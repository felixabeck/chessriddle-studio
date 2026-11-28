import { describe, expect, test } from "vitest";
import type { FileWorkspaceHandle, PositionStats } from "@/bindings";
import type { FileMetadata } from "@/components/files/file";
import type {
    IndexedRepertoireChapter,
    IndexedRepertoireFile,
    RepertoireChapterHeaders,
    RepertoireChapterNode,
} from "@/state/repertoireIndex";
import { positionFromFen } from "@/utils/chessops";
import { makeFen } from "chessops/fen";
import { parseSan } from "chessops/san";
import {
    classifyChapterNodes,
    classifyTreeNodes,
    collectPreparationFens,
    combinePreparationStats,
    computePreparationView,
    computePreparationViews,
    INITIAL_BOARD_STATE,
    parsePreparationMinGames,
    type NodeClassification,
    type PreparationColor,
    preparationViewForSource,
} from "@/utils/opponentPreparation";
import { defaultTree, getBoardState, type TreeNode } from "@/utils/treeReducer";

function makeFileMetadata(name: string, numGames = 1): FileMetadata {
    return {
        type: "file",
        handle: { id: { id: name }, kind: "file" } as unknown as FileWorkspaceHandle,
        name,
        numGames,
        metadata: { type: "repertoire", tags: [] },
        lastModified: 1,
    };
}

type MoveSpec = { san: string; children?: MoveSpec[] };

/** Builds a real chess tree and its matching `IndexedRepertoireChapter` from SAN specs. */
function buildChapter(options: {
    chapter?: number;
    fen?: string;
    headers?: Partial<RepertoireChapterHeaders>;
    moves?: MoveSpec[];
}): { chapter: IndexedRepertoireChapter; root: TreeNode } {
    const tree = defaultTree(options.fen);
    const root = tree.root;

    function attach(parent: TreeNode, specs: MoveSpec[]) {
        for (const spec of specs) {
            const [pos, err] = positionFromFen(parent.fen);
            if (!pos || err) throw new Error(`Invalid test FEN: ${parent.fen}`);
            const move = parseSan(pos, spec.san);
            if (!move) throw new Error(`Illegal test SAN "${spec.san}" from ${parent.fen}`);
            pos.play(move);
            const child: TreeNode = {
                fen: makeFen(pos.toSetup()),
                move,
                san: spec.san,
                children: [],
                score: null,
                depth: null,
                halfMoves: parent.halfMoves + 1,
                shapes: [],
                nags: [],
                comment: "",
            };
            parent.children.push(child);
            if (spec.children) attach(child, spec.children);
        }
    }

    if (options.moves) attach(root, options.moves);

    const nodes: RepertoireChapterNode[] = [];
    function flatten(node: TreeNode, parentIndex: number, path: number[]) {
        const index = nodes.length;
        nodes.push({
            boardState: getBoardState(node.fen),
            parent: parentIndex,
            san: node.san,
            path,
            halfMoves: node.halfMoves,
            hasContinuation: node.children.length > 0,
        });
        for (let i = 0; i < node.children.length; i++) {
            flatten(node.children[i], index, [...path, i]);
        }
    }
    flatten(root, -1, []);

    const headers: RepertoireChapterHeaders = {
        white: "",
        black: "",
        event: "",
        ...options.headers,
    };
    return {
        chapter: { chapter: options.chapter ?? 0, headers, nodes },
        root,
    };
}

function makeFile(name: string, chapters: IndexedRepertoireChapter[]): IndexedRepertoireFile {
    return {
        workspaceKey: `file:${name}`,
        file: makeFileMetadata(name, chapters.length),
        chapters,
        partial: false,
    };
}

function statRow(
    move: string,
    counts: Partial<Pick<PositionStats, "white" | "draw" | "black" | "unknown">>,
    lastPlayed: string | null = null,
    yearCounts: { year: number; count: number }[] = [],
): PositionStats {
    return {
        move,
        white: counts.white ?? 0,
        draw: counts.draw ?? 0,
        black: counts.black ?? 0,
        unknown: counts.unknown ?? 0,
        last_played: lastPlayed,
        year_counts: yearCounts,
        recent: [],
    };
}

function boardAfter(moves: string[], startFen?: string): string {
    const { chapter } = buildChapter({
        fen: startFen,
        moves: moves.reduceRight<MoveSpec[]>((children, san) => [{ san, children }], []),
    });
    return chapter.nodes[chapter.nodes.length - 1].boardState;
}

