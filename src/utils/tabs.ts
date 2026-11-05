import { tauri } from "@/platform/tauri";
import { normalizeError, type AppError } from "@/platform/errors";
import i18n from "i18next";
import { useSetAtom, useStore, type getDefaultStore } from "jotai";
import type { StoreApi } from "zustand";
import { createContext, startTransition, useCallback } from "react";
import type { FileMetadata } from "@/components/files/file";
import { MAX_STORE_ATTEMPTS, persistStorageWriteError, tabStorage } from "@/state/store/tabStorage";
import { reportPersistError } from "@/state/persistError";
import {
    getTabTreeKey,
    newWorkspaceId,
    tabSchema,
    type GameOrigin,
    type Tab,
} from "@/state/workspaceTypes";
import {
    activeTabAtom,
    closingTabsAtom,
    initializeWorkspace,
    reclaimTabLocalState,
    tabsAtom,
    updateTabById,
} from "@/state/atoms";
import {
    closeTreeStore,
    getCachedTreeStore,
    prepareTreeStoreRetarget,
    type TreeStore,
    type TreeStoreState,
} from "@/state/store/tree";
import { defaultPGN, getPGN, parsePGN, parsePGNWithLossReport } from "./chess";
import { pickPgnFile, readFileGame, writeFileGame } from "./files";
import type { GameHeaders, TreeState } from "./treeReducer";
import { fileWorkspaceKey } from "./pathCapabilities";
import type { DatabaseHandle, NormalizedGame } from "@/bindings";
import { databaseGameToTree, seedDatabaseOrientation } from "./databaseGameTree";
import { databaseHandleKey } from "./db";
import { getFileFreshness, setFileFreshness } from "@/state/fileFreshness";
import type { Workspace } from "@/state/workspace";
import { gameSignature } from "@/state/gameSignature";
export { getTabTreeKey, tabSchema, type GameOrigin, type Tab };

export type FileBackedTab = Tab & {
    gameOrigin: Extract<GameOrigin, { kind: "file" | "temp_file" }>;
};

export function isFileBackedTab(tab?: Tab | null): tab is FileBackedTab {
    return !!tab && (tab.gameOrigin.kind === "file" || tab.gameOrigin.kind === "temp_file");
}

export function matchesFileGameTab(
    tab: Tab | undefined,
    origin: FileBackedTab["gameOrigin"],
): tab is FileBackedTab {
    return isFileBackedTab(tab) && sameFileGameOrigin(tab.gameOrigin, origin);
}

export function getTabFile(tab?: Tab | null): FileMetadata | undefined {
    return isFileBackedTab(tab) ? tab.gameOrigin.file : undefined;
}

export function getTabGameNumber(tab?: Tab | null): number {
    return isFileBackedTab(tab) ? tab.gameOrigin.gameNumber : 0;
}

export function isPersistentGameOrigin(tab?: Tab | null): boolean {
    if (!tab) return false;
    return tab.gameOrigin.kind !== "none";
}

/** Coverage only: persistent origin, or an analysis tab of any origin. Does not read dirty. */
export function asksBeforeDiscardingChanges(tab?: Tab | null): boolean {
    if (!tab) return false;
    return isPersistentGameOrigin(tab) || tab.type === "analysis";
}

export const genID = newWorkspaceId;

export type SetTabs = (
    update: Tab[] | ((tabs: Tab[]) => Tab[]),
    activeTab?: string,
    onSaved?: (saved: Workspace) => void,
) => boolean;
export type SetCurrentTab = (update: React.SetStateAction<Tab>) => boolean;
/** Acknowledges the canonical persisted successor before workspace observers run. */
export type UpdateTab = (
    tabId: string,
    update: React.SetStateAction<Tab>,
    onAdmitted?: (successor: Tab) => void,
) => boolean;

/** Live access stays inside the caller's workspace provider, including durable refusal. */
export function useTabActions() {
    const workspace = useStore();
    const setTabs = useSetAtom(tabsAtom);
    const getTab = useCallback(
        (id: string) => workspace.get(tabsAtom).find((tab) => tab.value === id),
        [workspace],
    );
    const updateTab = useCallback(
        (id: string, update: React.SetStateAction<Tab>, onAdmitted?: (successor: Tab) => void) =>
            updateTabById(setTabs, id, update, onAdmitted),
        [setTabs],
    );
    return { workspace, getTab, updateTab };
}

export function sameTabOwner(current: Tab | undefined, captured: Tab): current is Tab {
    return (
        !!current &&
        current.value === captured.value &&
        getTabTreeKey(current) === getTabTreeKey(captured)
    );
}

export const AddGameContext = createContext<((owner: Tab | undefined) => Promise<void>) | null>(
    null,
);

type AddGameLease = { owner: FileBackedTab };
type AddGameAdmission = { lease: AddGameLease | null; listeners: Set<() => void> };
// One pending Add Game per live store/generation. Weak keys retain no retired store, and an
// empty admission is removed after its last view unsubscribes. Recovery append has its own owner.
const addGameAdmissions = new WeakMap<TreeStore, AddGameAdmission>();

function addGameAdmission(store: TreeStore): AddGameAdmission {
    let admission = addGameAdmissions.get(store);
    if (!admission) {
        admission = { lease: null, listeners: new Set() };
        addGameAdmissions.set(store, admission);
    }
    return admission;
}

function publishAddGameAdmission(store: TreeStore, admission: AddGameAdmission) {
    for (const listener of admission.listeners) listener();
    if (!admission.lease && !admission.listeners.size) addGameAdmissions.delete(store);
}

