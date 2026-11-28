import { beforeEach, describe, expect, test, vi } from "vitest";
import { makeFen } from "chessops/fen";
import { makeSan, parseSan } from "chessops/san";
import type { ScoresheetGame } from "@/bindings";
import { headersToPGN } from "@/utils/chess";
import { positionFromFen } from "@/utils/chessops";
import {
    buildScoresheetTree,
    findScoresheetCell,
    formatScoresheetPhotosTag,
    getScoresheetPhotoIds,
    hasScoresheetPhotoPanel,
    isPlainScoresheetLine,
    parseScoresheetPhotosTag,
    planScoresheetContinuation,
    replayScoresheetMoves,
    SCORESHEET_PHOTOS_TAG,
    scoresheetGameToPgn,
    scoresheetLayoutMatchesPhotos,
    type ScoresheetCell,
    withScoresheetPhotoIds,
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

import {
    createNode,
    defaultTree,
    type ScoresheetReviewLayout,
    type TreeNode,
    type TreeState,
} from "./treeReducer";

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
    test("composes PGN with headers, numbered SAN moves, and optional clock comments", () => {
        const pgn = scoresheetGameToPgn(sampleGame());
        expect(pgn).toContain('[Event "Club Open"]');
        expect(pgn).toContain('[White "Alice"]');
        expect(pgn).toContain('[Black "Bob"]');
        expect(pgn).toContain('[Date "2026.11.24"]');
        expect(pgn).toContain('[WhiteElo "1850"]');
        expect(pgn).toContain('[BlackElo "1790"]');
        expect(pgn).toContain('[Result "1-0"]');
        expect(pgn).toContain("1. e4 e5 2. Nf3 1-0");

        const withClocks = scoresheetGameToPgn(
            sampleGame({
                moves: [
                    { san: "e4", unsure: false, clock: 5160 },
                    { san: "e5", unsure: true },
                    { san: "Nf3", unsure: false, clock: 5190 },
                ],
            }),
        );
        expect(withClocks).toContain("1. e4 {[%clk 1:26:00]} e5 2. Nf3 {[%clk 1:26:30]} 1-0");
    });

    test("completely read game keeps game-end default, marks unsure nodes, sets review state and dirty", async () => {
        const game = sampleGame();
        const controller = new AbortController();
        mocks.parsePGN.mockResolvedValueOnce(makeParsedTree(["e4", "e5", "Nf3"], "1-0"));

        const tree = await buildScoresheetTree(game, { signal: controller.signal });

        expect(mocks.parsePGN).toHaveBeenCalledWith(scoresheetGameToPgn(game), undefined, {
            signal: controller.signal,
        });
        const [passedPgn] = mocks.parsePGN.mock.calls[0];
        expect(passedPgn).toContain('[Event "Club Open"]');
        expect(passedPgn).toContain('[White "Alice"]');
        expect(passedPgn).toContain('[Black "Bob"]');
        expect(passedPgn).toContain("1. e4 e5 2. Nf3 1-0");

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

    test("continuation plans and replayScoresheetMoves carry clocks in seconds across after-stop and replace-middle", () => {
        const tree = defaultTree();
        const e4 = appendSan(tree.root, "e4");
        e4.clock = 5400;
        const e5 = appendSan(e4, "e5");
        e5.clock = 5340;
        const nf3 = appendSan(e5, "Nf3");
        nf3.clock = 5280;
        const nc6 = appendSan(nf3, "Nc6"); // L = 4
        nc6.clock = 5220;

        // after-stop slices stopped.clocks at L - ply (4 - 3 = 1) and exposes stoppedPlyClock when L === ply + 1.
        expect(
            planScoresheetContinuation(tree.root, [0, 0, 0, 0], {
                stopped: { ply: 3, tokens: ["?", "Bb5", "a6"], clocks: [5220, 5160, null] },
            }),
        ).toEqual({
            kind: "after-stop",
            stoppedPlyClock: 5220,
            moves: [
                { san: "Bb5", unsure: false, clock: 5160 },
                { san: "a6", unsure: false },
            ],
        });
        expect(
            planScoresheetContinuation(tree.root, [0, 0, 0, 0], {
                stopped: { ply: 3, tokens: ["?", "Bb5", "a6"], clocks: [null, 5160, null] },
            }),
        ).toEqual({
            kind: "after-stop",
            moves: [
                { san: "Bb5", unsure: false, clock: 5160 },
                { san: "a6", unsure: false },
            ],
        });
        // L > ply + 1 (4 > 2 + 1): user played two moves past the stop, so no stoppedPlyClock.
        expect(
            planScoresheetContinuation(tree.root, [0, 0, 0, 0], {
                stopped: {
                    ply: 2,
                    tokens: ["?", "?", "Bb5", "a6"],
                    clocks: [5280, 5220, 5160, 5100],
                },
            }),
        ).toEqual({
            kind: "after-stop",
            moves: [
                { san: "Bb5", unsure: false, clock: 5160 },
                { san: "a6", unsure: false, clock: 5100 },
            ],
        });

        // replace-middle carries clocks from old main-line nodes AND remaining stopped tokens.
        appendSan(e4, "c5"); // [0, 1]
        const replacePlan = planScoresheetContinuation(tree.root, [0, 1], {
            stopped: { ply: 4, tokens: ["Bb5", "a6"], clocks: [null, 5100] },
        });
        expect(replacePlan).toEqual({
            kind: "replace-middle",
            parentPath: [0],
            oldMainLineMoveCount: 2,
            moves: [
                { san: "Nf3", unsure: false, clock: 5280 },
                { san: "Nc6", unsure: false, clock: 5220 },
                { san: "Bb5", unsure: false },
                { san: "a6", unsure: false, clock: 5100 },
            ],
        });

        // replayScoresheetMoves sets node.clock directly in seconds (not ms).
        const replayed = replayScoresheetMoves(nc6, [
            { san: "Bb5", unsure: false, clock: 5160 },
            { san: "a6", unsure: false },
        ]);
        expect(replayed).toBe(2);
        expect(nc6.children[0].clock).toBe(5160);
        expect(nc6.children[0].children[0].clock).toBeUndefined();
    });
});

describe("ScoresheetPhotos PGN tag helpers", () => {
    const id1 = "a".repeat(64);
    const id2 = "0123456789abcdef".repeat(4);
    const id3 = "b".repeat(64);
    const id4 = "c".repeat(64);
    const id5 = "d".repeat(64);

    test("parseScoresheetPhotosTag accepts 1–4 lowercase 64-hex ids and rejects malformed or oversized values", () => {
        expect(parseScoresheetPhotosTag(id1)).toEqual([id1]);
        expect(parseScoresheetPhotosTag(`${id1},${id2}`)).toEqual([id1, id2]);
        expect(parseScoresheetPhotosTag([id1, id2, id3, id4].join(","))).toEqual([
            id1,
            id2,
            id3,
            id4,
        ]);

        // Rejects empty, >4 ids, uppercase, non-hex, wrong length, whitespace, path traversal.
        for (const bad of [
            undefined,
            "",
            "   ",
            "a".repeat(63),
            "a".repeat(65),
            `A${"a".repeat(63)}`,
            `g${"a".repeat(63)}`,
            `${id1}, ${id2}`,
            ` ${id1}`,
            `${id1},`,
            `,${id1}`,
            "../etc/passwd",
            `${"a".repeat(31)}/${"b".repeat(32)}`,
            `${"a".repeat(31)}\\${"b".repeat(32)}`,
            [id1, id2, id3, id4, id5].join(","),
        ]) {
            expect(parseScoresheetPhotosTag(bad)).toBeNull();
        }
    });

    test("hasScoresheetPhotoPanel is true for active review or well-formed tag, false for malformed tag", () => {
        const plain = defaultTree();
        expect(hasScoresheetPhotoPanel(plain)).toBe(false);

        const withReview = { ...defaultTree(), scoresheetReview: {} };
        expect(hasScoresheetPhotoPanel(withReview)).toBe(true);

        const withValidTag = defaultTree();
        withValidTag.headers = withScoresheetPhotoIds(withValidTag.headers, [id1, id2]);
        expect(getScoresheetPhotoIds(withValidTag.headers)).toEqual([id1, id2]);
        expect(hasScoresheetPhotoPanel(withValidTag)).toBe(true);

        // Malformed tag gives no reference and no Photo panel, and headersToPGN preserves it untouched.
        const withMalformedTag = defaultTree();
        withMalformedTag.headers = {
            ...withMalformedTag.headers,
            other: { [SCORESHEET_PHOTOS_TAG]: "../malformed" },
        };
        expect(getScoresheetPhotoIds(withMalformedTag.headers)).toBeNull();
        expect(hasScoresheetPhotoPanel(withMalformedTag)).toBe(false);
        expect(headersToPGN(withMalformedTag.headers)).toContain(
            `[${SCORESHEET_PHOTOS_TAG} "../malformed"]`,
        );
    });

    test("buildScoresheetTree attaches ScoresheetPhotos when photoIds are provided", async () => {
        const game = sampleGame();
        mocks.parsePGN.mockResolvedValueOnce(makeParsedTree(["e4", "e5", "Nf3"], "1-0"));
        const tree = await buildScoresheetTree(game, { photoIds: [id1, id2] });
        expect(tree.headers.other?.[SCORESHEET_PHOTOS_TAG]).toBe(`${id1},${id2}`);
        expect(formatScoresheetPhotosTag([id1, id2])).toBe(`${id1},${id2}`);
        expect(formatScoresheetPhotosTag([])).toBeNull();
        expect(formatScoresheetPhotosTag(["not-hex"])).toBeNull();
    });
});

const LAYOUT_ID_1 = "a".repeat(64);
const LAYOUT_ID_2 = "b".repeat(64);

function twoPageLayout(
    photoIds: string[] | null = [LAYOUT_ID_1, LAYOUT_ID_2],
): ScoresheetReviewLayout {
    return {
        photoIds,
        blocks: [
            {
                page: 0,
                firstMove: 1,
                rows: 20,
                topLeft: [100, 200],
                topRight: [300, 200],
                bottomLeft: [100, 800],
                bottomRight: [300, 800],
            },
            {
                page: 1,
                firstMove: 21,
                rows: 20,
                topLeft: [400, 100],
                topRight: [600, 100],
                bottomLeft: [400, 900],
                bottomRight: [600, 900],
            },
        ],
    };
}

function expectCell(cell: ScoresheetCell | null, page: number, quad: [number, number][]): void {
    expect(cell).not.toBeNull();
    expect(cell!.page).toBe(page);
    cell!.quad.forEach(([x, y], index) => {
        expect(x).toBeCloseTo(quad[index][0], 6);
        expect(y).toBeCloseTo(quad[index][1], 6);
    });
}

function mainLinePath(plies: number): number[] {
    return Array.from({ length: plies }, () => 0);
}

describe("scoresheet layout cells", () => {
    const tree = makeParsedTree(
        Array.from({ length: 41 }, (_, index) => `m${index + 1}`),
        "*",
    );
    const layout = twoPageLayout();

    test("maps White and Black of a move to the left and right half of its block row, widened by the marker margin", () => {
        // Move 1: row 0 of 20 → v from -0.01 to 0.06; White u from -0.03 to 0.53, Black 0.47 to 1.03.
        expectCell(findScoresheetCell(layout, tree.root, mainLinePath(1)), 0, [
            [94, 194],
            [206, 194],
            [206, 236],
            [94, 236],
        ]);
        expectCell(findScoresheetCell(layout, tree.root, mainLinePath(2)), 0, [
            [194, 194],
            [306, 194],
            [306, 236],
            [194, 236],
        ]);
        // Move 20 Black: the block's last row.
        expectCell(findScoresheetCell(layout, tree.root, mainLinePath(40)), 0, [
            [194, 764],
            [306, 764],
            [306, 806],
            [194, 806],
        ]);
        // Move 21 White: the first row of the second block, on the second photo.
        expectCell(findScoresheetCell(layout, tree.root, mainLinePath(41)), 1, [
            [394, 92],
            [506, 92],
            [506, 148],
            [394, 148],
        ]);
    });

    test("interpolates between all four corners of a tilted, perspective-distorted block", () => {
        const corners = {
            topLeft: [100, 100] as [number, number],
            topRight: [300, 120] as [number, number],
            bottomLeft: [120, 500] as [number, number],
            bottomRight: [340, 560] as [number, number],
        };
        const tilted: ScoresheetReviewLayout = {
            photoIds: null,
            blocks: [{ page: 0, firstMove: 1, rows: 2, ...corners }],
        };
        const bilinear = (u: number, v: number): [number, number] => {
            const top = [
                corners.topLeft[0] + (corners.topRight[0] - corners.topLeft[0]) * u,
                corners.topLeft[1] + (corners.topRight[1] - corners.topLeft[1]) * u,
            ];
            const bottom = [
                corners.bottomLeft[0] + (corners.bottomRight[0] - corners.bottomLeft[0]) * u,
                corners.bottomLeft[1] + (corners.bottomRight[1] - corners.bottomLeft[1]) * u,
            ];
            return [top[0] + (bottom[0] - top[0]) * v, top[1] + (bottom[1] - top[1]) * v];
        };
        // Move 2 Black: the bottom-right cell, u from 0.47 to 1.03, v from 0.4 to 1.1.
        expectCell(findScoresheetCell(tilted, tree.root, mainLinePath(4)), 0, [
            bilinear(0.47, 0.4),
            bilinear(1.03, 0.4),
            bilinear(1.03, 1.1),
            bilinear(0.47, 1.1),
        ]);
    });

    test("a variation move takes the cell of its ply", () => {
        const withVariation = makeParsedTree(["e4", "e5", "Nf3"], "*");
        const e4 = withVariation.root.children[0];
        e4.children.push({ ...e4.children[0], san: "c5", children: [], halfMoves: 2 });
        expect(findScoresheetCell(layout, withVariation.root, [0, 1])).toEqual(
            findScoresheetCell(layout, withVariation.root, [0, 0]),
        );
    });

    test("returns no cell without a layout, at the start, for an uncovered move, an unresolvable path or a non-standard start", () => {
        expect(findScoresheetCell(undefined, tree.root, mainLinePath(1))).toBeNull();
        expect(findScoresheetCell(layout, tree.root, [])).toBeNull();
        expect(findScoresheetCell(layout, tree.root, [0, 5])).toBeNull();
        const firstBlockOnly: ScoresheetReviewLayout = { ...layout, blocks: [layout.blocks[0]] };
        expect(findScoresheetCell(firstBlockOnly, tree.root, mainLinePath(41))).toBeNull();

        const fromPosition = makeParsedTree(["e4"], "*");
        fromPosition.root.fen = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
        expect(findScoresheetCell(layout, fromPosition.root, [0])).toBeNull();
        const shifted = makeParsedTree(["e4"], "*");
        shifted.root.halfMoves = 1;
        expect(findScoresheetCell(layout, shifted.root, [0])).toBeNull();
    });

    test("a layout matches only the photos it was read from", () => {
        expect(scoresheetLayoutMatchesPhotos(layout, [LAYOUT_ID_1, LAYOUT_ID_2])).toBe(true);
        expect(scoresheetLayoutMatchesPhotos(layout, [LAYOUT_ID_2, LAYOUT_ID_1])).toBe(false);
        expect(scoresheetLayoutMatchesPhotos(layout, [LAYOUT_ID_1])).toBe(false);
        expect(scoresheetLayoutMatchesPhotos(layout, null)).toBe(false);
        expect(scoresheetLayoutMatchesPhotos(twoPageLayout(null), null)).toBe(true);
        expect(scoresheetLayoutMatchesPhotos(twoPageLayout(null), [LAYOUT_ID_1])).toBe(false);
    });

    test("buildScoresheetTree keeps the reading's layout bound to the attached photo ids, or to none", async () => {
        const blocks = twoPageLayout().blocks;
        mocks.parsePGN.mockResolvedValueOnce(makeParsedTree(["e4", "e5", "Nf3"], "1-0"));
        const stored = await buildScoresheetTree(
            sampleGame({ layout: blocks, stopped: { ply: 3, tokens: ["?"] } }),
            { photoIds: [LAYOUT_ID_1, LAYOUT_ID_2] },
        );
        expect(stored.scoresheetReview).toEqual({
            stopped: { ply: 3, tokens: ["?"] },
            layout: { photoIds: [LAYOUT_ID_1, LAYOUT_ID_2], blocks },
        });
        expect(stored.scoresheetReview!.layout!.blocks[0]).not.toBe(blocks[0]);

        mocks.parsePGN.mockResolvedValueOnce(makeParsedTree(["e4", "e5", "Nf3"], "1-0"));
        const unsaved = await buildScoresheetTree(sampleGame({ layout: blocks }));
        expect(unsaved.scoresheetReview).toEqual({ layout: { photoIds: null, blocks } });

        mocks.parsePGN.mockResolvedValueOnce(makeParsedTree(["e4", "e5", "Nf3"], "1-0"));
        const none = await buildScoresheetTree(sampleGame({ layout: [] }));
        expect(none.scoresheetReview).toEqual({});
    });
});
