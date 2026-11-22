import { parseUci } from "chessops";
import { makeFen } from "chessops/fen";
import { makeSan } from "chessops/san";
import { expect, test } from "vitest";
import type { BestMoves, ReportPosition } from "@/bindings";
import { positionFromFen } from "../chessops";
import { createNode, defaultTree, type TreeNode } from "../treeReducer";
import {
    formatScore,
    getAccuracy,
    getAnnotation,
    getCPLoss,
    getWinChance,
    judgeReport,
    normalizeScore,
    positionAssessment,
} from "../score";

test("should format a positive cp score correctly", () => {
    expect(formatScore({ type: "cp", value: 50 })).toBe("+0.50");
});

test("should format a negative cp score correctly", () => {
    expect(formatScore({ type: "cp", value: -50 })).toBe("-0.50");
});

test("should format a mate score correctly", () => {
    expect(formatScore({ type: "mate", value: 5 })).toBe("+M5");
    expect(formatScore({ type: "mate", value: -5 })).toBe("-M5");
});

test("should format a dtz score with a leading sign", () => {
    expect(formatScore({ type: "dtz", value: 12 })).toBe("+DTZ12");
    expect(formatScore({ type: "dtz", value: -12 })).toBe("-DTZ12");
    expect(formatScore({ type: "dtz", value: 0 })).toBe("DTZ0");
    expect(formatScore({ type: "dtz", value: 12 }, 1).slice(1)).toBe("DTZ12");
});

test("normalizeScore maps dtz like mate to the centipawn ceiling", () => {
    expect(normalizeScore({ type: "dtz", value: 12 }, "white")).toBe(1000);
    expect(normalizeScore({ type: "dtz", value: -5 }, "white")).toBe(-1000);
    expect(normalizeScore({ type: "dtz", value: 12 }, "black")).toBe(-1000);
    expect(normalizeScore({ type: "dtz", value: -5 }, "black")).toBe(1000);
    expect(normalizeScore({ type: "dtz", value: 0 }, "white")).toBeCloseTo(0);
    expect(normalizeScore({ type: "dtz", value: 0 }, "black")).toBeCloseTo(0);
});

test("should calculate the win chance correctly", () => {
    expect(getWinChance(0)).toBe(50);
    expect(getWinChance(100)).toBeCloseTo(59.1);
    expect(getWinChance(-500)).toBeCloseTo(13.69);
});

test("should calculate the accuracy correctly", () => {
    expect(getAccuracy({ type: "cp", value: 0 }, { type: "cp", value: 0 }, "white")).toBe(100);
    expect(getAccuracy({ type: "cp", value: 0 }, { type: "cp", value: -500 }, "white")).toBeCloseTo(
        19.07,
    );
});

test("should calculate the cp loss correctly", () => {
    expect(getCPLoss({ type: "cp", value: 0 }, { type: "cp", value: 50 }, "black")).toBe(50);
    expect(getCPLoss({ type: "mate", value: -1 }, { type: "cp", value: 0 }, "black")).toBe(1000);
});

// The mistake annotations are a comparison against the previous evaluation, so
// every case that expects one supplies it explicitly.
const ZERO = { type: "cp" as const, value: 0 };

test("should annotate as ??", () => {
    expect(getAnnotation(null, ZERO, { type: "cp", value: -500 }, "white", [])).toBe("??");
    expect(getAnnotation(null, ZERO, { type: "cp", value: 500 }, "black", [])).toBe("??");
});

test("should annotate as ?", () => {
    expect(getAnnotation(null, ZERO, { type: "cp", value: -200 }, "white", [])).toBe("?");
    expect(getAnnotation(null, ZERO, { type: "cp", value: 200 }, "black", [])).toBe("?");
});

test("should annotate as ?!", () => {
    expect(getAnnotation(null, ZERO, { type: "cp", value: -100 }, "white", [])).toBe("?!");
    expect(getAnnotation(null, ZERO, { type: "cp", value: 100 }, "black", [])).toBe("?!");
});

test("should not annotate", () => {
    expect(getAnnotation(null, ZERO, { type: "cp", value: -50 }, "white", [])).toBe("");
    expect(getAnnotation(null, ZERO, { type: "cp", value: 50 }, "black", [])).toBe("");
});

