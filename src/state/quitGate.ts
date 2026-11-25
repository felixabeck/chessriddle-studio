import { warnSafely } from "@/platform/errors";
import { createNativeListenerLifecycle } from "@/platform/listenerLifecycle";
import { getFileFreshness } from "@/state/fileFreshness";
import {
    tabStorage,
    type TabTreeReadResult,
    type TabTreeStorageStatus,
} from "@/state/store/tabStorage";
import { getCachedTreeStore } from "@/state/store/tree";
import { getTabTreeKey, type Tab } from "@/state/workspaceTypes";
import { asksBeforeDiscardingChanges, isFileBackedTab, type SaveResult } from "@/utils/tabs";

export type BlockingTab = {
    value: string;
    name: string;
    uninspectable: boolean;
};

export type QuitDialogState = {
    failClosed: boolean;
    tabs: BlockingTab[];
};

/** Why Save and quit stopped before quitting; `attention` needs the user inside the tab. */
export type QuitSaveOutcome =
    | { kind: "quit" }
    | { kind: "cancelled" }
    | {
          kind: "blocked";
          tab: BlockingTab;
          reason: "failed" | "superseded" | "attention";
          message?: string;
      };

export type CloseRequestedEvent = {
    preventDefault: () => void;
};

export type TabInspection = {
    getCachedTreeStore: typeof getCachedTreeStore;
    inspectTree: (tabId: string, requireExisting: boolean) => TabTreeReadResult;
    getStatus: (tabId: string) => ReturnType<typeof tabStorage.getStatus>;
    getFileFreshness: typeof getFileFreshness;
    warn?: (message: string) => void;
};

export type QuitGateHost = {
    getTabs: () => readonly Tab[];
    openDialog: (state: QuitDialogState) => boolean;
    destroyWindow: () => Promise<void>;
    exitProcess: (code: number) => void | Promise<void>;
    /** Runs the tab's ordinary user save for Save and quit. */
    saveTab: (tab: Tab) => Promise<SaveResult>;
    notify: (error: unknown) => void;
    log: (message: string) => Promise<void>;
    warn: (message: string) => void;
    /**
     * Durable workspace session mirror. A tab whose current content is confirmed does not block
     * quitting, whether dirty, in conflict or unavailable; unconfirmed and uninspectable tabs
     * still block.
     */
    recovery?: QuitRecovery;
};

export type QuitRecovery = {
    drain: () => Promise<{ finished: boolean }>;
    isConfirmed: (tabId: string) => boolean;
};

const defaultInspection: TabInspection = {
    getCachedTreeStore,
    inspectTree: (tabId, requireExisting) => tabStorage.inspectTree(tabId, requireExisting),
    getStatus: (tabId) => tabStorage.getStatus(tabId),
    getFileFreshness,
    warn: warnSafely,
};

let inProgress = false;
let proceeding = false;
let saving = false;
let activeHost: QuitGateHost | null = null;

export function isQuitGateInProgress(): boolean {
    return inProgress;
}

export function resetQuitGateForTests(): void {
    inProgress = false;
    proceeding = false;
    saving = false;
    activeHost = null;
}

function treeIsDirty(state: unknown): boolean {
    return (
        !!state &&
        typeof state === "object" &&
        "dirty" in state &&
        (state as { dirty: unknown }).dirty === true
    );
}

function isUninspectableStatus(
    kind: TabTreeStorageStatus["kind"] | TabTreeReadResult["kind"],
): boolean {
    return kind === "unreadable" || kind === "unavailable";
}

type TabVerdict = { tab: Tab; uninspectable: boolean; dirty: boolean };

