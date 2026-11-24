import { describe, beforeEach, expect, test, vi } from "vitest";
import type { DatabaseHandle } from "@/bindings";
import { parseUci } from "chessops";
import { Chess } from "chessops/chess";
import { makeFen, parseFen } from "chessops/fen";
import { parseSan } from "chessops/san";
import { createEmptyCard } from "ts-fsrs";
import {
    boardStateMapBuilder,
    buildTranspositionMaps,
    createNode,
    defaultTree,
    getBoardState,
    getMemoizedBoardStateMap,
    normalizeTreeHalfMoves,
    type TreeNode,
} from "./treeReducer";
import { createTreeStore, type TreeStoreState } from "@/state/store/tree";
import { openingLine } from "./tests/openingLine";

const mocks = vi.hoisted(() => ({ searchPosition: vi.fn(), searchPositionsStats: vi.fn() }));
vi.mock("./db", () => ({ searchPosition: mocks.searchPosition }));
vi.mock("@/platform/tauri", () => ({
    tauri: { searchPositionsStats: mocks.searchPositionsStats },
}));

import {
    applyReachWeights,
    computeReachWeights,
    reachWeightsChange,
    computeTreeCoverage,
    fetchBatchStatistics,
    fetchPositionMoves,
    fetchTreeStatistics,
    fetchTreesStatistics,
    findBiggestGap,
    getStats,
    roundReachWeight,
} from "./repertoire";

const database: DatabaseHandle = { id: { id: "db" }, kind: "database" };

beforeEach(() => vi.clearAllMocks());

test("memoizes transposition content and does not rebuild it for an ordinary store set", () => {
    const root = defaultTree().root;
    const first = createNode({
        fen: "same w - - 0 1",
        move: parseUci("e2e4")!,
        san: "e4",
        halfMoves: 1,
    });
    const second = createNode({
        fen: "same w - - 0 1",
        move: parseUci("d2d4")!,
        san: "d4",
        halfMoves: 1,
    });
    root.children = [first, second];
    const store = createTreeStore(undefined, { ...defaultTree(), root });
    const builder = vi.spyOn(boardStateMapBuilder, "build");
    const setComment = store.getState().setComment;
    builder.mockClear();

    setComment("memoized");
    expect(builder).not.toHaveBeenCalled();

    const map = getMemoizedBoardStateMap(store.getState().root, []);
    expect(map).toEqual(buildTranspositionMaps(store.getState().root));
    expect(map["same w - -"].map(({ node }) => node)).toEqual([first, second]);
    expect(builder).toHaveBeenCalledTimes(1);
    expect(getMemoizedBoardStateMap(store.getState().root, [])).toBe(map);
});

test("iterative tree stats match the previous varied-tree counts", () => {
    const root = defaultTree().root;
    const first = createNode({
        fen: "first w - - 0 1",
        move: parseUci("e2e4")!,
        san: "e4",
        halfMoves: 1,
    });
    const firstChild = createNode({
        fen: "first-child b - - 0 1",
        move: parseUci("e7e5")!,
        san: "e5",
        halfMoves: 2,
    });
    const firstLeaf = createNode({
        fen: "first-leaf w - - 0 1",
        move: parseUci("g1f3")!,
        san: "Nf3",
        halfMoves: 3,
    });
    const second = createNode({
        fen: "second w - - 0 1",
        move: parseUci("d2d4")!,
        san: "d4",
        halfMoves: 1,
    });
    firstChild.children = [firstLeaf];
    first.children = [firstChild];
    root.children = [first, second];

    expect(getStats({ ...defaultTree(), root } as TreeStoreState)).toEqual({
        total: 4,
        leafs: 2,
        depth: 3,
        // 1.d4 beside 1.e4 e5 2.Nf3 is a side line one move long.
        openVariations: 1,
    });

    // A second move closes it. The store replaces changed nodes, and so does this tree.
    const reply = createNode({
        fen: "reply b - - 0 1",
        move: parseUci("d7d5")!,
        san: "d5",
        halfMoves: 2,
    });
    const answered = { ...root, children: [first, { ...second, children: [reply] }] };
    expect(getStats({ ...defaultTree(), root: answered } as TreeStoreState).openVariations).toBe(0);
});

test.each(["forward", "reverse"] as const)(
    "overlapping identical-position fetches keep distinct operation ids and results in %s completion order",
    async (completionOrder) => {
        type SearchResult = Awaited<ReturnType<typeof import("./db").searchPosition>>;
        let resolveFirst!: (result: SearchResult) => void;
        let resolveSecond!: (result: SearchResult) => void;
        const firstSearch = new Promise<SearchResult>((resolve) => {
            resolveFirst = resolve;
        });
        const secondSearch = new Promise<SearchResult>((resolve) => {
            resolveSecond = resolve;
        });
        mocks.searchPosition
            .mockImplementationOnce(() => firstSearch)
            .mockImplementationOnce(() => secondSearch);
        const firstSignal = new AbortController().signal;
        const secondSignal = new AbortController().signal;
        const fen = defaultTree().root.fen;

        const first = fetchPositionMoves(database, fen, firstSignal);
        const second = fetchPositionMoves(database, fen, secondSignal);

        expect(mocks.searchPosition).toHaveBeenCalledTimes(2);
        const [firstCall, secondCall] = mocks.searchPosition.mock.calls;
        const options = {
            path: database,
            type: "exact",
            fen,
            color: "white",
            player: null,
            result: "any",
        };
        expect(firstCall[0]).toEqual(options);
        expect(secondCall[0]).toEqual(options);
        expect(firstCall[2]).toBe(firstSignal);
        expect(secondCall[2]).toBe(secondSignal);
        expect(firstSignal).not.toBe(secondSignal);
        expect(firstCall[1]).not.toBe(secondCall[1]);
        expect(firstCall[1]).toMatch(/^coverage-calc:.+$/);
        expect(secondCall[1]).toMatch(/^coverage-calc:.+$/);

        const firstMove = { move: "e4", white: 10, draw: 2, black: 3 };
        const secondMove = { move: "d4", white: 4, draw: 5, black: 6 };
        const firstData: SearchResult = [
            [
                { ...firstMove, unknown: 0, last_played: null, year_counts: [] },
                {
                    move: "*",
                    white: 1,
                    draw: 2,
                    black: 3,
                    unknown: 0,
                    last_played: null,
                    year_counts: [],
                },
            ],
            [],
        ];
        const secondData: SearchResult = [
            [{ ...secondMove, unknown: 0, last_played: null, year_counts: [] }],
            [],
        ];
        const firstOperation = {
            resolve: resolveFirst,
            data: firstData,
            promise: first,
            expected: { moves: [firstMove], total: 21 },
        };
        const secondOperation = {
            resolve: resolveSecond,
            data: secondData,
            promise: second,
            expected: { moves: [secondMove], total: 15 },
        };
        const [earlier, later] =
            completionOrder === "reverse"
                ? [secondOperation, firstOperation]
                : [firstOperation, secondOperation];
        earlier.resolve(earlier.data);
        await expect(earlier.promise).resolves.toEqual(earlier.expected);
        later.resolve(later.data);
        await expect(later.promise).resolves.toEqual(later.expected);

        mocks.searchPosition.mockResolvedValueOnce([[], []]);
        await expect(fetchPositionMoves(database, fen)).resolves.toEqual({ moves: [], total: 0 });
        expect(mocks.searchPosition).toHaveBeenCalledTimes(3);
        const [repeatedOptions, repeatedId, repeatedSignal] = mocks.searchPosition.mock.calls[2];
        expect(repeatedOptions).toEqual(options);
        expect(repeatedId).not.toBe(firstCall[1]);
        expect(repeatedId).not.toBe(secondCall[1]);
        expect(repeatedId).toMatch(/^coverage-calc:.+$/);
        expect(repeatedSignal).toBeUndefined();
        expect(firstSignal.aborted).toBe(false);
        expect(secondSignal.aborted).toBe(false);
    },
);