describe("node classification (table-driven)", () => {
    const blackToMoveFen = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
    const customWhiteFen = "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3";

    const cases: Array<{
        name: string;
        opponentColor: PreparationColor;
        fen?: string;
        orientation?: PreparationColor;
        moves: MoveSpec[];
        playedBoardStates: string[];
        expectedInPreparation: boolean;
        expected: Array<{ path: number[]; classification: NodeClassification }>;
    }> = [
        {
            name: "White repertoire (missing orientation): played, open below user move, excluded below opponent move",
            opponentColor: "black",
            orientation: undefined,
            moves: [
                {
                    san: "e4",
                    children: [
                        {
                            san: "e5",
                            children: [
                                // User (White) to move at e4 e5 (played): Nf3 is played, Nc3 is open (with open descendant)
                                { san: "Nf3" },
                                { san: "Nc3", children: [{ san: "Nf6" }] },
                            ],
                        },
                        // Opponent (Black) to move at e4 (played): c5 is unplayed -> excluded (with excluded descendant)
                        { san: "c5", children: [{ san: "Nf3" }] },
                    ],
                },
            ],
            playedBoardStates: [
                INITIAL_BOARD_STATE,
                boardAfter(["e4"]),
                boardAfter(["e4", "e5"]),
                boardAfter(["e4", "e5", "Nf3"]),
            ],
            expectedInPreparation: true,
            expected: [
                { path: [], classification: { status: "played", relevant: true } },
                { path: [0], classification: { status: "played", relevant: true } },
                { path: [0, 0], classification: { status: "played", relevant: true } },
                { path: [0, 0, 0], classification: { status: "played", relevant: true } },
                { path: [0, 0, 1], classification: { status: "open", relevant: true } },
                { path: [0, 0, 1, 0], classification: { status: "open", relevant: true } },
                { path: [0, 1], classification: { status: "excluded", relevant: false } },
                { path: [0, 1, 0], classification: { status: "excluded", relevant: false } },
            ],
        },
        {
            name: "excluded branch transposing into a played position marks ancestors relevant",
            opponentColor: "black",
            orientation: "white",
            moves: [
                {
                    san: "e4",
                    children: [
                        // 1. e4 e5 2. Nf3 Nc6 (played)
                        {
                            san: "e5",
                            children: [{ san: "Nf3", children: [{ san: "Nc6" }] }],
                        },
                        // 1. e4 Nc6 (unplayed opponent move -> excluded) 2. Nf3 (excluded) e5 (transposes to played!)
                        {
                            san: "Nc6",
                            children: [{ san: "Nf3", children: [{ san: "e5" }] }],
                        },
                    ],
                },
            ],
            playedBoardStates: [
                INITIAL_BOARD_STATE,
                boardAfter(["e4"]),
                boardAfter(["e4", "e5"]),
                boardAfter(["e4", "e5", "Nf3"]),
                boardAfter(["e4", "e5", "Nf3", "Nc6"]),
            ],
            expectedInPreparation: true,
            expected: [
                { path: [], classification: { status: "played", relevant: true } },
                { path: [0], classification: { status: "played", relevant: true } },
                { path: [0, 0], classification: { status: "played", relevant: true } },
                { path: [0, 0, 0], classification: { status: "played", relevant: true } },
                { path: [0, 0, 0, 0], classification: { status: "played", relevant: true } },
                { path: [0, 1], classification: { status: "excluded", relevant: true } },
                { path: [0, 1, 0], classification: { status: "excluded", relevant: true } },
                { path: [0, 1, 0, 0], classification: { status: "played", relevant: true } },
            ],
        },
        {
            name: "Black repertoire from a Black-to-move root FEN uses halfMoves parity",
            opponentColor: "white",
            fen: blackToMoveFen,
            orientation: "black",
            moves: [
                // Root is Black (user) to move (halfMoves = 1): c5 played, e5 open
                {
                    san: "c5",
                    children: [
                        // After c5, White (opponent) to move (halfMoves = 2): Nf3 played, d4 excluded
                        { san: "Nf3" },
                        { san: "d4" },
                    ],
                },
                { san: "e5", children: [{ san: "Nf3" }] },
            ],
            playedBoardStates: [
                getBoardState(blackToMoveFen),
                boardAfter(["c5"], blackToMoveFen),
                boardAfter(["c5", "Nf3"], blackToMoveFen),
            ],
            expectedInPreparation: true,
            expected: [
                { path: [], classification: { status: "played", relevant: true } },
                { path: [0], classification: { status: "played", relevant: true } },
                { path: [0, 0], classification: { status: "played", relevant: true } },
                { path: [0, 1], classification: { status: "excluded", relevant: false } },
                { path: [1], classification: { status: "open", relevant: true } },
                { path: [1, 0], classification: { status: "open", relevant: true } },
            ],
        },
        {
            name: "custom White-to-move root FEN with played root and open user move",
            opponentColor: "black",
            fen: customWhiteFen,
            orientation: "white",
            moves: [{ san: "Bb5" }, { san: "Bc4" }],
            playedBoardStates: [getBoardState(customWhiteFen), boardAfter(["Bb5"], customWhiteFen)],
            expectedInPreparation: true,
            expected: [
                { path: [], classification: { status: "played", relevant: true } },
                { path: [0], classification: { status: "played", relevant: true } },
                { path: [1], classification: { status: "open", relevant: true } },
            ],
        },
        {
            name: "chapter of wrong orientation is not part of the preparation",
            opponentColor: "white",
            orientation: undefined, // defaults to White, but user is Black
            moves: [{ san: "e4" }],
            playedBoardStates: [INITIAL_BOARD_STATE, boardAfter(["e4"])],
            expectedInPreparation: false,
            expected: [
                { path: [], classification: { status: "excluded", relevant: false } },
                { path: [0], classification: { status: "excluded", relevant: false } },
            ],
        },
        {
            name: "chapter of right orientation with no played node is not part of the preparation",
            opponentColor: "black",
            orientation: "white",
            moves: [{ san: "d4" }],
            playedBoardStates: [],
            expectedInPreparation: false,
            expected: [
                { path: [], classification: { status: "excluded", relevant: false } },
                { path: [0], classification: { status: "excluded", relevant: false } },
            ],
        },
    ];

    test.each(cases)("$name", (tc) => {
        const { chapter, root } = buildChapter({
            fen: tc.fen,
            headers: { orientation: tc.orientation },
            moves: tc.moves,
        });
        const played = new Set(tc.playedBoardStates);

        const indexedResult = classifyChapterNodes(chapter, tc.opponentColor, played);
        expect(indexedResult.inPreparation).toBe(tc.expectedInPreparation);
        expect(
            chapter.nodes.map((node, i) => ({
                path: node.path,
                classification: indexedResult.nodes[i],
            })),
        ).toEqual(tc.expected);

        const treeResult = classifyTreeNodes(root, tc.orientation, tc.opponentColor, played);
        expect(treeResult.inPreparation).toBe(tc.expectedInPreparation);
        const byPath: Array<{ path: number[]; classification: NodeClassification }> = [];
        function walk(node: TreeNode, path: number[]) {
            byPath.push({ path, classification: treeResult.nodes.get(node)! });
            for (let i = 0; i < node.children.length; i++) walk(node.children[i], [...path, i]);
        }
        walk(root, []);
        expect(byPath).toEqual(tc.expected);
    });
});

