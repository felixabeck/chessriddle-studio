import { MantineProvider } from "@mantine/core";
import { INITIAL_FEN } from "chessops/fen";
import { createStore, Provider } from "jotai";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { DatabaseHandle } from "@/bindings";
import {
    localOptionsFamily,
    pinnedExplorerComparisonFamily,
    pinnedExplorerDatabaseFamily,
    pinnedExplorerFurtherColumnsFamily,
    tabFamily,
    tabsAtom,
} from "@/state/atoms";
import { createTreeStore } from "@/state/store/tree";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { databaseHandleKey } from "@/utils/db";
import { playerOpeningLine } from "./playerOpeningLine";
import { prepareOpponentOnBoard, usePrepareOpponentOnBoard } from "./prepareOpponentOnBoard";
import type { OnlineGames } from "./useOnlineGames";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
installMatchMediaStub();

const mocks = vi.hoisted(() => ({
    opponentPlayers: vi.fn(),
    createTab: vi.fn(),
    navigate: vi.fn(),
    notifyUnlessCancelled: vi.fn(),
    showNotification: vi.fn(),
}));

vi.mock("./opponentLookup", () => ({
    opponentPlayers: mocks.opponentPlayers,
}));
vi.mock("@tanstack/react-router", () => ({
    useNavigate: () => mocks.navigate,
}));
vi.mock("@mantine/notifications", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@mantine/notifications")>();
    return {
        ...actual,
        notifications: { ...actual.notifications, show: mocks.showNotification },
    };
});
vi.mock("@/components/files/notifyError", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/components/files/notifyError")>()),
    notifyUnlessCancelled: mocks.notifyUnlessCancelled,
}));
vi.mock("@/utils/tabs", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/utils/tabs")>();
    mocks.createTab.mockImplementation(actual.createTab);
    return {
        ...actual,
        createTab: mocks.createTab,
    };
});

const cardDb: DatabaseHandle = { kind: "database", id: { id: "otb-db" } };
const onlineDb: DatabaseHandle = { kind: "database", id: { id: "online-db" } };
const foundOnline: OnlineGames = {
    file: onlineDb,
    accounts: [{ provider: "lichess", username: "OpponentOnline" }],
    lookup: { kind: "found", player: 55 },
};

const t = ((key: string) => key) as never;

describe("prepareOpponentOnBoard", () => {
    let store: ReturnType<typeof createStore>;

    beforeEach(async () => {
        vi.clearAllMocks();
        localStorage.clear();
        sessionStorage.clear();
        const actual = await vi.importActual<typeof import("@/utils/tabs")>("@/utils/tabs");
        mocks.createTab.mockImplementation(actual.createTab);
        mocks.navigate.mockResolvedValue(undefined);
        mocks.opponentPlayers.mockResolvedValue([]);
        store = createStore();
    });

    test("builds explorer with comparison when online lookup is found and further reference when requested", async () => {
        const id = await prepareOpponentOnBoard({
            pin: { file: cardDb, player: 12, color: "black", startDate: "2024.11.08" },
            online: foundOnline,
            includeReference: true,
            tabName: "Carlsen, Magnus",
            setTabs: (update) => store.set(tabsAtom, update),
            atoms: store,
            navigate: mocks.navigate,
            t,
            onError: mocks.notifyUnlessCancelled,
        });

        expect(id).toBeTruthy();
        const tab = store.get(tabsAtom).find((item) => item.value === id)!;
        expect(tab.name).toBe("Carlsen, Magnus");
        expect(tab.explorer).toEqual({
            pinned: cardDb,
            comparison: { database: onlineDb, player: 55 },
            further: ["reference"],
            options: {
                player: 12,
                player_database: databaseHandleKey(cardDb),
                color: "black",
                start_date: "2024.11.08",
                result: "any",
            },
        });
        expect(store.get(pinnedExplorerDatabaseFamily(id!))).toEqual(cardDb);
        expect(store.get(pinnedExplorerComparisonFamily(id!))).toEqual({
            database: onlineDb,
            player: 55,
        });
        expect(store.get(pinnedExplorerFurtherColumnsFamily(id!))).toEqual(["reference"]);
        expect(store.get(localOptionsFamily(id!))).toMatchObject({
            player: 12,
            player_database: databaseHandleKey(cardDb),
            color: "black",
            start_date: "2024.11.08",
        });
        expect(store.get(tabFamily(id!))).toBe("database");
        expect(mocks.navigate).toHaveBeenCalledWith({ to: "/" });

        const tree = createTreeStore(id!).getState();
        expect(tree.root.fen).toBe(INITIAL_FEN);
        expect(tree.root.children).toHaveLength(0);
        expect(tree.headers.orientation).toBe("black");
    });

    test("omits comparison without online games, omits reference when false, and omits explorer without pin", async () => {
        const noOnlineId = await prepareOpponentOnBoard({
            pin: { file: cardDb, player: 12, color: "white" },
            includeReference: false,
            tabName: "No Online",
            setTabs: (update) => store.set(tabsAtom, update),
            atoms: store,
            navigate: mocks.navigate,
            t,
            onError: mocks.notifyUnlessCancelled,
        });

        const noOnlineTab = store.get(tabsAtom).find((item) => item.value === noOnlineId)!;
        expect(noOnlineTab.explorer).toEqual({
            pinned: cardDb,
            options: {
                player: 12,
                player_database: databaseHandleKey(cardDb),
                color: "white",
                result: "any",
            },
        });
        expect(store.get(pinnedExplorerComparisonFamily(noOnlineId!))).toBeNull();
        expect(store.get(pinnedExplorerFurtherColumnsFamily(noOnlineId!))).toEqual([]);
        expect(createTreeStore(noOnlineId!).getState().headers.orientation).toBe("white");

        const unpinnedId = await prepareOpponentOnBoard({
            online: foundOnline,
            includeReference: true,
            tabName: "Unpinned",
            initialTree: playerOpeningLine(["e4"], "white").tree,
            setTabs: (update) => store.set(tabsAtom, update),
            atoms: store,
            navigate: mocks.navigate,
            t,
            onError: mocks.notifyUnlessCancelled,
        });
        const unpinnedTab = store.get(tabsAtom).find((item) => item.value === unpinnedId)!;
        expect(unpinnedTab.explorer).toBeUndefined();
        expect(store.get(tabFamily(unpinnedId!))).not.toBe("database");
    });
});

