/**
 * Durable workspace session store mirror and startup restore.
 *
 * The renderer keeps its open tabs, page tabs and per-tab game trees in `sessionStorage`, which
 * WebKitGTK holds only in memory. This module mirrors those exact `sessionStorage` strings into
 * the native `<app_data>/workspace-session/` store while the app runs, and seeds `sessionStorage`
 * from that store on a fresh process start before `initializeWorkspace()` or path-owner
 * snapshotting reads it.
 *
 * Crash-point consistency:
 * - A new tab enters the durable `workspace` leaf only once a tree leaf for it is durable (or when
 *   it has no stored tree, e.g. a `new` tab).
 * - An already-durable tab stays listed in the durable `workspace` leaf while a newer write of its
 *   tree is pending or failed, so a crash restores its last durable version.
 * - A tree leaf (or dropped `page-tabs` leaf) is removed only after a durable `workspace` leaf no
 *   longer lists it.
 */
import i18n from "i18next";
import type { getDefaultStore } from "jotai";
import { z } from "zod";
import type {
    WorkspaceSessionFixedLeaves,
    WorkspaceSessionLeafState,
    WorkspaceSessionNames,
    WorkspaceSessionQuarantineResult,
    WorkspaceSessionReadEntry,
} from "@/bindings";
import { errorCategoryOf, normalizeError, warnSafely } from "@/platform/errors";
import { tauri } from "@/platform/tauri";
import { sampleFreshProcess, tabsAtom } from "@/state/atoms";
import { PAGE_TABS_STORAGE_KEY, pageTabsAtom } from "@/state/pageTabs";
import { readRestoreOpenTabsPreference } from "@/state/restoreOpenTabs";
import { serializeStorageValue } from "@/state/store/debouncedStorage";
import { inspectRawTreeForRestore, tabStorage } from "@/state/store/tabStorage";
import { getCachedTreeStore, subscribeTreeStoreCreated, type TreeStore } from "@/state/store/tree";
import {
    MAX_WORKSPACE_TABS,
    parseStoredWorkspaceForRestore,
    WORKSPACE_STORAGE_KEY,
    type Workspace,
} from "@/state/workspace";
import { getTabTreeKey, type Tab } from "@/state/workspaceTypes";
import { asksBeforeDiscardingChanges } from "@/utils/tabs";

export const WORKSPACE_LEAF_KEY = "workspace";
export const PAGE_TABS_LEAF_KEY = "page-tabs";
export const WORKSPACE_SESSION_UNAVAILABLE_KEY = "workspace-session-unavailable";
/** Maximum keys per `readWorkspaceSessionLeaves` IPC call (matches native `WORKSPACE_SESSION_READ_MAX_KEYS`). */
export const WORKSPACE_SESSION_READ_MAX_KEYS = 256;
/** Coalescing delay for session mirror writes; first dirtying change writes at once. */
export const WORKSPACE_SESSION_WRITE_DELAY_MS = 1000;
/** Upper bound a quit or "Clear saved data" waits for outstanding native operations. */
export const WORKSPACE_SESSION_DRAIN_TIMEOUT_MS = 2000;
const REMOVE_RETRY_BASE_MS = 1000;
const REMOVE_RETRY_MAX_MS = 30_000;

type JotaiStore = ReturnType<typeof getDefaultStore>;

export type WorkspaceSessionNative = {
    writeLeaf: (key: string, content: string) => Promise<unknown>;
    readFixed: () => Promise<WorkspaceSessionFixedLeaves>;
    readLeaves: (keys: string[]) => Promise<WorkspaceSessionReadEntry[]>;
    listNames: () => Promise<WorkspaceSessionNames>;
    removeLeaf: (key: string) => Promise<unknown>;
    quarantine: (keys: string[] | null) => Promise<WorkspaceSessionQuarantineResult>;
    clear: () => Promise<string[]>;
};

export const nativeWorkspaceSession: WorkspaceSessionNative = {
    writeLeaf: (key, content) => tauri.writeWorkspaceSessionLeaf(key, content),
    readFixed: () => tauri.readWorkspaceSessionFixed(),
    readLeaves: (keys) => tauri.readWorkspaceSessionLeaves(keys),
    listNames: () => tauri.listWorkspaceSessionNames(),
    removeLeaf: (key) => tauri.removeWorkspaceSessionLeaf(key),
    quarantine: (keys) => tauri.quarantineWorkspaceSessionLeaves(keys),
    clear: () => tauri.clearWorkspaceSession(),
};

export type DrainResult = { finished: boolean };

const uuidSchema = z.string().uuid();

function isCanonicalUuid(value: string): boolean {
    return value === value.toLowerCase() && uuidSchema.safeParse(value).success;
}

function persistStoreUnavailableMarker(session: Storage): void {
    try {
        session.setItem(WORKSPACE_SESSION_UNAVAILABLE_KEY, "1");
    } catch {
        // In-memory storeUnavailable still protects this load if sessionStorage refuses writes.
    }
}

function readStoreUnavailableMarker(session: Pick<Storage, "getItem">): boolean {
    try {
        return session.getItem(WORKSPACE_SESSION_UNAVAILABLE_KEY) === "1";
    } catch {
        return false;
    }
}

function clearStoreUnavailableMarker(session: Pick<Storage, "removeItem">): void {
    try {
        session.removeItem(WORKSPACE_SESSION_UNAVAILABLE_KEY);
    } catch {
        // Best-effort cleanup when Clear saved data succeeded on the session store.
    }
}

