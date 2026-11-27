import { parseUci } from "chessops";
import { INITIAL_FEN, makeFen } from "chessops/fen";
import { makeSan } from "chessops/san";
import { expect, test } from "vitest";
import type { ReportPosition, Score } from "@/bindings";
import { positionFromFen } from "../chessops";
import {
    buildReviewFacts,
    classifyMistake,
    computeMaterialSwing,
    getMoveTimeUsage,
    isTimeTrouble,
    MAX_GENERATED_ANALYSIS_VARIATION_PLIES,
    MAX_REVIEW_FACTS,
    summarizeGame,
} from "../gameReview";
import { judgeReport } from "../score";
import { createNode, defaultTree, type GameHeaders, type TreeNode } from "../treeReducer";

type EngineScore = ReportPosition["best"][number]["score"]["value"];

const cp = (value: number): EngineScore => ({ type: "cp", value });
const mate = (value: number): EngineScore => ({ type: "mate", value });
const score = (value: EngineScore): Score => ({ value, wdl: null });

function reportPos(
    uciMoves: string[],
    value: EngineScore,
    terminal: ReportPosition["terminal"] = null,
): ReportPosition {
    return {
        best:
            uciMoves.length === 0 && terminal !== null
                ? []
                : [
                      {
                          nodes: 1n,
                          depth: 12,
                          score: { value, wdl: null },
                          uciMoves,
                          sanMoves: uciMoves,
                          multipv: 1,
                          nps: 1n,
                      },
                  ],
        terminal,
        isSacrifice: false,
    };
}

function buildMainline(fen: string, ucis: string[]): TreeNode[] {
    const root = defaultTree(fen).root;
    const nodes = [root];
    const [chess] = positionFromFen(fen);
    if (!chess) throw new Error(`Invalid FEN: ${fen}`);
    for (const uci of ucis) {
        const move = parseUci(uci);
        if (!move) throw new Error(`Invalid UCI: ${uci}`);
        const san = makeSan(chess, move);
        chess.play(move);
        const parent = nodes[nodes.length - 1];
        const child = createNode({
            fen: makeFen(chess.toSetup()),
            move,
            san,
            halfMoves: parent.halfMoves + 1,
        });
        parent.children.push(child);
        nodes.push(child);
    }
    return nodes;
}

// ---- O1: Mistake classification & review facts ----

test("classifyMistake detects each of the six kinds of mistake", () => {
    const start = INITIAL_FEN;
    const a2a3 = parseUci("a2a3")!;

    // 1. allowsMate: not being mated before, being mated after.
    expect(
        classifyMistake({
            fenBefore: start,
            playedMove: a2a3,
            color: "white",
            beforeScore: cp(0),
            afterScore: mate(-2),
            betterLineUci: ["e2e4", "e7e5"],
            afterLineUci: ["e7e5"],
        }),
    ).toBe("allowsMate");

    // 2. missesMate: had a mate before, no longer has one after.
    expect(
        classifyMistake({
            fenBefore: start,
            playedMove: a2a3,
            color: "white",
            beforeScore: mate(2),
            afterScore: cp(200),
            betterLineUci: ["e2e4", "e7e5"],
            afterLineUci: ["e7e5"],
        }),
    ).toBe("missesMate");

    // 3. losesMaterial: played line loses a queen (-9) vs better line (0).
    // White has Q on d1 (e-pawn already on e4), Black has N on f6; 1. Qh5 Nxh5 2. a3 (quiet after ply 2) vs 1. Nc3 e5.
    const hangQueenFen = "rnbqkb1r/pppppppp/5n2/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 1";
    expect(
        classifyMistake({
            fenBefore: hangQueenFen,
            playedMove: parseUci("d1h5")!,
            color: "white",
            beforeScore: cp(0),
            afterScore: cp(-800),
            betterLineUci: ["b1c3", "e7e5"],
            afterLineUci: ["f6h5", "a2a3"],
        }),
    ).toBe("losesMaterial");

    // 4. missesMaterial: better line wins a queen (+9) vs played line (0).
    // White rook on h1 captures Black queen on h5, followed by a quiet Black move.
    const rookTakesQueenFen = "rnb1kbnr/pppppppp/8/7q/8/8/PPPPPPP1/RNBQKBNR w KQkq - 0 1";
    expect(
        classifyMistake({
            fenBefore: rookTakesQueenFen,
            playedMove: parseUci("a2a3")!,
            color: "white",
            beforeScore: cp(800),
            afterScore: cp(0),
            betterLineUci: ["h1h5", "e7e6"],
            afterLineUci: ["h5g4", "e2e4"],
        }),
    ).toBe("missesMaterial");

    // 5. missesWin: win chance >= 75 before (+400 -> ~81.2), < 75 after (+100 -> ~59.1), no material swing.
    expect(
        classifyMistake({
            fenBefore: start,
            playedMove: a2a3,
            color: "white",
            beforeScore: cp(400),
            afterScore: cp(100),
            betterLineUci: ["e2e4", "e7e5"],
            afterLineUci: ["e7e5", "g1f3"],
        }),
    ).toBe("missesWin");

    // 6. decisive: win chance > 25 before (0 -> 50), <= 25 after (-400 -> ~18.8), no material swing.
    expect(
        classifyMistake({
            fenBefore: start,
            playedMove: a2a3,
            color: "white",
            beforeScore: cp(0),
            afterScore: cp(-400),
            betterLineUci: ["e2e4", "e7e5"],
            afterLineUci: ["e7e5", "g1f3"],
        }),
    ).toBe("decisive");

    // Fallback: drop stays inside balanced band (e.g. +150 -> -50) with no material swing -> null.
    expect(
        classifyMistake({
            fenBefore: start,
            playedMove: a2a3,
            color: "white",
            beforeScore: cp(150),
            afterScore: cp(-50),
            betterLineUci: ["e2e4", "e7e5"],
            afterLineUci: ["e7e5", "g1f3"],
        }),
    ).toBeNull();
});