function inspectBlockingTabs(
    tabs: readonly Tab[],
    inspection: TabInspection = defaultInspection,
    hasConfirmedCopy: (tabId: string) => boolean = () => false,
): TabVerdict[] {
    const blocking: TabVerdict[] = [];
    for (const tab of tabs) {
        if (tab.type === "new") continue;

        const treeKey = getTabTreeKey(tab);
        const requireExisting = treeKey !== tab.value;
        let dirty = false;
        let uninspectable = false;

        try {
            const cached = inspection.getCachedTreeStore(tab.value);
            if (cached) {
                dirty = cached.getState().dirty === true;
                const status = inspection.getStatus(treeKey);
                uninspectable = isUninspectableStatus(status.kind);
            } else {
                const result = inspection.inspectTree(treeKey, requireExisting);
                uninspectable = isUninspectableStatus(result.kind);
                if (result.kind === "available") dirty = treeIsDirty(result.value.state);
            }
        } catch (error) {
            uninspectable = true;
            const warn = inspection.warn ?? warnSafely;
            warn(
                `Quit gate could not inspect tab ${tab.value}: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }

        if (uninspectable) {
            blocking.push({ tab, uninspectable: true, dirty: false });
            continue;
        }

        if (!asksBeforeDiscardingChanges(tab)) continue;

        // A tab whose current content is confirmed in the durable workspace session does not block
        // quitting, whether dirty, in conflict or unavailable: its tree and baseline come back and
        // any conflict is detected again at the next start (O5, d-20261125-14).
        if (hasConfirmedCopy(tab.value)) continue;

        if (dirty) {
            blocking.push({ tab, uninspectable: false, dirty: true });
            continue;
        }

        if (isFileBackedTab(tab)) {
            const freshness = inspection.getFileFreshness(tab.value);
            if (freshness.state === "conflict" || freshness.state === "unavailable") {
                blocking.push({ tab, uninspectable: false, dirty: false });
            }
        }
    }
    return blocking;
}

function toBlockingTab({ tab, uninspectable }: TabVerdict): BlockingTab {
    return { value: tab.value, name: tab.name, uninspectable };
}

/** Dirty, conflicting or uninspectable tabs. File-write guards depend on this exact meaning. */
export function scanBlockingTabs(
    tabs: readonly Tab[],
    inspection: TabInspection = defaultInspection,
): BlockingTab[] {
    return inspectBlockingTabs(tabs, inspection).map(toBlockingTab);
}

/**
 * The quit decision: like `scanBlockingTabs`, minus inspectable tabs whose current content is
 * confirmed in the durable workspace session (including dirty, conflict, or unavailable tabs).
 */
export function scanQuitBlockingTabs(
    tabs: readonly Tab[],
    recovery: QuitRecovery | undefined,
    inspection: TabInspection = defaultInspection,
): BlockingTab[] {
    return inspectBlockingTabs(tabs, inspection, (tabId) =>
        recovery ? recovery.isConfirmed(tabId) : false,
    ).map(toBlockingTab);
}

function releaseLatch(): void {
    inProgress = false;
    proceeding = false;
    activeHost = null;
}

async function proceedQuit(host: QuitGateHost): Promise<void> {
    proceeding = true;
    activeHost = null;
    try {
        await host.destroyWindow();
        releaseLatch();
    } catch (error) {
        try {
            host.notify(error);
        } catch {
            // Notify is best-effort; the log and exit(0) fallback must still run.
        }
        try {
            await host.log(
                `Window destroy failed; falling back to process exit: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        } catch {
            // The log helper is already best-effort; quitting must still proceed.
        }
        try {
            await host.exitProcess(0);
        } finally {
            releaseLatch();
        }
    }
}

function openFailClosed(host: QuitGateHost, error: unknown): void {
    host.warn(
        `Quit gate could not finish its scan: ${
            error instanceof Error ? error.message : String(error)
        }`,
    );
    if (!host.openDialog({ failClosed: true, tabs: [] })) {
        host.warn("Quit confirmation dialog could not be opened; the quit gate is released.");
        releaseLatch();
    }
}

export async function runQuitGate(host: QuitGateHost): Promise<void> {
    if (inProgress) return;
    inProgress = true;
    activeHost = host;
    try {
        const drained = await host.recovery?.drain();
        if (drained && !drained.finished) {
            host.warn("Quit gate: recovery copies were still being updated when it scanned.");
        }
        const tabs = host.getTabs();
        const blocking = scanQuitBlockingTabs(tabs, host.recovery);
        if (blocking.length === 0) {
            await proceedQuit(host);
            return;
        }
        if (!host.openDialog({ failClosed: false, tabs: blocking })) {
            host.warn("Quit confirmation dialog could not be opened; the quit gate is released.");
            releaseLatch();
        }
    } catch (error) {
        openFailClosed(host, error);
    }
}

export function cancelQuitGate(): void {
    if (!inProgress || proceeding || saving) return;
    releaseLatch();
}

export async function quitWithoutSaving(): Promise<void> {
    const host = activeHost;
    if (!host || saving) return;
    await proceedQuit(host);
}

/**
 * Saves every dirty tab through its ordinary user save, one at a time, and quits only when no
 * tab blocks afterwards. The first save that does not complete stops the run: tabs saved before
 * it stay saved and the dialog stays open on the refreshed list.
 */
export async function saveAndQuit(): Promise<QuitSaveOutcome> {
    const host = activeHost;
    if (!host || proceeding || saving) return { kind: "cancelled" };
    saving = true;
    try {
        // Each tab is attempted once, re-read from the live workspace because an earlier save
        // can rebind it; the attempted set bounds the loop by the number of tabs.
        const attempted = new Set<string>();
        for (;;) {
            const next = inspectBlockingTabs(host.getTabs()).find(
                (verdict) => verdict.dirty && !attempted.has(verdict.tab.value),
            );
            if (!next) break;
            attempted.add(next.tab.value);
            const result = await host.saveTab(next.tab);
            if (result === "saved") continue;
            if (result === "cancelled") return { kind: "cancelled" };
            const tab = toBlockingTab(next);
            if (result === "conflict") return { kind: "blocked", tab, reason: "attention" };
            if (result === "superseded") return { kind: "blocked", tab, reason: "superseded" };
            return { kind: "blocked", tab, reason: "failed", message: result.error.message };
        }
        // Let the removes of the games just saved finish. An incomplete drain still quits: the
        // user saved, and a leftover copy only reappears as an unsaved duplicate.
        try {
            const drained = await host.recovery?.drain();
            if (drained && !drained.finished) {
                host.warn("Save and quit: recovery copies were still being updated at quit.");
            }
        } catch (error) {
            host.warn(
                `Save and quit could not settle recovery copies: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
        const remaining = scanQuitBlockingTabs(host.getTabs(), host.recovery);
        const first = remaining[0];
        if (!first) {
            saving = false;
            await proceedQuit(host);
            return { kind: "quit" };
        }
        return { kind: "blocked", tab: first, reason: "attention" };
    } catch (error) {
        host.warn(
            `Save and quit stopped: ${error instanceof Error ? error.message : String(error)}`,
        );
        throw error;
    } finally {
        saving = false;
        if (inProgress && !proceeding && activeHost === host) {
            // Saved tabs no longer block; show what is still open.
            try {
                host.openDialog({
                    failClosed: false,
                    tabs: scanQuitBlockingTabs(host.getTabs(), host.recovery),
                });
            } catch (error) {
                // The existing dialog stays as it was.
                host.warn(
                    `Quit dialog could not be refreshed after Save and quit: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                );
            }
        }
    }
}

export function createCloseRequestedHandler(
    runGate: () => void | Promise<void>,
): (event: CloseRequestedEvent) => Promise<void> {
    return async (event) => {
        event.preventDefault();
        try {
            await runGate();
        } catch {
            // preventDefault already kept the window; the gate owns fail-closed handling.
        }
    };
}

export function registerQuitCloseListener(options: {
    subscribe: (
        handler: (event: CloseRequestedEvent) => void | Promise<void>,
    ) => Promise<() => void> | (() => void);
    onCloseRequested: () => void | Promise<void>;
    notify: (error: unknown) => void;
    warn: (message: string) => void;
    failureMessage: string;
}): () => void {
    const handler = createCloseRequestedHandler(options.onCloseRequested);
    const lifecycle = createNativeListenerLifecycle({
        onFailure: (error) => {
            options.warn(
                `${options.failureMessage} (${error instanceof Error ? error.message : String(error)})`,
            );
            options.notify(new Error(options.failureMessage));
        },
    });
    lifecycle.attach(() => options.subscribe(handler));
    return () => lifecycle.stop();
}
