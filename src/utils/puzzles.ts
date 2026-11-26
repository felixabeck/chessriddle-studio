import { tauri } from "@/platform/tauri";
import type { PuzzleDatabaseInfo } from "@/bindings";
import { runFolderSwitch, type FolderSwitchResult } from "@/components/settings/folderSwitch";
import { isNormal, parseUci, type Move, type NormalMove } from "chessops";
import type { Chess } from "chessops/chess";
import type { TreeStore } from "@/state/store/tree";
import i18n from "@/i18n";
import { uciNormalize } from "@/utils/chess";
import { parseSanOrUci, positionFromFen, translateChessopsError } from "@/utils/chessops";
import { getBoardState, type TreeNode, type TreeState } from "@/utils/treeReducer";

import type { Puzzle } from "@/state/puzzleSession";
export type { Completion, Puzzle } from "@/state/puzzleSession";

export type MoveSequenceResult =
    | { success: true; moves: Move[] }
    | { success: false; error: Error };

export function validateMoveSequence(fen: string, payload: string[]): MoveSequenceResult {
    const [pos, positionError] = positionFromFen(fen);
    if (!pos) {
        return {
            success: false,
            error: new Error(
                i18n.t("Board.Analysis.InvalidPosition", {
                    error: translateChessopsError(i18n.t, positionError),
                }),
            ),
        };
    }
    const moves: Move[] = [];
    for (const [index, token] of payload.entries()) {
        const move = parseSanOrUci(pos, token);
        if (!move) {
            return {
                success: false,
                error: new Error(`${i18n.t("MoveInput.InvalidMove")} (${index + 1})`),
            };
        }
        pos.play(move);
        moves.push(move);
    }
    return { success: true, moves };
}

export function puzzleMoveMatches(
    pos: Chess,
    move: Move,
    expectedUci: string | undefined,
): boolean {
    const expected = parseUci(expectedUci ?? "");
    return (
        !!expected &&
        pos.isLegal(move) &&
        pos.isLegal(expected) &&
        uciNormalize(pos, move) === uciNormalize(pos, expected)
    );
}

export function getPuzzleProgress(
    puzzle: Pick<Puzzle, "fen" | "moves"> | null | undefined,
    root: TreeNode,
    position: readonly number[],
): { step: number | null; atFrontier: boolean; nextMove: NormalMove | null } {
    if (!puzzle || getBoardState(root.fen) !== getBoardState(puzzle.fen)) {
        return { step: null, atFrontier: false, nextMove: null };
    }
    let node = root;
    for (let step = 0; step < position.length; step++) {
        const child = node.children[position[step]];
        const [parent] = positionFromFen(node.fen);
        if (!child?.move || !parent || !puzzleMoveMatches(parent, child.move, puzzle.moves[step])) {
            return { step: null, atFrontier: false, nextMove: null };
        }
        node = child;
    }
    const step = position.length;
    const [pos] = positionFromFen(node.fen);
    const child = node.children[0];
    const atFrontier = !(
        pos &&
        child?.move &&
        puzzleMoveMatches(pos, child.move, puzzle.moves[step])
    );
    const move = step > 0 ? parseUci(puzzle.moves[step] ?? "") : undefined;
    const nextMove =
        pos && !pos.isEnd() && move && isNormal(move) && pos.isLegal(move) ? move : null;
    return { step, atFrontier, nextMove };
}

export function captureTreePositionOwner(
    store: Pick<TreeStore, "getState">,
    snapshot: Pick<TreeState, "root" | "position"> = store.getState(),
): () => boolean {
    const { root, position } = snapshot;
    return () => {
        const current = store.getState();
        return current.root === root && current.position === position;
    };
}

/** Native code enumerates and grants puzzle capabilities; renderer code never
 * reconstructs a database path from a directory and filename. */
export async function getPuzzleDatabases(signal?: AbortSignal): Promise<PuzzleDatabaseInfo[]> {
    return await tauri.listPuzzleDatabases({ signal });
}

export async function choosePuzzleDatabase(): Promise<FolderSwitchResult> {
    return await runFolderSwitch(() => tauri.issuePuzzleWorkspace());
}