test("derives no mistake annotation without the previous evaluation", () => {
    // A null previous score means "not available" — an unannotated ply, not a
    // blunder measured against an invented 0.00 baseline.
    expect(getAnnotation(null, null, { type: "cp", value: -500 }, "white", [])).toBe("");
    expect(getAnnotation(null, null, { type: "cp", value: 500 }, "black", [])).toBe("");
    expect(getAnnotation(null, null, { type: "mate", value: -1 }, "white", [])).toBe("");
});

test("derives no ! without the previous-previous evaluation", () => {
    const only = (value: number, san: string): BestMoves => ({
        depth: 1,
        multipv: 1,
        nodes: 1n,
        score: { value: { type: "cp", value }, wdl: null },
        nps: 1000n,
        sanMoves: [san],
        uciMoves: ["e2e4"],
    });
    // Only move: the best line is far better than the second, and it was played.
    const prevMoves = [only(300, "e4"), only(-300, "d4")];

    expect(
        getAnnotation(ZERO, ZERO, { type: "cp", value: 300 }, "white", prevMoves, false, "e4"),
    ).toBe("!");
    // "!" claims the move improved on the position before it. Without that
    // evaluation there is nothing to have improved on.
    expect(
        getAnnotation(null, ZERO, { type: "cp", value: 300 }, "white", prevMoves, false, "e4"),
    ).toBe("");
    // "!!" rests on the sacrifice alone and survives the missing evaluation.
    expect(
        getAnnotation(null, ZERO, { type: "cp", value: 300 }, "white", prevMoves, true, "e4"),
    ).toBe("!!");
});

test("positionAssessment uses the 0.3 / 1 / 2 pawn boundaries from White's view", () => {
    const cp = (value: number) => positionAssessment({ type: "cp", value });
    expect([0, 29, -29].map(cp)).toEqual(["=", "=", "="]);
    expect([30, 99, -30, -99].map(cp)).toEqual(["⩲", "⩲", "⩱", "⩱"]);
    expect([100, 199, -100, -199].map(cp)).toEqual(["±", "±", "∓", "∓"]);
    expect([200, 900, -200, -900].map(cp)).toEqual(["+-", "+-", "-+", "-+"]);
});

test("positionAssessment treats mate and tablebase scores as decisive for their side", () => {
    expect(positionAssessment({ type: "mate", value: 3 })).toBe("+-");
    expect(positionAssessment({ type: "mate", value: -1 })).toBe("-+");
    expect(positionAssessment({ type: "dtz", value: 12 })).toBe("+-");
    expect(positionAssessment({ type: "dtz", value: -4 })).toBe("-+");
});

// ---- judgeReport (R1) ----

type EngineLine = ReportPosition["best"][number];
type EngineScore = EngineLine["score"]["value"];
type Line = [uci: string, score: EngineScore];

function line([uci, score]: Line, multipv: number): EngineLine {
    return {
        nodes: 1n,
        depth: 10,
        score: { value: score, wdl: null },
        uciMoves: [uci],
        sanMoves: [uci],
        multipv,
        nps: 1n,
    };
}

function position(
    lines: Line[],
    extra: Partial<Pick<ReportPosition, "terminal" | "isSacrifice">> = {},
): ReportPosition {
    return {
        best: lines.map((entry, index) => line(entry, index + 1)),
        terminal: extra.terminal ?? null,
        isSacrifice: extra.isSacrifice ?? false,
    };
}

const cp = (value: number): EngineScore => ({ type: "cp", value });
const mate = (value: number): EngineScore => ({ type: "mate", value });

/** Mainline nodes, root first, for a game from `fen` with the given UCI moves. */
function mainline(fen: string, ucis: string[]): TreeNode[] {
    const nodes = [defaultTree(fen).root];
    const [chess] = positionFromFen(fen);
    if (!chess) throw new Error(`bad fen ${fen}`);
    for (const uci of ucis) {
        const move = parseUci(uci)!;
        const san = makeSan(chess, move);
        chess.play(move);
        const parent = nodes[nodes.length - 1];
        const node = createNode({
            fen: makeFen(chess.toSetup()),
            move,
            san,
            halfMoves: parent.halfMoves + 1,
        });
        parent.children.push(node);
        nodes.push(node);
    }
    return nodes;
}

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

