import { beforeEach, expect, test, vi } from "vitest";
import { lex } from "./tests/lexPgn";

const mocks = vi.hoisted(() => ({
    lexPgn: vi.fn(),
}));

vi.mock("@/platform/tauri", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/platform/tauri")>();
    return {
        ...actual,
        tauri: {
            ...actual.tauri,
            lexPgn: mocks.lexPgn,
        },
    };
});

const { scanChapterPositions } = await import("./chapterScan");
const { getBoardState } = await import("@/utils/treeReducer");

beforeEach(() => {
    vi.resetAllMocks();
    mocks.lexPgn.mockImplementation(async (pgn: string, options?: { signal?: AbortSignal }) => {
        if (options?.signal?.aborted) {
            throw new DOMException("Cancellation", "AbortError");
        }
        return lex(pgn);
    });
});

test("visits root, continuations, variations, and line ends in pre-order with move sequences", async () => {
    const visited: Array<{
        boardState: string;
        path: number[];
        hasContinuation: boolean;
        moveOrder: string;
        halfMoves: number;
        san: string | null;
    }> = [];
    const result = await scanChapterPositions(
        '[White "Main"]\n\n1. e4 (1. d4 d5) 1... e5 2. Nf3 *',
        (pos) => {
            visited.push(pos);
        },
    );

    expect(result.headers.white).toBe("Main");
    expect(result.rootKey).toBe("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -");
    expect(
        visited.map((item) => [
            item.path,
            item.hasContinuation,
            item.moveOrder,
            item.halfMoves,
            item.san,
        ]),
    ).toEqual([
        [[], true, "", 0, null],
        [[0], true, "e4", 1, "e4"],
        [[0, 0], true, "e4 e5", 2, "e5"],
        [[0, 0, 0], false, "e4 e5 Nf3", 3, "Nf3"],
        [[1], true, "d4", 1, "d4"],
        [[1, 0], false, "d4 d5", 2, "d5"],
    ]);
});

test("anchors halfMoves to a custom Black-to-move root FEN", async () => {
    const visited: Array<{ path: number[]; halfMoves: number; san: string | null }> = [];
    await scanChapterPositions(
        '[FEN "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1"]\n\n1... c5 2. Nf3 *',
        (pos) => {
            visited.push({ path: pos.path, halfMoves: pos.halfMoves, san: pos.san });
        },
    );
    expect(visited).toEqual([
        { path: [], halfMoves: 1, san: null },
        { path: [0], halfMoves: 2, san: "c5" },
        { path: [0, 0], halfMoves: 3, san: "Nf3" },
    ]);
});

test("normalizes four-field, six-field, and Shredder castling root FENs to one key", async () => {
    const fourField = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -";
    const sixField = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
    const shredder = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b HAha - 4 12";

    const r4 = await scanChapterPositions(`[FEN "${fourField}"]\n\n1... e5 *`, () => undefined);
    const r6 = await scanChapterPositions(`[FEN "${sixField}"]\n\n1... e5 *`, () => undefined);
    const rShredder = await scanChapterPositions(
        `[FEN "${shredder}"]\n\n1... e5 *`,
        () => undefined,
    );

    const expected = getBoardState(sixField);
    expect(r4.rootKey).toBe(expected);
    expect(r6.rootKey).toBe(expected);
    expect(rShredder.rootKey).toBe(expected);
});

test("stops early when callback returns false", async () => {
    const paths: number[][] = [];
    await scanChapterPositions("1. e4 e5 2. Nf3 Nc6 *", (pos) => {
        paths.push(pos.path);
        if (pos.path.length === 1) return false;
        return true;
    });
    expect(paths).toEqual([[], [0]]);
});

test("propagates AbortSignal cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
        scanChapterPositions("1. e4 e5 *", () => undefined, { signal: controller.signal }),
    ).rejects.toThrow(/Cancellation/i);
});