export function getAddGameLease(store: TreeStore) {
    return addGameAdmissions.get(store)?.lease ?? null;
}

export function subscribeAddGame(store: TreeStore, listener: () => void) {
    const admission = addGameAdmission(store);
    admission.listeners.add(listener);
    return () => {
        admission.listeners.delete(listener);
        publishAddGameAdmission(store, admission);
    };
}

/** Add Game completion belongs to the captured workspace and cached store, not a view. */
export async function appendBlankGame({
    captured,
    store,
    workspace,
    getTab,
    updateTab,
    onError,
    uncertainMessage,
    changedMessage,
}: {
    captured: Tab | undefined;
    store: TreeStore;
    workspace: ReturnType<typeof getDefaultStore>;
    getTab: (id: string) => Tab | undefined;
    updateTab: UpdateTab;
    onError: (error: unknown) => void;
    uncertainMessage: string;
    changedMessage: string;
}): Promise<void> {
    if (!isFileBackedTab(captured)) return;
    const ownerId = captured.value;
    let completionOwner = captured;
    const owns = () => {
        const current = getTab(ownerId);
        return (
            sameTabOwner(current, completionOwner) &&
            matchesFileGameTab(current, completionOwner.gameOrigin) &&
            getCachedTreeStore(ownerId) === store
        );
    };
    if (!owns()) return;
    const admission = addGameAdmission(store);
    if (
        admission.lease &&
        sameTabOwner(captured, admission.lease.owner) &&
        matchesFileGameTab(captured, admission.lease.owner.gameOrigin)
    )
        return;
    const lease = { owner: captured };
    admission.lease = lease;
    publishAddGameAdmission(store, admission);
    const before = getFileFreshness(ownerId);
    const claimed = setFileFreshness(ownerId, "appending");
    const notifyError = (error: unknown) => {
        if (owns()) onError(error);
    };
    const unverified = () =>
        setFileFreshness(ownerId, "unverified", {
            errorMessage: getFileFreshness(ownerId).errorMessage,
        });
    let writeAttempted = false;
    let replacementAttempted = false;
    const refreshFileCount = async () => {
        try {
            const count = await tauri.countPgnGames(captured.gameOrigin.file.handle);
            if (!owns()) return { ok: true as const };
            const committed = updateTab(ownerId, (previous) => {
                return {
                    ...previous,
                    gameOrigin: {
                        ...(previous as FileBackedTab).gameOrigin,
                        file: { ...(previous as FileBackedTab).gameOrigin.file, numGames: count },
                    },
                };
            });
            // Refusal carries no error because the workspace boundary reports the storage diagnostic.
            return { ok: committed };
        } catch (error) {
            return { ok: false as const, error };
        }
    };
    try {
        const pgn = defaultPGN();
        const newGame = await parsePGN(pgn);
        if (!owns()) return;
        const latest = getTab(ownerId)! as FileBackedTab;
        const origin = latest.gameOrigin;
        const gameNumber = origin.file.numGames;
        writeAttempted = true;
        const written = await writeFileGame(origin.file.handle, gameNumber, pgn, {
            kind: "append",
        });
        if (!owns()) return;
        if (written.stamp === null || written.revision === null) {
            const countRefresh = await refreshFileCount();
            if (!owns()) return;
            unverified();
            notifyError({
                category: "applied-despite-error",
                message: uncertainMessage,
            });
            if (!countRefresh.ok && "error" in countRefresh) notifyError(countRefresh.error);
            return;
        }
        // Once replacement starts, an exception can follow durable workspace admission.
        // Count repair would publish the old owner over that admitted candidate.
        replacementAttempted = true;
        const replacement = replaceFileGame({
            store: workspace,
            owner: captured,
            treeStore: store,
            snapshot: store.getState(),
            tree: {
                ...newGame,
                sourceStamp: written.stamp,
                ...(written.linked ? { linkedSource: written.linked } : {}),
            },
            page: gameNumber,
            appendCount: gameNumber + 1,
            isCurrent: owns,
            onAdmitted: (successor) => {
                completionOwner = successor;
            },
        });
        if (replacement.kind === "committed") {
            if (owns())
                setFileFreshness(ownerId, "verified", { verifiedRevision: written.revision });
        } else if (owns()) unverified();
    } catch (error) {
        if (!owns()) return;
        const normalized = normalizeError(error);
        const countRefresh =
            writeAttempted && !replacementAttempted
                ? await refreshFileCount()
                : { ok: true as const };
        if (!owns()) return;
        if (writeAttempted) unverified();
        let visibleError: unknown = normalized;
        if (writeAttempted && normalized.backendCategory === "stale-game") {
            // Durable refusal already reports storage failure. It cannot claim a refreshed count.
            if (!countRefresh.ok && !("error" in countRefresh)) return;
            visibleError = countRefresh.ok
                ? { category: "validation", message: changedMessage }
                : countRefresh.error;
        } else if (writeAttempted) {
            visibleError = {
                ...normalized,
                message: `${uncertainMessage} ${normalized.message}`,
            };
        }
        notifyError(visibleError);
    } finally {
        // A parse failure may restore only its own presentation claim, never a newer Save result.
        if (owns() && getFileFreshness(ownerId) === claimed) {
            setFileFreshness(ownerId, before.state, before);
        }
        if (admission.lease === lease) {
            admission.lease = null;
            publishAddGameAdmission(store, admission);
        }
    }
}

type StagedAdmissionResult =
    | { kind: "committed"; id: string }
    | { kind: "refused"; stage: "tree" | "workspace" };

