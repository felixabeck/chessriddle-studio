import { beforeEach, describe, expect, test, vi } from "vitest";
import { INITIAL_FEN, makeFen } from "chessops/fen";
import { makeSan } from "chessops/san";
import type { LexedPgnGame, LexPgnGamesOutcome } from "@/bindings";
import { errorUnlessCancelled } from "@/platform/errors";
import { cancellationError } from "@/platform/tauri";
import { MAX_TREE_DEPTH, MAX_TREE_NODES, PGN_TEXT_MAX } from "@/state/store/tabStorage";
import { getPGN } from "./chess";
import { parseSanOrUci, positionFromFen } from "./chessops";
import {
    createRepertoireMerger,
    MAX_REPERTOIRE_IMPORT_GAMES,
    mergeIntoRepertoire,
    readRepertoireSource,
    RepertoireImportError,
    type RepertoireImportSource,
} from "./repertoireImport";
import {
    createNode,
    defaultTree,
    rootHalfMoves,
    type TreeNode,
    type TreeState,
} from "./treeReducer";

const mocks = vi.hoisted(() => ({
    lexPgn: vi.fn(),
    lexPgnGames: vi.fn(),
    fileRevision: vi.fn(),
    countPgnGames: vi.fn(),
    readGames: vi.fn(),
}));

vi.mock("@/platform/tauri", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/platform/tauri")>();
    return {
        ...actual,
        tauri: {
            ...actual.tauri,
            lexPgn: mocks.lexPgn,
            lexPgnGames: mocks.lexPgnGames,
            fileRevision: mocks.fileRevision,
            countPgnGames: mocks.countPgnGames,
            readGames: mocks.readGames,
        },
    };
});

beforeEach(() => {
    mocks.lexPgn.mockReset();
    mocks.lexPgnGames.mockReset();
    mocks.fileRevision.mockReset();
    mocks.fileRevision.mockResolvedValue("rev1");
    mocks.countPgnGames.mockReset();
    mocks.readGames.mockReset();
});

const FILE_HANDLE = { root: "workspace", relPath: "repertoire.pgn" } as unknown as Parameters<
    typeof readRepertoireSource
>[0] extends { kind: "file"; file: infer F }
    ? F extends { handle: infer H }
        ? H
        : never
    : never;

function buildGame(moves: string[], fen?: string): TreeState {
    const tree = defaultTree(fen);
    let cur = tree.root;
    const [pos] = positionFromFen(tree.root.fen);
    if (!pos) throw new Error(`Invalid fixture FEN: ${tree.root.fen}`);
    for (const sanOrUci of moves) {
        const move = parseSanOrUci(pos, sanOrUci);
        if (!move)
            throw new Error(`Illegal fixture move ${sanOrUci} from ${makeFen(pos.toSetup())}`);
        const san = makeSan(pos, move);
        pos.play(move);
        const child = createNode({
            fen: makeFen(pos.toSetup()),
            move,
            san,
            halfMoves: cur.halfMoves + 1,
        });
        cur.children.push(child);
        cur = child;
    }
    return tree;
}

function sanTokens(moves: string[], fen?: string) {
    const tokens: Array<
        { type: "Header"; value: { tag: string; value: string } } | { type: "San"; value: string }
    > = [];
    if (fen) {
        tokens.push({ type: "Header", value: { tag: "SetUp", value: "1" } });
        tokens.push({ type: "Header", value: { tag: "FEN", value: fen } });
    }
    for (const san of moves) {
        tokens.push({ type: "San", value: san });
    }
    return tokens;
}

async function collectRepertoireSource(
    source: RepertoireImportSource,
    signal?: AbortSignal,
): Promise<{ games: TreeState[]; read: number; skipped: number }> {
    const games: TreeState[] = [];
    const { read, skipped } = await readRepertoireSource(source, {
        ...(signal ? { signal } : {}),
        onGame: (game) => {
            games.push(game);
            return null;
        },
    });
    return { games, read, skipped };
}