test("classifyMistake flips White-relative scores for Black and ignores allowsMate when already mated", () => {
    const blackFen = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
    const a7a6 = parseUci("a7a6")!;
    const quiet = {
        fenBefore: blackFen,
        playedMove: a7a6,
        color: "black" as const,
        betterLineUci: ["e7e5", "g1f3"],
        afterLineUci: ["d2d4", "e7e5"],
    };

    // Black being mated is a positive White-relative mate score.
    expect(classifyMistake({ ...quiet, beforeScore: cp(0), afterScore: mate(2) })).toBe(
        "allowsMate",
    );
    // Black having mate is a negative White-relative mate score.
    expect(classifyMistake({ ...quiet, beforeScore: mate(-2), afterScore: cp(-200) })).toBe(
        "missesMate",
    );
    // Black win chance >= 75 (-400 cp) dropping below 75 (-100 cp).
    expect(classifyMistake({ ...quiet, beforeScore: cp(-400), afterScore: cp(-100) })).toBe(
        "missesWin",
    );
    // Black win chance > 25 (0 cp) dropping to <= 25 (+400 cp).
    expect(classifyMistake({ ...quiet, beforeScore: cp(0), afterScore: cp(400) })).toBe("decisive");

    // Already being mated before the move does not trigger allowsMate (either side).
    expect(classifyMistake({ ...quiet, beforeScore: mate(4), afterScore: mate(2) })).toBeNull();
    expect(
        classifyMistake({
            fenBefore: INITIAL_FEN,
            playedMove: parseUci("a2a3")!,
            color: "white",
            beforeScore: mate(-4),
            afterScore: mate(-2),
            betterLineUci: ["e2e4", "e7e5"],
            afterLineUci: ["e7e5", "g1f3"],
        }),
    ).toBeNull();
});

