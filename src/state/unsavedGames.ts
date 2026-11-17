/**
 * Recovery copies of games that were never saved.
 *
 * Every open tab lives in `sessionStorage`, which the webview keeps only in memory, so quitting or
 * a crash loses a game the user typed in. This module keeps one durable copy per protected tab
 * (`asksBeforeDiscardingChanges` and dirty) in the native `unsaved-games` store, removes it when
 * the game is saved or deliberately discarded, and restores the remaining copies when a fresh
 * renderer starts.
 *
 * Ownership: one mirror per renderer, started and stopped by the root layout. Every native write
 * and remove for one tab runs in that tab's serial lane, so a late write can never recreate a
 * record that a later remove deleted. The mirror removes only ids it observed being saved or
 * closed; a record it never saw (a crash copy waiting for restore, or one that failed to decode)
 * is never touched.
 */
import i18n from "i18next";
import type { getDefaultStore } from "jotai";
import { z } from "zod";
import type { UnsavedGameInventory } from "@/bindings";
import { normalizeError, warnSafely } from "@/platform/errors";
import { tauri } from "@/platform/tauri";
import { tabsAtom, workspaceStartedFresh } from "@/state/atoms";
import { prepareTreeForStorage, TREE_STORAGE_VERSION, tabStorage } from "@/state/store/tabStorage";
import { createTreeStore, getCachedTreeStore, type TreeStore } from "@/state/store/tree";
import { getTabTreeKey, type Tab } from "@/state/workspaceTypes";
import type { TreeState } from "@/utils/treeReducer";
import { asksBeforeDiscardingChanges, commitNewTab, type SetTabs } from "@/utils/tabs";

export const UNSAVED_GAME_VERSION = 1;
/** Coalescing delay for edits after the first one; the first dirtying change writes at once. */
export const UNSAVED_GAME_WRITE_DELAY_MS = 1000;
/** Upper bound a quit or "Clear saved data" waits for outstanding native operations. */
export const UNSAVED_GAME_DRAIN_TIMEOUT_MS = 2000;
/** Longest tab name a record keeps; a longer name is cut on write so the record still decodes. */
export const UNSAVED_GAME_NAME_MAX = 1024;
const UNSAVED_GAME_TYPE_MAX = 64;
const REMOVE_RETRY_BASE_MS = 1000;
const REMOVE_RETRY_MAX_MS = 30_000;

type JotaiStore = ReturnType<typeof getDefaultStore>;

export type UnsavedGameNative = {
    write: (id: string, document: string) => Promise<unknown>;
    list: () => Promise<UnsavedGameInventory>;
    remove: (id: string) => Promise<unknown>;
    clear: () => Promise<string[]>;
};

export const nativeUnsavedGames: UnsavedGameNative = {
    write: (id, document) => tauri.writeUnsavedGame(id, document),
    list: () => tauri.listUnsavedGames(),
    remove: (id) => tauri.removeUnsavedGame(id),
    clear: () => tauri.clearUnsavedGames(),
};

// ---------------------------------------------------------------------------------------------
// Record format: the one writer/reader pair.

const recordSchema = z.object({
    version: z.literal(UNSAVED_GAME_VERSION),
    // The stored type is diagnostic only: restore always opens an analysis tab.
    tab: z.object({
        name: z.string().max(UNSAVED_GAME_NAME_MAX),
        type: z.string().max(UNSAVED_GAME_TYPE_MAX),
    }),
    tree: z.object({
        version: z.number().int().min(0).max(TREE_STORAGE_VERSION),
        state: z.unknown(),
    }),
});

export type DecodedUnsavedGame = { name: string; tree: TreeState };

/** UTF-8 JSON with the plain persisted tree envelope, never the compressed session string. */
export function encodeUnsavedGame(tab: Pick<Tab, "name" | "type">, state: unknown): string {
    return JSON.stringify({
        version: UNSAVED_GAME_VERSION,
        tab: { name: tab.name.slice(0, UNSAVED_GAME_NAME_MAX), type: tab.type },
        tree: { version: TREE_STORAGE_VERSION, state: prepareTreeForStorage(state) },
    });
}

/** Throws when the document is not a valid record; the caller keeps the file. */
export function decodeUnsavedGame(document: string): DecodedUnsavedGame {
    const record = recordSchema.parse(JSON.parse(document));
    return { name: record.tab.name, tree: prepareTreeForStorage(record.tree.state) };
}

// ---------------------------------------------------------------------------------------------
// Mirror

type Snapshot = { root: unknown; headers: unknown; name: string; type: string };
type WriteStatus = "confirmed" | "pending" | "failed";