describe("lines, gaps, ordering, and transpositions across chapters", () => {
    test("transposition across two chapters: leaf in chapter 1 continuing with played move in chapter 2 is not a line; gap covered by chapter 2 is not a gap", () => {
        // Chapter 0: 1. e4 e5 2. Nf3 Nc6 (leaf at Nc6)
        const ch0 = buildChapter({
            chapter: 0,
            headers: { white: "Ruy Stub", orientation: "white" },
            moves: [
                {
                    san: "e4",
                    children: [
                        { san: "e5", children: [{ san: "Nf3", children: [{ san: "Nc6" }] }] },
                    ],
                },
            ],
        });
        // Chapter 1: 1. Nf3 Nc6 2. e4 e5 3. Bb5 (transposes to same position and plays 3. Bb5!)
        // Also covers 1. e4 c5 in chapter 1? No, at 1. e4 we test gap coverage across chapters:
        // Add chapter 2 that covers 1. e4 c5.
        const ch1 = buildChapter({
            chapter: 1,
            headers: { white: "Transposed Ruy", orientation: "white" },
            moves: [
                {
                    san: "Nf3",
                    children: [
                        {
                            san: "Nc6",
                            children: [
                                {
                                    san: "e4",
                                    children: [{ san: "e5", children: [{ san: "Bb5" }] }],
                                },
                            ],
                        },
                    ],
                },
            ],
        });
        const ch2 = buildChapter({
            chapter: 2,
            headers: { white: "Sicilian", orientation: "white" },
            moves: [{ san: "e4", children: [{ san: "c5" }] }],
        });

        const files = [makeFile("WhiteRep", [ch0.chapter, ch1.chapter, ch2.chapter])];
        const posAfterE4 = boardAfter(["e4"]);
        const posAfterNc6 = boardAfter(["e4", "e5", "Nf3", "Nc6"]);
        const posAfterBb5 = boardAfter(["e4", "e5", "Nf3", "Nc6", "Bb5"]);

        const stats = new Map<string, PositionStats[]>([
            [INITIAL_BOARD_STATE, [statRow("e4", { white: 6, black: 4 }, "2026.04.01")]],
            [
                posAfterE4,
                [
                    statRow("e5", { white: 3, black: 2 }, "2026.03.01"),
                    // Covered by chapter 2 -> must NOT be a gap!
                    statRow("c5", { white: 2, draw: 1 }, "2026.04.01"),
                    // Uncovered by any chapter -> MUST be a gap, pointing to first occurrence (ch0)!
                    statRow("e6", { black: 1, unknown: 1 }, "2026.02.15"),
                    // "*" is NEVER a gap!
                    statRow("*", { draw: 2 }, "2026.05.01"),
                ],
            ],
            [boardAfter(["e4", "e5"]), [statRow("Nf3", { white: 5 }, "2026.03.01")]],
            [boardAfter(["e4", "e5", "Nf3"]), [statRow("Nc6", { white: 5 }, "2026.03.01")]],
            [posAfterNc6, [statRow("Bb5", { white: 5 }, "2026.03.01")]],
            [
                posAfterBb5,
                [
                    statRow("a6", { white: 3 }, "2026.03.01"),
                    statRow("*", { draw: 2 }, "2026.04.10"),
                ],
            ],
            [boardAfter(["e4", "c5"]), [statRow("*", { white: 3 }, "2026.04.01")]],
        ]);

        const view = computePreparationView(files, "black", stats, 1);
        expect(view.total).toBe(10);
        // posAfterNc6 is a leaf in ch0 but continues with played Bb5 in ch1 -> NOT a line.
        expect(
            view.lines.map((l) => ({
                chapter: l.chapter,
                moves: l.moves,
                games: l.games,
                lastPlayed: l.lastPlayed,
            })),
        ).toEqual([
            {
                chapter: 1,
                moves: ["Nf3", "Nc6", "e4", "e5", "Bb5"],
                games: 5,
                // Latest date over posAfterBb5's own rows including "*"!
                lastPlayed: "2026.04.10",
            },
            {
                chapter: 2,
                moves: ["e4", "c5"],
                games: 3,
                lastPlayed: "2026.04.01",
            },
        ]);
        // Only e6 is a gap at posAfterE4 (c5 is covered by ch2, "*" is never a gap), plus a6 at posAfterBb5.
        expect(
            view.gaps.map((g) => ({
                chapter: g.chapter,
                moves: g.moves,
                move: g.move,
                games: g.games,
                lastPlayed: g.lastPlayed,
            })),
        ).toEqual([
            {
                chapter: 1,
                moves: ["Nf3", "Nc6", "e4", "e5", "Bb5"],
                move: "a6",
                games: 3,
                lastPlayed: "2026.03.01",
            },
            {
                chapter: 0,
                moves: ["e4"],
                move: "e6",
                games: 2,
                lastPlayed: "2026.02.15",
            },
        ]);
    });

    test("position reached only through another move order is a line with the date of those games", () => {
        // Repertoire has 1. d4 d5 2. c4 e6; opponent reached that position only via 1. c4 e6 2. d4 d5,
        // so 1. d4 and 1. d4 d5 have 0 games, while the target position has 4 games ending there ("*").
        const ch = buildChapter({
            headers: { white: "QGD", orientation: "white" },
            moves: [
                {
                    san: "d4",
                    children: [{ san: "d5", children: [{ san: "c4", children: [{ san: "e6" }] }] }],
                },
            ],
        });
        const target = boardAfter(["d4", "d5", "c4", "e6"]);
        const stats = new Map<string, PositionStats[]>([
            [target, [statRow("*", { white: 2, draw: 1, unknown: 1 }, "2026.06.20")]],
        ]);
        const view = computePreparationView([makeFile("QGD", [ch.chapter])], "black", stats, 1);
        expect(view.total).toBe(0);
        expect(view.lines).toHaveLength(1);
        expect(view.lines[0]).toMatchObject({
            chapter: 0,
            chapterTitle: { name: "QGD" },
            moves: ["d4", "d5", "c4", "e6"],
            boardState: target,
            games: 4,
            lastPlayed: "2026.06.20",
        });
    });

    test("lines and gaps sort by games desc, then last_played desc, then file, chapter, and tree order", () => {
        const f0c0 = buildChapter({
            chapter: 0,
            headers: { white: "F0C0" },
            moves: [
                { san: "e4", children: [{ san: "e5" }, { san: "c5" }] },
                { san: "d4", children: [{ san: "d5" }] },
            ],
        });
        const f1c0 = buildChapter({
            chapter: 0,
            headers: { white: "F1C0" },
            moves: [{ san: "c4", children: [{ san: "e5" }] }],
        });
        const files = [makeFile("Alpha", [f0c0.chapter]), makeFile("Beta", [f1c0.chapter])];

        const stats = new Map<string, PositionStats[]>([
            [INITIAL_BOARD_STATE, [statRow("e4", { white: 20 }, "2026.01.01")]],
            // Same games (5), different dates -> later date first
            [boardAfter(["e4", "e5"]), [statRow("*", { white: 5 }, "2025.05.01")]],
            [boardAfter(["e4", "c5"]), [statRow("*", { white: 5 }, "2026.01.10")]],
            // Same games (5) and same date ("2025.05.01") -> tree/file order breaks ties
            [boardAfter(["d4", "d5"]), [statRow("*", { white: 5 }, "2025.05.01")]],
            [boardAfter(["c4", "e5"]), [statRow("*", { white: 5 }, "2025.05.01")]],
            // Higher games (8) with null date still beats games (5) with recent date
            [
                boardAfter(["e4"]),
                [
                    statRow("e5", { white: 5 }),
                    statRow("c5", { white: 5 }),
                    statRow("d6", { black: 8 }, null),
                    statRow("g6", { black: 5 }, "2026.02.01"),
                    statRow("b6", { black: 5 }, "2025.12.01"),
                ],
            ],
        ]);

        const view = computePreparationView(files, "black", stats, 1);
        expect(view.lines.map((l) => `${l.file.name}:${l.moves.join(" ")}`)).toEqual([
            "Alpha:e4 c5", // 5 games, 2026.01.10
            "Alpha:e4 e5", // 5 games, 2025.05.01, file 0, earlier in tree
            "Alpha:d4 d5", // 5 games, 2025.05.01, file 0, later in tree
            "Beta:c4 e5", // 5 games, 2025.05.01, file 1
        ]);
        expect(view.gaps.map((g) => g.move)).toEqual(["d6", "g6", "b6"]);
    });
});

