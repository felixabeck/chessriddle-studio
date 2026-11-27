import { beforeEach, describe, expect, test, vi } from "vitest";
import type { ArtifactPublication, PathRef } from "@/bindings";
import { assertAccountExportTicketOrder } from "@/utils/tests/accountExportTicketOrder";
import { parseComment, parsePgn, startingPosition } from "chessops/pgn";
import { parseSan } from "chessops/san";
import i18n from "@/i18n";
import chess960Fixture from "./fixtures/live-960-101679677427.json";

const mocks = vi.hoisted(() => ({
    downloadChessComGames: vi.fn(),
    releaseDownload: vi.fn(),
    withDownloadTicket: vi.fn(),
    progress: vi.fn(),
    getPublicChessComJson: vi.fn(),
    logError: vi.fn(),
    showNotification: vi.fn(),
}));

vi.mock("@/platform/native", () => ({ error: mocks.logError }));
vi.mock("@mantine/notifications", () => ({
    notifications: { show: mocks.showNotification },
}));

vi.mock("@/platform/tauri", async () => {
    const actual = await vi.importActual<typeof import("@/platform/tauri")>("@/platform/tauri");
    return {
        ...actual,
        tauri: {
            ...actual.tauri,
            downloadChessComGames: mocks.downloadChessComGames,
            getPublicChessComJson: mocks.getPublicChessComJson,
        },
        withDownloadTicket: mocks.withDownloadTicket,
        tauriSubscriptions: { ...actual.tauriSubscriptions, progress: mocks.progress },
    };
});

import {
    ChessComGameResponseError,
    downloadChessCom,
    fetchChessComGamePgn,
    getChessComAccount,
    getChessComProfile,
    getChessComStats,
    getChesscomGame,
} from "./api";

const destination: PathRef = { id: "destination" };
const publication: ArtifactPublication = {
    handle: { id: { id: "artifact" }, kind: "fileWorkspace" },
    durability: "Durable",
};

beforeEach(() => {
    mocks.getPublicChessComJson.mockReset();
    mocks.logError.mockReset().mockResolvedValue(undefined);
    mocks.showNotification.mockReset();
    mocks.downloadChessComGames.mockReset().mockResolvedValue(publication);
    mocks.releaseDownload.mockReset().mockResolvedValue(undefined);
    mocks.withDownloadTicket
        .mockReset()
        .mockImplementation(async (run: (ticket: string) => Promise<unknown>) => {
            try {
                return await run("prepared-ticket");
            } catch (error) {
                await mocks.releaseDownload("prepared-ticket");
                throw error;
            }
        });
});

describe("fetchChessComGamePgn", () => {
    test("returns the PGN the dialog entry point returns, from the typed game identity", async () => {
        mocks.getPublicChessComJson.mockResolvedValue(JSON.stringify(chess960Fixture));
        const viaCore = await fetchChessComGamePgn("live", "101679677427");
        const viaDialog = await getChesscomGame("https://www.chess.com/game/live/101679677427");

        expect(viaCore).toBe(viaDialog);
        expect(mocks.getPublicChessComJson).toHaveBeenNthCalledWith(1, {
            kind: "game",
            game_type: "live",
            game_id: "101679677427",
        });
        expect(mocks.showNotification).not.toHaveBeenCalled();
        expect(mocks.logError).not.toHaveBeenCalled();
    });

    test.each([
        ["an unexpected response shape", { nothing: true }, "Invalid response for Chess.com game"],
        [
            "an invalid starting position",
            { game: { moveList: "", pgnHeaders: { SetUp: "1", FEN: "not a fen" } } },
            "Invalid starting position for Chess.com game",
        ],
        [
            "an illegal move",
            { game: { moveList: "a4", pgnHeaders: {} } },
            "Illegal move in Chess.com game: a4",
        ],
    ])("rejects %s with a response error and stays silent", async (_name, body, message) => {
        mocks.getPublicChessComJson.mockResolvedValue(JSON.stringify(body));

        const failure = await fetchChessComGamePgn("daily", "42").catch((cause: unknown) => cause);

        expect(failure).toBeInstanceOf(ChessComGameResponseError);
        expect((failure as Error).message).toContain(message);
        expect(mocks.showNotification).not.toHaveBeenCalled();
        expect(mocks.logError).not.toHaveBeenCalled();
    });

    test("passes a transport failure through unchanged", async () => {
        const failure = { category: "network", message: "offline" };
        mocks.getPublicChessComJson.mockRejectedValue(failure);

        await expect(fetchChessComGamePgn("live", "1")).rejects.toBe(failure);
        expect(mocks.showNotification).not.toHaveBeenCalled();
    });
});

