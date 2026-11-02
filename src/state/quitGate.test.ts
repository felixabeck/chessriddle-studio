import { afterEach, beforeEach, expect, test, vi } from "vitest";
import capabilityText from "../../src-tauri/capabilities/main.json?raw";
import { getFileFreshness, removeFileFreshness, setFileFreshness } from "@/state/fileFreshness";
import { tabStorage, TREE_STORAGE_VERSION } from "@/state/store/tabStorage";
import { closeTreeStore, createTreeStore, getCachedTreeStore } from "@/state/store/tree";
import type { Tab } from "@/state/workspaceTypes";
import { defaultTree } from "@/utils/treeReducer";
import { serializeStorageValue } from "@/state/store/debouncedStorage";
import {
    cancelQuitGate,
    createCloseRequestedHandler,
    isQuitGateInProgress,
    quitWithoutSaving,
    registerQuitCloseListener,
    resetQuitGateForTests,
    runQuitGate,
    scanBlockingTabs,
    type QuitGateHost,
    type TabInspection,
} from "./quitGate";

vi.mock("@/platform/native", () => ({
    warn: vi.fn().mockResolvedValue(undefined),
    error: vi.fn().mockResolvedValue(undefined),
}));

const owned = new Set<string>();

function uuid(): string {
    const id = crypto.randomUUID();
    owned.add(id);
    return id;
}

const fileMetadata = {
    type: "file" as const,
    handle: { id: { id: "games" }, kind: "fileWorkspace" as const },
    name: "games.pgn",
    numGames: 1,
    metadata: { type: "game" as const, tags: [] },
    lastModified: 1,
};

function tab(partial: Partial<Tab> & Pick<Tab, "value" | "type">): Tab {
    return {
        name: partial.name ?? partial.value,
        gameOrigin: partial.gameOrigin ?? { kind: "none" },
        ...partial,
    };
}

function fileOrigin(): Tab["gameOrigin"] {
    return { kind: "file", file: fileMetadata, gameNumber: 0 };
}

function databaseOrigin(): Tab["gameOrigin"] {
    return { kind: "database", database: { id: { id: "db" }, kind: "database" }, gameId: 1 };
}

function draftOrigin(): Tab["gameOrigin"] {
    return { kind: "databaseDraft", database: { id: { id: "db" }, kind: "database" } };
}

function seedStoredTree(id: string, dirty: boolean, legacy = false) {
    const tree = defaultTree();
    tree.dirty = dirty;
    const envelope = { version: legacy ? 0 : TREE_STORAGE_VERSION, state: tree };
    sessionStorage.setItem(id, legacy ? JSON.stringify(envelope) : serializeStorageValue(envelope));
}

function host(overrides: Partial<QuitGateHost> = {}) {
    return {
        getTabs: () => [] as readonly Tab[],
        openDialog: vi.fn(() => true),
        destroyWindow: vi.fn(async () => undefined),
        exitProcess: vi.fn((_code: number) => undefined),
        notify: vi.fn((_error: unknown) => undefined),
        log: vi.fn(async (_message: string) => undefined),
        warn: vi.fn((_message: string) => undefined),
        ...overrides,
    };
}

beforeEach(() => {
    resetQuitGateForTests();
    sessionStorage.clear();
});

afterEach(() => {
    for (const id of owned) {
        closeTreeStore(id);
        removeFileFreshness(id);
    }
    owned.clear();
    sessionStorage.clear();
    resetQuitGateForTests();
});

