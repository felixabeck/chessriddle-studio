import { createStore, Provider } from "jotai";
import { act, type ComponentProps, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, test } from "vitest";
import {
    activeTabAtom,
    boardTabsHiddenFamily,
    currentBoardTabsHiddenAtom,
    disposeTabAtoms,
    tabsAtom,
} from "./atoms";
import {
    opponentPreparationAtom,
    type StoredOpponentPreparation,
    tabPreparationViewFamily,
} from "./atoms/preparation";
import {
    resolveBoardLayoutKind,
    showCurrentBoardTabs,
    useAnalysisTabLayoutKind,
} from "./boardLayoutKind";
import { boardLayoutFamily } from "./layoutStorage";
import type { BoardLayoutKind } from "./layoutPresets";
import { WorkspaceTabScope } from "./tabScope";
import type { Tab } from "./workspaceTypes";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

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

describe("useAnalysisTabLayoutKind", () => {
    let container: HTMLDivElement | null = null;
    let root: Root | null = null;

    afterEach(async () => {
        if (root) {
            const mounted = root;
            root = null;
            await act(async () => mounted.unmount());
        }
        container?.remove();
        container = null;
    });

    function mountProbe(store: ReturnType<typeof createStore>) {
        let observed: BoardLayoutKind | undefined;
        function Probe({ currentTab }: { currentTab: Tab }) {
            observed = useAnalysisTabLayoutKind(currentTab);
            return null;
        }
        const render = async (currentTab: Tab) => {
            if (!container || !root) {
                container = document.createElement("div");
                document.body.append(container);
                root = createRoot(container);
            }
            const activeRoot = root;
            await act(async () => {
                activeRoot.render(
                    createElement(
                        Provider,
                        { store },
                        createElement(
                            WorkspaceTabScope,
                            { tabId: currentTab.value } as ComponentProps<typeof WorkspaceTabScope>,
                            createElement(Probe, { currentTab }),
                        ),
                    ),
                );
            });
        };
        return { render, getKind: () => observed };
    }

    test("tracks repertoire, matching preparation, and replaced preparation inside WorkspaceTabScope", async () => {
        const store = createStore();
        const repTab = repertoireTab("rep-hook");
        const probe = mountProbe(store);

        await probe.render(repTab);
        expect(probe.getKind()).toBe("repertoire");

        await act(async () => {
            store.set(opponentPreparationAtom, fakePreparation("prep-1"));
            store.set(tabPreparationViewFamily("rep-hook"), {
                preparationId: "prep-1",
                landing: null,
                showAllLines: false,
            });
        });
        expect(probe.getKind()).toBe("preparation");

        await act(async () => {
            store.set(opponentPreparationAtom, fakePreparation("prep-2"));
        });
        expect(probe.getKind()).toBe("repertoire");

        const nonRepTab = gameTab("game-hook");
        await probe.render(nonRepTab);
        expect(probe.getKind()).toBe("game");
    });

    test("re-rendering after disposeTabAtoms creates no orphaned tabPreparationViewFamily entry", async () => {
        const store = createStore();
        const tabId = "closing-tab";
        const tab = repertoireTab(tabId);
        const probe = mountProbe(store);

        await probe.render(tab);
        expect(Array.from(tabPreparationViewFamily.getParams())).toContain(tabId);

        disposeTabAtoms(tabId);
        expect(Array.from(tabPreparationViewFamily.getParams())).not.toContain(tabId);

        // Simulate a closing-tab re-render (e.g. inside startTransition) after disposal.
        await probe.render({ ...tab, name: "Rep (closing)" });
        expect(probe.getKind()).toBe("repertoire");
        expect(Array.from(tabPreparationViewFamily.getParams())).not.toContain(tabId);
    });
});

describe("currentBoardTabsHiddenAtom and showCurrentBoardTabs", () => {
    test("the View menu flag follows the active analysis board's shown state", () => {
        const store = createStore();
        store.set(tabsAtom, [gameTab("game"), playTab("play")]);
        store.set(activeTabAtom, "game");
        expect(store.get(currentBoardTabsHiddenAtom)).toBe(false);
        store.set(boardTabsHiddenFamily("game"), true);
        expect(store.get(currentBoardTabsHiddenAtom)).toBe(true);
        store.set(activeTabAtom, "play");
        expect(store.get(currentBoardTabsHiddenAtom)).toBe(false);
        boardTabsHiddenFamily.remove("game");
    });

    test("showCurrentBoardTabs shows only the active analysis tab's kind", () => {
        localStorage.clear();
        const store = createStore();
        store.set(tabsAtom, [repertoireTab("rep"), gameTab("game"), playTab("play")]);
        store.set(boardLayoutFamily("repertoire"), (prev) => ({ ...prev, tabsHidden: true }));
        store.set(boardLayoutFamily("game"), (prev) => ({ ...prev, tabsHidden: true }));

        store.set(activeTabAtom, "play");
        showCurrentBoardTabs(store);
        expect(store.get(boardLayoutFamily("repertoire")).tabsHidden).toBe(true);
        expect(store.get(boardLayoutFamily("game")).tabsHidden).toBe(true);

        store.set(activeTabAtom, "rep");
        showCurrentBoardTabs(store);
        expect(store.get(boardLayoutFamily("repertoire")).tabsHidden).toBe(false);
        expect(store.get(boardLayoutFamily("game")).tabsHidden).toBe(true);
    });
});
