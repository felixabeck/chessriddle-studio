import { afterEach, expect, test, vi } from "vitest";
import { createStore } from "jotai";
import type { SyncStringStorage } from "jotai/vanilla/utils/atomWithStorage";
import {
    ANALYSIS_BOARD_LAYOUT_KEY,
    createBoardArrangementStorage,
    createWindowsStateStorage,
    defaultWindowsState,
    LEGACY_LAYOUT_KEYS,
    RETIRED_ENGINE_KEYS,
    WINDOWS_STATE_KEY,
} from "./layoutStorage";
import { defaultBoardArrangement, engineAreaId, placeArea } from "./boardArrangement";

const native = vi.hoisted(() => ({ warn: vi.fn() }));
const persistError = vi.hoisted(() => ({ reportPersistError: vi.fn() }));
vi.mock("@/platform/native", () => native);
vi.mock("./persistError", () => persistError);

afterEach(() => {
    localStorage.clear();
    native.warn.mockClear();
    persistError.reportPersistError.mockClear();
    vi.restoreAllMocks();
});

test("round-trips a valid bounded Mosaic layout", () => {
    const storage = createWindowsStateStorage(localStorage);
    const layout = {
        currentNode: {
            direction: "column" as const,
            first: "bottomRight" as const,
            second: {
                direction: "row" as const,
                first: "left" as const,
                second: "topRight" as const,
                splitPercentage: 35,
            },
        },
    };

    storage.setItem("windowsState", layout);

    expect(storage.getItem("windowsState", defaultWindowsState())).toEqual(layout);
});

test.each([
    { currentNode: "obsoletePane" },
    { currentNode: "database" },
    {
        currentNode: {
            direction: "row",
            first: "left",
            second: "left",
        },
    },
    {
        currentNode: {
            direction: "row",
            first: "left",
            second: "topRight",
            obsolete: true,
        },
    },
    {
        currentNode: {
            direction: "row",
            first: "left",
            second: "topRight",
            splitPercentage: 101,
        },
    },
    {
        currentNode: {
            direction: "row",
            first: "left",
            second: {
                direction: "column",
                first: "topRight",
                second: { direction: "row", first: "bottomRight", second: "left" },
            },
        },
    },
])("repairs corrupt or obsolete hydration to the safe layout", (stored) => {
    localStorage.setItem("windowsState", JSON.stringify(stored));
    const storage = createWindowsStateStorage(localStorage);

    expect(storage.getItem("windowsState", defaultWindowsState())).toEqual(defaultWindowsState());
    expect(JSON.parse(localStorage.getItem("windowsState")!)).toEqual(defaultWindowsState());
    expect(native.warn).toHaveBeenCalledWith("Invalid persisted value for windowsState");
});

test("reports a quota-failed write and preserves the last valid layout for reload", () => {
    const storage = createWindowsStateStorage(localStorage);
    const durable = { currentNode: "left" as const };
    storage.setItem("windowsState", durable);
    const originalSetItem = Storage.prototype.setItem;
    const quotaError = new DOMException("quota", "QuotaExceededError");
    const setItem = vi
        .spyOn(Storage.prototype, "setItem")
        .mockImplementation(function (this: Storage, key, value) {
            if (key === "windowsState") throw quotaError;
            return originalSetItem.call(this, key, value);
        });

    storage.setItem("windowsState", { currentNode: "topRight" });
    setItem.mockRestore();

    expect(persistError.reportPersistError).toHaveBeenCalledOnce();
    expect(
        createWindowsStateStorage(localStorage).getItem("windowsState", defaultWindowsState()),
    ).toEqual(durable);
});

/** In-memory storage double whose individual operations can be made to throw. */
function memoryStorage(
    initial: Record<string, string | undefined> = {},
    failures: {
        get?: (key: string) => Error | null;
        set?: (key: string) => Error | null;
        remove?: (key: string) => Error | null;
    } = {},
) {
    const map = new Map<string, string>(
        Object.entries(initial).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
        ),
    );
    const reads: string[] = [];
    const writes: Array<[string, string]> = [];
    const removals: string[] = [];
    const storage: SyncStringStorage = {
        getItem(key) {
            reads.push(key);
            const error = failures.get?.(key);
            if (error) throw error;
            return map.get(key) ?? null;
        },
        setItem(key, value) {
            writes.push([key, value]);
            const error = failures.set?.(key);
            if (error) throw error;
            map.set(key, value);
        },
        removeItem(key) {
            removals.push(key);
            const error = failures.remove?.(key);
            if (error) throw error;
            map.delete(key);
        },
    };
    return { storage, map, reads, writes, removals };
}