test("dirty file, database, draft, and origin-none analysis tabs block", () => {
    const fileId = uuid();
    const dbId = uuid();
    const draftId = uuid();
    const analysisId = uuid();
    seedStoredTree(fileId, true);
    seedStoredTree(dbId, true);
    seedStoredTree(draftId, true);
    seedStoredTree(analysisId, true);
    expect(
        scanBlockingTabs([
            tab({ value: fileId, type: "analysis", gameOrigin: fileOrigin() }),
            tab({ value: dbId, type: "analysis", gameOrigin: databaseOrigin() }),
            tab({ value: draftId, type: "analysis", gameOrigin: draftOrigin() }),
            tab({ value: analysisId, type: "analysis", gameOrigin: { kind: "none" } }),
        ]).map((item) => item.value),
    ).toEqual([fileId, dbId, draftId, analysisId]);
});

test("a dirty file-origin play tab blocks", () => {
    const id = uuid();
    seedStoredTree(id, true);
    expect(scanBlockingTabs([tab({ value: id, type: "play", gameOrigin: fileOrigin() })])).toEqual([
        { value: id, name: id, uninspectable: false },
    ]);
});

test("dirty origin-none play and puzzle tabs do not block", () => {
    const playId = uuid();
    const puzzleId = uuid();
    seedStoredTree(playId, true);
    seedStoredTree(puzzleId, true);
    expect(
        scanBlockingTabs([
            tab({ value: playId, type: "play" }),
            tab({ value: puzzleId, type: "puzzles" }),
        ]),
    ).toEqual([]);
});

test("an unreadable origin-none play tab blocks", () => {
    const id = uuid();
    sessionStorage.setItem(id, "not a tree");
    expect(scanBlockingTabs([tab({ value: id, type: "play" })])).toEqual([
        { value: id, name: id, uninspectable: true },
    ]);
});

test("clean covered tabs do not block", () => {
    const id = uuid();
    seedStoredTree(id, false);
    expect(
        scanBlockingTabs([tab({ value: id, type: "analysis", gameOrigin: fileOrigin() })]),
    ).toEqual([]);
});

test.each(["conflict", "unavailable"] as const)(
    "covered file tab in freshness %s blocks when dirty is false",
    (state) => {
        const id = uuid();
        seedStoredTree(id, false);
        setFileFreshness(id, state);
        expect(
            scanBlockingTabs([tab({ value: id, type: "analysis", gameOrigin: fileOrigin() })]),
        ).toEqual([{ value: id, name: id, uninspectable: false }]);
    },
);

test("cached unreadable storage blocks even when the store is clean", () => {
    const id = uuid();
    sessionStorage.setItem(id, "not a tree");
    const store = createTreeStore(id);
    expect(store.getState().dirty).toBe(false);
    expect(tabStorage.getStatus(id).kind).toBe("unreadable");
    expect(scanBlockingTabs([tab({ value: id, type: "analysis" })])).toEqual([
        { value: id, name: id, uninspectable: true },
    ]);
});

test("cached unavailable storage blocks even when the store is clean", () => {
    const id = uuid();
    const store = createTreeStore(id);
    expect(store.getState().dirty).toBe(false);
    const inspection: TabInspection = {
        getCachedTreeStore,
        inspectTree: (tabId, requireExisting) => tabStorage.inspectTree(tabId, requireExisting),
        getStatus: () => ({ kind: "unavailable", error: new Error("refused") }),
        getFileFreshness,
    };
    expect(scanBlockingTabs([tab({ value: id, type: "analysis" })], inspection)).toEqual([
        { value: id, name: id, uninspectable: true },
    ]);
});

test.each(["unreadable", "unavailable"] as const)("uncached %s storage blocks", (kind) => {
    const id = uuid();
    if (kind === "unreadable") sessionStorage.setItem(id, "not a tree");
    const inspection: TabInspection = {
        getCachedTreeStore,
        inspectTree: () =>
            kind === "unreadable"
                ? { kind: "unreadable", rawValue: "not a tree" }
                : { kind: "unavailable", error: new Error("refused") },
        getStatus: (tabId) => tabStorage.getStatus(tabId),
        getFileFreshness,
    };
    expect(scanBlockingTabs([tab({ value: id, type: "puzzles" })], inspection)).toEqual([
        { value: id, name: id, uninspectable: true },
    ]);
    expect(getCachedTreeStore(id)).toBeUndefined();
});

