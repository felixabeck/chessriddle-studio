/**
 * Legacy 1.1.0 unsaved-game migration.
 *
 * New recovery copies live in `<app_data>/workspace-session/` (`src/state/workspaceSession.ts`).
 * On a fresh process start, this module lists any remaining `<app_data>/unsaved-games/<uuid>.json`
 * records from 1.1.0, admits any record whose id is not already open as an analysis tab, and
 * removes each migrated record once the session mirror confirms that tab or the tab is closed.
 */
import i18n from "i18next";
import type { getDefaultStore } from "jotai";
import { z } from "zod";
import type { UnsavedGameInventory } from "@/bindings";
import { errorCategoryOf, normalizeError, warnSafely } from "@/platform/errors";
import { tauri } from "@/platform/tauri";
import { tabsAtom, workspaceStartedFresh } from "@/state/atoms";
import { prepareTreeForStorage, TREE_STORAGE_VERSION, tabStorage } from "@/state/store/tabStorage";
import type { TreeState } from "@/utils/treeReducer";
import { commitNewTab, type SetTabs } from "@/utils/tabs";

export const UNSAVED_GAME_VERSION = 1;
/** Longest tab name a legacy record accepts. */
export const UNSAVED_GAME_NAME_MAX = 1024;
const UNSAVED_GAME_TYPE_MAX = 64;
const REMOVE_RETRY_BASE_MS = 1000;
const REMOVE_RETRY_MAX_MS = 30_000;

type JotaiStore = ReturnType<typeof getDefaultStore>;

export type UnsavedGameNative = {
    list: () => Promise<UnsavedGameInventory>;
    remove: (id: string) => Promise<unknown>;
    clear: () => Promise<string[]>;
};

export const nativeUnsavedGames: UnsavedGameNative = {
    list: () => tauri.listUnsavedGames(),
    remove: (id) => tauri.removeUnsavedGame(id),
    clear: () => tauri.clearUnsavedGames(),
};

// ---------------------------------------------------------------------------------------------
// Legacy record reader