test("clean profile returns default arrangement without writing or removing anything", () => {
    const double = memoryStorage();
    const storage = createBoardArrangementStorage(double.storage);

    expect(storage.getItem(ANALYSIS_BOARD_LAYOUT_KEY, defaultBoardArrangement())).toEqual(
        defaultBoardArrangement(),
    );
    expect(double.writes).toEqual([]);
    expect(double.removals).toEqual([]);
    expect(persistError.reportPersistError).not.toHaveBeenCalled();
});

test.each([
    {
        name: "beside on with splits and pinned explorer above tabs (spans notation and tabs)",
        initial: {
            "panels-beside-notation": "true",
            "board-beside-splits": JSON.stringify({ board: 42, notation: 60 }),
            "detached-explorer": "true",
            "detached-explorer-placement": JSON.stringify("tabs"),
            "detached-explorer-heights": JSON.stringify({ tabs: 240 }),
        },
        expected: {
            direction: "row",
            first: "left",
            splitPercentage: 42,
            second: {
                direction: "column",
                first: "database",
                splitPercentage: 30,
                second: {
                    direction: "row",
                    first: "bottomRight",
                    second: "topRight",
                    splitPercentage: 60,
                },
            },
        },
    },
    {
        name: "beside off with windowsState and pinned explorer below board",
        initial: {
            windowsState: JSON.stringify({
                currentNode: {
                    direction: "row",
                    first: "left",
                    second: { direction: "column", first: "topRight", second: "bottomRight" },
                    splitPercentage: 55,
                },
            }),
            "detached-explorer": "true",
            "detached-explorer-placement": JSON.stringify("board"),
        },
        expected: {
            direction: "row",
            first: { direction: "column", first: "left", second: "database", splitPercentage: 70 },
            second: { direction: "column", first: "topRight", second: "bottomRight" },
            splitPercentage: 55,
        },
    },
    {
        name: "beside off with pinned explorer above notation",
        initial: {
            "detached-explorer": "true",
            "detached-explorer-placement": JSON.stringify("notation"),
        },
        expected: {
            direction: "row",
            first: "left",
            second: {
                direction: "column",
                first: "topRight",
                second: {
                    direction: "column",
                    first: "database",
                    second: "bottomRight",
                    splitPercentage: 30,
                },
            },
        },
    },
    {
        name: "beside off with pinned explorer below notation",
        initial: {
            "detached-explorer": "true",
            "detached-explorer-placement": JSON.stringify("belowNotation"),
        },
        expected: {
            direction: "row",
            first: "left",
            second: {
                direction: "column",
                first: "topRight",
                second: {
                    direction: "column",
                    first: "bottomRight",
                    second: "database",
                    splitPercentage: 70,
                },
            },
        },
    },
    {
        name: "unparseable legacy values count as absent and still clean up legacy keys",
        initial: {
            "panels-beside-notation": "{",
            "board-beside-splits": "not json",
            "detached-explorer": "123",
            "detached-explorer-placement": '"nowhere"',
            "detached-explorer-heights": "[]",
        },
        expected: defaultBoardArrangement(),
    },
])("carry-over writes new key and removes the five legacy keys: $name", ({ initial, expected }) => {
    const double = memoryStorage(initial);
    const storage = createBoardArrangementStorage(double.storage);

    const result = storage.getItem(ANALYSIS_BOARD_LAYOUT_KEY, defaultBoardArrangement());

    expect(result).toEqual(expected);
    expect(JSON.parse(double.map.get(ANALYSIS_BOARD_LAYOUT_KEY)!)).toEqual(expected);
    for (const key of LEGACY_LAYOUT_KEYS) {
        expect(double.map.has(key)).toBe(false);
    }
    expect(double.map.get(WINDOWS_STATE_KEY)).toBe(initial.windowsState);
    expect(persistError.reportPersistError).not.toHaveBeenCalled();
});

