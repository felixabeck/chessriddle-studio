/** The workspace's tab list, active tab and tab-close lifecycle. */
import type { SetStateAction } from "react";
import { atom } from "jotai";
import { getTabTreeKey, type Tab } from "../workspaceTypes";
import {
    WORKSPACE_STORAGE_KEY,
    loadWorkspace,
    reportPendingRemovalOverflow,
    reconcilePendingTreeRemovals,
    reconcileLegacyPuzzleRemovals,
    sweepLegacyPuzzleKeys,
    saveWorkspace,
    type Workspace,
} from "../workspace";
import { persistStorageWriteError } from "../storageWriteError";
import { tabStorage } from "../store/tabStorage";
import { reportPersistError } from "../persistError";
import { removeFileFreshness } from "../fileFreshness";
import { initializeRendererState } from "./rendererState";
import { disposeTabAtoms } from "./tabFamilies";

let initialWorkspace: Workspace | undefined;
let startedFresh = false;
let freshProcessSampled = false;

function storedWorkspaceAbsent(storage: Pick<Storage, "getItem"> = sessionStorage): boolean {
    try {
        return storage.getItem(WORKSPACE_STORAGE_KEY) === null;
    } catch {
        // An unreadable session store is not proof of a fresh start; restore stays off.
        return false;
    }
}

/**
 * Samples whether this renderer started without a stored workspace before startup seeding writes
 * `"workspace"` into `sessionStorage`.
 */
export function sampleFreshProcess(storage: Pick<Storage, "getItem"> = sessionStorage): {
    fresh: boolean;
    unreadable: boolean;
} {
    if (freshProcessSampled) {
        return { fresh: startedFresh, unreadable: false };
    }
    freshProcessSampled = true;
    try {
        const fresh = storage.getItem(WORKSPACE_STORAGE_KEY) === null;
        startedFresh = fresh;
        return { fresh, unreadable: false };
    } catch {
        startedFresh = false;
        return { fresh: false, unreadable: true };
    }
}

/** One successful document snapshot, shared by new stores without replacing their later edits. */
export function initializeWorkspace(): Workspace {
    initializeRendererState();
    if (initialWorkspace === undefined) {
        // Sampled before `loadWorkspace` writes the default workspace for an absent key, unless
        // startup restore already sampled before seeding.
        if (!freshProcessSampled) {
            startedFresh = storedWorkspaceAbsent();
            freshProcessSampled = true;
        }
        initialWorkspace = loadWorkspace(sessionStorage, WORKSPACE_STORAGE_KEY);
    }
    return initialWorkspace;
}

/**
 * Whether this renderer started without a stored workspace (process start, or after "Clear saved
 * data"), as opposed to a reload that kept its tabs. Only then are unsaved games restored.
 */
export function workspaceStartedFresh(): boolean {
    return startedFresh;
}

const committedWorkspaceAtom = atom<Workspace | null>(null);
const workspaceAtom = atom((get) => get(committedWorkspaceAtom) ?? initializeWorkspace());
const commitWorkspaceAtom = atom(
    null,
    (get, set, workspace: Workspace, onSaved?: (saved: Workspace) => void) => {
        const previous = get(workspaceAtom);
        const retainedIds = new Set(workspace.tabs.map(getTabTreeKey));
        const closedIds = new Set(
            previous.tabs.map(getTabTreeKey).filter((id) => !retainedIds.has(id)),
        );
        const protectedIds = workspace.treeOwnershipProtectedIds?.filter(
            (id) => !closedIds.has(id),
        );
        const pendingRemovalResult = reconcilePendingTreeRemovals(
            workspace.treeOwnershipPendingRemovalIds ?? [],
            closedIds,
            retainedIds,
        );
        const pendingRemovalIds = pendingRemovalResult.ids;
        const puzzleRemovals = reconcileLegacyPuzzleRemovals(
            previous.legacyPuzzleRemovalKeys ?? [],
            previous.tabs
                .filter((tab) => !workspace.tabs.some((next) => next.value === tab.value))
                .map((tab) => tab.value),
            workspace.tabs,
        );
        const canonical = {
            ...workspace,
            ...(protectedIds === undefined ? {} : { treeOwnershipProtectedIds: protectedIds }),
            treeOwnershipPendingRemovalIds:
                pendingRemovalIds.length === 0 ? undefined : pendingRemovalIds,
            legacyPuzzleRemovalKeys:
                puzzleRemovals.keys.length === 0 ? undefined : puzzleRemovals.keys,
        };
        const saved = saveWorkspace(sessionStorage, WORKSPACE_STORAGE_KEY, canonical);
        if (!saved) return false;
        reportPendingRemovalOverflow(
            pendingRemovalResult.droppedIds.length,
            puzzleRemovals.droppedKeys.length,
        );
        set(committedWorkspaceAtom, saved);
        sweepLegacyPuzzleKeys(saved);
        onSaved?.(saved);
        return true;
    },
);