describe("sources: OTB, Online, and Both", () => {
    test("derives all three views from two fetched maps and combines counts and last_played", () => {
        const ch = buildChapter({
            headers: { white: "Open", orientation: "white" },
            moves: [{ san: "e4", children: [{ san: "e5" }] }],
        });
        const files = [makeFile("Open", [ch.chapter])];
        const posE4 = boardAfter(["e4"]);
        const posE4E5 = boardAfter(["e4", "e5"]);

        expect(collectPreparationFens(files, "black")).toEqual([
            INITIAL_BOARD_STATE,
            posE4,
            posE4E5,
        ]);

        const otbStats = new Map<string, PositionStats[]>([
            [
                INITIAL_BOARD_STATE,
                [statRow("e4", { white: 3 }, "2025.01.01", [{ year: 2025, count: 3 }])],
            ],
            [
                posE4,
                [
                    statRow("e5", { white: 2 }, "2025.01.01"),
                    statRow("c5", { black: 1 }, "2024.06.01"),
                ],
            ],
            [posE4E5, [statRow("*", { white: 2 }, "2025.01.01")]],
        ]);
        const onlineStats = new Map<string, PositionStats[]>([
            [
                INITIAL_BOARD_STATE,
                [statRow("e4", { white: 4, unknown: 1 }, "2026.03.15", [{ year: 2026, count: 5 }])],
            ],
            [
                posE4,
                [
                    statRow("e5", { draw: 3 }, "2026.02.01"),
                    statRow("c5", { black: 2 }, "2026.03.15"),
                ],
            ],
            [posE4E5, [statRow("*", { draw: 3 }, "2026.02.01")]],
        ]);

        const combined = combinePreparationStats(otbStats, onlineStats);
        expect(combined.get(INITIAL_BOARD_STATE)).toEqual([
            statRow("e4", { white: 7, unknown: 1 }, "2026.03.15", [
                { year: 2025, count: 3 },
                { year: 2026, count: 5 },
            ]),
        ]);

        const views = computePreparationViews(files, "black", otbStats, onlineStats, 1);
        expect(views.otb.total).toBe(3);
        expect(views.online?.total).toBe(5);
        expect(views.both?.total).toBe(8);
        expect(views.both?.lines[0]).toMatchObject({
            moves: ["e4", "e5"],
            games: 5,
            lastPlayed: "2026.02.01",
        });
        expect(views.both?.gaps[0]).toMatchObject({
            move: "c5",
            games: 3,
            lastPlayed: "2026.03.15",
        });

        const otbOnly = computePreparationViews(files, "black", otbStats, null, 1);
        expect(otbOnly.otb.total).toBe(3);
        expect(otbOnly.online).toBeNull();
        expect(otbOnly.both).toBeNull();
    });

    test("Both keeps OTB's later last_played, sums same-year year_counts, and preserves one-source positions and moves", () => {
        const ch = buildChapter({
            headers: { white: "Open", orientation: "white" },
            moves: [{ san: "e4", children: [{ san: "e5" }] }, { san: "d4" }],
        });
        const files = [makeFile("Open", [ch.chapter])];
        const posE4 = boardAfter(["e4"]);
        const posE4E5 = boardAfter(["e4", "e5"]);
        const posD4 = boardAfter(["d4"]);

        const otbStats = new Map<string, PositionStats[]>([
            [
                INITIAL_BOARD_STATE,
                [statRow("e4", { white: 2 }, "2026.08.01", [{ year: 2026, count: 2 }])],
            ],
            [
                posE4,
                [
                    statRow("e5", { white: 2 }, "2026.08.01", [{ year: 2026, count: 2 }]),
                    // Move only in OTB
                    statRow("d6", { black: 1 }, "2025.04.01"),
                ],
            ],
            // Position only in OTB
            [posE4E5, [statRow("*", { white: 2 }, "2026.08.01")]],
        ]);
        const onlineStats = new Map<string, PositionStats[]>([
            [
                INITIAL_BOARD_STATE,
                // Earlier last_played than OTB, same year 2026
                [statRow("e4", { white: 3 }, "2026.02.10", [{ year: 2026, count: 3 }])],
            ],
            [
                posE4,
                [
                    statRow("e5", { draw: 1 }, "2025.11.01", [{ year: 2026, count: 1 }]),
                    // Move only in Online
                    statRow("c5", { black: 2 }, "2026.05.01"),
                ],
            ],
            // Position only in Online
            [posD4, [statRow("*", { white: 3 }, "2026.07.01")]],
        ]);

        const combined = combinePreparationStats(otbStats, onlineStats);
        expect(combined.get(INITIAL_BOARD_STATE)).toEqual([
            statRow("e4", { white: 5 }, "2026.08.01", [{ year: 2026, count: 5 }]),
        ]);
        expect(combined.get(posE4)).toEqual([
            statRow("e5", { white: 2, draw: 1 }, "2026.08.01", [{ year: 2026, count: 3 }]),
            statRow("d6", { black: 1 }, "2025.04.01"),
            statRow("c5", { black: 2 }, "2026.05.01"),
        ]);
        expect(combined.get(posE4E5)).toEqual([statRow("*", { white: 2 }, "2026.08.01")]);
        expect(combined.get(posD4)).toEqual([statRow("*", { white: 3 }, "2026.07.01")]);

        const views = computePreparationViews(files, "black", otbStats, onlineStats, 1);
        expect(
            views.both?.lines.map((line) => ({
                moves: line.moves,
                games: line.games,
                lastPlayed: line.lastPlayed,
            })),
        ).toEqual([
            { moves: ["d4"], games: 3, lastPlayed: "2026.07.01" },
            { moves: ["e4", "e5"], games: 2, lastPlayed: "2026.08.01" },
        ]);
        expect(views.both?.gaps.map((gap) => gap.move)).toEqual(["c5", "d6"]);
    });
});

