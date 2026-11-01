import { beforeEach, describe, expect, test, vi } from "vitest";
import { INITIAL_FEN } from "chessops/fen";
import { cancellationError } from "@/platform/tauri";
import type { ArtifactPublication } from "@/bindings";
import { assertAccountExportTicketOrder } from "@/utils/tests/accountExportTicketOrder";

const mocks = vi.hoisted(() => ({
    downloadLichessGames: vi.fn(),
    logError: vi.fn(),
    getPublicLichessJson: vi.fn(),
    getAuthenticatedLichessAccount: vi.fn(),
    lexPgn: vi.fn(),
    releaseDownload: vi.fn(),
    withDownloadTicket: vi.fn(),
    progress: vi.fn(),
}));

vi.mock("@/platform/native", () => ({
    error: mocks.logError,
}));

vi.mock("@/platform/tauri", async () => {
    const actual = await vi.importActual<typeof import("@/platform/tauri")>("@/platform/tauri");
    return {
        ...actual,
        tauri: {
            ...actual.tauri,
            downloadLichessGames: mocks.downloadLichessGames,
            getPublicLichessJson: mocks.getPublicLichessJson,
            getAuthenticatedLichessAccount: mocks.getAuthenticatedLichessAccount,
            lexPgn: mocks.lexPgn,
        },
        withDownloadTicket: mocks.withDownloadTicket,
        tauriSubscriptions: { ...actual.tauriSubscriptions, progress: mocks.progress },
    };
});

import { convertToNormalized, downloadLichess, getBestMoves, getLichessAccount } from "./api";

const publication: ArtifactPublication = {
    handle: { id: { id: "artifact" }, kind: "fileWorkspace" },
    durability: "Durable",
};

describe("getBestMoves", () => {
    test("cloud PVs truncate at illegal or unparsable moves with aligned UCI and SAN", async () => {
        mocks.getPublicLichessJson.mockReset().mockResolvedValue(
            JSON.stringify({
                fen: INITIAL_FEN,
                knodes: 123,
                depth: 24,
                pvs: [
                    { cp: 35, moves: "e2e4 e7e5 e2e3 g1f3" },
                    { mate: 3, moves: "d2d4 invalid d7d5" },
                ],
            }),
        );

        await expect(
            getBestMoves(
                "tab",
                { t: "Infinite" },
                { fen: INITIAL_FEN, moves: [], extraOptions: [] },
            ),
        ).resolves.toEqual([
            100,
            [
                {
                    score: { value: { type: "cp", value: 35 }, wdl: null },
                    nodes: 123000n,
                    depth: 24,
                    multipv: 1,
                    nps: 0n,
                    uciMoves: ["e2e4", "e7e5"],
                    sanMoves: ["e4", "e5"],
                },
                {
                    score: { value: { type: "mate", value: 3 }, wdl: null },
                    nodes: 123000n,
                    depth: 24,
                    multipv: 2,
                    nps: 0n,
                    uciMoves: ["d2d4"],
                    sanMoves: ["d4"],
                },
            ],
        ]);
        expect(mocks.getPublicLichessJson).toHaveBeenCalledExactlyOnceWith({
            kind: "cloud_eval",
            fen: INITIAL_FEN,
            multi_pv: 1,
        });
    });

    test("drops a cloud PV with no legal moves", async () => {
        mocks.getPublicLichessJson.mockReset().mockResolvedValue(
            JSON.stringify({
                fen: INITIAL_FEN,
                knodes: 123,
                depth: 24,
                pvs: [{ cp: 35, moves: "e2e5" }],
            }),
        );

        await expect(
            getBestMoves(
                "tab",
                { t: "Infinite" },
                {
                    fen: INITIAL_FEN,
                    moves: [],
                    extraOptions: [{ name: "MultiPV", type: "string", value: "2" }],
                },
            ),
        ).resolves.toEqual([100, []]);
    });

    test("numbers kept cloud PVs contiguously after dropping an illegal first line", async () => {
        mocks.getPublicLichessJson.mockReset().mockResolvedValue(
            JSON.stringify({
                fen: INITIAL_FEN,
                knodes: 123,
                depth: 24,
                pvs: [
                    { cp: 35, moves: "e2e5" },
                    { cp: 24, moves: "e2e4 e7e5" },
                    { mate: 3, moves: "d2d4 d7d5" },
                ],
            }),
        );

        await expect(
            getBestMoves(
                "tab",
                { t: "Infinite" },
                {
                    fen: INITIAL_FEN,
                    moves: [],
                    extraOptions: [{ name: "MultiPV", type: "string", value: "3" }],
                },
            ),
        ).resolves.toMatchObject([
            100,
            [
                { multipv: 1, uciMoves: ["e2e4", "e7e5"], sanMoves: ["e4", "e5"] },
                { multipv: 2, uciMoves: ["d2d4", "d7d5"], sanMoves: ["d4", "d5"] },
            ],
        ]);
    });

    test("requests one cloud PV when the MultiPV option is not a number", async () => {
        // Cloud evaluations are cached per FEN and line count; use a position no other test caches.
        const AFTER_E4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
        mocks.getPublicLichessJson
            .mockReset()
            .mockResolvedValue(JSON.stringify({ fen: AFTER_E4, knodes: 123, depth: 24, pvs: [] }));

        await getBestMoves(
            "tab",
            { t: "Infinite" },
            {
                fen: AFTER_E4,
                moves: [],
                extraOptions: [{ name: "MultiPV", type: "string", value: "abc" }],
            },
        );
        expect(mocks.getPublicLichessJson).toHaveBeenCalledExactlyOnceWith({
            kind: "cloud_eval",
            fen: AFTER_E4,
            multi_pv: 1,
        });
    });
});