type Entry = {
    id: string;
    tab: Tab;
    store: TreeStore;
    unsubscribe: () => void;
    timer: ReturnType<typeof setTimeout> | null;
    /** Generation of the write waiting in the lane, if one is waiting to start. */
    writeQueued: number | null;
    confirmed: Snapshot | null;
    status: WriteStatus;
    notifiedWriteFailure: boolean;
    mayHaveRecord: boolean;
};

type Lane = {
    generation: number;
    chain: Promise<void>;
    outstanding: number;
};

type PendingRemoval = {
    id: string;
    name: string;
    timer: ReturnType<typeof setTimeout> | null;
    attempts: number;
    notified: boolean;
};

export type DrainResult = { finished: boolean };

export type UnsavedGameMirrorDeps = {
    native: UnsavedGameNative;
    jotaiStore: JotaiStore;
    notify: (message: string) => void;
    warn?: (message: string) => void;
    /** Tree store for a tab; tests inject their own. */
    treeStoreFor?: (tab: Tab) => TreeStore | null;
};

function defaultTreeStoreFor(tab: Tab): TreeStore | null {
    const cached = getCachedTreeStore(tab.value);
    if (cached) return cached;
    const treeKey = getTabTreeKey(tab);
    // An unreadable or unavailable tree stays with its recovery flow; hydrating a default
    // store over it would hide the stored game.
    const inspected = tabStorage.inspectTree(treeKey, treeKey !== tab.value);
    if (inspected.kind !== "available" && inspected.kind !== "absent") return null;
    return createTreeStore(tab.value, undefined, treeKey);
}

/** The native category when the error came from a command, otherwise the renderer one. */
function categoryOf(error: unknown): string {
    const normalized = normalizeError(error);
    return normalized.backendCategory ?? normalized.category;
}

function sameSnapshot(left: Snapshot | null, right: Snapshot): boolean {
    return (
        !!left &&
        left.root === right.root &&
        left.headers === right.headers &&
        left.name === right.name &&
        left.type === right.type
    );
}

export class UnsavedGameMirror {
    private readonly entries = new Map<string, Entry>();
    private readonly lanes = new Map<string, Lane>();
    private readonly removals = new Map<string, PendingRemoval>();
    private unsubscribeTabs: (() => void) | null = null;
    private paused = false;
    private readonly warn: (message: string) => void;
    private readonly treeStoreFor: (tab: Tab) => TreeStore | null;

    constructor(private readonly deps: UnsavedGameMirrorDeps) {
        this.warn = deps.warn ?? warnSafely;
        this.treeStoreFor = deps.treeStoreFor ?? defaultTreeStoreFor;
    }

    start(): void {
        if (this.unsubscribeTabs) return;
        this.unsubscribeTabs = this.deps.jotaiStore.sub(tabsAtom, () => this.reconcile());
        this.reconcile();
    }

    /** Renderer teardown: cancels timers and listeners. Queued native operations finish alone. */
    stop(): void {
        this.unsubscribeTabs?.();
        this.unsubscribeTabs = null;
        for (const entry of this.entries.values()) {
            this.clearTimer(entry);
            entry.unsubscribe();
        }
        this.entries.clear();
        for (const removal of this.removals.values()) {
            if (removal.timer) clearTimeout(removal.timer);
            removal.timer = null;
        }
    }

    /** Whether the durable record equals the tab's current content. */
    isConfirmed(tabId: string): boolean {
        const entry = this.entries.get(tabId);
        if (!entry || entry.status !== "confirmed") return false;
        return sameSnapshot(entry.confirmed, this.snapshot(entry));
    }

    pause(): void {
        this.paused = true;
    }

    /** Resumes after an aborted "Clear saved data" and rewrites every dirty tab at once. */
    resume(): void {
        this.paused = false;
        for (const entry of this.entries.values()) {
            if (!entry.store.getState().dirty) continue;
            entry.status = "pending";
            entry.confirmed = null;
            this.scheduleWrite(entry, true);
        }
    }

    /**
     * Retries failed removes without their backoff and waits for every outstanding operation,
     * bounded by `timeoutMs`. Unless paused (Clear saved data), it also starts pending writes now
     * (quit).
     */
    async drain(timeoutMs = UNSAVED_GAME_DRAIN_TIMEOUT_MS): Promise<DrainResult> {
        if (!this.paused) {
            for (const entry of this.entries.values()) {
                if (entry.timer) {
                    this.clearTimer(entry);
                    this.enqueueWrite(entry);
                }
            }
        }
        for (const removal of this.removals.values()) {
            if (removal.timer) {
                clearTimeout(removal.timer);
                removal.timer = null;
                this.enqueueRemove(removal);
            }
        }
        const settled = Promise.all([...this.lanes.values()].map((lane) => lane.chain)).then(
            () => true,
        );
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<boolean>((resolve) => {
            timer = setTimeout(() => resolve(false), timeoutMs);
        });
        const completed = await Promise.race([settled, timeout]);
        clearTimeout(timer);
        const finished =
            completed &&
            [...this.lanes.values()].every((lane) => lane.outstanding === 0) &&
            [...this.removals.values()].every((removal) => removal.timer === null) &&
            this.removals.size === 0;
        return { finished };
    }