// ---------------------------------------------------------------------------------------------
// Startup notices & restore state shared with the mirror

// Each notice text is a literal `i18n.t` call so `i18next-cli extract` keeps its catalogue keys.
const NOTICE_TEXT = {
    "WorkspaceSession.RestoreFailed": (options?: Record<string, unknown>) =>
        i18n.t("WorkspaceSession.RestoreFailed", { category: String(options?.category ?? "") }),
    "WorkspaceSession.Quarantined": () => i18n.t("WorkspaceSession.Quarantined"),
    "WorkspaceSession.SeedQuotaFailed": () => i18n.t("WorkspaceSession.SeedQuotaFailed"),
    "WorkspaceSession.SkippedTabs": (options?: Record<string, unknown>) =>
        i18n.t("WorkspaceSession.SkippedTabs", { count: Number(options?.count ?? 0) }),
} as const;

export type QueuedSessionNotice = {
    key: keyof typeof NOTICE_TEXT;
    options?: Record<string, unknown>;
    color?: string;
};

type StartupRestoreHandoff = {
    storeUnavailable: boolean;
    durableValues: Map<string, string>;
    durableWorkspaceTabValues: Set<string>;
    durableWorkspaceTabKeys: Set<string>;
    removalTargets: Set<string>;
    durableWorkspaceSynced: boolean;
};

let pendingNotices: QueuedSessionNotice[] = [];
let startupHandoff: StartupRestoreHandoff = emptyHandoff();

function emptyHandoff(): StartupRestoreHandoff {
    return {
        storeUnavailable: false,
        durableValues: new Map(),
        durableWorkspaceTabValues: new Set(),
        durableWorkspaceTabKeys: new Set(),
        removalTargets: new Set(),
        durableWorkspaceSynced: false,
    };
}

function queueNotice(notice: QueuedSessionNotice): void {
    pendingNotices.push(notice);
}

/** Fail-closed fallback when `restoreWorkspaceSessionAtStart` throws unexpectedly in bootstrap. */
export function markWorkspaceSessionRestoreFailed(error: unknown, session?: Storage): void {
    const category = errorCategoryOf(error);
    startupHandoff.storeUnavailable = true;
    try {
        persistStoreUnavailableMarker(session ?? sessionStorage);
    } catch {
        // Accessing sessionStorage itself may throw SecurityError; in-memory state and notice still stand.
    }
    queueNotice({
        key: "WorkspaceSession.RestoreFailed",
        options: { category },
        color: "red",
    });
}

/** Delivers any notices recorded during bootstrap once i18n and notifications are mounted. */
export function flushWorkspaceSessionNotices(
    notify: (message: string, color?: string) => void,
): void {
    const queued = pendingNotices;
    pendingNotices = [];
    for (const notice of queued) {
        notify(NOTICE_TEXT[notice.key](notice.options), notice.color);
    }
}

// ---------------------------------------------------------------------------------------------
// Startup restore (O3)

export type RestoreSessionDeps = {
    native?: WorkspaceSessionNative;
    session?: Storage;
    local?: Pick<Storage, "getItem">;
    warn?: (message: string) => void;
    sampleFresh?: () => { fresh: boolean; unreadable: boolean };
    readRestorePreference?: () => boolean;
};

export type RestoreSessionResult =
    | { kind: "skipped"; reason: "reload" | "storage-unreadable" }
    | { kind: "empty" }
    | { kind: "unavailable"; category: string }
    | { kind: "quarantined"; storeUnavailable: boolean }
    | { kind: "quota-failed" }
    | { kind: "restored"; tabCount: number; skippedCount: number };

function leafIsPresent(state: WorkspaceSessionLeafState): boolean {
    return state.kind !== "absent";
}

function tabHoldsUnsavedWork(tab: Tab, rawTree: string | undefined): boolean {
    if (!asksBeforeDiscardingChanges(tab)) return false;
    if (rawTree === undefined) return false;
    const verdict = inspectRawTreeForRestore(rawTree);
    return verdict === "dirty" || verdict === "undecodable" || verdict === "append-outstanding";
}

function resolveActiveTab(tabs: readonly Tab[], previous: string | null): string | null {
    if (tabs.length === 0) return null;
    return tabs.some((tab) => tab.value === previous) ? previous : tabs[0]!.value;
}

/** Returns a failure category string when quarantine threw or left leaves unmoved, else `null`. */
async function quarantineFailed(
    native: WorkspaceSessionNative,
    keys: string[] | null,
    warn: (message: string) => void,
): Promise<string | null> {
    try {
        const result = await native.quarantine(keys);
        if (result.failed.length > 0) {
            warn(`workspace-session quarantine left ${result.failed.length} leaf(s)`);
            return "io";
        }
        return null;
    } catch (error) {
        warn(`workspace-session quarantine failed: ${normalizeError(error).message}`);
        return errorCategoryOf(error);
    }
}

/**
 * Runs in `startApplication` before `initializeWorkspace()` and before `initializeRendererState()`.
 * On a fresh process start, seeds `sessionStorage` from `<app_data>/workspace-session/` so the
 * existing reload path restores every tab with its origin, `sourceStamp`, and current move.
 */
