import type { LocalOptions } from "@/components/panels/database/DatabasePanel";
import type { DatabaseHandle, PositionStats, PositionStatsFilter } from "@/bindings";
import { tauri } from "@/platform/tauri";
import { searchPosition } from "./db";
import { dateOrderKey } from "./pgnDate";
import type { Position } from "./practicePosition";
import { validWeight } from "./practicePosition";
import { isInPracticeScope, isUserToMove } from "./practiceScope";
import {
    getNodeAtPath,
    getResolvedPathLength,
    type TreeNode,
    getBoardState,
    isOpenVariation,
} from "./treeReducer";
import type { TreeStoreState } from "@/state/store/tree";
import { memoize } from "proxy-memoize";

export type PositionMove = {
    san: string;
    games: number;
    totalGames: number;
    frequency: number;
    white: number;
    draw: number;
    black: number;
    inRepertoire: boolean;
    coverage: number;
    path: number[];
};

export async function fetchPositionMoves(
    dbPath: DatabaseHandle,
    fen: string,
    signal?: AbortSignal,
): Promise<{
    moves: { move: string; white: number; draw: number; black: number }[];
    total: number;
}> {
    const [openings] = await searchPosition(
        {
            path: dbPath,
            type: "exact",
            fen,
            color: "white",
            player: null,
            result: "any",
        } as LocalOptions,
        `coverage-calc:${crypto.randomUUID()}`,
        signal,
    );
    return positionMovesFromStats(openings);
}

function positionMovesFromStats(openings: PositionStats[]) {
    const summary = openings.find((op) => op.move === "*");
    const moves = openings
        .filter((op) => op.move !== "*")
        .map((op) => ({
            move: op.move,
            white: op.white,
            draw: op.draw,
            black: op.black,
        }));
    const gamesEndingHere = summary ? summary.white + summary.draw + summary.black : 0;
    const gamesContinuing = moves.reduce((acc, m) => acc + m.white + m.draw + m.black, 0);
    return { moves, total: gamesEndingHere + gamesContinuing };
}

/**
 * Merges `PositionStats` rows across multiple sources by move SAN: counts (`white`, `draw`,
 * `black`, `unknown`) and `year_counts` are summed and the later `last_played` wins.
 */
export function mergePositionStats(
    lists: Iterable<readonly PositionStats[] | undefined>,
): PositionStats[] {
    const moves = new Map<string, PositionStats>();
    for (const openings of lists) {
        if (!openings) continue;
        for (const row of openings) {
            const merged = moves.get(row.move);
            if (!merged) {
                moves.set(row.move, {
                    ...row,
                    year_counts: row.year_counts.map((y) => ({ ...y })),
                });
                continue;
            }
            merged.white += row.white;
            merged.draw += row.draw;
            merged.black += row.black;
            merged.unknown += row.unknown;
            if (dateOrderKey(row.last_played) > dateOrderKey(merged.last_played)) {
                merged.last_played = row.last_played;
            }
            for (const { year, count } of row.year_counts) {
                const existing = merged.year_counts.find((entry) => entry.year === year);
                if (existing) existing.count += count;
                else merged.year_counts.push({ year, count });
            }
            merged.year_counts.sort((a, b) => a.year - b.year);
        }
    }
    return [...moves.values()];
}

export type TreeStatisticsEntry = {
    moves: { move: string; white: number; draw: number; black: number }[];
    total: number;
};

export type TreeStatistics = Map<string, TreeStatisticsEntry>;

const REACH_WEIGHT_SIGNIFICANT_DIGITS = 4;

function moveGames(move: { white: number; draw: number; black: number }): number {
    return move.white + move.draw + move.black;
}

