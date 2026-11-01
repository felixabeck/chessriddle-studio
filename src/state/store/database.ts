import { type Draft, produce } from "immer";
import { z } from "zod";
import { createStore, useStore } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { GameQuery, GameSort, PlayerQuery, QueryOptions, TournamentQuery } from "@/bindings";
import { reportPersistError } from "@/state/persistError";
import { storageErrorCause } from "@/state/storageError";
import { ELO_FILTER_MAX, type SuccessDatabaseInfo } from "@/utils/db";
import { databaseHandleSchema } from "@/utils/pathCapabilities";
import { decodeCompressedOrJson, serializeStorageValue } from "./debouncedStorage";

// Hydrated selections supply identity only. DatabaseView gets display metadata from the
// fresh listing before rendering its children, so retain the stored metadata unchanged.
const persistedDatabaseSchema = z
    .object({
        type: z.literal("success"),
        file: databaseHandleSchema,
    })
    .passthrough();

export interface DatabaseViewStore {
    database?: SuccessDatabaseInfo;
    activeTab: "games" | "players" | "tournaments";
    games: {
        isFilterExpanded: boolean;
        query: GameQuery;
        selectedGame?: number;
    };
    players: {
        query: PlayerQuery;
        selectedPlayer?: number;
        activeTab: "overview" | "ratings" | "openings";
    };
    tournaments: {
        query: TournamentQuery;
        selectedTournament?: number;
        activeTab: "games" | "leaderboard";
    };

    setDatabase: (database: SuccessDatabaseInfo) => boolean;
    clearDatabase: () => boolean;
    setActiveTab: (mode: DatabaseViewStore["activeTab"]) => boolean;

    setGamesQuery: (filter: GameQuery) => boolean;
    setGamesSelectedGame: (game?: number) => boolean;
    toggleGamesOpenedSettings: () => boolean;

    setPlayersQuery: (filter: PlayerQuery) => boolean;
    setPlayersSelectedPlayer: (player?: number) => boolean;
    setPlayersActiveTab: (value: DatabaseViewStore["players"]["activeTab"]) => boolean;

    setTournamentsQuery: (query: TournamentQuery) => boolean;
    setTournamentsSelectedTournament: (tournament?: number) => boolean;
    setTournamentsActiveTab: (value: DatabaseViewStore["tournaments"]["activeTab"]) => boolean;
}

const defaultGamesQueryOptions: QueryOptions<GameSort> = {
    sort: "date",
    direction: "desc",
    pageSize: 25,
    page: 1,
    skipCount: false,
};

const defaultGamesState: DatabaseViewStore["games"] = {
    isFilterExpanded: false,
    selectedGame: undefined,
    query: {
        player1: undefined,
        range1: [0, ELO_FILTER_MAX],
        player2: undefined,
        range2: [0, ELO_FILTER_MAX],
        sides: "WhiteBlack",
        outcome: undefined,
        options: defaultGamesQueryOptions,
    },
};

function gamesQueryExceptPage(query: GameQuery) {
    const { options, ...rest } = query;
    return {
        ...rest,
        options: options
            ? {
                  skipCount: options.skipCount,
                  pageSize: options.pageSize,
                  sort: options.sort,
                  direction: options.direction,
              }
            : options,
    };
}

const defaultPlayersState: DatabaseViewStore["players"] = {
    activeTab: "overview",
    query: {
        name: undefined,
        range: undefined,
        options: {
            page: 1,
            pageSize: 25,
            sort: "name",
            direction: "desc",
            skipCount: false,
        },
    },
};

const defaultTournamentState: DatabaseViewStore["tournaments"] = {
    activeTab: "games",
    query: {
        name: "",
        options: {
            page: 1,
            pageSize: 25,
            sort: "name",
            direction: "desc",
            skipCount: false,
        },
    },
};

// Match Rust's i32 DTOs and pagination_limit_offset in db/mod.rs. Filter ranges
// have no backend ordering/ELO bound, and nullable pagination uses consumer defaults.
const queryIntegerSchema = z.number().int().min(-2_147_483_648).max(2_147_483_647);
const queryRangeSchema = z.tuple([queryIntegerSchema, queryIntegerSchema]).nullish();
// Matches MAX_PAGE_SIZE in src-tauri/src/db/mod.rs.
const MAX_PAGE_SIZE = 1000;

function createQueryOptionsSchema<Sort extends string>(sorts: [Sort, ...Sort[]]) {
    return z.object({
        skipCount: z.boolean(),
        page: queryIntegerSchema.min(1).nullish(),
        pageSize: queryIntegerSchema.min(1).max(MAX_PAGE_SIZE).nullish(),
        sort: z.enum(sorts),
        direction: z.enum(["asc", "desc"]),
    });
}