test("carry-over write failure keeps every legacy key, yields arrangement and reports once across repeated reads until setItem succeeds", () => {
    const initial = {
        "panels-beside-notation": "true",
        "detached-explorer": "true",
        "detached-explorer-placement": JSON.stringify("board"),
    };
    let failWrites = true;
    const double = memoryStorage(initial, {
        set: (key) =>
            failWrites && key === ANALYSIS_BOARD_LAYOUT_KEY
                ? new DOMException("quota", "QuotaExceededError")
                : null,
    });
    const storage = createBoardArrangementStorage(double.storage);
    const expected = {
        direction: "row" as const,
        first: {
            direction: "column" as const,
            first: "left" as const,
            second: "database" as const,
            splitPercentage: 70,
        },
        second: {
            direction: "row" as const,
            first: "bottomRight" as const,
            second: "topRight" as const,
        },
    };

    expect(storage.getItem(ANALYSIS_BOARD_LAYOUT_KEY, defaultBoardArrangement())).toEqual(expected);
    // Second getItem in the same session (e.g. Jotai mount after getOnInit) returns the memoized
    // outcome without re-running carry-over or reporting again.
    expect(storage.getItem(ANALYSIS_BOARD_LAYOUT_KEY, defaultBoardArrangement())).toEqual(expected);
    expect(double.removals).toEqual([]);
    for (const [key, value] of Object.entries(initial)) {
        expect(double.map.get(key)).toBe(value);
    }
    expect(persistError.reportPersistError).toHaveBeenCalledOnce();

    // Once a write succeeds (e.g. Reset or divider drag), the memo is cleared and getItem reads storage again.
    failWrites = false;
    storage.setItem(ANALYSIS_BOARD_LAYOUT_KEY, defaultBoardArrangement());
    expect(storage.getItem(ANALYSIS_BOARD_LAYOUT_KEY, expected)).toEqual(defaultBoardArrangement());
});

test("failing setItem reports save failure once without throwing and keeps the session memo", () => {
    const double = memoryStorage(
        {
            "panels-beside-notation": "true",
            "detached-explorer": "true",
            "detached-explorer-placement": JSON.stringify("board"),
        },
        {
            set: (key) =>
                key === ANALYSIS_BOARD_LAYOUT_KEY
                    ? new DOMException("quota", "QuotaExceededError")
                    : null,
        },
    );
    const storage = createBoardArrangementStorage(double.storage);
    const expected = {
        direction: "row" as const,
        first: {
            direction: "column" as const,
            first: "left" as const,
            second: "database" as const,
            splitPercentage: 70,
        },
        second: {
            direction: "row" as const,
            first: "bottomRight" as const,
            second: "topRight" as const,
        },
    };

    // Establish the session memo via a failed carry-over write.
    expect(storage.getItem(ANALYSIS_BOARD_LAYOUT_KEY, defaultBoardArrangement())).toEqual(expected);
    persistError.reportPersistError.mockClear();

    // A subsequent failing setItem does not throw, reports once, and preserves the session memo.
    expect(() =>
        storage.setItem(ANALYSIS_BOARD_LAYOUT_KEY, defaultBoardArrangement()),
    ).not.toThrow();
    expect(persistError.reportPersistError).toHaveBeenCalledOnce();

    persistError.reportPersistError.mockClear();
    expect(storage.getItem(ANALYSIS_BOARD_LAYOUT_KEY, defaultBoardArrangement())).toEqual(expected);
    expect(persistError.reportPersistError).not.toHaveBeenCalled();
});

test("removeItem deletes the key, clears the session memo, and reports once without throwing on failure", () => {
    let failWrites = true;
    let failRemovals = false;
    const double = memoryStorage(
        {
            "panels-beside-notation": "true",
            "detached-explorer": "true",
            "detached-explorer-placement": JSON.stringify("board"),
        },
        {
            set: (key) =>
                failWrites && key === ANALYSIS_BOARD_LAYOUT_KEY
                    ? new DOMException("quota", "QuotaExceededError")
                    : null,
            remove: (key) =>
                failRemovals && key === ANALYSIS_BOARD_LAYOUT_KEY ? new Error("locked") : null,
        },
    );
    const storage = createBoardArrangementStorage(double.storage);
    const expected = {
        direction: "row" as const,
        first: {
            direction: "column" as const,
            first: "left" as const,
            second: "database" as const,
            splitPercentage: 70,
        },
        second: {
            direction: "row" as const,
            first: "bottomRight" as const,
            second: "topRight" as const,
        },
    };

    // Establish the session memo via a failed carry-over write, then seed a key to prove removal.
    expect(storage.getItem(ANALYSIS_BOARD_LAYOUT_KEY, defaultBoardArrangement())).toEqual(expected);
    double.map.set(ANALYSIS_BOARD_LAYOUT_KEY, JSON.stringify(defaultBoardArrangement()));
    persistError.reportPersistError.mockClear();

    // (a) removeItem removes the key and clears the memo so the next getItem reads storage again.
    storage.removeItem(ANALYSIS_BOARD_LAYOUT_KEY);
    expect(double.map.has(ANALYSIS_BOARD_LAYOUT_KEY)).toBe(false);
    expect(persistError.reportPersistError).not.toHaveBeenCalled();

    failWrites = false;
    const fresh = {
        direction: "row" as const,
        first: "left" as const,
        second: {
            direction: "row" as const,
            first: "bottomRight" as const,
            second: "topRight" as const,
        },
    };
    double.map.set(ANALYSIS_BOARD_LAYOUT_KEY, JSON.stringify(fresh));
    expect(storage.getItem(ANALYSIS_BOARD_LAYOUT_KEY, defaultBoardArrangement())).toEqual(fresh);

    // (b) When storage.removeItem throws, removeItem does not throw and reports once.
    failRemovals = true;
    expect(() => storage.removeItem(ANALYSIS_BOARD_LAYOUT_KEY)).not.toThrow();
    expect(persistError.reportPersistError).toHaveBeenCalledOnce();
});

