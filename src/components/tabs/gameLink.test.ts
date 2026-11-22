import { beforeEach, describe, expect, test, vi } from "vitest";
import type { GameLink } from "@/bindings";

const mocks = vi.hoisted(() => ({
    fetchChessComGamePgn: vi.fn(),
    getLichessGame: vi.fn(),
}));

vi.mock("@/utils/chess.com/api", () => ({ fetchChessComGamePgn: mocks.fetchChessComGamePgn }));
vi.mock("@/utils/lichess/api", () => ({ getLichessGame: mocks.getLichessGame }));

import { fetchGameLinkPgn, gameLinkSite, gameLinkUrl } from "./gameLink";

const lichess: GameLink = { site: "lichess", game_id: "abcdefgh" };
const chessCom: GameLink = { site: "chess-com", game_type: "daily", game_id: "42" };

beforeEach(() => {
    mocks.fetchChessComGamePgn.mockReset().mockResolvedValue("chess.com pgn");
    mocks.getLichessGame.mockReset().mockResolvedValue("lichess pgn");
});

describe("game links", () => {
    test("names the site and the public game address", () => {
        expect(gameLinkSite(lichess)).toBe("Lichess");
        expect(gameLinkSite(chessCom)).toBe("Chess.com");
        expect(gameLinkUrl(lichess)).toBe("https://lichess.org/abcdefgh");
        expect(gameLinkUrl(chessCom)).toBe("https://www.chess.com/game/daily/42");
    });

    test("fetches a Lichess game by its id only", async () => {
        await expect(fetchGameLinkPgn(lichess)).resolves.toBe("lichess pgn");
        expect(mocks.getLichessGame).toHaveBeenCalledExactlyOnceWith("abcdefgh");
        expect(mocks.fetchChessComGamePgn).not.toHaveBeenCalled();
    });

    test("fetches a chess.com game by its type and id only", async () => {
        await expect(fetchGameLinkPgn(chessCom)).resolves.toBe("chess.com pgn");
        expect(mocks.fetchChessComGamePgn).toHaveBeenCalledExactlyOnceWith("daily", "42");
        expect(mocks.getLichessGame).not.toHaveBeenCalled();
    });

    test("lets the fetch failure through for the caller to present", async () => {
        const failure = new Error("offline");
        mocks.getLichessGame.mockRejectedValue(failure);
        await expect(fetchGameLinkPgn(lichess)).rejects.toBe(failure);
    });
});
