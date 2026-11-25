import { INITIAL_FEN } from "chessops/fen";
import type { PositionStats } from "@/bindings";
import type { FileMetadata } from "@/components/files/file";
import type {
    IndexedRepertoireChapter,
    IndexedRepertoireFile,
    RepertoireChapterNode,
} from "@/state/repertoireIndex";
import { type LineTitle, lineTitleOf } from "@/utils/lineTitle";
import { dateOrderKey } from "@/utils/pgnDate";
import { isUserToMove } from "@/utils/practiceScope";
import { mergePositionStats } from "@/utils/repertoire";
import { getBoardState, type TreeNode } from "@/utils/treeReducer";

export type PreparationColor = "white" | "black";
export type PreparationSource = "otb" | "online" | "both";

/** `getBoardState` key of the standard chess starting position. */
export const INITIAL_BOARD_STATE = getBoardState(INITIAL_FEN);

export type PreparationLine = {
    workspaceKey: string;
    file: FileMetadata;
    chapter: number;
    chapterTitle: LineTitle;
    path: number[];
    boardState: string;
    /** SAN sequence from the chapter root to this node (empty at root). */
    moves: readonly string[];
    games: number;
    lastPlayed: string | null;
};

export type PreparationGap = {
    workspaceKey: string;
    file: FileMetadata;
    chapter: number;
    chapterTitle: LineTitle;
    path: number[];
    boardState: string;
    /** SAN sequence from the chapter root to this position (empty at root). */
    moves: readonly string[];
    /** Opponent's SAN move that no indexed chapter of the user's colour covers. */
    move: string;
    games: number;
    lastPlayed: string | null;
};

export type PreparationView = {
    lines: readonly PreparationLine[];
    gaps: readonly PreparationGap[];
    /** Selected games that reached the standard starting position; 0 when none. */
    total: number;
    /** Positions reached by at least one selected game (`games >= 1`). */
    playedPositions: ReadonlySet<string>;
    /** Selected games reaching each played position. */
    positionGames: ReadonlyMap<string, number>;
};

export type PreparationViews = {
    otb: PreparationView;
    online: PreparationView | null;
    both: PreparationView | null;
};

export type NodePreparationStatus = "played" | "open" | "excluded";

export type NodeClassification = {
    status: NodePreparationStatus;
    relevant: boolean;
};

export type ChapterClassification = {
    inPreparation: boolean;
    nodes: readonly NodeClassification[];
};

export type TreeClassification = {
    inPreparation: boolean;
    nodes: Map<TreeNode, NodeClassification>;
};

/** The user's colour is the opposite of the opponent's colour. */
export function userColorForOpponent(opponentColor: PreparationColor): PreparationColor {
    return opponentColor === "white" ? "black" : "white";
}

/** A missing Orientation header reads as White, as everywhere else. */
export function chapterOrientation(orientation: PreparationColor | undefined): PreparationColor {
    return orientation ?? "white";
}

/** Share of total games (`games / total`), or `null` when `total <= 0`. */
export function preparationShare(games: number, total: number): number | null {
    return total > 0 ? games / total : null;
}

/** Resolves the active `PreparationView` for a source, falling back to `otb` when absent. */
export function preparationViewForSource(
    views: PreparationViews,
    source: PreparationSource,
): PreparationView {
    if (source === "online") return views.online ?? views.otb;
    if (source === "both") return views.both ?? views.otb;
    return views.otb;
}

function rowGames(row: PositionStats): number {
    return row.white + row.draw + row.black + row.unknown;
}

/** Number of selected games that reached a position, including `"*"` and unknown results. */
export function positionStatsGames(rows: readonly PositionStats[] | undefined): number {
    if (!rows || rows.length === 0) return 0;
    let total = 0;
    for (const row of rows) total += rowGames(row);
    return total;
}

/** Latest `last_played` over all rows of a position's statistics, the `"*"` row included. */
export function positionStatsLastPlayed(rows: readonly PositionStats[] | undefined): string | null {
    if (!rows || rows.length === 0) return null;
    let best: string | null = null;
    let bestKey = "";
    for (const row of rows) {
        if (rowGames(row) <= 0) continue;
        const key = dateOrderKey(row.last_played);
        if (key > bestKey) {
            best = row.last_played;
            bestKey = key;
        }
    }
    return best;
}