    private reconcile(): void {
        const tabs = this.deps.jotaiStore.get(tabsAtom);
        const protectedTabs = new Map(
            tabs.filter((tab) => asksBeforeDiscardingChanges(tab)).map((tab) => [tab.value, tab]),
        );
        for (const [id, entry] of [...this.entries]) {
            const next = protectedTabs.get(id);
            if (!next) {
                // Closed, or no longer a protected game: its copy must not come back.
                this.untrack(entry);
                continue;
            }
            if (next !== entry.tab) {
                const renamed = next.name !== entry.tab.name || next.type !== entry.tab.type;
                entry.tab = next;
                if (renamed && entry.store.getState().dirty) this.scheduleWrite(entry, false);
            }
        }
        for (const [id, tab] of protectedTabs) {
            if (!this.entries.has(id)) this.track(tab);
        }
    }

    private track(tab: Tab): void {
        let store: TreeStore | null;
        try {
            store = this.treeStoreFor(tab);
        } catch (error) {
            this.warn(`Unsaved game mirror could not open tab ${tab.value}: ${String(error)}`);
            return;
        }
        if (!store) return;
        const entry: Entry = {
            id: tab.value,
            tab,
            store,
            unsubscribe: () => undefined,
            timer: null,
            writeQueued: null,
            confirmed: null,
            status: "pending",
            notifiedWriteFailure: false,
            mayHaveRecord: false,
        };
        this.entries.set(tab.value, entry);
        entry.unsubscribe = store.subscribe((state, previous) => {
            if (state.dirty && !previous.dirty) {
                this.scheduleWrite(entry, true);
            } else if (!state.dirty && previous.dirty) {
                this.retire(entry);
            } else if (
                state.dirty &&
                (state.root !== previous.root || state.headers !== previous.headers)
            ) {
                this.scheduleWrite(entry, false);
            }
        });
        if (store.getState().dirty) this.scheduleWrite(entry, true);
    }

    private untrack(entry: Entry): void {
        this.entries.delete(entry.id);
        this.clearTimer(entry);
        entry.unsubscribe();
        if (entry.mayHaveRecord) this.startRemoval(entry.id, entry.tab.name);
        else this.endGeneration(entry.id);
    }

    /** The tab was saved: its copy goes; later edits start a new generation. */
    private retire(entry: Entry): void {
        this.clearTimer(entry);
        entry.status = "pending";
        entry.confirmed = null;
        if (entry.mayHaveRecord) {
            entry.mayHaveRecord = false;
            this.startRemoval(entry.id, entry.tab.name);
        } else {
            this.endGeneration(entry.id);
        }
    }

    private snapshot(entry: Entry): Snapshot {
        const state = entry.store.getState();
        return {
            root: state.root,
            headers: state.headers,
            name: entry.tab.name,
            type: entry.tab.type,
        };
    }

    private clearTimer(entry: Entry): void {
        if (entry.timer) clearTimeout(entry.timer);
        entry.timer = null;
    }

    private lane(id: string): Lane {
        let lane = this.lanes.get(id);
        if (!lane) {
            lane = { generation: 0, chain: Promise.resolve(), outstanding: 0 };
            this.lanes.set(id, lane);
        }
        return lane;
    }

    private endGeneration(id: string): void {
        this.lane(id).generation += 1;
    }

    private enqueue(id: string, operation: () => Promise<void>): void {
        const lane = this.lane(id);
        lane.outstanding += 1;
        lane.chain = lane.chain.then(operation).then(
            () => {
                lane.outstanding -= 1;
            },
            (error: unknown) => {
                lane.outstanding -= 1;
                this.warn(`Unsaved game operation for ${id} failed: ${String(error)}`);
            },
        );
    }

    private scheduleWrite(entry: Entry, immediate: boolean): void {
        if (entry.status === "confirmed") entry.status = "pending";
        this.clearTimer(entry);
        const delay = immediate ? 0 : UNSAVED_GAME_WRITE_DELAY_MS;
        entry.timer = setTimeout(() => {
            entry.timer = null;
            this.enqueueWrite(entry);
        }, delay);
    }

