import { minMax } from "@tiptap/react";
import { type Color, parseUci } from "chessops";
import { match } from "ts-pattern";
import type { BestMoves, ReportPosition, Score, ScoreValue } from "@/bindings";
import type { Annotation, BasicAnnotation } from "./annotation";
import { isSameMove, positionFromFen } from "./chessops";
import type { TreeNode } from "./treeReducer";

export const INITIAL_SCORE: Score = {
    value: {
        type: "cp",
        value: 15,
    },
    wdl: null,
};

const CP_CEILING = 1000;

export function formatScore(score: ScoreValue, precision = 2): string {
    let scoreText = match(score.type)
        .with("cp", () => Math.abs(score.value / 100).toFixed(precision))
        .with("mate", () => `M${Math.abs(score.value)}`)
        .with("dtz", () => `DTZ${Math.abs(score.value)}`)
        .exhaustive();
    if (score.value > 0) {
        scoreText = `+${scoreText}`;
    }
    if (score.value < 0) {
        scoreText = `-${scoreText}`;
    }
    return scoreText;
}

/** An engine score's position assessment, as the matching advantage annotation symbol. */
export type PositionAssessment = Extract<Annotation, "+-" | "±" | "⩲" | "=" | "⩱" | "∓" | "-+">;

/**
 * Centipawn boundaries (White's view, inclusive lower bound) of a slight edge, a clear
 * advantage and a winning position. There is no official standard; Felix chose
 * 0.3 / 1 / 2 pawns on 2026-11-02.
 */
const ASSESSMENT_EDGE_CP = 30;
const ASSESSMENT_ADVANTAGE_CP = 100;
const ASSESSMENT_WINNING_CP = 200;

/**
 * Maps a White-relative engine score to an advantage symbol. Mate and tablebase scores
 * are decisive for the side their sign favours. "Unclear" (∞) is never derived: a number
 * cannot say that a position is unclear.
 */
export function positionAssessment(score: ScoreValue): PositionAssessment {
    if (score.value === 0) return "=";
    const white = score.value > 0;
    if (score.type !== "cp") return white ? "+-" : "-+";
    const cp = Math.abs(score.value);
    if (cp >= ASSESSMENT_WINNING_CP) return white ? "+-" : "-+";
    if (cp >= ASSESSMENT_ADVANTAGE_CP) return white ? "±" : "∓";
    if (cp >= ASSESSMENT_EDGE_CP) return white ? "⩲" : "⩱";
    return "=";
}

export function getWinChance(centipawns: number) {
    return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * centipawns)) - 1);
}

export function normalizeScore(score: ScoreValue, color: Color): number {
    let cp = score.value;
    if (color === "black") {
        cp *= -1;
    }
    if (score.type !== "cp") {
        cp = CP_CEILING * Math.sign(cp);
    }
    return minMax(cp, -CP_CEILING, CP_CEILING);
}

function normalizeScores(
    prev: ScoreValue,
    next: ScoreValue,
    color: Color,
): { prevCP: number; nextCP: number } {
    return {
        prevCP: normalizeScore(prev, color),
        nextCP: normalizeScore(next, color),
    };
}

export function getAccuracy(prev: ScoreValue, next: ScoreValue, color: Color): number {
    const { prevCP, nextCP } = normalizeScores(prev, next, color);
    return minMax(
        103.1668 * Math.exp(-0.04354 * (getWinChance(prevCP) - getWinChance(nextCP))) - 3.1669 + 1,
        0,
        100,
    );
}

export function getCPLoss(prev: ScoreValue, next: ScoreValue, color: Color): number {
    const { prevCP, nextCP } = normalizeScores(prev, next, color);

    return Math.max(0, prevCP - nextCP);
}

export function getAnnotation(
    prevprev: ScoreValue | null,
    prev: ScoreValue | null,
    next: ScoreValue,
    color: Color,
    prevMoves: BestMoves[],
    is_sacrifice?: boolean,
    move?: string,
): Annotation {
    // A null score means the evaluation is not available, not that it was 0.00.
    // Coercing it to 0.00 invented a mistake annotation for a ply whose
    // predecessor published no lines: from a won position, the next evaluation
    // read as a huge loss against the invented baseline (f-20260831-21).
    // With no predecessor evaluation the comparison is against `next` itself, so
    // the difference is zero and no mistake annotation is derived.
    const { prevCP, nextCP } = normalizeScores(prev ?? next, next, color);
    const winChanceDiff = getWinChance(prevCP) - getWinChance(nextCP);

    if (winChanceDiff > 20) {
        return "??";
    }
    if (winChanceDiff > 10) {
        return "?";
    }
    if (winChanceDiff > 5) {
        return "?!";
    }

    if (prevMoves.length > 1) {
        const scores = normalizeScores(prevMoves[0].score.value, prevMoves[1].score.value, color);
        if (
            getWinChance(scores.prevCP) - getWinChance(scores.nextCP) > 10 &&
            move === prevMoves[0].sanMoves[0]
        ) {
            if (is_sacrifice) {
                return "!!";
            }
            if (prevprev !== null) {
                const scores = normalizeScores(prevprev, prevMoves[0].score.value, color);
                // Without the previous-previous evaluation there is nothing to
                // show the move improved on, so "!" is not derivable.
                if (getWinChance(scores.nextCP) - getWinChance(scores.prevCP) > 5) {
                    return "!";
                }
            }
        } else if (is_sacrifice && nextCP > -200) {
            return "!?";
        }
    }
    return "";
}