/**
 * Collects every unique `getBoardState` key across chapters of the user's colour, plus the
 * standard starting position for `total`.
 */
export function collectPreparationFens(
    files: readonly IndexedRepertoireFile[],
    opponentColor: PreparationColor,
): string[] {
    const userColor = userColorForOpponent(opponentColor);
    const fens = new Set<string>([INITIAL_BOARD_STATE]);
    for (const file of files) {
        for (const chapter of file.chapters) {
            if (chapterOrientation(chapter.headers.orientation) !== userColor) continue;
            for (const node of chapter.nodes) fens.add(node.boardState);
        }
    }
    return [...fens];
}

/**
 * Combines over-the-board and online batch statistics per position and move: counts are summed
 * and the later `last_played` wins.
 */
export function combinePreparationStats(
    otb: ReadonlyMap<string, readonly PositionStats[]>,
    online: ReadonlyMap<string, readonly PositionStats[]>,
): Map<string, PositionStats[]> {
    const combined = new Map<string, PositionStats[]>();
    const keys = new Set<string>([...otb.keys(), ...online.keys()]);
    for (const fen of keys) {
        combined.set(fen, mergePositionStats([otb.get(fen), online.get(fen)]));
    }
    return combined;
}

type NodeOccurrence = {
    workspaceKey: string;
    file: FileMetadata;
    chapter: number;
    chapterTitle: LineTitle;
    nodes: readonly RepertoireChapterNode[];
    nodeIndex: number;
    fileOrder: number;
    chapterOrder: number;
};

function movesToNode(nodes: readonly RepertoireChapterNode[], nodeIndex: number): string[] {
    const reversed: string[] = [];
    let current = nodeIndex;
    while (current >= 0) {
        const node = nodes[current];
        if (node.san !== null) reversed.push(node.san);
        current = node.parent;
    }
    reversed.reverse();
    return reversed;
}

type SortKey = {
    games: number;
    lastPlayed: string | null;
    fileOrder: number;
    chapterOrder: number;
    nodeIndex: number;
};

function comparePreparationOrder(a: SortKey, b: SortKey): number {
    if (a.games !== b.games) return b.games - a.games;
    const dateA = dateOrderKey(a.lastPlayed);
    const dateB = dateOrderKey(b.lastPlayed);
    if (dateA !== dateB) return dateA < dateB ? 1 : -1;
    if (a.fileOrder !== b.fileOrder) return a.fileOrder - b.fileOrder;
    if (a.chapterOrder !== b.chapterOrder) return a.chapterOrder - b.chapterOrder;
    return a.nodeIndex - b.nodeIndex;
}

/**
 * Computes one preparation view (lines, gaps, total, played positions) from the indexed
 * repertoire files and one batch statistics map.
 */
