import { type Chess, makeUci, parseUci } from "chessops";
import { makeFen } from "chessops/fen";
import { makeSan } from "chessops/san";
import type { TrainingPuzzle, TrainingTreeNode, TrainingVerdict } from "@/bindings";
import { makeMove } from "@/state/store/tree";
import { positionFromFen } from "./chessops";
import { defaultTree, getBoardState, type TreeNode, type TreeState } from "./treeReducer";

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

export function trainingDepth(node: TreeNode): number {
    return node.children.length ? 1 + Math.max(...node.children.map(trainingDepth)) : 0;
}

/** The server uses a move-bearing root, Studio uses a decision-position root. */
export function trainingSubmissionTree(root: TreeNode): TrainingTreeNode {
    const encode = (node: TreeNode): TrainingTreeNode =>
        Object.freeze({
            move: node.move ? makeUci(node.move) : "",
            children: Object.freeze(node.children.map(encode)) as TrainingTreeNode[],
        });
    return encode(root.children[0] ?? root);
}

export function trainingNeedsConfirmation(root: TreeNode, depth = 0): boolean {
    return root.children.length
        ? root.children.some((child) => trainingNeedsConfirmation(child, depth + 1))
        : depth > 0 && depth % 2 === 0;
}

export function canSubmitTraining(
    tree: Pick<TreeState, "root" | "position">,
    threshold: number,
): boolean {
    let node = tree.root;
    for (const index of tree.position) node = node.children[index];
    return (
        tree.root.children.length > 0 &&
        (trainingDepth(tree.root) >= threshold || position(node.fen).isEnd())
    );
}

export function trainingMoveNotice(
    tree: Pick<TreeState, "root" | "position">,
    token: string,
    cap: number,
) {
    let node = tree.root;
    for (const index of tree.position) node = node.children[index];
    const existing = node.children.findIndex(
        (child) => child.move && makeUci(child.move) === token,
    );
    if (existing >= 0) return { existing };
    if (tree.position.length % 2 === 0 && node.children.length)
        return { notice: "oneSolverMove" as const };
    if (tree.position.length >= cap || node.children.length >= 10)
        return { notice: "inputLimit" as const };
    move(position(node.fen), token);
    return {};
}

/** Optional annotations degrade independently of the already committed verdict. */
export function trainingVerdictTree(
    puzzle: TrainingPuzzle,
    submittedRoot: TreeNode,
    verdict: TrainingVerdict,
): TreeState {
    const tree = defaultTree(puzzle.decisionFen);
    tree.headers.orientation = puzzle.sideToMove;
    tree.root = structuredClone(submittedRoot);
    const follow = (path: number[]) => {
        let node: TreeNode | undefined = tree.root;
        for (const index of path) node = node?.children[index];
        return node;
    };
    const add = (path: number[], token: string) => {
        const parent = follow(path);
        if (!parent) return;
        const parsed = parseUci(token);
        const [pos] = positionFromFen(parent.fen);
        if (!parsed || !pos?.isLegal(parsed)) return;
        tree.position = path;
        makeMove({ state: tree, move: parsed, last: false, sound: false, changeHeaders: false });
        const child = follow(tree.position);
        if (child && !child.nags.includes(2)) child.nags = [1];
        return [...tree.position];
    };
    const serverPath = verdict.incorrectMovePath;
    if (serverPath && verdict.incorrectMove && verdict.correctMove) {
        const path = serverPath.length === 1 && serverPath[0] === -1 ? [0] : [0, ...serverPath];
        const wrong = follow(path);
        if (wrong?.move && makeUci(wrong.move) === verdict.incorrectMove) {
            const correction = add(path.slice(0, -1), verdict.correctMove);
            if (correction) wrong.nags = [2];
        }
    }
    let path: number[] | undefined = [];
    for (const token of verdict.correctVariation) {
        if (!path) break;
        path = add(path, token);
    }
    tree.position = [];
    return tree;
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