export const tabsAtom = atom(
    (get) => get(workspaceAtom).tabs,
    (
        get,
        set,
        update: Tab[] | ((tabs: Tab[]) => Tab[]),
        requestedActiveTab?: string,
        onSaved?: (saved: Workspace) => void,
    ) => {
        const workspace = get(workspaceAtom);
        const tabs = typeof update === "function" ? update(workspace.tabs) : update;
        const desiredActiveTab = requestedActiveTab ?? workspace.activeTab;
        const activeTab = tabs.some((tab) => tab.value === desiredActiveTab)
            ? desiredActiveTab
            : (tabs[0]?.value ?? null);
        return set(commitWorkspaceAtom, { ...workspace, tabs, activeTab }, onSaved);
    },
);

export const activeTabAtom = atom(
    (get) => get(workspaceAtom).activeTab,
    (get, set, update: string | null | ((activeTab: string | null) => string | null)) => {
        const workspace = get(workspaceAtom);
        const activeTab = typeof update === "function" ? update(workspace.activeTab) : update;
        return set(commitWorkspaceAtom, {
            ...workspace,
            activeTab: workspace.tabs.some((tab) => tab.value === activeTab) ? activeTab : null,
        });
    },
);

/** Transient close intent shared with async listeners; never persisted. */
export const closingTabsAtom = atom<Set<string>>(new Set<string>());

/** Reclaims per-tab state after workspace metadata stops owning it. */
export function reclaimTabLocalState(tabId: string, treeKey = tabId) {
    removeFileFreshness(tabId);
    let cleanupError: unknown;
    try {
        tabStorage.remove(treeKey);
    } catch (error) {
        cleanupError = error;
    }
    try {
        disposeTabAtoms(tabId);
    } catch (error) {
        cleanupError ??= error;
    }
    if (cleanupError !== undefined) {
        reportPersistError(persistStorageWriteError(cleanupError));
    }
}

/** Commits tab metadata, then attempts every tab-local cleanup category. */
export const closeWorkspaceTabAtom = atom(null, (get, set, tabId: string) => {
    const workspace = get(workspaceAtom);
    const index = workspace.tabs.findIndex((tab) => tab.value === tabId);
    if (index === -1) return false;
    const tabs = workspace.tabs.filter((tab) => tab.value !== tabId);
    const activeTab =
        workspace.activeTab !== tabId
            ? workspace.activeTab
            : (tabs[index]?.value ?? tabs[index - 1]?.value ?? null);
    if (!set(commitWorkspaceAtom, { ...workspace, tabs, activeTab })) return false;
    reclaimTabLocalState(tabId, getTabTreeKey(workspace.tabs[index]));
    return true;
});

/**
 * Puts `successor` in `tabId`'s place (same position, active if it was), then reclaims the
 * replaced tab's local state as a close does. `onCommitted` runs after the commit and before that
 * reclaim, while the replaced tab's runtime atoms still hold their values.
 */
export const replaceWorkspaceTabAtom = atom(
    null,
    (get, set, tabId: string, successor: Tab, onCommitted?: () => void) => {
        const workspace = get(workspaceAtom);
        const index = workspace.tabs.findIndex((tab) => tab.value === tabId);
        if (index === -1) return false;
        if (workspace.tabs.some((tab) => tab.value === successor.value)) return false;
        const tabs = workspace.tabs.map((tab, position) => (position === index ? successor : tab));
        const activeTab = workspace.activeTab === tabId ? successor.value : workspace.activeTab;
        if (!set(commitWorkspaceAtom, { ...workspace, tabs, activeTab })) return false;
        try {
            onCommitted?.();
        } finally {
            reclaimTabLocalState(tabId, getTabTreeKey(workspace.tabs[index]));
        }
        return true;
    },
);

export function updateTabById(
    setTabs: (
        update: Tab[] | ((tabs: Tab[]) => Tab[]),
        activeTab?: string,
        onSaved?: (saved: Workspace) => void,
    ) => boolean,
    tabId: string,
    update: SetStateAction<Tab>,
    onAdmitted?: (successor: Tab) => void,
) {
    let found = false;
    const committed = setTabs(
        (tabs) =>
            tabs.map((tab) => {
                if (tab.value !== tabId) return tab;
                found = true;
                return typeof update === "function" ? update(tab) : update;
            }),
        undefined,
        onAdmitted
            ? (saved) => {
                  const successor = saved.tabs.find((tab) => tab.value === tabId);
                  if (found && successor) onAdmitted(successor);
              }
            : undefined,
    );
    return committed && found;
}

export const currentTabAtom = atom(
    (get) => get(tabsAtom).find((tab) => tab.value === get(activeTabAtom)),
    (get, set, newValue: Tab | ((currentTab: Tab) => Tab)) => {
        const activeTab = get(activeTabAtom);
        return (
            activeTab !== null &&
            updateTabById((update) => set(tabsAtom, update), activeTab, newValue)
        );
    },
);
