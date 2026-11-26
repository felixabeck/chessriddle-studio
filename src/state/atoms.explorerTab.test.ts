import { createStore } from "jotai";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { DatabaseHandle } from "@/bindings";
import { serializeStorageValue } from "./store/debouncedStorage";
import { readStoredWorkspaceValue, WORKSPACE_STORAGE_KEY } from "./workspace";
import type { Tab } from "./workspaceTypes";

const persistError = vi.hoisted(() => ({ reportPersistError: vi.fn() }));
vi.mock("./persistError", () => persistError);

const dbHandle = (id: string): DatabaseHandle => ({ kind: "database", id: { id } });

function seedWorkspace(tabs: Tab[], activeTab: string | null = tabs[0]?.value ?? null) {
    sessionStorage.setItem(
        WORKSPACE_STORAGE_KEY,
        serializeStorageValue({ version: 1, tabs, activeTab }),
    );
}

beforeEach(() => {
    sessionStorage.clear();
    persistError.reportPersistError.mockClear();
});

afterEach(() => {
    vi.restoreAllMocks();
});

test("tab explorer atoms read from the stored tab record before first write and write through canonically", async () => {
    const tabId = crypto.randomUUID();
    const pinnedDb = dbHandle("pinned-db");
    const onlineDb = dbHandle("online-db");
    seedWorkspace([
        {
            name: "Board",
            value: tabId,
            type: "analysis",
            gameOrigin: { kind: "none" },
            explorer: {
                firstSource: "lch_all",
                pinned: pinnedDb,
                comparison: { database: onlineDb, player: 9 },
                further: ["reference", "lch_master"],
                options: {
                    player: 42,
                    player_database: "pinned-db",
                    color: "black",
                    result: "draw",
                    exclude_fast_events: true,
                },
            },
        },
    ]);

    vi.resetModules();
    const atoms = await import("./atoms");
    const store = createStore();

    expect(store.get(atoms.dbTypeFamily(tabId))).toBe("lch_all");
    expect(store.get(atoms.pinnedExplorerDatabaseFamily(tabId))).toEqual(pinnedDb);
    expect(store.get(atoms.pinnedExplorerComparisonFamily(tabId))).toEqual({
        database: onlineDb,
        player: 9,
    });
    expect(store.get(atoms.pinnedExplorerFurtherColumnsFamily(tabId))).toEqual([
        "reference",
        "lch_master",
    ]);
    expect(store.get(atoms.localOptionsFamily(tabId))).toEqual({
        path: null,
        type: "exact",
        fen: "",
        player: 42,
        player_database: "pinned-db",
        color: "black",
        result: "draw",
        exclude_fast_events: true,
    });

    // Unchecking exclude_fast_events removes only that field while keeping the rest.
    store.set(atoms.localOptionsFamily(tabId), (prev) => ({
        ...prev,
        exclude_fast_events: false,
    }));
    const afterUncheck = store.get(atoms.tabsAtom)[0]!;
    expect(afterUncheck.explorer?.options).toEqual({
        player: 42,
        player_database: "pinned-db",
        color: "black",
        result: "draw",
    });
    expect("exclude_fast_events" in (afterUncheck.explorer?.options ?? {})).toBe(false);

    // Clearing individual members removes only those members; clearing the last removes `explorer`.
    store.set(atoms.pinnedExplorerComparisonFamily(tabId), null);
    expect(store.get(atoms.tabsAtom)[0]!.explorer?.comparison).toBeUndefined();
    expect(store.get(atoms.tabsAtom)[0]!.explorer?.pinned).toEqual(pinnedDb);

    store.set(atoms.pinnedExplorerFurtherColumnsFamily(tabId), []);
    store.set(atoms.dbTypeFamily(tabId), "local");
    store.set(atoms.pinnedExplorerDatabaseFamily(tabId), null);
    store.set(atoms.localOptionsFamily(tabId), (prev) => ({
        ...prev,
        player: null,
        player_database: undefined,
        color: "white",
        result: "any",
    }));
    expect(store.get(atoms.tabsAtom)[0]!.explorer).toBeUndefined();
    expect("explorer" in store.get(atoms.tabsAtom)[0]!).toBe(false);
});

