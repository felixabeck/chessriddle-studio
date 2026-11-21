import type { GameHeaders, TreeNode } from "@/utils/treeReducer";

/** The editable document at one point in time. Immer shares unchanged subtrees between snapshots. */
export type TreeSnapshot = {
    root: TreeNode;
    headers: GameHeaders;
    position: number[];
    documentId: number;
};

/**
 * Undo/redo for one tab's game. Session-only: never persisted, and replaced with an empty history
 * whenever another document is installed in the store.
 */
export type TreeHistory = {
    past: readonly TreeSnapshot[];
    future: readonly TreeSnapshot[];
    /** Consecutive edits recorded with the same key merge into one step (typing in one comment). */
    mergeKey: string | null;
};

/** Steps kept per tab. The oldest step is dropped beyond it. */
export const TREE_HISTORY_LIMIT = 100;

export const EMPTY_TREE_HISTORY: TreeHistory = { past: [], future: [], mergeKey: null };

function treeSnapshot(state: TreeSnapshot): TreeSnapshot {
    return {
        root: state.root,
        headers: state.headers,
        position: state.position,
        documentId: state.documentId,
    };
}

/**
 * The header fields whose values differ, sorted. Board orientation is a view choice stored in the
 * headers, so flipping the board is never an undoable edit and is left out.
 */
export function editedHeaderFields(a: GameHeaders, b: GameHeaders): string[] {
    if (a === b) return [];
    return [...new Set([...Object.keys(a), ...Object.keys(b)])]
        .filter(
            (key) =>
                key !== "orientation" &&
                a[key as keyof GameHeaders] !== b[key as keyof GameHeaders],
        )
        .sort();
}

/**
 * Whether an action edited the document: a new tree (Immer copies it on any node change) or an
 * edited header field. Cursor position, document identity and board orientation do not count.
 */
export function documentChanged(before: TreeSnapshot, after: TreeSnapshot): boolean {
    return (
        before.root !== after.root || editedHeaderFields(before.headers, after.headers).length > 0
    );
}

/** The history after an edit that turned `before` into the current document. */
export function recordEdit(
    history: TreeHistory,
    before: TreeSnapshot,
    mergeKey: string | null,
): TreeHistory {
    if (mergeKey !== null && mergeKey === history.mergeKey && history.future.length === 0) {
        return history;
    }
    const past = [...history.past, treeSnapshot(before)];
    return {
        past: past.length > TREE_HISTORY_LIMIT ? past.slice(-TREE_HISTORY_LIMIT) : past,
        future: [],
        mergeKey,
    };
}

/**
 * Takes the newest step of `past` (undo) or `future` (redo) and files `current` on the other
 * side. Returns the snapshot to restore and the new history, or null with nothing to step to.
 */
export function stepHistory(
    history: TreeHistory,
    current: TreeSnapshot,
    direction: "undo" | "redo",
): { restore: TreeSnapshot; history: TreeHistory } | null {
    const source = direction === "undo" ? history.past : history.future;
    const restore = source.at(-1);
    if (!restore) return null;
    const remaining = source.slice(0, -1);
    const target = direction === "undo" ? history.future : history.past;
    const pushed = [...target, treeSnapshot(current)];
    return {
        restore,
        history:
            direction === "undo"
                ? { past: remaining, future: pushed, mergeKey: null }
                : { past: pushed, future: remaining, mergeKey: null },
    };
}
