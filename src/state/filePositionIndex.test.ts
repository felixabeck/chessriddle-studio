import { beforeEach, describe, expect, test, vi } from "vitest";
import type { FileWorkspaceHandle, StampedGame } from "@/bindings";
import { getBoardState } from "@/utils/treeReducer";
import { lex } from "./tests/lexPgn";

const mocks = vi.hoisted(() => ({
    countPgnGames: vi.fn(),
    readGames: vi.fn(),
    lexPgn: vi.fn(),
    warn: vi.fn((_message: string) => Promise.resolve()),
    error: vi.fn((_message: string) => Promise.resolve()),
}));

vi.mock("@/platform/tauri", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/platform/tauri")>();
    return {
        ...actual,
        tauri: {
            ...actual.tauri,
            countPgnGames: mocks.countPgnGames,
            readGames: mocks.readGames,
            lexPgn: mocks.lexPgn,
        },
    };
});

vi.mock("@/platform/native", () => ({
    platform: vi.fn(() => "linux"),
    warn: mocks.warn,
    error: mocks.error,
}));

const { cancellationError, TauriCommandError } = await import("@/platform/tauri");
const {
    FILE_INDEX_PAGE_SIZE,
    MAX_FILE_INDEX_BYTES,
    MAX_FILE_INDEX_CHAPTERS,
    MAX_INDEXED_FILES,
    createFilePositionIndexRegistry,
    getFileChapterOccurrences,
    getFilePositionIndex,
    requestFilePositionIndex,
    resetFilePositionIndexForTests,
    subscribeFilePositionIndex,
} = await import("./filePositionIndex");

function makeFile(
    id: string,
    options?: { name?: string; type?: "repertoire" | "game" },
): {
    handle: FileWorkspaceHandle;
    name: string;
    metadata: { type: "repertoire" | "game"; tags: string[] };
} {
    return {
        handle: { id: { id }, kind: "fileWorkspace" } as unknown as FileWorkspaceHandle,
        name: options?.name ?? `secret-dir/${id}.pgn`,
        metadata: { type: options?.type ?? "game", tags: [] },
    };
}

function stamped(pgn: string, revision = "r1", overrides?: Partial<StampedGame>): StampedGame {
    return {
        pgn,
        stamp: "s1",
        revision,
        present: true,
        omission: null,
        linked: null,
        ...overrides,
    };
}

function serveChapters(chapters: StampedGame[]) {
    mocks.countPgnGames.mockResolvedValue(chapters.length);
    mocks.readGames.mockImplementation(
        async (_handle: FileWorkspaceHandle, start: number, end: number) =>
            chapters.slice(start, end + 1),
    );
}

beforeEach(() => {
    vi.resetAllMocks();
    resetFilePositionIndexForTests();
    mocks.warn.mockImplementation(() => Promise.resolve());
    mocks.error.mockImplementation(() => Promise.resolve());
    mocks.lexPgn.mockImplementation(async (pgn: string, options?: { signal?: AbortSignal }) => {
        if (options?.signal?.aborted) throw cancellationError();
        return lex(pgn);
    });
});