function collectStatisticsFens(
    root: TreeNode,
    startPath: number[],
    signal?: AbortSignal,
): string[] {
    const fenSet = new Set<string>();
    let node = root;
    fenSet.add(getBoardState(node.fen));
    const resolved = getResolvedPathLength(root, startPath);
    for (let i = 0; i < resolved; i++) {
        if (signal?.aborted) throw new DOMException("Cancellation", "AbortError");
        node = node.children[startPath[i]];
        fenSet.add(getBoardState(node.fen));
    }

    const startNode = startPath.length > 0 ? getNodeAtPath(root, startPath) : root;
    const stack: TreeNode[] = [startNode];
    while (stack.length > 0) {
        if (signal?.aborted) throw new DOMException("Cancellation", "AbortError");
        const current = stack.pop()!;
        fenSet.add(getBoardState(current.fen));
        for (const child of current.children) stack.push(child);
    }
    return [...fenSet];
}

export async function fetchBatchStatistics(
    fenList: readonly string[],
    dbPath: DatabaseHandle,
    filter: PositionStatsFilter | null,
    signal?: AbortSignal,
    progressId?: string,
): Promise<Map<string, PositionStats[]>> {
    const cache = new Map<string, PositionStats[]>();
    if (fenList.length > 0) {
        const results = await tauri.searchPositionsStats(
            dbPath,
            [...fenList],
            filter,
            progressId ?? `coverage-calc:${crypto.randomUUID()}`,
            { signal },
        );
        for (const { fen, openings } of results) cache.set(fen, openings);
    }
    return cache;
}

function treeStatisticsFromBatch(raw: Map<string, PositionStats[]>): TreeStatistics {
    const cache: TreeStatistics = new Map();
    for (const [fen, openings] of raw) cache.set(fen, positionMovesFromStats(openings));
    return cache;
}

export async function fetchTreeStatistics(
    root: TreeNode,
    startPath: number[],
    dbPath: DatabaseHandle,
    signal?: AbortSignal,
): Promise<TreeStatistics> {
    return treeStatisticsFromBatch(
        await fetchBatchStatistics(
            collectStatisticsFens(root, startPath, signal),
            dbPath,
            null,
            signal,
        ),
    );
}

/** One batch statistics request over every tree's reach positions. */
export async function fetchTreesStatistics(
    trees: readonly { root: TreeNode; startPath: number[] }[],
    dbPath: DatabaseHandle,
    signal?: AbortSignal,
): Promise<TreeStatistics> {
    const fens = new Set<string>();
    for (const tree of trees) {
        for (const fen of collectStatisticsFens(tree.root, tree.startPath, signal)) fens.add(fen);
    }
    return treeStatisticsFromBatch(await fetchBatchStatistics([...fens], dbPath, null, signal));
}

function opponentMoveFrequency(parent: TreeNode, child: TreeNode, stats: TreeStatistics): number {
    const replies = parent.children.length;
    const dbData = stats.get(getBoardState(parent.fen));
    const recorded = dbData?.moves ?? [];
    const recordedTotal = recorded.reduce((sum, move) => sum + moveGames(move), 0);
    if (!dbData || recorded.length === 0 || recordedTotal <= 0) {
        return replies > 0 ? 1 / replies : 0;
    }
    const recordedMove = child.san ? recorded.find((move) => move.move === child.san) : undefined;
    if (!recordedMove) return 1 / recordedTotal;
    return moveGames(recordedMove) / recordedTotal;
}

function childReach(
    parent: TreeNode,
    child: TreeNode,
    reach: number,
    color: "white" | "black",
    stats: TreeStatistics,
): number {
    return isUserToMove(parent.halfMoves, color)
        ? reach
        : reach * opponentMoveFrequency(parent, child, stats);
}

export function roundReachWeight(value: number): number {
    const capped = Math.min(1, value);
    if (!Number.isFinite(capped) || capped <= 0) return capped;
    return Number.parseFloat(capped.toPrecision(REACH_WEIGHT_SIGNIFICANT_DIGITS));
}

/**
 * Reach of each in-scope board state from the reference statistics. Null when Start does not
 * resolve. Keys are `getBoardState`; values are capped at 1 and rounded to four significant digits.
 */
