import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    chessriddleAccount: vi.fn(),
    connectChessriddle: vi.fn(),
    disconnectChessriddle: vi.fn(),
    chessriddleTrainingAvailable: vi.fn(),
    chessriddleTrainingNext: vi.fn(),
    chessriddleMistakeCount: vi.fn(),
    chessriddleTrainingSubmit: vi.fn(),
    chessriddleOpenUpgrade: vi.fn(),
    chessriddleTrainingSettings: vi.fn(),
    chessriddleSaveTrainingSettings: vi.fn(),
    chessriddleTrainingMotifs: vi.fn(),
    chessriddleOpenWebsite: vi.fn(),
    closeSplashscreen: vi.fn(),
    releasePreviousDocumentOperations: vi.fn(),
    startGame: vi.fn(),
    getGameState: vi.fn(),
    makeGameMove: vi.fn(),
    takeBackGameMove: vi.fn(),
    resignGame: vi.fn(),
    abortGame: vi.fn(),
    getGameEngineLogs: vi.fn(),
    getProgress: vi.fn(),
    clearProgress: vi.fn(),
    cancelDownload: vi.fn(),
    cancelDownloadForProgress: vi.fn(),
    importAccountGames: vi.fn(),
    downloadLichessGames: vi.fn(),
    downloadChessComGames: vi.fn(),
    prepareNativeRead: vi.fn(),
    cancelNativeRead: vi.fn(),
    prepareDownload: vi.fn(),
    prepareConversion: vi.fn(),
    releaseConversion: vi.fn(),
    cancelConversion: vi.fn(),
    convertPgn: vi.fn(),
    releaseDownload: vi.fn(),
    prepareAnalysis: vi.fn(),
    cancelAnalysis: vi.fn(),
    getGames: vi.fn(),
    searchPositionsStats: vi.fn(),
    getDbGame: vi.fn(),
    inferGameOrientation: vi.fn(),
    countPgnGames: vi.fn(),
    fileRevision: vi.fn(),
    readGame: vi.fn(),
    readGames: vi.fn(),
    deleteGame: vi.fn(),
    lexPgn: vi.fn(),
    listFileWorkspace: vi.fn(),
    logError: vi.fn(),
    getCurrentWindow: vi.fn(),
    windowListen: vi.fn(),
    listeners: new Map<string, (event: any) => void>(),
}));

test.each(["chessriddleAccount", "connectChessriddle", "disconnectChessriddle"] as const)(
    "%s unwraps native replies and keeps account errors closed",
    async (command) => {
        const { tauri } = await import("./tauri");
        const { ChessRiddleCommandError } = await import("./chessriddle");
        const data =
            command === "disconnectChessriddle"
                ? { status: "notFound" }
                : { status: "disconnected" };
        mocks[command].mockResolvedValue({ status: "ok", data });
        await expect(tauri[command]()).resolves.toEqual(data);
        for (const code of [
            "unavailable",
            "busy",
            "storage",
            "network",
            "rateLimited",
            "server",
            "invalidGrant",
            "authentication",
            "invalidLink",
            "browser",
            "alreadyConnected",
            "notConnected",
            "noMatch",
            "dailyLimit",
            "updateRequired",
            "invalidRequest",
            "submissionInProgress",
            "engineTimeout",
            "engineBusy",
            "engineUnavailable",
        ]) {
            mocks[command].mockResolvedValue({ status: "error", error: code });
            await expect(tauri[command]()).rejects.toMatchObject({
                name: "ChessRiddleCommandError",
                code,
            });
        }
        mocks[command].mockRejectedValue("network");
        await expect(tauri[command]()).rejects.toMatchObject({ code: "network" });
        mocks[command].mockRejectedValue(new Error("private server diagnostic"));
        await expect(tauri[command]()).rejects.toEqual(new ChessRiddleCommandError("server"));
    },
);

test.each([
    "chessriddleTrainingAvailable",
    "chessriddleTrainingNext",
    "chessriddleMistakeCount",
    "chessriddleTrainingSubmit",
    "chessriddleOpenUpgrade",
    "chessriddleTrainingSettings",
    "chessriddleSaveTrainingSettings",
    "chessriddleTrainingMotifs",
    "chessriddleOpenWebsite",
] as const)("%s uses the closed ChessRiddle boundary", async (command) => {
    const { tauri } = await import("./tauri");
    // Each command has its own public arity. The native mock tests the common adapter.
    const invoke = async () => {
        switch (command) {
            case "chessriddleTrainingAvailable":
                return tauri.chessriddleTrainingAvailable();
            case "chessriddleTrainingNext":
                return tauri.chessriddleTrainingNext("tactics", [], 0, null);
            case "chessriddleMistakeCount":
                return tauri.chessriddleMistakeCount();
            case "chessriddleTrainingSubmit":
                return tauri.chessriddleTrainingSubmit({
                    puzzleId: 1,
                    source: "tactics",
                    decisionFen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
                    tree: { move: "", children: [] },
                    elapsedMs: 0,
                    solutionShown: true,
                    idempotencyKey: "00000000-0000-4000-8000-000000000001",
                    motif: null,
                });
            case "chessriddleOpenUpgrade":
                return tauri.chessriddleOpenUpgrade();
            case "chessriddleTrainingSettings":
                return tauri.chessriddleTrainingSettings();
            case "chessriddleSaveTrainingSettings":
                return tauri.chessriddleSaveTrainingSettings({
                    difficulty: 0,
                    motif: null,
                    showTimer: false,
                    showMoveCounter: false,
                    timerMode: "up",
                    timerDuration: 300,
                });
            case "chessriddleTrainingMotifs":
                return tauri.chessriddleTrainingMotifs();
            case "chessriddleOpenWebsite":
                return tauri.chessriddleOpenWebsite();
        }
    };
    mocks[command].mockResolvedValue({ status: "ok", data: null });
    await expect(invoke()).resolves.toBeNull();
    for (const code of [
        "notConnected",
        "dailyLimit",
        "updateRequired",
        "invalidRequest",
        "submissionInProgress",
        "engineTimeout",
        "engineBusy",
        "engineUnavailable",
    ]) {
        mocks[command].mockResolvedValue({ status: "error", error: code });
        await expect(invoke()).rejects.toMatchObject({ name: "ChessRiddleCommandError", code });
    }
    mocks[command].mockRejectedValue(new Error("private diagnostic"));
    await expect(invoke()).rejects.toMatchObject({ code: "server", message: "server" });
});