test("native cancellation propagates even when the renderer signal itself was not aborted", async () => {
    mocks.searchPosition.mockRejectedValue({
        tag: "backend-error",
        category: "cancellation",
        message: "native owner cancelled",
    });
    const signal = new AbortController().signal;
    await expect(fetchPositionMoves(database, "fen", signal)).rejects.toMatchObject({
        category: "cancellation",
    });
    expect(signal.aborted).toBe(false);
});

test("renderer cancellation never becomes empty repertoire success", async () => {
    const controller = new AbortController();
    const failure = new DOMException("Cancellation", "AbortError");
    mocks.searchPosition.mockImplementation(async () => {
        controller.abort();
        throw failure;
    });
    await expect(fetchPositionMoves(database, "fen", controller.signal)).rejects.toBe(failure);
});

test("ordinary search failure rejects instead of publishing empty full coverage", async () => {
    const failure = new Error("database unavailable");
    mocks.searchPosition.mockRejectedValue(failure);
    await expect(fetchPositionMoves(database, "fen")).rejects.toBe(failure);
});

test("a repetition line terminates coverage instead of recursing until the stack overflows", async () => {
    // 1. Nf3 Nf6 2. Ng1 Ng8 returns to the start position; with the clocks stripped both visits
    // share one board-state key, so stateMoves closes a cycle.
    const line = [
        {
            san: "Nf3",
            uci: "g1f3",
            fen: "rnbqkbnr/pppppppp/8/8/8/5N2/PPPPPPPP/RNBQKB1R b KQkq - 1 1",
        },
        {
            san: "Nf6",
            uci: "g8f6",
            fen: "rnbqkb1r/pppppppp/5n2/8/8/5N2/PPPPPPPP/RNBQKB1R w KQkq - 2 2",
        },
        {
            san: "Ng1",
            uci: "f3g1",
            fen: "rnbqkb1r/pppppppp/5n2/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 3 2",
        },
        {
            san: "Ng8",
            uci: "f6g8",
            fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 4 3",
        },
    ];
    const root = defaultTree().root;
    const stateMoves = new Map<string, Map<string, string>>();
    const nextSan = new Map<string, string>();
    let parent = root;
    for (const { san, uci, fen } of line) {
        const child = createNode({ fen, move: parseUci(uci)!, san, halfMoves: 0 });
        parent.children.push(child);
        stateMoves.set(getBoardState(parent.fen), new Map([[san, getBoardState(fen)]]));
        nextSan.set(getBoardState(parent.fen), san);
        parent = child;
    }
    normalizeTreeHalfMoves(root);
    expect(getBoardState(parent.fen)).toBe(getBoardState(root.fen));
    // After 1. Nf3 the opponent also plays 1... d5, which the repertoire does not answer, so the
    // start position's real coverage is 0.5 — distinguishable from the neutral placeholder.
    const afterNf3 = getBoardState(line[0].fen);
    mocks.searchPositionsStats.mockImplementation(async (_db, fens: string[]) =>
        fens.map((fen) => ({
            fen,
            openings: [
                { move: nextSan.get(fen), white: 10, draw: 0, black: 0 },
                ...(fen === afterNf3 ? [{ move: "d5", white: 10, draw: 0, black: 0 }] : []),
            ],
        })),
    );

    const signal = new AbortController().signal;
    const { coverageMap, missingGamesMap, gamesMap } = await computeTreeCoverage(
        root,
        "white",
        database,
        1,
        [],
        stateMoves,
        signal,
    );

    expect(mocks.searchPositionsStats).toHaveBeenCalledExactlyOnceWith(
        database,
        expect.arrayContaining([...nextSan.keys()]),
        null,
        expect.stringMatching(/^coverage-calc:/),
        { signal },
    );
    expect(mocks.searchPosition).not.toHaveBeenCalled();
    expect(coverageMap.get("")).toBe(0.5);
    expect(coverageMap.get("0,0,0,0")).toBe(0.5);
    expect(coverageMap.get("0")).toBe(0.5);
    expect(missingGamesMap.get("0")).toBe(10);
    expect(coverageMap.get("0,0")).toBe(1);
    expect(coverageMap).toEqual(
        new Map([
            ["", 0.5],
            ["0", 0.5],
            ["0,0", 1],
            ["0,0,0", 1],
            ["0,0,0,0", 0.5],
        ]),
    );
    expect(gamesMap).toEqual(
        new Map([
            ["", 10],
            ["0", 20],
            ["0,0", 10],
            ["0,0,0", 10],
            ["0,0,0,0", 10],
        ]),
    );
    expect(missingGamesMap).toEqual(
        new Map([
            ["", 0],
            ["0", 10],
            ["0,0", 0],
            ["0,0,0", 0],
            ["0,0,0,0", 0],
        ]),
    );
});