const activeTabSchema = z.enum(["games", "players", "tournaments"]);
// GameQuery's optional/null options and sides are an API convenience. Persisted UI
// panels need complete options for table edits and a side value for SideInput.
const persistedGamesSchema: z.ZodType<DatabaseViewStore["games"], z.ZodTypeDef, unknown> = z.object(
    {
        isFilterExpanded: z.boolean(),
        selectedGame: queryIntegerSchema
            .min(0)
            .nullish()
            .transform((value) => value ?? undefined),
        query: z.object({
            options: createQueryOptionsSchema(["id", "date", "whiteElo", "blackElo", "ply_count"]),
            player1: queryIntegerSchema.nullish(),
            player2: queryIntegerSchema.nullish(),
            tournament_id: queryIntegerSchema.nullish(),
            start_date: z.string().nullish(),
            end_date: z.string().nullish(),
            range1: queryRangeSchema,
            range2: queryRangeSchema,
            sides: z.enum(["BlackWhite", "WhiteBlack", "Any"]),
            outcome: z.string().nullish(),
            position: z.object({ fen: z.string(), type_: z.enum(["exact", "partial"]) }).nullish(),
            wanted_result: z.string().nullish(),
            exclude_fast_events: z.boolean().nullish(),
        }),
    },
);

const persistedPlayersSchema: z.ZodType<DatabaseViewStore["players"], z.ZodTypeDef, unknown> =
    z.object({
        activeTab: z.enum(["overview", "ratings", "openings"]),
        selectedPlayer: queryIntegerSchema.nullish().transform((value) => value ?? undefined),
        query: z.object({
            options: createQueryOptionsSchema(["id", "name", "elo"]),
            name: z.string().nullish(),
            range: queryRangeSchema,
        }),
    });

const persistedTournamentsSchema: z.ZodType<
    DatabaseViewStore["tournaments"],
    z.ZodTypeDef,
    unknown
> = z.object({
    activeTab: z.enum(["games", "leaderboard"]),
    selectedTournament: queryIntegerSchema.nullish().transform((value) => value ?? undefined),
    query: z.object({
        options: createQueryOptionsSchema(["id", "name"]),
        name: z.string().nullable(),
    }),
});

type DatabaseViewSetState = {
    (
        partial:
            | DatabaseViewStore
            | Partial<DatabaseViewStore>
            | ((state: DatabaseViewStore) => DatabaseViewStore | Partial<DatabaseViewStore>),
        replace?: false,
    ): boolean;
    (
        state: DatabaseViewStore | ((state: DatabaseViewStore) => DatabaseViewStore),
        replace: true,
    ): boolean;
};

