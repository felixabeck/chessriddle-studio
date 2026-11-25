import { beforeEach, describe, expect, test, vi } from "vitest";
import { makeFen } from "chessops/fen";
import { makeSan, parseSan } from "chessops/san";
import type { ScoresheetGame } from "@/bindings";
import { positionFromFen } from "@/utils/chessops";
import {
    buildScoresheetTree,
    isPlainScoresheetLine,
    planScoresheetContinuation,
    replayScoresheetMoves,
    scoresheetGameToPgn,
} from "./scoresheet";

const mocks = vi.hoisted(() => ({
    parsePGN: vi.fn(),
}));

vi.mock("@/utils/chess", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/utils/chess")>();
    return {
        ...actual,
        parsePGN: (...args: unknown[]) => mocks.parsePGN(...args),
    };
});

import { createNode, defaultTree, type TreeNode, type TreeState } from "./treeReducer";

function makeParsedTree(sans: string[], result: "1-0" | "0-1" | "1/2-1/2" | "*"): TreeState {
    const tree = defaultTree();
    tree.headers.result = result;
    let cursor: TreeNode = tree.root;
    for (let i = 0; i < sans.length; i += 1) {
        const next: TreeNode = {
            fen: tree.root.fen,
            move: null,
            san: sans[i],
            children: [],
            score: null,
            depth: null,
            halfMoves: i + 1,
            shapes: [],
            nags: [],
            comment: "",
        };
        cursor.children.push(next);
        cursor = next;
    }
    // Mirror `applyGameEndLoadDefault`: non-* result attaches `gameEnd` to the last main-line move.
    if (result !== "*" && cursor !== tree.root) {
        cursor.gameEnd = {};
    }
    return tree;
}

function sampleGame(overrides: Partial<ScoresheetGame> = {}): ScoresheetGame {
    return {
        headers: {
            white: "Alice",
            black: "Bob",
            event: "Club Open",
            site: "Berlin",
            date: "2026.11.24",
            round: "3",
            result: "1-0",
            whiteElo: "1850",
            blackElo: "1790",
        },
        moves: [
            { san: "e4", unsure: false },
            { san: "e5", unsure: true },
            { san: "Nf3", unsure: false },
        ],
        stopped: null,
        ...overrides,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
});

describe("scoresheet tree building", () => {
    test("composes PGN with headers and numbered SAN moves", () => {
        const pgn = scoresheetGameToPgn(sampleGame());
        expect(pgn).toContain('[Event "Club Open"]');
        expect(pgn).toContain('[White "Alice"]');
        expect(pgn).toContain('[Black "Bob"]');
        expect(pgn).toContain('[Date "2026.11.24"]');
        expect(pgn).toContain('[WhiteElo "1850"]');
        expect(pgn).toContain('[BlackElo "1790"]');
        expect(pgn).toContain('[Result "1-0"]');
        expect(pgn).toContain("1. e4 e5 2. Nf3 1-0");
    });

    test("completely read game keeps game-end default, marks unsure nodes, sets review state and dirty", async () => {
        const game = sampleGame();
        mocks.parsePGN.mockResolvedValueOnce(makeParsedTree(["e4", "e5", "Nf3"], "1-0"));

        const tree = await buildScoresheetTree(game);

        const n1 = tree.root.children[0];
        const n2 = n1.children[0];
        const n3 = n2.children[0];
        expect(n1.unsure).toBeUndefined();
        expect(n2.unsure).toBe(true);
        expect(n3.unsure).toBeUndefined();
        // Complete game keeps the default game-end marker.
        expect(n3.gameEnd).toEqual({});
        expect(tree.scoresheetReview).toEqual({});
        expect(tree.dirty).toBe(true);
    });

    test("stopped game strips game-end marker and records stopped ply and tokens", async () => {
        const game = sampleGame({
            stopped: { ply: 3, tokens: ["?", "Bb5", "a6"] },
        });
        mocks.parsePGN.mockResolvedValueOnce(makeParsedTree(["e4", "e5", "Nf3"], "1-0"));

        const tree = await buildScoresheetTree(game);

        const n1 = tree.root.children[0];
        const n2 = n1.children[0];
        const n3 = n2.children[0];
        expect(n3.gameEnd).toBeUndefined();
        expect(tree.scoresheetReview).toEqual({
            stopped: { ply: 3, tokens: ["?", "Bb5", "a6"] },
        });
        expect(tree.dirty).toBe(true);
    });

    test("throws when parsed main-line length differs from returned moves", async () => {
        const game = sampleGame();
        mocks.parsePGN.mockResolvedValueOnce(makeParsedTree(["e4", "e5"], "1-0"));

        await expect(buildScoresheetTree(game)).rejects.toThrow("Scoresheet move count mismatch");
    });
});