test.each(["KQkq e3", "HAha -"])(
    "coverage shares a raw %s root's prepared moves and database result with its legal repetition",
    async (rightsAndEp) => {
        const fen = `rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b ${rightsAndEp} 0 1`;
        const builder = createTreeStore(undefined, defaultTree(fen));
        expect(
            builder.getState().makeMoves({ payload: ["g8f6", "g1f3", "f6g8", "f3g1"] }).success,
        ).toBe(true);
        const root = builder.getState().root;
        const stateMoves = new Map<string, Map<string, string>>();
        for (const [key, entries] of Object.entries(getMemoizedBoardStateMap(root))) {
            const moves = new Map<string, string>();
            for (const { node } of entries) {
                for (const child of node.children) moves.set(child.san!, getBoardState(child.fen));
            }
            if (moves.size) stateMoves.set(key, moves);
        }
        const canonical = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -";
        const afterNf6 = getBoardState(root.children[0].fen);
        mocks.searchPositionsStats.mockImplementation(async (_db, fens: string[]) =>
            fens.map((key) => ({
                fen: key,
                openings: [
                    ...[...(stateMoves.get(key)?.keys() ?? [])].map((move) => ({
                        move,
                        white: 10,
                        draw: 0,
                        black: 0,
                    })),
                    ...(key === afterNf6 ? [{ move: "d4", white: 10, draw: 0, black: 0 }] : []),
                ],
            })),
        );

        const result = await computeTreeCoverage(root, "black", database, 1, [], stateMoves);
        expect(result.coverageMap.get("")).toBe(0.5);
        expect(result.coverageMap.get("0,0,0,0")).toBe(0.5);
        expect(result.gamesMap.get("")).toBe(10);
        expect(result.gamesMap.get("0,0,0,0")).toBe(10);
        expect(result.dbMovesMap.get(canonical)?.moves[0].move).toBe("Nf6");
        expect(
            mocks.searchPositionsStats.mock.calls
                .flatMap(([, fens]) => fens)
                .filter((key) => key === canonical),
        ).toHaveLength(1);
        expect(root.fen).toBe(fen);
    },
);

test.each([false, true])(
    "fractional opponent weights are exactly full only with every significant continuation, missing=%s",
    async (missing) => {
        const builder = createTreeStore(
            undefined,
            defaultTree("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1"),
        );
        const replies = ["e5", "c5", "e6", "c6", "d5", "d6", "Nf6", "Nc6", "g6", "b6"];
        for (const san of replies.slice(0, missing ? 9 : 10)) {
            builder.getState().goToStart();
            expect(builder.getState().makeMoves({ payload: [san, "Nf3"] }).success).toBe(true);
        }
        const root = builder.getState().root;
        const boardMap = getMemoizedBoardStateMap(root, []);
        const stateMoves = new Map<string, Map<string, string>>(
            Object.entries(boardMap).map(([fen, frames]) => [
                fen,
                new Map(
                    frames.flatMap(({ node }) =>
                        node.children.map((child): [string, string] => [
                            child.san!,
                            getBoardState(child.fen),
                        ]),
                    ),
                ),
            ]),
        );
        mocks.searchPositionsStats.mockImplementation(async (_db, fens: string[]) =>
            fens.map((fen) => ({
                fen,
                openings: (fen === getBoardState(root.fen)
                    ? replies
                    : root.children.some((node) => getBoardState(node.fen) === fen)
                      ? ["Nf3"]
                      : []
                ).map((move) => ({ move, white: 10, draw: 0, black: 0 })),
            })),
        );
        const result = await computeTreeCoverage(root, "white", database, 10, [], stateMoves);
        expect(result.coverageMap.get("") === 1).toBe(!missing);
        expect(result.coverageMap.get("")).toBeCloseTo(missing ? 0.9 : 1, 14);
        expect(result.missingGamesMap.get("")).toBe(missing ? 10 : 0);
    },
);

