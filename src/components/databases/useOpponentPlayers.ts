import useSWRImmutable from "swr/immutable";
import type { DatabaseHandle } from "@/bindings";
import { errorUnlessCancelled, safeFailureContext, warnSafely } from "@/platform/errors";
import type { OpponentLink } from "@/state/opponentLinks";
import { opponentPlayers } from "./opponentLookup";

/**
 * The SWR answer for the players the link's usernames name in its online games database, in the
 * order of the link's accounts and then lowest id first, so the first is the one the import merged
 * the others into. The accounts box and the opening tree read the same cached answer; nothing is asked
 * without a link or without a games database.
 */
export function useOpponentPlayers(link: OpponentLink | undefined, file: DatabaseHandle | null) {
    // Read here, not inside the fetcher: the React Compiler memoizes the fetcher on the property
    // reads it contains and evaluates them during render, so `link!.accounts` in the fetcher threw
    // whenever the player had no link.
    const accounts = link?.accounts ?? [];
    const usernames = accounts.map((account) => account.username).join("\n");
    return useSWRImmutable(
        file && link ? (["opponent-players", file, usernames] as const) : null,
        ([, database]) => opponentPlayers(database, accounts),
        {
            // Every reader reports the missing answer in its own place; the cause goes to the log once.
            onError: (cause) => {
                if (errorUnlessCancelled(cause)) {
                    warnSafely(
                        `The players of an opponent's online games could not be read: ${safeFailureContext(cause).message}`,
                    );
                }
            },
        },
    );
}