export async function restoreWorkspaceSessionAtStart(
    deps: RestoreSessionDeps = {},
): Promise<RestoreSessionResult> {
    const native = deps.native ?? nativeWorkspaceSession;
    const session = deps.session ?? sessionStorage;
    const local = deps.local ?? localStorage;
    const warn = deps.warn ?? warnSafely;
    const sample = deps.sampleFresh ?? (() => sampleFreshProcess(session));
    const readPref = deps.readRestorePreference ?? (() => readRestoreOpenTabsPreference(local));

    startupHandoff = emptyHandoff();

    const { fresh, unreadable } = sample();
    if (unreadable) return { kind: "skipped", reason: "storage-unreadable" };
    if (!fresh) {
        if (readStoreUnavailableMarker(session)) {
            startupHandoff.storeUnavailable = true;
        }
        return { kind: "skipped", reason: "reload" };
    }

    const restoreEnabled = readPref();

    let fixed: WorkspaceSessionFixedLeaves;
    let names: WorkspaceSessionNames;
    try {
        [fixed, names] = await Promise.all([native.readFixed(), native.listNames()]);
    } catch (error) {
        const category = errorCategoryOf(error);
        warn(`workspace-session read failed: ${normalizeError(error).message}`);
        startupHandoff.storeUnavailable = true;
        persistStoreUnavailableMarker(session);
        queueNotice({ key: "WorkspaceSession.RestoreFailed", options: { category }, color: "red" });
        return { kind: "unavailable", category };
    }

    if (
        !leafIsPresent(fixed.workspace) &&
        !leafIsPresent(fixed.pageTabs) &&
        names.names.length === 0 &&
        names.omitted === 0
    ) {
        return { kind: "empty" };
    }

    const parsedWorkspace =
        fixed.workspace.kind === "record"
            ? parseStoredWorkspaceForRestore(fixed.workspace.content)
            : null;

    if (!parsedWorkspace) {
        warn("workspace-session metadata invalid; quarantining");
        const failureCategory = await quarantineFailed(native, null, warn);
        const failed = failureCategory !== null;
        startupHandoff.storeUnavailable = failed;
        if (failed) persistStoreUnavailableMarker(session);
        queueNotice({ key: "WorkspaceSession.Quarantined" });
        return { kind: "quarantined", storeUnavailable: failed };
    }

    const rawWorkspace = fixed.workspace.kind === "record" ? fixed.workspace.content : "";
    const requestedKeys: string[] = [];
    const requestedSet = new Set<string>();
    for (const tab of parsedWorkspace.tabs) {
        const key = getTabTreeKey(tab);
        if (isCanonicalUuid(key) && !requestedSet.has(key)) {
            requestedSet.add(key);
            requestedKeys.push(key);
        }
    }

    // Workspace schema caps tabs at MAX_WORKSPACE_TABS (100) <= WORKSPACE_SESSION_READ_MAX_KEYS (256),
    // so every valid workspace fits in a single native readLeaves request.
    let readEntries: WorkspaceSessionReadEntry[] = [];
    if (requestedKeys.length > 0) {
        try {
            readEntries = await native.readLeaves(requestedKeys.slice(0, MAX_WORKSPACE_TABS));
        } catch (error) {
            const category = errorCategoryOf(error);
            warn(`workspace-session leaves read failed: ${normalizeError(error).message}`);
            startupHandoff.storeUnavailable = true;
            persistStoreUnavailableMarker(session);
            queueNotice({
                key: "WorkspaceSession.RestoreFailed",
                options: { category },
                color: "red",
            });
            return { kind: "unavailable", category };
        }
    }

    const treeRecords = new Map<string, string>();
    const skippedKeys = new Set<string>();
    for (const entry of readEntries) {
        if (entry.state.kind === "record") {
            treeRecords.set(entry.key, entry.state.content);
        } else if (entry.state.kind === "skipped") {
            skippedKeys.add(entry.key);
            warn(`workspace-session skipped ${entry.key}: ${entry.state.reason}`);
        }
    }

    const quarantineTargets = [...skippedKeys];
    if (restoreEnabled && fixed.pageTabs.kind === "skipped") {
        quarantineTargets.push(PAGE_TABS_LEAF_KEY);
        warn(`workspace-session skipped page-tabs: ${fixed.pageTabs.reason}`);
    }
    if (quarantineTargets.length > 0) {
        const failureCategory = await quarantineFailed(native, quarantineTargets, warn);
        if (failureCategory !== null) {
            startupHandoff.storeUnavailable = true;
            persistStoreUnavailableMarker(session);
            if (skippedKeys.size === 0) {
                queueNotice({
                    key: "WorkspaceSession.RestoreFailed",
                    options: { category: failureCategory },
                    color: "red",
                });
            }
        }
    }
    if (skippedKeys.size > 0) {
        queueNotice({
            key: "WorkspaceSession.SkippedTabs",
            options: { count: skippedKeys.size },
        });
    }

    const nonSkippedTabs = parsedWorkspace.tabs.filter(
        (tab) => !skippedKeys.has(getTabTreeKey(tab)),
    );
    const keptTabs = restoreEnabled
        ? nonSkippedTabs
        : nonSkippedTabs.filter((tab) =>
              tabHoldsUnsavedWork(tab, treeRecords.get(getTabTreeKey(tab))),
          );

    const keptTreeKeys = new Set(keptTabs.map(getTabTreeKey));
    const removalTargets = new Set<string>();

    for (const name of names.names) {
        if (!keptTreeKeys.has(name) && !skippedKeys.has(name)) {
            removalTargets.add(name);
        }
    }
    for (const key of treeRecords.keys()) {
        if (!keptTreeKeys.has(key)) {
            removalTargets.add(key);
        }
    }
    if (!restoreEnabled && leafIsPresent(fixed.pageTabs)) {
        removalTargets.add(PAGE_TABS_LEAF_KEY);
    }

    const shouldSeedWorkspace = restoreEnabled || keptTabs.length > 0;
    const workspaceModified = !restoreEnabled || skippedKeys.size > 0;

    if (shouldSeedWorkspace) {
        const workspaceToSeed: Workspace = workspaceModified
            ? {
                  ...parsedWorkspace,
                  tabs: keptTabs,
                  activeTab: resolveActiveTab(keptTabs, parsedWorkspace.activeTab),
              }
            : parsedWorkspace;
        const workspacePayload = workspaceModified
            ? serializeStorageValue(workspaceToSeed)
            : rawWorkspace;

        const seededKeys: string[] = [];
        try {
            // Seed tree leaves first, then pageTabs, then workspace last (O3).
            for (const tab of keptTabs) {
                const key = getTabTreeKey(tab);
                const raw = treeRecords.get(key);
                if (raw !== undefined) {
                    session.setItem(key, raw);
                    seededKeys.push(key);
                }
            }
            if (restoreEnabled && fixed.pageTabs.kind === "record") {
                session.setItem(PAGE_TABS_STORAGE_KEY, fixed.pageTabs.content);
                seededKeys.push(PAGE_TABS_STORAGE_KEY);
            }
            session.setItem(WORKSPACE_STORAGE_KEY, workspacePayload);
            seededKeys.push(WORKSPACE_STORAGE_KEY);
        } catch (error) {
            warn(
                `workspace-session seeding failed; rolling back: ${normalizeError(error).message}`,
            );
            for (const key of seededKeys) {
                try {
                    session.removeItem(key);
                } catch {
                    // Best-effort rollback of keys written before the quota failure.
                }
            }
            startupHandoff.storeUnavailable = true;
            persistStoreUnavailableMarker(session);
            queueNotice({ key: "WorkspaceSession.SeedQuotaFailed", color: "red" });
            return { kind: "quota-failed" };
        }
    }

    startupHandoff.durableValues.set(WORKSPACE_LEAF_KEY, rawWorkspace);
    for (const tab of parsedWorkspace.tabs) {
        startupHandoff.durableWorkspaceTabValues.add(tab.value);
        startupHandoff.durableWorkspaceTabKeys.add(getTabTreeKey(tab));
    }
    if (fixed.pageTabs.kind === "record") {
        startupHandoff.durableValues.set(PAGE_TABS_LEAF_KEY, fixed.pageTabs.content);
    }
    for (const [key, raw] of treeRecords) {
        if (keptTreeKeys.has(key)) {
            startupHandoff.durableValues.set(key, raw);
        }
    }
    startupHandoff.removalTargets = removalTargets;
    startupHandoff.durableWorkspaceSynced = shouldSeedWorkspace && !workspaceModified;

    return {
        kind: "restored",
        tabCount: shouldSeedWorkspace ? keptTabs.length : 0,
        skippedCount: skippedKeys.size,
    };
}

