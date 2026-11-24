import { expect, test, vi } from "vitest";
import type { DatabaseHandle, FileWorkspaceHandle } from "@/bindings";
import { buildFromTree } from "@/components/files/opening";
import { createTreeStore } from "@/state/store/tree";
import type { TreeStatistics } from "@/utils/repertoire";
import { getBoardState } from "@/utils/treeReducer";
import type { Position } from "@/utils/practicePosition";
import { prepareTimedRunWeights, type TimedRunPrepareDeps } from "./prepareTimedRun";

const database: DatabaseHandle = { id: { id: "reference" }, kind: "database" };
const handle = (id: string): FileWorkspaceHandle => ({ kind: "fileWorkspace", id: { id } });

function italianTree() {
    const store = createTreeStore();
    expect(store.getState().makeMoves({ payload: ["e4", "e5", "Nf3"] }).success).toBe(true);
    return store.getState();
}

function e5Stats(rootFenChild: string): TreeStatistics {
    return new Map([
        [
            rootFenChild,
            {
                moves: [
                    { move: "e5", white: 30, draw: 0, black: 0 },
                    { move: "c5", white: 70, draw: 0, black: 0 },
                ],
                total: 100,
            },
        ],
    ]);
}

test("loads unweighted chapters, issues one batch request, writes and awaits before returning", async () => {
    const treeA = italianTree();
    const treeB = italianTree();
    const positionsA = buildFromTree(treeA.root, "white", []);
    const positionsB = buildFromTree(treeB.root, "white", []).map((position) => ({
        ...position,
        weight: 0.4,
    }));
    const positionsC = buildFromTree(treeA.root, "white", []);
    const loadTree = vi.fn(async (_handle: FileWorkspaceHandle, game: number) =>
        game === 0
            ? { root: treeA.root, headers: treeA.headers }
            : { root: treeB.root, headers: treeB.headers },
    );
    const writeOrder: string[] = [];
    const writeDeck = vi.fn(async (file: string, game: number, _positions: Position[]) => {
        writeOrder.push(`${file}:${game}:start`);
        await new Promise((resolve) => setTimeout(resolve, 0));
        writeOrder.push(`${file}:${game}:done`);
    });
    const fetchStatistics = vi.fn<NonNullable<TimedRunPrepareDeps["fetchStatistics"]>>(
        async (trees) => {
            expect(trees).toHaveLength(2);
            return e5Stats(getBoardState(treeA.root.children[0].fen));
        },
    );
    let finishedBeforeWrites = false;
    const resultPromise = prepareTimedRunWeights({
        chapters: [
            { file: "a", game: 0, handle: handle("a"), positions: positionsA },
            { file: "b", game: 1, handle: handle("b"), positions: positionsB },
            { file: "c", game: 0, handle: handle("c"), positions: positionsC },
        ],
        referenceDb: database,
        signal: new AbortController().signal,
        deps: { loadTree, writeDeck, fetchStatistics },
    }).then((result) => {
        finishedBeforeWrites = writeOrder.some(
            (entry) =>
                entry.endsWith(":start") && !writeOrder.includes(entry.replace(":start", ":done")),
        );
        return result;
    });
    const result = await resultPromise;
    expect(result).toEqual({ status: "ready", statsFailed: false });
    expect(finishedBeforeWrites).toBe(false);
    expect(loadTree).toHaveBeenCalledTimes(2);
    expect(fetchStatistics).toHaveBeenCalledTimes(1);
    expect(writeDeck).toHaveBeenCalledTimes(2);
    expect(writeOrder).toEqual(["a:0:start", "a:0:done", "c:0:start", "c:0:done"]);
    expect(writeDeck.mock.calls[0]?.[2]?.[0]?.weight).toBe(0.3);
});

test("a chapter whose load fails leaves the others weighted", async () => {
    const tree = italianTree();
    const positions = buildFromTree(tree.root, "white", []);
    const loadTree = vi.fn(async (_handle: FileWorkspaceHandle, game: number) => {
        if (game === 1) throw new Error("missing chapter");
        return { root: tree.root, headers: tree.headers };
    });
    const writeDeck = vi.fn<TimedRunPrepareDeps["writeDeck"]>(async () => undefined);
    const fetchStatistics = vi.fn<NonNullable<TimedRunPrepareDeps["fetchStatistics"]>>(async () =>
        e5Stats(getBoardState(tree.root.children[0].fen)),
    );
    const result = await prepareTimedRunWeights({
        chapters: [
            { file: "a", game: 0, handle: handle("a"), positions },
            { file: "a", game: 1, handle: handle("a"), positions: [...positions] },
        ],
        referenceDb: database,
        signal: new AbortController().signal,
        deps: { loadTree, writeDeck, fetchStatistics },
    });
    expect(result).toEqual({ status: "ready", statsFailed: false });
    expect(loadTree).toHaveBeenCalledTimes(2);
    expect(fetchStatistics).toHaveBeenCalledTimes(1);
    expect(writeDeck).toHaveBeenCalledTimes(1);
    expect(writeDeck.mock.calls[0]?.[1]).toBe(0);
});

test("a failed statistics request reports statsFailed and writes nothing", async () => {
    const tree = italianTree();
    const positions = buildFromTree(tree.root, "white", []);
    const writeDeck = vi.fn(async () => undefined);
    const result = await prepareTimedRunWeights({
        chapters: [{ file: "a", game: 0, handle: handle("a"), positions }],
        referenceDb: database,
        signal: new AbortController().signal,
        deps: {
            loadTree: async () => ({ root: tree.root, headers: tree.headers }),
            writeDeck,
            fetchStatistics: async () => {
                throw new Error("stats down");
            },
        },
    });
    expect(result).toMatchObject({ status: "ready", statsFailed: true });
    expect(result.status === "ready" && result.statsError).toBeInstanceOf(Error);
    expect(writeDeck).not.toHaveBeenCalled();
});

test("an abort creates no run writes", async () => {
    const tree = italianTree();
    const positions = buildFromTree(tree.root, "white", []);
    const controller = new AbortController();
    const writeDeck = vi.fn(async () => undefined);
    const fetchStatistics = vi.fn(async () => e5Stats(getBoardState(tree.root.children[0].fen)));
    const result = await prepareTimedRunWeights({
        chapters: [{ file: "a", game: 0, handle: handle("a"), positions }],
        referenceDb: database,
        signal: controller.signal,
        deps: {
            loadTree: async () => {
                controller.abort();
                throw new DOMException("Cancellation", "AbortError");
            },
            writeDeck,
            fetchStatistics,
        },
    });
    expect(result).toEqual({ status: "aborted" });
    expect(fetchStatistics).not.toHaveBeenCalled();
    expect(writeDeck).not.toHaveBeenCalled();
});