test("classifyMistake enforces the 2-pawn threshold and handles non-queen piece swings", () => {
    // 1-pawn swing (-1 vs 0) must NOT match losesMaterial.
    const hangPawnFen = "4k3/8/8/4p3/8/8/3P4/4K3 w - - 0 1";
    expect(
        classifyMistake({
            fenBefore: hangPawnFen,
            playedMove: parseUci("d2d4")!,
            color: "white",
            beforeScore: cp(50),
            afterScore: cp(-50),
            betterLineUci: ["e1e2", "e8e7"],
            afterLineUci: ["e5d4", "e1e2"],
        }),
    ).toBeNull();

    // 1-pawn missed capture (+1 vs 0) must NOT match missesMaterial.
    const winPawnFen = "4k3/8/8/4p3/3P4/8/8/4K3 w - - 0 1";
    expect(
        classifyMistake({
            fenBefore: winPawnFen,
            playedMove: parseUci("e1e2")!,
            color: "white",
            beforeScore: cp(100),
            afterScore: cp(0),
            betterLineUci: ["d4e5", "e8e7"],
            afterLineUci: ["e5d4", "e2d3"],
        }),
    ).toBeNull();

    // Exact 2-pawn boundary via an exchange (Rook=5 for Knight=3 -> -2 swing) MUST match losesMaterial.
    const loseExchangeExact = "7k/8/6n1/8/3P4/8/8/4RK2 w - - 0 1";
    expect(
        classifyMistake({
            fenBefore: loseExchangeExact,
            playedMove: parseUci("e1e5")!,
            color: "white",
            beforeScore: cp(50),
            afterScore: cp(-50),
            betterLineUci: ["f1e2", "h8g8"],
            afterLineUci: ["g6e5", "d4e5", "h8g8"],
        }),
    ).toBe("losesMaterial");

    // Exact +2 boundary via winning an exchange (Knight=3 captures Rook=5, Black recaptures -> +2) MUST match missesMaterial.
    const winExchangeExact = "4k3/3p4/4r3/8/3N4/8/8/4K3 w - - 0 1";
    expect(
        classifyMistake({
            fenBefore: winExchangeExact,
            playedMove: parseUci("e1d2")!,
            color: "white",
            beforeScore: cp(100),
            afterScore: cp(0),
            betterLineUci: ["d4e6", "d7e6", "e1d2"],
            afterLineUci: ["e6e5", "d2d3"],
        }),
    ).toBe("missesMaterial");

    // Non-queen piece swing: winning a free rook (+5) with a bishop matches missesMaterial.
    const winRookFen = "4k3/8/8/4r3/8/8/7B/4K3 w - - 0 1";
    expect(
        classifyMistake({
            fenBefore: winRookFen,
            playedMove: parseUci("e1d2")!,
            color: "white",
            beforeScore: cp(100),
            afterScore: cp(0),
            betterLineUci: ["h2e5", "e8e7"],
            afterLineUci: ["e5e7", "d2d3"],
        }),
    ).toBe("missesMaterial");

    // Relative-guard conjunct for losesMaterial: unavoidable loss (-3 vs -3) must return null.
    const unavoidableLossFen = "4k3/8/8/4r3/8/4N3/8/K7 w - - 0 1";
    const unavoidablePlayed = ["a1b1", "e5e3", "b1c1"];
    const unavoidableBetter = ["a1a2", "e5e3", "a2b2"];
    expect(computeMaterialSwing(unavoidableLossFen, unavoidablePlayed, "white")).toBe(-3);
    expect(computeMaterialSwing(unavoidableLossFen, unavoidableBetter, "white")).toBe(-3);
    expect(
        classifyMistake({
            fenBefore: unavoidableLossFen,
            playedMove: parseUci(unavoidablePlayed[0])!,
            color: "white",
            beforeScore: cp(50),
            afterScore: cp(-50),
            betterLineUci: unavoidableBetter,
            afterLineUci: unavoidablePlayed.slice(1),
        }),
    ).toBeNull();

    // Relative-guard conjunct for missesMaterial: equal win (+3 vs +3) must return null.
    const equalWinFen = "k7/8/8/4n3/8/8/7B/K3R3 w - - 0 1";
    const equalWinPlayed = ["h2e5", "a8a7"];
    const equalWinBetter = ["e1e5", "a8a7"];
    expect(computeMaterialSwing(equalWinFen, equalWinPlayed, "white")).toBe(3);
    expect(computeMaterialSwing(equalWinFen, equalWinBetter, "white")).toBe(3);
    expect(
        classifyMistake({
            fenBefore: equalWinFen,
            playedMove: parseUci(equalWinPlayed[0])!,
            color: "white",
            beforeScore: cp(50),
            afterScore: cp(-50),
            betterLineUci: equalWinBetter,
            afterLineUci: equalWinPlayed.slice(1),
        }),
    ).toBeNull();
});