test.each([ANALYSIS_BOARD_LAYOUT_KEY, "detached-explorer", WINDOWS_STATE_KEY])(
    "throwing read of %s yields default, writes and removes nothing and reports once across repeated reads",
    (failingKey) => {
        const initial = {
            "panels-beside-notation": "true",
            "detached-explorer": "true",
        };
        let failReads = true;
        const double = memoryStorage(initial, {
            get: (key) => (failReads && key === failingKey ? new Error("blocked") : null),
        });
        const storage = createBoardArrangementStorage(double.storage);

        expect(storage.getItem(ANALYSIS_BOARD_LAYOUT_KEY, defaultBoardArrangement())).toEqual(
            defaultBoardArrangement(),
        );
        // Second getItem in the same session returns the memoized default without reporting again.
        expect(storage.getItem(ANALYSIS_BOARD_LAYOUT_KEY, defaultBoardArrangement())).toEqual(
            defaultBoardArrangement(),
        );
        expect(double.writes).toEqual([]);
        expect(double.removals).toEqual([]);
        expect(persistError.reportPersistError).toHaveBeenCalledOnce();

        // After setItem succeeds, getItem reads storage again.
        failReads = false;
        const custom = {
            direction: "row" as const,
            first: "left" as const,
            second: {
                direction: "row" as const,
                first: "bottomRight" as const,
                second: "topRight" as const,
            },
        };
        storage.setItem(ANALYSIS_BOARD_LAYOUT_KEY, custom);
        expect(storage.getItem(ANALYSIS_BOARD_LAYOUT_KEY, defaultBoardArrangement())).toEqual(
            custom,
        );
    },
);

test("throwing removeItem on multiple legacy keys still attempts all five, warns once naming them, yields arrangement and reports once", () => {
    const double = memoryStorage(
        {
            "panels-beside-notation": "true",
            "board-beside-splits": JSON.stringify({ board: 45 }),
            "detached-explorer": "false",
            "detached-explorer-placement": JSON.stringify("tabs"),
            "detached-explorer-heights": JSON.stringify({ tabs: 200 }),
        },
        {
            remove: (key) =>
                key === "board-beside-splits" || key === "detached-explorer-heights"
                    ? new Error(`locked: ${key}`)
                    : null,
        },
    );
    const storage = createBoardArrangementStorage(double.storage);

    const result = storage.getItem(ANALYSIS_BOARD_LAYOUT_KEY, defaultBoardArrangement());

    expect(result).toEqual({
        direction: "row",
        first: "left",
        splitPercentage: 45,
        second: { direction: "row", first: "bottomRight", second: "topRight" },
    });
    expect(double.removals).toEqual([...LEGACY_LAYOUT_KEYS]);
    expect(double.map.has("board-beside-splits")).toBe(true);
    expect(double.map.has("detached-explorer-heights")).toBe(true);
    expect(double.map.has("panels-beside-notation")).toBe(false);
    expect(double.map.has("detached-explorer")).toBe(false);
    expect(double.map.has("detached-explorer-placement")).toBe(false);
    expect(native.warn).toHaveBeenCalledExactlyOnceWith(
        "Unable to remove legacy layout keys: board-beside-splits, detached-explorer-heights",
    );
    expect(persistError.reportPersistError).toHaveBeenCalledOnce();

    // A second read uses the written new key and does not carry over again.
    persistError.reportPersistError.mockClear();
    expect(storage.getItem(ANALYSIS_BOARD_LAYOUT_KEY, defaultBoardArrangement())).toEqual(result);
    expect(persistError.reportPersistError).not.toHaveBeenCalled();
});