test("getDbGame forwards identity as the third argument and owns its abort ticket", async () => {
    const { tauri } = await import("./tauri");
    const database = { id: { id: "db" }, kind: "database" } as const;
    const identity = {
        locator: {
            collection: "11111111-1111-4111-8111-111111111111",
            generation: "old",
            ordinal: 2,
            stamp: "a".repeat(64),
        },
        signature: { white: "W", black: "B", event: "E", site: null, date: null, round: null },
    };
    mocks.getDbGame.mockResolvedValue({ status: "ok", data: { kind: "missing" } });
    expect(await tauri.getDbGame(database, 42, identity)).toEqual({ kind: "missing" });
    expect(mocks.getDbGame).toHaveBeenLastCalledWith(database, 42, identity, null);
    mocks.prepareNativeRead.mockResolvedValue({ status: "ok", data: "recent-ticket" });
    const controller = new AbortController();
    await tauri.getDbGame(database, 42, null, { signal: controller.signal });
    expect(mocks.getDbGame).toHaveBeenLastCalledWith(database, 42, null, "recent-ticket");
});

vi.mock("./native", () => ({ error: mocks.logError, getCurrentWindow: mocks.getCurrentWindow }));

test("orientation inference unwraps success and normalizes typed failures", async () => {
    const database = { id: { id: "db" }, kind: "database" } as const;
    for (const data of [null, "black"] as const) {
        mocks.inferGameOrientation.mockResolvedValue({ status: "ok", data });
        expect(await tauri.inferGameOrientation(database, 42)).toBe(data);
        expect(mocks.inferGameOrientation).toHaveBeenLastCalledWith(database, 42);
    }
    mocks.inferGameOrientation.mockResolvedValue({
        status: "error",
        error: { tag: "backend-error", category: "database", message: "Inference failed" },
    });
    await expect(tauri.inferGameOrientation(database, 42)).rejects.toBeInstanceOf(
        TauriCommandError,
    );
});

vi.mock("@/bindings/generated", () => ({
    commands: {
        chessriddleAccount: mocks.chessriddleAccount,
        connectChessriddle: mocks.connectChessriddle,
        disconnectChessriddle: mocks.disconnectChessriddle,
        chessriddleTrainingAvailable: mocks.chessriddleTrainingAvailable,
        chessriddleTrainingNext: mocks.chessriddleTrainingNext,
        chessriddleMistakeCount: mocks.chessriddleMistakeCount,
        chessriddleTrainingSubmit: mocks.chessriddleTrainingSubmit,
        chessriddleOpenUpgrade: mocks.chessriddleOpenUpgrade,
        chessriddleTrainingSettings: mocks.chessriddleTrainingSettings,
        chessriddleSaveTrainingSettings: mocks.chessriddleSaveTrainingSettings,
        chessriddleTrainingMotifs: mocks.chessriddleTrainingMotifs,
        chessriddleOpenWebsite: mocks.chessriddleOpenWebsite,
        closeSplashscreen: mocks.closeSplashscreen,
        releasePreviousDocumentOperations: mocks.releasePreviousDocumentOperations,
        startGame: mocks.startGame,
        getGameState: mocks.getGameState,
        makeGameMove: mocks.makeGameMove,
        takeBackGameMove: mocks.takeBackGameMove,
        resignGame: mocks.resignGame,
        abortGame: mocks.abortGame,
        getGameEngineLogs: mocks.getGameEngineLogs,
        getProgress: mocks.getProgress,
        clearProgress: mocks.clearProgress,
        cancelDownload: mocks.cancelDownload,
        cancelDownloadForProgress: mocks.cancelDownloadForProgress,
        importAccountGames: mocks.importAccountGames,
        downloadLichessGames: mocks.downloadLichessGames,
        downloadChessComGames: mocks.downloadChessComGames,
        prepareNativeRead: mocks.prepareNativeRead,
        cancelNativeRead: mocks.cancelNativeRead,
        prepareDownload: mocks.prepareDownload,
        prepareConversion: mocks.prepareConversion,
        releaseConversion: mocks.releaseConversion,
        cancelConversion: mocks.cancelConversion,
        convertPgn: mocks.convertPgn,
        releaseDownload: mocks.releaseDownload,
        prepareAnalysis: mocks.prepareAnalysis,
        cancelAnalysis: mocks.cancelAnalysis,
        getGames: mocks.getGames,
        searchPositionsStats: mocks.searchPositionsStats,
        getDbGame: mocks.getDbGame,
        inferGameOrientation: mocks.inferGameOrientation,
        countPgnGames: mocks.countPgnGames,
        fileRevision: mocks.fileRevision,
        readGame: mocks.readGame,
        readGames: mocks.readGames,
        deleteGame: mocks.deleteGame,
        lexPgn: mocks.lexPgn,
        listFileWorkspace: mocks.listFileWorkspace,
    },
    events: Object.fromEntries(
        [
            "clockUpdateEvent",
            "gameMoveEvent",
            "gameOverEvent",
            "progressEvent",
            "databaseContentFailure",
        ].map((name) => [
            name,
            {
                listen: vi.fn(async (callback) => {
                    mocks.listeners.set(name, callback);
                    return vi.fn();
                }),
            },
        ]),
    ),
}));

import { normalizeError } from "./errors";
import { TauriCommandError, tauri, tauriSubscriptions, unwrapCommand } from "./tauri";

