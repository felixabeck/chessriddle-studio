import { type Board, type Color, isNormal, type Move, makeUci, opposite, parseUci } from "chessops";
import { normalizeMove } from "chessops/chess";
import { makeFen } from "chessops/fen";
import { makeSan } from "chessops/san";
import type { ReportPosition, ScoreValue } from "@/bindings";
import type { BasicAnnotation } from "./annotation";
import { positionFromFen } from "./chessops";
import { getSideTimeControlFields, type TimeControlField } from "./clock";
import { getWinChance, normalizeScore } from "./score";
import { type GameHeaders, type TreeNode, treeIteratorMainLine } from "./treeReducer";

/** Win-chance thresholds (0–100) for ahead / behind bands and mistake kinds (D3). */
export const WIN_CHANCE_AHEAD_THRESHOLD = 75;
export const WIN_CHANCE_BEHIND_THRESHOLD = 25;
/** Minimum pawn-equivalent swing for material mistake kinds (D3). */
export const MATERIAL_SWING_THRESHOLD = 2;
/** Maximum plies walked to find a quiet point for material swing (D3). */
export const MATERIAL_SWING_MAX_PLIES = 8;
/** Time-trouble floor in seconds and base-time fraction (D3). */
export const TIME_TROUBLE_MIN_SECONDS = 30;
export const TIME_TROUBLE_BASE_FRACTION = 0.05;
/** Minimum fraction of mainline moves carrying a clock to show the time strip (D3). */
export const TIME_STRIP_MIN_CLOCK_FRACTION = 0.5;
/** Maximum review facts persisted in a report summary (D3). */
export const MAX_REVIEW_FACTS = 256;
/** Maximum plies stored for a generated report variation or review-fact better line. */
export const MAX_GENERATED_ANALYSIS_VARIATION_PLIES = 10;
/** Upper bound on a single SAN token stored inside a review fact. */
export const MAX_REVIEW_FACT_SAN_LENGTH = 16;

const PIECE_VALUES = {
    pawn: 1,
    knight: 3,
    bishop: 3,
    rook: 5,
    queen: 9,
} as const;

const DRAW_SCORE: ScoreValue = { type: "cp", value: 0 };
const CLOCK_EPSILON_SECONDS = 1e-9;

export const MISTAKE_KINDS = [
    "allowsMate",
    "missesMate",
    "losesMaterial",
    "missesMaterial",
    "missesWin",
    "decisive",
] as const;

export type MistakeKind = (typeof MISTAKE_KINDS)[number];

/** Persisted review fact for one mainline move marked `?!`, `?` or `??`. */
export interface ReviewFact {
    /** 1-based mainline index (`mainline[mainlineIndex]`). */
    mainlineIndex: number;
    kind: MistakeKind | null;
    /** Engine's better line from the position before the move, in SAN. */
    betterLine: string[];
}

export interface PlayedUciStep {
    move: Move;
    san: string;
    fen: string;
    isCapture: boolean;
    isCheckmate: boolean;
    isStalemate: boolean;
    material: Record<Color, number>;
}

function sideMaterial(board: Board, color: Color): number {
    const pieces = board[color];
    return (
        pieces.intersect(board.pawn).size() * PIECE_VALUES.pawn +
        pieces.intersect(board.knight).size() * PIECE_VALUES.knight +
        pieces.intersect(board.bishop).size() * PIECE_VALUES.bishop +
        pieces.intersect(board.rook).size() * PIECE_VALUES.rook +
        pieces.intersect(board.queen).size() * PIECE_VALUES.queen
    );
}

function boardMaterial(board: Board): Record<Color, number> {
    return {
        white: sideMaterial(board, "white"),
        black: sideMaterial(board, "black"),
    };
}

function isCaptureMove(
    board: Board,
    turn: Color,
    epSquare: number | undefined,
    move: Move,
): boolean {
    if (!isNormal(move)) return false;
    return (
        board[opposite(turn)].has(move.to) || (board.pawn.has(move.from) && move.to === epSquare)
    );
}

/**
 * Plays up to `maxPlies` UCI moves from `fen` using chessops, stopping at the first unparsable or
 * illegal move. Shared by `reportLineNodes`, `buildReviewFacts` and material-swing calculation.
 */
