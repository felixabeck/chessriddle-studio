import { makeFen } from "chessops/fen";
import { parsePgn } from "chessops/pgn";
import { makeSanAndPlay, parseSan } from "chessops/san";
import type { NormalizedGame } from "@/bindings";
import { positionFromFen } from "@/utils/chessops";
import { type NumberedMove, numberMoves } from "@/utils/format";
import { getBoardState, normalizeFen, rootHalfMoves } from "@/utils/treeReducer";

const PREVIEW_MAX_PLIES = 8;

export type GameNotationPart = NumberedMove;

export type GameNotationPreview = {
    preview: GameNotationPart[];
    full: GameNotationPart[];
    hasMore: boolean;
};

const EMPTY_NOTATION: GameNotationPreview = {
    preview: [],
    full: [],
    hasMore: false,
};

/**
 * Extracts the mainline continuation of `game` from `targetFen` (or from `game.fen` when
 * `targetFen` is absent or not reached in the legal prefix), returning up to 8 preview plies and
 * the full continuation for hover display. Returns an empty preview when `game.fen` is invalid,
 * no legal moves follow, or `targetFen` matches the game's final position.
 */
export function gameNotationPreview(
    game: Pick<NormalizedGame, "fen" | "moves">,
    targetFen?: string,
): GameNotationPreview {
    if (!game.moves?.trim()) return EMPTY_NOTATION;
    const startFen = normalizeFen(game.fen);
    const [pos] = positionFromFen(startFen);
    if (!pos) return EMPTY_NOTATION;

    let parsed;
    try {
        parsed = parsePgn(game.moves)[0];
    } catch {
        return EMPTY_NOTATION;
    }
    if (!parsed) return EMPTY_NOTATION;

    const startHalfMoves = rootHalfMoves(startFen);
    const targetBoardState =
        targetFen !== undefined ? getBoardState(normalizeFen(targetFen)) : undefined;

    let anchorIndex =
        targetBoardState !== undefined && getBoardState(startFen) === targetBoardState ? 0 : -1;
    const moves: string[] = [];

    for (const node of parsed.moves.mainline()) {
        const move = parseSan(pos, node.san);
        if (!move) break;
        const san = makeSanAndPlay(pos, move);
        moves.push(san);
        if (
            targetBoardState !== undefined &&
            anchorIndex === -1 &&
            getBoardState(makeFen(pos.toSetup())) === targetBoardState
        ) {
            anchorIndex = moves.length;
        }
    }

    if (moves.length === 0) return EMPTY_NOTATION;

    const startIndex = targetBoardState !== undefined && anchorIndex !== -1 ? anchorIndex : 0;
    const continuation = moves.slice(startIndex);
    if (continuation.length === 0) return EMPTY_NOTATION;

    const full = numberMoves(continuation, startHalfMoves + startIndex);
    const preview = full.slice(0, PREVIEW_MAX_PLIES);
    return {
        preview,
        full,
        hasMore: full.length > PREVIEW_MAX_PLIES,
    };
}
