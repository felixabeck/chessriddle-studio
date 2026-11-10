import { type Chess, parseUci } from "chessops";
import { makeFen } from "chessops/fen";
import { makeSan } from "chessops/san";
import type { TrainingPuzzle } from "@/bindings";
import { positionFromFen } from "./chessops";
import { defaultTree, getBoardState } from "./treeReducer";

// Mirrors the native submission bound from the server contract.
export const MAX_TRAINING_SUBMISSION_PLIES = 7;
// Mirrors the native duration bound from the server contract.
export const MAX_TRAINING_DURATION_MS = 86_400_000;
// Mirrors the native exclusion bound from the server contract.
export const MAX_TRAINING_EXCLUSIONS = 50;

function position(fen: string): Chess {
    const [pos] = positionFromFen(fen);
    if (!pos) throw new Error("Invalid training position");
    return pos;
}

function move(pos: Chess, token: string) {
    if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(token)) throw new Error("Invalid training move");
    const parsed = parseUci(token);
    if (!parsed || !pos.isLegal(parsed)) throw new Error("Illegal training move");
    return parsed;
}

/** Replay the opponent's entrance, anchored to the supplied root position. */
export function trainingDecision(puzzle: TrainingPuzzle): Chess {
    const pos = position(puzzle.preEntranceFen);
    pos.play(move(pos, puzzle.entranceMove));
    const expected = position(puzzle.decisionFen);
    if (
        getBoardState(makeFen(pos.toSetup())) !== getBoardState(makeFen(expected.toSetup())) ||
        pos.turn !== puzzle.sideToMove
    )
        throw new Error("Inconsistent training position");
    return pos;
}

export function walkTrainingLine(fen: string, line: readonly string[]) {
    const pos = position(fen);
    const steps = [
        { fen: makeFen(pos.toSetup()), san: "", turn: pos.turn, fullmoves: pos.fullmoves },
    ];
    for (const token of line) {
        const parsed = move(pos, token);
        const san = makeSan(pos, parsed);
        pos.play(parsed);
        steps.push({ fen: makeFen(pos.toSetup()), san, turn: pos.turn, fullmoves: pos.fullmoves });
    }
    return steps;
}

export function trainingPosition(
    puzzle: TrainingPuzzle,
    line: readonly string[],
    cursor = line.length,
) {
    if (!Number.isInteger(cursor) || cursor < 0 || cursor > line.length)
        throw new Error("Invalid training cursor");
    const pos = trainingDecision(puzzle);
    for (const token of line.slice(0, cursor)) pos.play(move(pos, token));
    return pos;
}

export function appendTrainingMove(
    puzzle: TrainingPuzzle,
    line: readonly string[],
    token: string,
    cap: number,
): string[] {
    if (line.length >= cap) throw new Error("Training line is full");
    const pos = trainingPosition(puzzle, line);
    move(pos, token);
    return [...line, token];
}

export function undoTrainingMove(line: readonly string[]): string[] {
    return line.slice(0, -1);
}

export function canSubmitTraining(
    puzzle: TrainingPuzzle,
    line: readonly string[],
    threshold: number,
): boolean {
    return line.length > 0 && (line.length >= threshold || trainingPosition(puzzle, line).isEnd());
}

export function trainingSan(puzzle: TrainingPuzzle, line: readonly string[]): string[] {
    trainingDecision(puzzle);
    return walkTrainingLine(puzzle.decisionFen, line)
        .slice(1)
        .map((step) => step.san);
}

/** Build the analysis mainline locally, without crossing the native PGN lexer. */
export function trainingAnalysisTree(puzzle: TrainingPuzzle, line: readonly string[]) {
    const steps = walkTrainingLine(puzzle.decisionFen, line);
    const tree = defaultTree(puzzle.decisionFen);
    tree.headers.orientation = puzzle.sideToMove;
    let parent = tree.root;
    for (let index = 0; index < line.length; index++) {
        const step = steps[index + 1];
        const child = {
            ...defaultTree(step.fen).root,
            move: parseUci(line[index]) ?? null,
            san: step.san,
        };
        parent.children = [child];
        parent = child;
    }
    return tree;
}
