import { afterEach, expect, test, vi } from "vitest";
import { createStore } from "jotai";
import {
    besideSplitsAtom,
    createWindowsStateStorage,
    defaultWindowsState,
    panelsBesideNotationAtom,
} from "./layoutStorage";

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

/** A mounted read: the stored value as a component sees it. */
function mounted<Value>(atom: Parameters<ReturnType<typeof createStore>["get"]>[0]) {
    const store = createStore();
    const unsubscribe = store.sub(atom, () => undefined);
    const value = store.get(atom) as Value;
    unsubscribe();
    return value;
}

test("the beside arrangement and its dividers hydrate from storage", () => {
    localStorage.setItem("panels-beside-notation", "true");
    localStorage.setItem("board-beside-splits", JSON.stringify({ board: 42, notation: 61.5 }));
    expect(mounted(panelsBesideNotationAtom)).toBe(true);
    expect(mounted(besideSplitsAtom)).toEqual({ board: 42, notation: 61.5 });
});

test("the beside arrangement is off and its dividers unset without stored values", () => {
    expect(mounted(panelsBesideNotationAtom)).toBe(false);
    expect(mounted(besideSplitsAtom)).toEqual({});
    expect(localStorage.getItem("panels-beside-notation")).toBeNull();
    expect(localStorage.getItem("board-beside-splits")).toBeNull();
});

test("an unreadable beside divider is dropped on its own and repaired in storage", () => {
    localStorage.setItem(
        "board-beside-splits",
        JSON.stringify({ board: 42, notation: 140, stray: 1 }),
    );
    expect(mounted<{ board?: number; notation?: number }>(besideSplitsAtom).board).toBe(42);
    expect(mounted<{ board?: number; notation?: number }>(besideSplitsAtom).notation).toBe(
        undefined,
    );
    expect(JSON.parse(localStorage.getItem("board-beside-splits")!)).toEqual({ board: 42 });
});

test.each(['"yes"', "{", "1"])("an unreadable beside choice %s falls back to off", (stored) => {
    localStorage.setItem("panels-beside-notation", stored);
    expect(mounted(panelsBesideNotationAtom)).toBe(false);
    expect(localStorage.getItem("panels-beside-notation")).toBe("false");
});

test.each(['"wide"', "[50, 50]", "{"])(
    "unreadable beside dividers %s fall back to unset",
    (stored) => {
        localStorage.setItem("board-beside-splits", stored);
        expect(mounted(besideSplitsAtom)).toEqual({});
    },
);