test("invalid stored analysis-board-layout yields default and repairs storage", () => {
    const double = memoryStorage({
        [ANALYSIS_BOARD_LAYOUT_KEY]: JSON.stringify({
            direction: "row",
            first: "left",
            second: "left",
        }),
    });
    const storage = createBoardArrangementStorage(double.storage);

    expect(storage.getItem(ANALYSIS_BOARD_LAYOUT_KEY, defaultBoardArrangement())).toEqual(
        defaultBoardArrangement(),
    );
    expect(JSON.parse(double.map.get(ANALYSIS_BOARD_LAYOUT_KEY)!)).toEqual(
        defaultBoardArrangement(),
    );
    expect(native.warn).toHaveBeenCalledWith(
        `Invalid persisted value for ${ANALYSIS_BOARD_LAYOUT_KEY}`,
    );

    // When the repair write succeeds, the fallback is not memoized: a subsequent read sees storage again.
    const updated = {
        direction: "row" as const,
        first: "left" as const,
        second: {
            direction: "row" as const,
            first: "bottomRight" as const,
            second: "topRight" as const,
        },
    };
    double.map.set(ANALYSIS_BOARD_LAYOUT_KEY, JSON.stringify(updated));
    expect(storage.getItem(ANALYSIS_BOARD_LAYOUT_KEY, defaultBoardArrangement())).toEqual(updated);
});

test("invalid stored analysis-board-layout with throwing setItem memoizes the default and reports once across repeated reads", () => {
    let failWrites = true;
    const double = memoryStorage(
        {
            [ANALYSIS_BOARD_LAYOUT_KEY]: "{not-valid-json",
        },
        {
            set: (key) =>
                failWrites && key === ANALYSIS_BOARD_LAYOUT_KEY
                    ? new DOMException("quota", "QuotaExceededError")
                    : null,
        },
    );
    const storage = createBoardArrangementStorage(double.storage);

    expect(storage.getItem(ANALYSIS_BOARD_LAYOUT_KEY, defaultBoardArrangement())).toEqual(
        defaultBoardArrangement(),
    );
    // Second getItem in the same session returns the memoized default without reporting again.
    expect(storage.getItem(ANALYSIS_BOARD_LAYOUT_KEY, defaultBoardArrangement())).toEqual(
        defaultBoardArrangement(),
    );
    expect(persistError.reportPersistError).toHaveBeenCalledOnce();

    // A subsequent successful setItem clears the session memo.
    failWrites = false;
    const custom = {
        direction: "row" as const,
        first: "left" as const,
        second: {
            direction: "row" as const,
            first: "bottomRight" as const,
            second: "topRight" as const,
        },
    };
    storage.setItem(ANALYSIS_BOARD_LAYOUT_KEY, custom);
    expect(storage.getItem(ANALYSIS_BOARD_LAYOUT_KEY, defaultBoardArrangement())).toEqual(custom);
});

test("Reset as the first action on a profile with legacy keys leaves none of them", async () => {
    localStorage.setItem(WINDOWS_STATE_KEY, JSON.stringify(defaultWindowsState()));
    localStorage.setItem("panels-beside-notation", "true");
    localStorage.setItem("board-beside-splits", JSON.stringify({ board: 45 }));
    localStorage.setItem("detached-explorer", "true");
    localStorage.setItem("detached-explorer-placement", JSON.stringify("board"));
    localStorage.setItem("detached-explorer-heights", JSON.stringify({ board: 180 }));

    // Fresh module import creates the exported `boardArrangementAtom` against the seeded storage.
    vi.resetModules();
    const { boardArrangementAtom } = await import("./layoutStorage");

    const store = createStore();
    store.set(boardArrangementAtom, defaultBoardArrangement());

    expect(JSON.parse(localStorage.getItem(ANALYSIS_BOARD_LAYOUT_KEY)!)).toEqual(
        defaultBoardArrangement(),
    );
    for (const key of LEGACY_LAYOUT_KEYS) {
        expect(localStorage.getItem(key)).toBeNull();
    }
    expect(localStorage.getItem(WINDOWS_STATE_KEY)).not.toBeNull();
});