    private enqueueWrite(entry: Entry): void {
        // A queued write samples the newest content when it starts, so one per generation is enough.
        const generation = this.lane(entry.id).generation;
        if (entry.writeQueued === generation) return;
        entry.writeQueued = generation;
        this.enqueue(entry.id, async () => {
            if (entry.writeQueued === generation) entry.writeQueued = null;
            if (this.paused) return;
            if (this.lane(entry.id).generation !== generation) return;
            if (this.entries.get(entry.id) !== entry) return;
            // An earlier generation's remove that failed and waits for its retry must not run
            // after this write: the write replaces the record it was meant to delete.
            this.cancelRemoval(entry.id);
            const state = entry.store.getState();
            if (!state.dirty) return;
            const snapshot = this.snapshot(entry);
            let document: string;
            try {
                document = encodeUnsavedGame(entry.tab, state);
            } catch (error) {
                this.writeFailed(entry, error);
                return;
            }
            entry.mayHaveRecord = true;
            try {
                await this.deps.native.write(entry.id, document);
            } catch (error) {
                if (this.lane(entry.id).generation === generation) {
                    this.writeFailed(entry, error);
                }
                return;
            }
            if (this.lane(entry.id).generation !== generation) return;
            entry.confirmed = snapshot;
            entry.notifiedWriteFailure = false;
            if (sameSnapshot(snapshot, this.snapshot(entry))) {
                entry.status = "confirmed";
            } else {
                entry.status = "pending";
                if (!entry.timer) this.enqueueWrite(entry);
            }
        });
    }

    private writeFailed(entry: Entry, error: unknown): void {
        entry.status = "failed";
        // Writes start only on a content change, so a refused (too large) record is not retried
        // until the game changes.
        const category = categoryOf(error);
        this.warn(`Unsaved game ${entry.id} could not be stored: ${normalizeError(error).message}`);
        if (entry.notifiedWriteFailure) return;
        entry.notifiedWriteFailure = true;
        this.deps.notify(i18n.t("UnsavedGames.WriteFailed", { name: entry.tab.name, category }));
    }

    private startRemoval(id: string, name: string): void {
        this.endGeneration(id);
        const existing = this.removals.get(id);
        if (existing?.timer) clearTimeout(existing.timer);
        const removal: PendingRemoval = existing ?? {
            id,
            name,
            timer: null,
            attempts: 0,
            notified: false,
        };
        removal.timer = null;
        this.removals.set(id, removal);
        this.enqueueRemove(removal);
    }

    private cancelRemoval(id: string): void {
        const removal = this.removals.get(id);
        if (!removal) return;
        if (removal.timer) clearTimeout(removal.timer);
        removal.timer = null;
        this.removals.delete(id);
    }

    private enqueueRemove(removal: PendingRemoval): void {
        this.enqueue(removal.id, async () => {
            if (this.removals.get(removal.id) !== removal) return;
            try {
                await this.deps.native.remove(removal.id);
            } catch (error) {
                removal.attempts += 1;
                if (!removal.notified) {
                    // Retries stay silent; the native side logs every failed attempt.
                    this.warn(
                        `Recovery copy ${removal.id} could not be deleted: ${normalizeError(error).message}`,
                    );
                    removal.notified = true;
                    this.deps.notify(
                        i18n.t("UnsavedGames.RemoveFailed", {
                            name: removal.name,
                            category: categoryOf(error),
                        }),
                    );
                }
                const delay = Math.min(
                    REMOVE_RETRY_BASE_MS * 2 ** (removal.attempts - 1),
                    REMOVE_RETRY_MAX_MS,
                );
                removal.timer = setTimeout(() => {
                    removal.timer = null;
                    this.enqueueRemove(removal);
                }, delay);
                return;
            }
            if (this.removals.get(removal.id) === removal) this.removals.delete(removal.id);
        });
    }
}

let mirror: UnsavedGameMirror | null = null;

export function getUnsavedGameMirror(deps: () => UnsavedGameMirrorDeps): UnsavedGameMirror {
    mirror ??= new UnsavedGameMirror(deps());
    return mirror;
}

export function resetUnsavedGamesForTests(): void {
    mirror?.stop();
    mirror = null;
    restoreStarted = false;
}

// ---------------------------------------------------------------------------------------------
// Restore

let restoreStarted = false;

export type RestoreDeps = {
    native: UnsavedGameNative;
    jotaiStore: JotaiStore;
    setTabs: SetTabs;
    notify: (message: string) => void;
    warn?: (message: string) => void;
    startedFresh?: () => boolean;
};