describe("getChesscomGame", () => {
    const gameURL = "https://www.chess.com/game/live/101679677427";

    function mockGame(moveList: string, pgnHeaders: Record<string, string | number> = {}) {
        mocks.getPublicChessComJson.mockResolvedValue(
            JSON.stringify({ game: { moveList, pgnHeaders } }),
        );
    }

    function replay(pgn: string | null) {
        expect(pgn).toBeTypeOf("string");
        if (pgn === null) throw new Error("Expected a PGN");
        const games = parsePgn(pgn);
        expect(games).toHaveLength(1);
        const game = games[0];
        const pos = startingPosition(game.headers).unwrap();
        const sans = [...game.moves.mainline()].map((node) => node.san);
        for (const san of sans) {
            const move = parseSan(pos, san);
            expect(move).toBeDefined();
            if (!move) throw new Error(`Illegal SAN: ${san}`);
            expect(pos.isLegal(move)).toBe(true);
            pos.play(move);
        }
        return { game, sans };
    }

    function expectInvalidResponse() {
        expect(mocks.logError).toHaveBeenCalledTimes(1);
        expect(mocks.showNotification).toHaveBeenCalledExactlyOnceWith({
            title: i18n.t("ChessCom.FetchGameFailed"),
            message: i18n.t("ChessCom.InvalidResponse", { value: gameURL }),
            color: "danger",
            icon: expect.objectContaining({ type: expect.anything() }),
        });
    }

    test("replays all 85 plies of the real Chess960 game including rook-square castling", async () => {
        mocks.getPublicChessComJson.mockResolvedValue(JSON.stringify(chess960Fixture));

        const pgn = await getChesscomGame(gameURL);
        const { game, sans } = replay(pgn);

        expect(sans).toHaveLength(85);
        expect(sans.slice(0, 8).join(" ")).toBe("e4 b6 b3 e5 Ng3 Ng6 Nh3 Bf6");
        expect(sans).toContain("O-O-O");
        expect(game.headers.get("FEN")).toBe(chess960Fixture.game.pgnHeaders.FEN);
        expect(game.headers.get("Variant")).toBe("Chess960");
        expect(game.headers.get("SetUp")).toBe("1");
        expect(game.headers.get("WhiteElo")).toBe("2948");
        expect(pgn).not.toContain("--");
        expect(mocks.showNotification).not.toHaveBeenCalled();
        expect(mocks.getPublicChessComJson).toHaveBeenCalledExactlyOnceWith({
            kind: "game",
            game_type: "live",
            game_id: "101679677427",
        });
    });

    test("puts each live move's remaining clock on that move", async () => {
        mocks.getPublicChessComJson.mockResolvedValue(JSON.stringify(chess960Fixture));

        const { game } = replay(await getChesscomGame(gameURL));
        const clocks = [...game.moves.mainline()].map(
            (node) => parseComment(node.comments?.join(" ") ?? "").clock,
        );

        // moveTimestamps has 86 entries for 85 plies; the trailing one has no move and is dropped.
        expect(clocks).toHaveLength(85);
        expect(clocks.slice(0, 4)).toEqual([170.7, 178.4, 167.5, 177.6]);
        expect(clocks.at(-1)).toBe(57.7);
    });

    test("accepts a list with exactly one clock per move", async () => {
        mocks.getPublicChessComJson.mockResolvedValue(
            JSON.stringify({
                game: { moveList: "mC0K", pgnHeaders: {}, moveTimestamps: "1199,1192" },
            }),
        );

        const { game } = replay(await getChesscomGame(gameURL));

        expect(
            [...game.moves.mainline()].map(
                (node) => parseComment(node.comments?.join(" ") ?? "").clock,
            ),
        ).toEqual([119.9, 119.2]);
    });

    test.each([
        ["a daily game", "https://www.chess.com/game/daily/123", "1199,1192"],
        ["a list shorter than the moves", gameURL, "1199"],
        ["an unreadable list", gameURL, "1199,abc"],
        ["a list that is not text", gameURL, [1199, 1192]],
    ])("adds no clocks for %s", async (_name, url, moveTimestamps: unknown) => {
        mocks.getPublicChessComJson.mockResolvedValue(
            JSON.stringify({ game: { moveList: "mC0K", pgnHeaders: {}, moveTimestamps } }),
        );

        const pgn = await getChesscomGame(url);

        expect(replay(pgn).sans).toEqual(["e4", "e5"]);
        expect(pgn).not.toContain("%clk");
    });

    test("replays a from-position game using its FEN", async () => {
        const fen = "4k3/8/8/8/8/8/8/R3K3 w Q - 0 1";
        mockGame("a4", { SetUp: "1", FEN: fen });

        const { game, sans } = replay(await getChesscomGame(gameURL));

        expect(sans).toEqual(["Ra8+"]);
        expect(game.headers.get("FEN")).toBe(fen);
    });

    test.each(["mK", "mC0KCK"])(
        "rejects an illegal move without returning a partial PGN: %s",
        async (moves) => {
            mockGame(moves);

            await expect(getChesscomGame(gameURL)).resolves.toBeNull();
            expectInvalidResponse();
        },
    );

    test("rejects a bad FEN header", async () => {
        mockGame("mC", { SetUp: "1", FEN: "not a fen" });

        await expect(getChesscomGame(gameURL)).resolves.toBeNull();
        expectInvalidResponse();
    });

    test("rejects an invalid response schema with the same notification", async () => {
        mocks.getPublicChessComJson.mockResolvedValue(JSON.stringify({ game: {} }));

        await expect(getChesscomGame(gameURL)).resolves.toBeNull();
        expectInvalidResponse();
    });

    test("preserves headers for an empty move list", async () => {
        mockGame("", { White: "Player", BlackElo: 1500 });

        const pgn = await getChesscomGame(gameURL);
        const { game, sans } = replay(pgn);

        expect(pgn).toContain('[White "Player"]');
        expect(game.headers.get("BlackElo")).toBe("1500");
        expect(sans).toEqual([]);
    });

    test("normalizes standard king-to-g-file castling through chessops", async () => {
        mockGame("eg", {
            SetUp: "1",
            FEN: "4k3/8/8/8/8/8/8/4K2R w K - 0 1",
        });

        expect(replay(await getChesscomGame(gameURL)).sans).toEqual(["O-O"]);
    });

    test.each([
        ["https://www.chess.com/game/123", "live"],
        ["https://www.chess.com/game/daily/123", "daily"],
    ])("fetches the correct game type for %s", async (url, gameType) => {
        mockGame("mC");

        expect(replay(await getChesscomGame(url)).sans).toEqual(["e4"]);
        expect(mocks.getPublicChessComJson).toHaveBeenCalledExactlyOnceWith({
            kind: "game",
            game_type: gameType,
            game_id: "123",
        });
    });

    test.each(["https://www.chess.com/events/some-event", "https://www.chess.com/member/player"])(
        "rejects %s without fetching",
        async (url) => {
            await expect(getChesscomGame(url)).resolves.toBeNull();
            expect(mocks.getPublicChessComJson).not.toHaveBeenCalled();
        },
    );
});