test("indexes chapters reaching one position by different move orders, keeping roots and line ends", async () => {
    const file = makeFile("ws-file-1", { name: "Repertoire.pgn", type: "repertoire" });
    serveChapters([
        stamped('[White "Italian"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bc4 *'),
        stamped('[White "King Knight"]\n\n1. Nf3 Nc6 2. e4 e5 *'),
        stamped(
            '[White "Tabiya"]\n[FEN "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3"]\n\n3. Bb5 *',
        ),
    ]);

    const { finished } = requestFilePositionIndex(file, "r1");
    expect(await finished).toBe("built");

    const index = getFilePositionIndex(file.handle, "r1");
    expect(index).not.toBeNull();
    expect(index!.chapters.get(0)?.name).toBe("Italian");
    expect(index!.chapters.get(1)?.name).toBe("King Knight");
    expect(index!.chapters.get(2)?.name).toBe("Tabiya");

    const afterNf3Nc6 = getBoardState(
        "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3",
    );
    // Chapter 0 continues (hasContinuation: true), chapter 1 ends at the position (false),
    // and chapter 2 starts at the position as its root (path: [], hasContinuation: true).
    expect(getFileChapterOccurrences(index!, afterNf3Nc6)).toEqual([
        {
            chapter: 0,
            chapterName: "Italian",
            path: [0, 0, 0, 0],
            hasContinuation: true,
            rootKey: getBoardState("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"),
            moveOrder: "e4 e5 Nf3 Nc6",
        },
        {
            chapter: 1,
            chapterName: "King Knight",
            path: [0, 0, 0, 0],
            hasContinuation: false,
            rootKey: getBoardState("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"),
            moveOrder: "Nf3 Nc6 e4 e5",
        },
        {
            chapter: 2,
            chapterName: "Tabiya",
            path: [],
            hasContinuation: true,
            rootKey: afterNf3Nc6,
            moveOrder: "",
        },
    ]);

    // The open chapter's occurrences are excluded at lookup.
    expect(getFileChapterOccurrences(index!, afterNf3Nc6, 0).map((o) => o.chapter)).toEqual([1, 2]);
});

test("O0: two spellings of one position form one occurrence set across chapters", async () => {
    const file = makeFile("ws-spellings");
    const fourField = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -";
    const shredder = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b HAha - 5 9";
    serveChapters([
        stamped(`[White "A"]\n[FEN "${fourField}"]\n\n1... e5 *`),
        stamped(`[White "B"]\n[FEN "${shredder}"]\n\n1... c5 *`),
        stamped('[White "C"]\n\n1. e4 *'),
    ]);

    expect(await requestFilePositionIndex(file, "r1").finished).toBe("built");
    const index = getFilePositionIndex(file.handle, "r1")!;
    const normalized = getBoardState("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1");
    const occs = getFileChapterOccurrences(index, normalized);
    expect(occs.map((o) => [o.chapter, o.path])).toEqual([
        [0, []],
        [1, []],
        [2, [0]],
    ]);
});

test("uses countPgnGames from disk even when FileMetadata.numGames would be stale", async () => {
    const file = {
        ...makeFile("ws-count"),
        numGames: 1, // ignored: too small
    };
    serveChapters([
        stamped('[White "A"]\n\n1. e4 *'),
        stamped('[White "B"]\n\n1. d4 *'),
        stamped('[White "C"]\n\n1. c4 *'),
    ]);
    expect(await requestFilePositionIndex(file, "r1").finished).toBe("built");
    expect(getFilePositionIndex(file.handle, "r1")!.chapters.size).toBe(3);

    // Too large stale numGames (e.g. 5) when disk only has 1 game -> ineligible (< 2 chapters).
    mocks.readGames.mockClear();
    const shrunk = { ...makeFile("ws-shrunk"), numGames: 5 };
    serveChapters([stamped('[White "Only"]\n\n1. e4 *')]);
    expect(await requestFilePositionIndex(shrunk, "r1").finished).toBe("ineligible");
    expect(mocks.readGames).not.toHaveBeenCalled();
});

