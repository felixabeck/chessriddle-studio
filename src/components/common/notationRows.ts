import { makeUci } from "chessops";
import { splitPgnComment } from "@/utils/pgnComment";
import { getEffectiveGameEnd, isOpenVariation, type TreeNode } from "@/utils/treeReducer";

/** The largest run mounted as one notation row. */
export const NOTATION_ROW_MAX_MOVES = 32;

export type NotationMove = {
    node: TreeNode;
    first: boolean;
    startingComment?: string;
    analysis?: boolean;
    /** A diagram row follows this move and carries its comment. */
    diagram?: boolean;
    /**
     * The notation frames this move: an open variation (`isOpenVariation`) in a notation that
     * marks them (`markOpenVariations`). False for every move of a notation that does not.
     */
    openVariation: boolean;
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
    /** The node whose position the comment annotates: its move's node, or that move's parent. */
    annotatedNode: TreeNode;
};

export type VariationNotationRow = {
    type: "variation";
    depth: number;
    parent: TreeNode;
    collapsed: boolean;
    /** Side lines of `parent` hidden by a filter (e.g. opponent preparation). */
    hiddenCount?: number;
};

/** The small board of a move that carries a diagram marker, with that move's comment below. */
export type DiagramNotationRow = {
    type: "diagram";
    depth: number;
    node: TreeNode;
    comment: string;
};

export type NotationRow =
    | InlineNotationRow
    | TableNotationRow
    | CommentNotationRow
    | DiagramNotationRow
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
    showDiagrams: boolean;
    tableView: boolean;
    collapsedVariations?: ReadonlySet<string>;
    /** Side-line root nodes (`parent.children[1..n]`) hidden by a filter. */
    hiddenVariations?: ReadonlySet<TreeNode>;
    /** Flag side lines one move long: for the notation of a tree that is being built. */
    markOpenVariations?: boolean;
};