describe("edge cases for gaps, lines, orientation filtering, and date ordering", () => {
    test("uncovered moves at a played user-to-move position are not gaps, and a played node with only unplayed children is a line", () => {
        // White repertoire (opponent = black): 1. e4 e5.
        // Start position (White/user to move) has played e4 and uncovered d4 -> d4 must NOT be a gap.
        // 1. e4 (Black/opponent to move) is played, while its repertoire child 1. e4 e5 is NOT played
        // -> 1. e4 itself IS a line!
        const ch = buildChapter({
            headers: { white: "Open", orientation: "white" },
            moves: [{ san: "e4", children: [{ san: "e5" }] }],
        });
        const posE4 = boardAfter(["e4"]);
        const stats = new Map<string, PositionStats[]>([
            [
                INITIAL_BOARD_STATE,
                [
                    statRow("e4", { white: 3 }, "2026.01.01"),
                    statRow("d4", { white: 5 }, "2026.02.01"),
                ],
            ],
            [posE4, [statRow("c5", { black: 3 }, "2026.01.01")]],
        ]);
        const view = computePreparationView([makeFile("White", [ch.chapter])], "black", stats, 1);
        expect(view.gaps.map((g) => ({ moves: g.moves, move: g.move }))).toEqual([
            { moves: ["e4"], move: "c5" },
        ]);
        expect(view.lines.map((l) => ({ moves: l.moves, games: l.games }))).toEqual([
            { moves: ["e4"], games: 3 },
        ]);
    });

    test("wrong-orientation chapters contribute nothing to FENs, lines, gaps, or coverage (Black repertoire against White opponent)", () => {
        // Opponent plays White -> user plays Black.
        // White chapter covers 1. d4 d5 and reaches 1. c4; Black chapter covers only 1. e4 c5.
        const whiteChapter = buildChapter({
            chapter: 0,
            headers: { white: "White Only", orientation: "white" },
            moves: [{ san: "d4", children: [{ san: "d5" }] }, { san: "c4" }],
        });
        const blackChapter = buildChapter({
            chapter: 1,
            headers: { white: "Sicilian", orientation: "black" },
            moves: [{ san: "e4", children: [{ san: "c5" }] }],
        });
        const files = [makeFile("Mixed", [whiteChapter.chapter, blackChapter.chapter])];

        // collectPreparationFens must include only the Black chapter's FENs (+ INITIAL_BOARD_STATE).
        expect(collectPreparationFens(files, "white")).toEqual([
            INITIAL_BOARD_STATE,
            boardAfter(["e4"]),
            boardAfter(["e4", "c5"]),
        ]);

        const stats = new Map<string, PositionStats[]>([
            [
                INITIAL_BOARD_STATE,
                [
                    statRow("e4", { white: 4 }, "2026.03.01"),
                    // Covered by whiteChapter, NOT by blackChapter -> must still be a gap!
                    statRow("d4", { white: 2 }, "2026.02.01"),
                ],
            ],
            [boardAfter(["e4"]), [statRow("c5", { black: 4 }, "2026.03.01")]],
            [boardAfter(["e4", "c5"]), [statRow("*", { black: 4 }, "2026.03.01")]],
            // Played positions from the White chapter must not appear as lines.
            [boardAfter(["d4"]), [statRow("d5", { white: 2 }, "2026.02.01")]],
            [boardAfter(["d4", "d5"]), [statRow("*", { white: 2 }, "2026.02.01")]],
        ]);
        const view = computePreparationView(files, "white", stats, 1);
        expect(view.lines.map((l) => l.moves)).toEqual([["e4", "c5"]]);
        expect(view.gaps.map((g) => g.move)).toEqual(["d4"]);
    });

    test("date ordering handles unpadded, partial, unknown, and null dates on tied game counts", () => {
        const ch = buildChapter({
            headers: { white: "Dates", orientation: "white" },
            moves: [
                { san: "e4" },
                { san: "d4" },
                { san: "c4" },
                { san: "Nf3" },
                { san: "g3" },
                { san: "b3" },
            ],
        });
        const files = [makeFile("Dates", [ch.chapter])];
        // The 5 lines (4 games each) follow dateOrderKey:
        // "2026.10.01" > "2026.5.1" (padded to 2026.05.01) > "2026.??.??" (2026.00.00)
        // > "????.??.??" (normalized to null / "") == null (broken by tree order: e4 before Nf3).
        // At 1. b3 (opponent to move), the 5 gaps (2 games each) carry row.last_played verbatim.
        const stats = new Map<string, PositionStats[]>([
            [boardAfter(["e4"]), [statRow("*", { white: 4 }, "????.??.??")]],
            [boardAfter(["d4"]), [statRow("*", { white: 4 }, "2026.??.??")]],
            [boardAfter(["c4"]), [statRow("*", { white: 4 }, "2026.5.1")]],
            [boardAfter(["Nf3"]), [statRow("*", { white: 4 }, null)]],
            [boardAfter(["g3"]), [statRow("*", { white: 4 }, "2026.10.01")]],
            [
                boardAfter(["b3"]),
                [
                    statRow("e5", { black: 2 }, "????.??.??"),
                    statRow("c5", { black: 2 }, "2026.??.??"),
                    statRow("e6", { black: 2 }, "2026.5.1"),
                    statRow("c6", { black: 2 }, null),
                    statRow("d6", { black: 2 }, "2026.10.01"),
                ],
            ],
        ]);
        const view = computePreparationView(files, "black", stats, 1);
        expect(view.lines.map((l) => [l.moves[0], l.lastPlayed])).toEqual([
            ["b3", "2026.10.01"],
            ["g3", "2026.10.01"],
            ["c4", "2026.5.1"],
            ["d4", "2026.??.??"],
            ["e4", null],
            ["Nf3", null],
        ]);
        expect(view.gaps.map((g) => [g.move, g.lastPlayed])).toEqual([
            ["d6", "2026.10.01"],
            ["e6", "2026.5.1"],
            ["c5", "2026.??.??"],
            ["e5", "????.??.??"],
            ["c6", null],
        ]);
    });

    test("preparationViewForSource selects the matching source view and falls back to otb when absent", () => {
        const view = (total: number) => ({
            lines: [],
            gaps: [],
            total,
            playedPositions: new Set<string>(),
            positionGames: new Map<string, number>(),
        });
        const otb = view(1);
        const online = view(2);
        const both = view(3);

        expect(preparationViewForSource({ otb, online, both }, "otb")).toBe(otb);
        expect(preparationViewForSource({ otb, online, both }, "online")).toBe(online);
        expect(preparationViewForSource({ otb, online, both }, "both")).toBe(both);
        expect(preparationViewForSource({ otb, online: null, both: null }, "online")).toBe(otb);
        expect(preparationViewForSource({ otb, online: null, both: null }, "both")).toBe(otb);
    });
});

