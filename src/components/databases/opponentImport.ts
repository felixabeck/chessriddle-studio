import type { createStore } from "jotai";
import type { ScopedMutator } from "swr";
import type {
    DatabaseDescriptor,
    DatabaseHandle,
    ErrorPayload,
    OpponentAccount,
    OpponentImportOutcome,
    OpponentImportRequest,
} from "@/bindings";
import { publishDatabaseList } from "@/hooks/useDatabaseList";
import {
    errorUnlessCancelled,
    normalizeError,
    safeFailureContext,
    warnSafely,
} from "@/platform/errors";
import { tauri, withDownloadTicket } from "@/platform/tauri";
import { opponentImportsAtom, opponentLinksAtom, sessionsAtom } from "@/state/atoms";
import {
    opponentDatabaseFilename,
    opponentDatabasePrefix,
    opponentSinceUnixSeconds,
    withOpponentDatabase,
    withoutOpponentLink,
} from "@/state/opponentLinks";
import { deleteDatabaseAndInvalidate } from "./databaseMutation";
import { forgetDeletedDatabase } from "./forgetDeletedDatabase";

type Store = ReturnType<typeof createStore>;

/** What the flow needs from the place that starts it; both outlive the starting component. */
export type OpponentFlowDeps = { store: Store; mutateCache: ScopedMutator };

export type OpponentAccountFailure = "notFound" | "rateLimited" | "signIn" | "other";

type OpponentRunOutcome =
    | { kind: "imported"; games: number; merged: boolean }
    | { kind: "noGames" }
    | { kind: "accountFailed"; account: OpponentAccount; reason: OpponentAccountFailure }
    | { kind: "cancelled" }
    | { kind: "failed"; error: unknown };

/**
 * How a run ended. Whatever the ending, `leftovers` counts the link's databases the run could
 * not delete: files of interrupted earlier runs, and the previous games after an update.
 */
export type OpponentImportResult = OpponentRunOutcome & { leftovers: number };

/**
 * Runs the native import of an opponent's online games. `onTicket` receives the id the import
 * reports its progress under and is cancelled by, before the import starts.
 */
export function importOpponentGames(
    request: OpponentImportRequest,
    onTicket: (ticket: string) => void,
): Promise<OpponentImportOutcome> {
    return withDownloadTicket((ticket) => {
        onTicket(ticket);
        return tauri.importOpponentGames(request, ticket);
    });
}

/** Which message an account's export failure gets. */
export function opponentAccountFailure(error: ErrorPayload): OpponentAccountFailure {
    const rejection = error.remoteHttpRejection;
    if (rejection?.status === 404) return "notFound";
    if (rejection?.status === 429) return "rateLimited";
    // Any other status answered a request with a token too, so the flag alone proves nothing.
    if (rejection?.authorizationSent && (rejection.status === 401 || rejection.status === 403)) {
        return "signIn";
    }
    return !rejection && error.category === "authentication" ? "signIn" : "other";
}

const running = new Map<string, Promise<OpponentImportResult>>();

/** Whether an import for the link is currently running. */
export function isOpponentImportRunning(linkId: string): boolean {
    return running.has(linkId);
}

function setInFlight(store: Store, linkId: string, ticket: string | null | undefined): void {
    const next = new Map(store.get(opponentImportsAtom));
    if (ticket === undefined) next.delete(linkId);
    else next.set(linkId, ticket);
    store.set(opponentImportsAtom, next);
}

/** The link's database files as the database folder lists them now. */
async function listLinkDatabases(linkId: string) {
    const { root } = await tauri.getDatabaseWorkspace();
    const listing = await tauri.listWorkspaceDatabases(root);
    const prefix = opponentDatabasePrefix(linkId);
    return {
        root,
        databases: listing.entries.filter((entry) => entry.filename.startsWith(prefix)),
    };
}

/**
 * Deletes the database with the cleanup the Library uses. A deletion that reported its error
 * only afterwards has removed the database and counts as done; every other failure is thrown.
 */
async function deleteOpponentDatabase(deps: OpponentFlowDeps, handle: DatabaseHandle) {
    try {
        await deleteDatabaseAndInvalidate(handle, tauri.deleteDatabase, (deleted) =>
            forgetDeletedDatabase(deleted, deps.store, deps.mutateCache),
        );
    } catch (cause) {
        if (normalizeError(cause).category !== "applied-despite-error") throw cause;
    }
}

/** Deletes each database and returns how many are still there; each failure is logged. */
async function deleteAll(deps: OpponentFlowDeps, databases: readonly DatabaseDescriptor[]) {
    let remaining = 0;
    for (const database of databases) {
        try {
            await deleteOpponentDatabase(deps, database.handle);
        } catch (cause) {
            remaining += 1;
            warnSafely(
                `An opponent's online games could not be deleted: ${safeFailureContext(cause).message}`,
            );
        }
    }
    return remaining;
}

/**
 * Publishes the database listing after this flow changed the database folder, so the listing is
 * right even while nothing that reads it is mounted. A failed read is logged and holds nothing.
 */
function refreshListing(deps: OpponentFlowDeps): Promise<void> {
    return publishDatabaseList(deps.mutateCache).then(
        () => undefined,
        (cause) =>
            warnSafely(
                `The database list could not be refreshed after an opponent's online games changed: ${safeFailureContext(cause).message}`,
            ),
    );
}