test("a never-mounted retargeted tab with a missing tree key is unavailable", () => {
    const value = uuid();
    const treeKey = uuid();
    const found = scanBlockingTabs([
        tab({ value, treeKey, type: "analysis", gameOrigin: fileOrigin() }),
    ]);
    expect(found).toEqual([{ value, name: value, uninspectable: true }]);
    expect(tabStorage.getStatus(treeKey).kind).toBe("not-read");
    expect(getCachedTreeStore(value)).toBeUndefined();
});

test("an inspection that throws blocks the tab as uninspectable", () => {
    const id = uuid();
    const inspection: TabInspection = {
        getCachedTreeStore: () => {
            throw new Error("inspect failed");
        },
        inspectTree: () => {
            throw new Error("inspect failed");
        },
        getStatus: () => ({ kind: "not-read" }),
        getFileFreshness,
    };
    expect(scanBlockingTabs([tab({ value: id, type: "play" })], inspection)).toEqual([
        { value: id, name: id, uninspectable: true },
    ]);
});

test("a per-tab inspection throw logs that tab's id", () => {
    const id = uuid();
    const warn = vi.fn();
    const inspection: TabInspection = {
        getCachedTreeStore: () => {
            throw new Error("inspect failed");
        },
        inspectTree: () => {
            throw new Error("inspect failed");
        },
        getStatus: () => ({ kind: "not-read" }),
        getFileFreshness,
        warn,
    };
    expect(scanBlockingTabs([tab({ value: id, type: "play" })], inspection)).toEqual([
        { value: id, name: id, uninspectable: true },
    ]);
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]![0])).toBe(
        `Quit gate could not inspect tab ${id}: inspect failed`,
    );
});

test("new tabs never block", () => {
    const id = uuid();
    seedStoredTree(id, true);
    sessionStorage.setItem(id, "not a tree");
    setFileFreshness(id, "conflict");
    expect(scanBlockingTabs([tab({ value: id, type: "new", gameOrigin: fileOrigin() })])).toEqual(
        [],
    );
});

test("scan is read-only: cached store, bytes, status, and freshness stay put", () => {
    const cachedId = uuid();
    const legacyId = uuid();
    const unreadId = uuid();
    const ownerId = uuid();
    const treeKey = uuid();
    const store = createTreeStore(cachedId);
    store.setState({ dirty: true });
    const cachedObject = getCachedTreeStore(cachedId);
    seedStoredTree(legacyId, true, true);
    const legacyBytes = sessionStorage.getItem(legacyId);
    seedStoredTree(unreadId, true);
    expect(tabStorage.getStatus(unreadId).kind).toBe("not-read");
    seedStoredTree(treeKey, false);
    setFileFreshness(ownerId, "conflict");
    const freshness = getFileFreshness(ownerId);
    const unreadStatus = tabStorage.getStatus(unreadId);
    const cachedStatus = tabStorage.getStatus(cachedId);

    const found = scanBlockingTabs([
        tab({ value: cachedId, type: "analysis", gameOrigin: fileOrigin() }),
        tab({ value: legacyId, type: "analysis", gameOrigin: fileOrigin() }),
        tab({ value: unreadId, type: "analysis", gameOrigin: fileOrigin() }),
        tab({
            value: ownerId,
            treeKey,
            type: "analysis",
            gameOrigin: fileOrigin(),
        }),
    ]);

    expect(found.map((item) => item.value).sort()).toEqual(
        [cachedId, legacyId, unreadId, ownerId].sort(),
    );
    expect(getCachedTreeStore(cachedId)).toBe(cachedObject);
    expect(sessionStorage.getItem(legacyId)).toBe(legacyBytes);
    expect(tabStorage.getStatus(unreadId)).toEqual(unreadStatus);
    expect(tabStorage.getStatus(cachedId)).toEqual(cachedStatus);
    expect(getFileFreshness(ownerId)).toEqual(freshness);
    expect(getCachedTreeStore(ownerId)).toBeUndefined();
});

