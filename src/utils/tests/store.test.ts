import { parseUci } from "chessops";
import { parseSan } from "chessops/san";
import { beforeEach, expect, test } from "vitest";
import { createTreeStore } from "@/state/store/tree";
import { getPGN } from "../chess";
import { positionFromFen } from "../chessops";
import {
    defaultTree,
    getMemoizedBoardStateMap,
    TreeNode,
    type TreeState,
} from "@/utils/treeReducer";

const store = createTreeStore();

beforeEach(() => {
    store.getState().setState(defaultTree());
});

const e4 = parseUci("e2e4")!;
const d5 = parseUci("d7d5")!;
const treeE4D5: () => TreeState = () => ({
    ...defaultTree(),
    position: [0, 0],
    root: {
        fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
        move: null,
        san: null,
        children: [
            {
                fen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
                move: e4,
                san: "e4",
                children: [
                    {
                        fen: "rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2",
                        move: d5,
                        san: "d5",
                        clock: undefined,
                        children: [],
                        score: null,
                        depth: null,
                        halfMoves: 2,
                        shapes: [],
                        nags: [],
                        comment: "",
                    },
                ],
                clock: undefined,
                score: null,
                depth: null,
                halfMoves: 1,
                shapes: [],
                nags: [],
                comment: "",
            },
        ],
        score: null,
        depth: null,
        halfMoves: 0,
        shapes: [],
        nags: [],
        comment: "",
    },
    report: {
        inProgress: false,
        operationId: null,
    },
});

const treeE4D5Nf3: () => TreeState = () => ({
    ...defaultTree(),
    position: [0, 0],
    root: {
        fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
        move: null,
        san: null,
        children: [
            {
                fen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
                move: e4,
                san: "e4",
                children: [
                    {
                        fen: "rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2",
                        move: d5,
                        san: "d5",
                        clock: undefined,
                        children: [],
                        score: null,
                        depth: null,
                        halfMoves: 2,
                        shapes: [],
                        nags: [],
                        comment: "",
                    },
                ],
                clock: undefined,
                score: null,
                depth: null,
                halfMoves: 1,
                shapes: [],
                nags: [],
                comment: "",
            },
            {
                fen: "rnbqkbnr/pppppppp/8/8/8/5N2/PPPPPPPP/RNBQKB1R b KQkq - 1 1",
                move: parseUci("g1f3")!,
                san: "Nf3",
                children: [],
                clock: undefined,
                score: null,
                depth: null,
                halfMoves: 1,
                shapes: [],
                nags: [],
                comment: "",
            },
        ],
        score: null,
        depth: null,
        halfMoves: 0,
        shapes: [],
        nags: [],
        comment: "",
    },
    report: {
        inProgress: false,
        operationId: null,
    },
});

const getNewState = () => {
    const s = store.getState();
    return {
        root: s.root,
        position: s.position,
        headers: s.headers,
        dirty: s.dirty,
        sourceStamp: s.sourceStamp,
        appendAttempted: s.appendAttempted,
        report: {
            inProgress: false,
            operationId: null,
        },
        boardStateMap: getMemoizedBoardStateMap(s.root, s.headers.start ?? []),
    };
};

// Helper to compute the derived boardStateMap for a given root and start path.
function expectedMap(root: TreeState["root"], start: number[] = []) {
    return getMemoizedBoardStateMap(root, start);
}

test("should handle save", () => {
    store.setState({ dirty: true });
    store.getState().save();

    expect(getNewState()).toStrictEqual({
        ...defaultTree(),
        dirty: false,
        boardStateMap: expectedMap(defaultTree().root),
    });
});

test("should handle setState", () => {
    const state = treeE4D5();
    store.getState().setState(state);
    expect(getNewState()).toStrictEqual({
        ...state,
        boardStateMap: expectedMap(state.root),
    });
});

test("should handle reset", () => {
    store.getState().setState(treeE4D5());
    store.getState().reset();
    expect(getNewState()).toStrictEqual({
        ...defaultTree(),
        boardStateMap: expectedMap(defaultTree().root),
    });
});

test("should handle setHeaders", () => {
    store.getState().setHeaders({
        ...defaultTree().headers,
        orientation: "black",
        start: [1],
    });

    expect(getNewState()).toStrictEqual({
        ...defaultTree(),
        dirty: true,
        headers: {
            ...defaultTree().headers,
            orientation: "black",
            start: [1],
        },
        boardStateMap: expectedMap(defaultTree().root, [1]),
    });
});