function stageAndCommitTab({
    seed,
    existingTabIds,
    commit,
    keepLogicalTab = false,
}: {
    seed?: (id: string) => void;
    existingTabIds?: Iterable<string>;
    commit: (freshId: string) => boolean;
    keepLogicalTab?: boolean;
}): StagedAdmissionResult {
    initializeWorkspace();
    const id = genID(existingTabIds);
    if (seed) {
        try {
            seed(id);
        } catch (error) {
            reportPersistError(persistStorageWriteError(error));
            rollbackCreatedTree(id);
            return { kind: "refused", stage: "tree" };
        }
    }

    let result: StagedAdmissionResult | undefined;
    let admissionError: unknown;
    const admit = () => {
        try {
            result = commit(id)
                ? { kind: "committed", id }
                : { kind: "refused", stage: "workspace" };
        } catch (error) {
            admissionError = error;
        }
    };
    // A retained logical owner must publish its new page before urgent error settlement.
    if (keepLogicalTab) admit();
    else startTransition(admit);
    // A missing result is an application exception, never definite admission refusal.
    if (!result) throw admissionError;
    if (result.kind === "refused") {
        if (seed) rollbackCreatedTree(id);
    }
    return result;
}

export function commitNewTab({
    tab,
    setTabs,
    seed,
    existingTabIds,
}: {
    tab: Omit<Tab, "value">;
    setTabs: SetTabs;
    seed?: (id: string) => void;
    existingTabIds?: Iterable<string>;
}): string | null {
    const result = stageAndCommitTab({
        seed,
        existingTabIds,
        commit: (id) =>
            setTabs((prev) => {
                const nextTab = { ...tab, value: id, treeKey: undefined };
                return prev.length === 0 ||
                    (prev.length === 1 && prev[0].type === "new" && tab.type !== "new")
                    ? [nextTab]
                    : [...prev, nextTab];
            }, id),
    });
    return result.kind === "committed" ? result.id : null;
}

function rollbackCreatedTree(id: string) {
    // Only seed failure or a returned refusal proves that deleting the staged tree is safe.
    if (!tabStorage.removeTreeSafely(id)) {
        tabStorage.recordFailedAdmission(id);
    }
}

export type ReplaceNewTabResult =
    | { kind: "committed"; id: string }
    | { kind: "superseded" }
    | { kind: "refused"; stage: "tree" | "workspace" };

export type ReplaceFileGameResult =
    | { kind: "committed"; treeKey: string }
    | { kind: "superseded" }
    | { kind: "refused"; stage: "tree" | "workspace" };

export function replaceNewTab({
    store,
    ownerId,
    tab,
    tree,
}: {
    store: ReturnType<typeof getDefaultStore>;
    ownerId: string;
    tab: Omit<Tab, "value">;
    tree: TreeState;
}): ReplaceNewTabResult {
    const tabs = store.get(tabsAtom);
    const ownerIndex = tabs.findIndex((current) => current.value === ownerId);
    if (
        ownerIndex === -1 ||
        tabs[ownerIndex]?.type !== "new" ||
        store.get(closingTabsAtom).has(ownerId)
    ) {
        return { kind: "superseded" };
    }

    const result = stageAndCommitTab({
        seed: (freshId) => tabStorage.seed(freshId, tree),
        existingTabIds: tabs.flatMap((current) => [current.value, getTabTreeKey(current)]),
        commit: (freshId) => {
            const activeTab = store.get(activeTabAtom);
            const committed = store.set(
                tabsAtom,
                (currentTabs) =>
                    currentTabs.map((current, index) =>
                        index === ownerIndex
                            ? { ...tab, value: freshId, treeKey: undefined }
                            : current,
                    ),
                activeTab === ownerId ? freshId : undefined,
            );
            if (committed) {
                reclaimTabLocalState(ownerId, getTabTreeKey(tabs[ownerIndex]));
                closeTreeStore(ownerId);
            }
            return committed;
        },
    });
    return result;
}

/** Stage a fresh durable generation without changing the logical tab or its runtime owners. */
export function replaceFileGame({
    store,
    owner,
    treeStore,
    snapshot,
    tree,
    page,
    appendCount,
    isCurrent,
    onAdmitted,
}: {
    store: ReturnType<typeof getDefaultStore>;
    owner: FileBackedTab;
    treeStore: TreeStore;
    snapshot: Pick<TreeState, "root" | "headers">;
    tree: TreeState;
    page: number;
    appendCount?: number;
    isCurrent: () => boolean;
    onAdmitted?: (successor: FileBackedTab) => void;
}): ReplaceFileGameResult {
    const oldKey = getTabTreeKey(owner);
    const owns = () => {
        const current = store.get(tabsAtom).find((tab) => tab.value === owner.value);
        const live = treeStore.getState();
        return (
            isCurrent() &&
            sameTabOwner(current, owner) &&
            !store.get(closingTabsAtom).has(owner.value) &&
            sameFileGameOrigin(current.gameOrigin, owner.gameOrigin) &&
            getCachedTreeStore(owner.value) === treeStore &&
            live.root === snapshot.root &&
            live.headers === snapshot.headers
        );
    };
    if (!owns()) return { kind: "superseded" };
    let superseded = false;
    let install!: () => void;
    const result = stageAndCommitTab({
        seed: (id) => {
            const replacement = prepareTreeStoreRetarget(owner.value, id, tree);
            install = replacement;
            tabStorage.seed(id, replacement.state);
        },
        keepLogicalTab: true,
        existingTabIds: store.get(tabsAtom).flatMap((tab) => [tab.value, getTabTreeKey(tab)]),
        commit: (id) => {
            if (!owns()) {
                superseded = true;
                return false;
            }
            return store.set(
                tabsAtom,
                (tabs) =>
                    tabs.map((tab) =>
                        tab.value === owner.value
                            ? {
                                  ...tab,
                                  treeKey: id,
                                  gameOrigin:
                                      appendCount === undefined
                                          ? { ...tab.gameOrigin, gameNumber: page }
                                          : {
                                                kind: "file" as const,
                                                gameNumber: page,
                                                file: {
                                                    ...(tab as FileBackedTab).gameOrigin.file,
                                                    numGames: appendCount,
                                                },
                                            },
                              }
                            : tab,
                    ),
                undefined,
                (saved) => {
                    try {
                        onAdmitted?.(
                            saved.tabs.find((tab) => tab.value === owner.value)! as FileBackedTab,
                        );
                    } finally {
                        install();
                    }
                },
            );
        },
    });
    if (superseded) return { kind: "superseded" };
    if (result.kind === "committed") {
        tabStorage.removeTreeSafely(oldKey);
        return { kind: "committed", treeKey: result.id };
    }
    return result;
}

