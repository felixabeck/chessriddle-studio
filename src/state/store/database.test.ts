import { afterEach, describe, expect, it, vi } from "vitest";
import { databaseRouteTarget, resolveDatabaseRoute } from "@/components/databases/databaseRoute";
import type { SuccessDatabaseInfo } from "@/utils/db";
import { formatBytes } from "@/utils/format";

vi.mock("@/i18n", () => ({
    default: { t: (key: string) => `translated:${key}` },
}));

import { activeDatabaseViewStore, type DatabaseViewStore } from "./database";
import { deserializeStorageValue } from "./debouncedStorage";
import { storageErrorCause } from "@/state/storageError";

const persistError = vi.hoisted(() => ({ report: vi.fn() }));
vi.mock("@/state/persistError", () => ({ reportPersistError: persistError.report }));

afterEach(() => {
    vi.restoreAllMocks();
    activeDatabaseViewStore.getState().clearDatabase();
    sessionStorage.clear();
});

const selectedDatabase = {
    type: "success",
    file: { id: { id: "selected" }, kind: "database" },
    title: "Selected database",
    filename: "selected.db3",
    description: "Stored metadata",
    player_count: 1,
    event_count: 2,
    game_count: 3,
    // Legacy persisted metadata supplies identity even while its size is still numeric.
    storage_size: 0,
    indexed: true,
};

async function hydrate(state?: unknown) {
    sessionStorage.clear();
    if (state !== undefined) {
        // Legacy plain JSON remains a supported hydration input.
        sessionStorage.setItem("database-view", JSON.stringify({ state, version: 0 }));
    }
    vi.resetModules();
    return (await import("./database")).activeDatabaseViewStore;
}

describe("database-view sessionStorage hydration", () => {
    it("round trips the games player sort through validated session storage", async () => {
        const store = await hydrate({ database: selectedDatabase });
        store.getState().setPlayersQuery({
            ...store.getState().players.query,
            options: {
                ...store.getState().players.query.options,
                sort: "games",
                direction: "asc",
            },
        });
        const persisted = sessionStorage.getItem("database-view")!;
        const next = await hydrate();
        sessionStorage.setItem("database-view", persisted);
        await next.persist.rehydrate();
        expect(next.getState().players.query.options.sort).toBe("games");
        expect(next.getState().players.query.options.direction).toBe("asc");
    });
    it("retains legacy numeric selection identity while displaying fresh exact listing metadata", async () => {
        const store = await hydrate({ database: selectedDatabase });
        expect(store.getState().database).toEqual(selectedDatabase);
        const fresh: SuccessDatabaseInfo = {
            ...selectedDatabase,
            type: "success",
            file: { id: { id: "selected" }, kind: "database" },
            title: "Fresh native metadata",
            storage_size: "9007199254740993",
        };
        const route = resolveDatabaseRoute([fresh], "selected", store.getState().database);
        expect(route).toEqual({ status: "ready", database: fresh });
        if (route.status !== "ready") throw new Error("expected ready legacy identity");
        expect(route.database).toBe(fresh);
        expect(formatBytes(route.database.storage_size)).toBe("8192 TB");
        expect(store.getState().database).toEqual(selectedDatabase);
    });

    it.each([
        null,
        {},
        { file: {} },
        { ...selectedDatabase, type: "error" },
        { ...selectedDatabase, file: "legacy.db3" },
        { ...selectedDatabase, file: { id: "legacy", kind: "database" } },
        { ...selectedDatabase, file: { id: {}, kind: "database" } },
        { ...selectedDatabase, file: { id: { id: "" }, kind: "database" } },
        { ...selectedDatabase, file: { id: { id: 7 }, kind: "database" } },
        { ...selectedDatabase, file: { id: { id: "selected" }, kind: "fileWorkspace" } },
    ])("drops the malformed selection %j at hydration", async (database) => {
        const store = await hydrate({ database, setDatabase: "persisted action" });
        expect(store.persist.hasHydrated()).toBe(true);
        expect(store.getState().database).toBeUndefined();
        expect(databaseRouteTarget(store.getState().database)).toEqual({ to: "/library" });
        expect(() => resolveDatabaseRoute([], "selected", store.getState().database)).not.toThrow();
        store.getState().setGamesSelectedGameId(42);
        store.getState().clearDatabase();
        expect(store.getState().games.selectedGameId).toBeUndefined();
    });

    it.each([undefined, null, {}, { database: { file: "old.db3" } }])(
        "preserves live defaults and actions for absent or older state %j",
        async (state) => {
            const store = await hydrate(state);
            expect(store.getState()).toMatchObject({
                activeTab: "games",
                games: { isFilterExpanded: false, query: { options: { page: 1 } } },
                players: { activeTab: "overview" },
                tournaments: { activeTab: "games" },
            });
            expect(store.getState().database).toBeUndefined();
            const actions = Object.entries(store.getInitialState()).filter(
                ([, value]) => typeof value === "function",
            );
            for (const [key, action] of actions) {
                expect(store.getState()[key as keyof DatabaseViewStore]).toBe(action);
            }
        },
    );

    it("preserves a valid selection, result selections and live actions", async () => {
        const initial = activeDatabaseViewStore.getInitialState();
        const store = await hydrate({
            database: selectedDatabase,
            activeTab: "players",
            games: { ...initial.games, selectedGameId: 42 },
            players: { ...initial.players, selectedPlayer: 7 },
            tournaments: { ...initial.tournaments, selectedTournament: 9 },
            clearDatabase: null,
            setGamesQuery: "stored action",
        });
        expect(store.getState().database).toEqual(selectedDatabase);
        expect(store.getState()).toMatchObject({
            activeTab: "players",
            games: { selectedGameId: 42 },
            players: { selectedPlayer: 7 },
            tournaments: { selectedTournament: 9 },
        });
        expect(databaseRouteTarget(store.getState().database)).toEqual({
            to: "/databases/$databaseId",
            params: { databaseId: "selected" },
        });
        store.getState().setGamesQuery(initial.games.query);
        expect(store.getState().games.selectedGameId).toBeUndefined();
        store.getState().clearDatabase();
        expect(store.getState().database).toBeUndefined();
    });
});