test("clean tabs destroy once with no dialog", async () => {
    const gate = host({ getTabs: () => [tab({ value: uuid(), type: "new" })] });
    await runQuitGate(gate);
    expect(gate.destroyWindow).toHaveBeenCalledOnce();
    expect(gate.openDialog).not.toHaveBeenCalled();
    expect(gate.exitProcess).not.toHaveBeenCalled();
    expect(isQuitGateInProgress()).toBe(false);
});

test("Quit without saving destroys exactly once while destroy is pending", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
        release = resolve;
    });
    const id = uuid();
    seedStoredTree(id, true);
    const gate = host({
        getTabs: () => [tab({ value: id, type: "analysis" })],
        destroyWindow: vi.fn(() => pending),
    });
    await runQuitGate(gate);
    expect(isQuitGateInProgress()).toBe(true);
    const first = quitWithoutSaving();
    const second = quitWithoutSaving();
    expect(gate.destroyWindow).toHaveBeenCalledOnce();
    expect(isQuitGateInProgress()).toBe(true);
    release();
    await Promise.all([first, second]);
    expect(gate.destroyWindow).toHaveBeenCalledOnce();
    expect(isQuitGateInProgress()).toBe(false);
});

test("blocking tabs request a dialog and do not destroy", async () => {
    const id = uuid();
    seedStoredTree(id, true);
    const gate = host({
        getTabs: () => [tab({ value: id, type: "analysis" })],
    });
    await runQuitGate(gate);
    expect(gate.destroyWindow).not.toHaveBeenCalled();
    expect(gate.openDialog).toHaveBeenCalledExactlyOnceWith({
        failClosed: false,
        tabs: [{ value: id, name: id, uninspectable: false }],
    });
    expect(isQuitGateInProgress()).toBe(true);
    cancelQuitGate();
    expect(isQuitGateInProgress()).toBe(false);
});

test("an outer scan throw logs without another tab's id", async () => {
    const otherId = uuid();
    const warn = vi.fn((_message: string) => undefined);
    const gate = host({
        getTabs: () => {
            throw new Error("scan exploded");
        },
        warn,
    });
    await runQuitGate(gate);
    expect(gate.openDialog).toHaveBeenCalledExactlyOnceWith({ failClosed: true, tabs: [] });
    const messages = warn.mock.calls.map((call) => String(call[0]));
    expect(messages.some((message) => message.includes("scan exploded"))).toBe(true);
    expect(messages.join("\n")).not.toContain(otherId);
});

test("a scan throw opens a fail-closed dialog, holds the latch, and ignores File → Exit", async () => {
    const gate = host({
        getTabs: () => {
            throw new Error("scan exploded");
        },
    });
    await runQuitGate(gate);
    expect(gate.destroyWindow).not.toHaveBeenCalled();
    expect(gate.openDialog).toHaveBeenCalledExactlyOnceWith({ failClosed: true, tabs: [] });
    expect(gate.warn).toHaveBeenCalled();
    expect(isQuitGateInProgress()).toBe(true);
    await runQuitGate(gate);
    expect(gate.openDialog).toHaveBeenCalledOnce();
    expect(gate.destroyWindow).not.toHaveBeenCalled();
    expect(gate.exitProcess).not.toHaveBeenCalled();
    cancelQuitGate();
    expect(isQuitGateInProgress()).toBe(false);
});

