import { useAtomValue } from "jotai";
import type { DatabaseHandle, OpponentAccount, Player } from "@/bindings";
import { useDatabaseList } from "@/hooks/useDatabaseList";
import { failureUnlessCancelled } from "@/platform/errors";
import { opponentLinksAtom } from "@/state/atoms";
import { findOpponentLink } from "@/state/opponentLinks";
import { databaseHandleKey } from "@/utils/db";
import { opponentGames } from "./OpponentAccounts";
import { useOpponentPlayers } from "./useOpponentPlayers";

/**
 * Which player of the online games database the linked usernames name. `unavailable` covers both
 * a lookup that found no player and one that failed: the card says the same about either.
 */
export type OnlinePlayerLookup =
    | { kind: "pending" }
    | { kind: "found"; player: number }
    | { kind: "unavailable" };

/** The player's downloaded online games: their database, the usernames and the player they name. */
export type OnlineGames = {
    file: DatabaseHandle;
    accounts: readonly OpponentAccount[];
    lookup: OnlinePlayerLookup;
};

/** Folds the lookup's SWR answer into its state; a cancelled run is still pending, not failed. */
export function onlinePlayerLookup(
    players: readonly { id: number }[] | undefined,
    error: unknown,
): OnlinePlayerLookup {
    if (players?.[0] !== undefined) return { kind: "found", player: players[0].id };
    if (players !== undefined) return { kind: "unavailable" };
    // SWR keeps a superseded run's cancellation as the key's error until the next run settles.
    if (failureUnlessCancelled(error)) return { kind: "unavailable" };
    return { kind: "pending" };
}

/**
 * The downloaded online games of the card database player's linked opponent accounts, as the card's
 * Openings, Overview and Ratings tabs read them. `undefined` without a link or without a
 * downloaded games database; online games kept in the card's own database are not a second
 * source of it.
 */
export function useOnlineGames(player: Player, cardFile: DatabaseHandle): OnlineGames | undefined {
    const link = findOpponentLink(useAtomValue(opponentLinksAtom), player.name);
    const { data: listing, error: listingError } = useDatabaseList();
    const games = opponentGames(link, listing, listingError);
    const onlineFile =
        link &&
        games.kind === "games" &&
        databaseHandleKey(games.file) !== databaseHandleKey(cardFile)
            ? games.file
            : null;
    const { data: players, error } = useOpponentPlayers(link, onlineFile);
    const lookup = onlinePlayerLookup(players, error);
    return link && onlineFile ? { file: onlineFile, accounts: link.accounts, lookup } : undefined;
}