export function playUciLine(
    fen: string,
    uciMoves: readonly string[],
    maxPlies: number,
): PlayedUciStep[] {
    const [position] = positionFromFen(fen);
    if (!position) return [];
    const steps: PlayedUciStep[] = [];
    for (const uci of uciMoves.slice(0, maxPlies)) {
        const parsed = parseUci(uci);
        if (!parsed) break;
        const move = normalizeMove(position, parsed);
        if (!position.isLegal(move)) break;
        const isCapture = isCaptureMove(position.board, position.turn, position.epSquare, move);
        const san = makeSan(position, move);
        position.play(move);
        steps.push({
            move,
            san,
            fen: makeFen(position.toSetup()),
            isCapture,
            isCheckmate: position.isCheckmate(),
            isStalemate: position.isStalemate(),
            material: boardMaterial(position.board),
        });
    }
    return steps;
}

/**
 * Mover-relative material swing of `uciMoves` from `fenBefore`, evaluated at the latest quiet
 * point within the first `MATERIAL_SWING_MAX_PLIES` plies. Returns `null` when the FEN is invalid
 * or the line has no quiet point.
 */
export function computeMaterialSwing(
    fenBefore: string,
    uciMoves: readonly string[],
    mover: Color,
): number | null {
    const [position] = positionFromFen(fenBefore);
    if (!position) return null;
    const enemy = opposite(mover);
    const initial = sideMaterial(position.board, mover) - sideMaterial(position.board, enemy);
    // Play one extra ply so ply `MATERIAL_SWING_MAX_PLIES` can see whether the next move captures.
    const steps = playUciLine(fenBefore, uciMoves, MATERIAL_SWING_MAX_PLIES + 1);
    const maxIndex = Math.min(steps.length, MATERIAL_SWING_MAX_PLIES);
    let latestQuietSwing: number | null = null;
    for (let i = 0; i < maxIndex; i++) {
        const step = steps[i];
        const next = steps[i + 1];
        const isQuiet =
            step.isCheckmate || step.isStalemate || (next !== undefined && !next.isCapture);
        if (isQuiet) {
            latestQuietSwing = step.material[mover] - step.material[enemy] - initial;
        }
    }
    return latestQuietSwing;
}

function moverValue(score: ScoreValue, color: Color): number {
    return color === "white" ? score.value : -score.value;
}

export interface ClassifyMistakeInput {
    fenBefore: string;
    playedMove: Move | null;
    color: Color;
    beforeScore: ScoreValue;
    afterScore: ScoreValue;
    betterLineUci: readonly string[];
    afterLineUci: readonly string[];
}

/**
 * Classifies a mistake (mover-relative, first matching rule wins). Returns `null` when none of the
 * six rules match.
 */
export function classifyMistake({
    fenBefore,
    playedMove,
    color,
    beforeScore,
    afterScore,
    betterLineUci,
    afterLineUci,
}: ClassifyMistakeInput): MistakeKind | null {
    const beforeView = moverValue(beforeScore, color);
    const afterView = moverValue(afterScore, color);
    const beforeBeingMated = beforeScore.type === "mate" && beforeView < 0;
    const afterBeingMated = afterScore.type === "mate" && afterView < 0;
    if (!beforeBeingMated && afterBeingMated) return "allowsMate";

    const beforeHadMate = beforeScore.type === "mate" && beforeView > 0;
    const afterHasMate = afterScore.type === "mate" && afterView > 0;
    if (beforeHadMate && !afterHasMate) return "missesMate";

    const betterSwing = computeMaterialSwing(fenBefore, betterLineUci, color);
    const playedSwing = playedMove
        ? computeMaterialSwing(fenBefore, [makeUci(playedMove), ...afterLineUci], color)
        : null;
    if (playedSwing !== null && betterSwing !== null) {
        if (
            playedSwing <= -MATERIAL_SWING_THRESHOLD &&
            playedSwing <= betterSwing - MATERIAL_SWING_THRESHOLD
        ) {
            return "losesMaterial";
        }
        if (
            betterSwing >= MATERIAL_SWING_THRESHOLD &&
            betterSwing >= playedSwing + MATERIAL_SWING_THRESHOLD
        ) {
            return "missesMaterial";
        }
    }

    const beforeWin = getWinChance(normalizeScore(beforeScore, color));
    const afterWin = getWinChance(normalizeScore(afterScore, color));
    if (beforeWin >= WIN_CHANCE_AHEAD_THRESHOLD && afterWin < WIN_CHANCE_AHEAD_THRESHOLD) {
        return "missesWin";
    }
    if (beforeWin > WIN_CHANCE_BEHIND_THRESHOLD && afterWin <= WIN_CHANCE_BEHIND_THRESHOLD) {
        return "decisive";
    }

    return null;
}

/**
 * Builds persisted review facts for a finished report: one entry per mainline move marked `?!`,
 * `?` or `??`, capped at `MAX_REVIEW_FACTS` in game order.
 */