/** Win-chance drops (mover's view, 0–100) above which a move is `??`, `?` and `?!`. */
const BLUNDER_DROP = 20;
const MISTAKE_DROP = 10;
const INACCURACY_DROP = 5;
/** Centipawn bands (mover's view) of the mate-created and mate-lost rules. */
const MATE_RULE_INACCURACY_CP = 999;
const MATE_RULE_MISTAKE_CP = 700;
/** How far the first line must beat the second for a first choice to be good (`!`, `!!`). */
const ONLY_MOVE_GAP = 10;
/** How far the first line must beat the evaluation two plies back for `!`. */
const PUNISHES_ERROR_GAP = 5;
/** The after-evaluation (mover's view) a sacrifice must stay above for `!?`. */
const INTERESTING_SACRIFICE_FLOOR_CP = -200;

const DRAW_SCORE: ScoreValue = { type: "cp", value: 0 };

/** A White-relative score in the mover's view: positive is good for the mover. */
function moverValue(score: ScoreValue, color: Color): number {
    return color === "white" ? score.value : -score.value;
}

function isMate(score: ScoreValue): boolean {
    return score.type !== "cp";
}

function winChanceFor(score: ScoreValue, color: Color): number {
    return getWinChance(normalizeScore(score, color));
}

function mistakeMark(before: ScoreValue, after: ScoreValue, color: Color): BasicAnnotation | null {
    const beforeView = moverValue(before, color);
    const afterView = moverValue(after, color);
    const afterMatedAgainst = isMate(after) && afterView < 0;
    if (!isMate(before) && afterMatedAgainst) {
        // Mate created: the move walks into a forced mate.
        if (beforeView < -MATE_RULE_INACCURACY_CP) return "?!";
        if (beforeView < -MATE_RULE_MISTAKE_CP) return "?";
        return "??";
    }
    if (isMate(before) && beforeView > 0 && (!isMate(after) || afterMatedAgainst)) {
        // Mate lost: a forced mate for the mover is gone. A mate against the mover is below
        // every band.
        if (!afterMatedAgainst && afterView > MATE_RULE_INACCURACY_CP) return "?!";
        if (!afterMatedAgainst && afterView > MATE_RULE_MISTAKE_CP) return "?";
        return "??";
    }
    const drop = winChanceFor(before, color) - winChanceFor(after, color);
    if (drop > BLUNDER_DROP) return "??";
    if (drop > MISTAKE_DROP) return "?";
    if (drop > INACCURACY_DROP) return "?!";
    return null;
}

/** Whether the move that reached `node` is the first line's first move in `parent`'s position. */
function playedFirstChoice(
    parent: Pick<TreeNode, "fen">,
    node: Pick<TreeNode, "move">,
    best: BestMoves,
): boolean {
    const engineMove = best.uciMoves[0] ? parseUci(best.uciMoves[0]) : undefined;
    if (!node.move || !engineMove) return false;
    const [position] = positionFromFen(parent.fen);
    return !!position && isSameMove(position, node.move, engineMove);
}

/**
 * Judges every mainline move of a finished report. `positions` are the native report's entries
 * (root first, White-relative) and `nodes` the mainline nodes they describe, root first. Entry
 * `i` of the result is the mark for the move that reached position `i`; entry 0 is always null.
 * The mover comes from each node's `halfMoves`, which is anchored to the root FEN.
 */
export function judgeReport(
    positions: readonly ReportPosition[],
    nodes: readonly Pick<TreeNode, "fen" | "move" | "halfMoves">[],
): (BasicAnnotation | null)[] {
    const length = Math.min(positions.length, nodes.length);
    const marks: (BasicAnnotation | null)[] = new Array(length).fill(null);
    for (let i = 1; i < length; i++) {
        const before = positions[i - 1];
        const after = positions[i];
        if (before.best.length === 0) continue;
        if (after.best.length === 0 && after.terminal === null) continue;
        if (after.terminal === "checkmate") continue;
        const afterScore = after.terminal === "draw" ? DRAW_SCORE : after.best[0].score.value;
        const color: Color = nodes[i].halfMoves % 2 === 1 ? "white" : "black";
        const firstChoice = playedFirstChoice(nodes[i - 1], nodes[i], before.best[0]);
        const mistake = firstChoice
            ? null
            : mistakeMark(before.best[0].score.value, afterScore, color);
        if (mistake) {
            marks[i] = mistake;
            continue;
        }
        if (before.best.length < 2) continue;
        const firstLine = winChanceFor(before.best[0].score.value, color);
        const secondLine = winChanceFor(before.best[1].score.value, color);
        if (firstChoice && firstLine - secondLine > ONLY_MOVE_GAP) {
            if (after.isSacrifice) {
                marks[i] = "!!";
            } else {
                const twoBack = i >= 2 ? positions[i - 2].best[0]?.score.value : undefined;
                if (twoBack && firstLine - winChanceFor(twoBack, color) > PUNISHES_ERROR_GAP) {
                    marks[i] = "!";
                }
            }
        } else if (
            after.isSacrifice &&
            normalizeScore(afterScore, color) > INTERESTING_SACRIFICE_FLOOR_CP
        ) {
            marks[i] = "!?";
        }
    }
    return marks;
}