export async function runTabCreation({
    create,
    onSuccess,
    onError,
}: {
    create: () => Promise<string | null> | string | null;
    onSuccess?: (id: string) => void | Promise<void>;
    onError: (error: unknown) => void;
}): Promise<string | null> {
    try {
        const id = await create();
        if (id === null) return null;
        await onSuccess?.(id);
        return id;
    } catch (error) {
        onError(error);
        return null;
    }
}

export async function createTab({
    tab,
    setTabs,
    pgn,
    headers,
    gameOrigin,
    position,
    initialTree,
    databaseGame,
    existingTabIds,
}: {
    tab: Omit<Tab, "value" | "gameOrigin">;
    setTabs: SetTabs;
    pgn?: string;
    headers?: GameHeaders;
    gameOrigin?: GameOrigin;
    position?: number[];
    initialTree?: TreeState;
    databaseGame?: NormalizedGame;
    existingTabIds?: Iterable<string>;
}): Promise<string | null> {
    let treeToSeed: TreeState | undefined = initialTree;
    const databaseOrigin = gameOrigin?.kind === "database" ? gameOrigin : undefined;
    if (gameOrigin?.kind === "database") {
        const current = await tauri.getDbGame(
            gameOrigin.database,
            gameOrigin.gameId,
            databaseGame?.linked
                ? { locator: databaseGame.linked, signature: gameSignature(databaseGame) }
                : null,
        );
        if (current.kind === "missing") return null;
        databaseGame = current.game;
        gameOrigin = {
            ...gameOrigin,
            gameId: databaseGame.id,
            linked: databaseGame.linked ?? undefined,
        };
        tab = { ...tab, name: `${databaseGame.white} - ${databaseGame.black}` };
        const linked = await tauri.resolveLinkedGame(
            gameOrigin.database,
            gameOrigin.gameId,
            gameOrigin.linked ?? null,
        );
        if (linked) {
            const tree = await parsePGN(linked.game.pgn);
            treeToSeed = {
                ...tree,
                sourceStamp: linked.game.stamp,
                linkedSource: linked.locator,
            } as TreeState;
            gameOrigin = {
                kind: "file",
                gameNumber: linked.ordinal,
                file: {
                    type: "file",
                    handle: linked.file,
                    name: linked.name,
                    numGames: linked.numGames,
                    metadata: { type: linked.purpose, tags: [] },
                    lastModified: Date.now(),
                },
            };
        }
    }

    if (!treeToSeed && databaseGame) {
        treeToSeed = await databaseGameToTree(databaseGame);
        if (gameOrigin?.kind !== "database") treeToSeed.sourceStamp = null;
        if (position) treeToSeed.position = position;
    }

    if (!treeToSeed && pgn !== undefined) {
        const tree = await parsePGN(pgn, headers?.fen);
        if (headers) {
            tree.headers = headers;
            if (position) {
                tree.position = position;
            }
        }
        treeToSeed = tree;
    }

    if (treeToSeed && databaseOrigin) {
        await seedDatabaseOrientation(
            treeToSeed,
            databaseOrigin.database,
            databaseGame?.id ?? databaseOrigin.gameId,
        );
    }

    return commitNewTab({
        tab: {
            ...tab,
            gameOrigin: gameOrigin ?? { kind: "none" },
        },
        setTabs,
        seed: treeToSeed ? (id) => tabStorage.seed(id, treeToSeed) : undefined,
        existingTabIds,
    });
}

export type SaveResult =
    | "saved"
    | "cancelled"
    | "conflict"
    | "superseded"
    | { status: "failed"; error: AppError };

export function serializeStoreTree(store: StoreApi<TreeStoreState>): string {
    const state = store.getState();
    return `${getPGN(state.root, {
        headers: state.headers,
        comments: true,
        extraMarkups: true,
        glyphs: true,
        variations: true,
    })}\n\n`;
}

export function sameFileGameOrigin(left: GameOrigin, right: GameOrigin): boolean {
    if (left.kind === "file" || left.kind === "temp_file") {
        return (
            (right.kind === "file" || right.kind === "temp_file") &&
            fileWorkspaceKey(left.file.handle) === fileWorkspaceKey(right.file.handle) &&
            left.gameNumber === right.gameNumber
        );
    }
    return false;
}