// ---------------------------------------------------------------------------------------------
// Session mirror (O2)

type Lane = {
    generation: number;
    chain: Promise<void>;
    outstanding: number;
};

type PendingRemoval = {
    key: string;
    timer: ReturnType<typeof setTimeout> | null;
    attempts: number;
    notified: boolean;
};

type TreeSubscription = {
    treeKey: string;
    unsubscribe: () => void;
};

export type WorkspaceSessionMirrorDeps = {
    native: WorkspaceSessionNative;
    jotaiStore: JotaiStore;
    notify: (message: string) => void;
    warn?: (message: string) => void;
    session?: Storage;
    treeStoreFor?: (tab: Tab) => TreeStore | null;
    onTreeStoreCreated?: (listener: (tabId: string, store: TreeStore) => void) => () => void;
    storeUnavailable?: boolean;
    initialHandoff?: StartupRestoreHandoff;
};

export class WorkspaceSessionMirror {
    private readonly lanes = new Map<string, Lane>();
    private readonly writeTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private readonly writeQueued = new Map<string, number>();
    private readonly durableValues = new Map<string, string>();
    private readonly durableWorkspaceTabValues = new Set<string>();
    private readonly durableWorkspaceTabKeys = new Set<string>();
    private readonly knownOwnedTreeKeys = new Set<string>();
    private readonly removals = new Map<string, PendingRemoval>();
    private readonly notifiedWriteFailure = new Set<string>();
    private readonly treeSubs = new Map<string, TreeSubscription>();
    private readonly confirmedListeners = new Set<() => void>();

    private unsubscribeTabs: (() => void) | null = null;
    private unsubscribePageTabs: (() => void) | null = null;
    private unsubscribeTabStorage: (() => void) | null = null;
    private unsubscribeTreeStoreCreated: (() => void) | null = null;
    private started = false;
    private paused = false;
    private storeUnavailable: boolean;
    /** True once the durable `workspace` leaf on disk matches the current session's baseline. */
    private durableWorkspaceSynced = false;
    private readonly warn: (message: string) => void;
    private readonly session: Storage;
    private readonly treeStoreFor: (tab: Tab) => TreeStore | null;
    private readonly onTreeStoreCreated: (
        listener: (tabId: string, store: TreeStore) => void,
    ) => () => void;