test("skips absent chapters and PGN-content rejections and logs once per build (CR-1)", async () => {
    const file = makeFile("ws-skips", { name: "/Users/alice/secret/Opening.pgn" });
    serveChapters([
        stamped("", "r7", { present: false }),
        stamped('[White "BadParsing"]\n\n1. e4 *', "r7"),
        stamped('[White "BadInput"]\n\n1. d4 *', "r7"),
        stamped('[White "BadChess"]\n\n1. c4 *', "r7"),
        stamped('[White "Good"]\n\n1. Nf3 *', "r7"),
    ]);
    mocks.lexPgn.mockImplementation(async (pgn: string) => {
        if (pgn.includes("BadParsing")) {
            throw new TauriCommandError({
                tag: "backend-error",
                category: "parsing",
                message: "Unexpected token in /Users/alice/secret/Opening.pgn",
            });
        }
        if (pgn.includes("BadInput")) {
            throw new TauriCommandError({
                tag: "backend-error",
                category: "invalid-input",
                message: "Malformed header",
            });
        }
        if (pgn.includes("BadChess")) {
            throw new TauriCommandError({
                tag: "backend-error",
                category: "chess-data",
                message: "Illegal FEN",
            });
        }
        return lex(pgn);
    });

    expect(await requestFilePositionIndex(file, "r7").finished).toBe("built");
    const index = getFilePositionIndex(file.handle, "r7")!;
    expect([...index.chapters.keys()]).toEqual([4]);

    // CR-1: several skipped chapters log exactly once per build, with workspace key and revision, no path.
    expect(mocks.warn).toHaveBeenCalledTimes(1);
    const logMessage = mocks.warn.mock.calls[0][0];
    expect(logMessage).toContain("ws-skips");
    expect(logMessage).toContain("r7");
    expect(logMessage).not.toContain("/Users/alice");
    expect(logMessage).not.toContain("Opening.pgn");
});

test("operation failure during chapter parse fails the build and logs once", async () => {
    const file = makeFile("ws-op-fail", { name: "/home/bob/private/Repertoire.pgn" });
    serveChapters([
        stamped('[White "SkippedFirst"]\n\n1. e4 *'),
        stamped('[White "OpFails"]\n\n1. d4 *'),
    ]);
    mocks.lexPgn.mockImplementation(async (pgn: string) => {
        if (pgn.includes("SkippedFirst")) {
            throw new TauriCommandError({
                tag: "backend-error",
                category: "parsing",
                message: "Bad PGN",
            });
        }
        throw new TauriCommandError({
            tag: "backend-error",
            category: "resource-limit",
            message: "Lexer budget exceeded for /home/bob/private/Repertoire.pgn",
        });
    });

    expect(await requestFilePositionIndex(file, "r3").finished).toBe("failed");
    expect(getFilePositionIndex(file.handle, "r3")).toBeNull();
    expect(mocks.warn).toHaveBeenCalledTimes(1);
    const logMessage = mocks.warn.mock.calls[0][0];
    expect(logMessage).toContain("ws-op-fail");
    expect(logMessage).toContain("r3");
    expect(logMessage).not.toContain("/home/bob");
    expect(logMessage).not.toContain("Repertoire.pgn");
});

