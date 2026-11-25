import { createStore } from "jotai";
import type { ScopedMutator } from "swr";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { DatabaseHandle, ErrorPayload } from "@/bindings";
import { opponentLinksAtom, pendingPlayerCardAtom } from "@/state/atoms";
import { defaultOpponentFilter, type OpponentLink } from "@/state/opponentLinks";
import { activeDatabaseViewStore } from "@/state/store/database";
import { catalogueI18n } from "@/tests/catalogues";
import type { DatabaseList, SuccessDatabaseInfo } from "@/utils/db";
import type { DatabaseRouteTarget } from "./databaseRoute";

const mocks = vi.hoisted(() => ({
    publishDatabaseList: vi.fn(),
    opponentPlayers: vi.fn(),
    notify: vi.fn(),
    notifyError: vi.fn(),
    warn: vi.fn(),
    translate: (key: string, options?: Record<string, unknown>) =>
        String(options?.defaultValue ?? key),
}));

vi.mock("@/hooks/useDatabaseList", () => ({
    publishDatabaseList: mocks.publishDatabaseList,
}));
vi.mock("./opponentLookup", () => ({
    opponentPlayers: mocks.opponentPlayers,
}));
vi.mock("@mantine/notifications", () => ({
    notifications: { show: mocks.notify },
}));
vi.mock("@/components/files/notifyError", () => ({
    notifyUnlessCancelled: mocks.notifyError,
}));
vi.mock("@/platform/errors", async (original) => ({
    ...(await original<typeof import("@/platform/errors")>()),
    warnSafely: mocks.warn,
}));
vi.mock("@/i18n", async (original) => ({
    ...(await original<typeof import("@/i18n")>()),
    default: {
        t: (key: string, options?: Record<string, unknown>) => mocks.translate(key, options),
    },
}));

import { openOpponentCard } from "./openOpponentCard";

const ID = "11111111-1111-4111-8111-111111111111";
const DATABASE = `opponent-${ID}-0a1b2c3d.db3`;
const FILE: DatabaseHandle = { id: { id: "opponent-db-1" }, kind: "database" };
const ACCOUNT = { provider: "lichess", username: "DrNykterstein" } as const;

const DATABASE_INFO: SuccessDatabaseInfo = {
    type: "success",
    file: FILE,
    filename: DATABASE,
    title: "DrNykterstein (online)",
    description: "",
    player_count: 2,
    event_count: 1,
    game_count: 12,
    storage_size: "1024",
    indexed: false,
};

function makeLink(overrides: Partial<OpponentLink> = {}): OpponentLink {
    return {
        id: ID,
        playerName: "DrNykterstein",
        accounts: [ACCOUNT],
        filter: defaultOpponentFilter(),
        database: DATABASE,
        ...overrides,
    };
}

let store: ReturnType<typeof createStore>;
let navigate: ReturnType<typeof vi.fn<(target: DatabaseRouteTarget) => unknown>>;
let mutateCache: ScopedMutator;

beforeEach(async () => {
    vi.clearAllMocks();
    const i18n = await catalogueI18n("en-US");
    mocks.translate = (key, options) => i18n.t(key, options);
    localStorage.clear();
    sessionStorage.clear();
    activeDatabaseViewStore.getState().clearDatabase();
    store = createStore();
    navigate = vi.fn<(target: DatabaseRouteTarget) => unknown>();
    mutateCache = vi.fn() as unknown as ScopedMutator;
    store.set(opponentLinksAtom, [makeLink()]);
    mocks.publishDatabaseList.mockResolvedValue({
        databases: [DATABASE_INFO],
        unread: [],
        workspaceFilenames: [DATABASE],
        root: { id: { id: "root-1" }, kind: "databaseRoot" },
    } satisfies DatabaseList);
    mocks.opponentPlayers.mockResolvedValue([{ id: 42, name: "DrNykterstein" }]);
});

afterEach(() => {
    activeDatabaseViewStore.getState().clearDatabase();
});

