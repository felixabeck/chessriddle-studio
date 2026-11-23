import useSWRImmutable from "swr/immutable";
import type { DatabaseHandle, PlayerGameInfo } from "@/bindings";
import { useNativeRequestOwner } from "@/hooks/useNativeRequestOwner";
import { errorUnlessCancelled, safeFailureContext, warnSafely } from "@/platform/errors";
import { tauri } from "@/platform/tauri";
import { useDatabaseContentRevision } from "@/state/linkedCollections";

export type PlayerGameInfoState = {
    info: PlayerGameInfo | undefined;
    /**
     * True until the database's revision is known and its statistics have arrived; false for an
     * unreadable index, which `unavailable` reports instead.
     */
    loading: boolean;
    error: unknown;
    /** The database's search index cannot be read. */
    unavailable: boolean;
};

/**
 * One player's game statistics in one database, re-read when the database's content changes.
 * Nothing is asked without a database or a player.
 */
export function usePlayerGameInfo(
    file: DatabaseHandle | null,
    player: number | null,
): PlayerGameInfoState {
    const { revision, unavailable } = useDatabaseContentRevision(file);
    const requestKey =
        file && player !== null && revision && !unavailable
            ? (["player-game-info", file, player, ...revision] as const)
            : null;
    const requestOwner = useNativeRequestOwner(requestKey);
    const { data, isLoading, error } = useSWRImmutable(
        requestKey,
        ([, database, id]) =>
            requestOwner!.run((signal) =>
                tauri.getPlayersGameInfo(crypto.randomUUID(), database, id, { signal }),
            ),
        {
            // A failed read is not retried: the card shows a short notice, the cause goes to the log once.
            shouldRetryOnError: false,
            onError: (cause) => {
                if (errorUnlessCancelled(cause)) {
                    warnSafely(
                        `The statistics of player ${player} could not be read: ${safeFailureContext(cause).message}`,
                    );
                }
            },
        },
    );
    return {
        info: data,
        loading: !unavailable && (isLoading || (file !== null && revision === null)),
        error,
        unavailable,
    };
}