describe("findBiggestGap", () => {
    const TEST_MOVES = {
        e4: {
            san: "e4",
            uci: "e2e4",
            fen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
        },
        e5: {
            san: "e5",
            uci: "e7e5",
            fen: "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2",
        },
        c5: {
            san: "c5",
            uci: "c7c5",
            fen: "rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2",
        },
        Nf3: {
            san: "Nf3",
            uci: "g1f3",
            fen: "rnbqkbnr/pp1ppppp/8/2p5/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2",
        },
        d6: {
            san: "d6",
            uci: "d7d6",
            fen: "rnbqkbnr/pp2pppp/3p4/2p5/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 0 3",
        },
        d4: {
            san: "d4",
            uci: "d2d4",
            fen: "rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq - 0 1",
        },
    } as const;

    type TestMoveKey = keyof typeof TEST_MOVES;

    function createTestNode(key: TestMoveKey): TreeNode {
        const { san, uci, fen } = TEST_MOVES[key];
        return createNode({
            fen,
            move: parseUci(uci)!,
            san,
            halfMoves: 0,
        });
    }

    function buildStandardLineTree(): { root: TreeNode; nodeE4: TreeNode; nodeE5: TreeNode } {
        const root = defaultTree().root;
        const nodeE4 = createTestNode("e4");
        const nodeE5 = createTestNode("e5");
        nodeE4.children.push(nodeE5);
        root.children.push(nodeE4);
        normalizeTreeHalfMoves(root);
        return { root, nodeE4, nodeE5 };
    }

    function toPathMap(entries: Record<string, number>): Map<string, number> {
        return new Map(Object.entries(entries));
    }

    function createPathMaps(maps: {
        coverage?: Record<string, number>;
        games?: Record<string, number>;
        missing?: Record<string, number>;
    }) {
        return {
            coverageMap: toPathMap(maps.coverage ?? {}),
            gamesMap: toPathMap(maps.games ?? {}),
            missingGamesMap: toPathMap(maps.missing ?? {}),
        };
    }

    test("larger opponent missing count beats smaller descendant", () => {
        const { root } = buildStandardLineTree();
        const { coverageMap, gamesMap, missingGamesMap } = createPathMaps({
            coverage: { "": 0.5, "0": 0.5, "0,0": 0 },
            games: { "": 100, "0": 100, "0,0": 20 },
            missing: { "": 0, "0": 80, "0,0": 20 },
        });

        const result = findBiggestGap(root, "white", coverageMap, gamesMap, missingGamesMap, 10);
        expect(result).toEqual([0]);
    });

    test("larger descendant wins conversely", () => {
        const { root } = buildStandardLineTree();
        const { coverageMap, gamesMap, missingGamesMap } = createPathMaps({
            coverage: { "": 0.5, "0": 0.5, "0,0": 0 },
            games: { "": 100, "0": 100, "0,0": 80 },
            missing: { "": 0, "0": 20, "0,0": 80 },
        });

        const result = findBiggestGap(root, "white", coverageMap, gamesMap, missingGamesMap, 10);
        expect(result).toEqual([0, 0]);
    });

    test("shorter path wins equal counts and traversal order breaks equal-length ties", () => {
        const root = defaultTree().root;
        const nodeE4 = createTestNode("e4");
        const nodeE5 = createTestNode("e5");
        const nodeC5 = createTestNode("c5");
        nodeE4.children.push(nodeE5, nodeC5);
        root.children.push(nodeE4);
        normalizeTreeHalfMoves(root);

        // 1. Shorter path wins between opponent parent [0] and child [0, 0] when counts are equal
        const coverageMap = toPathMap({
            "": 0.5,
            "0": 0.5,
            "0,0": 0,
            "0,1": 0,
        });
        const gamesMap = toPathMap({
            "": 100,
            "0": 100,
            "0,0": 50,
            "0,1": 50,
        });
        const missingEqualParent = toPathMap({
            "": 0,
            "0": 50,
            "0,0": 50,
            "0,1": 30,
        });
        expect(
            findBiggestGap(root, "white", coverageMap, gamesMap, missingEqualParent, 10),
        ).toEqual([0]);

        // 2. Traversal order breaks equal-length ties between siblings [0, 0] and [0, 1]
        const missingEqualSiblings = toPathMap({
            "": 0,
            "0": 10,
            "0,0": 50,
            "0,1": 50,
        });
        expect(
            findBiggestGap(root, "white", coverageMap, gamesMap, missingEqualSiblings, 10),
        ).toEqual([0, 0]);
    });

    test("scoped startPath remains strictly excluded", () => {
        const { root } = buildStandardLineTree();
        const { coverageMap, gamesMap, missingGamesMap } = createPathMaps({
            coverage: { "": 0.5, "0": 0.5, "0,0": 0 },
            games: { "": 200, "0": 200, "0,0": 30 },
            missing: { "": 0, "0": 200, "0,0": 30 },
        });

        // When startPath is [0], node [0] is the start node and must be strictly excluded
        const result = findBiggestGap(
            root,
            "white",
            coverageMap,
            gamesMap,
            missingGamesMap,
            10,
            [0],
        );
        expect(result).toEqual([0, 0]);

        // If the descendant has full coverage, result is null (start node still excluded)
        const coveredDescendantMap = toPathMap({
            "": 0.5,
            "0": 0.5,
            "0,0": 1,
        });
        expect(
            findBiggestGap(root, "white", coveredDescendantMap, gamesMap, missingGamesMap, 10, [0]),
        ).toBeNull();
    });

    test("supports black orientation where white moves are opponent turns", () => {
        // Standard start FEN (halfMoves: 0, White turn). User is black.
        const root = defaultTree().root;
        // [0]: 1. e4 (halfMoves: 1, Black turn = user turn)
        const nodeE4 = createTestNode("e4");
        // [0, 0]: 1... c5 (halfMoves: 2, White turn = opponent turn)
        const nodeC5 = createTestNode("c5");
        // [0, 0, 0]: 2. Nf3 (halfMoves: 3, Black turn = user leaf)
        const nodeNf3 = createTestNode("Nf3");

        nodeC5.children.push(nodeNf3);
        nodeE4.children.push(nodeC5);
        root.children.push(nodeE4);
        normalizeTreeHalfMoves(root);

        const coverageMap = toPathMap({
            "": 0.5,
            "0": 0.5,
            "0,0": 0.5,
            "0,0,0": 0,
        });
        const gamesMap = toPathMap({
            "": 100,
            "0": 100,
            "0,0": 100,
            "0,0,0": 40,
        });

        // Case 1: Larger opponent missing count beats descendant
        const missingOpponentWins = toPathMap({
            "": 0,
            "0": 0,
            "0,0": 90,
            "0,0,0": 40,
        });
        expect(
            findBiggestGap(root, "black", coverageMap, gamesMap, missingOpponentWins, 10),
        ).toEqual([0, 0]);

        // Case 2: Larger descendant missing count wins conversely
        const missingDescendantWins = toPathMap({
            "": 0,
            "0": 0,
            "0,0": 20,
            "0,0,0": 80,
        });
        expect(
            findBiggestGap(root, "black", coverageMap, gamesMap, missingDescendantWins, 10),
        ).toEqual([0, 0, 0]);
    });

    test("anchors halfMoves correctly on black-to-move custom start FEN with black orientation", () => {
        // Custom start: 1. e4 played, Black to move (root halfMoves = 1)
        const btmFen = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
        const root = defaultTree(btmFen).root;
        expect(root.halfMoves).toBe(1);

        // Orientation is black (user turn at root: Black)
        // [0]: 1... c5 (halfMoves: 2, White turn = opponent turn)
        // [0, 0]: 2. Nf3 (halfMoves: 3, Black turn = user leaf)
        const nodeC5 = createTestNode("c5");
        const nodeNf3 = createTestNode("Nf3");
        nodeC5.children.push(nodeNf3);
        root.children.push(nodeC5);
        normalizeTreeHalfMoves(root);

        const { coverageMap, gamesMap, missingGamesMap } = createPathMaps({
            coverage: { "": 0.5, "0": 0.5, "0,0": 0 },
            games: { "": 100, "0": 100, "0,0": 25 },
            missing: { "": 0, "0": 70, "0,0": 25 },
        });

        expect(findBiggestGap(root, "black", coverageMap, gamesMap, missingGamesMap, 10)).toEqual([
            0,
        ]);
    });

    test("anchors halfMoves correctly on black-to-move custom start FEN with white orientation", () => {
        // Custom start: 1. e4 played, Black to move (root halfMoves = 1)
        // Fresh tree for white orientation
        const btmFen = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
        const root = defaultTree(btmFen).root;
        expect(root.halfMoves).toBe(1);

        // Orientation is white (opponent turn at root: Black)
        // [0]: 1... c5 (halfMoves: 2, White turn = user turn)
        // [0, 0]: 2. Nf3 (halfMoves: 3, Black turn = opponent turn)
        // [0, 0, 0]: 2... d6 (halfMoves: 4, White turn = user leaf)
        const nodeC5 = createTestNode("c5");
        const nodeNf3 = createTestNode("Nf3");
        const nodeD6 = createTestNode("d6");
        nodeNf3.children.push(nodeD6);
        nodeC5.children.push(nodeNf3);
        root.children.push(nodeC5);
        normalizeTreeHalfMoves(root);

        const { coverageMap, gamesMap, missingGamesMap } = createPathMaps({
            coverage: { "": 0.5, "0": 0.5, "0,0": 0.5, "0,0,0": 0 },
            games: { "": 100, "0": 100, "0,0": 100, "0,0,0": 30 },
            missing: { "": 0, "0": 0, "0,0": 85, "0,0,0": 30 },
        });

        expect(findBiggestGap(root, "white", coverageMap, gamesMap, missingGamesMap, 10)).toEqual([
            0, 0,
        ]);
    });

    test("prunes subtrees when games < minGames even with high missing count underneath and selects eligible sibling", () => {
        const root = defaultTree().root;
        const nodeE4 = createTestNode("e4");
        const nodeE5 = createTestNode("e5");
        const nodeD4 = createTestNode("d4");

        nodeE4.children.push(nodeE5);
        root.children.push(nodeE4, nodeD4);
        normalizeTreeHalfMoves(root);

        const { coverageMap, gamesMap, missingGamesMap } = createPathMaps({
            coverage: { "": 0.5, "0": 0.5, "0,0": 0, "1": 0.5 },
            games: { "": 100, "0": 5, "0,0": 100, "1": 50 },
            missing: { "": 0, "0": 200, "0,0": 500, "1": 30 },
        });

        // node [0] has 5 games < minGames 10; neither it nor child [0,0] (missing 500)
        // should be visited or selected. Sibling [1] is eligible and must be chosen.
        const result = findBiggestGap(root, "white", coverageMap, gamesMap, missingGamesMap, 10);
        expect(result).toEqual([1]);
    });

    test("treats games === minGames as eligible at the boundary", () => {
        const root = defaultTree().root;
        const nodeE4 = createTestNode("e4");
        const nodeD4 = createTestNode("d4");
        root.children.push(nodeE4, nodeD4);
        normalizeTreeHalfMoves(root);

        const { coverageMap, gamesMap, missingGamesMap } = createPathMaps({
            coverage: { "": 0.5, "0": 0.5, "1": 0.5 },
            games: { "": 100, "0": 10, "1": 50 },
            missing: { "": 0, "0": 60, "1": 20 },
        });

        // node [0] has exactly games === minGames (10), so it must not be pruned.
        // With higher missing count (60 > 20), [0] must win over [1].
        const result = findBiggestGap(root, "white", coverageMap, gamesMap, missingGamesMap, 10);
        expect(result).toEqual([0]);
    });

    test("prunes fully covered intermediate subtrees even when descendants have missing games, selecting eligible sibling", () => {
        const root = defaultTree().root;
        const nodeE4 = createTestNode("e4");
        const nodeE5 = createTestNode("e5");
        const nodeD4 = createTestNode("d4");

        nodeE4.children.push(nodeE5);
        root.children.push(nodeE4, nodeD4);
        normalizeTreeHalfMoves(root);

        const { coverageMap, gamesMap, missingGamesMap } = createPathMaps({
            coverage: { "": 0.5, "0": 1.0, "0,0": 0, "1": 0.5 },
            games: { "": 100, "0": 100, "0,0": 50, "1": 50 },
            missing: { "": 0, "0": 0, "0,0": 500, "1": 25 },
        });

        // node [0] is fully covered (coverage === 1.0); intermediate pruning must prevent
        // traversal into [0,0] despite missing count 500. Sibling [1] must be selected.
        const result = findBiggestGap(root, "white", coverageMap, gamesMap, missingGamesMap, 10);
        expect(result).toEqual([1]);
    });

    test("structurally excludes prepared non-leaf user nodes even when map supplies a large missing count", () => {
        // Production normally assigns missing count zero to prepared/non-leaf user nodes;
        // this test verifies selector-contract coverage that non-leaf user nodes are structurally
        // ineligible as gaps even if a supplied map carries an artificial missing count (not a claimed production defect).
        const root = defaultTree().root;
        const nodeE4 = createTestNode("e4");
        const nodeC5 = createTestNode("c5");
        const nodeNf3 = createTestNode("Nf3");

        nodeC5.children.push(nodeNf3);
        nodeE4.children.push(nodeC5);
        root.children.push(nodeE4);
        normalizeTreeHalfMoves(root);

        // In white orientation:
        // [0] (1. e4, halfMoves 1): opponent turn -> gap eligible
        // [0, 0] (1... c5, halfMoves 2): user turn with children -> prepared non-leaf user node, structurally NOT a gap
        // [0, 0, 0] (2. Nf3, halfMoves 3): opponent turn -> gap eligible
        const { coverageMap, gamesMap, missingGamesMap } = createPathMaps({
            coverage: { "": 0.5, "0": 0.5, "0,0": 0.5, "0,0,0": 0 },
            games: { "": 100, "0": 100, "0,0": 100, "0,0,0": 50 },
            missing: { "": 0, "0": 5, "0,0": 999, "0,0,0": 15 },
        });

        const result = findBiggestGap(root, "white", coverageMap, gamesMap, missingGamesMap, 10);
        expect(result).toEqual([0, 0, 0]);
    });
});