export type RestoreResult =
    | { kind: "skipped" }
    | { kind: "failed"; category: string }
    | { kind: "done"; restored: number; kept: number };

/**
 * Once per renderer, and only when the renderer started without a stored workspace, admits every
 * decodable record as a dirty analysis tab under its own id. Nothing is ever deleted here.
 */
export async function restoreUnsavedGames(deps: RestoreDeps): Promise<RestoreResult> {
    if (restoreStarted) return { kind: "skipped" };
    restoreStarted = true;
    if (!(deps.startedFresh ?? workspaceStartedFresh)()) return { kind: "skipped" };
    const warn = deps.warn ?? warnSafely;

    let inventory: UnsavedGameInventory;
    try {
        inventory = await deps.native.list();
    } catch (error) {
        const category = categoryOf(error);
        warn(`Unsaved games could not be listed: ${normalizeError(error).message}`);
        deps.notify(i18n.t("UnsavedGames.RestoreFailed", { category }));
        return { kind: "failed", category };
    }

    let kept = inventory.skipped.length + inventory.omitted;
    for (const skip of inventory.skipped) {
        warn(`Unsaved game ${skip.id} was kept on disk and not opened: ${skip.reason}`);
    }
    if (inventory.omitted > 0) {
        warn(`${inventory.omitted} unsaved games beyond the listing limit were not opened`);
    }

    let restored = 0;
    for (const record of inventory.records) {
        const reason = admitRecord(record.id, record.document, deps);
        if (reason === null) {
            restored += 1;
        } else {
            kept += 1;
            warn(`Unsaved game ${record.id} was kept on disk and not opened: ${reason}`);
        }
    }

    if (restored > 0) deps.notify(i18n.t("UnsavedGames.Restored", { count: restored }));
    if (kept > 0) deps.notify(i18n.t("UnsavedGames.KeptOnDisk", { count: kept }));
    return { kind: "done", restored, kept };
}

/** Admits one record; returns `null` on success or the reason it stays on disk. */
function admitRecord(id: string, document: string, deps: RestoreDeps): string | null {
    let decoded: DecodedUnsavedGame;
    try {
        decoded = decodeUnsavedGame(document);
    } catch (error) {
        return `undecodable (${error instanceof Error ? error.message : String(error)})`;
    }
    if (deps.jotaiStore.get(tabsAtom).some((tab) => tab.value === id)) {
        return "a tab with this id is already open";
    }
    const tree = {
        ...decoded.tree,
        dirty: true,
        // The restored tab has no origin, so no earlier save can be pending or uncertain.
        sourceStamp: null,
        linkedSource: null,
        appendAttempted: false,
    } as TreeState;
    try {
        const admitted = commitNewTab({
            tab: { name: decoded.name, type: "analysis", gameOrigin: { kind: "none" } },
            setTabs: deps.setTabs,
            seed: (tabId) => tabStorage.seed(tabId, tree),
            id,
        });
        return admitted === null ? "the workspace refused the tab" : null;
    } catch (error) {
        return `admission failed (${error instanceof Error ? error.message : String(error)})`;
    }
}

// ---------------------------------------------------------------------------------------------
// Clear saved data

/**
 * Deletes every recovery copy before the caller wipes web storage. Throws (and resumes the mirror)
 * on every path that keeps the session; on success the mirror stays paused for the reload.
 */
export async function clearUnsavedGamesBeforeWipe(deps: {
    mirror: Pick<UnsavedGameMirror, "pause" | "resume" | "drain">;
    native: Pick<UnsavedGameNative, "clear">;
    wipe: () => void;
}): Promise<void> {
    deps.mirror.pause();
    let drained: DrainResult;
    try {
        drained = await deps.mirror.drain();
    } catch (error) {
        deps.mirror.resume();
        throw new Error(
            i18n.t("Menu.Help.ClearSavedData.UnsavedFailed", { category: categoryOf(error) }),
        );
    }
    if (!drained.finished) {
        deps.mirror.resume();
        throw new Error(i18n.t("Menu.Help.ClearSavedData.UnsavedPending"));
    }
    let leftover: string[];
    try {
        leftover = await deps.native.clear();
    } catch (error) {
        deps.mirror.resume();
        throw new Error(
            i18n.t("Menu.Help.ClearSavedData.UnsavedFailed", { category: categoryOf(error) }),
        );
    }
    if (leftover.length > 0) {
        deps.mirror.resume();
        throw new Error(
            i18n.t("Menu.Help.ClearSavedData.UnsavedLeftover", { count: leftover.length }),
        );
    }
    deps.wipe();
}
