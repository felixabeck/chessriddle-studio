import { createStore } from "jotai";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const reportPreferenceStorageFailure = vi.hoisted(() => vi.fn());
vi.mock("./utils", () => ({ reportPreferenceStorageFailure }));

import { serializeStorageValue } from "./store/debouncedStorage";
import { PAGE_TABS_STORAGE_KEY, pageTabsAtom, readPageTabs } from "./pageTabs";

beforeEach(() => {
    sessionStorage.clear();
    reportPreferenceStorageFailure.mockClear();
});

afterEach(() => {
    vi.restoreAllMocks();
});

test("a fresh store restores the page tabs a previous load saved", () => {
    const before = createStore();
    before.set(pageTabsAtom, (pages) => [...pages, "settings"]);
    before.set(pageTabsAtom, (pages) => [...pages, "accounts"]);

    const after = createStore();
    expect(after.get(pageTabsAtom)).toEqual(["settings", "accounts"]);

    after.set(pageTabsAtom, (pages) => pages.filter((page) => page !== "settings"));
    expect(createStore().get(pageTabsAtom)).toEqual(["accounts"]);
});

test("absent, corrupt and invalid values restore no page tabs while older and guide values restore", () => {
    expect(readPageTabs(sessionStorage)).toEqual([]);
    for (const stored of [
        "not json",
        '["accounts","accounts"]',
        '["guide","guide"]',
        '["boards"]',
        '{"accounts":true}',
        serializeStorageValue(["accounts", "engines", "settings", "accounts"]),
        serializeStorageValue(["accounts", "engines", "settings", "guide", "accounts"]),
    ]) {
        sessionStorage.setItem(PAGE_TABS_STORAGE_KEY, stored);
        expect(readPageTabs(sessionStorage)).toEqual([]);
    }
    sessionStorage.setItem(PAGE_TABS_STORAGE_KEY, serializeStorageValue(["engines"]));
    expect(readPageTabs(sessionStorage)).toEqual(["engines"]);
    sessionStorage.setItem(
        PAGE_TABS_STORAGE_KEY,
        serializeStorageValue(["accounts", "engines", "settings"]),
    );
    expect(readPageTabs(sessionStorage)).toEqual(["accounts", "engines", "settings"]);
    sessionStorage.setItem(PAGE_TABS_STORAGE_KEY, serializeStorageValue(["guide"]));
    expect(readPageTabs(sessionStorage)).toEqual(["guide"]);
    sessionStorage.setItem(
        PAGE_TABS_STORAGE_KEY,
        serializeStorageValue(["accounts", "engines", "settings", "guide"]),
    );
    expect(readPageTabs(sessionStorage)).toEqual(["accounts", "engines", "settings", "guide"]);
    expect(reportPreferenceStorageFailure).not.toHaveBeenCalled();
});

test("a refused read is reported and restores no page tabs", () => {
    const error = new DOMException("denied", "SecurityError");
    const storage = {
        getItem: () => {
            throw error;
        },
    };
    expect(readPageTabs(storage)).toEqual([]);
    expect(reportPreferenceStorageFailure).toHaveBeenCalledWith("read", error);
});

test("a refused write is reported and the tab stays open for this session", () => {
    const error = new DOMException("full", "QuotaExceededError");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
        throw error;
    });
    const store = createStore();
    store.set(pageTabsAtom, (pages) => [...pages, "engines"]);
    expect(store.get(pageTabsAtom)).toEqual(["engines"]);
    expect(reportPreferenceStorageFailure).toHaveBeenCalledWith("save", error);
});

test("an unchanged list is not written again", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const store = createStore();
    store.set(pageTabsAtom, (pages) => pages);
    expect(setItem).not.toHaveBeenCalled();
});