describe("readRepertoireSource (O1)", () => {
    test("file paging advances by returned page length across a short page", async () => {
        mocks.countPgnGames.mockResolvedValueOnce(3);
        mocks.readGames
            .mockResolvedValueOnce([
                { pgn: "1. e4 e5 *", stamp: "s0", revision: "rev1", present: true },
            ])
            .mockResolvedValueOnce([
                { pgn: "1. d4 d5 *", stamp: "s1", revision: "rev1", present: true },
                { pgn: "1. c4 e5 *", stamp: "s2", revision: "rev1", present: true },
            ]);
        mocks.lexPgn
            .mockResolvedValueOnce(sanTokens(["e4", "e5"]))
            .mockResolvedValueOnce(sanTokens(["d4", "d5"]))
            .mockResolvedValueOnce(sanTokens(["c4", "e5"]));

        const result = await collectRepertoireSource({
            kind: "file",
            file: { handle: FILE_HANDLE },
        });

        expect(mocks.readGames).toHaveBeenCalledTimes(2);
        expect(mocks.readGames).toHaveBeenNthCalledWith(1, FILE_HANDLE, 0, 2, undefined);
        expect(mocks.readGames).toHaveBeenNthCalledWith(2, FILE_HANDLE, 1, 2, undefined);
        expect(result.read).toBe(3);
        expect(result.skipped).toBe(0);
        expect(result.games.map((g) => g.root.children[0].san)).toEqual(["e4", "d4", "c4"]);
    });

    test("an omission or non-present game counts as skipped without parsing it", async () => {
        mocks.countPgnGames.mockResolvedValueOnce(3);
        mocks.readGames.mockResolvedValueOnce([
            {
                pgn: "",
                stamp: "s0",
                revision: "rev1",
                present: true,
                omission: "tooLarge",
            },
            { pgn: "", stamp: "s1", revision: "rev1", present: false },
            { pgn: "1. e4 e5 *", stamp: "s2", revision: "rev1", present: true },
        ]);
        mocks.lexPgn.mockResolvedValueOnce(sanTokens(["e4", "e5"]));

        const result = await collectRepertoireSource({
            kind: "file",
            file: { handle: FILE_HANDLE },
        });

        expect(mocks.lexPgn).toHaveBeenCalledTimes(1);
        expect(result.skipped).toBe(2);
        expect(result.read).toBe(1);
        expect(result.games).toHaveLength(1);
    });

    test("an empty page before the count refuses as a changed file (never loops)", async () => {
        mocks.countPgnGames.mockResolvedValueOnce(3);
        mocks.readGames
            .mockResolvedValueOnce([
                { pgn: "1. e4 e5 *", stamp: "s0", revision: "rev1", present: true },
            ])
            .mockResolvedValueOnce([]);
        mocks.lexPgn.mockResolvedValueOnce(sanTokens(["e4", "e5"]));

        await expect(
            collectRepertoireSource({ kind: "file", file: { handle: FILE_HANDLE } }),
        ).rejects.toMatchObject({
            name: "RepertoireImportError",
            code: "file-changed",
        });
        expect(mocks.readGames).toHaveBeenCalledTimes(2);
    });

    test("a revision change between pages refuses as a changed file", async () => {
        mocks.countPgnGames.mockResolvedValueOnce(2);
        mocks.readGames
            .mockResolvedValueOnce([
                { pgn: "1. e4 e5 *", stamp: "s0", revision: "rev1", present: true },
            ])
            .mockResolvedValueOnce([
                { pgn: "1. d4 d5 *", stamp: "s1", revision: "rev2", present: true },
            ]);
        mocks.lexPgn.mockResolvedValueOnce(sanTokens(["e4", "e5"]));

        await expect(
            collectRepertoireSource({ kind: "file", file: { handle: FILE_HANDLE } }),
        ).rejects.toMatchObject({
            name: "RepertoireImportError",
            code: "file-changed",
        });
    });

    test("reads fileRevision before countPgnGames and refuses append between counting and page 0 as file-changed", async () => {
        const order: string[] = [];
        mocks.fileRevision.mockImplementationOnce(async () => {
            order.push("fileRevision");
            return "rev-before-append";
        });
        mocks.countPgnGames.mockImplementationOnce(async () => {
            order.push("countPgnGames");
            return 1;
        });
        mocks.readGames.mockImplementationOnce(async () => {
            order.push("readGames");
            return [
                { pgn: "1. e4 e5 *", stamp: "s0", revision: "rev-after-append", present: true },
            ];
        });
        mocks.lexPgn.mockResolvedValueOnce(sanTokens(["e4", "e5"]));

        await expect(
            collectRepertoireSource({ kind: "file", file: { handle: FILE_HANDLE } }),
        ).rejects.toMatchObject({
            name: "RepertoireImportError",
            code: "file-changed",
        });
        expect(order).toEqual(["fileRevision", "countPgnGames", "readGames"]);
        expect(mocks.lexPgn).not.toHaveBeenCalled();
    });

    test("stops paging and refuses with too-large as soon as onGame returns a refusal reason", async () => {
        let seen = 0;
        mocks.countPgnGames.mockResolvedValueOnce(700);
        const makePage = (start: number, count: number) =>
            Array.from({ length: count }, (_, idx) => ({
                pgn: String(start + idx),
                stamp: `s-${start + idx}`,
                revision: "rev1",
                present: true,
            }));
        mocks.readGames.mockImplementation(async (_handle, start: number, end: number) =>
            makePage(start, end - start + 1),
        );
        mocks.lexPgn.mockResolvedValue(sanTokens(["e4", "e5"]));

        await expect(
            readRepertoireSource(
                { kind: "file", file: { handle: FILE_HANDLE } },
                {
                    onGame: () => (++seen >= 450 ? "max-nodes" : null),
                },
            ),
        ).rejects.toMatchObject({
            name: "RepertoireImportError",
            code: "too-large",
            reason: "max-nodes",
        });
        // Stopped during page 5 (indices 400..499) before fetching page 6 (indices 500..599).
        expect(mocks.readGames).toHaveBeenCalledTimes(5);

        // Text path also refuses immediately when onGame returns a refusal reason.
        mocks.lexPgnGames.mockResolvedValueOnce({
            status: "games",
            games: Array.from({ length: 10 }, () => ({
                status: "ok",
                tokens: sanTokens(["e4", "e5"]),
            })),
        });
        await expect(
            readRepertoireSource({ kind: "text", pgn: "too deep" }, { onGame: () => "max-depth" }),
        ).rejects.toMatchObject({
            name: "RepertoireImportError",
            code: "too-large",
            reason: "max-depth",
        });
    });

    test("accepts 1,500 games sharing an opening trunk whose unmerged node sum exceeds MAX_TREE_NODES", async () => {
        // 78-ply shared trunk + 2-ply leaf = 80 plies (81 nodes per game).
        // 1,500 * 81 = 121,500 unmerged nodes > MAX_TREE_NODES (100,000), merged << 1,000 nodes.
        const trunk = [
            ...Array.from({ length: 19 }, () => ["Nf3", "Nf6", "Ng1", "Ng8"]).flat(),
            "Nf3",
            "Nf6",
        ];
        const whiteReplies = ["e3", "e4", "d3", "d4", "c3", "c4", "g3", "b3", "Nc3", "a3"];
        const blackReplies = ["e6", "e5", "d6", "d5", "c6", "c5", "g6", "b6", "Nc6", "a6"];
        const leafPairs: Array<[string, string]> = [];
        for (const w of whiteReplies) {
            for (const b of blackReplies) {
                leafPairs.push([w, b]);
            }
        }
        const entries = Array.from({ length: 1500 }, (_, i) => {
            const [w, b] = leafPairs[i % leafPairs.length];
            return { status: "ok" as const, tokens: sanTokens([...trunk, w, b]) };
        });

        mocks.lexPgnGames.mockResolvedValueOnce({ status: "games", games: entries });
        const merger = createRepertoireMerger(defaultTree(), "white");
        const result = await readRepertoireSource(
            { kind: "text", pgn: "course" },
            { onGame: merger.add },
        );
        const merged = merger.finish();

        expect(result.read).toBe(1500);
        expect(result.skipped).toBe(0);
        expect(merged.ok).toBe(true);
    });

    test("streaming readRepertoireSource + createRepertoireMerger matches direct mergeIntoRepertoire on order, dedup, unplaced count, and black orientation", async () => {
        const nf3Fen = "rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2";
        const unrelatedFen = "4k3/8/8/8/8/8/8/4K3 b - - 0 1";
        const rawEntries = [
            // Game 1: custom FEN not yet in target (1. e4 e5 2. Nf3) -> unplaced
            { status: "ok" as const, tokens: sanTokens(["Nc6"], nf3Fen) },
            // Game 2: comment dedup against target ("King pawn" already on target e4) + adds 2. Nf3
            {
                status: "ok" as const,
                tokens: [
                    { type: "San" as const, value: "e4" },
                    { type: "Comment" as const, value: "King pawn" },
                    { type: "San" as const, value: "e5" },
                    { type: "San" as const, value: "Nf3" },
                ],
            },
            // Game 3: adds "Extra note" to e4 and conflicts with Black's 1... e5 via 1... c5
            {
                status: "ok" as const,
                tokens: [
                    { type: "San" as const, value: "e4" },
                    { type: "Comment" as const, value: "Extra note" },
                    { type: "San" as const, value: "c5" },
                ],
            },
            // Game 4: same custom FEN as Game 1, now placeable after Game 2 added 2. Nf3!
            { status: "ok" as const, tokens: sanTokens(["d6"], nf3Fen) },
            // Five unplaced games sharing one unrelated FEN -> must count all 5
            ...Array.from({ length: 5 }, () => ({
                status: "ok" as const,
                tokens: sanTokens(["Kd7"], unrelatedFen),
            })),
        ];

        const target = buildGame(["e4", "e5"]);
        target.root.children[0].comment = "King pawn";

        // Streamed path: readRepertoireSource -> createRepertoireMerger
        mocks.lexPgnGames.mockResolvedValueOnce({ status: "games", games: rawEntries });
        const merger = createRepertoireMerger(target, "black");
        const readResult = await readRepertoireSource(
            { kind: "text", pgn: "multi" },
            { onGame: merger.add },
        );
        const streamed = merger.finish();

        // Direct path: collect raw games -> mergeIntoRepertoire
        mocks.lexPgnGames.mockResolvedValueOnce({ status: "games", games: rawEntries });
        const collected = await collectRepertoireSource({ kind: "text", pgn: "multi" });
        const direct = mergeIntoRepertoire(target, collected.games, "black");

        expect(readResult.read).toBe(9);
        expect(streamed.ok).toBe(true);
        expect(direct.ok).toBe(true);
        if (!streamed.ok || !direct.ok) throw new Error("Expected both merges to succeed");
        expect(streamed.tree.root).toEqual(direct.tree.root);
        expect(streamed.report).toEqual(direct.report);

        // Explicit assertions on the closure-round counterexamples:
        expect(streamed.report.unplaced).toBe(6); // Game 1 + 5 unrelated
        expect(streamed.tree.root.children[0].comment).toBe("King pawn Extra note");
        // Black conflict mark on 1... c5 (existing 1... e5 stays first and unmarked)
        expect(streamed.tree.root.children[0].children.map((c) => c.san)).toEqual(["e5", "c5"]);
        expect(streamed.tree.root.children[0].children[0].reviewMark).toBeUndefined();
        expect(streamed.tree.root.children[0].children[1].reviewMark).toBe(true);
        // Game 4 placed 2... d6 under 2. Nf3 (order preserved after Game 2)
        expect(
            streamed.tree.root.children[0].children[0].children[0].children.map((c) => c.san),
        ).toEqual(["d6"]);
    });

    test.each(["invalid-input", "stale-game", "conflict"] as const)(
        "file change causing %s during readGames paging maps to file-changed (while count stays io)",
        async (category) => {
            mocks.fileRevision.mockResolvedValueOnce("rev1");
            mocks.countPgnGames.mockResolvedValueOnce(5);
            mocks.readGames.mockRejectedValueOnce({
                tag: "backend-error",
                category,
                message: "file changed during paging",
            });

            await expect(
                collectRepertoireSource({ kind: "file", file: { handle: FILE_HANDLE } }),
            ).rejects.toMatchObject({
                name: "RepertoireImportError",
                code: "file-changed",
            });

            mocks.fileRevision.mockResolvedValueOnce("rev1");
            mocks.countPgnGames.mockRejectedValueOnce({
                tag: "backend-error",
                category,
                message: "count failed",
            });

            await expect(
                collectRepertoireSource({ kind: "file", file: { handle: FILE_HANDLE } }),
            ).rejects.toMatchObject({
                name: "RepertoireImportError",
                code: "io",
            });
        },
    );

    test("LexedPgnGame rejects unsupported status tags at compile time and at runtime", async () => {
        // @ts-expect-error -- generated LexedPgnGame only permits status "ok" or "failed"
        const invalidTag: LexedPgnGame = { status: "tokens", tokens: sanTokens(["e4"]) };
        const invalidOutcome: LexPgnGamesOutcome = {
            status: "games",
            games: [invalidTag],
        };
        mocks.lexPgnGames.mockResolvedValueOnce(invalidOutcome);

        await expect(collectRepertoireSource({ kind: "text", pgn: "1. e4 *" })).rejects.toThrow(
            /Pattern matching error/,
        );
    });

    test("a file exceeding MAX_REPERTOIRE_IMPORT_GAMES refuses before reading any page", async () => {
        mocks.countPgnGames.mockResolvedValueOnce(MAX_REPERTOIRE_IMPORT_GAMES + 1);

        await expect(
            collectRepertoireSource({ kind: "file", file: { handle: FILE_HANDLE } }),
        ).rejects.toMatchObject({
            name: "RepertoireImportError",
            code: "too-many-games",
        });
        expect(mocks.readGames).not.toHaveBeenCalled();
    });

    test("an illegal-move game or invalid root FEN is skipped, not spliced; preservation losses are kept", async () => {
        mocks.lexPgnGames.mockResolvedValueOnce({
            status: "games",
            games: [
                { status: "ok", tokens: sanTokens(["e4", "Ke8", "Nf3"]) },
                { status: "ok", tokens: sanTokens(["e4"], "not-a-valid-fen") },
                { status: "failed", message: "lexer failure" },
                {
                    status: "ok",
                    tokens: [
                        { type: "San", value: "e4" },
                        { type: "Comment", value: "[%clk 0:05:00] [%clk 0:04:00]" },
                        { type: "San", value: "e5" },
                    ],
                },
            ],
        });

        const result = await collectRepertoireSource({ kind: "text", pgn: "..." });
        expect(mocks.lexPgnGames).toHaveBeenCalledWith(
            "...",
            MAX_REPERTOIRE_IMPORT_GAMES,
            undefined,
        );
        expect(result.skipped).toBe(3);
        expect(result.games).toHaveLength(1);
        expect(result.games[0].root.children[0].san).toBe("e4");
        expect(result.games[0].root.children[0].children[0].san).toBe("e5");
    });

    test("an all-skipped source or empty file refuses with no-usable-games", async () => {
        mocks.lexPgnGames.mockResolvedValueOnce({
            status: "games",
            games: [
                { status: "ok", tokens: sanTokens(["Ke8"]) },
                { status: "failed", message: "bad" },
            ],
        });
        await expect(
            collectRepertoireSource({ kind: "text", pgn: "1. Ke8 *" }),
        ).rejects.toMatchObject({
            name: "RepertoireImportError",
            code: "no-usable-games",
        });

        mocks.countPgnGames.mockResolvedValueOnce(0);
        await expect(
            collectRepertoireSource({ kind: "file", file: { handle: FILE_HANDLE } }),
        ).rejects.toMatchObject({
            name: "RepertoireImportError",
            code: "no-usable-games",
        });
        expect(mocks.readGames).not.toHaveBeenCalled();
    });

    test("a page longer than the remaining count refuses as a changed file", async () => {
        mocks.countPgnGames.mockResolvedValueOnce(2);
        mocks.readGames.mockResolvedValueOnce([
            { pgn: "1. e4 *", stamp: "s0", revision: "rev1", present: true },
            { pgn: "1. d4 *", stamp: "s1", revision: "rev1", present: true },
            { pgn: "1. c4 *", stamp: "s2", revision: "rev1", present: true },
        ]);

        await expect(
            collectRepertoireSource({ kind: "file", file: { handle: FILE_HANDLE } }),
        ).rejects.toMatchObject({
            name: "RepertoireImportError",
            code: "file-changed",
        });
    });

    test("cancellation propagates as cancellation without wrapping in RepertoireImportError", async () => {
        const controller = new AbortController();
        controller.abort();

        let caught: unknown;
        try {
            await collectRepertoireSource({ kind: "text", pgn: "1. e4 *" }, controller.signal);
        } catch (err) {
            caught = err;
        }
        expect(caught).toBeDefined();
        expect(caught instanceof RepertoireImportError).toBe(false);
        expect(errorUnlessCancelled(caught)).toBeNull();

        mocks.lexPgnGames.mockRejectedValueOnce(cancellationError());
        let caughtBackend: unknown;
        try {
            await collectRepertoireSource({ kind: "text", pgn: "1. e4 *" });
        } catch (err) {
            caughtBackend = err;
        }
        expect(caughtBackend instanceof RepertoireImportError).toBe(false);
        expect(errorUnlessCancelled(caughtBackend)).toBeNull();
    });

    test("per-game lexPgn skips only invalid-input/parsing/chess-data backend errors, refuses resource-limit/conflict/io, and propagates cancellation", async () => {
        mocks.countPgnGames.mockResolvedValueOnce(3);
        mocks.readGames.mockResolvedValueOnce([
            { pgn: "1. e4 *", stamp: "s0", revision: "rev1", present: true },
            { pgn: "1. c4 *", stamp: "s1", revision: "rev1", present: true },
            { pgn: "1. d4 *", stamp: "s2", revision: "rev1", present: true },
        ]);
        mocks.lexPgn
            .mockRejectedValueOnce({
                tag: "backend-error",
                category: "parsing",
                message: "malformed comment",
            })
            .mockRejectedValueOnce({
                tag: "backend-error",
                category: "invalid-input",
                message: "more than one game",
            })
            .mockResolvedValueOnce(sanTokens(["d4"]));

        const validated = await collectRepertoireSource({
            kind: "file",
            file: { handle: FILE_HANDLE },
        });
        expect(validated.skipped).toBe(2);
        expect(validated.games).toHaveLength(1);
        expect(validated.games[0].root.children[0].san).toBe("d4");

        // Non-skip backend categories (io, resource-limit, conflict) refuse the whole import as "io".
        for (const category of ["io", "resource-limit", "conflict"] as const) {
            mocks.countPgnGames.mockResolvedValueOnce(2);
            mocks.readGames.mockResolvedValueOnce([
                { pgn: "1. e4 *", stamp: "s0", revision: "rev1", present: true },
                { pgn: "1. d4 *", stamp: "s1", revision: "rev1", present: true },
            ]);
            mocks.lexPgn
                .mockRejectedValueOnce({
                    tag: "backend-error",
                    category,
                    message: `${category} failure`,
                })
                .mockResolvedValueOnce(sanTokens(["d4"]));

            await expect(
                collectRepertoireSource({ kind: "file", file: { handle: FILE_HANDLE } }),
            ).rejects.toMatchObject({
                name: "RepertoireImportError",
                code: "io",
            });
            mocks.lexPgn.mockReset();
        }

        // Cancellation rejection from per-game lexPgn propagates as cancellation.
        mocks.countPgnGames.mockResolvedValueOnce(1);
        mocks.readGames.mockResolvedValueOnce([
            { pgn: "1. e4 *", stamp: "s0", revision: "rev1", present: true },
        ]);
        mocks.lexPgn.mockRejectedValueOnce(cancellationError());

        let caught: unknown;
        try {
            await collectRepertoireSource({ kind: "file", file: { handle: FILE_HANDLE } });
        } catch (err) {
            caught = err;
        }
        expect(caught instanceof RepertoireImportError).toBe(false);
        expect(errorUnlessCancelled(caught)).toBeNull();
    });

    test("pasted-text tooManyGames outcome maps to too-many-games while backend rejections map to io", async () => {
        mocks.lexPgnGames.mockResolvedValueOnce({
            status: "tooManyGames",
            count: MAX_REPERTOIRE_IMPORT_GAMES + 5,
        });
        await expect(
            collectRepertoireSource({ kind: "text", pgn: "1. e4 *" }),
        ).rejects.toMatchObject({
            name: "RepertoireImportError",
            code: "too-many-games",
            message: expect.stringContaining(`${MAX_REPERTOIRE_IMPORT_GAMES + 5}`),
        });

        mocks.lexPgnGames.mockRejectedValueOnce({
            tag: "backend-error",
            category: "resource-limit",
            message: "native read capacity exceeded",
        });
        await expect(
            collectRepertoireSource({ kind: "text", pgn: "1. e4 *" }),
        ).rejects.toMatchObject({
            name: "RepertoireImportError",
            code: "io",
        });

        mocks.lexPgnGames.mockRejectedValueOnce({
            tag: "backend-error",
            category: "io",
            message: "lexer transport failed",
        });
        await expect(
            collectRepertoireSource({ kind: "text", pgn: "1. e4 *" }),
        ).rejects.toMatchObject({
            name: "RepertoireImportError",
            code: "io",
        });

        mocks.countPgnGames.mockRejectedValueOnce({
            tag: "backend-error",
            category: "resource-limit",
            message: "line too long",
        });
        await expect(
            collectRepertoireSource({ kind: "file", file: { handle: FILE_HANDLE } }),
        ).rejects.toMatchObject({
            name: "RepertoireImportError",
            code: "io",
        });

        mocks.countPgnGames.mockRejectedValueOnce({
            tag: "backend-error",
            category: "io",
            message: "disk read error",
        });
        await expect(
            collectRepertoireSource({ kind: "file", file: { handle: FILE_HANDLE } }),
        ).rejects.toMatchObject({
            name: "RepertoireImportError",
            code: "io",
        });

        mocks.countPgnGames.mockResolvedValueOnce(1);
        mocks.readGames.mockRejectedValueOnce({
            tag: "backend-error",
            category: "resource-limit",
            message: "page byte limit",
        });
        await expect(
            collectRepertoireSource({ kind: "file", file: { handle: FILE_HANDLE } }),
        ).rejects.toMatchObject({
            name: "RepertoireImportError",
            code: "io",
        });

        mocks.countPgnGames.mockResolvedValueOnce(1);
        mocks.readGames.mockRejectedValueOnce({
            tag: "backend-error",
            category: "io",
            message: "disk read error",
        });
        await expect(
            collectRepertoireSource({ kind: "file", file: { handle: FILE_HANDLE } }),
        ).rejects.toMatchObject({
            name: "RepertoireImportError",
            code: "io",
        });
    });

    test("variation with an illegal move or Unparsed token is skipped by readRepertoireSource", async () => {
        mocks.lexPgnGames.mockResolvedValueOnce({
            status: "games",
            games: [
                {
                    status: "ok",
                    tokens: [
                        { type: "San", value: "e4" },
                        { type: "ParenOpen" },
                        { type: "San", value: "Ke8" },
                        { type: "ParenClose" },
                        { type: "San", value: "e5" },
                    ],
                },
                {
                    status: "ok",
                    tokens: [
                        { type: "San", value: "e4" },
                        { type: "ParenOpen" },
                        { type: "San", value: "d4" },
                        { type: "Unparsed", value: "???" },
                        { type: "ParenClose" },
                    ],
                },
                { status: "ok", tokens: sanTokens(["d4", "d5"]) },
            ],
        });

        const result = await collectRepertoireSource({ kind: "text", pgn: "..." });
        expect(result.skipped).toBe(2);
        expect(result.games).toHaveLength(1);
        expect(result.games[0].root.children[0].san).toBe("d4");
    });
});