test("should handle setStart", () => {
    store.getState().setStart([1]);

    expect(getNewState()).toStrictEqual({
        ...defaultTree(),
        dirty: true,
        headers: { ...defaultTree().headers, start: [1] },
        boardStateMap: expectedMap(defaultTree().root, [1]),
    });
});

test("should handle makeMove", () => {
    store.getState().makeMove({ payload: e4 });

    expect(getNewState()).toStrictEqual({
        ...defaultTree(),
        dirty: true,
        position: [0],
        root: {
            ...defaultTree().root,
            children: [
                {
                    fen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
                    move: e4,
                    san: "e4",
                    children: [],
                    score: null,
                    clock: undefined,
                    depth: null,
                    halfMoves: 1,
                    shapes: [],
                    nags: [],
                    comment: "",
                },
            ],
        },
        boardStateMap: expectedMap({
            ...defaultTree().root,
            children: [
                {
                    fen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
                    move: e4,
                    san: "e4",
                    children: [],
                    score: null,
                    clock: undefined,
                    depth: null,
                    halfMoves: 1,
                    shapes: [],
                    nags: [],
                    comment: "",
                },
            ],
        }),
    });
});

test("should handle makeMoves", () => {
    store.getState().makeMoves({ payload: ["e4", "d5"] });

    const expectedTree = treeE4D5();
    expect(getNewState()).toStrictEqual({
        ...expectedTree,
        dirty: true,
        position: [0, 0],
        boardStateMap: expectedMap(expectedTree.root),
    });
});

test("should handle goToStart", () => {
    store.getState().setState(treeE4D5());
    store.getState().goToStart();

    expect(getNewState()).toStrictEqual({
        ...treeE4D5(),
        position: [],
        boardStateMap: expectedMap(treeE4D5().root),
    });
});

test("should handle goToEnd", () => {
    store.getState().setState({ ...treeE4D5(), position: [] });
    store.getState().goToEnd();

    expect(getNewState()).toStrictEqual({
        ...treeE4D5(),
        position: [0, 0],
        boardStateMap: expectedMap(treeE4D5().root),
    });
});

test("should handle goToNext", () => {
    store.getState().setState({ ...treeE4D5(), position: [] });
    store.getState().goToNext();

    expect(getNewState()).toStrictEqual({
        ...treeE4D5(),
        position: [0],
        boardStateMap: expectedMap(treeE4D5().root),
    });
});

test("should handle goToPrevious", () => {
    store.getState().setState({ ...treeE4D5(), position: [0] });
    store.getState().goToPrevious();

    expect(getNewState()).toStrictEqual({
        ...treeE4D5(),
        position: [],
        boardStateMap: expectedMap(treeE4D5().root),
    });
});

test("should handle goToBranchEnd", () => {
    store.getState().setState({ ...treeE4D5(), position: [] });
    store.getState().goToBranchEnd();

    expect(getNewState()).toStrictEqual({
        ...treeE4D5(),
        position: [0, 0],
        boardStateMap: expectedMap(treeE4D5().root),
    });
});

test("should handle goToBranchStart", () => {
    store.getState().setState({ ...treeE4D5(), position: [0, 0] });
    store.getState().goToBranchStart();

    expect(getNewState()).toStrictEqual({
        ...treeE4D5(),
        position: [],
        boardStateMap: expectedMap(treeE4D5().root),
    });
});

test("should handle goToMove", () => {
    store.getState().setState({ ...treeE4D5(), position: [] });
    store.getState().goToMove([0]);

    expect(getNewState()).toStrictEqual({
        ...treeE4D5(),
        position: [0],
        boardStateMap: expectedMap(treeE4D5().root),
    });
});

test("should handle deleteMove", () => {
    store.getState().setState(treeE4D5());
    store.getState().deleteMove([0]);

    expect(getNewState()).toStrictEqual({
        ...defaultTree(),
        dirty: true,
        boardStateMap: expectedMap(defaultTree().root),
    });
});