export function computeReachWeights(
    root: TreeNode,
    color: "white" | "black",
    startPath: number[],
    stats: TreeStatistics,
): Map<string, number> | null {
    if (getResolvedPathLength(root, startPath) !== startPath.length) return null;

    const sums = new Map<string, number>();
    const addIfInScope = (node: TreeNode, path: number[], reach: number) => {
        if (!isInPracticeScope(path, startPath)) return;
        const key = getBoardState(node.fen);
        sums.set(key, (sums.get(key) ?? 0) + reach);
    };

    let node = root;
    let reach = 1;
    addIfInScope(node, [], reach);
    for (let i = 0; i < startPath.length; i++) {
        const child = node.children[startPath[i]];
        reach = childReach(node, child, reach, color, stats);
        node = child;
        addIfInScope(node, startPath.slice(0, i + 1), reach);
    }

    const walkSubtree = (current: TreeNode, path: number[], currentReach: number) => {
        for (let i = 0; i < current.children.length; i++) {
            const child = current.children[i];
            const nextReach = childReach(current, child, currentReach, color, stats);
            const childPath = [...path, i];
            addIfInScope(child, childPath, nextReach);
            walkSubtree(child, childPath, nextReach);
        }
    };
    walkSubtree(node, startPath, reach);

    const weights = new Map<string, number>();
    for (const [key, sum] of sums) weights.set(key, roundReachWeight(sum));
    return weights;
}

function replacementReachWeight(
    position: Position,
    weights: Map<string, number>,
): number | undefined {
    if (position.outOfScope) return undefined;
    const computed = validWeight(weights.get(getBoardState(position.fen)));
    const stored = validWeight(position.weight);
    if (computed === undefined || stored === computed) return undefined;
    return computed;
}

/** True when applyReachWeights would write at least one card. */
export function reachWeightsChange(
    positions: readonly Position[],
    weights: Map<string, number>,
): boolean {
    return positions.some((position) => replacementReachWeight(position, weights) !== undefined);
}

/** Writes computed weights onto in-scope cards. Returns null when every stored weight is unchanged. */
export function applyReachWeights(
    positions: readonly Position[],
    weights: Map<string, number>,
): Position[] | null {
    let changed = false;
    const next = positions.map((position) => {
        const computed = replacementReachWeight(position, weights);
        if (computed === undefined) return position;
        changed = true;
        return { ...position, weight: computed };
    });
    return changed ? next : null;
}

/**
 * Compute coverage and missing games for a single `getBoardState` key.
 * Recurses into child keys (which must already be in dbCache and stateMoves).
 * Results are stored in a Map so each key is processed only once.
 */