describe("minimum games", () => {
    // Black repertoire (opponent = white): 1. e4 e5 2. Nf3 Nc6 and 2. Bc4 Nf6.
    const { chapter } = buildChapter({
        headers: { black: "Open Games", orientation: "black" },
        moves: [
            {
                san: "e4",
                children: [
                    {
                        san: "e5",
                        children: [
                            { san: "Nf3", children: [{ san: "Nc6" }] },
                            { san: "Bc4", children: [{ san: "Nf6" }] },
                        ],
                    },
                ],
            },
        ],
    });
    const files = [makeFile("Open Games", [chapter])];
    const posE4E5 = boardAfter(["e4", "e5"]);
    const posBc4 = boardAfter(["e4", "e5", "Bc4"]);
    const stats = new Map<string, PositionStats[]>([
        [INITIAL_BOARD_STATE, [statRow("e4", { white: 4, black: 2 }, "2026.01.01")]],
        [boardAfter(["e4"]), [statRow("e5", { white: 4, black: 2 }, "2026.01.01")]],
        [
            posE4E5,
            [
                statRow("Nf3", { white: 3 }, "2026.01.01"),
                statRow("Bc4", { black: 1 }, "2026.02.01"),
                statRow("Nc3", { white: 2 }, "2026.03.01"),
            ],
        ],
        [boardAfter(["e4", "e5", "Nf3"]), [statRow("Nc6", { white: 3 }, "2026.01.01")]],
        [boardAfter(["e4", "e5", "Nf3", "Nc6"]), [statRow("Bb5", { white: 3 }, "2026.01.01")]],
        [posBc4, [statRow("Nf6", { black: 1 }, "2026.02.01")]],
        [boardAfter(["e4", "e5", "Bc4", "Nf6"]), [statRow("d3", { black: 1 }, "2026.02.01")]],
    ]);

    function summary(minGames: 1 | 2 | 3 | 5) {
        const view = computePreparationView(files, "white", stats, minGames);
        return {
            total: view.total,
            lines: view.lines.map((line) => ({ moves: line.moves.join(" "), games: line.games })),
            gaps: view.gaps.map((gap) => `${gap.moves.join(" ")} ${gap.move}:${gap.games}`),
            bc4Played: view.playedPositions.has(posBc4),
            bc4Counted: view.positionGames.has(posBc4),
        };
    }

    test("a line and a gap count from the opponent's first game by default", () => {
        expect(summary(1)).toEqual({
            total: 6,
            lines: [
                { moves: "e4 e5 Nf3 Nc6", games: 3 },
                { moves: "e4 e5 Bc4 Nf6", games: 1 },
            ],
            gaps: ["e4 e5 Nf3 Nc6 Bb5:3", "e4 e5 Nc3:2", "e4 e5 Bc4 Nf6 d3:1"],
            bc4Played: true,
            bc4Counted: true,
        });
    });

    test("raising the minimum drops rarer lines and gaps but keeps the total", () => {
        expect(summary(2)).toEqual({
            total: 6,
            lines: [{ moves: "e4 e5 Nf3 Nc6", games: 3 }],
            gaps: ["e4 e5 Nf3 Nc6 Bb5:3", "e4 e5 Nc3:2"],
            bc4Played: false,
            bc4Counted: false,
        });
        expect(summary(3).gaps).toEqual(["e4 e5 Nf3 Nc6 Bb5:3"]);
    });

    test("a line ends where every continuation falls below the minimum", () => {
        expect(summary(5)).toEqual({
            total: 6,
            lines: [{ moves: "e4 e5", games: 6 }],
            gaps: [],
            bc4Played: false,
            bc4Counted: false,
        });
    });

    test("the folding classification follows the thresholded played positions", () => {
        const view = computePreparationView(files, "white", stats, 2);
        const classification = classifyChapterNodes(chapter, "white", view.playedPositions);
        const bc4Index = chapter.nodes.findIndex((node) => node.boardState === posBc4);
        expect(classification.nodes[bc4Index]).toEqual({ status: "excluded", relevant: false });
    });

    test("the online and Both views apply the same minimum to their own counts", () => {
        const onlineStats = new Map<string, PositionStats[]>([
            [INITIAL_BOARD_STATE, [statRow("e4", { white: 2 }, "2026.05.01")]],
            [boardAfter(["e4"]), [statRow("e5", { white: 2 }, "2026.05.01")]],
            [posE4E5, [statRow("Bc4", { white: 2 }, "2026.05.01")]],
            [posBc4, [statRow("Nf6", { white: 2 }, "2026.05.01")]],
        ]);
        const played = (minGames: 1 | 2 | 3 | 5) => {
            const views = computePreparationViews(files, "white", stats, onlineStats, minGames);
            return {
                otb: views.otb.playedPositions.has(posBc4),
                online: views.online?.playedPositions.has(posBc4),
                both: views.both?.playedPositions.has(posBc4),
            };
        };
        // Bc4: 1 game over the board, 2 online, 3 together.
        expect(played(2)).toEqual({ otb: false, online: true, both: true });
        expect(played(3)).toEqual({ otb: false, online: false, both: true });
        expect(played(5)).toEqual({ otb: false, online: false, both: false });
    });

    test("parsePreparationMinGames accepts only the offered choices", () => {
        expect(parsePreparationMinGames("3")).toBe(3);
        expect(parsePreparationMinGames("4")).toBe(1);
        expect(parsePreparationMinGames("")).toBe(1);
    });
});

