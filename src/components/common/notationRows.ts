import { makeUci } from "chessops";
import { splitPgnComment } from "@/utils/pgnComment";
import { getEffectiveGameEnd, type TreeNode } from "@/utils/treeReducer";

/** The largest run mounted as one notation row. */
export const NOTATION_ROW_MAX_MOVES = 32;

export type NotationMove = {
    node: TreeNode;
    first: boolean;
    startingComment?: string;
    analysis?: boolean;
};

export type InlineNotationRow = {
    type: "moves";
    depth: number;
    moves: NotationMove[];
    variationParent?: TreeNode;
};

export type TableNotationRow = {
    type: "table";
    moveNumber: number;
    white: NotationMove | null;
    black: NotationMove | null;
    splitRow: boolean;
};

export type CommentNotationRow = {
    type: "comment";
    depth: number;
    comment: string;
};

export type VariationNotationRow = {
    type: "variation";
    depth: number;
    parent: TreeNode;
    collapsed: boolean;
};

export type NotationRow =
    | InlineNotationRow
    | TableNotationRow
    | CommentNotationRow
    | VariationNotationRow
    | GameEndNotationRow;

export type GameEndNotationRow = {
    type: "gameEnd";
    hasAnalysis: boolean;
};

export type NodeLink = {
    parent: TreeNode | null;
    index: number;
};

/**
 * The tree index stores parent links, not paths. A path is derived when an action targets a
 * mounted move, and when a variation collapse key walks the move sequence from the root.
 */
export type NotationNodeIndex = {
    root: TreeNode;
    links: WeakMap<TreeNode, NodeLink>;
};

export type NotationRows = {
    rows: NotationRow[];
    index: NotationNodeIndex;
    rowForNode: Map<TreeNode, number>;
};

export type NotationRowOptions = {
    showVariations: boolean;
    showComments: boolean;
    tableView: boolean;
    collapsedVariations?: ReadonlySet<string>;
};

function collapseMoveToken(node: TreeNode): string {
    return node.san ?? (node.move ? makeUci(node.move) : "");
}

/**
 * Identity of a variation parent across sibling reorder: SAN (or UCI) of each node from the root
 * along `path`, joined by spaces. The root path is "". A deleted line no longer matches.
 */
export function variationCollapseKey(root: TreeNode, path: number[]): string {
    const tokens: string[] = [];
    let node = root;
    for (const index of path) {
        const child = node.children[index];
        if (child === undefined) break;
        tokens.push(collapseMoveToken(child));
        node = child;
    }
    return tokens.join(" ");
}

type InlineTask = {
    parent: TreeNode;
    childIndex: number;
    depth: number;
    first: boolean;
    variationParent?: TreeNode;
};

type RowBuildOptions = NotationRowOptions & {
    gameEnd?: TreeNode;
    analysisNodes: WeakSet<TreeNode>;
    index: NotationNodeIndex;
    collapseKeys: Map<TreeNode, string>;
};

type RowTask = InlineTask | GameEndNotationRow;

export function createNotationNodeIndex(root: TreeNode): NotationNodeIndex {
    const links = new WeakMap<TreeNode, NodeLink>();
    links.set(root, { parent: null, index: -1 });

    const stack: { node: TreeNode; parent: TreeNode; index: number }[] = [];
    for (let index = root.children.length - 1; index >= 0; index -= 1) {
        stack.push({ node: root.children[index], parent: root, index });
    }

    while (stack.length > 0) {
        const item = stack.pop()!;
        links.set(item.node, { parent: item.parent, index: item.index });
        for (let index = item.node.children.length - 1; index >= 0; index -= 1) {
            stack.push({ node: item.node.children[index], parent: item.node, index });
        }
    }

    return { root, links };
}

export function pathForNotationNode(
    index: NotationNodeIndex,
    node: TreeNode,
): number[] | undefined {
    if (node === index.root) return [];

    const path: number[] = [];
    let current: TreeNode | null = node;
    while (current && current !== index.root) {
        const link = index.links.get(current);
        if (!link || link.parent === null) return undefined;
        path.push(link.index);
        current = link.parent;
    }

    if (current !== index.root) return undefined;
    path.reverse();
    return path;
}

function addRow(rows: NotationRow[], rowForNode: Map<TreeNode, number>, row: NotationRow): void {
    const rowIndex = rows.length;
    rows.push(row);

    if (row.type === "moves") {
        for (const move of row.moves) rowForNode.set(move.node, rowIndex);
    } else if (row.type === "table") {
        if (row.white) rowForNode.set(row.white.node, rowIndex);
        if (row.black) rowForNode.set(row.black.node, rowIndex);
    }
}

