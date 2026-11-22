import { beforeEach, describe, expect, test, vi } from "vitest";
import type { DatabaseHandle, ErrorPayload } from "@/bindings";

const mocks = vi.hoisted(() => ({
    getLichessAccount: vi.fn(),
    getChessComProfile: vi.fn(),
    getChessComAccount: vi.fn(),
    queryPlayers: vi.fn(),
}));

vi.mock("@/utils/lichess/api", () => ({ getLichessAccount: mocks.getLichessAccount }));
vi.mock("@/utils/chess.com/api", () => ({
    getChessComProfile: mocks.getChessComProfile,
    getChessComAccount: mocks.getChessComAccount,
}));
vi.mock("@/utils/db", () => ({ query_players: mocks.queryPlayers }));

import { isOpponentUsername, lookupOpponentAccount, opponentPlayerIds } from "./opponentLookup";

function rejection(status: number): ErrorPayload {
    return {
        tag: "backend-error",
        category: "network",
        message: `remote service rejected the request with HTTP ${status}`,
        remoteHttpRejection: { status, authorizationSent: false },
    };
}

function perf(win: number, loss: number, draw: number) {
    return { last: { rating: 2800, date: 1 }, record: { win, loss, draw } };
}

beforeEach(() => {
    vi.clearAllMocks();
});

describe("isOpponentUsername", () => {
    test("accepts what each site allows and refuses everything else", () => {
        expect(isOpponentUsername("lichess", "DrNykterstein")).toBe(true);
        expect(isOpponentUsername("lichess", "a_b-9")).toBe(true);
        expect(isOpponentUsername("chesscom", "x")).toBe(true);
        for (const name of ["", "a", "a b", "a/b", "../x", "name?x=1", "x".repeat(31)]) {
            expect(isOpponentUsername("lichess", name)).toBe(false);
        }
        for (const name of ["", "a b", "a/b", "ü", "x".repeat(51)]) {
            expect(isOpponentUsername("chesscom", name)).toBe(false);
        }
    });
});

describe("lookupOpponentAccount on Lichess", () => {
    test("reports the site's spelling, title, real name, country and rated games", async () => {
        mocks.getLichessAccount.mockResolvedValue({
            id: "drnykterstein",
            username: "DrNykterstein",
            title: "GM",
            profile: { realName: " Magnus Carlsen ", flag: "NO" },
            count: { rated: 9876 },
        });

        expect(await lookupOpponentAccount("lichess", "drnykterstein")).toEqual({
            kind: "found",
            profile: {
                provider: "lichess",
                username: "DrNykterstein",
                title: "GM",
                realName: "Magnus Carlsen",
                country: "NO",
                ratedGames: 9876,
                closed: false,
            },
        });
        expect(mocks.getLichessAccount).toHaveBeenCalledWith({ username: "drnykterstein" });
    });

    test("reads the older first and last name fields and leaves out what is absent", async () => {
        mocks.getLichessAccount.mockResolvedValue({
            id: "someone",
            username: "Someone",
            profile: { firstName: "Ada", lastName: "Lovelace", country: "GB" },
        });

        expect(await lookupOpponentAccount("lichess", "someone")).toEqual({
            kind: "found",
            profile: {
                provider: "lichess",
                username: "Someone",
                realName: "Ada Lovelace",
                country: "GB",
                closed: false,
            },
        });

        mocks.getLichessAccount.mockResolvedValue({ id: "bare", username: "Bare" });

        expect(await lookupOpponentAccount("lichess", "bare")).toEqual({
            kind: "found",
            profile: { provider: "lichess", username: "Bare", closed: false },
        });
    });

    test("a closed account is its own outcome, because its games are gone", async () => {
        mocks.getLichessAccount.mockResolvedValue({
            id: "gone",
            username: "Gone",
            disabled: true,
        });

        expect(await lookupOpponentAccount("lichess", "gone")).toEqual({ kind: "closed" });
    });

    test("maps an unknown name, a rate limit and any other failure to their outcomes", async () => {
        mocks.getLichessAccount.mockRejectedValueOnce(rejection(404));
        expect(await lookupOpponentAccount("lichess", "nobody")).toEqual({ kind: "notFound" });

        mocks.getLichessAccount.mockRejectedValueOnce(rejection(429));
        expect(await lookupOpponentAccount("lichess", "nobody")).toEqual({ kind: "rateLimited" });

        mocks.getLichessAccount.mockRejectedValueOnce(rejection(500));
        expect(await lookupOpponentAccount("lichess", "nobody")).toEqual({ kind: "failed" });

        mocks.getLichessAccount.mockRejectedValueOnce(new Error("offline"));
        expect(await lookupOpponentAccount("lichess", "nobody")).toEqual({ kind: "failed" });

        mocks.getLichessAccount.mockResolvedValueOnce(null);
        expect(await lookupOpponentAccount("lichess", "nobody")).toEqual({ kind: "notFound" });
    });
});