export function buildReviewFacts(
    positions: readonly ReportPosition[],
    nodes: readonly Pick<TreeNode, "fen" | "move" | "halfMoves">[],
    marks: readonly (BasicAnnotation | null)[],
): ReviewFact[] {
    const length = Math.min(positions.length, nodes.length, marks.length);
    const facts: ReviewFact[] = [];
    for (let i = 1; i < length; i++) {
        const mark = marks[i];
        if (mark !== "?!" && mark !== "?" && mark !== "??") continue;
        if (facts.length >= MAX_REVIEW_FACTS) break;

        const before = positions[i - 1];
        const after = positions[i];
        const parentNode = nodes[i - 1];
        const movedNode = nodes[i];
        const color: Color = movedNode.halfMoves % 2 === 1 ? "white" : "black";

        const betterLineUci = before.best[0]?.uciMoves ?? [];
        const betterLine = playUciLine(
            parentNode.fen,
            betterLineUci,
            MAX_GENERATED_ANALYSIS_VARIATION_PLIES,
        ).map((step) => step.san);

        const beforeScore = before.best[0]?.score.value;
        const afterScore = after.terminal === "draw" ? DRAW_SCORE : after.best[0]?.score.value;
        const kind =
            beforeScore && afterScore
                ? classifyMistake({
                      fenBefore: parentNode.fen,
                      playedMove: movedNode.move,
                      color,
                      beforeScore,
                      afterScore,
                      betterLineUci,
                      afterLineUci: after.best[0]?.uciMoves ?? [],
                  })
                : null;

        facts.push({ mainlineIndex: i, kind, betterLine });
    }
    return facts;
}

export interface SummaryMoveRef {
    /** 1-based mainline index (`mainline[mainlineIndex]`). */
    mainlineIndex: number;
    halfMoves: number;
    moveNumber: number;
    color: Color;
    san: string;
}

export type GameSummary =
    | {
          kind: "stayedBalanced";
          turningPoint: null;
      }
    | {
          kind: "tookLead";
          side: Color;
          move: SummaryMoveRef;
          turningPoint: number;
      }
    | {
          kind: "turnedGame";
          side: Color;
          move: SummaryMoveRef;
          turningPoint: number;
      }
    | {
          kind: "balancedAgain";
          side: Color;
          aheadMove: SummaryMoveRef;
          balancedMove: SummaryMoveRef;
          turningPoint: null;
      };

type EvalBand = "white" | "black" | "balanced";

function whiteWinChanceForNode(node: TreeNode): number | null {
    if (node.score !== null) {
        return getWinChance(normalizeScore(node.score.value, "white"));
    }
    const [pos] = positionFromFen(node.fen);
    if (!pos) return null;
    if (pos.isCheckmate()) {
        return pos.turn === "black" ? 100 : 0;
    }
    if (pos.isStalemate() || pos.isInsufficientMaterial()) {
        return 50;
    }
    return null;
}

function bandForWinChance(winChance: number): EvalBand {
    if (winChance >= WIN_CHANCE_AHEAD_THRESHOLD) return "white";
    if (winChance <= WIN_CHANCE_BEHIND_THRESHOLD) return "black";
    return "balanced";
}

function toSummaryMoveRef(mainlineIndex: number, node: TreeNode): SummaryMoveRef {
    return {
        mainlineIndex,
        halfMoves: node.halfMoves,
        moveNumber: Math.ceil(node.halfMoves / 2),
        color: node.halfMoves % 2 === 1 ? "white" : "black",
        san: node.san ?? "",
    };
}

/**
 * Summarises the mainline from its White-relative win chances (O3). Returns `null` when the game
 * has no moves, any mainline position lacks a saved evaluation and is not terminal, or the start
 * position is outside the balanced band.
 */
