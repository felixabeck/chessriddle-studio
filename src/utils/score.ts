import { minMax } from "@tiptap/react";
import type { Color } from "chessops";
import { match } from "ts-pattern";
import type { BestMoves, Score, ScoreValue } from "@/bindings";
import type { Annotation } from "./annotation";

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
    if (score.type !== "dtz") {
        if (score.value > 0) {
            scoreText = `+${scoreText}`;
        }
        if (score.value < 0) {
            scoreText = `-${scoreText}`;
        }
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
    if (score.type === "mate") {
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