    constructor(private readonly deps: WorkspaceSessionMirrorDeps) {
        this.warn = deps.warn ?? warnSafely;
        this.session = deps.session ?? sessionStorage;
        this.treeStoreFor = deps.treeStoreFor ?? ((tab) => getCachedTreeStore(tab.value) ?? null);
        this.onTreeStoreCreated = deps.onTreeStoreCreated ?? subscribeTreeStoreCreated;
        const handoff = deps.initialHandoff ?? startupHandoff;
        this.storeUnavailable =
            deps.storeUnavailable ??
            (handoff.storeUnavailable || readStoreUnavailableMarker(this.session));
        for (const [k, v] of handoff.durableValues) this.durableValues.set(k, v);
        for (const v of handoff.durableWorkspaceTabValues) this.durableWorkspaceTabValues.add(v);
        for (const k of handoff.durableWorkspaceTabKeys) this.durableWorkspaceTabKeys.add(k);
        for (const key of handoff.removalTargets) {
            if (key === WORKSPACE_LEAF_KEY) continue;
            this.removals.set(key, { key, timer: null, attempts: 0, notified: false });
        }
        this.durableWorkspaceSynced = handoff.durableWorkspaceSynced;
    }

    onConfirmedChange(listener: () => void): () => void {
        this.confirmedListeners.add(listener);
        return () => {
            this.confirmedListeners.delete(listener);
        };
    }

    private notifyConfirmedChange(): void {
        for (const listener of this.confirmedListeners) listener();
    }

    start(): void {
        if (this.started) return;
        this.started = true;
        this.unsubscribeTabs = this.deps.jotaiStore.sub(tabsAtom, () => this.reconcileWorkspace());
        this.unsubscribePageTabs = this.deps.jotaiStore.sub(pageTabsAtom, () => {
            this.scheduleWrite(PAGE_TABS_LEAF_KEY, false);
        });
        this.unsubscribeTabStorage = tabStorage.subscribeCommittedWrite((treeKey) => {
            if (!isCanonicalUuid(treeKey)) return;
            const tab = this.currentTabs().find((entry) => getTabTreeKey(entry) === treeKey);
            if (!tab) return;
            this.ensureTreeSubscription(tab);
            this.knownOwnedTreeKeys.add(treeKey);
            const immediate = !this.durableValues.has(treeKey);
            this.scheduleWrite(treeKey, immediate);
        });
        this.unsubscribeTreeStoreCreated = this.onTreeStoreCreated((tabId, store) => {
            const tab = this.currentTabs().find((entry) => entry.value === tabId);
            if (tab) this.attachTreeSubscription(tab, store);
        });
        this.reconcileWorkspace(true);
        if (!this.storeUnavailable) {
            const pageTabsRaw = this.readSessionItem(PAGE_TABS_STORAGE_KEY);
            if (
                pageTabsRaw !== null &&
                pageTabsRaw !== undefined &&
                this.durableValues.get(PAGE_TABS_LEAF_KEY) !== pageTabsRaw
            ) {
                this.scheduleWrite(PAGE_TABS_LEAF_KEY, false);
            }
            if (this.durableWorkspaceSynced) {
                this.startEligibleRemovals(false);
            }
        }
    }

    stop(): void {
        if (!this.started) return;
        this.started = false;
        this.unsubscribeTabs?.();
        this.unsubscribeTabs = null;
        this.unsubscribePageTabs?.();
        this.unsubscribePageTabs = null;
        this.unsubscribeTabStorage?.();
        this.unsubscribeTabStorage = null;
        this.unsubscribeTreeStoreCreated?.();
        this.unsubscribeTreeStoreCreated = null;
        for (const sub of this.treeSubs.values()) sub.unsubscribe();
        this.treeSubs.clear();
        for (const timer of this.writeTimers.values()) clearTimeout(timer);
        this.writeTimers.clear();
        for (const removal of this.removals.values()) {
            if (removal.timer) clearTimeout(removal.timer);
            removal.timer = null;
        }
    }

    /**
     * True only when the store is available, `tabStorage` has no pending or failed write for the
     * tab's tree key, the durable tree leaf equals the current stored value, and the durable
     * workspace leaf lists the tab.
     */
    isConfirmed(tabId: string): boolean {
        if (this.storeUnavailable) return false;
        const tab = this.currentTabs().find((entry) => entry.value === tabId);
        if (!tab) return false;
        if (!this.durableWorkspaceTabValues.has(tab.value)) return false;
        const treeKey = getTabTreeKey(tab);
        if (tabStorage.hasPendingOrFailedWrite(treeKey)) return false;
        const currentRaw = this.readSessionItem(treeKey);
        if (currentRaw === undefined) return false;
        if (currentRaw === null) return true;
        return this.durableValues.get(treeKey) === currentRaw;
    }

    pause(): void {
        this.paused = true;
        for (const timer of this.writeTimers.values()) clearTimeout(timer);
        this.writeTimers.clear();
    }

