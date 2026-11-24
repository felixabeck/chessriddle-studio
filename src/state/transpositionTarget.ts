import { isPrefix } from "@/utils/misc";
import { getBoardState, type TreeNode } from "@/utils/treeReducer";

export type OpenMoveLine = {
    path: readonly number[];
    rootKey: string;
    moveOrder: string;
    chapter?: number;
};

export type OpenChapterOccurrence = {
    path: number[];
    hasContinuation: boolean;
};

export type FileChapterOccurrence = {
    chapter: number;
    chapterName: string;
    path: number[];
    hasContinuation: boolean;
    rootKey: string;
    moveOrder: string;
};

export type TranspositionTarget =
    | { scope: "chapter"; path: number[] }
    | { scope: "file"; chapter: number; chapterName: string; path: number[] };

/**
 * Derives the normalized root position key and SAN move sequence along `path` so the target rule
 * can reject shared move orders from the same starting position across chapters.
 */
export function getMoveLine(
    root: TreeNode,
    path: readonly number[],
): { rootKey: string; moveOrder: string } {
    const sans: string[] = [];
    let current = root;
    for (const index of path) {
        const next = current.children[index];
        if (!next) break;
        sans.push(next.san ?? "");
        current = next;
    }
    return {
        rootKey: getBoardState(root.fen),
        moveOrder: sans.join(" "),
    };
}

/**
 * Picks the transposition target for a move among occurrences in the open chapter and other
 * chapters of the same file.
 *
 * Order: the open chapter's occurrences in tree order (excluding the move's own line), then other
 * chapters by chapter number, each in tree order (excluding the open chapter's own number and
 * occurrences reached by the same moves from the same starting position).
 * Choice: the first candidate that has a continuation, else the first candidate.
 */
export function getTranspositionTarget(
    move: OpenMoveLine,
    openOccurrences: readonly OpenChapterOccurrence[],
    fileOccurrences: readonly FileChapterOccurrence[] = [],
): TranspositionTarget | undefined {
    if (move.path.length === 0) return undefined;

    let firstCandidate: TranspositionTarget | undefined;
    const movePath = [...move.path];

    for (const candidate of openOccurrences) {
        if (isPrefix(candidate.path, movePath) || isPrefix(movePath, candidate.path)) {
            continue;
        }
        const target: TranspositionTarget = { scope: "chapter", path: candidate.path };
        if (candidate.hasContinuation) return target;
        firstCandidate ??= target;
    }

    let orderedFileOccurrences = fileOccurrences;
    for (let i = 1; i < fileOccurrences.length; i++) {
        if (fileOccurrences[i].chapter < fileOccurrences[i - 1].chapter) {
            orderedFileOccurrences = [...fileOccurrences].sort((a, b) => a.chapter - b.chapter);
            break;
        }
    }

    for (const candidate of orderedFileOccurrences) {
        if (move.chapter !== undefined && candidate.chapter === move.chapter) continue;
        if (candidate.rootKey === move.rootKey && candidate.moveOrder === move.moveOrder) {
            continue;
        }
        const target: TranspositionTarget = {
            scope: "file",
            chapter: candidate.chapter,
            chapterName: candidate.chapterName,
            path: candidate.path,
        };
        if (candidate.hasContinuation) return target;
        firstCandidate ??= target;
    }

    return firstCandidate;
}