function appendSan(parent: TreeNode, san: string): TreeNode {
    const [pos] = positionFromFen(parent.fen);
    if (!pos) throw new Error(`Invalid FEN: ${parent.fen}`);
    const move = parseSan(pos, san);
    if (!move) throw new Error(`Illegal SAN ${san} in ${parent.fen}`);
    const canonical = makeSan(pos, move);
    pos.play(move);
    const child = createNode({
        fen: makeFen(pos.toSetup()),
        move,
        san: canonical,
        halfMoves: parent.halfMoves + 1,
    });
    parent.children.push(child);
    return child;
}

describe("scoresheet continuation helpers", () => {
    test("planScoresheetContinuation after-stop requires review, last main-line move, L > ply, and remaining tokens", () => {
        const tree = defaultTree();
        const e4 = appendSan(tree.root, "e4");
        const e5 = appendSan(e4, "e5");
        const nf3 = appendSan(e5, "Nf3");
        appendSan(nf3, "Nc6"); // L = 4

        const stoppedAt4 = { stopped: { ply: 4, tokens: ["Bb5", "a6"] } };
        const stoppedAt3 = { stopped: { ply: 3, tokens: ["?", "Bb5", "a6"] } };
        const stoppedAt2Exhausted = { stopped: { ply: 2, tokens: ["Nf3", "Nc6"] } };

        // Outside a review -> null.
        expect(planScoresheetContinuation(tree.root, [0, 0, 0, 0], undefined)).toBeNull();
        // L === ply -> null.
        expect(planScoresheetContinuation(tree.root, [0, 0, 0, 0], stoppedAt4)).toBeNull();
        // L < ply -> null.
        expect(
            planScoresheetContinuation(tree.root, [0, 0, 0, 0], {
                stopped: { ply: 6, tokens: ["Ba4"] },
            }),
        ).toBeNull();
        // Not at the last move of the main line -> null.
        expect(planScoresheetContinuation(tree.root, [0, 0, 0], stoppedAt3)).toBeNull();
        // Exhausted (L - ply >= tokens.length) -> null.
        expect(planScoresheetContinuation(tree.root, [0, 0, 0, 0], stoppedAt2Exhausted)).toBeNull();
        // L > ply (4 > 3) at last main-line move -> tokens[4 - 3] = tokens[1] onward.
        expect(planScoresheetContinuation(tree.root, [0, 0, 0, 0], stoppedAt3)).toEqual({
            kind: "after-stop",
            moves: [
                { san: "Bb5", unsure: false },
                { san: "a6", unsure: false },
            ],
        });
    });

    test("planScoresheetContinuation replace-middle combines old main line and sheet tokens only when L >= ply", () => {
        const tree = defaultTree();
        const e4 = appendSan(tree.root, "e4");
        const e5 = appendSan(e4, "e5");
        const nf3 = appendSan(e5, "Nf3");
        nf3.unsure = true;
        appendSan(nf3, "Nc6"); // L = 4
        // User replaces 1...e5 with 1...c5 at [0, 1].
        const c5 = appendSan(e4, "c5");

        // L === ply (4 === 4): includes tokens[0] right after old main-line moves.
        expect(
            planScoresheetContinuation(tree.root, [0, 1], {
                stopped: { ply: 4, tokens: ["Bb5", "a6"] },
            }),
        ).toEqual({
            kind: "replace-middle",
            parentPath: [0],
            oldMainLineMoveCount: 2,
            moves: [
                { san: "Nf3", unsure: true },
                { san: "Nc6", unsure: false },
                { san: "Bb5", unsure: false },
                { san: "a6", unsure: false },
            ],
        });

        // L > ply (4 > 3): appends sheet tokens from old line's length on (tokens[4 - 3] = tokens[1]).
        expect(
            planScoresheetContinuation(tree.root, [0, 1], {
                stopped: { ply: 3, tokens: ["?", "Bb5", "a6"] },
            }),
        ).toEqual({
            kind: "replace-middle",
            parentPath: [0],
            oldMainLineMoveCount: 2,
            moves: [
                { san: "Nf3", unsure: true },
                { san: "Nc6", unsure: false },
                { san: "Bb5", unsure: false },
                { san: "a6", unsure: false },
            ],
        });

        // L < ply (4 < 6): omits stopped tokens so no ply is skipped and no colour shifts.
        expect(
            planScoresheetContinuation(tree.root, [0, 1], {
                stopped: { ply: 6, tokens: ["Ba4"] },
            }),
        ).toEqual({
            kind: "replace-middle",
            parentPath: [0],
            oldMainLineMoveCount: 2,
            moves: [
                { san: "Nf3", unsure: true },
                { san: "Nc6", unsure: false },
            ],
        });

        // Variation of more than one move -> null.
        appendSan(c5, "Nf3");
        expect(planScoresheetContinuation(tree.root, [0, 1], {})).toBeNull();
        expect(planScoresheetContinuation(tree.root, [0, 1, 0], {})).toBeNull();

        // One-move variation beside the LAST main-line move with no remaining sheet tokens -> null.
        appendSan(nf3, "Nf6"); // [0, 0, 0, 1] beside last main-line move Nc6 at [0, 0, 0, 0]
        expect(planScoresheetContinuation(tree.root, [0, 0, 0, 1], {})).toBeNull();
    });

    test("isPlainScoresheetLine allows unsure marks and final gameEnd, and rejects variations, comments, NAGs, shapes, diagram, and non-final gameEnd", () => {
        const makeLine = () => {
            const t = defaultTree();
            const e4 = appendSan(t.root, "e4");
            const e5 = appendSan(e4, "e5");
            return { e4, e5 };
        };

        const plain = makeLine();
        plain.e4.unsure = true;
        plain.e5.unsure = true;
        plain.e5.gameEnd = {};
        expect(isPlainScoresheetLine(plain.e4)).toBe(true);

        const withNonFinalGameEnd = makeLine();
        withNonFinalGameEnd.e4.gameEnd = {};
        expect(isPlainScoresheetLine(withNonFinalGameEnd.e4)).toBe(false);

        const withComment = makeLine();
        withComment.e5.comment = "note";
        expect(isPlainScoresheetLine(withComment.e4)).toBe(false);

        const withNag = makeLine();
        withNag.e4.nags = [1];
        expect(isPlainScoresheetLine(withNag.e4)).toBe(false);

        const withShape = makeLine();
        withShape.e5.shapes = [{ orig: "e2", dest: "e4", brush: "green" }];
        expect(isPlainScoresheetLine(withShape.e4)).toBe(false);

        const withDiagram = makeLine();
        withDiagram.e4.diagram = true;
        expect(isPlainScoresheetLine(withDiagram.e4)).toBe(false);

        const withSubVariation = makeLine();
        appendSan(withSubVariation.e4, "c5");
        expect(isPlainScoresheetLine(withSubVariation.e4)).toBe(false);
    });

    test("replayScoresheetMoves resolves strictly, stops at ? or illegal token, and assigns sequential halfMoves", () => {
        const tree = defaultTree();
        const e4 = appendSan(tree.root, "e4");
        const count = replayScoresheetMoves(e4, [
            { san: "e5", unsure: true },
            { san: "Nf3", unsure: false },
            { san: "?", unsure: false },
            { san: "Nc6", unsure: false },
        ]);
        expect(count).toBe(2);
        const e5 = e4.children[0];
        const nf3 = e5.children[0];
        expect(e5.san).toBe("e5");
        expect(e5.halfMoves).toBe(2);
        expect(e5.unsure).toBe(true);
        expect(nf3.san).toBe("Nf3");
        expect(nf3.halfMoves).toBe(3);
        expect(nf3.children).toHaveLength(0);
    });
});