const databaseViewStore = createStore<DatabaseViewStore>()<[["zustand/persist", unknown]]>((
    publish,
    get,
    api,
) => {
    const admit: DatabaseViewSetState = (
        partial:
            | DatabaseViewStore
            | Partial<DatabaseViewStore>
            | ((state: DatabaseViewStore) => DatabaseViewStore | Partial<DatabaseViewStore>),
        replace?: boolean,
    ) => {
        const current = get();
        const next = typeof partial === "function" ? partial(current) : partial;
        const candidate = Object.is(next, current)
            ? current
            : (replace ?? (typeof next !== "object" || next === null))
              ? (next as DatabaseViewStore)
              : Object.assign({}, current, next);
        try {
            sessionStorage.setItem(
                "database-view",
                serializeStorageValue({ state: candidate, version: 0 }),
            );
        } catch (cause) {
            reportPersistError(new Error(storageErrorCause(cause), { cause }));
            return false;
        }
        // Subscriber failures after publication are not storage refusals.
        publish(candidate, true);
        return true;
    };
    const state = persist<DatabaseViewStore>(
        () => ({
            activeTab: "games",
            games: defaultGamesState,
            players: defaultPlayersState,
            tournaments: defaultTournamentState,

            setDatabase: (database: SuccessDatabaseInfo) => {
                return admit(
                    produce((state: Draft<DatabaseViewStore>) => {
                        state.database = database;
                        state.games = defaultGamesState;
                        state.players = defaultPlayersState;
                        state.tournaments = defaultTournamentState;
                    }),
                );
            },
            clearDatabase: () => {
                return admit(
                    produce((state: Draft<DatabaseViewStore>) => {
                        state.database = undefined;
                        state.games = defaultGamesState;
                        state.players = defaultPlayersState;
                        state.tournaments = defaultTournamentState;
                        state.activeTab = "games";
                    }),
                );
            },

            setActiveTab: (mode: DatabaseViewStore["activeTab"]) => {
                return admit(
                    produce((state: Draft<DatabaseViewStore>) => {
                        state.activeTab = mode;
                    }),
                );
            },
            setGamesQuery: (query) => {
                return admit(
                    produce((state: Draft<DatabaseViewStore>) => {
                        const restChanged =
                            JSON.stringify(gamesQueryExceptPage(state.games.query)) !==
                            JSON.stringify(gamesQueryExceptPage(query));
                        state.games.query = restChanged
                            ? {
                                  ...query,
                                  options: {
                                      ...(query.options ?? defaultGamesQueryOptions),
                                      page: 1,
                                  },
                              }
                            : query;
                        // A filter/sort change can make the old row either absent or refer to
                        // a different page. Selection belongs to the result set, never to a
                        // bare game ID surviving an unrelated query.
                        state.games.selectedGame = undefined;
                    }),
                );
            },
            setGamesSelectedGame: (game) => {
                return admit(
                    produce((state: Draft<DatabaseViewStore>) => {
                        state.games.selectedGame = game;
                    }),
                );
            },
            toggleGamesOpenedSettings: () => {
                return admit(
                    produce((state: Draft<DatabaseViewStore>) => {
                        state.games.isFilterExpanded = !state.games.isFilterExpanded;
                    }),
                );
            },

            setPlayersQuery: (query: PlayerQuery) => {
                return admit(
                    produce((state: Draft<DatabaseViewStore>) => {
                        state.players.query = query;
                        state.players.selectedPlayer = undefined;
                    }),
                );
            },
            setPlayersActiveTab: (value: DatabaseViewStore["players"]["activeTab"]) => {
                return admit(
                    produce((state: Draft<DatabaseViewStore>) => {
                        state.players.activeTab = value;
                    }),
                );
            },
            setPlayersSelectedPlayer: (player?: number) => {
                return admit(
                    produce((state: Draft<DatabaseViewStore>) => {
                        state.players.selectedPlayer = player;
                    }),
                );
            },

            setTournamentsQuery: (query: TournamentQuery) => {
                return admit(
                    produce((state: Draft<DatabaseViewStore>) => {
                        state.tournaments.query = query;
                        state.tournaments.selectedTournament = undefined;
                    }),
                );
            },
            setTournamentsSelectedTournament: (tournament?: number) => {
                return admit(
                    produce((state: Draft<DatabaseViewStore>) => {
                        state.tournaments.selectedTournament = tournament;
                    }),
                );
            },
            setTournamentsActiveTab: (value: DatabaseViewStore["tournaments"]["activeTab"]) => {
                return admit(
                    produce((state: Draft<DatabaseViewStore>) => {
                        state.tournaments.activeTab = value;
                    }),
                );
            },
        }),
        {
            name: "database-view",
            storage: createJSONStorage(() => ({
                getItem: (name) => {
                    const value = decodeCompressedOrJson(sessionStorage.getItem(name));
                    return value === null ? null : JSON.stringify(value);
                },
                setItem: (name, value) =>
                    sessionStorage.setItem(name, serializeStorageValue(JSON.parse(value))),
                removeItem: (name) => sessionStorage.removeItem(name),
            })),
            merge: (persistedState, currentState) => {
                const stored =
                    persistedState && typeof persistedState === "object"
                        ? (persistedState as Partial<DatabaseViewStore>)
                        : {};
                const parsed = persistedDatabaseSchema.safeParse(stored.database);
                const activeTab = activeTabSchema.safeParse(stored.activeTab);
                const games = persistedGamesSchema.safeParse(stored.games);
                const players = persistedPlayersSchema.safeParse(stored.players);
                const tournaments = persistedTournamentsSchema.safeParse(stored.tournaments);
                return {
                    ...currentState,
                    database: parsed.success ? (parsed.data as SuccessDatabaseInfo) : undefined,
                    activeTab: activeTab.success ? activeTab.data : currentState.activeTab,
                    games: games.success ? games.data : currentState.games,
                    players: players.success ? players.data : currentState.players,
                    tournaments: tournaments.success ? tournaments.data : currentState.tournaments,
                };
            },
        },
    )(publish, get, api);
    api.setState = admit;
    return state;
});

export const activeDatabaseViewStore = databaseViewStore as Omit<
    typeof databaseViewStore,
    "setState"
> & {
    setState: DatabaseViewSetState;
};

export function useActiveDatabaseViewStore(): DatabaseViewStore;
export function useActiveDatabaseViewStore<T>(selector: (state: DatabaseViewStore) => T): T;
export function useActiveDatabaseViewStore<T>(selector?: (state: DatabaseViewStore) => T) {
    return useStore(activeDatabaseViewStore, selector!);
}