describe("database-view durable admission", () => {
    const database: SuccessDatabaseInfo = {
        ...selectedDatabase,
        type: "success",
        file: { id: { id: "selected" }, kind: "database" },
        storage_size: "9007199254740993",
    };
    const mutations: [string, (store: typeof activeDatabaseViewStore) => boolean][] = [
        ["setDatabase", (store) => store.getState().setDatabase({ ...database, title: "Next" })],
        ["clearDatabase", (store) => store.getState().clearDatabase()],
        ["setActiveTab", (store) => store.getState().setActiveTab("players")],
        [
            "setGamesQuery",
            (store) =>
                store.getState().setGamesQuery({ ...store.getState().games.query, player1: 7 }),
        ],
        ["setGamesSelectedGameId", (store) => store.getState().setGamesSelectedGameId(43)],
        ["toggleGamesOpenedSettings", (store) => store.getState().toggleGamesOpenedSettings()],
        [
            "setPlayersQuery",
            (store) =>
                store
                    .getState()
                    .setPlayersQuery({ ...store.getState().players.query, name: "Next" }),
        ],
        ["setPlayersSelectedPlayer", (store) => store.getState().setPlayersSelectedPlayer(8)],
        ["setPlayersActiveTab", (store) => store.getState().setPlayersActiveTab("ratings")],
        [
            "setTournamentsQuery",
            (store) =>
                store
                    .getState()
                    .setTournamentsQuery({ ...store.getState().tournaments.query, name: "Next" }),
        ],
        [
            "setTournamentsSelectedTournament",
            (store) => store.getState().setTournamentsSelectedTournament(10),
        ],
        [
            "setTournamentsActiveTab",
            (store) => store.getState().setTournamentsActiveTab("leaderboard"),
        ],
        ["setState partial", (store) => store.setState({ activeTab: "players" })],
        [
            "setState function",
            (store) =>
                store.setState((state) => ({ games: { ...state.games, selectedGameId: 43 } })),
        ],
        [
            "setState replace",
            (store) => store.setState({ ...store.getState(), activeTab: "players" }, true),
        ],
        [
            "setState function replace",
            (store) => store.setState((state) => ({ ...state, activeTab: "players" }), true),
        ],
    ];

    it.each(mutations)(
        "refuses %s before publishing, then admits the same retry and reloads",
        async (_name, mutate) => {
            persistError.report.mockClear();
            const initial = activeDatabaseViewStore.getInitialState();
            const previous = {
                ...initial,
                database,
                games: { ...initial.games, selectedGameId: 42 },
                players: { ...initial.players, selectedPlayer: 7 },
                tournaments: { ...initial.tournaments, selectedTournament: 9 },
            };
            const store = await hydrate(previous);
            const before = store.getState();
            const seeded = sessionStorage.getItem("database-view");
            const treeKey = "11111111-1111-4111-8111-111111111111";
            const treeBytes = "unrelated tab-tree bytes";
            sessionStorage.setItem(treeKey, treeBytes);
            const subscriber = vi.fn();
            const unsubscribe = store.subscribe(subscriber);
            const cause = new DOMException("quota", "QuotaExceededError");
            const nativeSetItem = Storage.prototype.setItem;
            const refused = vi.fn(() => {
                expect(store.getState()).toBe(before);
                expect(subscriber).not.toHaveBeenCalled();
                expect(sessionStorage.getItem("database-view")).toBe(seeded);
                throw cause;
            });
            const setItem = vi
                .spyOn(Storage.prototype, "setItem")
                .mockImplementation(function (this: Storage, key, value) {
                    if (this === sessionStorage && key === "database-view") return refused();
                    return nativeSetItem.call(this, key, value);
                });
            try {
                expect(mutate(store)).toBe(false);
                expect(refused).toHaveBeenCalledOnce();
                expect(store.getState()).toBe(before);
                expect(sessionStorage.getItem("database-view")).toBe(seeded);
                expect(sessionStorage.getItem(treeKey)).toBe(treeBytes);
                expect(subscriber).not.toHaveBeenCalled();
                expect(persistError.report).toHaveBeenCalledExactlyOnceWith(
                    expect.objectContaining({ message: storageErrorCause(cause), cause }),
                );

                vi.resetModules();
                const refusedReload = (await import("./database")).activeDatabaseViewStore;
                expect(JSON.parse(JSON.stringify(refusedReload.getState()))).toEqual(
                    JSON.parse(JSON.stringify(before)),
                );
                expect(refused).toHaveBeenCalledOnce();
                expect(sessionStorage.getItem("database-view")).toBe(seeded);
            } finally {
                setItem.mockRestore();
                unsubscribe();
            }

            const published = vi.fn((state: DatabaseViewStore) => {
                expect(deserializeStorageValue(sessionStorage.getItem("database-view")!)).toEqual({
                    state: JSON.parse(JSON.stringify(state)),
                    version: 0,
                });
            });
            const stop = store.subscribe(published);
            try {
                expect(mutate(store)).toBe(true);
                expect(published).toHaveBeenCalledOnce();
            } finally {
                stop();
            }
            const stored = sessionStorage.getItem("database-view")!;
            const envelope = { state: JSON.parse(JSON.stringify(store.getState())), version: 0 };
            expect(deserializeStorageValue(stored)).toEqual(envelope);
            expect(stored).not.toBe(JSON.stringify(envelope));
            expect(sessionStorage.getItem(treeKey)).toBe(treeBytes);
            expect(persistError.report).toHaveBeenCalledOnce();

            vi.resetModules();
            const reloaded = (await import("./database")).activeDatabaseViewStore;
            expect(reloaded.persist.hasHydrated()).toBe(true);
            expect(JSON.parse(JSON.stringify(reloaded.getState()))).toEqual(envelope.state);
            expect(sessionStorage.getItem("database-view")).toBe(stored);
            expect(sessionStorage.getItem(treeKey)).toBe(treeBytes);
        },
    );

    it("preserves replacement and identity semantics of public setState", async () => {
        const store = await hydrate();
        const before = store.getState();
        const subscriber = vi.fn();
        const unsubscribe = store.subscribe(subscriber);
        expect(store.setState((state) => state)).toBe(true);
        expect(store.getState()).toBe(before);
        expect(subscriber).not.toHaveBeenCalled();
        const replacement = { ...before, activeTab: "players" as const };
        expect(store.setState(replacement, true)).toBe(true);
        expect(store.getState()).toBe(replacement);
        unsubscribe();
    });

    it("does not report a subscriber throw after a successful write as a refusal", async () => {
        persistError.report.mockClear();
        const store = await hydrate();
        const failure = new Error("subscriber failed");
        const unsubscribe = store.subscribe(() => {
            throw failure;
        });
        try {
            expect(() => store.getState().setDatabase(database)).toThrow(failure);
            expect(store.getState().database).toEqual(database);
            expect(
                deserializeStorageValue<{ state: DatabaseViewStore }>(
                    sessionStorage.getItem("database-view")!,
                )?.state.database,
            ).toEqual(database);
            expect(persistError.report).not.toHaveBeenCalled();
        } finally {
            unsubscribe();
        }
    });
});