function addComment(
    rows: NotationRow[],
    rowForNode: Map<TreeNode, number>,
    depth: number,
    comment: string,
): void {
    addRow(rows, rowForNode, { type: "comment", depth, comment });
}

/**
 * The prose of a comment that precedes a move: a variation's opening comment, which stays on its
 * move when the variation is promoted. Commands are never shown.
 */
function startingCommentText(node: TreeNode, options: NotationRowOptions): string {
    if (!options.showComments || !node.startingComment) return "";
    return splitPgnComment(node.startingComment).text;
}

function addInlineVariationRows(
    rows: NotationRow[],
    rowForNode: Map<TreeNode, number>,
    parent: TreeNode,
    depth: number,
    options: RowBuildOptions,
): void {
    const stack: RowTask[] = [];
    queueVariationTasks(rows, rowForNode, parent, depth, options, stack);
    appendInlineTasks(rows, rowForNode, stack, options);
}

function queueVariationTasks(
    rows: NotationRow[],
    rowForNode: Map<TreeNode, number>,
    parent: TreeNode,
    depth: number,
    options: RowBuildOptions,
    stack: RowTask[],
): void {
    let key = options.collapseKeys.get(parent);
    if (key === undefined) {
        const path = pathForNotationNode(options.index, parent);
        if (path !== undefined) {
            key = variationCollapseKey(options.index.root, path);
            options.collapseKeys.set(parent, key);
        }
    }
    const collapsed = key !== undefined && (options.collapsedVariations?.has(key) ?? false);
    addRow(rows, rowForNode, {
        type: "variation",
        depth,
        parent,
        collapsed,
    });
    if (collapsed) return;
    for (let childIndex = parent.children.length - 1; childIndex >= 1; childIndex -= 1) {
        stack.push({
            parent,
            childIndex,
            depth: depth + 1,
            first: true,
            variationParent: parent,
        });
    }
}

function appendInlineTasks(
    rows: NotationRow[],
    rowForNode: Map<TreeNode, number>,
    stack: RowTask[],
    options: RowBuildOptions,
): void {
    while (stack.length > 0) {
        const task = stack.pop()!;
        if ("type" in task) {
            addRow(rows, rowForNode, task);
            continue;
        }
        let parent = task.parent;
        let childIndex = task.childIndex;
        let first = task.first;
        const moves: NotationMove[] = [];

        while (parent.children[childIndex]) {
            const node = parent.children[childIndex];
            const starting = startingCommentText(node, options);
            moves.push({
                node,
                first: first || !!starting,
                startingComment: starting,
                analysis: options.analysisNodes.has(node),
            });
            first = false;

            const variationParent = parent;
            const hasVariations =
                options.showVariations && childIndex === 0 && variationParent.children.length > 1;
            const reachedLimit = moves.length >= NOTATION_ROW_MAX_MOVES;

            const isGameEnd = node === options.gameEnd;
            if (hasVariations || reachedLimit || isGameEnd) {
                addRow(rows, rowForNode, {
                    type: "moves",
                    depth: task.depth,
                    moves: moves.splice(0),
                    variationParent: task.variationParent,
                });

                if (node.children.length > 0) {
                    stack.push({
                        parent: node,
                        childIndex: 0,
                        depth: task.depth,
                        first: hasVariations,
                        variationParent: task.variationParent,
                    });
                }
                if (isGameEnd)
                    stack.push({ type: "gameEnd", hasAnalysis: node.children.length > 0 });
                if (hasVariations) {
                    queueVariationTasks(
                        rows,
                        rowForNode,
                        variationParent,
                        task.depth,
                        options,
                        stack,
                    );
                }
                break;
            }

            if (node.children.length === 0) {
                addRow(rows, rowForNode, {
                    type: "moves",
                    depth: task.depth,
                    moves: moves.splice(0),
                    variationParent: task.variationParent,
                });
                break;
            }

            parent = node;
            childIndex = 0;
        }
    }
}

function appendMainlineInlineRows(
    rows: NotationRow[],
    rowForNode: Map<TreeNode, number>,
    root: TreeNode,
    options: RowBuildOptions,
): void {
    appendInlineTasks(
        rows,
        rowForNode,
        [{ parent: root, childIndex: 0, depth: 0, first: true }],
        options,
    );
}

