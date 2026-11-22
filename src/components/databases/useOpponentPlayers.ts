import useSWRImmutable from "swr/immutable";
import type { DatabaseHandle } from "@/bindings";
import { errorUnlessCancelled, safeFailureContext, warnSafely } from "@/platform/errors";
import type { OpponentLink } from "@/state/opponentLinks";
import { opponentPlayers } from "./opponentLookup";

/**
 * The players the link's usernames name in its online games database, lowest id first. The
 * accounts box and the opening tree read the same cached answer; `undefined` while it loads, after
 * a failure, and when there are no games.
 */
export function useOpponentPlayers(link: OpponentLink | undefined, file: DatabaseHandle | null) {
    // Read here, not in the fetcher: the compiled hook evaluates what its closures read.
    const accounts = link?.accounts ?? [];
    const usernames = accounts.map((account) => account.username).join("\n");
    return useSWRImmutable(
        file && link ? (["opponent-players", file, usernames] as const) : null,
        ([, games]) => opponentPlayers(games, accounts),
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