function computeCoverageForFen(
    boardFen: string,
    dbCache: TreeStatistics,
    stateMoves: Map<string, Map<string, string>>,
    orientation: "white" | "black",
    minGames: number,
    memo: Map<string, { coverage: number; missing: number }>,
): { coverage: number; missing: number } {
    const cached = memo.get(boardFen);
    if (cached) return cached;
    // Board-state keys drop the clocks, so a repetition line maps a position back onto one still
    // on the call stack. Seed the memo with the neutral result before recursing so that re-entry
    // terminates; every exit below overwrites it with the real value.
    memo.set(boardFen, { coverage: 1, missing: 0 });

    const dbData = dbCache.get(boardFen);
    const moves = dbData?.moves ?? [];
    const total = dbData?.total ?? 0;

    if (total < minGames) {
        const res = { coverage: 1, missing: 0 };
        memo.set(boardFen, res);
        return res;
    }

    const sideToMove = boardFen.split(" ")[1]; // "w" or "b"
    const isUserTurn = sideToMove === orientation[0];

    if (isUserTurn) {
        const childFenMap = stateMoves.get(boardFen);
        if (!childFenMap || childFenMap.size === 0) {
            const res = { coverage: 0, missing: total };
            memo.set(boardFen, res);
            return res;
        }
        let maxCoverage = 0;
        for (const childFen of childFenMap.values()) {
            const child = computeCoverageForFen(
                childFen,
                dbCache,
                stateMoves,
                orientation,
                minGames,
                memo,
            );
            maxCoverage = Math.max(maxCoverage, child.coverage);
        }
        const res = { coverage: maxCoverage, missing: 0 };
        memo.set(boardFen, res);
        return res;
    } else {
        // Opponent's turn
        const significant = moves.filter((m) => m.white + m.draw + m.black >= minGames);
        const sigTotal = significant.reduce((sum, m) => sum + m.white + m.draw + m.black, 0);
        if (sigTotal === 0) {
            const res = { coverage: 1, missing: 0 };
            memo.set(boardFen, res);
            return res;
        }
        let weighted = 0;
        let maxMissing = 0;
        let fullyCovered = true;
        for (const m of significant) {
            const freq = (m.white + m.draw + m.black) / sigTotal;
            const childFen = stateMoves.get(boardFen)?.get(m.move);
            if (childFen) {
                const child = computeCoverageForFen(
                    childFen,
                    dbCache,
                    stateMoves,
                    orientation,
                    minGames,
                    memo,
                );
                weighted += freq * child.coverage;
                if (child.coverage !== 1) fullyCovered = false;
            } else {
                fullyCovered = false;
                if (m.white + m.draw + m.black > maxMissing) {
                    maxMissing = m.white + m.draw + m.black;
                }
            }
        }
        const res = { coverage: fullyCovered ? 1 : weighted, missing: maxMissing };
        memo.set(boardFen, res);
        return res;
    }
}

/**
 * Walk the actual tree and build the path‑keyed maps needed by the UI.
 */
function buildPathMaps(
    root: TreeNode,
    startPath: number[],
    fenCoverageCache: Map<string, { coverage: number; missing: number }>,
    dbCache: TreeStatistics,
): {
    coverageMap: Map<string, number>;
    gamesMap: Map<string, number>;
    missingGamesMap: Map<string, number>;
    dbMovesMap: TreeStatistics;
} {
    const coverageMap = new Map<string, number>();
    const gamesMap = new Map<string, number>();
    const missingGamesMap = new Map<string, number>();
    const dbMovesMap: TreeStatistics = new Map();

    const startNode = startPath.length > 0 ? getNodeAtPath(root, startPath) : root;
    function walk(node: TreeNode, path: number[]) {
        const boardFen = getBoardState(node.fen);
        const fenData = fenCoverageCache.get(boardFen);
        if (fenData) {
            const key = path.join(",");
            coverageMap.set(key, fenData.coverage);
            missingGamesMap.set(key, fenData.missing);
        }
        const dbData = dbCache.get(boardFen);
        if (dbData) {
            const key = path.join(",");
            gamesMap.set(key, dbData.total);
            if (!dbMovesMap.has(boardFen)) {
                dbMovesMap.set(boardFen, dbData);
            }
        }
        for (let i = 0; i < node.children.length; i++) {
            walk(node.children[i], [...path, i]);
        }
    }
    walk(startNode, [...startPath]);

    return { coverageMap, gamesMap, missingGamesMap, dbMovesMap };
}