test("should handle setAnnotation", () => {
    store.getState().setState({ ...treeE4D5(), position: [0] });
    store.getState().setAnnotation("!");

    const mutatedRoot: TreeNode = {
        ...treeE4D5().root,
        children: [
            {
                ...treeE4D5().root.children[0],
                nags: [1],
            },
        ],
    };

    expect(getNewState()).toStrictEqual({
        ...treeE4D5(),
        dirty: true,
        position: [0],
        root: mutatedRoot,
        boardStateMap: expectedMap(mutatedRoot),
    });
});

test("should handle setComment", () => {
    store.getState().setState({ ...treeE4D5(), position: [0] });
    store.getState().setComment("test");

    const mutatedRoot: TreeNode = {
        ...treeE4D5().root,
        children: [
            {
                ...treeE4D5().root.children[0],
                comment: "test",
            },
        ],
    };

    expect(getNewState()).toStrictEqual({
        ...treeE4D5(),
        dirty: true,
        position: [0],
        root: mutatedRoot,
        boardStateMap: expectedMap(mutatedRoot),
    });
});

test("should handle setFen", () => {
    store.getState().setState({ ...treeE4D5(), position: [0] });
    const fen = "rnbq1bnr/ppppkppp/8/4p3/4P3/8/PPPPKPPP/RNBQ1BNR w - - 2 3";
    store.getState().setFen(fen);

    const newRoot = defaultTree(fen).root;
    expect(getNewState()).toStrictEqual({
        ...defaultTree(),
        dirty: true,
        root: newRoot,
        headers: { ...defaultTree().headers, fen },
        boardStateMap: expectedMap(newRoot),
    });
});

test("should handle setScore", () => {
    store.getState().setState({ ...treeE4D5(), position: [0] });
    store.getState().setScore({
        value: { type: "mate" as const, value: 1 },
        wdl: null,
    });

    const mutatedRoot: TreeNode = {
        ...treeE4D5().root,
        children: [
            {
                ...treeE4D5().root.children[0],
                score: {
                    value: { type: "mate" as const, value: 1 },
                    wdl: null,
                },
            },
        ],
    };

    expect(getNewState()).toStrictEqual({
        ...treeE4D5(),
        dirty: true,
        position: [0],
        root: mutatedRoot,
        boardStateMap: expectedMap(mutatedRoot),
    });
});

test("should handle setShapes", () => {
    store.getState().setState({ ...treeE4D5(), position: [0] });
    store.getState().setShapes([
        { brush: "red", orig: "e4", dest: "d5" },
        { brush: "green", orig: "a1", dest: undefined },
    ]);

    const mutatedRoot: TreeNode = {
        ...treeE4D5().root,
        children: [
            {
                ...treeE4D5().root.children[0],
                shapes: [
                    { brush: "red", orig: "e4", dest: "d5" },
                    { brush: "green", orig: "a1", dest: undefined },
                ],
            },
        ],
    };

    expect(getNewState()).toStrictEqual({
        ...treeE4D5(),
        dirty: true,
        position: [0],
        root: mutatedRoot,
        boardStateMap: expectedMap(mutatedRoot),
    });
});

test("declares threefold only on the third occurrence of the normal root", () => {
    for (const uci of ["g1f3", "g8f6", "f3g1", "f6g8"]) {
        store.getState().makeMove({ payload: parseUci(uci)! });
    }
    expect(store.getState().headers.result).toBe("*");

    for (const uci of ["g1f3", "g8f6", "f3g1", "f6g8"]) {
        store.getState().makeMove({ payload: parseUci(uci)! });
    }
    expect(store.getState().headers.result).toBe("1/2-1/2");
});

test("counts the actual custom root for threefold repetition", () => {
    store.getState().setFen("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1");
    for (const uci of ["g8f6", "g1f3", "f6g8", "f3g1"]) {
        store.getState().makeMove({ payload: parseUci(uci)! });
    }
    expect(store.getState().headers.result).toBe("*");

    for (const uci of ["g8f6", "g1f3", "f6g8", "f3g1"]) {
        store.getState().makeMove({ payload: parseUci(uci)! });
    }
    expect(store.getState().headers.result).toBe("1/2-1/2");
});