test("classifyMistake respects the priority order when multiple rules match", () => {
    const hangQueenFen = "rnbqkb1r/pppppppp/5n2/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 1";
    const rookTakesQueenFen = "rnb1kbnr/pppppppp/8/7q/8/8/PPPPPPP1/RNBQKBNR w KQkq - 0 1";

    // 1 beats 2: had mate before AND allows mate after -> allowsMate.
    expect(
        classifyMistake({
            fenBefore: hangQueenFen,
            playedMove: parseUci("d1h5")!,
            color: "white",
            beforeScore: mate(2),
            afterScore: mate(-1),
            betterLineUci: ["b1c3", "e7e5"],
            afterLineUci: ["f6h5", "a2a3"],
        }),
    ).toBe("allowsMate");

    // 2 beats 3 and 5: misses mate while also losing material and dropping below 75%.
    expect(
        classifyMistake({
            fenBefore: hangQueenFen,
            playedMove: parseUci("d1h5")!,
            color: "white",
            beforeScore: mate(3),
            afterScore: cp(-800),
            betterLineUci: ["b1c3", "e7e5"],
            afterLineUci: ["f6h5", "a2a3"],
        }),
    ).toBe("missesMate");

    // 3 beats 5 and 6: loses material while also dropping from >= 75% to <= 25%.
    expect(
        classifyMistake({
            fenBefore: hangQueenFen,
            playedMove: parseUci("d1h5")!,
            color: "white",
            beforeScore: cp(400),
            afterScore: cp(-400),
            betterLineUci: ["b1c3", "e7e5"],
            afterLineUci: ["f6h5", "a2a3"],
        }),
    ).toBe("losesMaterial");

    // 4 beats 5: misses material while also dropping below 75%.
    expect(
        classifyMistake({
            fenBefore: rookTakesQueenFen,
            playedMove: parseUci("a2a3")!,
            color: "white",
            beforeScore: cp(500),
            afterScore: cp(0),
            betterLineUci: ["h1h5", "e7e6"],
            afterLineUci: ["h5g4", "e2e4"],
        }),
    ).toBe("missesMaterial");

    // 5 beats 6: win chance drops from >= 75% directly to <= 25% without mate/material.
    expect(
        classifyMistake({
            fenBefore: INITIAL_FEN,
            playedMove: parseUci("a2a3")!,
            color: "white",
            beforeScore: cp(400),
            afterScore: cp(-400),
            betterLineUci: ["e2e4", "e7e5"],
            afterLineUci: ["e7e5", "g1f3"],
        }),
    ).toBe("missesWin");
});

test("computeMaterialSwing handles promotion, en passant, illegal moves and no quiet point", () => {
    // Promotion: pawn (1) promotes to queen (9) -> +8 swing once followed by a quiet move.
    const promoFen = "7k/4P3/8/8/8/8/8/4K3 w - - 0 1";
    expect(computeMaterialSwing(promoFen, ["e7e8q", "h8g7"], "white")).toBe(8);

    // En passant: counts as a capture, so the ply before en passant is NOT a quiet point,
    // and after en passant + quiet reply the captured pawn is reflected in the swing.
    const epFen = "4k3/3p4/8/4P3/8/8/8/4K3 b - - 0 1";
    // 1...d5 (followed by capture exd6 e.p. -> ply 1 NOT quiet) 2. exd6 (followed by quiet Ke7 -> ply 2 IS quiet).
    // From Black's perspective, Black lost 1 pawn -> -1.
    expect(computeMaterialSwing(epFen, ["d7d5", "e5d6", "e8d8"], "black")).toBe(-1);
    // If the line ends right after d7d5 -> e5d6 (no quiet follow-up), there is NO quiet point!
    expect(computeMaterialSwing(epFen, ["d7d5", "e5d6"], "black")).toBeNull();

    // Illegal move ends the line: after a capture, an illegal follow-up is not a known quiet move.
    const captureFen = "rnb1kbnr/pppppppp/8/7q/8/8/PPPPPPP1/RNBQKBNR w KQkq - 0 1";
    expect(computeMaterialSwing(captureFen, ["h1h5", "e8e1"], "white")).toBeNull();

    // Checkmate counts as a quiet point even with no next move.
    const mateFen = "7k/5Q2/6K1/8/8/8/8/8 w - - 0 1";
    expect(computeMaterialSwing(mateFen, ["f7g7"], "white")).toBe(0);

    // Stalemate counts as a quiet point even with no next move.
    const stalemateFen = "7k/8/7K/5Q2/8/8/8/8 w - - 0 1";
    expect(computeMaterialSwing(stalemateFen, ["f5f7"], "white")).toBe(0);

    // No quiet point: single non-terminal move has no known next move -> null, so rules 3/4 do not apply.
    expect(computeMaterialSwing(captureFen, ["h1h5"], "white")).toBeNull();
    expect(
        classifyMistake({
            fenBefore: captureFen,
            playedMove: parseUci("a2a3")!,
            color: "white",
            beforeScore: cp(150),
            afterScore: cp(-50),
            betterLineUci: ["h1h5"], // no quiet point -> rules 3/4 skipped
            afterLineUci: ["h5g4", "e2e4"],
        }),
    ).toBeNull();
});