function addLine(from: TreeNode, moves: string[]): TreeNode {
    const position = Chess.fromSetup(parseFen(from.fen).unwrap()).unwrap();
    let node = from;
    for (const san of moves) {
        const move = parseSan(position, san)!;
        expect(move).toBeDefined();
        position.play(move);
        const existing = node.children.find((child) => child.san === san);
        if (existing) {
            node = existing;
            continue;
        }
        const child = createNode({
            fen: makeFen(position.toSetup()),
            move,
            san,
            halfMoves: node.halfMoves + 1,
        });
        node.children.push(child);
        node = child;
    }
    return node;
}

function recorded(moves: { move: string; games: number }[]) {
    return {
        moves: moves.map((move) => ({
            move: move.move,
            white: move.games,
            draw: 0,
            black: 0,
        })),
        total: moves.reduce((sum, move) => sum + move.games, 0),
    };
}

function statsFor(
    root: TreeNode,
    entries: [string[], { move: string; games: number }[]][],
): Map<string, ReturnType<typeof recorded>> {
    const map = new Map<string, ReturnType<typeof recorded>>();
    for (const [path, moves] of entries) {
        let node = root;
        for (const san of path) {
            const child = node.children.find((candidate) => candidate.san === san);
            expect(child).toBeDefined();
            node = child!;
        }
        map.set(getBoardState(node.fen), recorded(moves));
    }
    return map;
}