describe("move numbering anchor", () => {
    test("lines and gaps from a custom root FEN carry the root's half-move count", () => {
        const afterE4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
        const ch = buildChapter({
            fen: afterE4,
            headers: { orientation: "black" },
            moves: [{ san: "c5", children: [{ san: "Nf3", children: [{ san: "Nc6" }] }] }],
        });
        const stats = new Map<string, PositionStats[]>([
            [getBoardState(afterE4), [statRow("c5", { white: 5 })]],
            [
                boardAfter(["c5"], afterE4),
                [statRow("Nf3", { white: 3 }), statRow("d4", { white: 2 })],
            ],
            [boardAfter(["c5", "Nf3"], afterE4), [statRow("Nc6", { white: 3 })]],
            [boardAfter(["c5", "Nf3", "Nc6"], afterE4), [statRow("*", { white: 3 })]],
        ]);

        const view = computePreparationView(
            [makeFile("Sicilian", [ch.chapter])],
            "white",
            stats,
            1,
        );

        expect(view.lines.map((l) => ({ moves: l.moves, start: l.startHalfMoves }))).toEqual([
            { moves: ["c5", "Nf3", "Nc6"], start: 1 },
        ]);
        expect(
            view.gaps.map((g) => ({ moves: g.moves, move: g.move, start: g.startHalfMoves })),
        ).toEqual([{ moves: ["c5"], move: "d4", start: 1 }]);
    });

    test("a standard chapter starts at half-move 0", () => {
        const ch = buildChapter({ headers: { orientation: "black" }, moves: [{ san: "e4" }] });
        const stats = new Map<string, PositionStats[]>([
            [INITIAL_BOARD_STATE, [statRow("e4", { white: 4 }), statRow("c4", { white: 2 })]],
            [boardAfter(["e4"]), [statRow("*", { white: 4 })]],
        ]);

        const view = computePreparationView([makeFile("Dutch", [ch.chapter])], "white", stats, 1);

        expect(
            view.gaps.map((g) => ({ moves: g.moves, move: g.move, start: g.startHalfMoves })),
        ).toEqual([{ moves: [], move: "c4", start: 0 }]);
    });
});
