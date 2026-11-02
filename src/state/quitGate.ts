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
import { asksBeforeDiscardingChanges, isFileBackedTab } from "@/utils/tabs";

export type BlockingTab = {
    value: string;
    name: string;
    uninspectable: boolean;
};

export type QuitDialogState = {
    failClosed: boolean;
    tabs: BlockingTab[];
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
    notify: (error: unknown) => void;
    log: (message: string) => Promise<void>;
    warn: (message: string) => void;
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
let activeHost: QuitGateHost | null = null;

export function isQuitGateInProgress(): boolean {
    return inProgress;
}

export function resetQuitGateForTests(): void {
    inProgress = false;
    proceeding = false;
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

export function scanBlockingTabs(
    tabs: readonly Tab[],
    inspection: TabInspection = defaultInspection,
): BlockingTab[] {
    const blocking: BlockingTab[] = [];
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
            blocking.push({ value: tab.value, name: tab.name, uninspectable: true });
            continue;
        }

        if (!asksBeforeDiscardingChanges(tab)) continue;

        if (dirty) {
            blocking.push({ value: tab.value, name: tab.name, uninspectable: false });
            continue;
        }

        if (isFileBackedTab(tab)) {
            const freshness = inspection.getFileFreshness(tab.value);
            if (freshness.state === "conflict" || freshness.state === "unavailable") {
                blocking.push({ value: tab.value, name: tab.name, uninspectable: false });
            }
        }
    }
    return blocking;
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
        const tabs = host.getTabs();
        const blocking = scanBlockingTabs(tabs);
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
    if (!inProgress || proceeding) return;
    releaseLatch();
}

export async function quitWithoutSaving(): Promise<void> {
    const host = activeHost;
    if (!host) return;
    await proceedQuit(host);
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
    lifecycle.listen(() => options.subscribe(handler));
    return () => lifecycle.stop();
}