function sameOrigin(left: GameOrigin, right: GameOrigin): boolean {
    if (left.kind !== right.kind) return false;
    if (left.kind === "file" || left.kind === "temp_file") {
        return sameFileGameOrigin(left, right);
    }
    if (left.kind === "database") {
        return (
            right.kind === "database" &&
            left.gameId === right.gameId &&
            databaseHandleKey(left.database) === databaseHandleKey(right.database)
        );
    }
    if (left.kind === "databaseDraft") {
        return (
            right.kind === "databaseDraft" &&
            databaseHandleKey(left.database) === databaseHandleKey(right.database)
        );
    }
    return true;
}

function sourceChanged(tabId: string): SaveResult {
    setFileFreshness(tabId, "conflict", { conflictReason: "save-refused" });
    return "conflict";
}

function failed(error: unknown): Extract<SaveResult, { status: "failed" }> {
    return { status: "failed", error: normalizeError(error) };
}

type SaveFlight = {
    saves: Set<Promise<SaveResult>>;
    storing?: Promise<SaveResult>;
    storeTarget?: string;
};
// A live tab has one cached tree. Weak ownership lets a retired generation settle independently.
const saveFlights = new WeakMap<StoreApi<TreeStoreState>, SaveFlight>();
function saveFlight(store: StoreApi<TreeStoreState>): SaveFlight {
    let flight = saveFlights.get(store);
    if (!flight) {
        flight = { saves: new Set() };
        saveFlights.set(store, flight);
    }
    return flight;
}
function settleSave(store: StoreApi<TreeStoreState>, flight: SaveFlight) {
    if (!flight.saves.size && !flight.storing) saveFlights.delete(store);
}

function withStoreFlight(
    args: SaveArguments & { database: DatabaseHandle },
    action: (tab: Tab) => Promise<SaveResult>,
): Promise<SaveResult> {
    const owner = args.tab;
    if (!owner) return Promise.resolve(failed(new Error("There is no active tab to save.")));
    const flight = saveFlight(args.store);
    // A repeated submission belongs to the same pending attempt, never another native store.
    const target = databaseHandleKey(args.database);
    if (flight.storing && flight.storeTarget === target) return flight.storing;
    const pending = [...flight.saves, ...(flight.storing ? [flight.storing] : [])];
    const start = () => {
        const current = args.getTab(owner.value);
        if (
            !sameTabOwner(current, owner) ||
            (!pending.length && !sameOrigin(current.gameOrigin, owner.gameOrigin))
        )
            return Promise.resolve<SaveResult>("superseded");
        return action(current);
    };
    const result = pending.length ? Promise.allSettled(pending).then(start) : start();
    flight.storing = result;
    flight.storeTarget = target;
    const cleanup = () => {
        if (flight.storing === result) {
            flight.storing = undefined;
            flight.storeTarget = undefined;
        }
        settleSave(args.store, flight);
    };
    void result.then(cleanup, cleanup);
    return result;
}

function uncertainStore(): SaveResult {
    return failed({
        category: "applied-despite-error",
        message: i18n.t("Board.Database.MayHaveBeenAdded"),
    });
}

type SaveArguments = {
    tab: Tab | undefined;
    updateTab: UpdateTab;
    getTab: (tabId: string) => Tab | undefined;
    store: StoreApi<TreeStoreState>;
    isUserSave?: boolean;
};

export function saveToDatabase(
    args: SaveArguments & { database: DatabaseHandle },
): Promise<SaveResult> {
    return withStoreFlight(args, (tab) => storeToDatabase({ ...args, tab }));
}