function nodeAt(root: TreeNode, sans: string[]): TreeNode {
    let node = root;
    for (const san of sans) {
        const child = node.children.find((candidate) => candidate.san === san);
        expect(child).toBeDefined();
        node = child!;
    }
    return node;
}

describe("computeReachWeights", () => {
    test("White repertoire multiplies opponent frequencies and leaves own moves unchanged", () => {
        const root = openingLine(["e4", "e5", "Nf3"]);
        const stats = statsFor(root, [
            [[], [{ move: "e4", games: 100 }]],
            [
                ["e4"],
                [
                    { move: "e5", games: 80 },
                    { move: "c5", games: 20 },
                ],
            ],
        ]);
        const weights = computeReachWeights(root, "white", [], stats)!;
        expect(weights.get(getBoardState(nodeAt(root, ["e4", "e5"]).fen))).toBe(0.8);
    });

    test("Black repertoire uses opponent frequencies from the first move", () => {
        const root = openingLine(["e4", "e5", "Nf3", "Nc6"]);
        const stats = statsFor(root, [
            [
                [],
                [
                    { move: "e4", games: 80 },
                    { move: "d4", games: 20 },
                ],
            ],
            [["e4", "e5"], [{ move: "Nf3", games: 100 }]],
        ]);
        const weights = computeReachWeights(root, "black", [], stats)!;
        expect(weights.get(getBoardState(nodeAt(root, ["e4"]).fen))).toBe(0.8);
        expect(weights.get(getBoardState(nodeAt(root, ["e4", "e5", "Nf3"]).fen))).toBe(0.8);
    });

    test("a Black-to-move custom root has reach 1", () => {
        const root = openingLine(
            ["e5", "Nf3", "Nc6"],
            "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
        );
        const stats = statsFor(root, [
            [
                ["e5"],
                [
                    { move: "Nf3", games: 40 },
                    { move: "Nc3", games: 60 },
                ],
            ],
        ]);
        const weights = computeReachWeights(root, "black", [], stats)!;
        expect(weights.get(getBoardState(root.fen))).toBeUndefined();
        expect(weights.get(getBoardState(nodeAt(root, ["e5", "Nf3"]).fen))).toBe(0.4);
    });

    test("a transposition reached by two opponent move orders sums", () => {
        const root = openingLine(["e4", "e5", "Nf3", "Nc6", "Bb5"]);
        addLine(root, ["e4", "Nc6", "Nf3", "e5", "Bb5"]);
        const stats = statsFor(root, [
            [
                ["e4"],
                [
                    { move: "e5", games: 60 },
                    { move: "Nc6", games: 40 },
                ],
            ],
            [["e4", "e5", "Nf3"], [{ move: "Nc6", games: 100 }]],
            [
                ["e4", "Nc6", "Nf3"],
                [
                    { move: "e5", games: 50 },
                    { move: "d5", games: 50 },
                ],
            ],
        ]);
        const weights = computeReachWeights(root, "white", [], stats)!;
        expect(weights.get(getBoardState(nodeAt(root, ["e4", "e5", "Nf3", "Nc6"]).fen))).toBe(0.8);
    });

    test("an own-move alternative inherits the parent reach", () => {
        const root = openingLine(["e4", "e5", "Nf3", "Nc6"]);
        addLine(root, ["e4", "e5", "Bc4", "Nc6"]);
        const stats = statsFor(root, [
            [
                ["e4"],
                [
                    { move: "e5", games: 70 },
                    { move: "c5", games: 30 },
                ],
            ],
            [["e4", "e5", "Nf3"], [{ move: "Nc6", games: 100 }]],
            [["e4", "e5", "Bc4"], [{ move: "Nc6", games: 100 }]],
        ]);
        const weights = computeReachWeights(root, "white", [], stats)!;
        expect(weights.get(getBoardState(nodeAt(root, ["e4", "e5"]).fen))).toBe(0.7);
        expect(weights.get(getBoardState(nodeAt(root, ["e4", "e5", "Nf3", "Nc6"]).fen))).toBe(0.7);
        expect(weights.get(getBoardState(nodeAt(root, ["e4", "e5", "Bc4", "Nc6"]).fen))).toBe(0.7);
    });

    test("a move the database does not record counts as one game", () => {
        const root = openingLine(["e4", "a6", "Nf3"]);
        const stats = statsFor(root, [
            [
                ["e4"],
                [
                    { move: "e5", games: 90 },
                    { move: "c5", games: 10 },
                ],
            ],
        ]);
        const weights = computeReachWeights(root, "white", [], stats)!;
        expect(weights.get(getBoardState(nodeAt(root, ["e4", "a6"]).fen))).toBe(0.01);
    });

    test("a position without statistics splits equally among tree replies", () => {
        const root = openingLine(["e4", "e5", "Nf3"]);
        addLine(root, ["e4", "c5", "Nf3"]);
        const weights = computeReachWeights(root, "white", [], new Map())!;
        expect(weights.get(getBoardState(nodeAt(root, ["e4", "e5"]).fen))).toBe(0.5);
        expect(weights.get(getBoardState(nodeAt(root, ["e4", "c5"]).fen))).toBe(0.5);
    });

    test("a Start marker deep in the tree excludes earlier cards", () => {
        const root = openingLine(["e4", "e5", "Nf3", "Nc6", "Bb5"]);
        const stats = statsFor(root, [
            [
                ["e4"],
                [
                    { move: "e5", games: 50 },
                    { move: "c5", games: 50 },
                ],
            ],
            [["e4", "e5", "Nf3"], [{ move: "Nc6", games: 100 }]],
        ]);
        const startPath = [0, 0, 0];
        const weights = computeReachWeights(root, "white", startPath, stats)!;
        expect(weights.get(getBoardState(nodeAt(root, ["e4", "e5"]).fen))).toBeUndefined();
        expect(weights.get(getBoardState(nodeAt(root, ["e4", "e5", "Nf3", "Nc6"]).fen))).toBe(0.5);
    });

    test("a repetition that returns to the root does not add the out-of-scope reach", () => {
        const root = openingLine(["Nf3", "Nf6", "Ng1", "Ng8"]);
        const stats = statsFor(root, [
            [
                ["Nf3"],
                [
                    { move: "Nf6", games: 50 },
                    { move: "d5", games: 50 },
                ],
            ],
            [
                ["Nf3", "Nf6", "Ng1"],
                [
                    { move: "Ng8", games: 50 },
                    { move: "d5", games: 50 },
                ],
            ],
        ]);
        const weights = computeReachWeights(root, "white", [], stats)!;
        expect(weights.get(getBoardState(root.fen))).toBe(0.25);
        expect(weights.get(getBoardState(nodeAt(root, ["Nf3", "Nf6"]).fen))).toBe(0.5);
    });

    test("a repetition that returns to a position before Start does not add the out-of-scope reach", () => {
        const root = defaultTree().root;
        const before = createNode({
            fen: "before b - - 0 1",
            move: parseUci("e2e4")!,
            san: "e4",
            halfMoves: 1,
        });
        const start = createNode({
            fen: "start w - - 0 1",
            move: parseUci("e7e5")!,
            san: "e5",
            halfMoves: 2,
        });
        const reply = createNode({
            fen: "reply b - - 0 1",
            move: parseUci("g1f3")!,
            san: "Nf3",
            halfMoves: 3,
        });
        const returned = createNode({
            fen: "before b - - 1 2",
            move: parseUci("b8c6")!,
            san: "Nc6",
            halfMoves: 4,
        });
        reply.children = [returned];
        start.children = [reply];
        before.children = [start];
        root.children = [before];
        const stats = new Map([
            [
                getBoardState(before.fen),
                recorded([
                    { move: "e5", games: 50 },
                    { move: "c5", games: 50 },
                ]),
            ],
            [
                getBoardState(reply.fen),
                recorded([
                    { move: "Nc6", games: 50 },
                    { move: "d6", games: 50 },
                ]),
            ],
        ]);
        const weights = computeReachWeights(root, "white", [0, 0], stats)!;
        expect(weights.get(getBoardState(before.fen))).toBe(0.25);
        expect(weights.get(getBoardState(start.fen))).toBe(0.5);
    });

    test("a branch before Start that transposes below Start takes no part", () => {
        const root = defaultTree().root;
        const e4 = createNode({
            fen: "e4 b - - 0 1",
            move: parseUci("e2e4")!,
            san: "e4",
            halfMoves: 1,
        });
        const start = createNode({
            fen: "start w - - 0 1",
            move: parseUci("e7e5")!,
            san: "e5",
            halfMoves: 2,
        });
        const below = createNode({
            fen: "below b - - 0 1",
            move: parseUci("g1f3")!,
            san: "Nf3",
            halfMoves: 3,
        });
        const c5 = createNode({
            fen: "c5 w - - 0 1",
            move: parseUci("c7c5")!,
            san: "c5",
            halfMoves: 2,
        });
        const transpose = createNode({
            fen: "below b - - 0 1",
            move: parseUci("g1f3")!,
            san: "Nf3",
            halfMoves: 3,
        });
        start.children = [below];
        c5.children = [transpose];
        e4.children = [start, c5];
        root.children = [e4];
        const stats = new Map([
            [
                getBoardState(e4.fen),
                recorded([
                    { move: "e5", games: 10 },
                    { move: "c5", games: 90 },
                ]),
            ],
        ]);
        const weights = computeReachWeights(root, "white", [0, 0], stats)!;
        expect(weights.get(getBoardState(below.fen))).toBe(0.1);
    });

    test("an unresolved Start produces no weights", () => {
        const root = openingLine(["e4", "e5"]);
        expect(computeReachWeights(root, "white", [0, 9], new Map())).toBeNull();
    });

    test("the summed reach is capped at 1", () => {
        const root = defaultTree().root;
        const e4 = createNode({
            fen: "e4 b - - 0 1",
            move: parseUci("e2e4")!,
            san: "e4",
            halfMoves: 1,
        });
        const first = createNode({
            fen: "same w - - 0 1",
            move: parseUci("e7e5")!,
            san: "e5",
            halfMoves: 2,
        });
        const d4 = createNode({
            fen: "d4 b - - 0 1",
            move: parseUci("d2d4")!,
            san: "d4",
            halfMoves: 1,
        });
        const second = createNode({
            fen: "same w - - 0 1",
            move: parseUci("d7d5")!,
            san: "d5",
            halfMoves: 2,
        });
        e4.children = [first];
        d4.children = [second];
        root.children = [e4, d4];
        const weights = computeReachWeights(root, "white", [], new Map())!;
        expect(weights.get(getBoardState(first.fen))).toBe(1);
        expect(roundReachWeight(1.6)).toBe(1);
    });
});

