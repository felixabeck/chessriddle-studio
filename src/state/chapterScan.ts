import { parsePGN } from "@/utils/chess";
import { getBoardState, treeIterator, type GameHeaders } from "@/utils/treeReducer";

export type ChapterPosition = {
    boardState: string;
    path: number[];
    hasContinuation: boolean;
    /** Space-separated SAN moves from the chapter root to this node (empty at root). */
    moveOrder: string;
    /** Half-move count of this node, anchored to the chapter's root FEN. */
    halfMoves: number;
    /** Move played to reach this node, or `null` at the root. */
    san: string | null;
};

export type ChapterScanResult = {
    headers: GameHeaders;
    rootKey: string;
};

/**
 * Parses one chapter PGN and visits every node in tree order, deriving its normalized position key
 * (`getBoardState`), whether it continues, and the move sequence from the chapter root. Returning
 * `false` stops visiting further nodes. The parsed tree is dropped once the scan returns.
 */
export async function scanChapterPositions(
    pgn: string,
    onPosition: (position: ChapterPosition) => boolean | void,
    options?: { signal?: AbortSignal },
): Promise<ChapterScanResult> {
    const tree = await parsePGN(
        pgn,
        undefined,
        options?.signal ? { signal: options.signal } : undefined,
    );
    const rootKey = getBoardState(tree.root.fen);
    const sans: string[] = [];
    for (const { node, position } of treeIterator(tree.root)) {
        // `treeIterator` visits in pre-order DFS, so `sans[0..depth-2]` holds the ancestor moves.
        if (position.length === 0) {
            sans.length = 0;
        } else {
            sans.length = position.length - 1;
            sans.push(node.san ?? "");
        }
        const shouldContinue = onPosition({
            boardState: getBoardState(node.fen),
            path: position,
            hasContinuation: node.children.length > 0,
            moveOrder: sans.join(" "),
            halfMoves: node.halfMoves,
            san: node.san,
        });
        if (shouldContinue === false) break;
    }
    return { headers: tree.headers, rootKey };
}