describe("getChessComProfile", () => {
    test("returns the profile fields the confirmation shows", async () => {
        mocks.getPublicChessComJson.mockResolvedValue(
            JSON.stringify({
                username: "magnuscarlsen",
                name: "Magnus Carlsen",
                title: "GM",
                country: "https://api.chess.com/pub/country/NO",
                status: "premium",
                followers: 1,
            }),
        );

        await expect(getChessComProfile("MagnusCarlsen")).resolves.toEqual({
            username: "magnuscarlsen",
            name: "Magnus Carlsen",
            title: "GM",
            countryCode: "NO",
            closed: false,
        });
        expect(mocks.getPublicChessComJson).toHaveBeenCalledExactlyOnceWith({
            kind: "profile",
            player: "MagnusCarlsen",
        });
    });

    test.each(["closed", "closed:fair_play_violations"])(
        "marks status %s as closed",
        async (status) => {
            mocks.getPublicChessComJson.mockResolvedValue(
                JSON.stringify({ username: "gone", status }),
            );

            await expect(getChessComProfile("gone")).resolves.toEqual({
                username: "gone",
                closed: true,
            });
        },
    );

    test("leaves out a country that is not an API country URL", async () => {
        mocks.getPublicChessComJson.mockResolvedValue(
            JSON.stringify({ username: "player", country: "Norway" }),
        );

        await expect(getChessComProfile("player")).resolves.toEqual({
            username: "player",
            closed: false,
        });
    });

    test("rejects a response without a username", async () => {
        mocks.getPublicChessComJson.mockResolvedValue(JSON.stringify({ name: "Nobody" }));

        await expect(getChessComProfile("player")).rejects.toThrow(
            i18n.t("ChessCom.InvalidResponse", { value: "player" }),
        );
        expect(mocks.logError).toHaveBeenCalledTimes(1);
    });

    test("passes a lookup failure on unchanged", async () => {
        const failure = new Error("not found");
        mocks.getPublicChessComJson.mockRejectedValue(failure);

        await expect(getChessComProfile("player")).rejects.toBe(failure);
    });
});

