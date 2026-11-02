import type { NormalizedGame } from "@/bindings";
import { decodePgnTagValue, parsePGN } from "./chess";

export function databaseGameHeaders(game: NormalizedGame) {
    // Event and Site retain PGN escapes in the database. Tree headers contain decoded text.
    return { ...game, event: decodePgnTagValue(game.event), site: decodePgnTagValue(game.site) };
}

/** Convert a row using its own starting position, headers and row stamp. */
export async function databaseGameToTree(game: NormalizedGame) {
    const tree = await parsePGN(game.moves, game.fen);
    tree.headers = databaseGameHeaders(game);
    tree.sourceStamp = game.stamp ?? null;
    return tree;
}