test("computeMaterialSwing uses the latest quiet point and ply-9 lookahead for ply 8", () => {
    // Two quiet points: ply 1 (a1b1, next h8g8 quiet -> swing 0) and ply 3 (d1d8 captures rook, next g8g7 quiet -> swing +5).
    // Must return +5 (latest quiet point), not 0 (first quiet point).
    const twoQuietFen = "3r3k/8/8/8/8/8/8/K2R4 w - - 0 1";
    expect(computeMaterialSwing(twoQuietFen, ["a1b1", "h8g8", "d1d8", "g8g7"], "white")).toBe(5);

    // 8 consecutive captures on d5; ply 8 (d8d5) leaves White down 8 (lost 2P+N+Q=14, won 3P+N=6).
    // Plies 1..7 all have a capture as their next move, so ply 8 is the ONLY quiet point when ply 9 is quiet.
    const eightPlyCaptureFen = "3r3k/2n5/2p1p3/3p4/2P1P3/2N5/3Q4/K2R4 w - - 0 1";
    const eightCaptures = ["c4d5", "c6d5", "e4d5", "e6d5", "c3d5", "c7d5", "d2d5", "d8d5"];
    // Ply 9 quiet (a1b1) -> ply 8 IS quiet (requires MATERIAL_SWING_MAX_PLIES + 1 lookahead).
    expect(computeMaterialSwing(eightPlyCaptureFen, [...eightCaptures, "a1b1"], "white")).toBe(-8);
    // Ply 9 capture (d1d5) -> ply 8 is NOT quiet -> no quiet point within 8 plies -> null.
    expect(
        computeMaterialSwing(eightPlyCaptureFen, [...eightCaptures, "d1d5"], "white"),
    ).toBeNull();
});

test("buildReviewFacts handles Black-to-move start, illegal moves in betterLine and ply cap", () => {
    // Black to move on move 5 (e-pawn already on e5): Black hangs the queen via Qh4? -> Nxh4.
    const blackStart = "rnbqkbnr/pppp1ppp/8/4p3/8/5N2/PPPPPPPP/RNBQKB1R b KQkq - 1 5";
    const nodes = buildMainline(blackStart, ["d8h4"]);
    const positions = [
        reportPos(
            [
                "b8c6",
                "e2e4",
                "g8f6",
                "b1c3",
                "f8b4",
                "a2a3",
                "b4a5",
                "d2d3",
                "d7d6",
                "f1e2",
                "e8g8",
                "e1g1",
            ],
            cp(0),
        ),
        reportPos(["f3h4", "d7d6"], cp(800)),
    ];
    const marks = judgeReport(positions, nodes);
    expect(marks[1]).toBe("??");

    const facts = buildReviewFacts(positions, nodes, marks);
    expect(facts).toHaveLength(1);
    expect(facts[0].mainlineIndex).toBe(1);
    expect(facts[0].kind).toBe("losesMaterial");
    expect(facts[0].betterLine).toHaveLength(MAX_GENERATED_ANALYSIS_VARIATION_PLIES);
    expect(facts[0].betterLine.slice(0, 4)).toEqual(["Nc6", "e4", "Nf6", "Nc3"]);

    // Illegal move truncates betterLine cleanly.
    const withIllegal = [
        reportPos(["b8c6", "e1e8", "g8f6"], cp(0)),
        reportPos(["f3h4", "d7d6"], cp(800)),
    ];
    const truncated = buildReviewFacts(withIllegal, nodes, marks);
    expect(truncated[0].betterLine).toEqual(["Nc6"]);
});