async function storeToDatabase({
    tab,
    store,
    database,
    getTab,
    updateTab,
}: SaveArguments & {
    tab: Tab;
    database: DatabaseHandle;
}): Promise<SaveResult> {
    let completionOwner = tab;
    const owns = () => {
        const current = getTab(tab.value);
        return (
            sameTabOwner(current, completionOwner) &&
            sameOrigin(current.gameOrigin, completionOwner.gameOrigin) &&
            (!getCachedTreeStore(tab.value) || getCachedTreeStore(tab.value) === store)
        );
    };
    let destination: string | undefined;
    let attempted = false;
    let inserting = false;
    const clearAttempt = () => {
        store
            .getState()
            .setStoreAttempts(
                (store.getState().storeAttempts ?? []).filter((key) => key !== destination),
            );
        tabStorage.flush();
    };
    try {
        if (!owns()) return "superseded";
        const collection = await tauri.collectionForDatabase(database);
        if (!owns()) return "superseded";
        if (store.getState().root.children.length === 0)
            return failed({ category: "validation", message: i18n.t("Board.Database.NoMoves") });
        if (collection && collection.status !== "ready")
            return failed({ category: "validation", message: i18n.t("Collections.Unavailable") });
        destination = collection
            ? `file:${fileWorkspaceKey(collection.file)}`
            : `database:${databaseHandleKey(database)}`;
        const attempts = store.getState().storeAttempts ?? [];
        if (attempts.includes(destination) || attempts.length >= MAX_STORE_ATTEMPTS)
            return uncertainStore();
        const pgn = serializeStoreTree(store);
        store.getState().setStoreAttempts([...attempts, destination]);
        const key = getTabTreeKey(tab);
        const failedTabs = tabStorage.flush();
        if (
            failedTabs.includes(key) ||
            !tabStorage.read<TreeState>(key)?.state.storeAttempts?.includes(destination)
        ) {
            clearAttempt();
            return failed({
                category: "unexpected",
                message: i18n.t("FileFreshness.CouldNotPrepareAppend"),
            });
        }
        if (!owns()) return "superseded";
        if (collection) {
            const numGames = await tauri.countPgnGames(collection.file);
            if (!owns()) return "superseded";
            attempted = true;
            const result = await appendStoreGame({
                tab,
                store,
                pgn,
                getTab,
                updateTab,
                isCurrent: owns,
                selected: {
                    type: "file",
                    handle: collection.file,
                    name: collection.name,
                    numGames,
                    metadata: { type: "game", tags: [] },
                    lastModified: Date.now(),
                },
                prepareMessage: i18n.t("FileFreshness.CouldNotPrepareAppend"),
                storeAttempt: { clear: clearAttempt },
                onAdmitted: (successor) => {
                    completionOwner = successor;
                },
            });
            if (result === "uncertain" || result === "refused") return uncertainStore();
            return result === "edited" ? "superseded" : result;
        }
        attempted = true;
        inserting = true;
        const inserted = await tauri.insertDbGame(database, pgn);
        if (!owns()) return "superseded";
        const admitted = admitStoredGame({
            tab,
            getTab,
            updateTab,
            origin: { kind: "database", database, gameId: inserted.id },
            onAdmitted: (successor) => {
                completionOwner = successor;
            },
            finish: (ownsSuccessor) => {
                store.getState().setLinkedSource(null);
                if (!ownsSuccessor()) return;
                store.getState().setSourceStamp(inserted.stamp);
                if (!ownsSuccessor()) return;
                clearAttempt();
                if (!ownsSuccessor()) return;
                if (serializeStoreTree(store) === pgn) store.getState().save(inserted.stamp);
                if (!ownsSuccessor()) return;
                setFileFreshness(tab.value, "verified", { verifiedRevision: null });
            },
        });
        if (admitted !== "admitted") return admitted === "refused" ? uncertainStore() : admitted;
        return !store.getState().dirty && serializeStoreTree(store) === pgn
            ? "saved"
            : "superseded";
    } catch (error) {
        const failure = failed(error);
        // These typed rejections precede a write or roll the transaction back. A transport or
        // durability failure provides no such evidence and must retain its destination marker.
        const noWrite =
            ["chess-data", "parsing", "invalid-input", "permission", "stale-game"].includes(
                failure.error.backendCategory ?? "",
            ) ||
            (inserting && failure.error.backendCategory === "conflict");
        if (destination && (!attempted || noWrite)) clearAttempt();
        if (!owns()) return "superseded";
        if (destination && store.getState().storeAttempts?.includes(destination))
            failure.error.message = `${i18n.t("Board.Database.MayHaveBeenAdded")} ${failure.error.message}`;
        return failure;
    }
}

/** Only the canonical acknowledgement can finalize a write, even when observers throw. */
function admitStoredGame({
    tab,
    getTab,
    updateTab,
    origin,
    onAdmitted,
    finish,
}: {
    tab: Tab;
    getTab: (id: string) => Tab | undefined;
    updateTab: UpdateTab;
    origin: GameOrigin;
    onAdmitted?: (successor: Tab) => void;
    finish: (ownsSuccessor: () => boolean) => void;
}): "admitted" | "refused" | "superseded" {
    let successor: Tab | undefined;
    const ownsSuccessor = () => {
        const current = getTab(tab.value);
        return (
            !!successor &&
            sameTabOwner(current, successor) &&
            sameOrigin(current.gameOrigin, successor.gameOrigin)
        );
    };
    try {
        const admitted = updateTab(
            tab.value,
            (previous) => ({ ...previous, gameOrigin: origin }),
            (saved) => {
                successor = saved;
                onAdmitted?.(saved);
                if (ownsSuccessor()) finish(ownsSuccessor);
            },
        );
        if (!admitted) return "refused";
    } catch (error) {
        if (successor && !ownsSuccessor()) return "superseded";
        throw error;
    }
    return ownsSuccessor() ? "admitted" : "superseded";
}

/** The durable marker is also the synchronous admission guard for concurrent submissions.
 * Keep it until an observed append has an admitted origin, or a known stale refusal proves
 * nothing was written. A cold store must refuse the same uncertain append too. */
export async function appendStoreGame({
    tab,
    store,
    selected,
    pgn,
    isCurrent,
    updateTab,
    getTab,
    prepareMessage,
    onAdmitted,
    storeAttempt,
}: {
    tab: Tab;
    store: StoreApi<TreeStoreState>;
    selected: FileMetadata;
    pgn: string;
    isCurrent: () => boolean;
    updateTab: UpdateTab;
    getTab: (tabId: string) => Tab | undefined;
    prepareMessage: string;
    onAdmitted?: (successor: Tab) => void;
    storeAttempt?: { clear: () => void };
}): Promise<"saved" | "edited" | "superseded" | "uncertain" | "refused"> {
    if (!isCurrent()) return "superseded";
    if (!storeAttempt) {
        if (store.getState().appendAttempted) return "uncertain";
        store.getState().setAppendAttempted(true);
        const treeKey = getTabTreeKey(tab);
        const failedTabs = tabStorage.flush();
        if (
            failedTabs.includes(treeKey) ||
            !tabStorage.read<TreeState>(treeKey)?.state.appendAttempted
        ) {
            store.getState().setAppendAttempted(false);
            tabStorage.flush({ notify: true });
            throw { category: "unexpected", message: prepareMessage };
        }
    }
    let written;
    try {
        written = await writeFileGame(selected.handle, selected.numGames, pgn, { kind: "append" });
    } catch (error) {
        if (!isCurrent()) return "superseded";
        if (!storeAttempt && normalizeError(error).backendCategory === "stale-game") {
            store.getState().setAppendAttempted(false);
            tabStorage.flush();
        }
        throw error;
    }
    if (!isCurrent()) return "superseded";
    if (written.stamp === null || written.revision === null) return "uncertain";
    const { stamp, revision } = written;
    const successorOrigin: GameOrigin = {
        kind: "file",
        gameNumber: selected.numGames,
        file: { ...selected, numGames: selected.numGames + 1 },
    };
    const admitted = admitStoredGame({
        tab,
        getTab,
        updateTab,
        origin: successorOrigin,
        onAdmitted,
        finish: (ownsSuccessor) => {
            const unchanged = serializeStoreTree(store) === pgn;
            store.getState().setLinkedSource(written.linked ?? null);
            if (!ownsSuccessor()) return;
            storeAttempt?.clear();
            if (!ownsSuccessor()) return;
            if (unchanged) store.getState().save(stamp);
            else {
                store.getState().setSourceStamp(stamp);
                if (!ownsSuccessor()) return;
                store.getState().setAppendAttempted(false);
            }
            if (ownsSuccessor())
                setFileFreshness(tab.value, "verified", { verifiedRevision: revision });
        },
    });
    if (admitted !== "admitted") return admitted;
    // Workspace observers can edit after acknowledgement finalized the written snapshot.
    return !store.getState().dirty && serializeStoreTree(store) === pgn ? "saved" : "edited";
}

