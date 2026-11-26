import { createStore } from "jotai";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { tabFamily, tabsAtom } from "./atoms";
import {
    opponentPreparationAtom,
    type StoredOpponentPreparation,
    tabPreparationViewFamily,
} from "./atoms/preparation";
import type { BoardArrangement } from "./boardArrangement";
import { boardLayoutFamily } from "./layoutStorage";
import { selectStripTab } from "./stripTab";
import type { Tab } from "./workspaceTypes";

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

function makeRepertoireTab(id: string): Tab {
    return {
        value: id,
        name: "Rep",
        type: "analysis",
        gameOrigin: {
            kind: "file",
            gameNumber: 0,
            file: {
                type: "file",
                handle: { kind: "fileWorkspace", id: { id: "rep" } },
                name: "rep.pgn",
                numGames: 1,
                metadata: { type: "repertoire", tags: [] },
                lastModified: 0,
            },
        },
    };
}

function makeGameTab(id: string): Tab {
    return {
        value: id,
        name: "Game",
        type: "analysis",
        gameOrigin: { kind: "none" },
    };
}

afterEach(() => {
    localStorage.clear();
    for (const param of Array.from(tabPreparationViewFamily.getParams())) {
        tabPreparationViewFamily.remove(param);
    }
});

describe("selectStripTab", () => {
    let store: ReturnType<typeof createStore>;
    beforeEach(() => {
        store = createStore();
        store.set(tabsAtom, [makeGameTab("game-tab"), makeRepertoireTab("rep-tab")]);
        for (const kind of ["repertoire", "game", "preparation"] as const) {
            store.set(boardLayoutFamily(kind), {
                arrangement: withDatabaseArea,
                tabsHidden: true,
            });
        }
    });

    test("selects a tab that lives in the strip and shows the hidden strip only for that tab's kind", () => {
        selectStripTab(store, "rep-tab", "practice");
        expect(store.get(tabFamily("rep-tab"))).toBe("practice");
        expect(store.get(boardLayoutFamily("repertoire")).tabsHidden).toBe(false);
        expect(store.get(boardLayoutFamily("game")).tabsHidden).toBe(true);
        expect(store.get(boardLayoutFamily("preparation")).tabsHidden).toBe(true);
    });

    test("selects a panel shown as its own area without showing the strip", () => {
        selectStripTab(store, "game-tab", "database");
        expect(store.get(tabFamily("game-tab"))).toBe("database");
        expect(store.get(boardLayoutFamily("game")).tabsHidden).toBe(true);
    });

    test("targets the preparation kind when the tab shows the active opponent preparation", () => {
        store.set(opponentPreparationAtom, {
            id: "prep-1",
            identityKey: "k",
            cardDatabaseKey: "db",
            playerId: 1,
            opponentName: "Opp",
            opponentColor: "white",
            period: null,
            source: "otb",
            minGames: 1,
            views: { gaps: [], lines: [] } as unknown as StoredOpponentPreparation["views"],
            stats: { otb: new Map(), online: null },
            files: [],
            partial: false,
            onlineFailed: false,
        });
        store.set(tabPreparationViewFamily("rep-tab"), {
            preparationId: "prep-1",
            landing: null,
            showAllLines: false,
        });

        selectStripTab(store, "rep-tab", "practice");
        expect(store.get(boardLayoutFamily("preparation")).tabsHidden).toBe(false);
        expect(store.get(boardLayoutFamily("repertoire")).tabsHidden).toBe(true);
        expect(store.get(boardLayoutFamily("game")).tabsHidden).toBe(true);
    });
});
