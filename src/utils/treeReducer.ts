import type { DrawShape } from "@lichess-org/chessground/draw";
import type { Move } from "chessops";
import { INITIAL_FEN, makeCastlingFen, parseFen } from "chessops/fen";
import type { NoveltyOutcome, Outcome, ScoresheetLayoutBlock, Score } from "@/bindings";
import type { CoachSession } from "@/state/coachSession";
import type { BoundedGoMode } from "@/utils/engines";
import type { ReviewFact } from "@/utils/gameReview";
import type { PuzzleSession } from "@/state/puzzleSession";
import { dropInvalidEpSquare, positionFromFen } from "@/utils/chessops";

export interface ScoresheetReviewStop {
    /** 0-based sheet ply where reading stopped (number of legal plies before the first unplayable token). */
    ply: number;
    /** Sheet tokens from `ply` onward (`tokens[0]` is the token that did not fit). */
    tokens: string[];
    /** Optional per-token remaining clock times in seconds, parallel to `tokens` (`null` = absent). */
    clocks?: (number | null)[];
}

/** Where the move table sits on the photos a review was read from. */
export interface ScoresheetReviewLayout {
    /** Ids of the photos the layout belongs to; `null` when the photos could not be stored. */
    photoIds: string[] | null;
    blocks: ScoresheetLayoutBlock[];
}

export interface ScoresheetReview {
    stopped?: ScoresheetReviewStop;
    layout?: ScoresheetReviewLayout;
}

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
    /** The tab's Coach conversation. Not part of the game: never saved into a PGN. */
    coachSession?: CoachSession;
    /** Review state of a game imported from a scoresheet photo. Never saved into a PGN. */
    scoresheetReview?: ScoresheetReview;
}

type BoardStateMap = Record<string, { node: TreeNode; path: number[] }[]>;

// Keep both callers' maps (whole tree [] and chapter Start path) per root without evicting each other.
const MAX_CACHED_START_PATHS_PER_ROOT = 2;
const boardStateMapCache = new WeakMap<TreeNode, Map<string, BoardStateMap>>();
// R1(b): uncached getBoardState parses castling/EP through chessops (~81 ms vs ~6.6 ms for
// stripClock on a 10,000-node tree), so cache each node's key by object identity + FEN.
const nodeBoardStateCache = new WeakMap<TreeNode, { fen: string; boardState: string }>();

export const GAME_END_COMMAND = "gameend";
export const GAME_END_PROSE = "Game ended here";
export const REVIEW_MARK_COMMAND = "crreview";
// Match the lexer's text bound so every parsed termination can survive tab hydration.
export const MAX_GAME_END_TERMINATION_LENGTH = 10 * 1024 * 1024;