describe("usePrepareOpponentOnBoard", () => {
    let container: HTMLDivElement;
    let root: Root;
    let store: ReturnType<typeof createStore>;

    beforeEach(async () => {
        vi.clearAllMocks();
        localStorage.clear();
        sessionStorage.clear();
        const actual = await vi.importActual<typeof import("@/utils/tabs")>("@/utils/tabs");
        mocks.createTab.mockImplementation(actual.createTab);
        mocks.navigate.mockResolvedValue(undefined);
        store = createStore();
        container = document.createElement("div");
        document.body.append(container);
        root = createRoot(container);
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        container.remove();
    });

    const pendingOnline: OnlineGames = {
        file: onlineDb,
        accounts: [{ provider: "lichess", username: "Pending" }],
        lookup: { kind: "pending" },
    };

    function Harness() {
        const { preparing, prepare } = usePrepareOpponentOnBoard();
        return createElement(
            "button",
            {
                type: "button",
                "data-preparing": String(preparing),
                onClick: () =>
                    void prepare({
                        pin: { file: cardDb, player: 7, color: "white" },
                        online: pendingOnline,
                        includeReference: true,
                        tabName: "Pending Player",
                    }),
            },
            "Prepare",
        );
    }

    function deferredPlayers() {
        let resolvePlayers!: (players: { id: number; name: string }[]) => void;
        mocks.opponentPlayers.mockReturnValue(
            new Promise<{ id: number; name: string }[]>((resolve) => {
                resolvePlayers = resolve;
            }),
        );
        return resolvePlayers;
    }

    test("tracks preparing true while in-flight and returns to false when resolved while mounted", async () => {
        const resolvePlayers = deferredPlayers();

        await act(async () => {
            root.render(
                createElement(
                    Provider,
                    { store },
                    createElement(MantineProvider, null, createElement(Harness)),
                ),
            );
        });

        const btn = container.querySelector("button")!;
        expect(btn.getAttribute("data-preparing")).toBe("false");
        await act(async () => btn.click());
        expect(btn.getAttribute("data-preparing")).toBe("true");
        expect(mocks.opponentPlayers).toHaveBeenCalledTimes(1);

        await act(async () => {
            resolvePlayers([{ id: 88, name: "Pending" }]);
        });

        expect(btn.getAttribute("data-preparing")).toBe("false");
        expect(mocks.createTab).toHaveBeenCalledTimes(1);
        const tabs = store.get(tabsAtom);
        expect(tabs).toHaveLength(1);
        expect(mocks.navigate).toHaveBeenCalledWith({ to: "/" });
    });

    test("unmounting while in-flight does not abort tab creation and still opens and navigates cleanly", async () => {
        const resolvePlayers = deferredPlayers();

        await act(async () => {
            root.render(
                createElement(
                    Provider,
                    { store },
                    createElement(MantineProvider, null, createElement(Harness)),
                ),
            );
        });

        const btn = container.querySelector("button")!;
        await act(async () => btn.click());
        expect(btn.getAttribute("data-preparing")).toBe("true");
        expect(mocks.opponentPlayers).toHaveBeenCalledTimes(1);

        // Unmount while the lookup and tab creation are still pending.
        await act(async () => root.unmount());

        // Resolving after unmount still creates the tab without aborting and without throwing in finally.
        await act(async () => {
            resolvePlayers([{ id: 88, name: "Pending" }]);
        });

        expect(mocks.createTab).toHaveBeenCalledWith(
            expect.not.objectContaining({ signal: expect.anything() }),
        );
        const tabs = store.get(tabsAtom);
        expect(tabs).toHaveLength(1);
        expect(tabs[0].explorer).toEqual({
            pinned: cardDb,
            comparison: { database: onlineDb, player: 88 },
            further: ["reference"],
            options: {
                player: 7,
                player_database: databaseHandleKey(cardDb),
                color: "white",
                result: "any",
            },
        });
        expect(store.get(tabFamily(tabs[0].value))).toBe("database");
        expect(mocks.navigate).toHaveBeenCalledWith({ to: "/" });

        root = createRoot(container);
    });
});