test.each([
    {
        placement: undefined,
        expected: {
            direction: "row",
            first: "left",
            second: {
                direction: "column",
                first: {
                    direction: "column",
                    first: "engine:legacy-engine-identity:sf",
                    second: "topRight",
                    splitPercentage: 30,
                },
                second: "bottomRight",
            },
        },
    },
    {
        placement: JSON.stringify("tabs"),
        expected: {
            direction: "row",
            first: "left",
            second: {
                direction: "column",
                first: {
                    direction: "column",
                    first: "engine:legacy-engine-identity:sf",
                    second: "topRight",
                    splitPercentage: 30,
                },
                second: "bottomRight",
            },
        },
    },
    {
        placement: JSON.stringify("notation"),
        expected: {
            direction: "row",
            first: "left",
            second: {
                direction: "column",
                first: "topRight",
                second: {
                    direction: "column",
                    first: "engine:legacy-engine-identity:sf",
                    second: "bottomRight",
                    splitPercentage: 30,
                },
            },
        },
    },
    {
        placement: JSON.stringify("belowNotation"),
        expected: {
            direction: "row",
            first: "left",
            second: {
                direction: "column",
                first: "topRight",
                second: {
                    direction: "column",
                    first: "bottomRight",
                    second: "engine:legacy-engine-identity:sf",
                    splitPercentage: 70,
                },
            },
        },
    },
    {
        placement: JSON.stringify("board"),
        expected: {
            direction: "row",
            first: {
                direction: "column",
                first: "left",
                second: "engine:legacy-engine-identity:sf",
                splitPercentage: 70,
            },
            second: {
                direction: "column",
                first: "topRight",
                second: "bottomRight",
            },
        },
    },
])(
    "retired pinned-engine carry-over runs with existing analysis-board-layout for placement $placement and removes all three retired keys",
    ({ placement, expected }) => {
        const double = memoryStorage({
            [ANALYSIS_BOARD_LAYOUT_KEY]: JSON.stringify(defaultBoardArrangement()),
            "detached-engine": JSON.stringify("legacy-engine-identity:sf"),
            ...(placement !== undefined ? { "detached-engine-placement": placement } : {}),
            "detached-engine-lines": JSON.stringify(3),
        });
        const storage = createBoardArrangementStorage(double.storage);

        const result = storage.getItem(ANALYSIS_BOARD_LAYOUT_KEY, defaultBoardArrangement());

        expect(result).toEqual(expected);
        expect(JSON.parse(double.map.get(ANALYSIS_BOARD_LAYOUT_KEY)!)).toEqual(expected);
        for (const key of RETIRED_ENGINE_KEYS) {
            expect(double.map.has(key)).toBe(false);
        }
        expect(persistError.reportPersistError).not.toHaveBeenCalled();
    },
);

test("retired pinned-engine carry-over runs when analysis-board-layout is absent, including alongside legacy explorer keys", () => {
    const double = memoryStorage({
        "detached-explorer": "true",
        "detached-explorer-placement": JSON.stringify("board"),
        "detached-engine": JSON.stringify("eng-1"),
        "detached-engine-placement": JSON.stringify("notation"),
        "detached-engine-lines": JSON.stringify(2),
    });
    const storage = createBoardArrangementStorage(double.storage);

    const result = storage.getItem(ANALYSIS_BOARD_LAYOUT_KEY, defaultBoardArrangement());

    expect(result).toEqual({
        direction: "row",
        first: { direction: "column", first: "left", second: "database", splitPercentage: 70 },
        second: {
            direction: "column",
            first: "topRight",
            second: {
                direction: "column",
                first: "engine:eng-1",
                second: "bottomRight",
                splitPercentage: 30,
            },
        },
    });
    for (const key of [...LEGACY_LAYOUT_KEYS, ...RETIRED_ENGINE_KEYS]) {
        expect(double.map.has(key)).toBe(false);
    }
});