export async function computeTreeCoverage(
    root: TreeNode,
    userColor: "white" | "black",
    dbPath: DatabaseHandle,
    minGames: number,
    startPath: number[],
    stateMoves: Map<string, Map<string, string>>,
    signal?: AbortSignal,
): Promise<{
    coverageMap: Map<string, number>;
    gamesMap: Map<string, number>;
    missingGamesMap: Map<string, number>;
    dbMovesMap: TreeStatistics;
}> {
    const dbCache = await fetchTreeStatistics(root, startPath, dbPath, signal);

    if (signal?.aborted) throw new DOMException("Cancellation", "AbortError");

    const memo = new Map<string, { coverage: number; missing: number }>();
    for (const fen of dbCache.keys()) {
        computeCoverageForFen(fen, dbCache, stateMoves, userColor, minGames, memo);
    }

    const pathMaps = buildPathMaps(root, startPath, memo, dbCache);
    // Path-to-Start frequencies live in the cache for reach weights. Coverage maps stay Start-only.
    for (const [fen, data] of dbCache) {
        if (!pathMaps.dbMovesMap.has(fen)) pathMaps.dbMovesMap.set(fen, data);
    }

    return pathMaps;
}

export function findNextGap(
    root: TreeNode,
    startPath: number[],
    userColor: "white" | "black",
    coverageMap: Map<string, number>,
    gamesMap: Map<string, number>,
    minGames: number,
): number[] | null {
    const startNode = getNodeAtPath(root, startPath);

    function findNextInSubtree(node: TreeNode, path: number[]): number[] | null {
        const pathKey = path.join(",");
        const coverage = coverageMap.get(pathKey) ?? 0;
        const games = gamesMap.get(pathKey) ?? 0;

        if (coverage >= 1 || games < minGames) {
            return null;
        }

        const isUserTurn = isUserToMove(node.halfMoves, userColor);

        for (let i = 0; i < node.children.length; i++) {
            const result = findNextInSubtree(node.children[i], [...path, i]);
            if (result) return result;
        }

        if (path.length > startPath.length) {
            if (isUserTurn && node.children.length === 0) {
                return path;
            }

            if (!isUserTurn) {
                return path;
            }
        }

        return null;
    }

    return findNextInSubtree(startNode, startPath);
}

export function findBiggestGap(
    root: TreeNode,
    userColor: "white" | "black",
    coverageMap: Map<string, number>,
    gamesMap: Map<string, number>,
    missingGamesMap: Map<string, number>,
    minGames: number,
    startPath: number[] = [],
): number[] | null {
    const startNode = getNodeAtPath(root, startPath);

    let maxMissing = -1;
    let bestPath: number[] | null = null;

    function traverse(node: TreeNode, path: number[]): void {
        const pathKey = path.join(",");
        const coverage = coverageMap.get(pathKey) ?? 0;
        const games = gamesMap.get(pathKey) ?? 0;
        const missing = missingGamesMap.get(pathKey) ?? 0;

        if (coverage >= 1 || games < minGames) {
            return;
        }

        const isUserTurn = isUserToMove(node.halfMoves, userColor);

        for (let i = 0; i < node.children.length; i++) {
            traverse(node.children[i], [...path, i]);
        }

        if (path.length > startPath.length) {
            const isGap = !isUserTurn || node.children.length === 0;

            if (isGap) {
                if (missing > maxMissing) {
                    maxMissing = missing;
                    bestPath = [...path];
                } else if (missing === maxMissing && bestPath !== null) {
                    if (path.length < bestPath.length) {
                        bestPath = [...path];
                    }
                }
            }
        }
    }

    traverse(startNode, startPath);
    return bestPath;
}

function getTreeStats(root: TreeNode) {
    let total = 0;
    let leafs = 0;
    let depth = 0;
    let openVariations = 0;
    const stack: { node: TreeNode; depth: number }[] = [{ node: root, depth: 0 }];

    while (stack.length > 0) {
        const { node, depth: nodeDepth } = stack.pop()!;
        depth = Math.max(depth, nodeDepth);
        if (node.children.length === 0) {
            leafs += 1;
            continue;
        }
        total += node.children.length;
        for (let index = 0; index < node.children.length; index += 1) {
            if (isOpenVariation(node, index)) openVariations += 1;
            stack.push({ node: node.children[index], depth: nodeDepth + 1 });
        }
    }
    return { total, leafs, depth, openVariations };
}

export const getStats = memoize((store: TreeStoreState) => getTreeStats(store.root));