test("a non-scan exception opens a fail-closed dialog and holds the latch", async () => {
    const gate = host({
        getTabs: () => {
            throw new Error("tabs exploded");
        },
    });
    await runQuitGate(gate);
    expect(gate.openDialog).toHaveBeenCalledExactlyOnceWith({ failClosed: true, tabs: [] });
    expect(gate.destroyWindow).not.toHaveBeenCalled();
    expect(isQuitGateInProgress()).toBe(true);
    await quitWithoutSaving();
    expect(gate.destroyWindow).toHaveBeenCalledOnce();
    expect(isQuitGateInProgress()).toBe(false);
});

test("a fail-closed dialog that cannot open logs and releases the latch", async () => {
    const gate = host({
        getTabs: () => {
            throw new Error("tabs exploded");
        },
        openDialog: vi.fn(() => false),
    });
    await runQuitGate(gate);
    expect(gate.warn).toHaveBeenCalled();
    expect(isQuitGateInProgress()).toBe(false);
    const retry = host({ getTabs: () => [tab({ value: uuid(), type: "new" })] });
    await runQuitGate(retry);
    expect(retry.destroyWindow).toHaveBeenCalledOnce();
});

test("destroy rejection notifies, awaits the log, then exits", async () => {
    const order: string[] = [];
    const gate = host({
        getTabs: () => [tab({ value: uuid(), type: "new" })],
        destroyWindow: vi.fn(async () => {
            throw new Error("destroy refused");
        }),
        log: vi.fn(async () => {
            await Promise.resolve();
            order.push("log");
        }),
        exitProcess: vi.fn(() => {
            order.push("exit");
        }),
    });
    await runQuitGate(gate);
    expect(gate.notify).toHaveBeenCalledOnce();
    expect(gate.log).toHaveBeenCalledOnce();
    expect(gate.exitProcess).toHaveBeenCalledExactlyOnceWith(0);
    expect(order).toEqual(["log", "exit"]);
    expect(isQuitGateInProgress()).toBe(false);
});

test("notify throwing on destroy rejection still logs and exits", async () => {
    const gate = host({
        getTabs: () => [tab({ value: uuid(), type: "new" })],
        destroyWindow: vi.fn(async () => {
            throw new Error("destroy refused");
        }),
        notify: vi.fn(() => {
            throw new Error("notify refused");
        }),
    });
    await runQuitGate(gate);
    expect(gate.notify).toHaveBeenCalledOnce();
    expect(gate.log).toHaveBeenCalledOnce();
    expect(gate.exitProcess).toHaveBeenCalledExactlyOnceWith(0);
    expect(isQuitGateInProgress()).toBe(false);
});

test("cancel while destroy is pending is a no-op; later rejection still exits once", async () => {
    let rejectDestroy!: (error: Error) => void;
    const pending = new Promise<void>((_, reject) => {
        rejectDestroy = reject;
    });
    const id = uuid();
    seedStoredTree(id, true);
    const gate = host({
        getTabs: () => [tab({ value: id, type: "analysis" })],
        destroyWindow: vi.fn(() => pending),
    });
    await runQuitGate(gate);
    expect(gate.openDialog).toHaveBeenCalledOnce();
    const quitting = quitWithoutSaving();
    expect(isQuitGateInProgress()).toBe(true);
    cancelQuitGate();
    expect(isQuitGateInProgress()).toBe(true);
    await runQuitGate(gate);
    expect(gate.openDialog).toHaveBeenCalledOnce();
    expect(gate.destroyWindow).toHaveBeenCalledOnce();
    rejectDestroy(new Error("destroy refused"));
    await quitting;
    expect(gate.exitProcess).toHaveBeenCalledExactlyOnceWith(0);
    expect(isQuitGateInProgress()).toBe(false);
});