export function saveToFile(args: SaveArguments): Promise<SaveResult> {
    const owner = args.tab;
    if (!owner) return Promise.resolve(failed(new Error("There is no active tab to save.")));
    if (owner.gameOrigin.kind === "databaseDraft") {
        if (args.isUserSave) {
            const database = owner.gameOrigin.database;
            // A queued draft save follows the current origin after an earlier store rebinds it.
            return withStoreFlight({ ...args, database }, (tab) => saveToFileNow({ ...args, tab }));
        }
        if (!saveFlights.get(args.store)?.storing) return Promise.resolve("cancelled");
    }
    const flight = saveFlight(args.store);
    const pendingStore = flight.storing;
    const start = () => {
        const current = args.getTab(owner.value);
        if (
            !sameTabOwner(current, owner) ||
            (!pendingStore && !sameOrigin(current.gameOrigin, owner.gameOrigin))
        )
            return Promise.resolve<SaveResult>("superseded");
        return saveToFileNow({ ...args, tab: pendingStore ? current : owner });
    };
    const earlierSaves = [...flight.saves];
    if (pendingStore) earlierSaves.push(pendingStore);
    const result = earlierSaves.length ? Promise.allSettled(earlierSaves).then(start) : start();
    flight.saves.add(result);
    const cleanup = () => {
        flight.saves.delete(result);
        settleSave(args.store, flight);
    };
    void result.then(cleanup, cleanup);
    return result;
}