export function computePreparationView(
    files: readonly IndexedRepertoireFile[],
    opponentColor: PreparationColor,
    stats: ReadonlyMap<string, readonly PositionStats[]>,
): PreparationView {
    const userColor = userColorForOpponent(opponentColor);
    const playedPositions = new Set<string>();
    const positionGames = new Map<string, number>();
    const positionLastPlayed = new Map<string, string | null>();

    for (const [fen, rows] of stats) {
        const games = positionStatsGames(rows);
        if (games >= 1) {
            playedPositions.add(fen);
            positionGames.set(fen, games);
            positionLastPlayed.set(fen, positionStatsLastPlayed(rows));
        }
    }

    const total = positionGames.get(INITIAL_BOARD_STATE) ?? 0;

    // First occurrence per position in file, chapter and tree order, plus global child/move sets
    // across every indexed chapter of the user's colour.
    const firstOccurrence = new Map<string, NodeOccurrence>();
    const positionsWithPlayedChild = new Set<string>();
    const coveredMovesByPosition = new Map<string, Set<string>>();
    const opponentToMovePositions = new Set<string>();

    for (let fileOrder = 0; fileOrder < files.length; fileOrder++) {
        const indexedFile = files[fileOrder];
        for (let chapterOrder = 0; chapterOrder < indexedFile.chapters.length; chapterOrder++) {
            const chapter = indexedFile.chapters[chapterOrder];
            if (chapterOrientation(chapter.headers.orientation) !== userColor) continue;
            const chapterTitle = lineTitleOf(chapter.headers);
            const { nodes } = chapter;
            for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex++) {
                const node = nodes[nodeIndex];
                if (!firstOccurrence.has(node.boardState)) {
                    firstOccurrence.set(node.boardState, {
                        workspaceKey: indexedFile.workspaceKey,
                        file: indexedFile.file,
                        chapter: chapter.chapter,
                        chapterTitle,
                        nodes,
                        nodeIndex,
                        fileOrder,
                        chapterOrder,
                    });
                }
                if (
                    playedPositions.has(node.boardState) &&
                    !isUserToMove(node.halfMoves, userColor)
                ) {
                    opponentToMovePositions.add(node.boardState);
                }
                if (node.parent >= 0) {
                    const parentBoard = nodes[node.parent].boardState;
                    if (playedPositions.has(node.boardState)) {
                        positionsWithPlayedChild.add(parentBoard);
                    }
                    if (node.san !== null) {
                        let covered = coveredMovesByPosition.get(parentBoard);
                        if (!covered) {
                            covered = new Set();
                            coveredMovesByPosition.set(parentBoard, covered);
                        }
                        covered.add(node.san);
                    }
                }
            }
        }
    }

    const rawLines: (PreparationLine & SortKey)[] = [];
    const rawGaps: (PreparationGap & SortKey)[] = [];

    for (const [boardState, occ] of firstOccurrence) {
        const games = positionGames.get(boardState);
        if (games === undefined) continue;
        const node = occ.nodes[occ.nodeIndex];
        let cachedMoves: string[] | null = null;
        const getMoves = () => (cachedMoves ??= movesToNode(occ.nodes, occ.nodeIndex));

        if (!positionsWithPlayedChild.has(boardState)) {
            rawLines.push({
                workspaceKey: occ.workspaceKey,
                file: occ.file,
                chapter: occ.chapter,
                chapterTitle: occ.chapterTitle,
                path: node.path,
                boardState,
                moves: getMoves(),
                games,
                lastPlayed: positionLastPlayed.get(boardState) ?? null,
                fileOrder: occ.fileOrder,
                chapterOrder: occ.chapterOrder,
                nodeIndex: occ.nodeIndex,
            });
        }

        if (opponentToMovePositions.has(boardState)) {
            const covered = coveredMovesByPosition.get(boardState);
            for (const row of stats.get(boardState) ?? []) {
                if (row.move === "*") continue;
                const moveGames = rowGames(row);
                if (moveGames < 1) continue;
                if (covered?.has(row.move)) continue;
                rawGaps.push({
                    workspaceKey: occ.workspaceKey,
                    file: occ.file,
                    chapter: occ.chapter,
                    chapterTitle: occ.chapterTitle,
                    path: node.path,
                    boardState,
                    moves: getMoves(),
                    move: row.move,
                    games: moveGames,
                    lastPlayed: row.last_played,
                    fileOrder: occ.fileOrder,
                    chapterOrder: occ.chapterOrder,
                    nodeIndex: occ.nodeIndex,
                });
            }
        }
    }

    rawLines.sort(comparePreparationOrder);
    rawGaps.sort(comparePreparationOrder);

    const lines: PreparationLine[] = rawLines.map(
        ({ fileOrder: _f, chapterOrder: _c, nodeIndex: _n, ...line }) => line,
    );
    const gaps: PreparationGap[] = rawGaps.map(
        ({ fileOrder: _f, chapterOrder: _c, nodeIndex: _n, ...gap }) => gap,
    );

    return {
        lines,
        gaps,
        total,
        playedPositions,
        positionGames,
    };
}

/**
 * Derives the three source views (over the board, online, both) from the two fetched statistics
 * maps without triggering any additional search.
 */
export function computePreparationViews(
    files: readonly IndexedRepertoireFile[],
    opponentColor: PreparationColor,
    otbStats: ReadonlyMap<string, readonly PositionStats[]>,
    onlineStats?: ReadonlyMap<string, readonly PositionStats[]> | null,
): PreparationViews {
    const otb = computePreparationView(files, opponentColor, otbStats);
    if (!onlineStats) {
        return { otb, online: null, both: null };
    }
    const online = computePreparationView(files, opponentColor, onlineStats);
    const both = computePreparationView(
        files,
        opponentColor,
        combinePreparationStats(otbStats, onlineStats),
    );
    return { otb, online, both };
}

