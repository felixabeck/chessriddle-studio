import { beforeEach, describe, expect, test, vi } from "vitest";
import type { ScoresheetGame } from "@/bindings";
import { buildScoresheetTree, scoresheetGameToPgn } from "./scoresheet";

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

import { defaultTree, type TreeNode, type TreeState } from "./treeReducer";

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
