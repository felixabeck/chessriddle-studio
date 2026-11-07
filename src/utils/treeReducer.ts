import type { DrawShape } from "@lichess-org/chessground/draw";
import type { Move } from "chessops";
import { INITIAL_FEN, makeCastlingFen, parseFen } from "chessops/fen";
import type { Outcome, Score } from "@/bindings";
import type { PuzzleSession } from "@/state/puzzleSession";
import { positionFromFen } from "@/utils/chessops";

export interface TreeState {
    root: TreeNode;
    headers: GameHeaders;
    position: number[];
    dirty: boolean;
    sourceStamp: string | null;
    appendAttempted: boolean;
    storeAttempts?: string[];
    report: ReportState;
    puzzleSession?: PuzzleSession;
}

type BoardStateMap = Record<string, { node: TreeNode; path: number[] }[]>;

const boardStateMapCache = new WeakMap<TreeNode, { startKey: string; map: BoardStateMap }>();

export const GAME_END_COMMAND = "gameend";
export const GAME_END_PROSE = "Game ended here";
// Match the lexer's text bound so every parsed termination can survive tab hydration.
export const MAX_GAME_END_TERMINATION_LENGTH = 10 * 1024 * 1024;

export interface TreeNode {
    fen: string;
    move: Move | null;
    san: string | null;
    children: TreeNode[];
    score: Score | null;
    depth: number | null;
    halfMoves: number;
    shapes: DrawShape[];
    nags: number[];
    comment: string;
    /** Embedded `[%…]` commands the tree does not model, verbatim. */
    commands?: string;
    /** A variation's comment that precedes its first move, verbatim (commands included). */
    startingComment?: string;
    clock?: number;
    gameEnd?: { termination?: string };
}

export type ListNode = {
    position: number[];
    node: TreeNode;
};

export type EffectiveGameEnd = ListNode & {
    node: TreeNode & { gameEnd: NonNullable<TreeNode["gameEnd"]> };
};

export function* treeIterator(node: TreeNode): Generator<ListNode> {
    const stack: ListNode[] = [{ position: [], node }];
    while (stack.length > 0) {
        const { position, node } = stack.pop()!;
        yield { position, node };
        for (let i = node.children.length - 1; i >= 0; i--) {
            stack.push({ position: [...position, i], node: node.children[i] });
        }
    }
}

/**
 * Resolves a position in a repertoire tree. `[]` is deliberately reserved for
 * the root node; callers must treat `undefined` as a removed or unknown card.
 */
export function findFen(fen: string, node: TreeNode): number[] | undefined {
    const iterator = treeIterator(node);
    for (const item of iterator) {
        if (item.node.fen === fen) {
            return item.position;
        }
    }
    return undefined;
}

export function* treeIteratorMainLine(node: TreeNode): Generator<ListNode> {
    let currentNode: TreeNode | undefined = node;
    let position: number[] = [];
    while (currentNode) {
        yield { position, node: currentNode };
        currentNode = currentNode.children[0];
        position = [...position, 0];
    }
}

/** The first marked mainline move is the played game's boundary. Root flags are inert. */
export function getEffectiveGameEnd(root: TreeNode): EffectiveGameEnd | undefined {
    let node: TreeNode | undefined = root.children[0];
    let depth = 1;
    while (node) {
        if (node.gameEnd) {
            return { position: Array<number>(depth).fill(0), node } as EffectiveGameEnd;
        }
        node = node.children[0];
        depth++;
    }
    return undefined;
}

export function getEffectiveTermination(
    tree: Pick<TreeState, "root" | "headers">,
): string | undefined {
    return (
        getEffectiveGameEnd(tree.root)?.node.gameEnd.termination ?? tree.headers.other?.Termination
    );
}

/** Apply only once final load headers are known, never during persisted-tab hydration. */
export function applyGameEndLoadDefault(tree: TreeState): TreeState {
    let endNode: EffectiveGameEnd["node"] | undefined = getEffectiveGameEnd(tree.root)?.node;
    if (!endNode && tree.headers.result !== "*") {
        let last = tree.root;
        while (last.children[0]) {
            last = last.children[0];
        }
        if (last !== tree.root) {
            endNode = Object.assign(last, { gameEnd: {} });
        }
    }
    if (
        endNode &&
        endNode.gameEnd.termination === undefined &&
        tree.headers.other?.Termination !== undefined
    ) {
        endNode.gameEnd = { termination: tree.headers.other.Termination };
        delete tree.headers.other.Termination;
    }
    return tree;
}

export function sanitizeGameEndTermination(text: string): string {
    return text
        .replace(/[\]{}\r\n]/g, " ")
        .slice(0, MAX_GAME_END_TERMINATION_LENGTH)
        .trim();
}

export function countMainPly(node: TreeNode): number {
    let count = 0;
    let cur = node;
    while (cur.children.length > 0) {
        count++;
        cur = cur.children[0];
    }
    return count;
}

export function normalizeFen(fen?: string): string {
    return fen?.trim() || INITIAL_FEN;
}

export function defaultTree(fen?: string): TreeState {
    const normalizedFen = normalizeFen(fen);

    return {
        dirty: false,
        sourceStamp: null,
        appendAttempted: false,
        position: [],
        root: {
            fen: normalizedFen,
            move: null,
            san: null,
            children: [],
            score: null,
            depth: null,
            halfMoves: rootHalfMoves(normalizedFen),
            shapes: [],
            nags: [],
            comment: "",
        },
        headers: {
            id: 0,
            fen: normalizedFen,
            black: "",
            white: "",
            result: "*",
            event: "",
            site: "",
        },
        report: {
            inProgress: false,
            operationId: null,
        },
    };
}