test("counts a custom root for threefold even when its FEN has doubled spaces", () => {
    const single = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 17";
    const doubled = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR  b KQkq - 0 17";
    const moves = ["Nf6", "Nf3", "Ng8", "Ng1", "Nf6", "Nf3", "Ng8", "Ng1"];

    store.getState().setFen(single);
    expect(store.getState().root.fen).toBe(single);
    store.getState().makeMoves({ payload: moves });
    const singleResult = store.getState().headers.result;
    expect(singleResult).toBe("1/2-1/2");

    store.getState().setState(defaultTree());
    store.getState().setFen(doubled);
    expect(store.getState().root.fen).toBe(doubled);
    store.getState().makeMoves({ payload: moves });
    expect(store.getState().headers.result).toBe(singleResult);
});

test("setScore clears a depth that described the replaced score", () => {
    const tree = treeE4D5();
    tree.root.children[0].depth = 61;
    store.getState().setState({ ...tree, position: [0] });
    store.getState().setScore({ value: { type: "cp" as const, value: 5 }, wdl: null });

    expect(getNewState().root.children[0].depth).toBeNull();
    const pgn = getPGN(getNewState().root, {
        headers: null,
        glyphs: true,
        comments: true,
        variations: true,
        extraMarkups: true,
    });
    expect(pgn).toContain("[%eval +0.05]");
});

test("should handle addAnalysis", () => {
    store.getState().setState({ ...treeE4D5(), position: [0] });
    store.getState().addAnalysis([
        {
            best: [
                {
                    depth: 1,
                    multipv: 1,
                    nodes: 1n,
                    score: {
                        value: {
                            type: "cp",
                            value: 10,
                        },
                        wdl: null,
                    },
                    nps: 1000n,
                    sanMoves: ["e4"],
                    uciMoves: ["e2e4"],
                },
            ],
            novelty: false,
            is_sacrifice: false,
        },
        {
            best: [
                {
                    depth: 1,
                    multipv: 1,
                    nodes: 1n,
                    score: {
                        value: {
                            type: "cp",
                            value: 20,
                        },
                        wdl: null,
                    },
                    nps: 1000n,
                    sanMoves: ["d5"],
                    uciMoves: ["d7d5"],
                },
            ],
            novelty: false,
            is_sacrifice: false,
        },
    ]);

    const expectedRoot: TreeNode = {
        ...treeE4D5().root,
        children: [
            {
                ...treeE4D5().root.children[0],
                score: {
                    value: { type: "cp" as const, value: 20 },
                    wdl: null,
                },
                // The engine depth travels with its score, so a save writes `[%eval x,depth]`.
                depth: 1,
            },
        ],
        score: {
            value: { type: "cp" as const, value: 10 },
            wdl: null,
        },
        depth: 1,
    };
    expect(getNewState()).toStrictEqual({
        ...treeE4D5(),
        dirty: true,
        position: [0],
        root: expectedRoot,
        boardStateMap: expectedMap(expectedRoot),
    });
});
const line = (value: number, san: string, uci: string) => ({
    best: [
        {
            depth: 1,
            multipv: 1,
            nodes: 1n,
            score: { value: { type: "cp" as const, value }, wdl: null },
            nps: 1000n,
            sanMoves: [san],
            uciMoves: [uci],
        },
    ],
    novelty: false,
    is_sacrifice: false,
});
// A ply whose UCI output was bound-only publishes no MultiPV set at all.
const noLines = { best: [], novelty: false, is_sacrifice: false };

const castlingFen = "r3k2r/ppp2ppp/8/8/8/8/PPP2PPP/R3K2R w KQkq - 0 1";

test("addAnalysis does not duplicate an existing SAN castling child", () => {
    store.getState().setFen(castlingFen);
    store.getState().makeMove({ payload: "O-O" });
    expect(store.getState().root.children[0].move).toEqual(parseUci("e1h1"));

    store.getState().addAnalysis([line(0, "O-O", "e1g1"), line(-400, "a6", "a7a6")], {
        showVariations: true,
    });

    const parent = store.getState().root;
    expect(parent.children[0].nags).toContain(4);
    expect(parent.children.filter((child) => child.san === "O-O")).toHaveLength(1);
    expect(parent.children).toHaveLength(1);
});