test("a second entry while running or open is a total no-op", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
        release = resolve;
    });
    const gate = host({
        getTabs: () => [tab({ value: uuid(), type: "new" })],
        destroyWindow: vi.fn(() => pending),
    });
    const first = runQuitGate(gate);
    await Promise.resolve();
    expect(isQuitGateInProgress()).toBe(true);
    await runQuitGate(gate);
    expect(gate.openDialog).not.toHaveBeenCalled();
    expect(gate.destroyWindow).toHaveBeenCalledOnce();
    release();
    await first;
    expect(gate.destroyWindow).toHaveBeenCalledOnce();
    expect(gate.exitProcess).not.toHaveBeenCalled();

    const id = uuid();
    seedStoredTree(id, true);
    const dialog = host({
        getTabs: () => [tab({ value: id, type: "analysis" })],
    });
    await runQuitGate(dialog);
    expect(dialog.openDialog).toHaveBeenCalledOnce();
    await runQuitGate(dialog);
    expect(dialog.openDialog).toHaveBeenCalledOnce();
    expect(dialog.destroyWindow).not.toHaveBeenCalled();
    expect(dialog.exitProcess).not.toHaveBeenCalled();
});

test("the close-request handler calls preventDefault before its first await", async () => {
    const order: string[] = [];
    const runGate = vi.fn(async () => {
        order.push("gate");
        await Promise.resolve();
    });
    const handler = createCloseRequestedHandler(runGate);
    await handler({
        preventDefault: () => {
            order.push("prevent");
        },
    });
    expect(order).toEqual(["prevent", "gate"]);
});

test("every close-request delivery prevents default, including while open, on scan throw, and on gate exception", async () => {
    const prevent = vi.fn();
    const handler = createCloseRequestedHandler(() =>
        runQuitGate(
            host({
                getTabs: () => {
                    throw new Error("scan exploded");
                },
            }),
        ),
    );
    await handler({ preventDefault: prevent });
    expect(prevent).toHaveBeenCalledOnce();
    expect(isQuitGateInProgress()).toBe(true);
    await handler({ preventDefault: prevent });
    expect(prevent).toHaveBeenCalledTimes(2);

    resetQuitGateForTests();
    const throwing = createCloseRequestedHandler(async () => {
        throw new Error("gate exploded");
    });
    await throwing({ preventDefault: prevent });
    expect(prevent).toHaveBeenCalledTimes(3);
});

test("registers exactly one listener, unlistens on unmount, and unlistens if unmounted before settle", async () => {
    const unlisten = vi.fn();
    let resolve!: (value: () => void) => void;
    const pending = new Promise<() => void>((done) => {
        resolve = done;
    });
    const subscribe = vi.fn(() => pending);
    const stop = registerQuitCloseListener({
        subscribe,
        onCloseRequested: () => undefined,
        notify: vi.fn(),
        warn: vi.fn(),
        failureMessage: "listener failed",
    });
    expect(subscribe).toHaveBeenCalledOnce();
    stop();
    resolve(unlisten);
    await pending;
    await Promise.resolve();
    expect(unlisten).toHaveBeenCalledOnce();

    const settled = vi.fn();
    const stopSettled = registerQuitCloseListener({
        subscribe: async () => settled,
        onCloseRequested: () => undefined,
        notify: vi.fn(),
        warn: vi.fn(),
        failureMessage: "listener failed",
    });
    await Promise.resolve();
    stopSettled();
    expect(settled).toHaveBeenCalledOnce();
});

test("listener registration failure notifies once with the specific message", async () => {
    const notify = vi.fn();
    const warn = vi.fn();
    registerQuitCloseListener({
        subscribe: async () => {
            throw new Error("native refused");
        },
        onCloseRequested: () => undefined,
        notify,
        warn,
        failureMessage: "Closing the window will not ask",
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(notify).toHaveBeenCalledExactlyOnceWith(expect.any(Error));
    expect((notify.mock.calls[0]![0] as Error).message).toBe("Closing the window will not ask");
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]![0])).toContain("Closing the window will not ask");
});

test("main capability grants window destroy", () => {
    const capability = JSON.parse(capabilityText) as { permissions: string[] };
    expect(capability.permissions).toContain("core:window:allow-destroy");
});