describe("getLichessAccount", () => {
    beforeEach(() => {
        mocks.logError.mockReset().mockResolvedValue(undefined);
        mocks.getPublicLichessJson.mockReset();
        mocks.getAuthenticatedLichessAccount.mockReset();
    });

    describe.each([
        {
            branch: "public",
            options: { username: "Player" },
            command: mocks.getPublicLichessJson,
            args: [{ kind: "account", username: "Player" }],
        },
        {
            branch: "authenticated",
            options: { handle: "native-handle" },
            command: mocks.getAuthenticatedLichessAccount,
            args: ["native-handle"],
        },
    ])("$branch account read", ({ options, command, args }) => {
        const sentinel = "response-body-only-sentinel";
        const invalidBodies = [
            { label: "empty object", body: "{}" },
            { label: "missing id", body: JSON.stringify({ username: "Player", sentinel }) },
            { label: "empty id", body: JSON.stringify({ id: "", username: "Player", sentinel }) },
            { label: "missing username", body: JSON.stringify({ id: "player", sentinel }) },
            {
                label: "empty username",
                body: JSON.stringify({ id: "player", username: "", sentinel }),
            },
            { label: "invalid JSON", body: JSON.stringify({ sentinel }) + " trailing" },
        ];

        test.each(invalidBodies)(
            "rejects $label and logs once without the body",
            async ({ body, label }) => {
                command.mockResolvedValue(body);
                let parseCause: unknown = new Error("Lichess returned an invalid response");
                if (label === "invalid JSON") {
                    try {
                        JSON.parse(body);
                    } catch (cause) {
                        parseCause = cause;
                    }
                }

                await expect(getLichessAccount(options)).rejects.toEqual(parseCause);

                expect(command).toHaveBeenCalledExactlyOnceWith(...args);
                expect(mocks.logError).toHaveBeenCalledExactlyOnceWith(
                    "Lichess account response was rejected",
                );
                expect(JSON.stringify(mocks.logError.mock.calls)).not.toContain(sentinel);
            },
        );

        test("preserves the parse cause when the logger rejects", async () => {
            const parseCause = new SyntaxError("invalid account JSON");
            const loggerFailure = new Error("logger unavailable");
            command.mockResolvedValue("invalid JSON");
            mocks.logError.mockRejectedValue(loggerFailure);
            const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
            const parse = vi.spyOn(JSON, "parse").mockImplementationOnce(() => {
                throw parseCause;
            });
            try {
                await expect(getLichessAccount(options)).rejects.toBe(parseCause);
                expect(mocks.logError).toHaveBeenCalledExactlyOnceWith(
                    "Lichess account response was rejected",
                );
                expect(consoleError).toHaveBeenCalledExactlyOnceWith(
                    "Lichess account response was rejected",
                    {
                        operation: "Lichess account lookup",
                        primaryFailure: { category: "validation", message: parseCause.message },
                        loggerFailure: { category: "unexpected", message: loggerFailure.message },
                    },
                );
            } finally {
                parse.mockRestore();
                consoleError.mockRestore();
            }
        });

        test("propagates a native rejection without logging", async () => {
            const cause = new Error("native command failed");
            command.mockRejectedValue(cause);

            await expect(getLichessAccount(options)).rejects.toBe(cause);

            expect(command).toHaveBeenCalledExactlyOnceWith(...args);
            expect(mocks.logError).not.toHaveBeenCalled();
        });

        test("returns a valid account without logging", async () => {
            const account = { id: "player", username: "Player", count: { all: 42 } };
            command.mockResolvedValue(JSON.stringify(account));

            await expect(getLichessAccount(options)).resolves.toEqual(account);

            expect(command).toHaveBeenCalledExactlyOnceWith(...args);
            expect(mocks.logError).not.toHaveBeenCalled();
        });
    });

    test("returns null without a request or log when no account is named", async () => {
        await expect(getLichessAccount({})).resolves.toBeNull();

        expect(mocks.getPublicLichessJson).not.toHaveBeenCalled();
        expect(mocks.getAuthenticatedLichessAccount).not.toHaveBeenCalled();
        expect(mocks.logError).not.toHaveBeenCalled();
    });
});

