import { createStore } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { afterEach, expect, test, vi } from "vitest";
import { lastOpenedAtom, recordLastOpenedAtom } from "./atoms";
import { createLastOpenedStorage, MAX_LAST_OPENED, type LastOpened } from "./lastOpened";
import { deserializeStorageValue, serializeStorageValue } from "./store/debouncedStorage";

const report = vi.hoisted(() => vi.fn());
vi.mock("./persistError", () => ({ reportPersistError: report }));
vi.mock("@/platform/tauri", () => ({ tauri: {} }));

afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    report.mockClear();
});

test("recording an open before the atom has ever mounted preserves saved history through reload", async () => {
    const history = { "opaque-old-file": 100, "opaque-old-database": 200 };
    createLastOpenedStorage(localStorage).setItem("last-opened", history);
    vi.resetModules();
    const fresh = await import("./atoms");
    const store = createStore();

    // No subscription or initial read precedes this Library-page write.
    store.set(fresh.recordLastOpenedAtom, ["opaque-new-file"]);
    const expected = { ...history, "opaque-new-file": expect.any(Number) };
    expect(store.get(fresh.lastOpenedAtom)).toEqual(expected);
    expect(store.get(fresh.lastOpenedAtom)["opaque-new-file"]).toBeGreaterThan(200);

    vi.resetModules();
    const reloaded = await import("./atoms");
    expect(createStore().get(reloaded.lastOpenedAtom)).toEqual(expected);
});

test("the record survives hydration in a new atom and store with the validated compressed format", () => {
    const store = createStore();
    store.set(lastOpenedAtom, {});
    store.set(recordLastOpenedAtom, ["opaque-file", "opaque-database"]);
    const saved = store.get(lastOpenedAtom);
    expect(saved["opaque-file"]).toBeGreaterThan(0);
    expect(deserializeStorageValue(localStorage.getItem("last-opened")!)).toEqual({
        version: 1,
        items: saved,
    });
    const reloaded = atomWithStorage<LastOpened>(
        "last-opened",
        {},
        createLastOpenedStorage(localStorage),
        { getOnInit: true },
    );
    expect(createStore().get(reloaded)).toEqual(saved);
});

test("bounds the record to the 1000 newest keys by age, including refreshing an old key", () => {
    const store = createStore();
    store.set(
        lastOpenedAtom,
        Object.fromEntries(
            Array.from({ length: MAX_LAST_OPENED }, (_, index) => [`opaque-${index}`, index + 1]),
        ),
    );
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(1001);
    store.set(recordLastOpenedAtom, ["opaque-1000"]);
    expect(Object.keys(store.get(lastOpenedAtom))).toHaveLength(MAX_LAST_OPENED);
    expect(store.get(lastOpenedAtom)["opaque-0"]).toBeUndefined();
    expect(store.get(lastOpenedAtom)["opaque-1000"]).toBe(1001);
    now.mockReturnValue(2000);
    store.set(recordLastOpenedAtom, ["opaque-1"]);
    now.mockReturnValue(2001);
    store.set(recordLastOpenedAtom, ["another"]);
    const saved = createLastOpenedStorage(localStorage).getItem("last-opened", {});
    expect(Object.keys(saved)).toHaveLength(MAX_LAST_OPENED);
    expect(saved["opaque-1"]).toBe(2000);
    expect(saved["opaque-2"]).toBeUndefined();
});

test("keeps newly opened keys when timestamps tie at the cap", () => {
    const store = createStore();
    store.set(
        lastOpenedAtom,
        Object.fromEntries(
            Array.from({ length: MAX_LAST_OPENED }, (_, index) => [`opaque-${index}`, 1]),
        ),
    );
    vi.spyOn(Date, "now").mockReturnValue(1);
    store.set(recordLastOpenedAtom, ["newest"]);
    expect(Object.keys(store.get(lastOpenedAtom))).toHaveLength(MAX_LAST_OPENED);
    expect(store.get(lastOpenedAtom).newest).toBe(1);
});

test.each([
    null,
    "",
    "broken",
    serializeStorageValue({ version: 2, items: {} }),
    serializeStorageValue({ version: 1, items: { opaque: "yesterday" } }),
    serializeStorageValue({ version: 1, items: { opaque: -1 } }),
])("absent or corrupt stored records hydrate empty: %s", (bytes) => {
    if (bytes !== null) localStorage.setItem("last-opened", bytes);
    expect(createLastOpenedStorage(localStorage).getItem("last-opened", {})).toEqual({});
});

test("oversized stored records are bounded on read as well as write", () => {
    const items = Object.fromEntries(
        Array.from({ length: 1100 }, (_, index) => [`opaque-${index}`, index]),
    );
    localStorage.setItem("last-opened", serializeStorageValue({ version: 1, items }));
    const loaded = createLastOpenedStorage(localStorage).getItem("last-opened", {});
    expect(Object.keys(loaded)).toHaveLength(MAX_LAST_OPENED);
    expect(loaded["opaque-99"]).toBeUndefined();
    expect(loaded["opaque-1099"]).toBe(1099);
});

test("read and quota failures are handled by the existing preference error route", () => {
    const storage = createLastOpenedStorage({
        getItem: () => {
            throw new DOMException("denied", "SecurityError");
        },
        setItem: () => {
            throw new DOMException("full", "QuotaExceededError");
        },
        removeItem: () => {
            throw new DOMException("denied", "SecurityError");
        },
    });
    expect(storage.getItem("last-opened", {})).toEqual({});
    expect(() => storage.setItem("last-opened", { opaque: 1 })).not.toThrow();
    expect(() => storage.removeItem("last-opened")).not.toThrow();
    expect(report).toHaveBeenCalledTimes(3);
});