describe("ineligibility limits and stopping reading", () => {
    test("fewer than 2 chapters or more than maxChapters is ineligible without reading pages", async () => {
        const registry = createFilePositionIndexRegistry({ maxChapters: 3 });

        serveChapters([stamped("1. e4 *")]);
        expect(await registry.request(makeFile("ws-one"), "r1").finished).toBe("ineligible");
        expect(mocks.readGames).not.toHaveBeenCalled();

        serveChapters([
            stamped("1. e4 *"),
            stamped("1. d4 *"),
            stamped("1. c4 *"),
            stamped("1. Nf3 *"),
        ]);
        expect(await registry.request(makeFile("ws-four"), "r1").finished).toBe("ineligible");
        expect(mocks.readGames).not.toHaveBeenCalled();
        expect(mocks.warn).not.toHaveBeenCalled();
    });

    test("tooLarge chapter makes file ineligible and stops reading further pages", async () => {
        const registry = createFilePositionIndexRegistry({ pageSize: 2 });
        serveChapters([
            stamped("1. e4 *"),
            stamped("", "r1", { omission: "tooLarge" }),
            stamped("1. d4 *"),
            stamped("1. c4 *"),
        ]);

        const file = makeFile("ws-too-large");
        expect(await registry.request(file, "r1").finished).toBe("ineligible");
        expect(mocks.readGames).toHaveBeenCalledTimes(1);
        expect(registry.getIndex(file.handle, "r1")).toBeNull();
        expect(mocks.warn).not.toHaveBeenCalled();
    });

    test("crossing byte limit makes file ineligible and stops reading further pages", async () => {
        const registry = createFilePositionIndexRegistry({ pageSize: 2, maxBytes: 30 });
        serveChapters([
            stamped("1. e4 e5 2. Nf3 Nc6 *"), // 20 bytes
            stamped("1. d4 d5 2. c4 e6 *"), // +18 = 38 bytes (> 30)
            stamped("1. c4 *"),
            stamped("1. Nf3 *"),
        ]);

        const file = makeFile("ws-over-bytes");
        expect(await registry.request(file, "r1").finished).toBe("ineligible");
        expect(mocks.readGames).toHaveBeenCalledTimes(1);
        expect(mocks.lexPgn).not.toHaveBeenCalled();
        expect(mocks.warn).not.toHaveBeenCalled();
    });

    test("crossing byte limit on second page stops before third page", async () => {
        const registry = createFilePositionIndexRegistry({ pageSize: 2, maxBytes: 30 });
        serveChapters([
            stamped("1. e4 e5 *"), // 10 bytes
            stamped("1. d4 d5 *"), // +10 = 20 bytes (<= 30)
            stamped("1. c4 c5 *"), // +10 = 30 bytes (<= 30)
            stamped("1. Nf3 Nf6 *"), // +12 = 42 bytes (> 30)
            stamped("1. g3 *"),
            stamped("1. b3 *"),
        ]);

        const file = makeFile("ws-over-bytes-page2");
        expect(await registry.request(file, "r1").finished).toBe("ineligible");
        expect(mocks.readGames).toHaveBeenCalledTimes(2);
        expect(registry.getIndex(file.handle, "r1")).toBeNull();
        expect(mocks.warn).not.toHaveBeenCalled();
    });

    test("crossing position limit makes file ineligible and stops reading further pages", async () => {
        // Each "1. e4 e5 *" has 3 positions (root, e4, e5). 2 chapters = 6 positions > 5.
        const registry = createFilePositionIndexRegistry({ pageSize: 2, maxPositions: 5 });
        serveChapters([
            stamped("1. e4 e5 *"),
            stamped("1. d4 d5 *"),
            stamped("1. c4 c5 *"),
            stamped("1. Nf3 Nf6 *"),
        ]);

        const file = makeFile("ws-over-pos");
        expect(await registry.request(file, "r1").finished).toBe("ineligible");
        expect(mocks.readGames).toHaveBeenCalledTimes(1);
        expect(registry.getIndex(file.handle, "r1")).toBeNull();
        expect(mocks.warn).not.toHaveBeenCalled();
    });

    test("crossing position limit on second page stops before third page", async () => {
        // 3 positions per chapter: page 1 has 6 (<= 7), page 2 reaches 9 (> 7).
        const registry = createFilePositionIndexRegistry({ pageSize: 2, maxPositions: 7 });
        serveChapters([
            stamped("1. e4 e5 *"),
            stamped("1. d4 d5 *"),
            stamped("1. c4 c5 *"),
            stamped("1. Nf3 Nf6 *"),
            stamped("1. g3 g6 *"),
            stamped("1. b3 b6 *"),
        ]);

        const file = makeFile("ws-over-pos-page2");
        expect(await registry.request(file, "r1").finished).toBe("ineligible");
        expect(mocks.readGames).toHaveBeenCalledTimes(2);
        expect(registry.getIndex(file.handle, "r1")).toBeNull();
        expect(mocks.warn).not.toHaveBeenCalled();
    });
});

