import { parseUci } from "chessops";
import { parseSan } from "chessops/san";
import { produce } from "immer";
import { beforeEach, expect, test } from "vitest";
import type { GameAnalysis, ReportPosition } from "@/bindings";
import { createTreeStore, type ReportRequest } from "@/state/store/tree";
import { getGameStats, getMainLine, getPGN, reportRootFingerprint } from "../chess";
import { positionFromFen } from "../chessops";
import {
    defaultTree,
    displayedScore,
    getMemoizedBoardStateMap,
    type TreeNode,
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

test("setEngineScore records a view-only score without marking the tab unsaved", () => {
    store.getState().setState({ ...treeE4D5(), position: [0] });
    store.getState().setEngineScore({
        value: { type: "mate" as const, value: 1 },
        wdl: null,
    });

    const mutatedRoot: TreeNode = {
        ...treeE4D5().root,
        children: [
            {
                ...treeE4D5().root.children[0],
                engineScore: {
                    value: { type: "mate" as const, value: 1 },
                    wdl: null,
                },
            },
        ],
    };

    expect(getNewState()).toStrictEqual({
        ...treeE4D5(),
        dirty: false,
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

test("setEngineScore leaves the source evaluation and the serialized PGN unchanged", () => {
    const tree = treeE4D5();
    tree.root.children[0].score = { value: { type: "cp" as const, value: 30 }, wdl: null };
    tree.root.children[0].depth = 61;
    store.getState().setState({ ...tree, position: [0] });
    const serialize = () =>
        getPGN(getNewState().root, {
            headers: null,
            glyphs: true,
            comments: true,
            variations: true,
            extraMarkups: true,
        });
    const before = serialize();
    store.getState().setEngineScore({ value: { type: "cp" as const, value: 5 }, wdl: null });

    const node = getNewState().root.children[0];
    expect(node.score).toEqual({ value: { type: "cp", value: 30 }, wdl: null });
    expect(node.depth).toBe(61);
    expect(displayedScore(node)).toEqual({ value: { type: "cp", value: 5 }, wdl: null });
    expect(getNewState().dirty).toBe(false);
    expect(serialize()).toBe(before);
    expect(before).toContain("[%eval +0.30,61]");
    expect(before).not.toContain("+0.05");
});

type Position = ReportPosition;
const cpLine = (value: number, uci: string, depth = 1): Position["best"][number] => ({
    depth,
    multipv: 1,
    nodes: 1n,
    score: { value: { type: "cp", value }, wdl: null },
    nps: 1000n,
    sanMoves: [uci],
    uciMoves: [uci],
});
/** A report position with one line per `[score, uci]` pair. */
const at = (...lines: [number, string][]): Position => ({
    best: lines.map(([value, uci], index) => ({ ...cpLine(value, uci), multipv: index + 1 })),
    terminal: null,
    isSacrifice: false,
});
// A ply whose UCI output was bound-only publishes no line at all.
const noLines: Position = { best: [], terminal: null, isSacrifice: false };
const drawn: Position = { best: [], terminal: "draw", isSacrifice: false };
const NOT_REQUESTED = { kind: "notRequested" } as const;
const REPORT_OPERATION = "report-operation";

/** Applies a report as the tab's current operation, on the game as it stands. */
function runReport(
    positions: Position[],
    novelty: GameAnalysis["novelty"] = NOT_REQUESTED,
    request: Partial<ReportRequest> = {},
) {
    const state = store.getState();
    state.setReportOperationId(request.operationId ?? REPORT_OPERATION);
    const { root } = store.getState();
    return store.getState().applyReport(
        { positions, novelty },
        {
            operationId: REPORT_OPERATION,
            fingerprint: reportRootFingerprint(root.fen, getMainLine(root)),
            engine: "Stockfish 17",
            goMode: { t: "Time", c: 500 },
            marks: true,
            lines: true,
            createdAt: 1_700_000_000_000,
            ...request,
        },
    );
}

test("applyReport replaces the shown live score with the report's evaluation", () => {
    store.getState().setState({ ...treeE4D5(), position: [0] });
    store.getState().setEngineScore({ value: { type: "cp" as const, value: 5 }, wdl: null });
    expect(runReport([noLines, at([40, "d7d5"]), noLines])).toBe(true);

    const node = getNewState().root.children[0];
    expect(node.engineScore).toBeUndefined();
    expect(displayedScore(node)).toEqual({ value: { type: "cp", value: 40 }, wdl: null });
    expect(getNewState().dirty).toBe(true);
});

test("applyReport writes every evaluation with its depth and records the summary", () => {
    store.getState().setState({ ...treeE4D5(), position: [0] });
    runReport([at([10, "e2e4"]), at([20, "d7d5"]), at([15, "g1f3"])]);

    const expectedRoot: TreeNode = {
        ...treeE4D5().root,
        children: [
            {
                ...treeE4D5().root.children[0],
                score: { value: { type: "cp" as const, value: 20 }, wdl: null },
                // The engine depth travels with its score, so a save writes `[%eval x,depth]`.
                depth: 1,
                children: [
                    {
                        ...treeE4D5().root.children[0].children[0],
                        score: { value: { type: "cp" as const, value: 15 }, wdl: null },
                        depth: 1,
                    },
                ],
            },
        ],
        score: { value: { type: "cp" as const, value: 10 }, wdl: null },
        depth: 1,
    };
    expect(getNewState()).toStrictEqual({
        ...treeE4D5(),
        dirty: true,
        position: [0],
        root: expectedRoot,
        boardStateMap: expectedMap(expectedRoot),
    });
    const { root, report } = store.getState();
    expect(report.summary).toEqual({
        engine: "Stockfish 17",
        goMode: { t: "Time", c: 500 },
        createdAt: 1_700_000_000_000,
        missingEvaluations: 0,
        novelty: "notRequested",
        fingerprint: reportRootFingerprint(root.fen, getMainLine(root)),
    });
});

test("applyReport refuses a result of an older operation on the unchanged game", () => {
    store.getState().setState(treeE4D5());
    const before = store.getState().root;
    store.getState().setReportOperationId("newer-operation");
    const applied = store.getState().applyReport(
        { positions: [at([0, "e2e4"]), at([-400, "d7d5"]), noLines], novelty: NOT_REQUESTED },
        {
            operationId: "older-operation",
            fingerprint: reportRootFingerprint(before.fen, getMainLine(before)),
            engine: "Stockfish 17",
            goMode: { t: "Time", c: 500 },
            marks: true,
            lines: true,
            createdAt: 1,
        },
    );
    expect(applied).toBe(false);
    expect(store.getState().root).toBe(before);
    expect(store.getState().report.summary ?? null).toBeNull();
    expect(store.getState().dirty).toBe(false);
});

test("applyReport refuses a result for another game", () => {
    store.getState().setState(treeE4D5());
    const before = store.getState().root;
    expect(
        runReport([noLines, noLines, noLines], NOT_REQUESTED, {
            fingerprint: reportRootFingerprint(before.fen, ["e2e4"]),
        }),
    ).toBe(false);
    expect(store.getState().root).toBe(before);
});

const castlingFen = "r3k2r/ppp2ppp/8/8/8/8/PPP2PPP/R3K2R w KQkq - 0 1";

/** 1.a3 with a castle already in the tree as a variation (`castle` as the tree spells it). */
function castleBesideA3(castle: string | ReturnType<typeof parseUci>) {
    store.getState().setFen(castlingFen);
    store.getState().makeMove({ payload: "a3" });
    store.getState().goToStart();
    store.getState().makeMove({ payload: castle! });
    store.getState().goToStart();
}

test("applyReport does not duplicate an existing SAN castling child", () => {
    castleBesideA3("O-O");
    expect(store.getState().root.children[1].move).toEqual(parseUci("e1h1"));

    runReport([at([0, "e1g1"]), at([-400, "a7a6"])]);

    const parent = store.getState().root;
    expect(parent.children[0].nags).toContain(4);
    expect(parent.children.filter((child) => child.san === "O-O")).toHaveLength(1);
    expect(parent.children).toHaveLength(2);
});

test("applyReport does not duplicate an existing raw UCI castling child", () => {
    castleBesideA3(parseUci("e1g1"));
    expect(store.getState().root.children[1].move).toEqual(parseUci("e1g1"));

    runReport([at([0, "e1g1"]), at([-400, "a7a6"])]);

    const parent = store.getState().root;
    expect(parent.children[0].nags).toContain(4);
    expect(parent.children.filter((child) => child.san === "O-O")).toHaveLength(1);
    expect(parent.children).toHaveLength(2);
    expect(parent.children[1].move).toEqual(parseUci("e1g1"));
});

test("applyReport stores SAN-normalized castling moves throughout a generated line", () => {
    store.getState().setFen(castlingFen);
    store.getState().makeMove({ payload: "a3" });
    const best = at([0, "e1g1"]);
    best.best[0].uciMoves.push("e8g8");

    runReport([best, at([-400, "a7a6"])]);

    const parent = store.getState().root;
    expect(parent.children[0].nags).toContain(4);
    expect(parent.children).toHaveLength(2);
    const variation = parent.children[1];
    const [parentPos] = positionFromFen(parent.fen);
    expect(variation.san).toBe("O-O");
    expect(variation.move).toEqual(parseSan(parentPos!, "O-O"));
    expect(variation.move).toEqual(parseUci("e1h1"));
    expect(variation.reportLine).toBe(true);
    expect(variation.score).toEqual({ value: { type: "cp", value: 0 }, wdl: null });
    expect(variation.children).toHaveLength(1);
    const [variationPos] = positionFromFen(variation.fen);
    expect(variation.children[0].san).toBe("O-O");
    expect(variation.children[0].move).toEqual(parseSan(variationPos!, "O-O"));
    expect(variation.children[0].move).toEqual(parseUci("e8h8"));
    expect(variation.children[0].reportLine).toBeUndefined();
});

test("applyReport ends a better line at its first illegal move", () => {
    store.getState().setState(treeE4D5());
    const best = at([0, "d2d4"]);
    best.best[0].uciMoves.push("d7d5", "e1e8", "c2c4");
    runReport([best, at([-400, "e7e5"]), noLines]);
    const variation = store.getState().root.children[1];
    expect(variation.san).toBe("d4");
    expect(variation.children.map((child) => child.san)).toEqual(["d5"]);
    expect(variation.children[0].children).toEqual([]);
});

test.each([
    { score: -70, code: 6 },
    { score: -140, code: 2 },
    { score: -400, code: 4 },
])("a report writes mark $code once and keeps the marks of other groups", ({ score, code }) => {
    const tree = treeE4D5();
    tree.root.children[0].nags = [8, 8, 220];
    store.getState().setState(tree);
    const positions = [at([0, "d2d4"]), at([score, "d7d5"]), noLines];
    const novelty = { kind: "found", position: 1 } as const;
    runReport(positions, novelty);
    expect(store.getState().root.children[0].nags).toEqual([8, 8, 220, code, 146]);
    runReport(positions, novelty);
    expect(store.getState().root.children[0].nags).toEqual([8, 8, 220, code, 146]);
});

test("a report never puts the novelty glyph on the root", () => {
    store.getState().setState(treeE4D5());
    runReport([at([0, "e2e4"]), at([0, "d7d5"]), noLines], { kind: "found", position: 0 });
    expect(store.getState().root.nags).not.toContain(146);
});

test.each([
    { nags: [1], expected: [4] },
    { nags: [2], expected: [4] },
    { nags: [1, 220], expected: [220, 4] },
])("a report replaces the move-quality marks with a blunder", ({ nags, expected }) => {
    const tree = treeE4D5();
    tree.root.children[0].nags = nags;
    store.getState().setState(tree);
    runReport([at([0, "d2d4"]), at([-400, "d7d5"]), noLines]);
    expect(store.getState().root.children[0].nags).toEqual(expected);
});

test("a report without marks leaves every mark alone", () => {
    const tree = treeE4D5();
    tree.root.children[0].nags = [1, 220];
    store.getState().setState(tree);
    runReport([at([0, "d2d4"]), at([-400, "d7d5"]), noLines], NOT_REQUESTED, { marks: false });
    expect(store.getState().root.children[0].nags).toEqual([1, 220]);
    expect(store.getState().root.children[0].score?.value).toEqual({ type: "cp", value: -400 });
});

test("a report judges a ply whose predecessor has no lines without inventing a score", () => {
    store.getState().setState({ ...treeE4D5(), position: [0] });
    runReport([at([10, "e2e4"]), noLines, at([900, "g1f3"])]);

    const state = getNewState();
    expect(state.root.score).toStrictEqual({ value: { type: "cp", value: 10 }, wdl: null });
    expect(state.root.children[0].score).toBeNull();
    expect(state.root.children[0].children[0].score).toStrictEqual({
        value: { type: "cp", value: 900 },
        wdl: null,
    });
    expect(state.root.children[0].children[0].nags).toStrictEqual([]);
    expect(store.getState().report.summary?.missingEvaluations).toBe(1);
});

test("a re-run replaces marks, the novelty, report lines and stale scores", () => {
    store.getState().setState(treeE4D5());
    runReport([at([0, "d2d4"]), at([-400, "e7e5"]), at([-380, "g1f3"])], {
        kind: "found",
        position: 1,
    });
    let root = store.getState().root;
    expect(root.children[0].nags).toEqual([4, 146]);
    expect(root.children.map((child) => child.san)).toEqual(["e4", "d4"]);
    expect(root.children[0].children[0].score?.value).toEqual({ type: "cp", value: -380 });

    // The second run finds 1.e4 fine, cannot evaluate the last position and puts the novelty on
    // 1...d5.
    runReport([at([20, "e2e4"]), at([25, "d7d5"]), noLines], { kind: "found", position: 2 });
    root = store.getState().root;
    expect(root.children[0].nags).toEqual([]);
    expect(root.children[0].children[0].nags).toEqual([146]);
    expect(root.children.map((child) => child.san)).toEqual(["e4"]);
    expect(root.children[0].score?.value).toEqual({ type: "cp", value: 25 });
    expect(root.children[0].children[0].score).toBeNull();
    expect(root.children[0].children[0].depth).toBeNull();
});

test("an unavailable novelty leaves the N mark alone; a not-found novelty removes it", () => {
    const tree = treeE4D5();
    tree.root.children[0].nags = [146];
    store.getState().setState(tree);
    runReport([at([0, "e2e4"]), at([0, "d7d5"]), noLines], { kind: "unavailable" });
    expect(store.getState().root.children[0].nags).toEqual([146]);
    runReport([at([0, "e2e4"]), at([0, "d7d5"]), noLines], { kind: "notFound" });
    expect(store.getState().root.children[0].nags).toEqual([]);
});

/** Mainline from `fen` through the given SAN moves. */
function playFrom(fen: string, moves: string[]) {
    store.getState().setFen(fen);
    for (const move of moves) store.getState().makeMove({ payload: move });
}

test("a stalemate result saves 0.00, judges the last move and counts it", () => {
    playFrom("7k/8/7K/5Q2/8/8/8/8 w - - 0 1", ["Qf7"]);
    runReport([at([500, "f5f6"]), drawn]);
    const { root } = store.getState();
    expect(root.children[0].score).toEqual({ value: { type: "cp", value: 0 }, wdl: null });
    expect(root.children[0].nags).toEqual([4]);
    expect(getGameStats(root).white.acpl).toBeGreaterThan(0);
});

test("a bare-kings result saves 0.00 once and moves played on after it stay unscored", () => {
    playFrom("8/8/8/4k3/8/3p4/8/2N1K3 w - - 0 1", ["Nxd3", "Ke4", "Ke2"]);
    const stale = { value: { type: "cp" as const, value: 300 }, wdl: null };
    store.setState(
        produce((state: ReturnType<typeof store.getState>) => {
            state.root.children[0].children[0].score = stale;
        }),
    );
    runReport([at([500, "e1e2"]), drawn, drawn, drawn]);
    const { root } = store.getState();
    const nxd3 = root.children[0];
    expect(nxd3.score).toEqual({ value: { type: "cp", value: 0 }, wdl: null });
    expect(nxd3.nags).toEqual([4]);
    expect(nxd3.children[0].score).toBeNull();
    expect(nxd3.children[0].children[0].score).toBeNull();
    const stats = getGameStats(root);
    // Only the move into bare kings is scored: White's one move, nothing for Black.
    expect(stats.black.acpl).toBeNull();
    expect(stats.white.acpl).toBe(500);
});

test("applyReport records review facts even when marks and lines options are off", () => {
    store.getState().setState(treeE4D5());
    const best = at([0, "d2d4"]);
    best.best[0].uciMoves.push("d7d5");
    expect(
        runReport([best, at([-400, "e7e5"]), noLines], NOT_REQUESTED, {
            marks: false,
            lines: false,
        }),
    ).toBe(true);
    const { root, report } = store.getState();
    // No marks or variation lines written to the tree when both options are off.
    expect(root.children[0].nags).toEqual([]);
    expect(root.children).toHaveLength(1);
    // Facts are still written on the summary.
    expect(report.summary?.facts).toEqual([
        { mainlineIndex: 1, kind: "decisive", betterLine: ["d4", "d5"] },
    ]);
});

test("applyReport caps persisted review facts at 256 in game order", () => {
    store.getState().setState(defaultTree());
    const cycle = ["Nf3", "Nf6", "Ng1", "Ng8"];
    for (let i = 0; i < 65; i++) {
        for (const san of cycle) store.getState().makeMove({ payload: san });
    }
    // 260 moves; alternate +400 / -400 on non-first-choice moves so every move is a blunder.
    const positions: Position[] = [at([0, "e2e4"])];
    for (let ply = 1; ply <= 260; ply++) {
        // Mover at odd ply is White (wants +), at even ply is Black (wants -).
        // Score after ply is bad for whoever just moved: -400 after White, +400 after Black.
        const scoreAfter = ply % 2 === 1 ? -400 : 400;
        const bestUci = ply % 2 === 1 ? "e7e5" : "e2e4";
        positions.push(at([scoreAfter, bestUci]));
    }
    expect(runReport(positions, NOT_REQUESTED, { marks: false, lines: false })).toBe(true);
    const facts = store.getState().report.summary?.facts ?? [];
    expect(facts).toHaveLength(256);
    expect(facts[0].mainlineIndex).toBe(1);
    expect(facts[255].mainlineIndex).toBe(256);
});

/** 1.e4 (1.d4 report line) (1.c4) d5, with the report line from an earlier run. */
function treeWithReportLine() {
    store.getState().setState(treeE4D5());
    runReport([at([0, "d2d4"]), at([-400, "e7e5"]), noLines]);
    store.getState().goToStart();
    store.getState().makeMove({ payload: "c4" });
    const { root } = store.getState();
    expect(root.children.map((child) => child.san)).toEqual(["e4", "d4", "c4"]);
    expect(root.children[1].reportLine).toBe(true);
}

test.each([
    { name: "on the line", target: [1], expected: [] },
    { name: "on a later sibling", target: [2], expected: [1] },
])(
    "removing a report line rebases the cursor, start and practice path $name",
    ({ target, expected }) => {
        treeWithReportLine();
        store.getState().goToMove(target);
        store.getState().setStart(target);
        store.getState().setPracticePath(target);
        runReport([at([20, "e2e4"]), at([25, "d7d5"]), noLines]);
        const state = store.getState();
        expect(state.root.children.map((child) => child.san)).toEqual(["e4", "c4"]);
        expect(state.position).toEqual(expected);
        expect(state.practicePath).toEqual(expected);
        expect(state.headers.start).toEqual(expected.length ? expected : undefined);
    },
);

test("a report line the user promoted into the main line is never removed", () => {
    store.getState().setState(treeE4D5());
    runReport([at([0, "d2d4"]), at([-400, "e7e5"]), noLines]);
    store.getState().promoteVariation([1]);
    const promoted = store.getState().root.children[0];
    expect(promoted.san).toBe("d4");
    expect(promoted.reportLine).toBe(true);
    runReport([at([0, "d2d4"]), at([0, "d7d5"])]);
    expect(store.getState().root.children[0]).toMatchObject({ san: "d4", reportLine: true });
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

test("toggleDiagram flips the marker of the current node, a variation path and the root", () => {
    const store = createTreeStore();
    store.getState().setState(treeE4D5());
    store.getState().goToMove([0]);
    store.getState().makeMove({ payload: parseUci("c7c5")!, changePosition: false });

    store.getState().toggleDiagram();
    expect(store.getState().root.children[0].diagram).toBe(true);
    store.getState().toggleDiagram();
    expect("diagram" in store.getState().root.children[0]).toBe(false);

    store.getState().toggleDiagram([0, 1]);
    expect(store.getState().root.children[0].children[1].san).toBe("c5");
    expect(store.getState().root.children[0].children[1].diagram).toBe(true);
    expect(store.getState().root.children[0].children[0].diagram).toBeUndefined();

    store.getState().toggleDiagram([]);
    expect(store.getState().root.diagram).toBe(true);
});

test("toggleDiagram ignores a path that does not resolve to a node", () => {
    const store = createTreeStore();
    store.getState().setState(treeE4D5());
    const before = store.getState().root;
    store.getState().toggleDiagram([0, 0, 0, 0]);
    store.getState().toggleDiagram([5]);
    store.getState().toggleDiagram("0" as unknown as number[]);
    expect(store.getState().root).toBe(before);
    expect(store.getState().dirty).toBe(false);

    store.getState().toggleDiagram([0]);
    expect(store.getState().dirty).toBe(true);
});