const recordSchema = z.object({
    version: z.literal(UNSAVED_GAME_VERSION),
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

/** Throws when the document is not a valid legacy record; the caller keeps the file. */
export function decodeUnsavedGame(document: string): DecodedUnsavedGame {
    const record = recordSchema.parse(JSON.parse(document));
    return { name: record.tab.name, tree: prepareTreeForStorage(record.tree.state) };
}

// ---------------------------------------------------------------------------------------------
// Legacy migration on fresh process start (O4)

export type LegacyMigrationObserver = {
    isConfirmed: (tabId: string) => boolean;
    onConfirmedChange: (listener: () => void) => () => void;
};

export type RestoreDeps = {
    native: UnsavedGameNative;
    jotaiStore: JotaiStore;
    setTabs: SetTabs;
    notify: (message: string) => void;
    warn?: (message: string) => void;
    startedFresh?: () => boolean;
    sessionMirror?: LegacyMigrationObserver;
};

export type RestoreResult =
    | { kind: "skipped" }
    | { kind: "failed"; category: string }
    | { kind: "done"; restored: number; kept: number };

type PendingLegacyRemoval = {
    id: string;
    name: string;
    timer: ReturnType<typeof setTimeout> | null;
    inFlight: boolean;
    attempts: number;
    notified: boolean;
};

let restoreStarted = false;
const activeRemovals = new Map<string, PendingLegacyRemoval>();
let unsubscribeTabsWatcher: (() => void) | null = null;
let unsubscribeConfirmWatcher: (() => void) | null = null;

export function resetUnsavedGamesForTests(): void {
    restoreStarted = false;
    unsubscribeTabsWatcher?.();
    unsubscribeTabsWatcher = null;
    unsubscribeConfirmWatcher?.();
    unsubscribeConfirmWatcher = null;
    for (const entry of activeRemovals.values()) {
        if (entry.timer) clearTimeout(entry.timer);
    }
    activeRemovals.clear();
}

/**
 * Once per fresh renderer start (after workspace session seeding), lists legacy 1.1.0 records,
 * admits any record whose id is not already an open tab as an analysis tab, and schedules removal
 * of each legacy record once the session mirror confirms that tab or that tab is closed.
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
        const category = errorCategoryOf(error);
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
    const tracked: Array<{ id: string; name: string }> = [];
    for (const record of inventory.records) {
        const openTab = deps.jotaiStore.get(tabsAtom).find((tab) => tab.value === record.id);
        if (openTab) {
            // Already open (e.g. restored from workspace-session); do not admit again, but remove
            // the legacy copy once confirmed by the session mirror or closed.
            tracked.push({ id: record.id, name: openTab.name });
            continue;
        }
        const outcome = admitRecord(record.id, record.document, deps);
        if (outcome.ok) {
            restored += 1;
            tracked.push({ id: record.id, name: outcome.name });
        } else {
            kept += 1;
            warn(`Unsaved game ${record.id} was kept on disk and not opened: ${outcome.reason}`);
        }
    }

    if (tracked.length > 0) {
        watchMigratedRecords(tracked, deps, warn);
    }

    if (restored > 0) deps.notify(i18n.t("UnsavedGames.Restored", { count: restored }));
    if (kept > 0) deps.notify(i18n.t("UnsavedGames.KeptOnDisk", { count: kept }));
    return { kind: "done", restored, kept };
}

function admitRecord(
    id: string,
    document: string,
    deps: RestoreDeps,
): { ok: true; name: string } | { ok: false; reason: string } {
    let decoded: DecodedUnsavedGame;
    try {
        decoded = decodeUnsavedGame(document);
    } catch (error) {
        return {
            ok: false,
            reason: `undecodable (${error instanceof Error ? error.message : String(error)})`,
        };
    }
    const tree = {
        ...decoded.tree,
        dirty: true,
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
        return admitted === null
            ? { ok: false, reason: "the workspace refused the tab" }
            : { ok: true, name: decoded.name };
    } catch (error) {
        return {
            ok: false,
            reason: `admission failed (${error instanceof Error ? error.message : String(error)})`,
        };
    }
}

function watchMigratedRecords(
    records: Array<{ id: string; name: string }>,
    deps: RestoreDeps,
    warn: (message: string) => void,
): void {
    const waiting = new Map<string, string>(records.map((entry) => [entry.id, entry.name]));

    const check = () => {
        const openIds = new Set(deps.jotaiStore.get(tabsAtom).map((tab) => tab.value));
        for (const [id, name] of [...waiting]) {
            const isClosed = !openIds.has(id);
            const isConfirmed = deps.sessionMirror?.isConfirmed(id) ?? false;
            if (!isClosed && !isConfirmed) continue;
            waiting.delete(id);
            scheduleLegacyRemoval(id, name, deps, warn);
        }
        if (waiting.size === 0) {
            unsubscribeTabsWatcher?.();
            unsubscribeTabsWatcher = null;
            unsubscribeConfirmWatcher?.();
            unsubscribeConfirmWatcher = null;
        }
    };

    unsubscribeTabsWatcher?.();
    unsubscribeTabsWatcher = deps.jotaiStore.sub(tabsAtom, check);
    unsubscribeConfirmWatcher?.();
    unsubscribeConfirmWatcher = deps.sessionMirror?.onConfirmedChange(check) ?? null;
    check();
}

function scheduleLegacyRemoval(
    id: string,
    name: string,
    deps: RestoreDeps,
    warn: (message: string) => void,
): void {
    if (activeRemovals.has(id)) return;
    const entry: PendingLegacyRemoval = {
        id,
        name,
        timer: null,
        inFlight: false,
        attempts: 0,
        notified: false,
    };
    activeRemovals.set(id, entry);
    void attemptLegacyRemoval(entry, deps, warn);
}

async function attemptLegacyRemoval(
    entry: PendingLegacyRemoval,
    deps: RestoreDeps,
    warn: (message: string) => void,
): Promise<void> {
    if (activeRemovals.get(entry.id) !== entry || entry.inFlight) return;
    entry.inFlight = true;
    try {
        await deps.native.remove(entry.id);
        if (activeRemovals.get(entry.id) === entry) activeRemovals.delete(entry.id);
    } catch (error) {
        entry.inFlight = false;
        if (activeRemovals.get(entry.id) !== entry) return;
        entry.attempts += 1;
        if (!entry.notified) {
            warn(
                `Legacy unsaved game ${entry.id} could not be deleted: ${normalizeError(error).message}`,
            );
            entry.notified = true;
            deps.notify(
                i18n.t("UnsavedGames.RemoveFailed", {
                    name: entry.name,
                    category: errorCategoryOf(error),
                }),
            );
        }
        const delay = Math.min(
            REMOVE_RETRY_BASE_MS * 2 ** (entry.attempts - 1),
            REMOVE_RETRY_MAX_MS,
        );
        entry.timer = setTimeout(() => {
            entry.timer = null;
            void attemptLegacyRemoval(entry, deps, warn);
        }, delay);
    }
}