test("fen, path, type, and default-only writes perform no workspace write", async () => {
    const tabId = crypto.randomUUID();
    seedWorkspace([
        {
            name: "Board",
            value: tabId,
            type: "analysis",
            gameOrigin: { kind: "none" },
        },
    ]);

    vi.resetModules();
    const atoms = await import("./atoms");
    const store = createStore();
    store.get(atoms.tabsAtom);

    const setItem = vi.spyOn(Storage.prototype, "setItem");
    store.set(atoms.localOptionsFamily(tabId), (prev) => ({
        ...prev,
        fen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
    }));
    store.set(atoms.localOptionsFamily(tabId), (prev) => ({
        ...prev,
        path: dbHandle("any-db"),
    }));
    store.set(atoms.localOptionsFamily(tabId), (prev) => ({
        ...prev,
        type: "partial",
    }));
    store.set(atoms.localOptionsFamily(tabId), (prev) => ({
        ...prev,
        elo: [0, 3000],
        exclude_fast_events: false,
    }));
    store.set(atoms.dbTypeFamily(tabId), "local");
    store.set(atoms.pinnedExplorerDatabaseFamily(tabId), null);
    store.set(atoms.pinnedExplorerComparisonFamily(tabId), null);
    store.set(atoms.pinnedExplorerFurtherColumnsFamily(tabId), []);

    expect(setItem).not.toHaveBeenCalled();
    expect(store.get(atoms.localOptionsFamily(tabId))).toMatchObject({
        type: "partial",
        path: dbHandle("any-db"),
    });
});

test("a prepared tab with non-default explorer state writes no workspace on fen/path/type edits or equal re-writes", async () => {
    const tabId = crypto.randomUUID();
    const pinnedDb = dbHandle("prep-db");
    const onlineDb = dbHandle("online-db");
    seedWorkspace([
        {
            name: "Prep",
            value: tabId,
            type: "analysis",
            gameOrigin: { kind: "none" },
            explorer: {
                pinned: pinnedDb,
                comparison: { database: onlineDb, player: 17 },
                further: ["reference", "lch_all"],
                options: {
                    player: 42,
                    player_database: "prep-db",
                    color: "black",
                    result: "any",
                },
            },
        },
    ]);

    vi.resetModules();
    const atoms = await import("./atoms");
    const store = createStore();
    store.get(atoms.tabsAtom);
    const beforeRaw = sessionStorage.getItem(WORKSPACE_STORAGE_KEY);

    const setItem = vi.spyOn(Storage.prototype, "setItem");
    store.set(atoms.localOptionsFamily(tabId), (prev) => ({
        ...prev,
        fen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
    }));
    store.set(atoms.localOptionsFamily(tabId), (prev) => ({
        ...prev,
        path: dbHandle("prep-db"),
    }));
    store.set(atoms.localOptionsFamily(tabId), (prev) => ({
        ...prev,
        type: "partial",
    }));
    store.set(atoms.pinnedExplorerFurtherColumnsFamily(tabId), ["reference", "lch_all"]);
    store.set(atoms.pinnedExplorerDatabaseFamily(tabId), dbHandle("prep-db"));
    store.set(atoms.pinnedExplorerComparisonFamily(tabId), {
        database: dbHandle("online-db"),
        player: 17,
    });

    expect(setItem).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(WORKSPACE_STORAGE_KEY)).toBe(beforeRaw);
});

test("ephemeral or unknown tab ids work in memory without writing to workspace", async () => {
    const tabId = crypto.randomUUID();
    seedWorkspace([
        {
            name: "Board",
            value: tabId,
            type: "analysis",
            gameOrigin: { kind: "none" },
        },
    ]);

    vi.resetModules();
    const atoms = await import("./atoms");
    const store = createStore();
    store.get(atoms.tabsAtom);

    const ephemeralId = `ephemeral:${crypto.randomUUID()}`;
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    store.set(atoms.dbTypeFamily(ephemeralId), "lch_master");
    store.set(atoms.pinnedExplorerDatabaseFamily(ephemeralId), dbHandle("ephemeral-db"));
    expect(setItem).not.toHaveBeenCalled();
    expect(store.get(atoms.dbTypeFamily(ephemeralId))).toBe("lch_master");
    expect(store.get(atoms.pinnedExplorerDatabaseFamily(ephemeralId))).toEqual(
        dbHandle("ephemeral-db"),
    );
});