async function saveToFileNow({
    tab,
    updateTab,
    getTab,
    store,
    isUserSave,
}: {
    tab: Tab | undefined;
    updateTab: UpdateTab;
    getTab: (tabId: string) => Tab | undefined;
    store: StoreApi<TreeStoreState>;
    isUserSave?: boolean;
}): Promise<SaveResult> {
    if (!tab) return failed(new Error("There is no active tab to save."));
    const tabId = tab.value;
    const currentOrigin = tab.gameOrigin;
    let completionOwner = tab;
    const owns = () => {
        const current = getTab(tabId);
        return (
            sameTabOwner(current, completionOwner) &&
            sameOrigin(current.gameOrigin, completionOwner.gameOrigin)
        );
    };
    let currentFileOperation = false;
    let writingCurrentOrigin = false;
    let writingSaveAsDestination = false;
    try {
        if (!owns()) return "superseded";
        if (currentOrigin.kind === "databaseDraft") {
            if (!isUserSave) return "cancelled";
            return storeToDatabase({
                tab,
                store,
                getTab,
                updateTab,
                database: currentOrigin.database,
            });
        }
        const fileOrigin = isFileBackedTab(tab) ? tab.gameOrigin : undefined;
        const databaseOrigin = currentOrigin?.kind === "database" ? currentOrigin : undefined;
        const isTempFile = currentOrigin?.kind === "temp_file";
        const sourceStamp = store.getState().sourceStamp;
        const pgn = serializeStoreTree(store);
        if (currentOrigin.kind === "none") {
            const uncertain = () =>
                failed({
                    category: "applied-despite-error",
                    message: i18n.t("FileFreshness.AppendMayHaveBeenAdded"),
                });
            if (store.getState().appendAttempted) return uncertain();
            const selected = await pickPgnFile("export");
            if (!owns()) return "superseded";
            if (!selected) return "cancelled";
            try {
                const result = await appendStoreGame({
                    tab,
                    store,
                    selected,
                    pgn,
                    isCurrent: owns,
                    updateTab,
                    getTab,
                    prepareMessage: i18n.t("FileFreshness.CouldNotPrepareAppend"),
                    onAdmitted: (successor) => {
                        completionOwner = successor;
                    },
                });
                if (result === "uncertain" || result === "refused") return uncertain();
                return result === "edited" ? "superseded" : result;
            } catch (error) {
                if (!owns()) return "superseded";
                const failure = failed(error);
                if (store.getState().appendAttempted) {
                    failure.error.message = `${i18n.t("FileFreshness.AppendMayHaveBeenAdded")} ${failure.error.message}`;
                }
                return failure;
            }
        }
        const gameNumber = fileOrigin?.gameNumber ?? 0;
        const write = (file: FileMetadata, stamp: string) => {
            const linked = store.getState().linkedSource;
            return writeFileGame(
                file.handle,
                gameNumber,
                pgn,
                linked
                    ? { kind: "linkedGame", stamp, revision: linked.generation }
                    : { kind: "game", stamp },
            );
        };
        const validateSource = async (
            origin: NonNullable<typeof fileOrigin>,
            checkLoss = false,
        ) => {
            currentFileOperation = true;
            const source = await readFileGame(origin.file.handle, origin.gameNumber);
            if (!owns()) return "superseded";
            if (source.stamp !== sourceStamp) return sourceChanged(tabId);
            if (checkLoss) {
                const parsed = await parsePGNWithLossReport(source.pgn);
                if (!owns()) return "superseded";
                if (parsed.losses.length > 0) {
                    setFileFreshness(tabId, "conflict", { conflictReason: "lossy-source" });
                    return "conflict";
                }
            }
            currentFileOperation = false;
        };
        const finishWrite = (
            written?: Awaited<ReturnType<typeof writeFileGame>>,
            commitOrigin?: () => boolean,
        ): SaveResult => {
            if (!owns()) return "superseded";
            if (written && (written.stamp === null || written.revision === null)) {
                if (written.stamp === null) store.getState().setSourceStamp(null);
                setFileFreshness(tabId, "unverified");
                return "conflict";
            }
            if (commitOrigin && !commitOrigin()) return "superseded";
            const unchanged = serializeStoreTree(store) === pgn;
            if (unchanged)
                store.getState().save(written?.stamp ?? undefined, written?.revision ?? undefined);
            else if (written)
                store.getState().setSourceStamp(written.stamp, written.revision ?? undefined);
            if (written)
                setFileFreshness(tabId, "verified", {
                    verifiedRevision: written.revision ?? undefined,
                });
            return unchanged ? "saved" : "superseded";
        };

        if (databaseOrigin) {
            const collection = await tauri.collectionForDatabase(databaseOrigin.database);
            if (!owns()) return "superseded";
            if (collection) {
                // A pre-link tree cannot acquire an editable source merely from an old row ID.
                // Keep its complete dirty tree available for Save As and recovery.
                return failed({
                    category: "validation",
                    message: i18n.t("Collections.RetiredTab", {
                        defaultValue:
                            "This database now indexes a PGN collection. Save this game as a new file to preserve your edits.",
                    }),
                });
            }
            writingCurrentOrigin = true;
            if (sourceStamp === null) return sourceChanged(tabId);
            const stamp = await tauri.writeDbGame(
                databaseOrigin.database,
                databaseOrigin.gameId,
                pgn,
                sourceStamp,
            );
            if (!owns()) return "superseded";
            const unchanged = serializeStoreTree(store) === pgn;
            if (unchanged) store.getState().save(stamp);
            else store.getState().setSourceStamp(stamp);
            setFileFreshness(tabId, "verified", { verifiedRevision: null });
            return unchanged ? "saved" : "superseded";
        }

        if (fileOrigin && !(isTempFile && isUserSave)) {
            currentFileOperation = true;
            writingCurrentOrigin = true;
            if (sourceStamp === null) return sourceChanged(tabId);
            const result = await validateSource(fileOrigin, true);
            if (result) return result;
            currentFileOperation = true;
            const written = await write(fileOrigin.file, sourceStamp);
            return finishWrite(written);
        }

        if (isTempFile && fileOrigin) {
            if (sourceStamp === null) return sourceChanged(tabId);
            const result = await validateSource(fileOrigin);
            if (result) return result;
        }

        const selected = await pickPgnFile();
        if (!owns()) return "superseded";
        if (!selected) return "cancelled";

        if (isTempFile && fileOrigin) {
            const result = await validateSource(fileOrigin);
            if (result) return result;
        }

        const destination = await readFileGame(selected.handle, gameNumber);
        if (!owns()) return "superseded";
        currentFileOperation = true;
        writingSaveAsDestination = true;
        const written = await write(selected, destination.stamp);
        return finishWrite(written, () =>
            updateTab(tabId, (previous) => ({
                ...previous,
                gameOrigin: {
                    kind: "file",
                    gameNumber,
                    file: {
                        ...selected,
                        numGames: Math.max(selected.numGames, gameNumber + 1),
                        metadata: { tags: [], type: "game" as const },
                    },
                },
            })),
        );
    } catch (error) {
        if (!owns()) return "superseded";
        const failure = failed(error);
        const normalized = failure.error;
        if (normalized.backendCategory === "stale-game") {
            return writingCurrentOrigin ? sourceChanged(tabId) : failure;
        }
        if (
            writingCurrentOrigin &&
            currentOrigin.kind === "database" &&
            normalized.backendCategory === "missing-resource"
        ) {
            setFileFreshness(tabId, "unavailable");
            return "conflict";
        }
        if (writingCurrentOrigin && normalized.category === "applied-despite-error") {
            // The game reached the file but its stamp is unknown: verify it by text, as after a
            // write whose read-back failed.
            store.getState().setSourceStamp(null);
            setFileFreshness(tabId, "unverified");
            return failure;
        }
        if (currentFileOperation && normalized.backendCategory === "conflict") {
            setFileFreshness(tabId, "unverified", { errorMessage: normalized.message });
            return failure;
        }
        // A Save-As destination that vanished or refused the slot was never written, and it is not
        // the tab's game: that is an ordinary failure, not an unavailable source.
        if (
            currentFileOperation &&
            !writingSaveAsDestination &&
            (normalized.backendCategory === "missing-resource" ||
                normalized.backendCategory === "invalid-input")
        ) {
            setFileFreshness(tabId, "unavailable");
            return "conflict";
        }
        return failure;
    }
}