describe("build failure classes publish nothing and log once", () => {
    test("failed countPgnGames fails and logs once", async () => {
        const file = makeFile("ws-count-fail");
        mocks.countPgnGames.mockRejectedValue(new Error("io error"));
        expect(await requestFilePositionIndex(file, "r1").finished).toBe("failed");
        expect(getFilePositionIndex(file.handle, "r1")).toBeNull();
        expect(mocks.warn).toHaveBeenCalledTimes(1);
    });

    test("failed readGames fails and logs once", async () => {
        const file = makeFile("ws-page-fail");
        mocks.countPgnGames.mockResolvedValue(2);
        mocks.readGames.mockRejectedValue(new Error("disk read failed"));
        expect(await requestFilePositionIndex(file, "r1").finished).toBe("failed");
        expect(getFilePositionIndex(file.handle, "r1")).toBeNull();
        expect(mocks.warn).toHaveBeenCalledTimes(1);
    });

    test("page with a foreign revision fails and logs once", async () => {
        const file = makeFile("ws-foreign-rev");
        serveChapters([stamped("1. e4 *", "r1"), stamped("1. d4 *", "r2")]);
        expect(await requestFilePositionIndex(file, "r1").finished).toBe("failed");
        expect(getFilePositionIndex(file.handle, "r1")).toBeNull();
        expect(mocks.warn).toHaveBeenCalledTimes(1);
    });

    test("empty page before counted end fails and logs once", async () => {
        const file = makeFile("ws-empty-page");
        mocks.countPgnGames.mockResolvedValue(4);
        mocks.readGames.mockResolvedValue([]);
        expect(await requestFilePositionIndex(file, "r1").finished).toBe("failed");
        expect(getFilePositionIndex(file.handle, "r1")).toBeNull();
        expect(mocks.warn).toHaveBeenCalledTimes(1);
    });

    test("non-payload error containing 'aborted' without aborted signal fails and logs once", async () => {
        const file = makeFile("ws-msg-aborted");
        serveChapters([stamped("1. e4 *"), stamped("1. d4 *")]);
        mocks.lexPgn.mockRejectedValueOnce(new Error("request aborted"));

        expect(await requestFilePositionIndex(file, "r1").finished).toBe("failed");
        expect(getFilePositionIndex(file.handle, "r1")).toBeNull();
        expect(mocks.warn).toHaveBeenCalledTimes(1);
        const logMessage = mocks.warn.mock.calls[0][0];
        expect(logMessage).toContain("ws-msg-aborted");
        expect(logMessage).toContain("r1");
    });
});

test("cancellation during chapter parse stops the build with no further call and publishes nothing", async () => {
    const file = makeFile("ws-cancel-parse");
    serveChapters([stamped("1. e4 *"), stamped("1. d4 *"), stamped("1. c4 *")]);

    let releaseLex!: () => void;
    const lexHeld = new Promise<void>((resolve) => {
        releaseLex = resolve;
    });
    mocks.lexPgn.mockImplementationOnce(
        async (_pgn: string, options?: { signal?: AbortSignal }) => {
            await lexHeld;
            if (options?.signal?.aborted) throw cancellationError();
            return lex("1. e4 *");
        },
    );

    const req = requestFilePositionIndex(file, "r1");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.lexPgn).toHaveBeenCalledTimes(1);

    // Unmount aborts the build in flight.
    req.release();
    releaseLex();
    expect(await req.finished).toBe("cancelled");
    expect(mocks.lexPgn).toHaveBeenCalledTimes(1);
    expect(mocks.readGames).toHaveBeenCalledTimes(1);
    expect(getFilePositionIndex(file.handle, "r1")).toBeNull();
    expect(mocks.warn).not.toHaveBeenCalled();

    // A later request for the same (file, revision) can build cleanly since it never settled.
    expect(await requestFilePositionIndex(file, "r1").finished).toBe("built");
    expect(mocks.countPgnGames).toHaveBeenCalledTimes(2);
    expect(getFilePositionIndex(file.handle, "r1")).not.toBeNull();
});