const wireState = {
    gameId: "game",
    session: 1,
    revision: 2,
    status: "playing",
    initialFen: "start",
    moves: [],
    currentFen: "start",
    ply: 0,
    turn: "white",
    whiteTime: null,
    blackTime: null,
    whitePlayer: "White",
    blackPlayer: "Black",
};

describe("tauri command facade", () => {
    beforeEach(() => {
        mocks.releasePreviousDocumentOperations.mockReset();
        mocks.prepareNativeRead.mockReset();
        mocks.cancelNativeRead.mockReset();
        mocks.prepareDownload.mockReset();
        mocks.releaseDownload.mockReset();
        mocks.importAccountGames.mockReset().mockResolvedValue({ status: "ok", data: null });
        mocks.downloadLichessGames.mockReset().mockResolvedValue({ status: "ok", data: null });
        mocks.downloadChessComGames.mockReset().mockResolvedValue({ status: "ok", data: null });
        mocks.prepareAnalysis.mockReset();
        mocks.cancelAnalysis.mockReset();
        mocks.getGames.mockReset();
        mocks.searchPositionsStats.mockReset();
        mocks.countPgnGames.mockReset();
        mocks.fileRevision.mockReset();
        mocks.readGame.mockReset();
        mocks.readGames.mockReset();
        mocks.deleteGame.mockReset();
        mocks.lexPgn.mockReset();
        mocks.listFileWorkspace.mockReset();
        mocks.logError.mockReset().mockResolvedValue(undefined);
        mocks.windowListen.mockReset().mockResolvedValue(vi.fn());
        mocks.getCurrentWindow.mockReset().mockReturnValue({ listen: mocks.windowListen });
    });
    test("exposes the previous-document sweep with normalized failures", async () => {
        mocks.releasePreviousDocumentOperations.mockResolvedValueOnce({ status: "ok", data: null });
        await expect(tauri.releasePreviousDocumentOperations()).resolves.toBeNull();
        expect(mocks.releasePreviousDocumentOperations).toHaveBeenCalledExactlyOnceWith();
        mocks.releasePreviousDocumentOperations.mockResolvedValueOnce({
            status: "error",
            error: {
                tag: "backend-error",
                category: "conflict",
                message: "native operation registry poisoned",
            },
        });
        await expect(tauri.releasePreviousDocumentOperations()).rejects.toBeInstanceOf(
            TauriCommandError,
        );
    });
    test("normalizes progress event generations from decimal string wire values", async () => {
        const callback = vi.fn();
        const payload = {
            id: "job",
            generation: "7",
            progress: 100,
            finished: true,
            state: "succeeded",
            cleared: false,
        };
        const unlisten = await tauriSubscriptions.progress(callback);
        mocks.listeners.get("progressEvent")?.({ payload, id: 9 });
        expect(callback).toHaveBeenCalledWith({
            payload: { ...payload, generation: 7n },
            id: 9,
        });
        unlisten();
    });

    test("database content failure subscriptions register the callback", async () => {
        const callback = vi.fn();
        const unlisten = await tauriSubscriptions.databaseContentFailure(callback);
        expect(mocks.listeners.get("databaseContentFailure")).toBe(callback);
        unlisten();
    });

    test.each([
        "0",
        "9007199254740991",
        "9007199254740992",
        "9007199254740993",
        "9007199254740994",
        "18446744073709551615",
    ])("preserves exact progress generation %s across every adapter", async (generation) => {
        const item = {
            id: "job",
            generation,
            progress: 35,
            finished: false,
            state: "running" as const,
        };
        const expected = { ...item, generation: BigInt(generation) };
        mocks.getProgress.mockResolvedValueOnce({ status: "ok", data: item });
        await expect(tauri.getProgress("job")).resolves.toEqual(expected);
        mocks.clearProgress.mockResolvedValueOnce({ status: "ok", data: generation });
        await expect(tauri.clearProgress("job")).resolves.toBe(BigInt(generation));
        const callback = vi.fn();
        const unlisten = await tauriSubscriptions.progress(callback);
        mocks.listeners.get("progressEvent")?.({ payload: { ...item, cleared: false } });
        expect(callback.mock.calls[0][0].payload).toEqual({ ...expected, cleared: false });
        unlisten();
    });

    test.each([
        0,
        1n,
        null,
        "",
        "00",
        "01",
        "+1",
        "-1",
        " 1",
        "1 ",
        "1.0",
        "1e3",
        "١",
        "18446744073709551616",
    ])(
        "rejects malformed incoming generation %s through command and listener errors",
        async (generation) => {
            const item = {
                id: "job",
                generation,
                progress: 20,
                finished: false,
                state: "running",
                cleared: false,
            };
            mocks.getProgress.mockResolvedValueOnce({ status: "ok", data: item });
            await expect(tauri.getProgress("job")).rejects.toBeInstanceOf(TauriCommandError);
            mocks.clearProgress.mockResolvedValueOnce({ status: "ok", data: generation });
            await expect(tauri.clearProgress("job")).rejects.toBeInstanceOf(TauriCommandError);
            const callback = vi.fn();
            const onError = vi.fn();
            const unlisten = await tauriSubscriptions.progress(callback, onError);
            const event = { payload: item };
            mocks.listeners.get("progressEvent")?.(event);
            expect(callback).not.toHaveBeenCalled();
            expect(onError).toHaveBeenCalledWith(
                expect.objectContaining({ message: expect.stringContaining("generation") }),
                event,
            );
            unlisten();
        },
    );

    test("normalizes progress snapshots and the generation used by download cancellation", async () => {
        const item = {
            id: "job",
            generation: "7",
            progress: 20,
            finished: false,
            state: "running",
        };
        mocks.getProgress.mockResolvedValueOnce({ status: "ok", data: item });
        await expect(tauri.getProgress("job")).resolves.toEqual({ ...item, generation: 7n });
        mocks.getProgress.mockResolvedValueOnce({ status: "ok", data: null });
        await expect(tauri.getProgress("missing")).resolves.toBeNull();
        // cancelDownload returns only a boolean; downloadJobs obtains clearedGeneration here.
        mocks.cancelDownload.mockResolvedValueOnce({ status: "ok", data: true });
        await expect(tauri.cancelDownload("ticket")).resolves.toBe(true);
        mocks.cancelDownloadForProgress.mockResolvedValueOnce({ status: "ok", data: true });
        await expect(tauri.cancelDownloadForProgress("job")).resolves.toBe(true);
        expect(mocks.cancelDownloadForProgress).toHaveBeenCalledWith("job");
        mocks.clearProgress.mockResolvedValueOnce({ status: "ok", data: "9" });
        await expect(tauri.clearProgress("job")).resolves.toBe(9n);
    });

    describe("download sinceMs encoding", () => {
        const destination = { id: "destination" };
        const accountRequest = {
            provider: "lichess",
            account: "Player",
            accountHandle: "opaque-account",
            destination,
            pendingBatch: null,
            target: {
                kind: "unlinked" as const,
                database: { id: { id: "database" }, kind: "database" as const },
                title: "Player Lichess",
            },
        };
        describe.each([
            {
                name: "importAccountGames",
                command: mocks.importAccountGames,
                call: (sinceMs: bigint | null) =>
                    tauri.importAccountGames({ ...accountRequest, sinceMs }),
                wireArgs: (sinceMs: number | null) => [{ ...accountRequest, sinceMs }],
            },
        ])("$name", ({ command, call, wireArgs }) => {
            test("encodes a timestamp as a JSON number and preserves other arguments", async () => {
                await call(1_700_000_000_000n);

                expect(() => JSON.stringify(command.mock.calls[0])).not.toThrow();
                expect(command).toHaveBeenCalledExactlyOnceWith(...wireArgs(1_700_000_000_000));
            });

            test("passes null through unchanged", async () => {
                await call(null);

                expect(command).toHaveBeenCalledExactlyOnceWith(...wireArgs(null));
            });

            test.each([-1n, BigInt(Number.MAX_SAFE_INTEGER) + 1n])(
                "rejects invalid timestamp %s before native dispatch",
                async (sinceMs) => {
                    const result = call(sinceMs);

                    await expect(result).rejects.toBeInstanceOf(TauriCommandError);
                    await expect(result).rejects.toThrow(
                        "sinceMs must be a nonnegative safe integer",
                    );
                    expect(command).not.toHaveBeenCalled();
                },
            );
        });
    });

    test("a signal reserves a ticket and passes it outside positional arguments", async () => {
        mocks.prepareNativeRead.mockResolvedValue({ status: "ok", data: "ticket-1" });
        mocks.getGames.mockResolvedValue({ status: "ok", data: { data: [], count: 0 } });
        const signal = new AbortController().signal;
        await tauri.getGames({ id: { id: "db" }, kind: "database" }, {} as never, { signal });
        expect(mocks.getGames).toHaveBeenCalledWith(
            { id: { id: "db" }, kind: "database" },
            {},
            "ticket-1",
        );
    });

    test("withDownloadTicket owns the generated reservation lifecycle", async () => {
        const { withDownloadTicket } = await import("./tauri");
        mocks.prepareDownload.mockResolvedValue({ status: "ok", data: "download-ticket" });
        mocks.releaseDownload.mockResolvedValue({ status: "ok", data: null });

        const continuation = vi.fn(async (ticket: string) => {
            expect(ticket).toBe("download-ticket");
            throw new Error("download failed");
        });
        await expect(withDownloadTicket(continuation)).rejects.toThrow("download failed");
        expect(mocks.prepareDownload).toHaveBeenCalledOnce();
        expect(mocks.releaseDownload).toHaveBeenCalledWith("download-ticket");

        mocks.prepareDownload.mockResolvedValue({ status: "ok", data: "successful-ticket" });
        await expect(withDownloadTicket(async (ticket) => ticket)).resolves.toBe(
            "successful-ticket",
        );
        expect(mocks.releaseDownload).toHaveBeenCalledOnce();
    });

    test("conversion preparation forwards exact ticket and releases failure without masking it", async () => {
        const { withConversionTicket } = await import("./tauri");
        mocks.prepareConversion.mockResolvedValue({ status: "ok", data: "conversion-ticket" });
        mocks.releaseConversion.mockResolvedValue({ status: "ok", data: null });
        const failure = new Error("Cancellation");
        const run = vi.fn(async (ticket: string) => {
            expect(ticket).toBe("conversion-ticket");
            throw failure;
        });
        await expect(withConversionTicket(run)).rejects.toBe(failure);
        expect(mocks.releaseConversion).toHaveBeenCalledWith("conversion-ticket");
        mocks.releaseConversion.mockClear();
        await expect(withConversionTicket(async () => "committed")).resolves.toBe("committed");
        expect(mocks.releaseConversion).not.toHaveBeenCalled();
    });

    test("conversion preparation rejection never dispatches and cancel failures remain typed", async () => {
        const { tauri, withConversionTicket } = await import("./tauri");
        mocks.prepareConversion.mockResolvedValue({
            status: "error",
            error: {
                tag: "backend-error",
                category: "resource-limit",
                message: "Too many operations",
            },
        });
        const run = vi.fn();
        await expect(withConversionTicket(run)).rejects.toThrow("Too many operations");
        expect(run).not.toHaveBeenCalled();
        mocks.cancelConversion.mockResolvedValue({
            status: "error",
            error: { tag: "backend-error", category: "permission", message: "Permission denied" },
        });
        await expect(tauri.cancelConversion("exact-ticket")).rejects.toMatchObject({
            details: { category: "permission" },
        });
        expect(mocks.cancelConversion).toHaveBeenCalledWith("exact-ticket");
    });

    test("convertPgn forwards all six generated arguments including nullable ticket", async () => {
        const { tauri } = await import("./tauri");
        const database = { id: { id: "db" }, kind: "database" } as const;
        mocks.convertPgn.mockResolvedValue({ status: "ok", data: null });
        await tauri.convertPgn("operation", [], database, "Title", null, "exact-ticket");
        expect(mocks.convertPgn).toHaveBeenCalledWith(
            "operation",
            [],
            database,
            "Title",
            null,
            "exact-ticket",
        );
        await tauri.convertPgn("account", [], database, "Account", null, null);
        expect(mocks.convertPgn).toHaveBeenLastCalledWith(
            "account",
            [],
            database,
            "Account",
            null,
            null,
        );
    });

    test("pgn and workspace reads reserve tickets and pass outside positional arguments", async () => {
        mocks.prepareNativeRead.mockResolvedValue({ status: "ok", data: "ticket-pgn" });
        mocks.countPgnGames.mockResolvedValue({ status: "ok", data: 42 });
        mocks.fileRevision.mockResolvedValue({ status: "ok", data: "dev:ino:revision" });
        mocks.readGame.mockResolvedValue({
            status: "ok",
            data: { pgn: "game", stamp: "a".repeat(64), revision: "r1", present: true },
        });
        const page = [
            {
                pgn: '[Event "A"]',
                stamp: "a".repeat(64),
                revision: "r1",
                present: true,
            },
        ];
        mocks.readGames.mockResolvedValue({ status: "ok", data: page });
        mocks.deleteGame.mockResolvedValue({ status: "ok", data: null });
        mocks.lexPgn.mockResolvedValue({ status: "ok", data: [] });
        mocks.listFileWorkspace.mockResolvedValue({
            status: "ok",
            data: { entries: [], unread: [] },
        });

        const signal = new AbortController().signal;
        const fileHandle = { id: { id: "f1" }, kind: "fileWorkspace" as const };
        const wsHandle = { id: { id: "ws1" }, kind: "fileWorkspace" as const };

        await tauri.countPgnGames(fileHandle, { signal });
        expect(mocks.countPgnGames).toHaveBeenCalledWith(fileHandle, "ticket-pgn");

        await expect(tauri.readGames(fileHandle, 0, 10, { signal })).resolves.toEqual(page);
        expect(mocks.readGames).toHaveBeenCalledWith(fileHandle, 0, 10, "ticket-pgn");

        await tauri.deleteGame(fileHandle, 0, page[0].stamp, page[0].revision);
        expect(mocks.deleteGame).toHaveBeenCalledWith(
            fileHandle,
            0,
            page[0].stamp,
            page[0].revision,
        );

        await tauri.readGame(fileHandle, 2, { signal });
        expect(mocks.readGame).toHaveBeenCalledWith(fileHandle, 2, "ticket-pgn");

        await tauri.fileRevision(fileHandle, { signal });
        expect(mocks.fileRevision).toHaveBeenCalledWith(fileHandle, "ticket-pgn");

        await tauri.lexPgn("1. e4", { signal });
        expect(mocks.lexPgn).toHaveBeenCalledWith("1. e4", "ticket-pgn");

        await tauri.listFileWorkspace(wsHandle, { signal });
        expect(mocks.listFileWorkspace).toHaveBeenCalledWith(wsHandle, "ticket-pgn");

        // Without signal, passes null
        await tauri.countPgnGames(fileHandle);
        expect(mocks.countPgnGames).toHaveBeenCalledWith(fileHandle, null);

        await tauri.readGames(fileHandle, 0, 10);
        expect(mocks.readGames).toHaveBeenCalledWith(fileHandle, 0, 10, null);

        await tauri.readGame(fileHandle, 2);
        expect(mocks.readGame).toHaveBeenCalledWith(fileHandle, 2, null);

        await tauri.fileRevision(fileHandle);
        expect(mocks.fileRevision).toHaveBeenCalledWith(fileHandle, null);

        await tauri.lexPgn("1. e4");
        expect(mocks.lexPgn).toHaveBeenCalledWith("1. e4", null);

        await tauri.listFileWorkspace(wsHandle);
        expect(mocks.listFileWorkspace).toHaveBeenCalledWith(wsHandle, null);
    });

    describe("optional lex timing hook", () => {
        afterEach(() => vi.unstubAllGlobals());

        test("preserves the command result when the hook is absent", async () => {
            vi.stubGlobal("__verifyAppRecordLexPgn", undefined);
            mocks.lexPgn.mockResolvedValueOnce({ status: "ok", data: [] });
            await expect(tauri.lexPgn("1. e4")).resolves.toEqual([]);
            mocks.lexPgn.mockRejectedValueOnce(new Error("lexer unavailable"));
            await expect(tauri.lexPgn("1. e4")).rejects.toBeInstanceOf(TauriCommandError);
        });

        async function expectLexTiming(
            settle: (result: ReturnType<typeof tauri.lexPgn>) => Promise<unknown>,
        ) {
            const mark = vi.fn();
            vi.stubGlobal("__verifyAppRecordLexPgn", mark);
            const startedAt = performance.now();
            await settle(tauri.lexPgn("1. e4"));
            const elapsedMs = performance.now() - startedAt;
            expect(mark).toHaveBeenCalledOnce();
            const durationMs = mark.mock.calls[0][0];
            expect(Number.isFinite(durationMs)).toBe(true);
            expect(durationMs).toBeGreaterThanOrEqual(0);
            expect(durationMs).toBeLessThanOrEqual(elapsedMs);

            mocks.closeSplashscreen.mockResolvedValueOnce({ status: "ok", data: null });
            await tauri.closeSplashscreen();
            expect(mark).toHaveBeenCalledOnce();
        }

        test("records elapsed time in finally on success", async () => {
            mocks.lexPgn.mockResolvedValueOnce({ status: "ok", data: [] });
            await expectLexTiming((result) => expect(result).resolves.toEqual([]));
        });

        test("records elapsed time in finally on rejection", async () => {
            mocks.lexPgn.mockRejectedValueOnce(new Error("lexer unavailable"));
            await expectLexTiming((result) =>
                expect(result).rejects.toBeInstanceOf(TauriCommandError),
            );
        });
    });

    test("window focus subscriptions return the native listener cleanup", async () => {
        const dispose = vi.fn();
        const callback = vi.fn();
        mocks.windowListen.mockResolvedValueOnce(dispose);

        const unlisten = await tauriSubscriptions.windowFocus(callback);

        expect(mocks.windowListen).toHaveBeenCalledWith("tauri://focus", callback);
        unlisten();
        expect(dispose).toHaveBeenCalledOnce();
    });

    test("abort before preparation rejects without native dispatch", async () => {
        const controller = new AbortController();
        controller.abort();
        await expect(
            tauri.getGames({ id: { id: "db" }, kind: "database" }, {} as never, {
                signal: controller.signal,
            }),
        ).rejects.toMatchObject({ details: { category: "cancelled" } });
        expect(mocks.prepareNativeRead).not.toHaveBeenCalled();
        expect(mocks.getGames).not.toHaveBeenCalled();
    });

    test("abort during preparation cancels the eventual reservation without dispatch", async () => {
        const controller = new AbortController();
        let finishPreparation!: (value: unknown) => void;
        mocks.prepareNativeRead.mockReturnValue(
            new Promise((resolve) => {
                finishPreparation = resolve;
            }),
        );
        mocks.cancelNativeRead.mockResolvedValue({ status: "ok", data: null });
        const result = tauri.getGames({ id: { id: "db" }, kind: "database" }, {} as never, {
            signal: controller.signal,
        });
        controller.abort();
        finishPreparation({ status: "ok", data: "late-ticket" });
        await expect(result).rejects.toMatchObject({ details: { category: "cancelled" } });
        expect(mocks.cancelNativeRead).toHaveBeenCalledWith("late-ticket");
        expect(mocks.getGames).not.toHaveBeenCalled();
    });

    test("analysis preparation retains abort until the eventual reservation exists", async () => {
        const controller = new AbortController();
        let finishPreparation!: (value: unknown) => void;
        mocks.prepareAnalysis.mockReturnValue(
            new Promise((resolve) => {
                finishPreparation = resolve;
            }),
        );
        mocks.cancelAnalysis.mockResolvedValue({ status: "ok", data: null });

        const result = tauri.prepareAnalysis("tab", { signal: controller.signal });
        controller.abort();
        finishPreparation({ status: "ok", data: "analysis-ticket" });

        await expect(result).rejects.toMatchObject({ details: { category: "cancelled" } });
        expect(mocks.cancelAnalysis).toHaveBeenCalledOnce();
        expect(mocks.cancelAnalysis).toHaveBeenCalledWith("analysis-ticket");
    });

    test("analysis abort before preparation skips the native command", async () => {
        const controller = new AbortController();
        controller.abort();
        await expect(
            tauri.prepareAnalysis("tab", { signal: controller.signal }),
        ).rejects.toMatchObject({ details: { category: "cancelled" } });
        expect(mocks.prepareAnalysis).not.toHaveBeenCalled();
    });

    test("successful analysis preparation transfers reservation ownership to its caller", async () => {
        const controller = new AbortController();
        mocks.prepareAnalysis.mockResolvedValue({ status: "ok", data: "analysis-ticket" });

        await expect(tauri.prepareAnalysis("tab", { signal: controller.signal })).resolves.toBe(
            "analysis-ticket",
        );
        controller.abort();
        await Promise.resolve();

        expect(mocks.cancelAnalysis).not.toHaveBeenCalled();
    });

    test("failed preparation removes its abort listener without issuing cleanup", async () => {
        const controller = new AbortController();
        const remove = vi.spyOn(controller.signal, "removeEventListener");
        mocks.prepareNativeRead.mockRejectedValue(new Error("prepare failed"));
        await expect(
            tauri.getGames({ id: { id: "db" }, kind: "database" }, {} as never, {
                signal: controller.signal,
            }),
        ).rejects.toThrow("prepare failed");
        expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
        expect(mocks.cancelNativeRead).not.toHaveBeenCalled();
        expect(mocks.getGames).not.toHaveBeenCalled();
    });

    test("active abort cancels exactly its ticket and cannot return buffered success", async () => {
        const controller = new AbortController();
        mocks.prepareNativeRead.mockResolvedValue({ status: "ok", data: "active-ticket" });
        mocks.cancelNativeRead.mockResolvedValue({ status: "ok", data: null });
        let finishCommand!: (value: unknown) => void;
        mocks.getGames.mockReturnValue(new Promise((resolve) => (finishCommand = resolve)));
        const result = tauri.getGames({ id: { id: "db" }, kind: "database" }, {} as never, {
            signal: controller.signal,
        });
        await Promise.resolve();
        controller.abort();
        finishCommand({ status: "ok", data: { data: [], count: 0 } });
        await expect(result).rejects.toMatchObject({ details: { category: "cancelled" } });
        expect(mocks.cancelNativeRead).toHaveBeenCalledOnce();
        expect(mocks.cancelNativeRead).toHaveBeenCalledWith("active-ticket");
    });

    test("coverage batch routes its third argument and abort options to its own native ticket", async () => {
        const controller = new AbortController();
        const database = { id: { id: "coverage-db" }, kind: "database" } as const;
        const fens = ["coverage-fen"];
        mocks.prepareNativeRead.mockResolvedValue({ status: "ok", data: "coverage-ticket" });
        mocks.cancelNativeRead.mockResolvedValue({ status: "ok", data: null });
        let finishCommand!: (value: unknown) => void;
        mocks.searchPositionsStats.mockReturnValue(
            new Promise((resolve) => {
                finishCommand = resolve;
            }),
        );
        const result = tauri.searchPositionsStats(database, fens, "coverage-calc:test", {
            signal: controller.signal,
        });
        await Promise.resolve();
        expect(mocks.searchPositionsStats).toHaveBeenCalledExactlyOnceWith(
            database,
            fens,
            "coverage-calc:test",
            "coverage-ticket",
        );
        controller.abort();
        finishCommand({ status: "ok", data: [] });
        await expect(result).rejects.toMatchObject({ details: { category: "cancelled" } });
        expect(mocks.cancelNativeRead).toHaveBeenCalledExactlyOnceWith("coverage-ticket");
    });

    test("simultaneous owners cancel independently", async () => {
        const first = new AbortController();
        const second = new AbortController();
        mocks.prepareNativeRead
            .mockResolvedValueOnce({ status: "ok", data: "ticket-first" })
            .mockResolvedValueOnce({ status: "ok", data: "ticket-second" });
        mocks.cancelNativeRead.mockResolvedValue({ status: "ok", data: null });
        const completions = new Map<string, (value: unknown) => void>();
        mocks.getGames.mockImplementation(
            (_file: unknown, _query: unknown, ticket: string) =>
                new Promise((resolve) => completions.set(ticket, resolve)),
        );
        const firstResult = tauri.getGames({ id: { id: "first" }, kind: "database" }, {} as never, {
            signal: first.signal,
        });
        const secondResult = tauri.getGames(
            { id: { id: "second" }, kind: "database" },
            {} as never,
            { signal: second.signal },
        );
        await vi.waitFor(() => expect(completions.size).toBe(2));
        first.abort();
        completions.get("ticket-first")!({ status: "ok", data: { data: [], count: 0 } });
        completions.get("ticket-second")!({ status: "ok", data: { data: [], count: 0 } });
        await expect(firstResult).rejects.toMatchObject({ details: { category: "cancelled" } });
        await expect(secondResult).resolves.toEqual({ data: [], count: 0 });
        expect(mocks.cancelNativeRead).toHaveBeenCalledOnce();
        expect(mocks.cancelNativeRead).toHaveBeenCalledWith("ticket-first");
    });

    test("completion before abort retires the listener without native cancellation", async () => {
        const controller = new AbortController();
        mocks.prepareNativeRead.mockResolvedValue({ status: "ok", data: "completed-ticket" });
        mocks.getGames.mockResolvedValue({ status: "ok", data: { data: [], count: 0 } });
        await expect(
            tauri.getGames({ id: { id: "db" }, kind: "database" }, {} as never, {
                signal: controller.signal,
            }),
        ).resolves.toEqual({ data: [], count: 0 });
        controller.abort();
        await Promise.resolve();
        expect(mocks.cancelNativeRead).not.toHaveBeenCalled();
    });

    test("generated command errors clean up their claimed reservation", async () => {
        mocks.prepareNativeRead.mockResolvedValue({ status: "ok", data: "failed-ticket" });
        mocks.cancelNativeRead.mockResolvedValue({ status: "ok", data: null });
        mocks.getGames.mockResolvedValue({
            status: "error",
            error: { tag: "backend-error", category: "conflict", message: "claim failed" },
        });
        await expect(
            tauri.getGames({ id: { id: "db" }, kind: "database" }, {} as never, {
                signal: new AbortController().signal,
            }),
        ).rejects.toMatchObject({ details: { category: "validation" } });
        expect(mocks.cancelNativeRead).toHaveBeenCalledWith("failed-ticket");
    });

    test("cleanup rejection preserves the primary error and logs the secondary", async () => {
        mocks.prepareNativeRead.mockResolvedValue({ status: "ok", data: "cleanup-ticket" });
        mocks.cancelNativeRead.mockResolvedValue({ status: "error", error: "cleanup failed" });
        mocks.getGames.mockResolvedValue({ status: "error", error: "primary failed" });
        await expect(
            tauri.getGames({ id: { id: "db" }, kind: "database" }, {} as never, {
                signal: new AbortController().signal,
            }),
        ).rejects.toThrow("primary failed");
        expect(mocks.logError).toHaveBeenCalledOnce();
        expect(mocks.logError.mock.calls[0][0]).toContain("cleanup-ticket");
    });
    test("rejected cleanup logger uses safe fallback without changing the primary error", async () => {
        const fallback = vi.spyOn(console, "error").mockImplementation(() => undefined);
        mocks.prepareNativeRead.mockResolvedValue({ status: "ok", data: "fallback-ticket" });
        mocks.cancelNativeRead.mockResolvedValue({ status: "error", error: "cleanup failed" });
        mocks.logError.mockRejectedValue(new Error("logger failed"));
        mocks.getGames.mockResolvedValue({ status: "error", error: "primary failed" });
        await expect(
            tauri.getGames({ id: { id: "db" }, kind: "database" }, {} as never, {
                signal: new AbortController().signal,
            }),
        ).rejects.toThrow("primary failed");
        expect(fallback).toHaveBeenCalledWith(
            "Native getGames cleanup logging failed (fallback-ticket)",
            expect.objectContaining({ message: "logger failed" }),
        );
        fallback.mockRestore();
    });
    test("returns command payloads instead of generated Result wrappers", async () => {
        mocks.closeSplashscreen.mockResolvedValue({ status: "ok", data: null });
        await expect(tauri.closeSplashscreen()).resolves.toBeNull();
    });

    test("normalizes and redacts generated errors", async () => {
        mocks.closeSplashscreen.mockResolvedValue({
            status: "error",
            error: {
                tag: "backend-error",
                category: "invalid-input",
                message: "Bearer secret-value at /home/user/private.pgn",
            },
        });
        let caught: unknown;
        try {
            await tauri.closeSplashscreen();
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(TauriCommandError);
        const error = caught as TauriCommandError;
        expect(error.message).not.toContain("secret-value");
        expect(error.message).not.toContain("/home/user");
        expect(error.message).not.toContain("$1");
        expect(error.details).toEqual({
            category: "validation",
            backendCategory: "invalid-input",
            message: "Bearer [redacted] at [path]",
        });
        expect(error.details).toBe(normalizeError(error));
    });

    test("maps a closeSplashscreen platform failure through the typed payload", async () => {
        mocks.closeSplashscreen.mockResolvedValue({
            status: "error",
            error: {
                tag: "backend-error",
                category: "platform",
                message: "platform failure",
            },
        });
        await expect(tauri.closeSplashscreen()).rejects.toMatchObject({
            message: "platform failure",
            details: {
                category: "unexpected",
                backendCategory: "platform",
                message: "platform failure",
            },
        });
    });

    test("redacts an untyped command string error through unwrapCommand", () => {
        let caught: unknown;
        try {
            unwrapCommand({
                status: "error",
                error: "Bearer secret-value at /home/user/private.pgn",
            });
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(TauriCommandError);
        const error = caught as TauriCommandError;
        expect(error.message).not.toContain("secret-value");
        expect(error.message).not.toContain("/home/user");
        expect(error.message).not.toContain("$1");
    });

    test("maps a generated ErrorPayload through unwrapCommand", () => {
        const result = {
            status: "error" as const,
            error: {
                tag: "backend-error" as const,
                category: "permission" as const,
                message: "denied at /private/secret",
            },
        };
        let caught: unknown;
        try {
            unwrapCommand(result);
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(TauriCommandError);
        const commandError = caught as TauriCommandError;
        expect(commandError.details).toEqual({
            category: "permission",
            backendCategory: "permission",
            message: "denied at [path]",
        });
        expect(commandError.message).toBe("denied at [path]");
        expect(commandError.message).not.toContain("/private/secret");
    });

    test("rethrows an already-normalised TauriCommandError", async () => {
        const inner = new TauriCommandError("Bearer secret-value at /home/user/private.pgn");
        mocks.closeSplashscreen.mockRejectedValue(inner);
        let caught: unknown;
        try {
            await tauri.closeSplashscreen();
        } catch (error) {
            caught = error;
        }
        expect(caught).toBe(inner);
    });

    test("normalizes game replies and encodes all six expected sessions as safe numbers", async () => {
        for (const command of [
            mocks.getGameState,
            mocks.makeGameMove,
            mocks.takeBackGameMove,
            mocks.resignGame,
        ]) {
            command.mockResolvedValue({ status: "ok", data: wireState });
        }
        mocks.abortGame.mockResolvedValue({ status: "ok", data: null });
        mocks.getGameEngineLogs.mockResolvedValue({ status: "ok", data: [] });

        await expect(tauri.getGameState("game", 1n)).resolves.toMatchObject({
            session: 1n,
            revision: 2n,
        });
        await expect(tauri.makeGameMove("game", 2n, "e2e4", 4)).resolves.toMatchObject({
            session: 1n,
            revision: 2n,
        });
        await expect(tauri.takeBackGameMove("game", 3n)).resolves.toMatchObject({
            session: 1n,
            revision: 2n,
        });
        await expect(tauri.resignGame("game", 4n, "white")).resolves.toMatchObject({
            session: 1n,
            revision: 2n,
        });
        await tauri.abortGame("game", 5n);
        await tauri.getGameEngineLogs("game", 6n, "black");
        expect(mocks.getGameState).toHaveBeenCalledWith("game", 1);
        expect(mocks.makeGameMove).toHaveBeenCalledWith("game", 2, "e2e4", 4);
        expect(mocks.takeBackGameMove).toHaveBeenCalledWith("game", 3);
        expect(mocks.resignGame).toHaveBeenCalledWith("game", 4, "white");
        expect(mocks.abortGame).toHaveBeenCalledWith("game", 5);
        expect(mocks.getGameEngineLogs).toHaveBeenCalledWith("game", 6, "black");
        expect(() => JSON.stringify(mocks.abortGame.mock.calls.at(-1))).not.toThrow();
    });

    test("start uses numeric config unchanged and unrelated commands remain untouched", async () => {
        mocks.startGame.mockResolvedValue({ status: "ok", data: wireState });
        mocks.closeSplashscreen.mockResolvedValue({ status: "ok", data: null });
        const config = {
            white: { type: "human" as const, name: "White" },
            black: { type: "human" as const, name: "Black" },
            whiteTimeControl: { initialTime: 60_000, increment: 1_000 },
            blackTimeControl: { initialTime: 60_000, increment: 1_000 },
            initialFen: null,
            initialMoves: [],
            openingBook: { book: { id: { id: "book" }, kind: "openingBook" as const }, maxPly: 24 },
        };
        await expect(tauri.startGame("game", config)).resolves.toMatchObject({
            session: 1n,
            revision: 2n,
        });
        expect(mocks.startGame).toHaveBeenCalledWith("game", config);
        expect(() => JSON.stringify(mocks.startGame.mock.calls[0])).not.toThrow();
        await tauri.closeSplashscreen();
        expect(mocks.closeSplashscreen).toHaveBeenCalledWith();
    });

    test("drops malformed game events and reports the original envelope once", async () => {
        const cases = [
            ["clockUpdate", "clockUpdateEvent", { ...wireState, session: -1 }],
            ["gameMove", "gameMoveEvent", { ...wireState, session: Number.MAX_SAFE_INTEGER + 1 }],
            ["gameOver", "gameOverEvent", { ...wireState, revision: "bad" }],
        ] as const;
        for (const [subscription, eventName, payload] of cases) {
            const callback = vi.fn();
            const onError = vi.fn();
            await tauriSubscriptions[subscription](callback, onError);
            const envelope = { payload, id: 9 };
            mocks.listeners.get(eventName)?.(envelope);
            expect(callback).not.toHaveBeenCalled();
            expect(onError).toHaveBeenCalledOnce();
            expect(onError.mock.calls[0][1]).toBe(envelope);
        }
    });
});