const defaults = activeDatabaseViewStore.getInitialState();
const validGames = {
    isFilterExpanded: true,
    selectedGameId: 42,
    query: {
        ...defaults.games.query,
        player1: 7,
        player2: null,
        playerName: "Carlsen",
        tournamentId: -2,
        range1: [-100, 3500],
        range2: [2500, 1000],
        sides: "Any",
        outcome: "*",
        startDate: "2020.01.01",
        endDate: null,
        options: {
            skipCount: true,
            page: 2_147_483_647,
            pageSize: 1000,
            sort: "blackElo",
            direction: "asc",
        },
    },
};
const validPlayers = {
    activeTab: "ratings",
    selectedPlayer: -7,
    query: {
        name: "Carlsen",
        range: [3500, -100],
        options: { skipCount: false, page: null, pageSize: null, sort: "elo", direction: "asc" },
    },
};
const validTournaments = {
    activeTab: "leaderboard",
    selectedTournament: 9,
    query: { name: null, options: { skipCount: true, sort: "name", direction: "asc" } },
};

describe("database-view panel hydration", () => {
    it("migrates legacy game query filters and the plies sort", async () => {
        const { tournamentId, startDate, endDate, ...query } = validGames.query;
        const store = await hydrate({
            games: {
                ...validGames,
                query: {
                    ...query,
                    tournament_id: tournamentId,
                    start_date: startDate,
                    end_date: endDate,
                    wanted_result: "0-1",
                    exclude_fast_events: true,
                    position: { fen: "legacy", type_: "partial" },
                    options: { ...query.options, sort: "ply_count" },
                },
            },
        });
        expect(store.getState().games).toEqual({
            ...validGames,
            query: { ...validGames.query, options: { ...query.options, sort: "plyCount" } },
        });
    });

    it("prefers current game query keys over legacy keys, including null", async () => {
        const store = await hydrate({
            games: {
                ...validGames,
                query: {
                    ...validGames.query,
                    tournament_id: 123,
                    start_date: "1990.01.01",
                    end_date: "1999.12.31",
                    wanted_result: "1-0",
                    exclude_fast_events: false,
                },
            },
        });
        expect(store.getState().games).toEqual(validGames);
    });

    it("round trips current game query keys and the plies sort", async () => {
        const games = {
            ...validGames,
            query: {
                ...validGames.query,
                options: { ...validGames.query.options, sort: "plyCount" },
            },
        };
        const store = await hydrate({ games });
        expect(store.getState().games).toEqual(games);
        store.getState().toggleGamesOpenedSettings();
        store.getState().toggleGamesOpenedSettings();
        const persisted = sessionStorage.getItem("database-view")!;
        const next = await hydrate();
        sessionStorage.setItem("database-view", persisted);
        await next.persist.rehydrate();
        expect(next.getState().games).toEqual(games);
    });

    it("drops a legacy game row index while preserving the rest of the games state", async () => {
        const games = { ...validGames, selectedGameId: undefined };
        const store = await hydrate({ games: { ...games, selectedGame: 0 } });
        expect(store.getState().games).toEqual(games);
        expect(store.getState().games).not.toHaveProperty("selectedGame");
    });

    it.each([-2_147_483_648, -1, 0, 2_147_483_647])(
        "preserves the signed game record ID %s",
        async (selectedGameId) => {
            const games = { ...validGames, selectedGameId };
            const store = await hydrate({ games });
            expect(store.getState().games).toEqual(games);
        },
    );

    it.each(["id", "date", "whiteElo", "blackElo", "plyCount"])(
        "preserves the supported game sort %s",
        async (sort) => {
            const games = {
                ...validGames,
                selectedGameId: 0,
                query: {
                    ...validGames.query,
                    options: { ...validGames.query.options, page: 1, pageSize: 1, sort },
                },
            };
            const store = await hydrate({ games });
            expect(store.getState().games).toEqual(games);
        },
    );

    it.each(["name", "elo", "games"])("preserves the supported player sort %s", async (sort) => {
        const players = {
            ...validPlayers,
            activeTab: "openings",
            query: { ...validPlayers.query, options: { ...validPlayers.query.options, sort } },
        };
        const store = await hydrate({ players });
        expect(store.getState().players).toEqual(players);
    });

    it("falls back from the retired player ID sort to name descending independently", async () => {
        const store = await hydrate({
            games: validGames,
            players: {
                ...validPlayers,
                query: {
                    ...validPlayers.query,
                    options: { ...validPlayers.query.options, sort: "id" },
                },
            },
            tournaments: validTournaments,
        });
        expect(store.getState().players).toEqual(store.getInitialState().players);
        expect(store.getState().players.query.options).toMatchObject({
            sort: "name",
            direction: "desc",
        });
        expect(store.getState().games).toEqual(validGames);
        expect(store.getState().tournaments).toEqual(validTournaments);
    });

    it.each(["name", "date", "players", "games", "avgElo"])(
        "preserves the supported tournament sort %s",
        async (sort) => {
            const tournaments = {
                ...validTournaments,
                query: {
                    ...validTournaments.query,
                    options: { ...validTournaments.query.options, sort },
                },
            };
            const store = await hydrate({ tournaments });
            expect(store.getState().tournaments).toEqual(tournaments);
        },
    );

    it("falls back from the retired ID sort to date descending independently", async () => {
        const store = await hydrate({
            games: validGames,
            players: validPlayers,
            tournaments: {
                ...validTournaments,
                query: {
                    ...validTournaments.query,
                    options: { ...validTournaments.query.options, sort: "id" },
                },
            },
        });
        expect(store.getState().tournaments).toEqual(store.getInitialState().tournaments);
        expect(store.getState().tournaments.query.options).toMatchObject({
            sort: "date",
            direction: "desc",
        });
        expect(store.getState().games).toEqual(validGames);
        expect(store.getState().players).toEqual(validPlayers);
    });

    it.each(["BlackWhite", "WhiteBlack", "Any"])(
        "preserves the supported side %s",
        async (sides) => {
            const games = {
                ...validGames,
                query: {
                    ...validGames.query,
                    sides,
                    player1: -2_147_483_648,
                    player2: 2_147_483_647,
                },
            };
            const store = await hydrate({ games });
            expect(store.getState().games).toEqual(games);
        },
    );

    it("discards obsolete search filters without losing valid list filters", async () => {
        const store = await hydrate({
            games: {
                ...validGames,
                query: {
                    ...validGames.query,
                    position: "obsolete",
                    wantedResult: [],
                    excludeFastEvents: "obsolete",
                    includeUnknownResults: true,
                    sampleOrder: "date",
                    wanted_result: "draw",
                    exclude_fast_events: true,
                },
            },
        });
        expect(store.getState().games).toEqual(validGames);
    });

    it("preserves supported filters, nulls, selections, backend bounds and the ratings tab", async () => {
        const store = await hydrate({
            database: selectedDatabase,
            activeTab: "tournaments",
            games: validGames,
            players: validPlayers,
            tournaments: validTournaments,
        });
        expect(store.getState()).toMatchObject({
            database: selectedDatabase,
            activeTab: "tournaments",
            games: validGames,
            players: validPlayers,
            tournaments: validTournaments,
        });
        const actions = Object.entries(store.getInitialState()).filter(
            ([, value]) => typeof value === "function",
        );
        for (const [key, action] of actions)
            expect(store.getState()[key as keyof DatabaseViewStore]).toBe(action);
    });

    it.each([
        undefined,
        null,
        {},
        { isFilterExpanded: true },
        { ...validGames, query: null },
        { ...validGames, query: 7 },
        { ...validGames, query: "query" },
        { ...validGames, query: [] },
    ])("resets incomplete games %j while the matching route remains ready", async (games) => {
        const store = await hydrate({
            database: selectedDatabase,
            games,
            players: validPlayers,
            tournaments: validTournaments,
        });
        expect(store.getState().games).toEqual(store.getInitialState().games);
        expect(store.getState().players).toEqual(validPlayers);
        expect(store.getState().tournaments).toEqual(validTournaments);
        expect(
            resolveDatabaseRoute(
                [store.getState().database!],
                "selected",
                store.getState().database,
            ),
        ).toMatchObject({ status: "ready" });
    });

    it.each([
        { options: undefined },
        { options: null },
        { options: {} },
        { options: "options" },
        { options: [] },
        { options: { ...validGames.query.options, skipCount: "false" } },
        { options: { ...validGames.query.options, sort: "name" } },
        { options: { ...validGames.query.options, direction: "ascending" } },
        { options: { ...validGames.query.options, page: 0 } },
        { options: { ...validGames.query.options, page: 2_147_483_648 } },
        { options: { ...validGames.query.options, pageSize: 0 } },
        { options: { ...validGames.query.options, pageSize: 1001 } },
        { options: { ...validGames.query.options, pageSize: 1.5 } },
        { player1: "7" },
        { player2: 1.5 },
        { playerName: 7 },
        { tournamentId: -2_147_483_649 },
        { range1: [1000] },
        { range2: [0, 3000, 3500] },
        { range1: [0, "3000"] },
        { range1: [0, 2_147_483_648] },
        { sides: undefined },
        { sides: null },
        { sides: "Both" },
        { outcome: {} },
        { startDate: 2020 },
        { endDate: false },
    ])("rejects malformed game query fields %j", async (fields) => {
        const store = await hydrate({
            games: { ...validGames, query: { ...validGames.query, ...fields } },
            players: validPlayers,
        });
        expect(store.getState().games).toEqual(store.getInitialState().games);
        expect(store.getState().players).toEqual(validPlayers);
    });

    it.each([{ isFilterExpanded: "true" }, { selectedGameId: "42" }, { selectedGameId: 0.5 }])(
        "rejects malformed games panel fields %j",
        async (fields) => {
            const store = await hydrate({ games: { ...validGames, ...fields } });
            expect(store.getState().games).toEqual(store.getInitialState().games);
        },
    );

    it.each([
        undefined,
        null,
        {},
        { ...validPlayers, activeTab: "games" },
        { ...validPlayers, selectedPlayer: "7" },
        { ...validPlayers, query: null },
        { ...validPlayers, query: {} },
        { ...validPlayers, query: { ...validPlayers.query, name: 7 } },
        { ...validPlayers, query: { ...validPlayers.query, range: [0, 1.5] } },
        { ...validPlayers, query: { ...validPlayers.query, options: null } },
        {
            ...validPlayers,
            query: {
                ...validPlayers.query,
                options: { ...validPlayers.query.options, sort: "date" },
            },
        },
        {
            ...validPlayers,
            query: {
                ...validPlayers.query,
                options: { ...validPlayers.query.options, direction: 7 },
            },
        },
        {
            ...validPlayers,
            query: {
                ...validPlayers.query,
                options: { ...validPlayers.query.options, pageSize: -1 },
            },
        },
    ])("resets malformed players %j independently", async (players) => {
        const store = await hydrate({ games: validGames, players, tournaments: validTournaments });
        expect(store.getState().players).toEqual(store.getInitialState().players);
        expect(store.getState().games).toEqual(validGames);
        expect(store.getState().tournaments).toEqual(validTournaments);
    });

    it.each([
        undefined,
        null,
        {},
        { ...validTournaments, activeTab: "overview" },
        { ...validTournaments, selectedTournament: 0.5 },
        { ...validTournaments, query: 7 },
        { ...validTournaments, query: null },
        { ...validTournaments, query: {} },
        { ...validTournaments, query: { ...validTournaments.query, name: {} } },
        { ...validTournaments, query: { ...validTournaments.query, options: {} } },
        {
            ...validTournaments,
            query: {
                ...validTournaments.query,
                options: { ...validTournaments.query.options, sort: "elo" },
            },
        },
        {
            ...validTournaments,
            query: {
                ...validTournaments.query,
                options: { ...validTournaments.query.options, skipCount: 1 },
            },
        },
        {
            ...validTournaments,
            query: {
                ...validTournaments.query,
                options: { ...validTournaments.query.options, page: -1 },
            },
        },
    ])("resets malformed tournaments %j independently", async (tournaments) => {
        const store = await hydrate({ games: validGames, players: validPlayers, tournaments });
        expect(store.getState().tournaments).toEqual(store.getInitialState().tournaments);
        expect(store.getState().games).toEqual(validGames);
        expect(store.getState().players).toEqual(validPlayers);
    });

    it.each([undefined, null, "overview", "", 7, {}, []])(
        "resets invalid activeTab %j independently",
        async (activeTab) => {
            const store = await hydrate({
                activeTab,
                games: validGames,
                players: validPlayers,
                tournaments: validTournaments,
            });
            expect(store.getState().activeTab).toBe("games");
            expect(store.getState().games).toEqual(validGames);
            expect(store.getState().players).toEqual(validPlayers);
            expect(store.getState().tournaments).toEqual(validTournaments);
        },
    );

    it("preserves nullable filters the UI handles and normalizes absent row selections", async () => {
        const store = await hydrate({
            games: {
                ...validGames,
                selectedGameId: null,
                query: {
                    ...validGames.query,
                    player1: null,
                    range1: null,
                    range2: null,
                    outcome: null,
                    startDate: null,
                    playerName: null,
                },
            },
            players: {
                ...validPlayers,
                selectedPlayer: null,
                query: { ...validPlayers.query, name: null, range: null },
            },
            tournaments: { ...validTournaments, selectedTournament: null },
        });
        expect(store.getState().games.query).toMatchObject({
            player1: null,
            range1: null,
            range2: null,
            outcome: null,
            startDate: null,
            playerName: null,
        });
        expect(store.getState().players.query).toMatchObject({ name: null, range: null });
        expect(store.getState().games.selectedGameId).toBeUndefined();
        expect(store.getState().players.selectedPlayer).toBeUndefined();
        expect(store.getState().tournaments.selectedTournament).toBeUndefined();
    });
});