export function collapseMoveToken(node: TreeNode): string {
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

/**
 * The collapse keys of every variation toggle that can hide the move at `path`: one per side line
 * the path enters, keyed by the node that side line branches from, as `queueVariationTasks` keys it.
 * When `onlyNodes` is given, only side-line roots present in `onlyNodes` are included.
 */
export function collapseKeysOnPath(
    root: TreeNode,
    path: number[],
    onlyNodes?: ReadonlySet<TreeNode>,
): string[] {
    if (onlyNodes && onlyNodes.size === 0) return [];
    const keys: string[] = [];
    let node: TreeNode | undefined = root;
    for (let depth = 0; depth < path.length; depth += 1) {
        const childIndex = path[depth];
        const child: TreeNode | undefined = node?.children[childIndex];
        if (childIndex >= 1 && (!onlyNodes || (child !== undefined && onlyNodes.has(child)))) {
            keys.push(variationCollapseKey(root, path.slice(0, depth)));
        }
        node = child;
    }
    return keys;
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
    annotatedNode: TreeNode,
): void {
    addRow(rows, rowForNode, { type: "comment", depth, comment, annotatedNode });
}

function showsDiagram(node: TreeNode, options: NotationRowOptions): boolean {
    return options.showDiagrams && node.diagram === true;
}

function addDiagram(
    rows: NotationRow[],
    rowForNode: Map<TreeNode, number>,
    depth: number,
    node: TreeNode,
    options: NotationRowOptions,
): void {
    addRow(rows, rowForNode, {
        type: "diagram",
        depth,
        node,
        comment: options.showComments ? node.comment : "",
    });
}

/**
 * The comment row of a table-view mainline move, or its diagram row, which carries the comment.
 */
function addTableMoveNote(
    rows: NotationRow[],
    rowForNode: Map<TreeNode, number>,
    node: TreeNode,
    options: NotationRowOptions,
): void {
    if (showsDiagram(node, options)) addDiagram(rows, rowForNode, 0, node, options);
    else if (options.showComments && node.comment.length > 0)
        addComment(rows, rowForNode, 0, node.comment, node);
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
    const hiddenVariations = options.hiddenVariations;
    let hiddenCount = 0;
    const visibleChildren: number[] = [];
    for (let childIndex = 1; childIndex < parent.children.length; childIndex += 1) {
        if (hiddenVariations?.has(parent.children[childIndex])) {
            hiddenCount += 1;
        } else {
            visibleChildren.push(childIndex);
        }
    }
    const row: VariationNotationRow = {
        type: "variation",
        depth,
        parent,
        collapsed,
    };
    if (hiddenCount > 0) row.hiddenCount = hiddenCount;
    addRow(rows, rowForNode, row);
    if (collapsed) return;
    for (let index = visibleChildren.length - 1; index >= 0; index -= 1) {
        stack.push({
            parent,
            childIndex: visibleChildren[index],
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
            const diagram = showsDiagram(node, options);
            moves.push({
                node,
                first: first || !!starting,
                startingComment: starting,
                analysis: options.analysisNodes.has(node),
                diagram,
                openVariation:
                    options.markOpenVariations === true && isOpenVariation(parent, childIndex),
            });
            first = false;

            const variationParent = parent;
            const hasVariations =
                options.showVariations && childIndex === 0 && variationParent.children.length > 1;
            const reachedLimit = moves.length >= NOTATION_ROW_MAX_MOVES;

            const isGameEnd = node === options.gameEnd;
            if (hasVariations || reachedLimit || isGameEnd || diagram) {
                addRow(rows, rowForNode, {
                    type: "moves",
                    depth: task.depth,
                    moves: moves.splice(0),
                    variationParent: task.variationParent,
                });
                // Directly below its move, before that move's alternatives.
                if (diagram) addDiagram(rows, rowForNode, task.depth, node, options);

                if (node.children.length > 0) {
                    stack.push({
                        parent: node,
                        childIndex: 0,
                        depth: task.depth,
                        first: hasVariations || diagram,
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
        // Table rows hold main-line moves only, and a continuation is never an open variation.
        white: white
            ? {
                  node: white,
                  first: true,
                  analysis: options.analysisNodes.has(white),
                  openVariation: false,
              }
            : null,
        black: black
            ? {
                  node: black,
                  first: true,
                  analysis: options.analysisNodes.has(black),
                  openVariation: false,
              }
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
        if (childStarting) addComment(rows, rowForNode, 0, childStarting, current);

        if (!isWhite) {
            const hasVariations = options.showVariations && variations.length > 0;
            addTableRow(rows, rowForNode, moveNumber, null, child, false, options);
            addTableMoveNote(rows, rowForNode, child, options);
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
        const whiteHasNote =
            (options.showComments && child.comment.length > 0) || showsDiagram(child, options);
        const whiteHasVariations = options.showVariations && variations.length > 0;
        const blackHasVariations = options.showVariations && blackVariations.length > 0;
        const blackStarting = black ? startingCommentText(black, options) : "";
        const whiteBoundary =
            whiteHasNote ||
            whiteHasVariations ||
            blackStarting.length > 0 ||
            child === options.gameEnd;
        if (whiteBoundary) {
            addTableRow(rows, rowForNode, moveNumber, child, null, !!black, options);
            addTableMoveNote(rows, rowForNode, child, options);
            if (whiteHasVariations) addInlineVariationRows(rows, rowForNode, current, 0, options);
            if (child === options.gameEnd)
                addRow(rows, rowForNode, {
                    type: "gameEnd",
                    hasAnalysis: child.children.length > 0,
                });

            if (black) {
                if (blackStarting) addComment(rows, rowForNode, 0, blackStarting, child);
                addTableRow(rows, rowForNode, moveNumber, null, black, false, options);
                addTableMoveNote(rows, rowForNode, black, options);
                if (blackHasVariations) addInlineVariationRows(rows, rowForNode, child, 0, options);
            }
        } else {
            addTableRow(rows, rowForNode, moveNumber, child, black, false, options);
            if (black) addTableMoveNote(rows, rowForNode, black, options);
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

    if (showsDiagram(root, options)) {
        addDiagram(rows, rowForNode, 0, root, options);
    } else if (options.showComments && root.comment.length > 0) {
        addComment(rows, rowForNode, 0, root.comment, root);
    }

    if (options.tableView) {
        appendTableRows(rows, rowForNode, root, buildOptions);
    } else {
        appendMainlineInlineRows(rows, rowForNode, root, buildOptions);
    }

    return { rows, index, rowForNode };
}