test("fetchBatchStatistics forwards the filter and keeps unknown, last_played and year_counts", async () => {
    const startFen = getBoardState(defaultTree().root.fen);
    const filter = { player1: 7, startDate: "2024.01.01", includeUnknownResults: true };
    const signal = new AbortController().signal;
    const openings = [
        {
            move: "e4",
            white: 3,
            draw: 1,
            black: 2,
            unknown: 4,
            last_played: "2026.02.14",
            year_counts: [
                { year: 2025, count: 6 },
                { year: 2026, count: 4 },
            ],
        },
        {
            move: "*",
            white: 0,
            draw: 1,
            black: 0,
            unknown: 1,
            last_played: "2026.01.05",
            year_counts: [{ year: 2026, count: 2 }],
        },
    ];
    mocks.searchPositionsStats.mockResolvedValueOnce([{ fen: startFen, openings }]);

    const result = await fetchBatchStatistics([startFen], database, filter, signal, "prep:test");

    expect(mocks.searchPositionsStats).toHaveBeenCalledExactlyOnceWith(
        database,
        [startFen],
        filter,
        "prep:test",
        { signal },
    );
    expect(result.get(startFen)).toEqual(openings);
});

test("fetchTreesStatistics issues one searchPositionsStats call over the union of two trees", async () => {
    const treeA = openingLine(["e4", "e5"]);
    const treeB = openingLine(["e4", "c5"]);
    mocks.searchPositionsStats.mockImplementation(async (_db, fens: string[]) =>
        fens.map((fen) => ({ fen, openings: [] })),
    );
    await fetchTreesStatistics(
        [
            { root: treeA, startPath: [] },
            { root: treeB, startPath: [] },
        ],
        database,
    );
    expect(mocks.searchPositionsStats).toHaveBeenCalledTimes(1);
    const fens = mocks.searchPositionsStats.mock.calls[0][1] as string[];
    expect(fens).toEqual(
        expect.arrayContaining([
            getBoardState(treeA.fen),
            getBoardState(nodeAt(treeA, ["e4"]).fen),
            getBoardState(nodeAt(treeA, ["e4", "e5"]).fen),
            getBoardState(nodeAt(treeB, ["e4", "c5"]).fen),
        ]),
    );
    expect(new Set(fens).size).toBe(fens.length);
});

