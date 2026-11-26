import { createStore } from "jotai";
import { afterEach, describe, expect, test } from "vitest";
import { tabsAtom } from "./atoms";
import {
    opponentPreparationAtom,
    type StoredOpponentPreparation,
    tabPreparationViewFamily,
} from "./atoms/preparation";
import { resolveBoardLayoutKind } from "./boardLayoutKind";
import type { Tab } from "./workspaceTypes";

function repertoireTab(id: string): Tab {
    return {
        value: id,
        name: "Rep",
        type: "analysis",
        gameOrigin: {
            kind: "file",
            gameNumber: 0,
            file: {
                type: "file",
                handle: { kind: "fileWorkspace", id: { id: "rep-file" } },
                name: "rep.pgn",
                numGames: 1,
                metadata: { type: "repertoire", tags: [] },
                lastModified: 0,
            },
        },
    };
}

function gameTab(id: string): Tab {
    return {
        value: id,
        name: "Game",
        type: "analysis",
        gameOrigin: { kind: "none" },
    };
}

function playTab(id: string): Tab {
    return {
        value: id,
        name: "Play",
        type: "play",
        gameOrigin: { kind: "none" },
    };
}

function fakePreparation(id: string): StoredOpponentPreparation {
    return {
        id,
        identityKey: `key-${id}`,
        cardDatabaseKey: "db",
        playerId: 1,
        opponentName: "Opponent",
        opponentColor: "white",
        period: null,
        source: "otb",
        minGames: 1,
        views: { gaps: [], lines: [] } as unknown as StoredOpponentPreparation["views"],
        stats: { otb: new Map(), online: null },
        files: [],
        partial: false,
        onlineFailed: false,
    };
}

afterEach(() => {
    for (const param of Array.from(tabPreparationViewFamily.getParams())) {
        tabPreparationViewFamily.remove(param);
    }
});

describe("resolveBoardLayoutKind", () => {
    test("precedence: active matching preparation > repertoire > game, and stale preparation falls back to repertoire", () => {
        const store = createStore();
        store.set(tabsAtom, [repertoireTab("rep-1"), gameTab("game-1")]);

        // No preparation active: repertoire tab is repertoire, game tab is game.
        expect(resolveBoardLayoutKind(store, "rep-1")).toBe("repertoire");
        expect(resolveBoardLayoutKind(store, "game-1")).toBe("game");

        // Matching preparation view promotes the repertoire tab to preparation.
        store.set(opponentPreparationAtom, fakePreparation("prep-1"));
        store.set(tabPreparationViewFamily("rep-1"), {
            preparationId: "prep-1",
            landing: null,
            showAllLines: false,
        });
        expect(resolveBoardLayoutKind(store, "rep-1")).toBe("preparation");
        expect(resolveBoardLayoutKind(store, "game-1")).toBe("game");

        // Replacing the global preparation makes the tab's view stale -> falls back to repertoire.
        store.set(opponentPreparationAtom, fakePreparation("prep-2"));
        expect(resolveBoardLayoutKind(store, "rep-1")).toBe("repertoire");

        // Clearing the global preparation also falls back to repertoire.
        store.set(opponentPreparationAtom, null);
        expect(resolveBoardLayoutKind(store, "rep-1")).toBe("repertoire");
    });

    test("does not allocate a tabPreparationViewFamily entry for a closed or non-analysis tab", () => {
        const store = createStore();
        store.set(tabsAtom, [playTab("play-1")]);
        store.set(opponentPreparationAtom, fakePreparation("prep-1"));

        expect(resolveBoardLayoutKind(store, "closed-tab-id")).toBe("game");
        expect(resolveBoardLayoutKind(store, "play-1")).toBe("game");

        const allocated = Array.from(tabPreparationViewFamily.getParams());
        expect(allocated).not.toContain("closed-tab-id");
        expect(allocated).not.toContain("play-1");
    });
});