describe("mergeIntoRepertoire (O2)", () => {
    test("conflicting user-side reply is appended and marked while existing move stays first; opponent branch is unmarked", () => {
        const target = buildGame(["e4", "e5", "Nf3"]);
        const snapshot = structuredClone(target);
        const imported = buildGame(["e4", "c5", "Nf3"]);
        const conflicting = buildGame(["d4", "d5"]);

        const result = mergeIntoRepertoire(target, [imported, conflicting], "white");
        expect(target).toEqual(snapshot); // input never mutated
        expect(result.ok).toBe(true);
        if (!result.ok) return;

        expect(result.report).toEqual({ added: 4, conflicts: 1, unplaced: 0 });
        // Existing White move e4 stays first; imported conflicting d4 is appended and marked.
        expect(result.tree.root.children.map((c) => c.san)).toEqual(["e4", "d4"]);
        expect(result.tree.root.children[0].reviewMark).toBeUndefined();
        expect(result.tree.root.children[1].reviewMark).toBe(true);
        // Opponent (Black) reply c5 after 1. e4 is appended unmarked.
        expect(result.tree.root.children[0].children.map((c) => c.san)).toEqual(["e5", "c5"]);
        expect(result.tree.root.children[0].children[1].reviewMark).toBeUndefined();
    });

    test("side to move comes from the node's FEN (Black-to-move start FEN, never ply parity)", () => {
        const blackToMoveFen = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
        const target = buildGame(["e5"], blackToMoveFen);
        const imported = buildGame(["c5"], blackToMoveFen);

        const asBlack = mergeIntoRepertoire(target, [imported], "black");
        expect(asBlack.ok).toBe(true);
        if (!asBlack.ok) return;
        expect(asBlack.report.conflicts).toBe(1);
        expect(asBlack.tree.root.children[1].reviewMark).toBe(true);

        const asWhite = mergeIntoRepertoire(target, [imported], "white");
        expect(asWhite.ok).toBe(true);
        if (!asWhite.ok) return;
        expect(asWhite.report.conflicts).toBe(0);
        expect(asWhite.tree.root.children[1].reviewMark).toBeUndefined();
    });

    test("grafted mid-tree game gets replayed FENs and parent.halfMoves + 1", () => {
        // Target reaches 1. e4 e5 2. Nf3 (halfMoves = 3, fullmove = 2, Black to move).
        const target = buildGame(["e4", "e5", "Nf3"]);
        // Imported game starts from the same board state but with a custom fullmove counter (10).
        const customFen = "rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 10";
        const imported = buildGame(["Nc6", "Bb5"], customFen);

        const result = mergeIntoRepertoire(target, [imported], "white");
        expect(result.ok).toBe(true);
        if (!result.ok) return;

        expect(result.report).toEqual({ added: 2, conflicts: 0, unplaced: 0 });
        const nc6 = result.tree.root.children[0].children[0].children[0].children[0];
        const bb5 = nc6.children[0];
        expect(nc6.san).toBe("Nc6");
        expect(nc6.halfMoves).toBe(4);
        expect(nc6.fen).toContain(" 2 3"); // replayed from target's fullmove 2 -> 3, NOT 11
        expect(bb5.san).toBe("Bb5");
        expect(bb5.halfMoves).toBe(5);
    });

    test("empty target seeded from a custom Black-to-move FEN numbers its first move correctly", () => {
        const emptyTarget = defaultTree();
        const customFen = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 10";
        const imported = buildGame(["c5", "Nf3"], customFen);

        const result = mergeIntoRepertoire(emptyTarget, [imported], "black");
        expect(result.ok).toBe(true);
        if (!result.ok) return;

        expect(result.tree.root.fen).toBe(customFen);
        expect(result.tree.headers.fen).toBe(customFen);
        expect(result.tree.root.halfMoves).toBe(rootHalfMoves(customFen));
        expect(result.tree.root.children[0].halfMoves).toBe(rootHalfMoves(customFen) + 1);

        const pgn = getPGN(result.tree.root, {
            headers: result.tree.headers,
            glyphs: true,
            comments: true,
            variations: true,
            extraMarkups: true,
        });
        expect(pgn).toContain("10... c5 11. Nf3");
    });

    test("annotations (comments, startingComment, NAGs, shapes, score+depth, diagram) are kept and merged; clocks and gameEnd are dropped", () => {
        const target = buildGame(["e4", "e5"]);
        const targetE4 = target.root.children[0];
        targetE4.comment = "Main move";
        targetE4.nags = [1];
        targetE4.shapes = [{ orig: "e2", dest: "e4", brush: "green" }];

        const imported = buildGame(["e4", "c5"]);
        const impE4 = imported.root.children[0];
        impE4.comment = "Strong center";
        impE4.nags = [1, 3];
        impE4.shapes = [
            { orig: "e2", dest: "e4", brush: "green" },
            { orig: "d2", dest: "d4", brush: "red" },
        ];
        impE4.score = { value: { type: "cp", value: 35 }, wdl: null };
        impE4.depth = 18;
        impE4.diagram = true;
        impE4.clock = 300;
        impE4.gameEnd = { termination: "Normal" };

        const impC5 = impE4.children[0];
        impC5.comment = "Sicilian";
        impC5.startingComment = "Leading note";
        impC5.nags = [6];
        impC5.shapes = [{ orig: "c7", dest: "c5", brush: "blue" }];
        impC5.commands = "[%evp 0,12]";
        impC5.score = { value: { type: "cp", value: 20 }, wdl: null };
        impC5.depth = 22;
        impC5.diagram = true;
        impC5.clock = 295;
        impC5.gameEnd = { termination: "Abandoned" };

        const result = mergeIntoRepertoire(target, [imported], "white");
        expect(result.ok).toBe(true);
        if (!result.ok) return;

        const mergedE4 = result.tree.root.children[0];
        expect(mergedE4.comment).toBe("Main move Strong center");
        expect(mergedE4.nags).toEqual([1, 3]);
        expect(mergedE4.shapes).toEqual([
            { orig: "e2", dest: "e4", brush: "green" },
            { orig: "d2", dest: "d4", brush: "red" },
        ]);
        expect(mergedE4.score).toEqual({ value: { type: "cp", value: 35 }, wdl: null });
        expect(mergedE4.depth).toBe(18);
        expect(mergedE4.diagram).toBe(true);
        expect(mergedE4.clock).toBeUndefined();
        expect(mergedE4.gameEnd).toBeUndefined();

        const mergedC5 = mergedE4.children[1];
        expect(mergedC5.comment).toBe("Sicilian");
        expect(mergedC5.startingComment).toBe("Leading note");
        expect(mergedC5.nags).toEqual([6]);
        expect(mergedC5.shapes).toEqual([{ orig: "c7", dest: "c5", brush: "blue" }]);
        expect(mergedC5.commands).toBe("[%evp 0,12]");
        expect(mergedC5.score).toEqual({ value: { type: "cp", value: 20 }, wdl: null });
        expect(mergedC5.depth).toBe(22);
        expect(mergedC5.diagram).toBe(true);
        expect(mergedC5.clock).toBeUndefined();
        expect(mergedC5.gameEnd).toBeUndefined();

        // Re-importing the same comment does not duplicate it.
        const second = mergeIntoRepertoire(result.tree, [imported], "white");
        expect(second.ok).toBe(true);
        if (!second.ok) return;
        expect(second.tree.root.children[0].comment).toBe("Main move Strong center");
    });

    test("unplaced games are counted without modifying the target", () => {
        const target = buildGame(["e4", "e5"]);
        const unrelated = buildGame(["Kd7"], "4k3/8/8/8/8/8/8/4K3 b - - 0 1");

        const result = mergeIntoRepertoire(target, [unrelated], "white");
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.report).toEqual({ added: 0, conflicts: 0, unplaced: 1 });
        expect(result.changed).toBe(false);
    });

    test("depth, node, and byte limits refuse with nothing applied", () => {
        // Depth limit: target has a chain of MAX_TREE_DEPTH moves, importing 1 more move refuses.
        const deepTarget = defaultTree();
        let cur: TreeNode = deepTarget.root;
        const [pos] = positionFromFen(INITIAL_FEN);
        if (!pos) throw new Error("Invalid start");
        const cycle = ["Nf3", "Nf6", "Ng1", "Ng8"];
        for (let i = 0; i < MAX_TREE_DEPTH - 1; i++) {
            const san = cycle[i % cycle.length];
            const move = parseSanOrUci(pos, san)!;
            pos.play(move);
            const next = createNode({
                fen: makeFen(pos.toSetup()),
                move,
                san,
                halfMoves: i + 1,
            });
            cur.children.push(next);
            cur = next;
        }
        // Final ply at MAX_TREE_DEPTH reaches a unique position not seen earlier in the cycle.
        const uniqueSan = pos.turn === "white" ? "e4" : "e5";
        const uniqueMove = parseSanOrUci(pos, uniqueSan)!;
        pos.play(uniqueMove);
        const leaf = createNode({
            fen: makeFen(pos.toSetup()),
            move: uniqueMove,
            san: uniqueSan,
            halfMoves: MAX_TREE_DEPTH,
        });
        cur.children.push(leaf);
        cur = leaf;

        const deepExtra = buildGame([pos.turn === "white" ? "d4" : "d5"], cur.fen);
        const deepResult = mergeIntoRepertoire(deepTarget, [deepExtra], "white");
        expect(deepResult).toMatchObject({ ok: false, reason: "max-depth" });
        expect(cur.children).toHaveLength(0);

        // Node limit: target already has MAX_TREE_NODES nodes (root + children), importing 1 more refuses.
        const wideTarget = defaultTree();
        const [e4Pos] = positionFromFen(INITIAL_FEN);
        const e4Move = parseSanOrUci(e4Pos!, "e4")!;
        e4Pos!.play(e4Move);
        const e4Fen = makeFen(e4Pos!.toSetup());
        const d4Pos = positionFromFen(INITIAL_FEN)[0]!;
        const d4Move = parseSanOrUci(d4Pos, "d4")!;
        d4Pos.play(d4Move);
        const d4Fen = makeFen(d4Pos.toSetup());
        // Build a synthetic tree of exactly MAX_TREE_NODES nodes (1 root + MAX_TREE_NODES - 1 children).
        const e4Node = createNode({ fen: e4Fen, move: e4Move, san: "e4", halfMoves: 1 });
        wideTarget.root.children.push(e4Node);
        for (let i = 2; i < MAX_TREE_NODES; i++) {
            e4Node.children.push(
                createNode({ fen: d4Fen, move: d4Move, san: `x${i}`, halfMoves: 2 }),
            );
        }
        const oneMore = buildGame(["d4"]);
        const nodeResult = mergeIntoRepertoire(wideTarget, [oneMore], "white");
        expect(nodeResult).toMatchObject({ ok: false, reason: "max-nodes" });
        expect(wideTarget.root.children).toHaveLength(1);

        // Byte limit: merged serialized PGN > PGN_TEXT_MAX refuses.
        const byteTarget = buildGame(["e4"]);
        const hugeGame = buildGame(["e4", "c5"]);
        hugeGame.root.children[0].children[0].comment = "a".repeat(PGN_TEXT_MAX + 128);
        const byteResult = mergeIntoRepertoire(byteTarget, [hugeGame], "white");
        expect(byteResult).toMatchObject({ ok: false, reason: "max-bytes" });
        expect(byteTarget.root.children[0].children).toHaveLength(0);
    });

    test("empty target preserves existing root annotations when FEN is unchanged and when root is replaced", () => {
        const makeAnnotatedEmpty = () => {
            const target = defaultTree();
            target.root.comment = "Opening plan";
            target.root.startingComment = "Lead";
            target.root.nags = [10];
            target.root.shapes = [{ orig: "e2", dest: "e4", brush: "green" }];
            target.root.commands = "[%evp 0,1]";
            target.root.score = { value: { type: "cp", value: 15 }, wdl: null };
            target.root.depth = 12;
            target.root.diagram = true;
            return target;
        };

        // Case A: same start FEN (INITIAL_FEN)
        const sameFenResult = mergeIntoRepertoire(
            makeAnnotatedEmpty(),
            [buildGame(["e4"])],
            "white",
        );
        expect(sameFenResult.ok).toBe(true);
        if (!sameFenResult.ok) throw new Error("Expected same-FEN merge to succeed");
        expect(sameFenResult.tree.root.comment).toBe("Opening plan");
        expect(sameFenResult.tree.root.startingComment).toBe("Lead");
        expect(sameFenResult.tree.root.nags).toEqual([10]);
        expect(sameFenResult.tree.root.shapes).toEqual([
            { orig: "e2", dest: "e4", brush: "green" },
        ]);
        expect(sameFenResult.tree.root.commands).toBe("[%evp 0,1]");
        expect(sameFenResult.tree.root.score).toEqual({
            value: { type: "cp", value: 15 },
            wdl: null,
        });
        expect(sameFenResult.tree.root.depth).toBe(12);
        expect(sameFenResult.tree.root.diagram).toBe(true);

        // Case B: custom start FEN replaces root and carries existing root annotations
        const customFen = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 10";
        const replacedResult = mergeIntoRepertoire(
            makeAnnotatedEmpty(),
            [buildGame(["c5"], customFen)],
            "black",
        );
        expect(replacedResult.ok).toBe(true);
        if (!replacedResult.ok) throw new Error("Expected custom-FEN merge to succeed");
        expect(replacedResult.tree.root.fen).toBe(customFen);
        expect(replacedResult.tree.root.halfMoves).toBe(rootHalfMoves(customFen));
        expect(replacedResult.tree.root.comment).toBe("Opening plan");
        expect(replacedResult.tree.root.startingComment).toBe("Lead");
        expect(replacedResult.tree.root.nags).toEqual([10]);
        expect(replacedResult.tree.root.shapes).toEqual([
            { orig: "e2", dest: "e4", brush: "green" },
        ]);
        expect(replacedResult.tree.root.commands).toBe("[%evp 0,1]");
        expect(replacedResult.tree.root.score).toEqual({
            value: { type: "cp", value: 15 },
            wdl: null,
        });
        expect(replacedResult.tree.root.depth).toBe(12);
        expect(replacedResult.tree.root.diagram).toBe(true);
    });

    test("merged comments forming a physical line >= 1 MiB refuse with max-line-bytes", () => {
        const target = defaultTree();
        const game1 = buildGame(["e4"]);
        game1.root.children[0].comment = "a".repeat(600 * 1024);
        const game2 = buildGame(["e4"]);
        game2.root.children[0].comment = "b".repeat(600 * 1024);

        const result = mergeIntoRepertoire(target, [game1, game2], "white");
        expect(result).toMatchObject({ ok: false, reason: "max-line-bytes" });
    });

    test("existing score/depth, startingComment, and commands win on an existing node", () => {
        const target = buildGame(["e4"]);
        const targetE4 = target.root.children[0];
        targetE4.score = { value: { type: "cp", value: 40 }, wdl: null };
        targetE4.depth = 20;
        targetE4.startingComment = "Existing start";
        targetE4.commands = "[%evp 0,40]";

        const imported = buildGame(["e4"]);
        const impE4 = imported.root.children[0];
        impE4.score = { value: { type: "cp", value: -90 }, wdl: null };
        impE4.depth = 30;
        impE4.startingComment = "Imported start";
        impE4.commands = "[%evp 0,99]";

        const result = mergeIntoRepertoire(target, [imported], "white");
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error("Expected merge to succeed");
        const mergedE4 = result.tree.root.children[0];
        expect(mergedE4.score).toEqual({ value: { type: "cp", value: 40 }, wdl: null });
        expect(mergedE4.depth).toBe(20);
        expect(mergedE4.startingComment).toBe("Existing start");
        expect(mergedE4.commands).toBe("[%evp 0,40]");
    });

    test("new nodes clone source move objects instead of aliasing input moves", () => {
        const target = defaultTree();
        const imported = buildGame(["e4"]);
        const result = mergeIntoRepertoire(target, [imported], "white");
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error("Expected merge to succeed");
        expect(result.tree.root.children[0].move).toEqual(imported.root.children[0].move);
        expect(result.tree.root.children[0].move).not.toBe(imported.root.children[0].move);
    });

    test("Chess960 Shredder-FEN castling falls back to SAN when source move encoding is not legal as-is", () => {
        // White king on d1 (sq 3), White rook on h1 (sq 7), Shredder-FEN castling right "H".
        // Legal Chess960 O-O is king-to-rook { from: 3, to: 7 }; king-to-destination { from: 3, to: 6 } is illegal as-is.
        const fen960 = "4k3/8/8/8/8/8/8/3K3R w H - 0 1";
        const target = defaultTree(fen960);
        const imported = defaultTree(fen960);
        const [pos] = positionFromFen(fen960);
        expect(pos).not.toBeNull();
        expect(pos!.isLegal({ from: 3, to: 6 })).toBe(false);
        imported.root.children.push(
            createNode({
                fen: "4k3/8/8/8/8/8/8/5RK1 b - - 1 1",
                move: { from: 3, to: 6 },
                san: "O-O",
                halfMoves: 1,
            }),
        );

        const result = mergeIntoRepertoire(target, [imported], "white");
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error("Expected Chess960 merge to succeed");
        expect(result.report.added).toBe(1);
        expect(result.tree.root.children[0].san).toBe("O-O");
        expect(result.tree.root.children[0].move).toEqual({ from: 3, to: 7 });
        expect(result.tree.root.children[0].fen).toBe("4k3/8/8/8/8/8/8/5RK1 b - - 1 1");
    });
});