describe("openOpponentCard", () => {
    test("sets pendingPlayerCardAtom and navigates without writing activeDatabaseViewStore", async () => {
        const onStoreChange = vi.fn();
        const unsubscribe = activeDatabaseViewStore.subscribe(onStoreChange);
        try {
            const opened = await openOpponentCard(store, navigate, mutateCache, ID);

            expect(opened).toBe(true);
            expect(mocks.publishDatabaseList).toHaveBeenCalledExactlyOnceWith(mutateCache);
            expect(mocks.opponentPlayers).toHaveBeenCalledExactlyOnceWith(FILE, [ACCOUNT]);
            expect(store.get(pendingPlayerCardAtom)).toEqual({
                database: "opponent-db-1",
                playerId: 42,
                playerName: "DrNykterstein",
            });
            expect(navigate).toHaveBeenCalledExactlyOnceWith({
                to: "/databases/$databaseId",
                params: { databaseId: "opponent-db-1" },
            });
            expect(onStoreChange).not.toHaveBeenCalled();
            expect(activeDatabaseViewStore.getState().database).toBeUndefined();
            expect(mocks.notify).not.toHaveBeenCalled();
            expect(mocks.notifyError).not.toHaveBeenCalled();
        } finally {
            unsubscribe();
        }
    });

    test("reports a failing listing and sets nothing and does not navigate", async () => {
        const error = new Error("listing failed");
        mocks.publishDatabaseList.mockRejectedValue(error);

        const opened = await openOpponentCard(store, navigate, mutateCache, ID);

        expect(opened).toBe(false);
        expect(mocks.notifyError).toHaveBeenCalledExactlyOnceWith("Error", error, "database");
        expect(mocks.notify).not.toHaveBeenCalled();
        expect(store.get(pendingPlayerCardAtom)).toBeNull();
        expect(navigate).not.toHaveBeenCalled();
    });

    test("a cancelled listing is silent, sets nothing and does not navigate", async () => {
        const cancelled: ErrorPayload = {
            tag: "backend-error",
            category: "cancellation",
            message: "Cancellation",
        };
        mocks.publishDatabaseList.mockRejectedValue(cancelled);
        // Real notifyUnlessCancelled suppresses cancellations; verify it was delegated with the error.
        mocks.notifyError.mockImplementation(() => {});

        const opened = await openOpponentCard(store, navigate, mutateCache, ID);

        expect(opened).toBe(false);
        expect(mocks.notifyError).toHaveBeenCalledExactlyOnceWith("Error", cancelled, "database");
        expect(mocks.notify).not.toHaveBeenCalled();
        expect(store.get(pendingPlayerCardAtom)).toBeNull();
        expect(navigate).not.toHaveBeenCalled();
    });

    test.each([
        ["unknown link", [], { databases: [DATABASE_INFO], unread: [] }],
        [
            "link without database",
            [makeLink({ database: undefined })],
            { databases: [DATABASE_INFO], unread: [] },
        ],
        ["missing database", [makeLink()], { databases: [], unread: [] }],
        [
            "unread database",
            [makeLink()],
            { databases: [], unread: [{ filename: DATABASE, error: "permission denied" }] },
        ],
        [
            "unreadable database",
            [makeLink()],
            {
                databases: [
                    {
                        type: "error" as const,
                        file: FILE,
                        filename: DATABASE,
                        indexed: false,
                        error: "corrupt",
                    },
                ],
                unread: [],
            },
        ],
    ])("reports OnlineUnavailable for %s and opens nothing", async (_label, links, listing) => {
        store.set(opponentLinksAtom, links);
        mocks.publishDatabaseList.mockResolvedValue(listing);

        const opened = await openOpponentCard(store, navigate, mutateCache, ID);

        expect(opened).toBe(false);
        expect(mocks.notify).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
                color: "danger",
                title: "Error",
                message: "The online games could not be read.",
            }),
        );
        expect(mocks.opponentPlayers).not.toHaveBeenCalled();
        expect(store.get(pendingPlayerCardAtom)).toBeNull();
        expect(navigate).not.toHaveBeenCalled();
    });

    test("logs and reports OnlineUnavailable when player lookup fails", async () => {
        mocks.opponentPlayers.mockRejectedValue(new Error("unable to open /private/opponent.db3"));

        const opened = await openOpponentCard(store, navigate, mutateCache, ID);

        expect(opened).toBe(false);
        expect(mocks.warn).toHaveBeenCalledOnce();
        expect(mocks.warn.mock.calls[0][0]).toMatch(
            /^The players of an opponent's online games could not be read: /,
        );
        expect(mocks.warn.mock.calls[0][0]).not.toContain("/private/opponent.db3");
        expect(mocks.notify).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
                color: "danger",
                title: "Error",
                message: "The online games could not be read.",
            }),
        );
        expect(store.get(pendingPlayerCardAtom)).toBeNull();
        expect(navigate).not.toHaveBeenCalled();
    });

    test("reports OnlineUnavailable when player lookup returns no players", async () => {
        mocks.opponentPlayers.mockResolvedValue([]);

        const opened = await openOpponentCard(store, navigate, mutateCache, ID);

        expect(opened).toBe(false);
        expect(mocks.warn).not.toHaveBeenCalled();
        expect(mocks.notify).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
                color: "danger",
                title: "Error",
                message: "The online games could not be read.",
            }),
        );
        expect(store.get(pendingPlayerCardAtom)).toBeNull();
        expect(navigate).not.toHaveBeenCalled();
    });

    test("is silent when player lookup is cancelled", async () => {
        mocks.opponentPlayers.mockRejectedValue({
            tag: "backend-error",
            category: "cancellation",
            message: "Cancellation",
        } satisfies ErrorPayload);

        const opened = await openOpponentCard(store, navigate, mutateCache, ID);

        expect(opened).toBe(false);
        expect(mocks.warn).not.toHaveBeenCalled();
        expect(mocks.notify).not.toHaveBeenCalled();
        expect(mocks.notifyError).not.toHaveBeenCalled();
        expect(store.get(pendingPlayerCardAtom)).toBeNull();
        expect(navigate).not.toHaveBeenCalled();
    });
});