test.each([
    ["null engine id", { "detached-engine": "null", "detached-engine-lines": "2" }],
    ["empty engine id", { "detached-engine": '""', "detached-engine-placement": '"board"' }],
    ["corrupt engine id", { "detached-engine": "{bad", "detached-engine-lines": "3" }],
    ["non-string engine id", { "detached-engine": "123" }],
    ["lines key only", { "detached-engine-lines": "2" }],
])(
    "retired keys with no valid engine id (%s) remove all three retired keys without writing analysis-board-layout",
    (_label, retired) => {
        // When analysis-board-layout is absent: no write, retired keys removed.
        const absent = memoryStorage(retired);
        expect(
            createBoardArrangementStorage(absent.storage).getItem(
                ANALYSIS_BOARD_LAYOUT_KEY,
                defaultBoardArrangement(),
            ),
        ).toEqual(defaultBoardArrangement());
        expect(absent.writes).toEqual([]);
        expect(absent.removals).toEqual([...RETIRED_ENGINE_KEYS]);
        for (const key of RETIRED_ENGINE_KEYS) {
            expect(absent.map.has(key)).toBe(false);
        }

        // When analysis-board-layout exists: no rewrite, retired keys removed.
        const custom = placeArea(defaultBoardArrangement(), "database", "left", "bottom");
        const present = memoryStorage({
            [ANALYSIS_BOARD_LAYOUT_KEY]: JSON.stringify(custom),
            ...retired,
        });
        expect(
            createBoardArrangementStorage(present.storage).getItem(
                ANALYSIS_BOARD_LAYOUT_KEY,
                defaultBoardArrangement(),
            ),
        ).toEqual(custom);
        expect(present.writes).toEqual([]);
        expect(present.removals).toEqual([...RETIRED_ENGINE_KEYS]);
    },
);

test("retired engine carry-over skips write and removes retired keys when leaf is already present or cap 4 is reached", () => {
    const withEng1 = placeArea(defaultBoardArrangement(), engineAreaId("eng-1"), "left", "bottom");
    const dup = memoryStorage({
        [ANALYSIS_BOARD_LAYOUT_KEY]: JSON.stringify(withEng1),
        "detached-engine": JSON.stringify("eng-1"),
        "detached-engine-placement": JSON.stringify("tabs"),
    });
    expect(
        createBoardArrangementStorage(dup.storage).getItem(
            ANALYSIS_BOARD_LAYOUT_KEY,
            defaultBoardArrangement(),
        ),
    ).toEqual(withEng1);
    expect(dup.writes).toEqual([]);
    expect(dup.removals).toEqual([...RETIRED_ENGINE_KEYS]);

    let atCap = defaultBoardArrangement();
    for (const id of ["e1", "e2", "e3", "e4"]) {
        atCap = placeArea(atCap, engineAreaId(id), "left", "bottom");
    }
    const capped = memoryStorage({
        [ANALYSIS_BOARD_LAYOUT_KEY]: JSON.stringify(atCap),
        "detached-engine": JSON.stringify("e5"),
        "detached-engine-placement": JSON.stringify("tabs"),
    });
    expect(
        createBoardArrangementStorage(capped.storage).getItem(
            ANALYSIS_BOARD_LAYOUT_KEY,
            defaultBoardArrangement(),
        ),
    ).toEqual(atCap);
    expect(capped.writes).toEqual([]);
    expect(capped.removals).toEqual([...RETIRED_ENGINE_KEYS]);
});

test("failed write during retired engine carry-over keeps all three retired keys and serves computed arrangement for the session", () => {
    const double = memoryStorage(
        {
            [ANALYSIS_BOARD_LAYOUT_KEY]: JSON.stringify(defaultBoardArrangement()),
            "detached-engine": JSON.stringify("eng-1"),
            "detached-engine-placement": JSON.stringify("board"),
            "detached-engine-lines": JSON.stringify(2),
        },
        {
            set: (key) =>
                key === ANALYSIS_BOARD_LAYOUT_KEY
                    ? new DOMException("quota", "QuotaExceededError")
                    : null,
        },
    );
    const storage = createBoardArrangementStorage(double.storage);
    const expected = {
        direction: "row" as const,
        first: {
            direction: "column" as const,
            first: "left" as const,
            second: "engine:eng-1" as const,
            splitPercentage: 70,
        },
        second: {
            direction: "column" as const,
            first: "topRight" as const,
            second: "bottomRight" as const,
        },
    };

    expect(storage.getItem(ANALYSIS_BOARD_LAYOUT_KEY, defaultBoardArrangement())).toEqual(expected);
    // Repeated read in the same session returns the memoized computed arrangement without reporting again.
    expect(storage.getItem(ANALYSIS_BOARD_LAYOUT_KEY, defaultBoardArrangement())).toEqual(expected);
    expect(double.removals).toEqual([]);
    for (const key of RETIRED_ENGINE_KEYS) {
        expect(double.map.has(key)).toBe(true);
    }
    expect(persistError.reportPersistError).toHaveBeenCalledOnce();
});