describe("database result-set state", () => {
    it("clears a games selection when the query is replaced", () => {
        activeDatabaseViewStore.getState().setGamesSelectedGameId(42);
        activeDatabaseViewStore.getState().setGamesQuery({
            ...activeDatabaseViewStore.getState().games.query,
            player1: 7,
        });
        expect(activeDatabaseViewStore.getState().games.selectedGameId).toBeUndefined();
    });

    it("resets the games page when a player filter changes", () => {
        const store = activeDatabaseViewStore;
        const options = store.getState().games.query.options!;
        store.getState().setGamesQuery({
            ...store.getState().games.query,
            options: { ...options, page: 40 },
        });
        expect(store.getState().games.query.options?.page).toBe(40);
        store.getState().setGamesQuery({
            ...store.getState().games.query,
            player1: 7,
        });
        expect(store.getState().games.query.options?.page).toBe(1);
        expect(store.getState().games.query.player1).toBe(7);
    });

    it("resets the games page when the page size changes", () => {
        const store = activeDatabaseViewStore;
        const options = store.getState().games.query.options!;
        store.getState().setGamesQuery({
            ...store.getState().games.query,
            options: { ...options, page: 40 },
        });
        store.getState().setGamesQuery({
            ...store.getState().games.query,
            options: { ...store.getState().games.query.options!, pageSize: 50 },
        });
        expect(store.getState().games.query.options?.page).toBe(1);
        expect(store.getState().games.query.options?.pageSize).toBe(50);
    });

    it("keeps the requested games page when only the page changes", () => {
        const store = activeDatabaseViewStore;
        const options = store.getState().games.query.options!;
        store.getState().setGamesQuery({
            ...store.getState().games.query,
            options: { ...options, page: 40 },
        });
        expect(store.getState().games.query.options?.page).toBe(40);
        store.getState().setGamesQuery({
            ...store.getState().games.query,
            options: { ...store.getState().games.query.options!, page: 3 },
        });
        expect(store.getState().games.query.options?.page).toBe(3);
    });

    it("resets the players page when a name filter changes", () => {
        const store = activeDatabaseViewStore;
        const options = store.getState().players.query.options;
        store.getState().setPlayersQuery({
            ...store.getState().players.query,
            options: { ...options, page: 40 },
        });
        expect(store.getState().players.query.options.page).toBe(40);
        store.getState().setPlayersQuery({
            ...store.getState().players.query,
            name: "Carlsen",
        });
        expect(store.getState().players.query.options.page).toBe(1);
        expect(store.getState().players.query.name).toBe("Carlsen");
    });

    it("resets the players page when the page size changes", () => {
        const store = activeDatabaseViewStore;
        const options = store.getState().players.query.options;
        store.getState().setPlayersQuery({
            ...store.getState().players.query,
            options: { ...options, page: 40 },
        });
        store.getState().setPlayersQuery({
            ...store.getState().players.query,
            options: { ...store.getState().players.query.options, pageSize: 50 },
        });
        expect(store.getState().players.query.options.page).toBe(1);
        expect(store.getState().players.query.options.pageSize).toBe(50);
    });

    it("keeps the requested players page when only the page changes", () => {
        const store = activeDatabaseViewStore;
        const options = store.getState().players.query.options;
        store.getState().setPlayersQuery({
            ...store.getState().players.query,
            options: { ...options, page: 40 },
        });
        expect(store.getState().players.query.options.page).toBe(40);
        store.getState().setPlayersQuery({
            ...store.getState().players.query,
            options: { ...store.getState().players.query.options, page: 3 },
        });
        expect(store.getState().players.query.options.page).toBe(3);
    });

    it("resets the tournaments page when a name filter changes", () => {
        const store = activeDatabaseViewStore;
        const options = store.getState().tournaments.query.options;
        store.getState().setTournamentsQuery({
            ...store.getState().tournaments.query,
            options: { ...options, page: 40 },
        });
        expect(store.getState().tournaments.query.options.page).toBe(40);
        store.getState().setTournamentsQuery({
            ...store.getState().tournaments.query,
            name: "Candidates",
        });
        expect(store.getState().tournaments.query.options.page).toBe(1);
        expect(store.getState().tournaments.query.name).toBe("Candidates");
    });

    it("resets the tournaments page when the page size changes", () => {
        const store = activeDatabaseViewStore;
        const options = store.getState().tournaments.query.options;
        store.getState().setTournamentsQuery({
            ...store.getState().tournaments.query,
            options: { ...options, page: 40 },
        });
        store.getState().setTournamentsQuery({
            ...store.getState().tournaments.query,
            options: { ...store.getState().tournaments.query.options, pageSize: 50 },
        });
        expect(store.getState().tournaments.query.options.page).toBe(1);
        expect(store.getState().tournaments.query.options.pageSize).toBe(50);
    });

    it("keeps the requested tournaments page when only the page changes", () => {
        const store = activeDatabaseViewStore;
        const options = store.getState().tournaments.query.options;
        store.getState().setTournamentsQuery({
            ...store.getState().tournaments.query,
            options: { ...options, page: 40 },
        });
        expect(store.getState().tournaments.query.options.page).toBe(40);
        store.getState().setTournamentsQuery({
            ...store.getState().tournaments.query,
            options: { ...store.getState().tournaments.query.options, page: 3 },
        });
        expect(store.getState().tournaments.query.options.page).toBe(3);
    });

    it("clears player and tournament selections with their result set", () => {
        activeDatabaseViewStore.getState().setPlayersSelectedPlayer(12);
        activeDatabaseViewStore.getState().setTournamentsSelectedTournament(5);
        activeDatabaseViewStore.getState().setPlayersQuery({
            ...activeDatabaseViewStore.getState().players.query,
            name: "Carlsen",
        });
        activeDatabaseViewStore.getState().setTournamentsQuery({
            ...activeDatabaseViewStore.getState().tournaments.query,
            name: "Candidates",
        });
        expect(activeDatabaseViewStore.getState().players.selectedPlayer).toBeUndefined();
        expect(activeDatabaseViewStore.getState().tournaments.selectedTournament).toBeUndefined();
    });
});