test("addAnalysis does not duplicate an existing raw UCI castling child", () => {
    store.getState().setFen(castlingFen);
    store.getState().makeMove({ payload: parseUci("e1g1")! });
    expect(store.getState().root.children[0].move).toEqual(parseUci("e1g1"));

    store.getState().addAnalysis([line(0, "O-O", "e1g1"), line(-400, "a6", "a7a6")], {
        showVariations: true,
    });

    const parent = store.getState().root;
    expect(parent.children[0].nags).toContain(4);
    expect(parent.children.filter((child) => child.san === "O-O")).toHaveLength(1);
    expect(parent.children).toHaveLength(1);
    expect(parent.children[0].move).toEqual(parseUci("e1g1"));
});

test("addAnalysis stores SAN-normalized castling moves throughout a generated PV", () => {
    store.getState().setFen(castlingFen);
    store.getState().makeMove({ payload: "a3" });
    const best = line(0, "O-O", "e1g1");
    best.best[0].sanMoves.push("O-O");
    best.best[0].uciMoves.push("e8g8");

    store.getState().addAnalysis([best, line(-400, "a6", "a7a6")], {
        showVariations: true,
    });

    const parent = store.getState().root;
    expect(parent.children[0].nags).toContain(4);
    expect(parent.children).toHaveLength(2);
    const variation = parent.children[1];
    const [parentPos] = positionFromFen(parent.fen);
    expect(variation.san).toBe("O-O");
    expect(variation.move).toEqual(parseSan(parentPos!, "O-O"));
    expect(variation.move).toEqual(parseUci("e1h1"));
    expect(variation.children).toHaveLength(1);
    const [variationPos] = positionFromFen(variation.fen);
    expect(variation.children[0].san).toBe("O-O");
    expect(variation.children[0].move).toEqual(parseSan(variationPos!, "O-O"));
    expect(variation.children[0].move).toEqual(parseUci("e8h8"));
});

test.each([
    { score: -70, code: 6 },
    { score: -140, code: 2 },
    { score: -400, code: 4 },
])("analysis report appends $code once without changing stored NAGs", ({ score, code }) => {
    const tree = treeE4D5();
    tree.root.children[0].nags = [8, 8, 220];
    store.getState().setState(tree);
    const analysis = [line(0, "e4", "e2e4"), { ...line(score, "d5", "d7d5"), novelty: true }];
    store.getState().addAnalysis(analysis);
    expect(store.getState().root.children[0].nags).toEqual([8, 8, 220, code, 146]);
    store.getState().addAnalysis(analysis);
    expect(store.getState().root.children[0].nags).toEqual([8, 8, 220, code, 146]);
});

test.each([
    { nags: [1], expected: [4] },
    { nags: [2], expected: [4] },
    { nags: [1, 220], expected: [220, 4] },
])("analysis report replaces basic NAGs of the same group with a blunder", ({ nags, expected }) => {
    const tree = treeE4D5();
    tree.root.children[0].nags = nags;
    store.getState().setState(tree);
    store.getState().addAnalysis([line(0, "e4", "e2e4"), line(-400, "d5", "d7d5")]);
    expect(store.getState().root.children[0].nags).toEqual(expected);
});

test("addAnalysis annotates a ply whose predecessor has no lines without inventing a score", () => {
    store.getState().setState({ ...treeE4D5(), position: [0] });
    store.getState().addAnalysis([line(10, "e4", "e2e4"), noLines, line(900, "d5", "d7d5")]);

    const state = getNewState();
    expect(state.root.score).toStrictEqual({
        value: { type: "cp", value: 10 },
        wdl: null,
    });
    expect(state.root.children[0].score).toBeNull();
    expect(state.root.children[0].children[0].score).toStrictEqual({
        value: { type: "cp", value: 900 },
        wdl: null,
    });
    // +900 measured against an invented 0.00 baseline for the missing ply would
    // read as a blunder by Black. With no predecessor evaluation, no mistake
    // annotation is derivable at all.
    expect(state.root.children[0].children[0].nags).toStrictEqual([]);
});

test("addAnalysis tolerates a previous-previous ply with no lines", () => {
    store.getState().setState({ ...treeE4D5(), position: [0] });
    store.getState().addAnalysis([noLines, line(10, "e4", "e2e4"), line(20, "d5", "d7d5")]);

    const state = getNewState();
    expect(state.root.score).toBeNull();
    expect(state.root.children[0].score).toStrictEqual({
        value: { type: "cp", value: 10 },
        wdl: null,
    });
    expect(state.root.children[0].children[0].score).toStrictEqual({
        value: { type: "cp", value: 20 },
        wdl: null,
    });
    expect(state.root.children[0].children[0].nags).toStrictEqual([]);
});