/** `cleanup.leftovers` is counted as the run goes, so it is known however the run ends. */
async function importLink(
    deps: OpponentFlowDeps,
    linkId: string,
    title: string,
    cleanup: { leftovers: number },
): Promise<OpponentRunOutcome> {
    const { store } = deps;
    const link = store.get(opponentLinksAtom).find((other) => other.id === linkId);
    if (!link) return { kind: "failed", error: new Error("unknown opponent link") };
    const { root, databases } = await listLinkDatabases(linkId);
    // Files of an interrupted earlier run. One that cannot be deleted does not stop this run.
    cleanup.leftovers += await deleteAll(
        deps,
        databases.filter((entry) => entry.filename !== link.database),
    );
    const nonce = crypto.randomUUID().slice(0, 8);
    const filename = opponentDatabaseFilename(linkId, nonce);
    const outcome = await importOpponentGames(
        {
            root,
            filename,
            title,
            accounts: link.accounts,
            sinceUnixSeconds: opponentSinceUnixSeconds(link.filter, new Date()),
            timeControls: link.filter.timeControls,
            lichessHandle:
                store.get(sessionsAtom).find((session) => session.lichess?.handle)?.lichess
                    ?.handle ?? null,
        },
        (ticket) => setInFlight(store, linkId, ticket),
    );
    if (outcome.kind === "accountFailed") {
        return {
            kind: "accountFailed",
            account: outcome.account,
            reason: opponentAccountFailure(outcome.error),
        };
    }
    if (outcome.database === null) return { kind: "noGames" };
    // The download is over and its ticket is spent: what follows cannot be cancelled.
    setInFlight(store, linkId, null);
    // The link names the new database only once the listing has it, so no reader ever sees a link
    // whose games the listing lacks. A listing that cannot be read does not undo the download.
    await refreshListing(deps);
    // The link switches first; the previous database goes only once the new one is in place.
    store.set(opponentLinksAtom, (links) => withOpponentDatabase(links, linkId, filename));
    const previous = databases.find((entry) => entry.filename === link.database);
    if (previous) cleanup.leftovers += await deleteAll(deps, [previous]);
    return {
        kind: "imported",
        games: outcome.accounts.reduce((sum, account) => sum + account.games, 0),
        merged: outcome.merged,
    };
}

/**
 * Downloads the link's online games into a fresh database. A second start for the same link
 * joins the running one. The previous database and the link stay as they were unless the run
 * imported games.
 */
export function runOpponentImport(
    deps: OpponentFlowDeps,
    linkId: string,
    title: string,
): Promise<OpponentImportResult> {
    const joined = running.get(linkId);
    if (joined) return joined;
    setInFlight(deps.store, linkId, null);
    const cleanup = { leftovers: 0 };
    const run = importLink(deps, linkId, title, cleanup)
        .catch(
            (error): OpponentRunOutcome =>
                errorUnlessCancelled(error) === null
                    ? { kind: "cancelled" }
                    : { kind: "failed", error },
        )
        .then((outcome): OpponentImportResult => ({ ...outcome, leftovers: cleanup.leftovers }))
        .finally(() => {
            running.delete(linkId);
            setInFlight(deps.store, linkId, undefined);
            // Whatever the ending, the run may have deleted databases the listing still names.
            void refreshListing(deps);
        });
    running.set(linkId, run);
    return run;
}

/** Asks the running import of the link to stop; its own result reports the cancellation. */
export async function cancelOpponentImport(store: Store, linkId: string): Promise<void> {
    const ticket = store.get(opponentImportsAtom).get(linkId);
    if (ticket) await tauri.cancelDownload(ticket);
}

/**
 * Deletes the link's online games and keeps its accounts. Throws, leaving the link as it was,
 * when the database it points at could not be deleted. Returns how many files of interrupted
 * runs could not be deleted; those keep neither the games nor the link.
 */
export async function removeOpponentGames(deps: OpponentFlowDeps, linkId: string): Promise<number> {
    const leftovers = await deleteLinkDatabases(deps, linkId);
    deps.store.set(opponentLinksAtom, (links) => withOpponentDatabase(links, linkId, undefined));
    return leftovers;
}

/** Deletes the link's online games and then the link. Throws and returns as above. */
export async function unlinkOpponent(deps: OpponentFlowDeps, linkId: string): Promise<number> {
    const leftovers = await deleteLinkDatabases(deps, linkId);
    deps.store.set(opponentLinksAtom, (links) => withoutOpponentLink(links, linkId));
    return leftovers;
}

async function deleteLinkDatabases(deps: OpponentFlowDeps, linkId: string): Promise<number> {
    if (running.has(linkId)) throw new Error("opponent import is running");
    const link = deps.store.get(opponentLinksAtom).find((other) => other.id === linkId);
    try {
        const { databases } = await listLinkDatabases(linkId);
        const current = databases.find((entry) => entry.filename === link?.database);
        if (current) await deleteOpponentDatabase(deps, current.handle);
        return await deleteAll(
            deps,
            databases.filter((entry) => entry !== current),
        );
    } finally {
        void refreshListing(deps);
    }
}