test("buildReviewFacts respects MAX_REVIEW_FACTS cap and keeps kind=null when no rule matches", () => {
    // Build a 1-move inaccuracy where no rule matches (drops +100 -> +20: win chance ~59.1 -> ~51.8).
    const nodes = buildMainline(INITIAL_FEN, ["a2a3"]);
    const positions = [reportPos(["e2e4", "e7e5"], cp(100)), reportPos(["e7e5", "g1f3"], cp(20))];
    const marks = judgeReport(positions, nodes);
    expect(marks[1]).toBe("?!");
    expect(buildReviewFacts(positions, nodes, marks)).toEqual([
        { mainlineIndex: 1, kind: null, betterLine: ["e4", "e5"] },
    ]);

    // Cap test: 260 marked mistakes produce only MAX_REVIEW_FACTS (256) in game order.
    const repeatedMoves: string[] = [];
    for (let i = 0; i < 65; i++) {
        repeatedMoves.push("g1f3", "g8f6", "f3g1", "f6g8");
    }
    const longNodes = buildMainline(INITIAL_FEN, repeatedMoves);
    const longPositions: ReportPosition[] = longNodes.map((_, idx) =>
        reportPos(idx % 2 === 0 ? ["e2e4"] : ["e7e5"], cp(0)),
    );
    const longMarks = longNodes.map((_, idx) => (idx === 0 ? null : ("??" as const)));
    const capped = buildReviewFacts(longPositions, longNodes, longMarks);
    expect(capped).toHaveLength(MAX_REVIEW_FACTS);
    expect(capped[0].mainlineIndex).toBe(1);
    expect(capped[MAX_REVIEW_FACTS - 1].mainlineIndex).toBe(MAX_REVIEW_FACTS);
});

test("buildReviewFacts classifies terminal draw mistakes with draw score and ignores non-mistake marks", () => {
    // Stalemate blunder: White is winning (+500) and plays Qf7 (stalemate -> terminal: "draw", best: []).
    const stalemateNodes = buildMainline("7k/8/7K/5Q2/8/8/8/8 w - - 0 1", ["f5f7"]);
    const stalematePositions = [reportPos(["f5f6"], cp(500)), reportPos([], cp(0), "draw")];
    const stalemateMarks = judgeReport(stalematePositions, stalemateNodes);
    expect(stalemateMarks[1]).toBe("??");
    expect(buildReviewFacts(stalematePositions, stalemateNodes, stalemateMarks)).toEqual([
        { mainlineIndex: 1, kind: "missesWin", betterLine: ["Qf6+"] },
    ]);

    // Non-mistake marks (!!, !, !?) produce no review fact.
    const nonMistakeNodes = buildMainline(INITIAL_FEN, ["e2e4", "e7e5", "g1f3"]);
    const nonMistakePositions = [
        reportPos(["e2e4"], cp(0)),
        reportPos(["e7e5"], cp(0)),
        reportPos(["g1f3"], cp(0)),
        reportPos(["b8c6"], cp(0)),
    ];
    expect(buildReviewFacts(nonMistakePositions, nonMistakeNodes, [null, "!!", "!", "!?"])).toEqual(
        [],
    );
});

// ---- O3: Summary line ----

function scoredLine(fen: string, ucis: string[], scores: (EngineScore | null)[]): TreeNode {
    const nodes = buildMainline(fen, ucis);
    nodes.forEach((node, idx) => {
        const value = scores[idx];
        node.score = value ? score(value) : null;
    });
    return nodes[0];
}

