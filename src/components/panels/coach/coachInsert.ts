import {
    getBoardState,
    getNodeAtPath,
    getResolvedPathLength,
    treeIterator,
    type TreeNode,
} from "@/utils/treeReducer";

/**
 * Where a Coach line can be inserted now. The line starts from the position its question was
 * asked about; the tree may have changed since. The remembered path is used only if it still
 * resolves completely and still leads to that position; otherwise the first node with the same
 * position is taken, and without one the line cannot be inserted.
 */
export function resolveCoachInsertPath(
    root: TreeNode,
    path: readonly number[],
    fen: string,
): number[] | null {
    const position = getBoardState(fen);
    if (
        getResolvedPathLength(root, path) === path.length &&
        getBoardState(getNodeAtPath(root, [...path]).fen) === position
    ) {
        return [...path];
    }
    for (const item of treeIterator(root)) {
        if (getBoardState(item.node.fen) === position) return item.position;
    }
    return null;
}
