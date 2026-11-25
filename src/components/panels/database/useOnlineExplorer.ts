import { useTranslation } from "react-i18next";
import useSWR from "swr/immutable";
import type { NormalizedGame } from "@/bindings";
import { inlineFailureMessage } from "@/components/files/notifyError";
import { useNativeRequestOwner } from "@/hooks/useNativeRequestOwner";
import type { ExplorerOnlineSource } from "@/state/atoms";
import type { Opening } from "@/utils/db";
import {
    convertToNormalized,
    getLichessGames,
    getMasterGames,
    type PositionData,
} from "@/utils/lichess/api";
import type { LichessGamesOptions, MasterGamesOptions } from "@/utils/lichess/explorer";

export async function fetchOnlineOpening<T>(
    fetcher: (fen: string, options: T, handle: string) => Promise<PositionData>,
    fen: string,
    options: T,
    handle: string,
    signal?: AbortSignal,
) {
    const data = await fetcher(fen, options, handle);
    if (signal?.aborted) {
        throw new DOMException("Cancellation", "AbortError");
    }
    const seen = new Set<string>();
    const games = [...(data.topGames ?? []), ...(data.recentGames ?? [])].filter((game) => {
        if (seen.has(game.id)) return false;
        seen.add(game.id);
        return true;
    });
    const normalized = await convertToNormalized(games, { signal });
    return {
        openings: data.moves.map((move) => ({
            move: move.san,
            white: move.white,
            black: move.black,
            draw: move.draws,
        })),
        total: { move: "", white: data.white, black: data.black, draw: data.draws },
        games: normalized.games,
        gameFailures: normalized.failures,
    };
}

export type OnlineExplorerResult = {
    openings: Opening[];
    total: Opening | undefined;
    games: NormalizedGame[];
    gameFailures: Awaited<ReturnType<typeof convertToNormalized>>["failures"] | undefined;
    loading: boolean;
    error: string | undefined;
};

/**
 * One Lichess column's request. Identified by its source, stored filter options, position and
 * account handle; a superseded or unmounted request delivers nothing. There is no request without
 * a signed-in account, and a failed request is not retried by itself.
 */
export function useOnlineExplorer(
    source: ExplorerOnlineSource,
    fen: string,
    options: LichessGamesOptions | MasterGamesOptions,
    handle: string | undefined,
    enabled: boolean,
): OnlineExplorerResult {
    const { t } = useTranslation();
    const key = enabled && handle ? ({ type: source, options, fen, handle } as const) : null;
    const owner = useNativeRequestOwner(key);
    const { data, isLoading, error } = useSWR(
        key,
        () =>
            owner!.run((signal) =>
                source === "lch_all"
                    ? fetchOnlineOpening(
                          getLichessGames,
                          fen,
                          options as LichessGamesOptions,
                          handle!,
                          signal,
                      )
                    : fetchOnlineOpening(
                          getMasterGames,
                          fen,
                          options as MasterGamesOptions,
                          handle!,
                          signal,
                      ),
            ),
        {
            shouldRetryOnError: false,
            revalidateOnFocus: false,
            revalidateOnReconnect: false,
        },
    );
    return {
        openings: data?.openings ?? [],
        total: data?.total,
        games: data?.games ?? [],
        gameFailures: data?.gameFailures,
        loading: Boolean(key) && isLoading,
        error: inlineFailureMessage(error, undefined, t("Board.Database.ExplorerLoadError")),
    };
}
