import { useAtom, useAtomValue, useSetAtom } from "jotai";
import type { DatabaseHandle } from "@/bindings";
import {
    explorerDatabaseFiltersAtom,
    localOptionsFamily,
    pinnedExplorerDatabaseFamily,
    setExplorerFiltersAtom,
} from "@/state/atoms";
import { type ExplorerFilters, explorerFiltersFor } from "@/state/explorerFilters";
import { useTabAtom } from "@/state/tabScope";
import { databaseHandleKey, getEffectiveLocalPlayer, type LocalOptions } from "@/utils/db";

/** The filter fields of a tab's own options, with the player only if `database` owns it. */
function tabFilters(options: LocalOptions, database: DatabaseHandle | null): ExplorerFilters {
    return {
        player: getEffectiveLocalPlayer(options, database),
        color: options.color,
        start_date: options.start_date,
        end_date: options.end_date,
        result: options.result,
        elo: options.elo,
        exclude_fast_events: options.exclude_fast_events,
    };
}

/**
 * The options one local source is searched with. A pinned tab searches its own source with the
 * tab's options; an unpinned tab — and the reference source on a pinned tab — combines the
 * database's saved filters with the tab's position and match mode.
 */
function localSourceOptions(
    tabOptions: LocalOptions,
    database: DatabaseHandle | null,
    saved: ExplorerFilters | null,
): LocalOptions {
    if (saved === null) {
        return {
            ...tabOptions,
            path: database,
            player: getEffectiveLocalPlayer(tabOptions, database),
        };
    }
    return {
        ...saved,
        player_database: database ? databaseHandleKey(database) : undefined,
        path: database,
        fen: tabOptions.fen,
        type: tabOptions.type,
    };
}

/**
 * Binds a local source's filters to where they live: the database's saved filters, or the tab's
 * own options while the tab is pinned to a database.
 *
 * `fixedPlayer` is the player of a pinned tab's second column. That column shares every other
 * filter with the tab, searches `database` for its own player, and never changes the tab's
 * player.
 *
 * `saved` forces the database's saved filters even on a pinned tab (the reference source on a
 * preparation board), editing only those saved filters and never the tab's own options.
 */
export function useExplorerFilters(
    database: DatabaseHandle | null,
    fixedPlayer: number | null = null,
    { saved = false }: { saved?: boolean } = {},
): {
    filters: ExplorerFilters;
    setFilters: (update: (current: ExplorerFilters) => ExplorerFilters) => void;
    /** The options to search `database` with in this tab. */
    options: LocalOptions;
} {
    const pinned = useAtomValue(useTabAtom(pinnedExplorerDatabaseFamily)) !== null;
    const [tabOptions, setTabOptions] = useAtom(useTabAtom(localOptionsFamily));
    const entries = useAtomValue(explorerDatabaseFiltersAtom);
    const saveFilters = useSetAtom(setExplorerFiltersAtom);
    const key = database ? databaseHandleKey(database) : null;

    if (!saved && pinned && fixedPlayer !== null) {
        const shared = (options: LocalOptions): ExplorerFilters => ({
            ...tabFilters(options, database),
            player: fixedPlayer,
        });
        return {
            filters: shared(tabOptions),
            setFilters: (update) =>
                setTabOptions((current) => {
                    const { player: _fixed, ...rest } = update(shared(current));
                    return { ...current, ...rest };
                }),
            options: {
                ...tabOptions,
                path: database,
                player: fixedPlayer,
                player_database: key ?? undefined,
            },
        };
    }
    if (!saved && pinned) {
        return {
            filters: tabFilters(tabOptions, database),
            setFilters: (update) =>
                setTabOptions((current) => {
                    const before = tabFilters(current, database);
                    const { player, ...rest } = update(before);
                    return {
                        ...current,
                        ...rest,
                        // A player another database owns stays stored until this database's player changes.
                        ...(player === before.player
                            ? {}
                            : {
                                  player,
                                  player_database: player !== null && key ? key : undefined,
                              }),
                    };
                }),
            options: localSourceOptions(tabOptions, database, null),
        };
    }
    const filters = explorerFiltersFor(entries, key);
    return {
        filters,
        setFilters: (update) => {
            if (database) saveFilters({ database, update });
        },
        options: localSourceOptions(tabOptions, database, filters),
    };
}
