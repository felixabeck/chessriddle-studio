import type { GameLink } from "@/bindings";
import { fetchChessComGamePgn } from "@/utils/chess.com/api";
import { getLichessGame } from "@/utils/lichess/api";

/** The site's proper name, as shown to the user. */
export function gameLinkSite(link: GameLink): string {
    return link.site === "lichess" ? "Lichess" : "Chess.com";
}

/** The game's public address, for messages that name the game. */
export function gameLinkUrl(link: GameLink): string {
    return link.site === "lichess"
        ? `https://lichess.org/${link.game_id}`
        : `https://www.chess.com/game/${link.game_type}/${link.game_id}`;
}

/** Fetches the PGN of a game the operating system handed to the app. No UI side effects. */
export function fetchGameLinkPgn(link: GameLink): Promise<string> {
    return link.site === "lichess"
        ? getLichessGame(link.game_id)
        : fetchChessComGamePgn(link.game_type, link.game_id);
}