function addTableRow(
    rows: NotationRow[],
    rowForNode: Map<TreeNode, number>,
    moveNumber: number,
    white: TreeNode | null,
    black: TreeNode | null,
    splitRow: boolean,
    options: RowBuildOptions,
): void {
    addRow(rows, rowForNode, {
        type: "table",
        moveNumber,
        white: white
            ? { node: white, first: true, analysis: options.analysisNodes.has(white) }
            : null,
        black: black
            ? { node: black, first: true, analysis: options.analysisNodes.has(black) }
            : null,
        splitRow,
    });
}

function appendTableRows(
    rows: NotationRow[],
    rowForNode: Map<TreeNode, number>,
    root: TreeNode,
    options: RowBuildOptions,
): void {
    let current = root;

    while (current.children.length > 0) {
        const child = current.children[0];
        const isWhite = child.halfMoves % 2 === 1;
        const moveNumber = Math.ceil(child.halfMoves / 2);
        const variations = current.children.slice(1);

        const childStarting = startingCommentText(child, options);
        if (childStarting) addComment(rows, rowForNode, 0, childStarting);

        if (!isWhite) {
            const hasComment = options.showComments && child.comment.length > 0;
            const hasVariations = options.showVariations && variations.length > 0;
            addTableRow(rows, rowForNode, moveNumber, null, child, false, options);
            if (hasComment) addComment(rows, rowForNode, 0, child.comment);
            if (hasVariations) addInlineVariationRows(rows, rowForNode, current, 0, options);
            if (child === options.gameEnd)
                addRow(rows, rowForNode, {
                    type: "gameEnd",
                    hasAnalysis: child.children.length > 0,
                });
            current = child;
            continue;
        }

        const black = child.children[0]?.halfMoves % 2 === 0 ? child.children[0] : null;
        const blackVariations = black ? child.children.slice(1) : [];
        const whiteHasComment = options.showComments && child.comment.length > 0;
        const whiteHasVariations = options.showVariations && variations.length > 0;
        const blackHasComment = !!black && options.showComments && black.comment.length > 0;
        const blackHasVariations = options.showVariations && blackVariations.length > 0;
        const blackStarting = black ? startingCommentText(black, options) : "";
        const whiteBoundary =
            whiteHasComment ||
            whiteHasVariations ||
            blackStarting.length > 0 ||
            child === options.gameEnd;
        if (whiteBoundary) {
            addTableRow(rows, rowForNode, moveNumber, child, null, !!black, options);
            if (whiteHasComment) addComment(rows, rowForNode, 0, child.comment);
            if (whiteHasVariations) addInlineVariationRows(rows, rowForNode, current, 0, options);
            if (child === options.gameEnd)
                addRow(rows, rowForNode, {
                    type: "gameEnd",
                    hasAnalysis: child.children.length > 0,
                });

            if (black) {
                if (blackStarting) addComment(rows, rowForNode, 0, blackStarting);
                addTableRow(rows, rowForNode, moveNumber, null, black, false, options);
                if (blackHasComment) addComment(rows, rowForNode, 0, black.comment);
                if (blackHasVariations) addInlineVariationRows(rows, rowForNode, child, 0, options);
            }
        } else {
            addTableRow(rows, rowForNode, moveNumber, child, black, false, options);
            if (blackHasComment) addComment(rows, rowForNode, 0, black.comment);
            if (blackHasVariations) addInlineVariationRows(rows, rowForNode, child, 0, options);
        }

        if (black && black === options.gameEnd)
            addRow(rows, rowForNode, { type: "gameEnd", hasAnalysis: black.children.length > 0 });

        current = black ?? child;
    }
}

export function buildNotationRows(root: TreeNode, options: NotationRowOptions): NotationRows {
    const rows: NotationRow[] = [];
    const rowForNode = new Map<TreeNode, number>();
    const index = createNotationNodeIndex(root);
    const gameEnd = getEffectiveGameEnd(root)?.node;
    const analysisNodes = new WeakSet<TreeNode>();
    const stack = [...(gameEnd?.children ?? [])];
    while (stack.length > 0) {
        const node = stack.pop()!;
        analysisNodes.add(node);
        for (const child of node.children) stack.push(child);
    }
    const buildOptions: RowBuildOptions = {
        ...options,
        gameEnd,
        analysisNodes,
        index,
        collapseKeys: new Map(),
    };

    if (options.showComments && root.comment.length > 0) {
        addComment(rows, rowForNode, 0, root.comment);
    }

    if (options.tableView) {
        appendTableRows(rows, rowForNode, root, buildOptions);
    } else {
        appendMainlineInlineRows(rows, rowForNode, root, buildOptions);
    }

    return { rows, index, rowForNode };
}