    /**
     * Resumes after an aborted "Clear saved data". Rewrites every mirrored key so no confirmation
     * refers to a cleared store, except in store-unavailable mode which is kept unless the session
     * store was cleared completely.
     */
    resume(options?: { clearedCompletely?: boolean }): void {
        this.paused = false;
        if (this.storeUnavailable) {
            if (options?.clearedCompletely) {
                this.storeUnavailable = false;
                clearStoreUnavailableMarker(this.session);
            } else {
                return;
            }
        }
        this.durableValues.clear();
        this.durableWorkspaceTabValues.clear();
        this.durableWorkspaceTabKeys.clear();
        this.durableWorkspaceSynced = false;

        for (const tab of this.currentTabs()) {
            const treeKey = getTabTreeKey(tab);
            if (!isCanonicalUuid(treeKey)) continue;
            const raw = this.readSessionItem(treeKey);
            if (raw !== null && raw !== undefined) {
                this.enqueueWrite(treeKey);
            }
        }
        const pageTabsRaw = this.readSessionItem(PAGE_TABS_STORAGE_KEY);
        if (pageTabsRaw !== null && pageTabsRaw !== undefined) {
            this.enqueueWrite(PAGE_TABS_LEAF_KEY);
        }
        this.enqueueWrite(WORKSPACE_LEAF_KEY);
    }

    /**
     * Flushes `tabStorage`'s debounced writes, starts pending writes now (unless paused), retries
     * waiting removals, and waits bounded by `timeoutMs`.
     */
    async drain(timeoutMs = WORKSPACE_SESSION_DRAIN_TIMEOUT_MS): Promise<DrainResult> {
        const deadline = Date.now() + timeoutMs;
        let flushFailed = false;
        if (!this.paused) {
            const failed = tabStorage.flush({ notify: false });
            flushFailed = failed.length > 0;
        }
        if (!this.paused && !this.storeUnavailable) {
            this.reconcileWorkspace(true);
            const pageTabsRaw = this.readSessionItem(PAGE_TABS_STORAGE_KEY);
            if (
                pageTabsRaw !== null &&
                pageTabsRaw !== undefined &&
                this.durableValues.get(PAGE_TABS_LEAF_KEY) !== pageTabsRaw
            ) {
                this.enqueueWrite(PAGE_TABS_LEAF_KEY);
            }
            for (const [key, timer] of [...this.writeTimers]) {
                clearTimeout(timer);
                this.writeTimers.delete(key);
                this.enqueueWrite(key);
            }
            this.startEligibleRemovals(true);
        }

        for (;;) {
            const remaining = Math.max(0, deadline - Date.now());
            const chains = [...this.lanes.values()].map((lane) => lane.chain);
            const settled = Promise.all(chains).then(() => true);
            let timer: ReturnType<typeof setTimeout> | undefined;
            const timeout = new Promise<boolean>((resolve) => {
                timer = setTimeout(() => resolve(false), remaining);
            });
            const completed = await Promise.race([settled, timeout]);
            clearTimeout(timer);
            if (!completed) return { finished: false };

            if (!this.paused && !this.storeUnavailable && this.writeTimers.size > 0) {
                for (const [key, t] of [...this.writeTimers]) {
                    clearTimeout(t);
                    this.writeTimers.delete(key);
                    this.enqueueWrite(key);
                }
                continue;
            }
            const anyOutstanding = [...this.lanes.values()].some((lane) => lane.outstanding > 0);
            if (anyOutstanding) {
                if (Date.now() >= deadline) return { finished: false };
                continue;
            }
            break;
        }

        const finished =
            !flushFailed &&
            [...this.lanes.values()].every((lane) => lane.outstanding === 0) &&
            this.writeTimers.size === 0;
        return { finished };
    }

    private currentTabs(): readonly Tab[] {
        return this.deps.jotaiStore.get(tabsAtom);
    }

    /** Returns string if present, null if absent, undefined if reading threw. */
    private readSessionItem(key: string): string | null | undefined {
        try {
            return this.session.getItem(key);
        } catch {
            return undefined;
        }
    }

    private reconcileWorkspace(immediateMissing = false): void {
        const tabs = this.currentTabs();
        const currentTreeKeys = new Set<string>();
        for (const tab of tabs) {
            const treeKey = getTabTreeKey(tab);
            if (isCanonicalUuid(treeKey)) {
                currentTreeKeys.add(treeKey);
                this.knownOwnedTreeKeys.add(treeKey);
                this.cancelRemoval(treeKey);
            }
            this.ensureTreeSubscription(tab);
        }

        for (const [tabId, sub] of [...this.treeSubs]) {
            if (!tabs.some((tab) => tab.value === tabId)) {
                sub.unsubscribe();
                this.treeSubs.delete(tabId);
            }
        }

        let closedAny = false;
        for (const knownKey of [...this.knownOwnedTreeKeys]) {
            if (!currentTreeKeys.has(knownKey)) {
                this.knownOwnedTreeKeys.delete(knownKey);
                this.clearWriteTimer(knownKey);
                this.endGeneration(knownKey);
                if (!this.removals.has(knownKey)) {
                    this.removals.set(knownKey, {
                        key: knownKey,
                        timer: null,
                        attempts: 0,
                        notified: false,
                    });
                }
                closedAny = true;
            }
        }
        if (closedAny) this.notifyConfirmedChange();

        if (this.storeUnavailable) return;

        for (const tab of tabs) {
            const treeKey = getTabTreeKey(tab);
            if (!isCanonicalUuid(treeKey)) continue;
            const raw = this.readSessionItem(treeKey);
            if (raw !== null && raw !== undefined && this.durableValues.get(treeKey) !== raw) {
                const immediate = immediateMissing || !this.durableValues.has(treeKey);
                this.scheduleWrite(treeKey, immediate);
            }
        }

        const workspaceRaw = this.readSessionItem(WORKSPACE_STORAGE_KEY);
        if (
            workspaceRaw !== null &&
            workspaceRaw !== undefined &&
            (!this.durableWorkspaceSynced ||
                this.durableValues.get(WORKSPACE_LEAF_KEY) !== workspaceRaw)
        ) {
            this.scheduleWrite(WORKSPACE_LEAF_KEY, closedAny || immediateMissing);
        }
    }