test("a failed workspace commit keeps the in-memory explorer value and reports the persist error", async () => {
    const tabId = crypto.randomUUID();
    seedWorkspace([
        {
            name: "Board",
            value: tabId,
            type: "analysis",
            gameOrigin: { kind: "none" },
        },
    ]);

    vi.resetModules();
    const atoms = await import("./atoms");
    const store = createStore();
    store.get(atoms.tabsAtom);

    const originalSetItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
        if (key === WORKSPACE_STORAGE_KEY) {
            throw new DOMException("quota", "QuotaExceededError");
        }
        return originalSetItem.call(this, key, value);
    });

    store.set(atoms.dbTypeFamily(tabId), "lch_all");
    expect(store.get(atoms.dbTypeFamily(tabId))).toBe("lch_all");
    expect(persistError.reportPersistError).toHaveBeenCalledOnce();
    expect(store.get(atoms.tabsAtom)[0]!.explorer).toBeUndefined();
});

test("cold module reload over the same sessionStorage restores all persisted tab explorer choices", async () => {
    const tabId = crypto.randomUUID();
    const pinnedDb = dbHandle("prep-db");
    const onlineDb = dbHandle("online-db");
    seedWorkspace([
        {
            name: "Prep",
            value: tabId,
            type: "analysis",
            gameOrigin: { kind: "none" },
        },
    ]);

    vi.resetModules();
    const first = await import("./atoms");
    const store1 = createStore();
    store1.set(first.pinnedExplorerDatabaseFamily(tabId), pinnedDb);
    store1.set(first.pinnedExplorerComparisonFamily(tabId), {
        database: onlineDb,
        player: 17,
    });
    store1.set(first.pinnedExplorerFurtherColumnsFamily(tabId), ["reference", "lch_all"]);
    store1.set(first.dbTypeFamily(tabId), "lch_master");
    store1.set(first.localOptionsFamily(tabId), (prev) => ({
        ...prev,
        player: 42,
        player_database: "prep-db",
        color: "black",
        start_date: "2025.01.01",
        type: "partial",
        fen: "8/8/8/8/8/8/8/8 w - - 0 1",
        path: pinnedDb,
    }));

    expect(readStoredWorkspaceValue(sessionStorage, WORKSPACE_STORAGE_KEY)).toMatchObject({
        tabs: [
            {
                value: tabId,
                explorer: {
                    firstSource: "lch_master",
                    pinned: pinnedDb,
                    comparison: { database: onlineDb, player: 17 },
                    further: ["reference", "lch_all"],
                    options: {
                        player: 42,
                        player_database: "prep-db",
                        color: "black",
                        start_date: "2025.01.01",
                        result: "any",
                    },
                },
            },
        ],
    });

    vi.resetModules();
    const reloaded = await import("./atoms");
    const store2 = createStore();
    expect(store2.get(reloaded.pinnedExplorerDatabaseFamily(tabId))).toEqual(pinnedDb);
    expect(store2.get(reloaded.pinnedExplorerComparisonFamily(tabId))).toEqual({
        database: onlineDb,
        player: 17,
    });
    expect(store2.get(reloaded.pinnedExplorerFurtherColumnsFamily(tabId))).toEqual([
        "reference",
        "lch_all",
    ]);
    expect(store2.get(reloaded.dbTypeFamily(tabId))).toBe("lch_master");
    expect(store2.get(reloaded.localOptionsFamily(tabId))).toEqual({
        path: null,
        fen: "",
        type: "exact",
        player: 42,
        player_database: "prep-db",
        color: "black",
        start_date: "2025.01.01",
        result: "any",
    });
});