/** White's first move judged with `before` lines and an `after` position. */
function judgeFirstMove(played: string, before: ReportPosition, after: ReportPosition) {
    return judgeReport([before, after], mainline(START, [played]))[1];
}

test("judgeReport marks win-chance drops of the move that was not the first choice", () => {
    const before = position([["e2e4", cp(0)]]);
    expect(judgeFirstMove("a2a3", before, position([["e7e5", cp(-500)]]))).toBe("??");
    expect(judgeFirstMove("a2a3", before, position([["e7e5", cp(-200)]]))).toBe("?");
    expect(judgeFirstMove("a2a3", before, position([["e7e5", cp(-100)]]))).toBe("?!");
    expect(judgeFirstMove("a2a3", before, position([["e7e5", cp(-50)]]))).toBeNull();
});

test("judgeReport never marks the engine's own first choice as a mistake", () => {
    const before = position([["e2e4", cp(0)]]);
    const after = position([["e7e5", cp(-500)]]);
    // A drop above 20: the same move is `??` when it was not the first choice.
    expect(judgeFirstMove("a2a3", before, after)).toBe("??");
    expect(judgeFirstMove("e2e4", before, after)).toBeNull();
});

test("judgeReport compares a king-to-rook castle with the engine's castle as one move", () => {
    const fen = "r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1";
    const before = position([["e1g1", cp(0)]]);
    const after = position([["e8g8", cp(-500)]]);
    expect(judgeReport([before, after], mainline(fen, ["e1h1"]))[1]).toBeNull();
    expect(judgeReport([before, after], mainline(fen, ["a2a3"]))[1]).toBe("??");
});

test("judgeReport bands a move that walks into a forced mate", () => {
    const after = position([["e7e5", mate(-3)]]);
    expect(judgeFirstMove("a2a3", position([["e2e4", cp(-1200)]]), after)).toBe("?!");
    expect(judgeFirstMove("a2a3", position([["e2e4", cp(-800)]]), after)).toBe("?");
    expect(judgeFirstMove("a2a3", position([["e2e4", cp(-100)]]), after)).toBe("??");
    // Walking from exactly −7.00 into mate is not below the `?` band.
    expect(judgeFirstMove("a2a3", position([["e2e4", cp(-700)]]), after)).toBe("??");
});

test("judgeReport bands a move that loses a forced mate", () => {
    const before = position([["e2e4", mate(2)]]);
    expect(judgeFirstMove("a2a3", before, position([["e7e5", cp(1200)]]))).toBe("?!");
    expect(judgeFirstMove("a2a3", before, position([["e7e5", cp(800)]]))).toBe("?");
    // A missed mate that keeps +9.00.
    expect(judgeFirstMove("a2a3", before, position([["e7e5", cp(900)]]))).toBe("?");
    expect(judgeFirstMove("a2a3", before, position([["e7e5", cp(100)]]))).toBe("??");
    expect(judgeFirstMove("a2a3", before, position([["e7e5", mate(-2)]]))).toBe("??");
    // Still mating: no mark.
    expect(judgeFirstMove("a2a3", before, position([["e7e5", mate(3)]]))).toBeNull();
});

test("judgeReport gives no judgement without both evaluations, and none for mate", () => {
    const evaluated = position([["e2e4", cp(0)]]);
    expect(judgeFirstMove("a2a3", position([]), position([["e7e5", cp(-500)]]))).toBeNull();
    expect(judgeFirstMove("a2a3", evaluated, position([]))).toBeNull();
    expect(judgeFirstMove("a2a3", evaluated, position([], { terminal: "checkmate" }))).toBeNull();
    expect(judgeReport([evaluated], mainline(START, []))).toEqual([null]);
});

test("judgeReport scores a terminal draw as 0.00: stalemate and bare kings", () => {
    const won = position([["f5f6", cp(500)]]);
    const stalemate = mainline("7k/8/7K/5Q2/8/8/8/8 w - - 0 1", ["f5f7"]);
    expect(judgeReport([won, position([], { terminal: "draw" })], stalemate)[1]).toBe("??");
    const bareKings = mainline("8/8/8/4k3/8/3p4/8/2N1K3 w - - 0 1", ["c1d3"]);
    const winning = position([["e1e2", cp(500)]]);
    expect(judgeReport([winning, position([], { terminal: "draw" })], bareKings)[1]).toBe("??");
    // A drawn position that stays drawn is no mistake.
    const level = position([["e1e2", cp(0)]]);
    expect(judgeReport([level, position([], { terminal: "draw" })], bareKings)[1]).toBeNull();
});

