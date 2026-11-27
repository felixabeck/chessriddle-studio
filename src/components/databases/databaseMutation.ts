import type { DatabaseHandle, DbGameHeadersUpdate, FileWorkspaceHandle } from "@/bindings";
import type { SuccessDatabaseInfo } from "@/utils/db";
import { collectSWRKeys, databaseHandleKey, sameDatabaseHandle } from "@/utils/db";
import {
    errorUnlessCancelled,
    logFailureSafely,
    runDestructiveWithRefresh,
    safeFailureContext,
} from "@/platform/errors";
import { tauri } from "@/platform/tauri";
import { notifyUnlessCancelled, runUnlessCancelled } from "@/components/files/notifyError";
import type { DatabaseConversionOperation } from "@/state/atoms";
import { type Cache, type ScopedMutator, unstable_serialize } from "swr";

/** Keep the operation row through reload, preserving the transaction's primary outcome. */
export async function refreshAfterDatabaseConversion<T>(
    convert: () => Promise<T>,
    refresh: () => Promise<unknown>,
    setRefreshFailed: (failed: boolean) => void,
    notifyTitle: string,
): Promise<T> {
    const reload = async (notifyFailure: boolean) => {
        try {
            await refresh();
            setRefreshFailed(false);
        } catch (cause) {
            setRefreshFailed(true);
            const primaryFailure = safeFailureContext(cause);
            await logFailureSafely(
                `Failed import database refresh failed: ${primaryFailure.message}`,
                { operation: "failed import database refresh", primaryFailure },
                "Import refresh logging failed",
            );
            if (notifyFailure) notifyUnlessCancelled(notifyTitle, cause, "database");
        }
    };
    let result: T;
    try {
        result = await convert();
    } catch (cause) {
        await reload(!errorUnlessCancelled(cause));
        throw cause;
    }
    await reload(true);
    return result;
}

/** Refresh the admitted database's game, player and tournament queries after a game mutation.
 * Results are bounded by the original keys collected from this cache for this operation. */
export async function refreshDatabaseGameQueries(
    file: DatabaseHandle,
    cache: Cache,
    mutate: ScopedMutator,
): Promise<PromiseSettledResult<unknown>[]> {
    const keys = await collectSWRKeys(
        mutate,
        (key) =>
            Array.isArray(key) &&
            (key[0] === "games" || key[0] === "players" || key[0] === "tournaments") &&
            sameDatabaseHandle(key[1] as DatabaseHandle, file),
    );
    return Promise.allSettled(
        keys.map(async (key) => {
            // Committed deletion invalidates old rows and historical errors even for inactive
            // keys. This does not start a refresh, so the next call owns active revalidation.
            await mutate(key, undefined, { revalidate: false });
            // Fetch failures live in cache state even when revalidation resolves normally.
            const data = await mutate(key);
            const error = cache.get(unstable_serialize(key))?.error;
            if (error !== undefined) throw error;
            return data;
        }),
    );
}

/** Refresh a database's game, player and tournament queries and notify any refresh failure
 * separately under the `"database"` domain without turning a committed mutation into a write error. */
export async function refreshDatabaseGameQueriesOrNotify(args: {
    file: DatabaseHandle;
    cache: Cache;
    mutate: ScopedMutator;
    refreshFailedTitle: string;
    shouldNotify?: () => boolean;
}): Promise<void> {
    const canNotify = args.shouldNotify ?? (() => true);
    try {
        const refreshed = await refreshDatabaseGameQueries(args.file, args.cache, args.mutate);
        for (const result of refreshed) {
            if (result.status === "rejected" && canNotify()) {
                notifyUnlessCancelled(args.refreshFailedTitle, result.reason, "database");
            }
        }
    } catch (error) {
        if (canNotify()) notifyUnlessCancelled(args.refreshFailedTitle, error, "database");
    }
}

/** Save updated game headers, then refresh the database's queries and report any refresh failure
 * separately without turning a committed write into a save error. */
export async function saveDbGameHeaders(args: {
    file: DatabaseHandle;
    gameId: number;
    headers: DbGameHeadersUpdate;
    expectedStamp: string;
    cache: Cache;
    mutate: ScopedMutator;
    refreshFailedTitle: string;
    onSaved?: (stamp: string) => void;
}): Promise<string> {
    const stamp = await tauri.writeDbGameHeaders(
        args.file,
        args.gameId,
        args.headers,
        args.expectedStamp,
    );
    args.onSaved?.(stamp);
    await refreshDatabaseGameQueriesOrNotify({
        file: args.file,
        cache: args.cache,
        mutate: args.mutate,
        refreshFailedTitle: args.refreshFailedTitle,
    });
    return stamp;
}

export type DatabaseRemovalState = {
    selected: string | null;
    reference: DatabaseHandle | null;
    active?: SuccessDatabaseInfo;
};

/** Clears every renderer state slot that could still target a deleted capability. */
export function invalidateDeletedDatabase(
    deleted: DatabaseHandle,
    state: DatabaseRemovalState,
): DatabaseRemovalState {
    return {
        selected: state.selected === databaseHandleKey(deleted) ? null : state.selected,
        reference: sameDatabaseHandle(state.reference, deleted) ? null : state.reference,
        active: sameDatabaseHandle(state.active?.file, deleted) ? undefined : state.active,
    };
}

/** Native deletion is the commit point. Renderer state is cleared after success
 * and after `applied-despite-error`, because that category means the primary
 * was already destroyed even though the command rejected. */
export async function deleteDatabaseAndInvalidate(
    deleted: DatabaseHandle,
    remove: (database: DatabaseHandle) => Promise<unknown>,
    invalidate: (database: DatabaseHandle) => void,
): Promise<void> {
    await runDestructiveWithRefresh(
        () => remove(deleted),
        () => invalidate(deleted),
    );
}

export async function runPgnExport(args: {
    issueDestination: () => Promise<{ handle: FileWorkspaceHandle }>;
    exportToPgn: (file: DatabaseHandle, handle: FileWorkspaceHandle) => Promise<unknown>;
    file: DatabaseHandle;
    notifyTitle: string;
    setLoading: (loading: boolean) => void;
}): Promise<void> {
    args.setLoading(true);
    try {
        await runUnlessCancelled(args.notifyTitle, async () => {
            const destination = await args.issueDestination();
            await args.exportToPgn(args.file, destination.handle);
        });
    } finally {
        args.setLoading(false);
    }
}

export async function runAddGamesToDatabase(args: {
    pickPgnFile: () => Promise<{ handle: FileWorkspaceHandle; name: string } | null>;
    convertPgn: (
        progressId: string,
        files: FileWorkspaceHandle[],
        dest: DatabaseHandle,
        ticket: string | null,
    ) => Promise<unknown>;
    dest: DatabaseHandle;
    notifyTitle: string;
    runConversion: (
        sourceFileName: string,
        convert: (operation: DatabaseConversionOperation) => Promise<void>,
    ) => Promise<void>;
}): Promise<void> {
    await runUnlessCancelled(args.notifyTitle, async () => {
        const selected = await args.pickPgnFile();
        if (!selected) return;
        await args.runConversion(selected.name, async (operation) => {
            operation.throwIfCancelled();
            await args.convertPgn(operation.id, [selected.handle], args.dest, operation.ticket);
        });
    });
}
