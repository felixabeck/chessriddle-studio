import useSWRImmutable from "swr/immutable";
import type { DatabaseHandle } from "@/bindings";
import { errorUnlessCancelled, safeFailureContext, warnSafely } from "@/platform/errors";
import { tauri } from "@/platform/tauri";

/**
 * The name of a database's player, for a header that names the player filter. `undefined` while it
 * loads, without a player, and when the lookup fails; the header then reads "Player". A failure is
 * logged once and not retried: the name is a label, the column's numbers do not depend on it.
 */
export function usePlayerName(
    database: DatabaseHandle | null,
    player: number | null,
): string | undefined {
    const { data } = useSWRImmutable(
        database && player !== null ? (["player-name", database, player] as const) : null,
        async ([, file, id]) => (await tauri.getPlayer(file, id))?.name ?? undefined,
        {
            shouldRetryOnError: false,
            onError: (cause) => {
                if (errorUnlessCancelled(cause)) {
                    warnSafely(
                        `A filtered player's name could not be read: ${safeFailureContext(cause).message}`,
                    );
                }
            },
        },
    );
    return data ?? undefined;
}