function nextNodeStatus(
    isPlayed: boolean,
    parentStatus: NodePreparationStatus | null,
    parentIsUserToMove: boolean,
): NodePreparationStatus {
    if (isPlayed) return "played";
    if (parentStatus === null) return "excluded";
    if (parentStatus === "played") return parentIsUserToMove ? "open" : "excluded";
    return parentStatus;
}

/**
 * Classifies every node of an indexed chapter (played / open / excluded / relevant).
 * A chapter whose orientation is not the user's colour, or that has no played node, has
 * `inPreparation: false`.
 */
export function classifyChapterNodes(
    chapter: Pick<IndexedRepertoireChapter, "headers" | "nodes">,
    opponentColor: PreparationColor,
    playedPositions: ReadonlySet<string>,
): ChapterClassification {
    const userColor = userColorForOpponent(opponentColor);
    const { nodes } = chapter;
    if (chapterOrientation(chapter.headers.orientation) !== userColor) {
        return {
            inPreparation: false,
            nodes: nodes.map(() => ({ status: "excluded", relevant: false })),
        };
    }

    const classifications: NodeClassification[] = new Array(nodes.length);
    let inPreparation = false;

    for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        const isPlayed = playedPositions.has(node.boardState);
        if (isPlayed) inPreparation = true;
        const parentStatus = node.parent >= 0 ? classifications[node.parent].status : null;
        const parentIsUser =
            node.parent >= 0 ? isUserToMove(nodes[node.parent].halfMoves, userColor) : false;
        const status = nextNodeStatus(isPlayed, parentStatus, parentIsUser);
        classifications[i] = { status, relevant: status === "played" || status === "open" };
    }

    // Propagate relevance upward: nodes are in pre-order, so `parent < i` always holds.
    for (let i = nodes.length - 1; i >= 0; i--) {
        if (classifications[i].relevant && nodes[i].parent >= 0) {
            classifications[nodes[i].parent].relevant = true;
        }
    }

    return {
        inPreparation,
        nodes: classifications,
    };
}

/**
 * Classifies every node of a live `TreeNode` tree against the preparation's played positions, so
 * notation filtering follows live tree edits without a new search.
 */
export function classifyTreeNodes(
    root: TreeNode,
    orientation: PreparationColor | undefined,
    opponentColor: PreparationColor,
    playedPositions: ReadonlySet<string>,
): TreeClassification {
    const userColor = userColorForOpponent(opponentColor);
    const nodes = new Map<TreeNode, NodeClassification>();
    if (chapterOrientation(orientation) !== userColor) {
        const stack: TreeNode[] = [root];
        while (stack.length > 0) {
            const current = stack.pop()!;
            nodes.set(current, { status: "excluded", relevant: false });
            for (const child of current.children) stack.push(child);
        }
        return { inPreparation: false, nodes };
    }

    let inPreparation = false;
    const postOrder: { node: TreeNode; parent: TreeNode | null }[] = [];
    const stack: { node: TreeNode; parent: TreeNode | null }[] = [{ node: root, parent: null }];

    while (stack.length > 0) {
        const item = stack.pop()!;
        const { node, parent } = item;
        const isPlayed = playedPositions.has(getBoardState(node.fen));
        if (isPlayed) inPreparation = true;
        const parentStatus = parent ? nodes.get(parent)!.status : null;
        const parentIsUser = parent ? isUserToMove(parent.halfMoves, userColor) : false;
        const status = nextNodeStatus(isPlayed, parentStatus, parentIsUser);
        nodes.set(node, { status, relevant: status === "played" || status === "open" });
        postOrder.push(item);
        for (let i = node.children.length - 1; i >= 0; i--) {
            stack.push({ node: node.children[i], parent: node });
        }
    }

    for (let i = postOrder.length - 1; i >= 0; i--) {
        const { node, parent } = postOrder[i];
        if (parent && nodes.get(node)!.relevant) {
            nodes.get(parent)!.relevant = true;
        }
    }

    return {
        inPreparation,
        nodes,
    };
}