describe("getChessComStats", () => {
    test("returns the statistics, and logs an unreadable answer without announcing it", async () => {
        const stats = {
            chess_blitz: { last: { rating: 1500, date: 1 }, record: { win: 3, loss: 2, draw: 1 } },
        };
        mocks.getPublicChessComJson.mockResolvedValueOnce(JSON.stringify(stats));
        await expect(getChessComStats("player")).resolves.toEqual(stats);

        mocks.getPublicChessComJson.mockResolvedValueOnce(
            JSON.stringify({ chess_blitz: { last: "none" } }),
        );
        await expect(getChessComStats("player")).resolves.toBeNull();

        expect(mocks.logError).toHaveBeenCalledTimes(1);
        expect(mocks.showNotification).not.toHaveBeenCalled();
    });

    test("passes a failed request on", async () => {
        const failure = new Error("offline");
        mocks.getPublicChessComJson.mockRejectedValue(failure);

        await expect(getChessComStats("player")).rejects.toBe(failure);
        expect(mocks.showNotification).not.toHaveBeenCalled();
    });
});

describe("getChessComAccount", () => {
    const record = { win: 10, loss: 5, draw: 2 };

    test("accepts stats whose last rating omits the rating deviation", async () => {
        const stats = {
            chess_blitz: { last: { rating: 1500, date: 1700000000 }, record },
            chess_rapid: { last: { rating: 1600, date: 1700000001, rd: 45 }, record },
        };
        mocks.getPublicChessComJson.mockResolvedValue(JSON.stringify(stats));

        await expect(getChessComAccount("player")).resolves.toEqual(stats);
        expect(mocks.getPublicChessComJson).toHaveBeenCalledExactlyOnceWith({
            kind: "account",
            player: "player",
        });
        expect(mocks.showNotification).not.toHaveBeenCalled();
    });

    test("rejects a perf block missing its rating", async () => {
        mocks.getPublicChessComJson.mockResolvedValue(
            JSON.stringify({ chess_blitz: { last: { date: 1700000000, rd: 45 }, record } }),
        );

        await expect(getChessComAccount("player")).resolves.toBeNull();
        expect(mocks.logError).toHaveBeenCalledTimes(1);
        expect(mocks.showNotification).toHaveBeenCalledExactlyOnceWith({
            title: i18n.t("ChessCom.FetchAccountFailed"),
            message: i18n.t("ChessCom.InvalidResponse", { value: "player" }),
            color: "danger",
            icon: expect.objectContaining({ type: expect.anything() }),
        });
    });
});

describe("downloadChessCom", () => {
    test("installs the ticket listener before the native entry frame while download is pending", async () => {
        await assertAccountExportTicketOrder({
            progressMock: mocks.progress,
            nativeMock: mocks.downloadChessComGames,
            download: (onTicket) => downloadChessCom(destination, "player", null, onTicket),
            publication,
        });
    });

    test("passes the prepared ticket as the native job id", async () => {
        await expect(downloadChessCom(destination, "player", 123, vi.fn())).resolves.toEqual(
            publication,
        );

        expect(mocks.downloadChessComGames).toHaveBeenCalledWith(
            destination,
            "player_chesscom.pgn",
            "player",
            123n,
            "prepared-ticket",
        );
        expect(mocks.releaseDownload).not.toHaveBeenCalled();
    });

    test("returns an uncertain publication unchanged", async () => {
        const uncertain: ArtifactPublication = {
            handle: publication.handle,
            durability: { DurabilityUncertain: "DownloadTargetReplacement" },
        };
        mocks.downloadChessComGames.mockResolvedValue(uncertain);

        await expect(downloadChessCom(destination, "player", null, vi.fn())).resolves.toEqual(
            uncertain,
        );
        expect(mocks.downloadChessComGames).toHaveBeenCalledTimes(1);
        expect(mocks.releaseDownload).not.toHaveBeenCalled();
    });

    test("releases a prepared ticket when the command rejects", async () => {
        const failure = new Error("download failed");
        mocks.downloadChessComGames.mockRejectedValue(failure);

        await expect(downloadChessCom(destination, "player", null, vi.fn())).rejects.toBe(failure);
        expect(mocks.releaseDownload).toHaveBeenCalledWith("prepared-ticket");
    });
});