test("summarizeGame returns each of the four sentence shapes and turning points", () => {
    // 1. stayedBalanced
    const balanced = scoredLine(
        INITIAL_FEN,
        ["e2e4", "e7e5", "g1f3"],
        [cp(15), cp(0), cp(50), cp(-50)],
    );
    expect(summarizeGame(balanced)).toEqual({ kind: "stayedBalanced", turningPoint: null });

    // 2. tookLead (White takes lead at ply 3 and keeps it)
    const whiteLead = scoredLine(
        INITIAL_FEN,
        ["e2e4", "e7e5", "g1f3", "b8c6"],
        [cp(15), cp(0), cp(100), cp(400), cp(500)],
    );
    expect(summarizeGame(whiteLead)).toEqual({
        kind: "tookLead",
        side: "white",
        move: { mainlineIndex: 3, halfMoves: 3, moveNumber: 2, color: "white", san: "Nf3" },
        turningPoint: 3,
    });

    // 3. turnedGame (White ahead earlier, Black takes the final lead at ply 4)
    const blackTurn = scoredLine(
        INITIAL_FEN,
        ["e2e4", "e7e5", "g1f3", "b8c6"],
        [cp(15), cp(400), cp(50), cp(0), cp(-400)],
    );
    expect(summarizeGame(blackTurn)).toEqual({
        kind: "turnedGame",
        side: "black",
        move: { mainlineIndex: 4, halfMoves: 4, moveNumber: 2, color: "black", san: "Nc6" },
        turningPoint: 4,
    });

    // 4. balancedAgain (uses the most recent ahead run when multiple occurred)
    const balancedAgain = scoredLine(
        INITIAL_FEN,
        ["e2e4", "e7e5", "g1f3", "b8c6", "f1b5", "a7a6"],
        [cp(15), cp(400), cp(0), cp(-400), cp(-450), cp(0), cp(10)],
    );
    expect(summarizeGame(balancedAgain)).toEqual({
        kind: "balancedAgain",
        side: "black",
        aheadMove: { mainlineIndex: 3, halfMoves: 3, moveNumber: 2, color: "white", san: "Nf3" },
        balancedMove: { mainlineIndex: 5, halfMoves: 5, moveNumber: 3, color: "white", san: "Bb5" },
        turningPoint: null,
    });
});

test("summarizeGame returns null on unscored positions or unbalanced start, and handles terminal mate", () => {
    // Unscored non-terminal position -> null.
    const unscored = scoredLine(INITIAL_FEN, ["e2e4", "e7e5"], [cp(15), null, cp(0)]);
    expect(summarizeGame(unscored)).toBeNull();

    // Unbalanced start (White ahead at root) -> null (no summary, no turning point).
    const unbalancedStart = scoredLine(INITIAL_FEN, ["e2e4", "e7e5"], [cp(400), cp(400), cp(400)]);
    expect(summarizeGame(unbalancedStart)).toBeNull();

    // Empty game (no moves) -> null.
    const empty = defaultTree().root;
    empty.score = score(cp(0));
    expect(summarizeGame(empty)).toBeNull();

    // Terminal checkmate with score === null counts as decisive for the mating side.
    const mateRoot = scoredLine("7k/5Q2/6K1/8/8/8/8/8 w - - 0 1", ["f7g7"], [cp(0), null]);
    expect(summarizeGame(mateRoot)).toEqual({
        kind: "tookLead",
        side: "white",
        move: { mainlineIndex: 1, halfMoves: 1, moveNumber: 1, color: "white", san: "Qg7#" },
        turningPoint: 1,
    });

    // Terminal stalemate with score === null counts as balanced (50% win chance).
    const stalemateRoot = scoredLine("7k/8/7K/5Q2/8/8/8/8 w - - 0 1", ["f5f7"], [cp(0), null]);
    expect(summarizeGame(stalemateRoot)).toEqual({ kind: "stayedBalanced", turningPoint: null });

    // Black-to-move start anchors move numbers to the root FEN.
    const blackStart = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 10";
    const fromBlack = scoredLine(blackStart, ["e7e5", "g1f3"], [cp(0), cp(-400), cp(-450)]);
    expect(summarizeGame(fromBlack)).toEqual({
        kind: "tookLead",
        side: "black",
        move: { mainlineIndex: 1, halfMoves: 20, moveNumber: 10, color: "black", san: "e5" },
        turningPoint: 1,
    });
});

// ---- O4: Time spent & time trouble ----

function headersWithTc(
    overrides: Partial<
        Pick<GameHeaders, "time_control" | "white_time_control" | "black_time_control">
    >,
) {
    return {
        time_control: null,
        white_time_control: null,
        black_time_control: null,
        ...overrides,
    };
}

function clockedLine(fen: string, ucis: string[], clocks: (number | undefined)[]): TreeNode {
    const nodes = buildMainline(fen, ucis);
    clocks.forEach((clk, idx) => {
        nodes[idx + 1].clock = clk;
    });
    return nodes[0];
}