test("should handle promoteVariation", () => {
    store.getState().setState(treeE4D5Nf3());
    store.getState().promoteVariation([1]);

    expect(getNewState()).toStrictEqual({
        ...treeE4D5Nf3(),
        dirty: true,
        position: [1, 0],
        root: {
            ...treeE4D5Nf3().root,
            children: [
                {
                    ...treeE4D5Nf3().root.children[1],
                },
                {
                    ...treeE4D5Nf3().root.children[0],
                },
            ],
        },
        boardStateMap: expectedMap({
            ...treeE4D5Nf3().root,
            children: [
                {
                    ...treeE4D5Nf3().root.children[1],
                },
                {
                    ...treeE4D5Nf3().root.children[0],
                },
            ],
        }),
    });
});

// Helper to build a simple transposition tree:
// 1. e4 e5 2. Nf3 Nc6 (main line with children)
// and a side line 1. Nf3 Nc6 2. e4 e5 transposing to the same position after move 2.
const e4Move = parseUci("e2e4")!;
const e5Move = parseUci("e7e5")!;
const Nf3Move = parseUci("g1f3")!;
const Nc6Move = parseUci("b8c6")!;

const buildTranspositionTree = () => {
    const root: TreeNode = {
        ...defaultTree().root,
        children: [],
    };

    // Main line: e4 e5 Nf3 Nc6
    const e4Node: TreeNode = {
        fen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
        move: e4Move,
        san: "e4",
        children: [],
        score: null,
        depth: null,
        halfMoves: 1,
        shapes: [],
        nags: [],
        comment: "",
    };
    const e5Node: TreeNode = {
        fen: "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2",
        move: e5Move,
        san: "e5",
        children: [],
        score: null,
        depth: null,
        halfMoves: 2,
        shapes: [],
        nags: [],
        comment: "",
    };
    const Nf3NodeMain: TreeNode = {
        fen: "rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2",
        move: Nf3Move,
        san: "Nf3",
        children: [],
        score: null,
        depth: null,
        halfMoves: 3,
        shapes: [],
        nags: [],
        comment: "",
    };
    const Nc6NodeMain: TreeNode = {
        fen: "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3",
        move: Nc6Move,
        san: "Nc6",
        children: [
            {
                fen: "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3", // same fen but after playing? Actually need to be a child of Nc6: for simplicity, we'll just give it a child so it has children
                move: parseUci("f1b5")!,
                san: "Bb5",
                children: [],
                score: null,
                depth: null,
                halfMoves: 4,
                shapes: [],
                nags: [],
                comment: "",
            },
        ],
        score: null,
        depth: null,
        halfMoves: 4,
        shapes: [],
        nags: [],
        comment: "",
    };

    // Side line: Nf3 Nc6 e4 e5 transposing
    const Nf3NodeSide: TreeNode = {
        fen: "rnbqkbnr/pppppppp/8/8/8/5N2/PPPPPPPP/RNBQKB1R b KQkq - 1 1",
        move: Nf3Move,
        san: "Nf3",
        children: [],
        score: null,
        depth: null,
        halfMoves: 1,
        shapes: [],
        nags: [],
        comment: "",
    };
    const Nc6NodeSide: TreeNode = {
        fen: "r1bqkbnr/pppppppp/2n5/8/8/5N2/PPPPPPPP/RNBQKB1R w KQkq - 2 2",
        move: Nc6Move,
        san: "Nc6",
        children: [],
        score: null,
        depth: null,
        halfMoves: 2,
        shapes: [],
        nags: [],
        comment: "",
    };
    const e4NodeSide: TreeNode = {
        fen: "r1bqkbnr/pppppppp/2n5/8/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 0 2", // after e4
        move: e4Move,
        san: "e4",
        children: [],
        score: null,
        depth: null,
        halfMoves: 3,
        shapes: [],
        nags: [],
        comment: "",
    };
    const e5NodeSide: TreeNode = {
        fen: "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 0 3",
        move: e5Move,
        san: "e5",
        children: [], // this is the transposition node, has no children in side line
        score: null,
        depth: null,
        halfMoves: 4,
        shapes: [],
        nags: [],
        comment: "",
    };

    // connect main line
    e4Node.children = [e5Node];
    e5Node.children = [Nf3NodeMain];
    Nf3NodeMain.children = [Nc6NodeMain];

    // connect side line
    Nf3NodeSide.children = [Nc6NodeSide];
    Nc6NodeSide.children = [e4NodeSide];
    e4NodeSide.children = [e5NodeSide];

    // root has two branches: e4 (index 0) and Nf3 (index 1)
    root.children = [e4Node, Nf3NodeSide];

    return root;
};