export function summarizeGame(root: TreeNode): GameSummary | null {
    const mainline = Array.from(treeIteratorMainLine(root));
    if (mainline.length < 2) return null;

    const bands: EvalBand[] = [];
    for (const { node } of mainline) {
        const winChance = whiteWinChanceForNode(node);
        if (winChance === null) return null;
        bands.push(bandForWinChance(winChance));
    }

    if (bands[0] !== "balanced") return null;

    const finalBand = bands[bands.length - 1];
    let finalStart = bands.length - 1;
    while (finalStart > 0 && bands[finalStart - 1] === finalBand) {
        finalStart -= 1;
    }

    if (finalBand === "balanced") {
        if (finalStart === 0) {
            return { kind: "stayedBalanced", turningPoint: null };
        }
        const aheadSide = bands[finalStart - 1] as Color;
        let aheadStart = finalStart - 1;
        while (aheadStart > 0 && bands[aheadStart - 1] === aheadSide) {
            aheadStart -= 1;
        }
        return {
            kind: "balancedAgain",
            side: aheadSide,
            aheadMove: toSummaryMoveRef(aheadStart, mainline[aheadStart].node),
            balancedMove: toSummaryMoveRef(finalStart, mainline[finalStart].node),
            turningPoint: null,
        };
    }

    const otherSide = opposite(finalBand);
    let otherAheadEarlier = false;
    for (let i = 1; i < finalStart; i++) {
        if (bands[i] === otherSide) {
            otherAheadEarlier = true;
            break;
        }
    }

    return {
        kind: otherAheadEarlier ? "turnedGame" : "tookLead",
        side: finalBand,
        move: toSummaryMoveRef(finalStart, mainline[finalStart].node),
        turningPoint: finalStart,
    };
}

export interface MoveTimeEntry {
    /** 1-based mainline index (`mainline[mainlineIndex]`). */
    mainlineIndex: number;
    halfMoves: number;
    color: Color;
    san: string;
    /** Mover's remaining clock after the move, in seconds, or `null` when absent. */
    clock: number | null;
    /** Seconds spent on this move, or `null` when unknown or time was added. */
    spent: number | null;
    /** Whether the mover's clock after this move is at or below the time-trouble threshold. */
    inTimeTrouble: boolean;
}

export interface GameTimeUsage {
    moves: MoveTimeEntry[];
    /** True when at least half of the mainline moves carry a clock. */
    showTimeStrip: boolean;
}

function baseSecondsFromField(field: TimeControlField | null): number | null {
    if (!field || !Number.isFinite(field.seconds) || field.seconds < 0) return null;
    return field.seconds / 1000;
}

function incrementSecondsFromField(field: TimeControlField | null): number {
    if (!field || field.increment === undefined || !Number.isFinite(field.increment)) return 0;
    return field.increment >= 0 ? field.increment / 1000 : 0;
}

/** Whether a remaining clock (in seconds) is at or below the time-trouble threshold (O4). */
export function isTimeTrouble(clock: number | null, baseSeconds: number | null): boolean {
    if (clock === null || !Number.isFinite(clock)) return false;
    const threshold =
        baseSeconds !== null && Number.isFinite(baseSeconds)
            ? Math.max(TIME_TROUBLE_MIN_SECONDS, baseSeconds * TIME_TROUBLE_BASE_FRACTION)
            : TIME_TROUBLE_MIN_SECONDS;
    return clock <= threshold;
}

/**
 * Derives per-move time spent, time trouble and time-strip eligibility for the mainline (O4).
 */
export function getMoveTimeUsage(
    root: TreeNode,
    headers: Pick<GameHeaders, "time_control" | "white_time_control" | "black_time_control">,
): GameTimeUsage {
    const { white: whiteField, black: blackField } = getSideTimeControlFields(headers);
    const base: Record<Color, number | null> = {
        white: baseSecondsFromField(whiteField),
        black: baseSecondsFromField(blackField),
    };
    const increment: Record<Color, number> = {
        white: incrementSecondsFromField(whiteField),
        black: incrementSecondsFromField(blackField),
    };
    const previousClock: Record<Color, number | null> = {
        white: base.white,
        black: base.black,
    };

    const moves: MoveTimeEntry[] = [];
    let clockedMoves = 0;
    let mainlineIndex = 0;
    let node = root;

    while (node.children.length > 0) {
        node = node.children[0];
        mainlineIndex += 1;
        const color: Color = node.halfMoves % 2 === 1 ? "white" : "black";
        const clock = node.clock !== undefined && Number.isFinite(node.clock) ? node.clock : null;
        if (clock !== null) clockedMoves += 1;

        const prev = previousClock[color];
        let spent: number | null = null;
        if (clock !== null && prev !== null) {
            const rawSpent = prev - clock + increment[color];
            if (rawSpent >= -CLOCK_EPSILON_SECONDS) {
                spent = rawSpent <= 0 ? 0 : rawSpent;
            }
        }
        previousClock[color] = clock;

        moves.push({
            mainlineIndex,
            halfMoves: node.halfMoves,
            color,
            san: node.san ?? "",
            clock,
            spent,
            inTimeTrouble: isTimeTrouble(clock, base[color]),
        });
    }

    return {
        moves,
        showTimeStrip:
            moves.length > 0 && clockedMoves / moves.length >= TIME_STRIP_MIN_CLOCK_FRACTION,
    };
}