test("getMoveTimeUsage computes spent with base time, increment, missing clocks and added time", () => {
    // 5+3 time control (300s base, 3s increment), 6 plies.
    // White clocks: 298 (spent 300-298+3=5), 300 (spent 298-300+3=1), 320 (rose by 20 > 3 -> null).
    // Black clocks: 303 (spent 300-303+3=0), undefined (missing -> null), 290 (predecessor unknown -> null).
    const root = clockedLine(
        INITIAL_FEN,
        ["e2e4", "e7e5", "g1f3", "b8c6", "f1b5", "a7a6"],
        [298, 303, 300, undefined, 320, 290],
    );
    const usage = getMoveTimeUsage(root, headersWithTc({ time_control: "300+3" }));
    expect(usage.showTimeStrip).toBe(true);
    expect(usage.moves.map((m) => m.spent)).toEqual([5, 0, 1, null, null, null]);
    expect(usage.moves.map((m) => m.clock)).toEqual([298, 303, 300, null, 320, 290]);
});

test("getMoveTimeUsage uses side-specific time controls and falls back cleanly when base is unknown", () => {
    const root = clockedLine(INITIAL_FEN, ["e2e4", "e7e5", "g1f3", "b8c6"], [170, 50, 160, 40]);
    const sideSpecific = getMoveTimeUsage(
        root,
        headersWithTc({ white_time_control: "180+0", black_time_control: "60+2" }),
    );
    expect(sideSpecific.moves.map((m) => m.spent)).toEqual([10, 12, 10, 12]);

    // Unknown time control: first move of each side has no predecessor -> spent null; second move uses first clock.
    const noTc = getMoveTimeUsage(root, headersWithTc({}));
    expect(noTc.moves.map((m) => m.spent)).toEqual([null, null, 10, 10]);
});

test("isTimeTrouble enforces both the 30 s floor and the 5% of base threshold", () => {
    // Unknown base -> 30 s threshold.
    expect(isTimeTrouble(30, null)).toBe(true);
    expect(isTimeTrouble(30.1, null)).toBe(false);
    expect(isTimeTrouble(null, null)).toBe(false);

    // 5+0 (300 s base): 5% = 15 s < 30 s -> 30 s threshold wins.
    expect(isTimeTrouble(30, 300)).toBe(true);
    expect(isTimeTrouble(31, 300)).toBe(false);

    // 90+30 (5400 s base): 5% = 270 s > 30 s -> 270 s threshold wins.
    expect(isTimeTrouble(270, 5400)).toBe(true);
    expect(isTimeTrouble(271, 5400)).toBe(false);

    // Integrated check via getMoveTimeUsage with 90+30.
    const root = clockedLine(INITIAL_FEN, ["e2e4", "e7e5"], [270, 271]);
    const usage = getMoveTimeUsage(root, headersWithTc({ time_control: "5400+30" }));
    expect(usage.moves.map((m) => m.inTimeTrouble)).toEqual([true, false]);
});

test("getMoveTimeUsage warrants the time strip from half the mainline moves onward", () => {
    // 0 moves -> false.
    expect(getMoveTimeUsage(defaultTree().root, headersWithTc({})).showTimeStrip).toBe(false);

    // 1 of 3 moves clocked -> false (< 50%).
    const belowHalf = clockedLine(
        INITIAL_FEN,
        ["e2e4", "e7e5", "g1f3"],
        [100, undefined, undefined],
    );
    expect(getMoveTimeUsage(belowHalf, headersWithTc({})).showTimeStrip).toBe(false);

    // 2 of 4 moves clocked -> true (== 50%).
    const exactHalf = clockedLine(
        INITIAL_FEN,
        ["e2e4", "e7e5", "g1f3", "b8c6"],
        [100, undefined, 90, undefined],
    );
    expect(getMoveTimeUsage(exactHalf, headersWithTc({})).showTimeStrip).toBe(true);
});

test("getMoveTimeUsage attributes clocks by halfMoves on a Black-to-move start FEN", () => {
    const blackStart = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
    const root = clockedLine(blackStart, ["e7e5", "g1f3"], [55, 175]);
    const usage = getMoveTimeUsage(
        root,
        headersWithTc({ white_time_control: "180+0", black_time_control: "60+0" }),
    );
    expect(usage.moves.map((m) => [m.color, m.spent])).toEqual([
        ["black", 5],
        ["white", 5],
    ]);
});