test("goToNext transposition fallback: jump to transposition with children", () => {
    const root = buildTranspositionTree();
    store.getState().setState({
        ...defaultTree(),
        root,
        position: [1, 0, 0, 0], // side line after 1. Nf3 Nc6 e4 e5 (node with no children)
    });

    store.getState().goToNext();

    const state = getNewState();
    // Should have jumped to the main line Nc6 node's first child
    expect(state.position).toEqual([0, 0, 0, 0, 0]); // main line e4 e5 Nf3 Nc6 Bb5
});

test("goToNext transposition fallback: no fallback when no transposition has children", () => {
    // Build a tree where a side line transposes but no node has children
    const rootNoChildren = {
        ...defaultTree().root,
        children: [
            {
                fen: "start",
                move: e4Move,
                san: "e4",
                children: [],
                score: null,
                depth: null,
                halfMoves: 1,
                shapes: [],
                nags: [],
                comment: "",
            },
            {
                fen: "start",
                move: Nf3Move,
                san: "Nf3",
                children: [],
                score: null,
                depth: null,
                halfMoves: 1,
                shapes: [],
                nags: [],
                comment: "",
            },
        ],
    };
    store.getState().setState({ ...defaultTree(), root: rootNoChildren, position: [1] });
    const posBefore = store.getState().position;
    store.getState().goToNext();
    expect(store.getState().position).toEqual(posBefore); // no change
});

test("goToNext transposition fallback: lexicographic priority", () => {
    // Shared board state: after 1. e4 e5 2. Nf3
    const sharedFen = "rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2";

    // Two nodes that HAVE children and share the same FEN (transposition targets)
    const nodeWithChildA: TreeNode = {
        fen: sharedFen,
        move: Nf3Move,
        san: "Nf3",
        children: [
            {
                // Child gets a distinct but valid FEN
                fen: "rnbqkb1r/pppp1ppp/5n2/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3",
                move: parseUci("b8c6")!,
                san: "Nc6",
                children: [],
                score: null,
                depth: null,
                halfMoves: 3,
                shapes: [],
                nags: [],
                comment: "",
            },
        ],
        score: null,
        depth: null,
        halfMoves: 2,
        shapes: [],
        nags: [],
        comment: "",
    };
    const nodeWithChildB: TreeNode = {
        fen: sharedFen,
        move: Nf3Move,
        san: "Nf3",
        children: [
            {
                fen: "rnbqkb1r/pppp1ppp/5n2/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 4 3", // different move counter makes it distinct but board state identical
                move: parseUci("d2d4")!,
                san: "d4",
                children: [],
                score: null,
                depth: null,
                halfMoves: 3,
                shapes: [],
                nags: [],
                comment: "",
            },
        ],
        score: null,
        depth: null,
        halfMoves: 2,
        shapes: [],
        nags: [],
        comment: "",
    };

    // A third node that shares the FEN but has NO children.
    // goToNext from here should trigger transposition fallback.
    const nodeNoChild: TreeNode = {
        fen: sharedFen,
        move: Nf3Move,
        san: "Nf3",
        children: [],
        score: null,
        depth: null,
        halfMoves: 2,
        shapes: [],
        nags: [],
        comment: "",
    };

    // Build tree:
    // branch 0 -> nodeWithChildA (path [0,0])
    // branch 1 -> nodeWithChildB (path [1,0])
    // branch 2 -> nodeNoChild   (path [2,0])
    const root: TreeNode = {
        ...defaultTree().root,
        children: [
            {
                fen: defaultTree().root.fen,
                move: e4Move,
                san: "e4",
                children: [nodeWithChildA],
                score: null,
                depth: null,
                halfMoves: 1,
                shapes: [],
                nags: [],
                comment: "",
            },
            {
                fen: defaultTree().root.fen,
                move: Nf3Move,
                san: "Nf3",
                children: [nodeWithChildB],
                score: null,
                depth: null,
                halfMoves: 1,
                shapes: [],
                nags: [],
                comment: "",
            },
            {
                fen: defaultTree().root.fen,
                move: parseUci("d2d4")!,
                san: "d4",
                children: [nodeNoChild],
                score: null,
                depth: null,
                halfMoves: 1,
                shapes: [],
                nags: [],
                comment: "",
            },
        ],
    };

    store.getState().setState({ ...defaultTree(), root, position: [2, 0] }); // start at nodeNoChild
    store.getState().goToNext();
    const state = getNewState();
    // Should pick path [0,0] (nodeWithChildA) because it's lexicographically smaller than [1,0]
    expect(state.position).toEqual([0, 0, 0]); // first child of nodeWithChildA
});