export function rootHalfMoves(fen: string): number {
    return parseFen(fen).unwrap(
        (setup) => (setup.fullmoves - 1) * 2 + (setup.turn === "black" ? 1 : 0),
        () => 0,
    );
}

export function normalizeTreeHalfMoves(root: TreeNode): void {
    const initial = rootHalfMoves(root.fen);
    for (const { node, position } of treeIterator(root)) {
        node.halfMoves = initial + position.length;
    }
}

export function createNode({
    fen,
    move,
    san,
    halfMoves,
    clock,
}: {
    move: Move;
    san: string;
    fen: string;
    halfMoves: number;
    clock?: number;
}): TreeNode {
    return {
        fen,
        move,
        san,
        clock: clock === undefined ? undefined : clock / 1000,
        children: [],
        score: null,
        depth: null,
        halfMoves,
        shapes: [],
        nags: [],
        comment: "",
    };
}

export type GameHeaders = {
    id: number;
    fen: string;
    event: string;
    site: string;
    date?: string | null;
    time?: string | null;
    round?: string | null;
    white: string;
    white_elo?: number | null;
    black: string;
    black_elo?: number | null;
    result: Outcome;
    time_control?: string | null;
    white_time_control?: string | null;
    black_time_control?: string | null;
    eco?: string | null;
    variant?: string | null;
    other?: Record<string, string>;
    // Repertoire headers
    start?: number[];
    orientation?: "white" | "black";
};

export function getGameName(headers: GameHeaders) {
    if ((headers.white && headers.white !== "?") || (headers.black && headers.black !== "?")) {
        return `${headers.white} - ${headers.black}`;
    }
    if (headers.event) {
        return headers.event;
    }
    return "Unknown";
}

export const getNodeAtPath = (node: TreeNode, path: number[]): TreeNode => {
    let currentNode = node;
    for (const index of path) {
        if (!currentNode.children || index >= currentNode.children.length) {
            return currentNode;
        }
        currentNode = currentNode.children[index];
    }
    return currentNode;
};

type PathWalkNode = { readonly children: readonly PathWalkNode[] };

// Number.isSafeInteger already rejects non-numbers; this only lets TypeScript see that.
const isSafeIndex = (value: unknown): value is number => Number.isSafeInteger(value);

/**
 * Returns how many leading indices of an untrusted path resolve to nodes in this tree. Only the
 * child links are read, so an in-memory tree and a freshly parsed persisted one both qualify.
 */
export function getResolvedPathLength(root: PathWalkNode, path: readonly unknown[]): number {
    let currentNode = root;
    let resolvedLength = 0;
    for (const index of path) {
        if (!isSafeIndex(index) || index < 0 || index >= currentNode.children.length) {
            return resolvedLength;
        }
        currentNode = currentNode.children[index];
        resolvedLength += 1;
    }
    return resolvedLength;
}

export function buildTranspositionMaps(root: TreeNode, startPath: number[] = []): BoardStateMap {
    const map: BoardStateMap = {};
    const startNode = getNodeAtPath(root, startPath);

    const stack: { node: TreeNode; path: number[] }[] = [
        {
            node: startNode,
            path: [...startPath],
        },
    ];
    while (stack.length > 0) {
        const { node, path } = stack.pop()!;
        const boardFen = getBoardState(node.fen);
        if (!map[boardFen]) map[boardFen] = [];
        map[boardFen].push({ node, path });
        for (let i = node.children.length - 1; i >= 0; i -= 1) {
            stack.push({ node: node.children[i], path: [...path, i] });
        }
    }
    return map;
}

/** A small testable seam for the memoized derivation; callers should use getMemoizedBoardStateMap. */
export const boardStateMapBuilder = {
    build: (root: TreeNode, startPath: number[]): BoardStateMap =>
        buildTranspositionMaps(root, startPath),
};

/**
 * Lazily derives the repertoire map for the current root and start path. Roots are weakly keyed,
 * so an edited tree releases its old map when the old Immer tree is no longer referenced.
 */
export function getMemoizedBoardStateMap(root: TreeNode, startPath: number[] = []): BoardStateMap {
    const startKey = startPath.join(",");
    const cached = boardStateMapCache.get(root);
    if (cached?.startKey === startKey) return cached.map;

    const map = boardStateMapBuilder.build(root, startPath);
    boardStateMapCache.set(root, { startKey, map });
    return map;
}

export interface ReportState {
    inProgress: boolean;
    operationId: string | null;
}

export function getBoardState(fen: string): string {
    const fields = fen.split(/[\s_]+/).slice(0, 4);
    if ((fields[2] && fields[2] !== "-") || (fields[3] && fields[3] !== "-")) {
        const [position] = positionFromFen(fen);
        // Compare actual rights through the library, retaining raw fields for rejected positions.
        if (position) {
            const setup = position.toSetup();
            fields[2] = makeCastlingFen(setup.board, setup.castlingRights);
            if (fields[3] && setup.epSquare === undefined) fields[3] = "-";
        }
    }
    return fields.join(" ");
}
