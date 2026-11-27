import { expect, test, vi } from "vitest";
import {
    boardTabId,
    boardTabPanelId,
    closeOnMiddleClick,
    isBoardsPath,
    isLibraryFamilyPath,
    preventMiddleMouseAutoscroll,
    returnTargetFromPath,
    pageTabOf,
} from "./boardTabDom";

test("the shared tab and panel ids are a function of the tab id", () => {
    expect(boardTabId("abc")).toBe("board-tab-abc");
    expect(boardTabPanelId("abc")).toBe("board-tab-panel-abc");
    expect(boardTabId("a-uuid")).toBe("board-tab-a-uuid");
    expect(boardTabPanelId("a-uuid")).toBe("board-tab-panel-a-uuid");
});

test("library family matching covers databases routes and not a lookalike", () => {
    expect(isLibraryFamilyPath("/library")).toBe(true);
    expect(isLibraryFamilyPath("/library/")).toBe(true);
    expect(isLibraryFamilyPath("/databases")).toBe(true);
    expect(isLibraryFamilyPath("/databases/")).toBe(true);
    expect(isLibraryFamilyPath("/databases/abc")).toBe(true);
    expect(isLibraryFamilyPath("/databasesX")).toBe(false);
    expect(isBoardsPath("/")).toBe(true);
    expect(isBoardsPath("/library")).toBe(false);
});

test("page tabs are derived from the route", () => {
    expect(pageTabOf("/settings")).toBe("settings");
    expect(pageTabOf("/accounts")).toBe("accounts");
    expect(pageTabOf("/engines")).toBe("engines");
    expect(pageTabOf("/guide")).toBe("guide");
    expect(pageTabOf("/guide/")).toBe("guide");
    expect(pageTabOf("/guide/topics")).toBe("guide");
    expect(pageTabOf("/guideX")).toBeNull();
    expect(pageTabOf("/library")).toBeNull();
    expect(pageTabOf("/")).toBeNull();
});

test("the return target is the last boards or library-family location", () => {
    expect(returnTargetFromPath("/")).toEqual({ to: "/" });
    expect(returnTargetFromPath("/library")).toEqual({ to: "/library" });
    expect(returnTargetFromPath("/databases/database-A")).toEqual({
        to: "/databases/$databaseId",
        params: { databaseId: "database-A" },
    });
});

test("middle click closes and cancels the default; other buttons do not", () => {
    const close = vi.fn();
    const ignored = {
        button: 0,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
    };
    closeOnMiddleClick(ignored, close);
    preventMiddleMouseAutoscroll(ignored);
    expect(close).not.toHaveBeenCalled();
    expect(ignored.preventDefault).not.toHaveBeenCalled();
    expect(ignored.stopPropagation).not.toHaveBeenCalled();

    const right = {
        button: 2,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
    };
    closeOnMiddleClick(right, close);
    preventMiddleMouseAutoscroll(right);
    expect(close).not.toHaveBeenCalled();
    expect(right.preventDefault).not.toHaveBeenCalled();

    const middle = {
        button: 1,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
    };
    preventMiddleMouseAutoscroll(middle);
    expect(middle.preventDefault).toHaveBeenCalledTimes(1);
    closeOnMiddleClick(middle, close);
    expect(close).toHaveBeenCalledTimes(1);
    expect(middle.preventDefault).toHaveBeenCalledTimes(2);
    expect(middle.stopPropagation).toHaveBeenCalledTimes(1);
});