test("boardStateMap updates when start changes", () => {
    store.getState().setState(treeE4D5());
    store.getState().setStart([0]); // start at e4 node
    const state = getNewState();
    // The derived map should now only contain nodes from e4 onward.
    const entries = Object.values(state.boardStateMap);
    // There should be at least one entry for the e4 node fen and its child
    expect(entries.length).toBeGreaterThan(0);
    // Make sure the root fen is not in the map (since start excludes it)
    const rootFen = defaultTree().root.fen;
    expect(state.boardStateMap[rootFen]).toBeUndefined();
});

test("practice mode: goToNext does not jump to a transposition at the end of the drill", () => {
    const root = buildTranspositionTree();
    store.getState().setState({
        ...defaultTree(),
        root,
        position: [1, 0, 0, 0], // side line, no children
    });
    store.getState().setPracticePath([1, 0, 0, 0]); // end of drill

    store.getState().goToNext();
    const state = getNewState();
    expect(state.position).toEqual([1, 0, 0, 0]);
});

test("practice mode: goToNext does not advance from an off-path cursor", () => {
    const root = buildTranspositionTree();
    expect(root.children[0].children.length).toBeGreaterThan(0);

    store.getState().setState({ ...defaultTree(), root, position: [0] });
    store.getState().setPracticePath([1, 0]);

    store.getState().goToNext();

    expect(store.getState().position).toEqual([0]);
});

test("practice mode: goToNext does not use transposition fallback past the drill path", () => {
    const sharedFen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1";
    const target: TreeNode = {
        ...defaultTree().root,
        fen: sharedFen,
        move: Nf3Move,
        san: "Nf3",
        children: [
            {
                ...defaultTree().root,
                fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 1 2",
                move: Nc6Move,
                san: "Nc6",
            },
        ],
    };
    const root: TreeNode = {
        ...defaultTree().root,
        children: [
            {
                ...defaultTree().root,
                move: e4Move,
                san: "e4",
                children: [{ ...target, children: [] }],
            },
            target,
        ],
    };
    expect(root.children[0].children[0].children).toHaveLength(0);
    expect(root.children[1].children.length).toBeGreaterThan(0);

    store.getState().setState({ ...defaultTree(), root, position: [0, 0] });
    store.getState().setPracticePath([1]);

    store.getState().goToNext();

    expect(store.getState().position).toEqual([0, 0]);
});

test("practice mode: goToNext follows the drill path and stops at its end", () => {
    const navigationNode = (san: string, move: typeof e4Move, children: TreeNode[] = []) => ({
        ...defaultTree().root,
        move,
        san,
        children,
    });
    const root: TreeNode = {
        ...defaultTree().root,
        children: [
            navigationNode("e4", e4Move),
            navigationNode("Nf3", Nf3Move, [
                navigationNode("e5", e5Move),
                navigationNode("Nc6", Nc6Move, [navigationNode("Bb5", parseUci("f1b5")!)]),
            ]),
        ],
    };
    expect(root.children[1].children[1].children.length).toBeGreaterThan(0);

    store.getState().setState({ ...defaultTree(), root });
    store.getState().setPracticePath([1, 1]);

    store.getState().goToNext();
    expect(store.getState().position).toEqual([1]);

    store.getState().goToNext();
    expect(store.getState().position).toEqual([1, 1]);

    store.getState().goToNext();
    expect(store.getState().position).toEqual([1, 1]);
});