test("two owners joining one in-flight build: releasing one keeps running, releasing both aborts", async () => {
    const file = makeFile("ws-two-owners");
    serveChapters([stamped("1. e4 *"), stamped("1. d4 *")]);

    let releaseLex!: () => void;
    let capturedSignal: AbortSignal | undefined;
    const lexHeld = new Promise<void>((resolve) => {
        releaseLex = resolve;
    });
    mocks.lexPgn.mockImplementationOnce(
        async (_pgn: string, options?: { signal?: AbortSignal }) => {
            capturedSignal = options?.signal;
            await lexHeld;
            if (options?.signal?.aborted) throw cancellationError();
            return lex("1. e4 *");
        },
    );

    const owner1 = requestFilePositionIndex(file, "r1");
    const owner2 = requestFilePositionIndex(file, "r1");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mocks.countPgnGames).toHaveBeenCalledTimes(1);
    expect(capturedSignal?.aborted).toBe(false);

    owner1.release();
    expect(capturedSignal?.aborted).toBe(false);

    owner2.release();
    expect(capturedSignal?.aborted).toBe(true);

    releaseLex();
    expect(await owner1.finished).toBe("cancelled");
    expect(await owner2.finished).toBe("cancelled");
    expect(getFilePositionIndex(file.handle, "r1")).toBeNull();
});

test("replacing an in-flight build with a newer revision aborts old build and ignores late settlement", async () => {
    const file = makeFile("ws-replace-inflight");
    let releaseOldLex!: () => void;
    let oldSignal: AbortSignal | undefined;
    const oldLexHeld = new Promise<void>((resolve) => {
        releaseOldLex = resolve;
    });

    mocks.countPgnGames.mockResolvedValue(2);
    mocks.readGames.mockImplementation(async (_handle: FileWorkspaceHandle, start: number) => {
        // First build is r1, replacement build is r2.
        const rev = mocks.readGames.mock.calls.length <= 1 ? "r1" : "r2";
        return start === 0
            ? [stamped("1. e4 *", rev), stamped("1. d4 *", rev)]
            : [stamped("1. d4 *", rev)];
    });
    mocks.lexPgn.mockImplementationOnce(
        async (_pgn: string, options?: { signal?: AbortSignal }) => {
            oldSignal = options?.signal;
            await oldLexHeld;
            if (options?.signal?.aborted) throw cancellationError();
            return lex("1. e4 *");
        },
    );

    const oldReq = requestFilePositionIndex(file, "r1");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(oldSignal?.aborted).toBe(false);

    const newReq = requestFilePositionIndex(file, "r2");
    expect(oldSignal?.aborted).toBe(true);
    expect(await newReq.finished).toBe("built");
    expect(getFilePositionIndex(file.handle, "r2")).not.toBeNull();

    // Let the superseded r1 build settle late: it must not delete or overwrite r2.
    releaseOldLex();
    expect(await oldReq.finished).toBe("cancelled");
    expect(getFilePositionIndex(file.handle, "r2")).not.toBeNull();
    expect(getFilePositionIndex(file.handle, "r1")).toBeNull();
});

test("throwing subscriber does not interrupt request() or settlement", async () => {
    const file = makeFile("ws-throwing-sub");
    serveChapters([stamped("1. e4 *"), stamped("1. d4 *")]);

    const unsubThrowing = subscribeFilePositionIndex(() => {
        unsubThrowing();
        throw new Error("subscriber failed");
    });
    const secondListener = vi.fn();
    const unsubSecond = subscribeFilePositionIndex(secondListener);

    const req = requestFilePositionIndex(file, "r1");
    expect(typeof req.release).toBe("function");
    expect(await req.finished).toBe("built");
    expect(getFilePositionIndex(file.handle, "r1")).not.toBeNull();
    expect(secondListener).toHaveBeenCalled();
    expect(mocks.warn).toHaveBeenCalledTimes(1);
    unsubSecond();
});