describe("convertToNormalized", () => {
    beforeEach(() => {
        mocks.logError.mockReset().mockResolvedValue(undefined);
        mocks.getPublicLichessJson.mockReset();
        mocks.lexPgn.mockReset();
    });

    const dummyGames = [
        {
            id: "game-0",
            uci: "e2e4",
            winner: null,
            speed: "blitz",
            mode: "rated",
            white: { name: "W0", rating: 1500 },
            black: { name: "B0", rating: 1500 },
            year: 2024,
            month: "01",
        },
        {
            id: "game-1",
            uci: "e2e4",
            winner: null,
            speed: "blitz",
            mode: "rated",
            white: { name: "W1", rating: 1600 },
            black: { name: "B1", rating: 1600 },
            year: 2024,
            month: "02",
        },
        {
            id: "game-2",
            uci: "e2e4",
            winner: null,
            speed: "blitz",
            mode: "rated",
            white: { name: "W2", rating: 1700 },
            black: { name: "B2", rating: 1700 },
            year: 2024,
            month: "03",
        },
        {
            id: "game-3",
            uci: "e2e4",
            winner: null,
            speed: "blitz",
            mode: "rated",
            white: { name: "W3", rating: 1800 },
            black: { name: "B3", rating: 1800 },
            year: 2024,
            month: "04",
        },
    ];

    test("retains successful siblings and logs diagnostic for ordinary failures", async () => {
        mocks.getPublicLichessJson.mockImplementation(async ({ game_id }: { game_id: string }) => {
            if (game_id === "game-1") throw new Error("Network timeout");
            return `[White "${game_id}"]\n[Black "Opponent"]\n\n1. e4 e5 *`;
        });

        mocks.lexPgn.mockImplementation(async (pgn: string) => {
            if (pgn.includes("game-2")) throw new Error("Invalid PGN syntax");
            return [];
        });

        const normalized = await convertToNormalized(dummyGames);
        expect(normalized.games).toHaveLength(2);
        expect(normalized.games[0].id).toBe(0);
        expect(normalized.games[1].id).toBe(3);
        expect(normalized.failures).toHaveLength(2);
        expect(normalized.failures.map(({ item, index }) => ({ item, index }))).toEqual([
            { item: dummyGames[1], index: 1 },
            { item: dummyGames[2], index: 2 },
        ]);
        expect(mocks.logError).toHaveBeenCalledTimes(2);
        expect(mocks.logError).toHaveBeenNthCalledWith(
            1,
            expect.stringContaining("Lichess game normalization item 1 failed"),
        );
        expect(mocks.logError).toHaveBeenNthCalledWith(
            2,
            expect.stringContaining("Lichess game normalization item 2 failed"),
        );
    });

    test("returns empty failure metadata when every game succeeds", async () => {
        mocks.getPublicLichessJson.mockResolvedValue(`[White "P"]\n[Black "O"]\n\n1. e4 e5 *`);
        mocks.lexPgn.mockResolvedValue([]);

        const normalized = await convertToNormalized([dummyGames[0]]);

        expect(normalized.games).toHaveLength(1);
        expect(normalized.failures).toEqual([]);
        expect(mocks.logError).not.toHaveBeenCalled();
    });

    test("checkpoint 2: abort signal after getLichessGame PGN fetch before parsePGN rejects without diagnostic", async () => {
        const controller = new AbortController();

        mocks.getPublicLichessJson.mockImplementation(async () => {
            controller.abort();
            return `[White "Player"]\n[Black "Opponent"]\n\n1. e4 e5 *`;
        });

        const promise = convertToNormalized([dummyGames[0]], { signal: controller.signal });
        await expect(promise).rejects.toMatchObject({ name: "AbortError" });
        expect(mocks.lexPgn).not.toHaveBeenCalled();
        expect(mocks.logError).not.toHaveBeenCalled();
    });

    test("mixed completed/cancelled parses: rejection on cancellation without diagnostic or partial results", async () => {
        const controller = new AbortController();

        mocks.getPublicLichessJson.mockResolvedValue(`[White "P"]\n[Black "O"]\n\n1. e4 e5 *`);
        mocks.lexPgn.mockImplementation(
            async (_pgn: string, _options?: { signal?: AbortSignal }) => {
                if (mocks.lexPgn.mock.calls.length === 1) {
                    return []; // game 0 completes
                }
                // game 1 gets cancelled during lexing
                controller.abort();
                throw cancellationError();
            },
        );

        const promise = convertToNormalized(dummyGames, { signal: controller.signal });
        await expect(promise).rejects.toThrow("Cancellation");
        expect(mocks.logError).not.toHaveBeenCalled();
    });
});

