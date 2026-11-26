import { createStore } from "jotai";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { tabFamily } from "./atoms";
import type { BoardArrangement } from "./boardArrangement";
import {
    ANALYSIS_TABS_HIDDEN_KEY,
    analysisTabsHiddenAtom,
    boardArrangementAtom,
} from "./layoutStorage";
import { selectStripTab } from "./stripTab";

vi.mock("@/platform/native", () => ({ warn: vi.fn() }));
vi.mock("./persistError", () => ({ reportPersistError: vi.fn() }));

const withDatabaseArea: BoardArrangement = {
    direction: "row",
    first: "left",
    second: {
        direction: "column",
        first: "database",
        second: { direction: "column", first: "topRight", second: "bottomRight" },
    },
};

describe("selectStripTab", () => {
    let store: ReturnType<typeof createStore>;
    beforeEach(() => {
        store = createStore();
        store.set(boardArrangementAtom, withDatabaseArea);
        store.set(analysisTabsHiddenAtom, true);
    });

    test("selects a tab that lives in the strip and shows the hidden strip", () => {
        selectStripTab(store, "tab-1", "practice");
        expect(store.get(tabFamily("tab-1"))).toBe("practice");
        expect(store.get(analysisTabsHiddenAtom)).toBe(false);
    });

    test("selects a panel shown as its own area without showing the strip", () => {
        selectStripTab(store, "tab-1", "database");
        expect(store.get(tabFamily("tab-1"))).toBe("database");
        expect(store.get(analysisTabsHiddenAtom)).toBe(true);
    });
});

describe("analysisTabsHiddenAtom storage", () => {
    test("an absent or corrupt stored value reads as shown", async () => {
        localStorage.setItem(ANALYSIS_TABS_HIDDEN_KEY, "not json");
        vi.resetModules();
        const fresh = await import("./layoutStorage");
        expect(createStore().get(fresh.analysisTabsHiddenAtom)).toBe(false);
        localStorage.removeItem(ANALYSIS_TABS_HIDDEN_KEY);
        vi.resetModules();
        const absent = await import("./layoutStorage");
        expect(createStore().get(absent.analysisTabsHiddenAtom)).toBe(false);
    });
});