export interface TreeNode {
    fen: string;
    move: Move | null;
    san: string | null;
    children: TreeNode[];
    /** The game's own evaluation: read from the source PGN or written by a game report. Saved. */
    score: Score | null;
    depth: number | null;
    /**
     * The live engine's latest evaluation of this node. View-only: it never marks the tab unsaved
     * and is never serialized into the PGN (f-20261115-24).
     */
    engineScore?: Score;
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
    /** The notation shows a small board of this position (ChessBase's `[#]` comment marker). */
    diagram?: true;
    /**
     * First node of a better line a game report added. Session and tab storage only: never
     * written to PGN, so a saved and reopened line is an ordinary variation.
     */
    reportLine?: true;
    /**
     * Move flagged for review during a scoresheet photo import. Session and tab storage only:
     * never written to PGN, and only active while `scoresheetReview` is present.
     */
    unsure?: true;
    /**
     * Imported repertoire move that conflicts with an existing reply for the repertoire's side.
     * Persisted as `[%crreview]` in PGN and in tab storage until cleared.
     */
    reviewMark?: true;
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
        const last = getMainlineEndNode(tree.root);
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

/**
 * The one spelling a root FEN is installed with: trimmed, and without an en-passant square
 * the engine, game report and database would reject (f-20261115-25).
 */
export function normalizeFen(fen?: string): string {
    const trimmed = fen?.trim();
    return trimmed ? dropInvalidEpSquare(trimmed) : INITIAL_FEN;
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

/**
 * Where a position (a `getBoardState` key) is in the tree now. The tree may have changed since
 * `path` was remembered, so the path is used only if it still resolves completely and still leads
 * to that position; otherwise the first node with the position is taken. `accept` narrows which
 * nodes count. `null` when the tree has none.
 */
export function locateBoardState(
    root: TreeNode,
    path: readonly number[],
    boardState: string,
    accept: (node: TreeNode) => boolean = () => true,
): { node: TreeNode; position: number[] } | null {
    const matches = (node: TreeNode) => getBoardState(node.fen) === boardState && accept(node);
    if (getResolvedPathLength(root, path) === path.length) {
        const node = getNodeAtPath(root, [...path]);
        if (matches(node)) return { node, position: [...path] };
    }
    for (const item of treeIterator(root)) {
        if (matches(item.node)) return { node: item.node, position: item.position };
    }
    return null;
}

export function normalizeTreeHalfMoves(root: TreeNode): void {
    const initial = rootHalfMoves(root.fen);
    for (const { node, position } of treeIterator(root)) {
        node.halfMoves = initial + position.length;
    }
}

/** The evaluation to show for a node: the live engine's when present, otherwise the game's. */
export function displayedScore(node: TreeNode): Score | null {
    return node.engineScore ?? node.score;
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

/** The last node of the unique children[0] mainline, which is `root` when it has no moves. */
export function getMainlineEndNode(root: TreeNode): TreeNode {
    let node = root;
    while (node.children.length > 0) node = node.children[0];
    return node;
}

/**
 * A side line that stops after its first move: an alternative (never `children[0]`, the
 * continuation) with nothing below it. Its comment, NAGs and evaluation do not enter into it.
 */
export function isOpenVariation(parent: TreeNode, childIndex: number): boolean {
    return childIndex >= 1 && parent.children[childIndex]?.children.length === 0;
}

/**
 * The path of the first open variation after the cursor in notation order, wrapping to the first
 * one in the tree, or null when the tree has none. Notation order prints a move, then each of its
 * alternatives with everything below it, then the move's own continuation.
 */
export function nextOpenVariation(root: TreeNode, position: number[]): number[] | null {
    const cursor = getNodeAtPath(root, position);
    // Root is never popped as a child; wrapping from an unpassed cursor is the first open variation.
    let passedCursor = false;
    let first: number[] | null = null;
    const pending: { parent: TreeNode; index: number; path: number[] }[] = [];
    const queueChildren = (parent: TreeNode, path: number[]) => {
        if (parent.children.length === 0) return;
        // Stack order: pushed first, so popped last. What stands below the continuation is
        // printed after every alternative and everything below those.
        pending.push({ parent, index: 0, path: [...path, 0] });
        for (let index = parent.children.length - 1; index >= 1; index -= 1) {
            pending.push({ parent, index, path: [...path, index] });
        }
        // Notation order: the continuation move itself is printed before its alternatives, so a
        // cursor on it is already passed when they are visited.
        if (parent.children[0] === cursor) passedCursor = true;
    };

    queueChildren(root, []);
    while (pending.length > 0) {
        const { parent, index, path } = pending.pop()!;
        const node = parent.children[index];
        if (isOpenVariation(parent, index)) {
            if (passedCursor) return path;
            first ??= path;
        }
        if (node === cursor) passedCursor = true;
        queueChildren(node, path);
    }
    return first;
}

/**
 * The path to the first mainline node (the root included) that has the same position as the
 * earliest-listed of `fens` the mainline reaches, or null. The list is in order of preference.
 * Database games are stored and searched as a mainline, so variations are not walked.
 */
export function findMainlinePath(root: TreeNode, fens: readonly string[]): number[] | null {
    const reached = new Map<string, number[]>();
    for (const { position, node } of treeIteratorMainLine(root)) {
        const board = getBoardState(node.fen);
        if (!reached.has(board)) reached.set(board, position);
    }
    for (const fen of fens) {
        const path = reached.get(getBoardState(fen));
        if (path) return path;
    }
    return null;
}

/**
 * A new tree whose mainline is the unique path from `root` to `position`. Sibling variations,
 * comments, NAGs, shapes and scores are dropped. The cursor sits at the end of that line.
 */
export function lineToTree(
    root: TreeNode,
    orientation: GameHeaders["orientation"],
    position: number[],
): TreeState {
    const tree = defaultTree(root.fen);
    tree.headers.orientation = orientation;
    let dest = tree.root;
    const resolvedLength = getResolvedPathLength(root, position);
    const mainline: number[] = [];
    for (let depth = 1; depth <= resolvedLength; depth++) {
        const source = getNodeAtPath(root, position.slice(0, depth));
        if (source.move === null || source.san === null) break;
        const copy = createNode({
            fen: source.fen,
            move: source.move,
            san: source.san,
            halfMoves: source.halfMoves,
        });
        dest.children = [copy];
        dest = copy;
        mainline.push(0);
    }
    tree.position = mainline;
    return tree;
}

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

/**
 * Whether the move at `path` can carry a comment in front of it. PGN keeps one comment slot
 * between two moves of a line, so a separate "before" comment exists only where a move opens a
 * variation: it is an alternative to its parent's main continuation. A move that already carries
 * one (a promoted variation) stays editable so the comment can be changed or cleared.
 */
export function acceptsStartingComment(root: TreeNode, path: readonly number[]): boolean {
    if (path.length === 0 || getResolvedPathLength(root, path) !== path.length) return false;
    return path[path.length - 1] > 0 || !!getNodeAtPath(root, [...path]).startingComment;
}

function getNodeBoardState(node: TreeNode): string {
    const cached = nodeBoardStateCache.get(node);
    if (cached && cached.fen === node.fen) return cached.boardState;
    const boardState = getBoardState(node.fen);
    nodeBoardStateCache.set(node, { fen: node.fen, boardState });
    return boardState;
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
        const boardFen = getNodeBoardState(node);
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
 * Up to two start paths are retained per root so the notation (whole tree) and practice/Next-key
 * callers (`headers.start`) do not evict each other.
 */
export function getMemoizedBoardStateMap(root: TreeNode, startPath: number[] = []): BoardStateMap {
    const startKey = startPath.join(",");
    let byStart = boardStateMapCache.get(root);
    const cached = byStart?.get(startKey);
    if (cached) {
        byStart!.delete(startKey);
        byStart!.set(startKey, cached);
        return cached;
    }

    const map = boardStateMapBuilder.build(root, startPath);
    if (!byStart) {
        byStart = new Map();
        boardStateMapCache.set(root, byStart);
    }
    byStart.set(startKey, map);
    if (byStart.size > MAX_CACHED_START_PATHS_PER_ROOT) {
        const oldest = byStart.keys().next().value!;
        byStart.delete(oldest);
    }
    return map;
}

/** What produced the report currently written on the tree, and which game it describes. */
export interface ReportSummary {
    engine: string;
    goMode: BoundedGoMode;
    /** Milliseconds since the epoch. */
    createdAt: number;
    /** Positions the engine could not evaluate (neither evaluated nor terminal). */
    missingEvaluations: number;
    novelty: NoveltyOutcome["kind"];
    /** `reportRootFingerprint` of the root FEN and mainline the report describes. */
    fingerprint: string;
    /** Review facts for mainline mistakes (`?!`, `?`, `??`), capped at `MAX_REVIEW_FACTS`. */
    facts?: ReviewFact[];
}

export interface ReportState {
    inProgress: boolean;
    operationId: string | null;
    summary?: ReportSummary | null;
}

export function getBoardState(fen: string): string {
    // Same field separators chessops parseFen accepts (whitespace runs and "_").
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

export interface ScoresheetRemaining {
    /** 0-based sheet ply of the next remaining token. */
    nextPly: number;
    /** 1-based move number of the next remaining token, anchored to `rootHalfMoves`. */
    moveNumber: number;
    /** Side to move of the next remaining token, anchored to `rootHalfMoves`. */
    color: "white" | "black";
    /** Remaining sheet tokens from `nextPly` onward. */
    tokens: string[];
    /** Optional per-token remaining clock times in seconds, parallel to `tokens`. */
    clocks?: (number | null)[];
    /** The token that did not fit, present only while the main line still ends at the stop. */
    failedToken?: string;
}

/**
 * Derives what remains of a scoresheet stop from the immutable `stopped` record and the current
 * main-line length `L`. Returns `null` when nothing remains.
 *
 * - `L < ply`: the stop is at `ply` and all tokens remain (the game no longer ends at the stop).
 * - `L === ply`: the game still ends at the stop; `tokens[0]` is `failedToken` and all tokens remain.
 * - `L > ply`: the next token is `tokens[L - ply]` and the tokens from there on remain, or `null`
 *   once `L - ply >= tokens.length`.
 */
export function deriveScoresheetRemaining(
    stopped: ScoresheetReviewStop | undefined,
    mainLineLength: number,
    initialHalfMoves = 0,
): ScoresheetRemaining | null {
    if (!stopped || stopped.tokens.length === 0) return null;
    const { ply, tokens, clocks } = stopped;
    let nextPly: number;
    let remaining: string[];
    let remainingClocks: (number | null)[] | undefined;
    let failedToken: string | undefined;

    if (mainLineLength < ply) {
        nextPly = ply;
        remaining = tokens;
        remainingClocks = clocks;
    } else {
        const offset = mainLineLength - ply;
        if (offset >= tokens.length) return null;
        nextPly = mainLineLength;
        remaining = tokens.slice(offset);
        remainingClocks = clocks?.slice(offset);
        if (offset === 0) failedToken = tokens[0];
    }

    const halfMoves = initialHalfMoves + nextPly + 1;
    const color: "white" | "black" = halfMoves % 2 === 1 ? "white" : "black";
    const moveNumber = Math.ceil(halfMoves / 2);

    return {
        nextPly,
        moveNumber,
        color,
        tokens: remaining,
        ...(remainingClocks !== undefined ? { clocks: remainingClocks } : {}),
        ...(failedToken !== undefined ? { failedToken } : {}),
    };
}

/** Paths of main-line nodes currently marked `unsure`, in ply order (root is never included). */
export function getMainLineUnsurePaths(root: TreeNode): number[][] {
    const paths: number[][] = [];
    for (const { position, node } of treeIteratorMainLine(root)) {
        if (position.length > 0 && node.unsure === true) {
            paths.push(position);
        }
    }
    return paths;
}

/**
 * Returns `root` unchanged when no node carries `unsure`; otherwise returns an iterative shallow
 * copy of the tree with `unsure` removed from every node.
 */
export function stripUnsureMarks(root: TreeNode): TreeNode {
    let hasUnsure = false;
    for (const { node } of treeIterator(root)) {
        if (node.unsure !== undefined) {
            hasUnsure = true;
            break;
        }
    }
    if (!hasUnsure) return root;

    const cloneNode = (node: TreeNode): TreeNode => {
        const { unsure: _unsure, ...rest } = node;
        return { ...rest, children: [] };
    };

    const clonedRoot = cloneNode(root);
    const stack: Array<{ source: TreeNode; target: TreeNode }> = [
        { source: root, target: clonedRoot },
    ];
    while (stack.length > 0) {
        const { source, target } = stack.pop()!;
        for (let i = source.children.length - 1; i >= 0; i--) {
            const child = source.children[i];
            const clonedChild = cloneNode(child);
            target.children[i] = clonedChild;
            stack.push({ source: child, target: clonedChild });
        }
    }
    return clonedRoot;
}