describe("what a site answers is not trusted", () => {
    test("an answer naming an account the site cannot have is a failed lookup", async () => {
        mocks.getLichessAccount.mockResolvedValue({ id: "x", username: "../other" });
        expect(await lookupOpponentAccount("lichess", "someone")).toEqual({ kind: "failed" });

        mocks.getChessComProfile.mockResolvedValue({ username: "a b", closed: false });
        mocks.getChessComAccount.mockResolvedValue(null);
        expect(await lookupOpponentAccount("chesscom", "someone")).toEqual({ kind: "failed" });
    });

    test("profile text of the wrong type is left out and overlong text is cut", async () => {
        mocks.getLichessAccount.mockResolvedValue({
            id: "odd",
            username: "Odd",
            title: 7,
            profile: { realName: "x".repeat(500), flag: { code: "NO" } },
            count: { rated: "many" },
        });

        expect(await lookupOpponentAccount("lichess", "odd")).toEqual({
            kind: "found",
            profile: {
                provider: "lichess",
                username: "Odd",
                realName: "x".repeat(100),
                closed: false,
            },
        });
    });
});

describe("lookupOpponentAccount on Chess.com", () => {
    test("reports the profile and the rated games of every time control together", async () => {
        mocks.getChessComProfile.mockResolvedValue({
            username: "MagnusCarlsen",
            name: "Magnus Carlsen",
            title: "GM",
            countryCode: "NO",
            closed: false,
        });
        mocks.getChessComAccount.mockResolvedValue({
            chess_blitz: perf(10, 5, 2),
            chess_rapid: perf(3, 1, 1),
        });

        expect(await lookupOpponentAccount("chesscom", "magnuscarlsen")).toEqual({
            kind: "found",
            profile: {
                provider: "chesscom",
                username: "MagnusCarlsen",
                title: "GM",
                realName: "Magnus Carlsen",
                country: "NO",
                ratedGames: 22,
                closed: false,
            },
        });
    });

    test("a failed or unreadable statistics lookup still shows the profile", async () => {
        mocks.getChessComProfile.mockResolvedValue({ username: "Closed", closed: true });

        mocks.getChessComAccount.mockRejectedValueOnce(rejection(500));
        expect(await lookupOpponentAccount("chesscom", "closed")).toEqual({
            kind: "found",
            profile: { provider: "chesscom", username: "Closed", closed: true },
        });

        mocks.getChessComAccount.mockResolvedValueOnce(null);
        expect(await lookupOpponentAccount("chesscom", "closed")).toEqual({
            kind: "found",
            profile: { provider: "chesscom", username: "Closed", closed: true },
        });
    });

    test("a failed profile lookup never reaches the statistics and names its outcome", async () => {
        mocks.getChessComProfile.mockRejectedValueOnce(rejection(404));
        expect(await lookupOpponentAccount("chesscom", "nobody")).toEqual({ kind: "notFound" });

        mocks.getChessComProfile.mockRejectedValueOnce(rejection(429));
        expect(await lookupOpponentAccount("chesscom", "nobody")).toEqual({ kind: "rateLimited" });

        // A profile of an unexpected shape is rejected by the reader with a plain error.
        mocks.getChessComProfile.mockRejectedValueOnce(new Error("invalid response"));
        expect(await lookupOpponentAccount("chesscom", "nobody")).toEqual({ kind: "failed" });

        expect(mocks.getChessComAccount).not.toHaveBeenCalled();
    });
});

describe("opponentPlayerIds", () => {
    const file: DatabaseHandle = { id: { id: "opponent" }, kind: "database" };

    test("asks for each username by exact name and returns the distinct ids, lowest first", async () => {
        mocks.queryPlayers
            .mockResolvedValueOnce({ data: [{ id: 9 }, { id: 4 }], count: null })
            .mockResolvedValueOnce({ data: [{ id: 4 }], count: null })
            .mockResolvedValueOnce({ data: [], count: null });
        const signal = new AbortController().signal;

        const ids = await opponentPlayerIds(
            file,
            [
                { provider: "lichess", username: "DrNykterstein" },
                { provider: "chesscom", username: "MagnusCarlsen" },
                { provider: "chesscom", username: "Unplayed" },
            ],
            signal,
        );

        expect(ids).toEqual([4, 9]);
        expect(
            mocks.queryPlayers.mock.calls.map(([handle, query]) => [handle, query.name]),
        ).toEqual([
            [file, "DrNykterstein"],
            [file, "MagnusCarlsen"],
            [file, "Unplayed"],
        ]);
        for (const [, query, options] of mocks.queryPlayers.mock.calls) {
            expect(query.nameMatch).toBe("exact");
            expect(options).toEqual({ signal });
        }
    });
});
