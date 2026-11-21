import { expect, test } from "vitest";
import {
    boardTabId,
    boardTabPanelId,
    isBoardsPath,
    isLibraryFamilyPath,
    returnTargetFromPath,
    temporaryPageOf,
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

test("temporary pages are derived from the route", () => {
    expect(temporaryPageOf("/settings")).toBe("settings");
    expect(temporaryPageOf("/accounts")).toBe("accounts");
    expect(temporaryPageOf("/engines")).toBe("engines");
    expect(temporaryPageOf("/library")).toBeNull();
    expect(temporaryPageOf("/")).toBeNull();
});

test("the return target is the last boards or library-family location", () => {
    expect(returnTargetFromPath("/")).toEqual({ to: "/" });
    expect(returnTargetFromPath("/library")).toEqual({ to: "/library" });
    expect(returnTargetFromPath("/databases/database-A")).toEqual({
        to: "/databases/$databaseId",
        params: { databaseId: "database-A" },
    });
});