test("settled failed or ineligible revision is not rebuilt, and a newer revision replaces it", async () => {
    const failedFile = makeFile("ws-terminal-fail");
    mocks.countPgnGames.mockRejectedValueOnce(new Error("io failure"));
    expect(await requestFilePositionIndex(failedFile, "r1").finished).toBe("failed");
    expect(mocks.countPgnGames).toHaveBeenCalledTimes(1);

    // Same revision: not built again.
    expect(await requestFilePositionIndex(failedFile, "r1").finished).toBe("failed");
    expect(mocks.countPgnGames).toHaveBeenCalledTimes(1);

    // Newer revision replaces failed outcome and builds.
    serveChapters([stamped("1. e4 *", "r2"), stamped("1. d4 *", "r2")]);
    expect(await requestFilePositionIndex(failedFile, "r2").finished).toBe("built");
    expect(getFilePositionIndex(failedFile.handle, "r2")).not.toBeNull();
    expect(getFilePositionIndex(failedFile.handle, "r1")).toBeNull();
    expect(getFilePositionIndex(failedFile.handle, null)).toBeNull();

    // Ineligible revision is not rebuilt until revision changes.
    const ineligibleFile = makeFile("ws-terminal-ineligible");
    mocks.countPgnGames.mockResolvedValueOnce(1);
    expect(await requestFilePositionIndex(ineligibleFile, "r1").finished).toBe("ineligible");
    mocks.countPgnGames.mockClear();
    expect(await requestFilePositionIndex(ineligibleFile, "r1").finished).toBe("ineligible");
    expect(mocks.countPgnGames).not.toHaveBeenCalled();

    serveChapters([stamped("1. e4 *", "r2"), stamped("1. d4 *", "r2")]);
    expect(await requestFilePositionIndex(ineligibleFile, "r2").finished).toBe("built");
    expect(getFilePositionIndex(ineligibleFile.handle, "r2")).not.toBeNull();
});

test("retains up to MAX_INDEXED_FILES (3) and evicts least recently used", async () => {
    expect(MAX_INDEXED_FILES).toBe(3);
    const fileA = makeFile("ws-a");
    const fileB = makeFile("ws-b");
    const fileC = makeFile("ws-c");
    const fileD = makeFile("ws-d");
    serveChapters([stamped("1. e4 *"), stamped("1. d4 *")]);

    await requestFilePositionIndex(fileA, "r1").finished;
    await requestFilePositionIndex(fileB, "r1").finished;
    await requestFilePositionIndex(fileC, "r1").finished;
    // Touch A so B becomes least recently used.
    await requestFilePositionIndex(fileA, "r1").finished;

    await requestFilePositionIndex(fileD, "r1").finished;

    expect(getFilePositionIndex(fileA.handle, "r1")).not.toBeNull();
    expect(getFilePositionIndex(fileB.handle, "r1")).toBeNull();
    expect(getFilePositionIndex(fileC.handle, "r1")).not.toBeNull();
    expect(getFilePositionIndex(fileD.handle, "r1")).not.toBeNull();
});

test("evicting an in-flight build aborts its signal and resolves as evicted", async () => {
    const fileA = makeFile("ws-evict-flight");
    let capturedSignal: AbortSignal | undefined;
    mocks.countPgnGames.mockImplementationOnce(
        (_handle: FileWorkspaceHandle, options?: { signal?: AbortSignal }) => {
            capturedSignal = options?.signal;
            return new Promise((_resolve, reject) => {
                options?.signal?.addEventListener("abort", () => reject(cancellationError()), {
                    once: true,
                });
            });
        },
    );

    const inflight = requestFilePositionIndex(fileA, "r1");
    expect(capturedSignal?.aborted).toBe(false);

    serveChapters([stamped("1. e4 *"), stamped("1. d4 *")]);
    await requestFilePositionIndex(makeFile("ws-1"), "r1").finished;
    await requestFilePositionIndex(makeFile("ws-2"), "r1").finished;
    await requestFilePositionIndex(makeFile("ws-3"), "r1").finished;

    expect(capturedSignal?.aborted).toBe(true);
    expect(await inflight.finished).toBe("evicted");
});