    private ensureTreeSubscription(tab: Tab): void {
        const existing = this.treeSubs.get(tab.value);
        const treeKey = getTabTreeKey(tab);
        if (existing && existing.treeKey === treeKey) return;
        let store: TreeStore | null;
        try {
            store = this.treeStoreFor(tab);
        } catch {
            return;
        }
        if (store) this.attachTreeSubscription(tab, store);
    }

    private attachTreeSubscription(tab: Tab, store: TreeStore): void {
        const treeKey = getTabTreeKey(tab);
        const existing = this.treeSubs.get(tab.value);
        if (existing) {
            if (existing.treeKey === treeKey) return;
            existing.unsubscribe();
            this.treeSubs.delete(tab.value);
        }
        const sub: TreeSubscription = { treeKey, unsubscribe: () => undefined };
        sub.unsubscribe = store.subscribe((state, previous) => {
            if (!this.started || this.storeUnavailable || this.paused) return;
            if (state.dirty && !previous.dirty) {
                // Zustand persist notifies subscribers before calling storage.setItem; defer to
                // the microtask after setItem so tabStorage.flush persists the new dirty state (O2).
                queueMicrotask(() => {
                    if (!this.started || this.storeUnavailable || this.paused) return;
                    if (this.treeSubs.get(tab.value) !== sub) return;
                    if (
                        !this.currentTabs().some(
                            (entry) =>
                                entry.value === tab.value && getTabTreeKey(entry) === treeKey,
                        )
                    ) {
                        return;
                    }
                    tabStorage.flush({ notify: true });
                    if (isCanonicalUuid(treeKey)) {
                        this.scheduleWrite(treeKey, true);
                    }
                });
            }
        });
        this.treeSubs.set(tab.value, sub);
    }

    private lane(key: string): Lane {
        let lane = this.lanes.get(key);
        if (!lane) {
            lane = { generation: 0, chain: Promise.resolve(), outstanding: 0 };
            this.lanes.set(key, lane);
        }
        return lane;
    }

    private endGeneration(key: string): void {
        this.lane(key).generation += 1;
    }

    private enqueue(key: string, operation: () => Promise<void>): void {
        const lane = this.lane(key);
        lane.outstanding += 1;
        lane.chain = lane.chain.then(operation).then(
            () => {
                lane.outstanding -= 1;
            },
            (error: unknown) => {
                lane.outstanding -= 1;
                this.warn(`Workspace session operation for ${key} failed: ${String(error)}`);
            },
        );
    }

    private clearWriteTimer(key: string): void {
        const timer = this.writeTimers.get(key);
        if (timer) clearTimeout(timer);
        this.writeTimers.delete(key);
    }

    private scheduleWrite(key: string, immediate: boolean): void {
        if (!this.started || this.storeUnavailable || this.paused) return;
        this.clearWriteTimer(key);
        const delay = immediate ? 0 : WORKSPACE_SESSION_WRITE_DELAY_MS;
        const timer = setTimeout(() => {
            this.writeTimers.delete(key);
            if (!this.started) return;
            this.enqueueWrite(key);
        }, delay);
        this.writeTimers.set(key, timer);
    }

    private enqueueWrite(key: string): void {
        if (!this.started || this.storeUnavailable || this.paused) return;
        const generation = this.lane(key).generation;
        if (this.writeQueued.get(key) === generation) return;
        this.writeQueued.set(key, generation);
        this.enqueue(key, async () => {
            if (this.writeQueued.get(key) === generation) this.writeQueued.delete(key);
            if (!this.started || this.paused || this.storeUnavailable) return;
            if (this.lane(key).generation !== generation) return;

            if (key === WORKSPACE_LEAF_KEY) {
                this.cancelRemoval(key);
                await this.performWorkspaceWrite(generation);
                return;
            }
            if (key === PAGE_TABS_LEAF_KEY) {
                const raw = this.readSessionItem(PAGE_TABS_STORAGE_KEY);
                if (raw === null || raw === undefined) return;
                this.cancelRemoval(key);
                if (this.durableValues.get(PAGE_TABS_LEAF_KEY) === raw) return;
                await this.writeLeaf(PAGE_TABS_LEAF_KEY, raw, generation);
                return;
            }
            if (!isCanonicalUuid(key)) return;
            if (!this.currentTabs().some((tab) => getTabTreeKey(tab) === key)) return;
            const raw = this.readSessionItem(key);
            if (raw === null || raw === undefined) return;
            this.cancelRemoval(key);
            if (this.durableValues.get(key) === raw) return;

            const wasDurable = this.durableValues.has(key);
            const wrote = await this.writeLeaf(key, raw, generation);
            if (!wrote || !this.started) return;
            this.notifyConfirmedChange();
            if (!wasDurable) {
                // First durable tree leaf for this tab: publish it into the durable workspace now.
                this.scheduleWrite(WORKSPACE_LEAF_KEY, true);
            }
        });
    }

