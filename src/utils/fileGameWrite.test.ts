import { describe, expect, test, vi } from "vitest";
import type { FileWorkspaceHandle, WriteStamp } from "@/bindings";
import type { Tab } from "@/utils/tabs";
import {
    advanceRowsAfterTagWrite,
    certainWriteIdentity,
    fileGameHasBlockingOpenTab,
} from "./fileGameWrite";

const mocks = vi.hoisted(() => ({
    scanBlockingTabs: vi.fn(),
    isTabOfFileGame: vi.fn(),
}));

vi.mock("@/state/quitGate", () => ({ scanBlockingTabs: mocks.scanBlockingTabs }));
vi.mock("@/utils/tabs", async (original) => ({
    ...(await original<typeof import("@/utils/tabs")>()),
    isTabOfFileGame: mocks.isTabOfFileGame,
}));

const handle: FileWorkspaceHandle = { id: { id: "file" }, kind: "fileWorkspace" };

function tab(gameNumber: number): Tab {
    return {
        value: `tab-${gameNumber}`,
        name: "Game",
        type: "analysis",
        gameOrigin: { kind: "file", file: { handle }, gameNumber },
    } as Tab;
}

describe("fileGameHasBlockingOpenTab", () => {
    test("refuses when a blocking tab belongs to this file game", () => {
        const line = tab(3);
        const other = tab(4);
        mocks.isTabOfFileGame.mockImplementation(
            (candidate: Tab, file: FileWorkspaceHandle, gameNumber: number) =>
                candidate === line && file === handle && gameNumber === 3,
        );
        mocks.scanBlockingTabs.mockReturnValue([{ value: line.value }]);
        expect(fileGameHasBlockingOpenTab([line, other], handle, 3)).toBe(true);
        expect(mocks.scanBlockingTabs).toHaveBeenCalledExactlyOnceWith([line]);
    });

    test("allows a clean open tab of this game", () => {
        const line = tab(3);
        mocks.isTabOfFileGame.mockReturnValue(true);
        mocks.scanBlockingTabs.mockReturnValue([]);
        expect(fileGameHasBlockingOpenTab([line], handle, 3)).toBe(false);
    });
});

describe("certainWriteIdentity", () => {
    test("requires both stamp and revision", () => {
        expect(certainWriteIdentity({ stamp: "s2", revision: "r2" } as WriteStamp)).toEqual({
            stamp: "s2",
            revision: "r2",
        });
        expect(certainWriteIdentity({ stamp: null, revision: "r2" } as WriteStamp)).toBeNull();
        expect(certainWriteIdentity({ stamp: "s2", revision: null } as WriteStamp)).toBeNull();
    });
});

describe("advanceRowsAfterTagWrite", () => {
    test("updates the edited row and advances siblings read at the same revision", () => {
        const rows = new Map([
            [0, { name: "First", identity: { stamp: "s0", revision: "r1" } }],
            [1, { name: "Second", section: "old", identity: { stamp: "s1", revision: "r1" } }],
            [2, { name: "Older", identity: { stamp: "s2", revision: "r0" } }],
        ]);
        const next = advanceRowsAfterTagWrite(
            rows,
            1,
            { stamp: "s9", revision: "r2" },
            "r1",
            (row) => ({ ...row, section: "Neu" }),
        );
        expect(next.get(1)).toEqual({
            name: "Second",
            section: "Neu",
            identity: { stamp: "s9", revision: "r2" },
        });
        expect(next.get(0)?.identity).toEqual({ stamp: "s0", revision: "r2" });
        expect(next.get(2)?.identity).toEqual({ stamp: "s2", revision: "r0" });
    });
});