test("judgeReport charges the side to move of a Black-to-move, fullmove-10 root", () => {
    const fen = "rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 10";
    const nodes = mainline(fen, ["a7a6", "b1c3"]);
    expect(nodes[1].halfMoves % 2).toBe(0);
    const positions = [
        position([["b8c6", cp(0)]]),
        // White-relative +5.00 after Black's move: Black's blunder.
        position([["f3e5", cp(500)]]),
        position([["g8f6", cp(-500)]]),
    ];
    const marks = judgeReport(positions, nodes);
    expect(marks[1]).toBe("??");
    // White gave the gain back on the second move.
    expect(marks[2]).toBe("??");
});

test("judgeReport derives !!, ! and !? only without a mistake and with two lines", () => {
    const onlyMove = position([
        ["e2e4", cp(300)],
        ["d2d4", cp(-100)],
    ]);
    const after = position([["e7e5", cp(300)]]);
    const sacrifice = position([["e7e5", cp(300)]], { isSacrifice: true });
    expect(judgeFirstMove("e2e4", onlyMove, sacrifice)).toBe("!!");
    // Without a second line nothing good is derivable.
    expect(judgeFirstMove("e2e4", position([["e2e4", cp(300)]]), sacrifice)).toBeNull();

    // `!` needs the evaluation two plies back and a first line that beats it by more than 5.
    const nodes = mainline(START, ["a2a3", "e7e5", "d2d4"]);
    const marks = judgeReport(
        [
            position([["e2e4", cp(0)]]),
            position([["d7d5", cp(0)]]),
            position([
                ["d2d4", cp(300)],
                ["g1f3", cp(-100)],
            ]),
            position([["e5d4", cp(300)]]),
        ],
        nodes,
    );
    // Black's 1...e5 dropped from 0 to +3.00 for White: `??`; White's 2.d4 punishes it: `!`.
    expect(marks[2]).toBe("??");
    expect(marks[3]).toBe("!");
    expect(judgeFirstMove("e2e4", onlyMove, after)).toBeNull();

    // `!?`: a sacrifice that is not the first choice and keeps the evaluation above −2.00.
    const close = position([
        ["e2e4", cp(30)],
        ["d2d4", cp(20)],
    ]);
    expect(judgeFirstMove("g1f3", close, position([["e7e5", cp(0)]], { isSacrifice: true }))).toBe(
        "!?",
    );
    expect(judgeFirstMove("g1f3", close, position([["e7e5", cp(0)]]))).toBeNull();
});

test("judgeReport marks a whole game", () => {
    // 1.e4 e5 2.Qh5 Nc6 3.Bc4 Nf6?? 4.Qxf7#
    const nodes = mainline(START, ["e2e4", "e7e5", "d1h5", "b8c6", "f1c4", "g8f6", "h5f7"]);
    const positions = [
        position([
            ["e2e4", cp(20)],
            ["d2d4", cp(18)],
        ]),
        position([
            ["e7e5", cp(25)],
            ["c7c5", cp(30)],
        ]),
        position([
            ["g1f3", cp(30)],
            ["b1c3", cp(20)],
        ]),
        // 2.Qh5 is not the first choice and gives up a little.
        position([
            ["b8c6", cp(-60)],
            ["g8f6", cp(-80)],
        ]),
        position([
            ["f1c4", cp(-40)],
            ["d2d3", cp(-60)],
        ]),
        position([
            ["g7g6", cp(-50)],
            ["d8e7", cp(-40)],
        ]),
        // 3...Nf6?? allows mate in one.
        position([
            ["h5f7", mate(1)],
            ["h5f5", cp(200)],
        ]),
        position([], { terminal: "checkmate" }),
    ];
    expect(judgeReport(positions, nodes)).toEqual([null, null, null, "?!", null, null, "??", null]);
});