    private async performWorkspaceWrite(generation: number): Promise<void> {
        const raw = this.readSessionItem(WORKSPACE_STORAGE_KEY);
        if (raw === null || raw === undefined) return;
        const parsed = parseStoredWorkspaceForRestore(raw);
        if (!parsed) return;

        const eligibleTabs: Tab[] = [];
        for (const tab of parsed.tabs) {
            const treeKey = getTabTreeKey(tab);
            const storedTree = this.readSessionItem(treeKey);
            if (storedTree === null || this.durableValues.has(treeKey)) {
                eligibleTabs.push(tab);
            }
        }

        const payload =
            eligibleTabs.length === parsed.tabs.length
                ? raw
                : serializeStorageValue({
                      ...parsed,
                      tabs: eligibleTabs,
                      activeTab: resolveActiveTab(eligibleTabs, parsed.activeTab),
                  });

        if (this.durableWorkspaceSynced && this.durableValues.get(WORKSPACE_LEAF_KEY) === payload) {
            this.startEligibleRemovals(false);
            return;
        }

        const wrote = await this.writeLeaf(WORKSPACE_LEAF_KEY, payload, generation);
        if (!wrote || !this.started) return;
        this.durableWorkspaceSynced = true;
        this.durableWorkspaceTabValues.clear();
        this.durableWorkspaceTabKeys.clear();
        for (const tab of eligibleTabs) {
            this.durableWorkspaceTabValues.add(tab.value);
            this.durableWorkspaceTabKeys.add(getTabTreeKey(tab));
        }
        this.notifyConfirmedChange();
        this.startEligibleRemovals(false);
    }

    private async writeLeaf(key: string, content: string, generation: number): Promise<boolean> {
        try {
            await this.deps.native.writeLeaf(key, content);
        } catch (error) {
            if (this.started && this.lane(key).generation === generation) {
                this.handleWriteFailure(key, error);
            }
            return false;
        }
        if (this.lane(key).generation !== generation) return false;
        this.durableValues.set(key, content);
        this.notifiedWriteFailure.delete(key);
        return true;
    }

    private handleWriteFailure(key: string, error: unknown): void {
        const category = errorCategoryOf(error);
        this.warn(
            `Workspace session leaf ${key} could not be stored: ${normalizeError(error).message}`,
        );
        if (this.notifiedWriteFailure.has(key)) return;
        this.notifiedWriteFailure.add(key);
        this.deps.notify(i18n.t("WorkspaceSession.WriteFailed", { category }));
    }

    private cancelRemoval(key: string): void {
        const removal = this.removals.get(key);
        if (!removal) return;
        if (removal.timer) clearTimeout(removal.timer);
        removal.timer = null;
        this.removals.delete(key);
    }

    private startEligibleRemovals(ignoreBackoff: boolean): void {
        if (!this.started || this.storeUnavailable || this.paused) return;
        if (!this.durableWorkspaceSynced) return;
        for (const removal of this.removals.values()) {
            if (removal.key === WORKSPACE_LEAF_KEY) continue;
            if (
                removal.key !== PAGE_TABS_LEAF_KEY &&
                this.durableWorkspaceTabKeys.has(removal.key)
            ) {
                continue;
            }
            if (removal.timer) {
                if (!ignoreBackoff) continue;
                clearTimeout(removal.timer);
                removal.timer = null;
            }
            this.enqueueRemove(removal);
        }
    }

    private enqueueRemove(removal: PendingRemoval): void {
        if (!this.started) return;
        this.enqueue(removal.key, async () => {
            if (!this.started || this.removals.get(removal.key) !== removal) return;
            if (this.paused || this.storeUnavailable) return;
            if (
                removal.key !== PAGE_TABS_LEAF_KEY &&
                this.durableWorkspaceTabKeys.has(removal.key)
            ) {
                return;
            }
            try {
                await this.deps.native.removeLeaf(removal.key);
            } catch (error) {
                if (!this.started) return;
                removal.attempts += 1;
                if (!removal.notified) {
                    this.warn(
                        `Workspace session leaf ${removal.key} could not be removed: ${normalizeError(error).message}`,
                    );
                    removal.notified = true;
                }
                const delay = Math.min(
                    REMOVE_RETRY_BASE_MS * 2 ** (removal.attempts - 1),
                    REMOVE_RETRY_MAX_MS,
                );
                removal.timer = setTimeout(() => {
                    removal.timer = null;
                    if (!this.started) return;
                    this.enqueueRemove(removal);
                }, delay);
                return;
            }
            if (this.removals.get(removal.key) === removal) {
                this.removals.delete(removal.key);
                this.durableValues.delete(removal.key);
            }
        });
    }
}

let sessionMirror: WorkspaceSessionMirror | null = null;

export function getWorkspaceSessionMirror(
    deps: () => WorkspaceSessionMirrorDeps,
): WorkspaceSessionMirror {
    sessionMirror ??= new WorkspaceSessionMirror(deps());
    return sessionMirror;
}

export function resetWorkspaceSessionForTests(): void {
    sessionMirror?.stop();
    sessionMirror = null;
    pendingNotices = [];
    startupHandoff = emptyHandoff();
}