describe("downloadLichess", () => {
    test("installs the ticket listener before the native entry frame while download is pending", async () => {
        await assertAccountExportTicketOrder({
            progressMock: mocks.progress,
            nativeMock: mocks.downloadLichessGames,
            download: (onTicket) =>
                downloadLichess("account", { id: "destination" }, "player", null, onTicket),
            publication,
        });
    });

    beforeEach(() => {
        mocks.downloadLichessGames.mockReset().mockResolvedValue(publication);
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

    test("passes the prepared ticket as the native job id", async () => {
        const handle = { id: "account" };
        const destination = { id: "destination" };

        await expect(
            downloadLichess(handle.id, destination, "player", 123, vi.fn()),
        ).resolves.toEqual(publication);
        expect(mocks.downloadLichessGames).toHaveBeenCalledWith(
            handle.id,
            destination,
            "player_lichess.pgn",
            "player",
            123n,
            "prepared-ticket",
        );
    });

    test("returns an uncertain publication unchanged", async () => {
        const uncertain: ArtifactPublication = {
            handle: publication.handle,
            durability: { DurabilityUncertain: "DownloadTargetReplacement" },
        };
        mocks.downloadLichessGames.mockResolvedValue(uncertain);

        await expect(
            downloadLichess("account", { id: "destination" }, "player", null, vi.fn()),
        ).resolves.toEqual(uncertain);
        expect(mocks.downloadLichessGames).toHaveBeenCalledTimes(1);
        expect(mocks.releaseDownload).not.toHaveBeenCalled();
    });

    test("releases the prepared ticket when the download command rejects", async () => {
        const failure = new Error("download failed");
        mocks.downloadLichessGames.mockRejectedValue(failure);

        await expect(
            downloadLichess("account", { id: "destination" }, "player", null, vi.fn()),
        ).rejects.toBe(failure);
        expect(mocks.releaseDownload).toHaveBeenCalledWith("prepared-ticket");
    });
});