test.each(RETIRED_ENGINE_KEYS)(
    "throwing read of retired key %s after valid stored layout returns that stored layout (never default) and keeps retired keys",
    (failingKey) => {
        const custom = placeArea(defaultBoardArrangement(), "database", "left", "bottom");
        const double = memoryStorage(
            {
                [ANALYSIS_BOARD_LAYOUT_KEY]: JSON.stringify(custom),
                "detached-engine": JSON.stringify("eng-1"),
                "detached-engine-placement": JSON.stringify("board"),
                "detached-engine-lines": JSON.stringify(2),
            },
            {
                get: (key) => (key === failingKey ? new Error("blocked") : null),
            },
        );
        const storage = createBoardArrangementStorage(double.storage);

        expect(storage.getItem(ANALYSIS_BOARD_LAYOUT_KEY, defaultBoardArrangement())).toEqual(
            custom,
        );
        expect(storage.getItem(ANALYSIS_BOARD_LAYOUT_KEY, defaultBoardArrangement())).toEqual(
            custom,
        );
        expect(double.writes).toEqual([]);
        expect(double.removals).toEqual([]);
        for (const key of RETIRED_ENGINE_KEYS) {
            expect(double.map.has(key)).toBe(true);
        }
        expect(persistError.reportPersistError).toHaveBeenCalledOnce();
    },
);

test("failed removal of retired keys reports like legacy carry-over and retries idempotently on next start", () => {
    let failRemoval = true;
    const double = memoryStorage(
        {
            [ANALYSIS_BOARD_LAYOUT_KEY]: JSON.stringify(defaultBoardArrangement()),
            "detached-engine": JSON.stringify("eng-1"),
            "detached-engine-placement": JSON.stringify("board"),
            "detached-engine-lines": JSON.stringify(2),
        },
        {
            remove: (key) =>
                failRemoval && key === "detached-engine" ? new Error("locked") : null,
        },
    );
    const firstSession = createBoardArrangementStorage(double.storage);
    const expected = {
        direction: "row" as const,
        first: {
            direction: "column" as const,
            first: "left" as const,
            second: "engine:eng-1" as const,
            splitPercentage: 70,
        },
        second: {
            direction: "column" as const,
            first: "topRight" as const,
            second: "bottomRight" as const,
        },
    };

    expect(firstSession.getItem(ANALYSIS_BOARD_LAYOUT_KEY, defaultBoardArrangement())).toEqual(
        expected,
    );
    // Repeated read in the same session uses the sessionFallback memo and does not report again.
    expect(firstSession.getItem(ANALYSIS_BOARD_LAYOUT_KEY, defaultBoardArrangement())).toEqual(
        expected,
    );
    expect(double.map.has("detached-engine")).toBe(true);
    expect(double.map.has("detached-engine-placement")).toBe(false);
    expect(double.map.has("detached-engine-lines")).toBe(false);
    expect(native.warn).toHaveBeenCalledWith(
        "Unable to remove legacy layout keys: detached-engine",
    );
    expect(persistError.reportPersistError).toHaveBeenCalledOnce();

    // Next start: removal succeeds, no duplicate engine leaf, no extra write.
    failRemoval = false;
    persistError.reportPersistError.mockClear();
    double.writes.length = 0;
    const nextSession = createBoardArrangementStorage(double.storage);
    expect(nextSession.getItem(ANALYSIS_BOARD_LAYOUT_KEY, defaultBoardArrangement())).toEqual(
        expected,
    );
    expect(double.writes).toEqual([]);
    for (const key of RETIRED_ENGINE_KEYS) {
        expect(double.map.has(key)).toBe(false);
    }
    expect(persistError.reportPersistError).not.toHaveBeenCalled();
});

test("corrupt analysis-board-layout whose repair write fails keeps retired engine keys and attempts no second write", () => {
    const double = memoryStorage(
        {
            [ANALYSIS_BOARD_LAYOUT_KEY]: "{not-valid-json",
            "detached-engine": JSON.stringify("eng-1"),
            "detached-engine-placement": JSON.stringify("board"),
            "detached-engine-lines": JSON.stringify(2),
        },
        {
            set: (key) =>
                key === ANALYSIS_BOARD_LAYOUT_KEY
                    ? new DOMException("quota", "QuotaExceededError")
                    : null,
        },
    );
    const storage = createBoardArrangementStorage(double.storage);

    expect(storage.getItem(ANALYSIS_BOARD_LAYOUT_KEY, defaultBoardArrangement())).toEqual(
        defaultBoardArrangement(),
    );
    expect(double.writes).toHaveLength(1);
    expect(double.removals).toEqual([]);
    for (const key of RETIRED_ENGINE_KEYS) {
        expect(double.map.has(key)).toBe(true);
    }
    expect(persistError.reportPersistError).toHaveBeenCalledOnce();
});