test("the statistics request includes the path from the root to Start", async () => {
    const root = openingLine(["e4", "e5", "Nf3"]);
    mocks.searchPositionsStats.mockImplementation(async (_db, fens: string[]) =>
        fens.map((fen) => ({ fen, openings: [] })),
    );
    await fetchTreeStatistics(root, [0, 0], database);
    const fens = mocks.searchPositionsStats.mock.calls[0][1] as string[];
    expect(fens).toEqual(
        expect.arrayContaining([
            getBoardState(root.fen),
            getBoardState(nodeAt(root, ["e4"]).fen),
            getBoardState(nodeAt(root, ["e4", "e5"]).fen),
            getBoardState(nodeAt(root, ["e4", "e5", "Nf3"]).fen),
        ]),
    );
});

test("path-to-Start statistics fill dbMovesMap and leave coverage maps at Start", async () => {
    const root = openingLine(["e4", "e5", "Nf3"]);
    const startPath = [0, 0];
    const start = nodeAt(root, ["e4", "e5"]);
    const below = nodeAt(root, ["e4", "e5", "Nf3"]);
    const stateMoves = new Map([
        [getBoardState(start.fen), new Map([["Nf3", getBoardState(below.fen)]])],
    ]);
    mocks.searchPositionsStats.mockImplementation(async (_db, fens: string[]) =>
        fens.map((fen) => ({
            fen,
            openings: [{ move: "*", white: 10, draw: 0, black: 0 }],
        })),
    );
    const result = await computeTreeCoverage(root, "white", database, 1, startPath, stateMoves);
    const startKey = startPath.join(",");
    expect(
        [...result.coverageMap.keys()].every(
            (key) => key === startKey || key.startsWith(`${startKey},`),
        ),
    ).toBe(true);
    expect(
        [...result.gamesMap.keys()].every(
            (key) => key === startKey || key.startsWith(`${startKey},`),
        ),
    ).toBe(true);
    expect(result.coverageMap.has("")).toBe(false);
    expect(result.dbMovesMap.has(getBoardState(root.fen))).toBe(true);
    expect(result.dbMovesMap.has(getBoardState(nodeAt(root, ["e4"]).fen))).toBe(true);
    expect(result.dbMovesMap.has(getBoardState(start.fen))).toBe(true);
});

test("applyReachWeights writes only changed in-scope cards", () => {
    const root = openingLine(["e4", "e5", "Nf3"]);
    const fen = nodeAt(root, ["e4", "e5"]).fen;
    const inScope = { fen, answer: "Nf3", card: createEmptyCard() };
    const outOfScope = {
        fen: nodeAt(root, ["e4"]).fen,
        answer: "e5",
        card: createEmptyCard(),
        outOfScope: true as const,
        weight: 0.4,
    };
    const weights = new Map([
        [getBoardState(fen), 0.8],
        [getBoardState(outOfScope.fen), 0.1],
    ]);
    const first = applyReachWeights([inScope, outOfScope], weights);
    expect(reachWeightsChange([inScope, outOfScope], weights)).toBe(true);
    expect(first).toEqual([{ ...inScope, weight: 0.8 }, outOfScope]);
    expect(reachWeightsChange(first!, weights)).toBe(false);
    expect(applyReachWeights(first!, weights)).toBeNull();
});