test("yields to event loop between chapters and notifies subscribers on completion", async () => {
    const file = makeFile("ws-yield");
    const listener = vi.fn();
    const unsub = subscribeFilePositionIndex(listener);
    serveChapters([stamped("1. e4 *"), stamped("1. d4 *")]);

    const events: string[] = [];
    mocks.lexPgn
        .mockImplementationOnce(async (pgn: string) => {
            events.push("lex-0");
            setTimeout(() => events.push("timer"), 0);
            return lex(pgn);
        })
        .mockImplementationOnce(async (pgn: string) => {
            events.push("lex-1");
            return lex(pgn);
        });

    expect(await requestFilePositionIndex(file, "r1").finished).toBe("built");
    expect(events).toEqual(["lex-0", "timer", "lex-1"]);
    expect(listener).toHaveBeenCalled();
    unsub();
});

test("a file exactly at every limit is built, across pages", async () => {
    // 4 chapters * 10 bytes = 40 bytes, 4 * (root + 2 moves) = 12 positions, pages of 3 → 2 reads.
    const registry = createFilePositionIndexRegistry({
        maxChapters: 4,
        maxBytes: 40,
        maxPositions: 12,
        pageSize: 3,
    });
    serveChapters([
        stamped("1. e4 e5 *"),
        stamped("1. d4 d5 *"),
        stamped("1. c4 c5 *"),
        stamped("1. g3 g6 *"),
    ]);

    const file = makeFile("ws-at-limit");
    expect(await registry.request(file, "r1").finished).toBe("built");
    const index = registry.getIndex(file.handle, "r1")!;
    expect(index.chapters.size).toBe(4);
    let countedPositions = 0;
    for (const occs of index.positions.values()) countedPositions += occs.length;
    expect(countedPositions).toBe(12);
    expect(mocks.readGames).toHaveBeenCalledTimes(2);
    expect(mocks.warn).not.toHaveBeenCalled();
});

test("the default registry accepts MAX_FILE_INDEX_CHAPTERS chapters and rejects one more", async () => {
    // Each chapter is a bare result: one position, so the chapter limit is the only one reached.
    serveChapters(Array.from({ length: MAX_FILE_INDEX_CHAPTERS }, () => stamped("*")));
    const file = makeFile("ws-default-chapters");
    expect(await requestFilePositionIndex(file, "r1").finished).toBe("built");
    expect(getFilePositionIndex(file.handle, "r1")!.chapters.size).toBe(MAX_FILE_INDEX_CHAPTERS);
    expect(mocks.readGames).toHaveBeenCalledTimes(
        Math.ceil(MAX_FILE_INDEX_CHAPTERS / FILE_INDEX_PAGE_SIZE),
    );

    mocks.readGames.mockClear();
    serveChapters(Array.from({ length: MAX_FILE_INDEX_CHAPTERS + 1 }, () => stamped("*")));
    expect(await requestFilePositionIndex(makeFile("ws-default-over"), "r1").finished).toBe(
        "ineligible",
    );
    expect(mocks.readGames).not.toHaveBeenCalled();
});

test("the default registry rejects a file over MAX_FILE_INDEX_BYTES before parsing", async () => {
    const oversized = `[Event "${"x".repeat(MAX_FILE_INDEX_BYTES)}"]\n\n*`;
    serveChapters([stamped(oversized), stamped("1. e4 *")]);
    expect(await requestFilePositionIndex(makeFile("ws-default-bytes"), "r1").finished).toBe(
        "ineligible",
    );
    expect(mocks.lexPgn).not.toHaveBeenCalled();
});
