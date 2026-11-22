import { parseUci } from "chessops";
import { afterEach, expect, test } from "vitest";
import type { GameAnalysis } from "@/bindings";
import { parsePgn } from "chessops/pgn";
import { getMainLine, getPGN, reportRootFingerprint } from "@/utils/chess";
import { defaultTree, getNodeAtPath } from "@/utils/treeReducer";
import { closeTreeStore, createTreeStore, retargetTreeStore, retryTreeStoreStorage } from "./tree";
import { deserializeStorageValue, serializeStorageValue } from "./debouncedStorage";
import { tabStorage } from "./tabStorage";
import { TREE_HISTORY_LIMIT } from "./treeHistory";

const persistedIds: string[] = [];

afterEach(() => {
    for (const id of persistedIds.splice(0)) {
        closeTreeStore(id);
        tabStorage.remove(id);
    }
});

function storeWithMoves() {
    const store = createTreeStore();
    store.getState().makeMoves({ payload: ["e4", "e5", "Nf3"] });
    return store;
}

test("undo restores arrows the board reports as cleared and redo clears them again", () => {
    const store = storeWithMoves();
    const arrows = [
        { orig: "e2", dest: "e4", brush: "green" },
        { orig: "g1", dest: "f3", brush: "red" },
    ] as const;
    store.getState().setShapes([...arrows]);
    store.getState().setShapes([]);
    expect(store.getState().currentNode().shapes).toEqual([]);

    store.getState().undo();
    expect(store.getState().currentNode().shapes).toEqual(arrows);
    expect(store.getState().dirty).toBe(true);

    store.getState().redo();
    expect(store.getState().currentNode().shapes).toEqual([]);
});

test("undo and redo of a saved game mark it unsaved so auto-save writes the result", () => {
    const store = storeWithMoves();
    store.getState().setComment("c");
    store.getState().save();
    expect(store.getState().dirty).toBe(false);
    store.getState().undo();
    expect(store.getState().dirty).toBe(true);
    store.getState().save();
    store.getState().redo();
    expect(store.getState().dirty).toBe(true);
});

test("each tab's store keeps its own history", () => {
    const first = storeWithMoves();
    const second = createTreeStore();
    expect(second.getState().history.past).toHaveLength(0);
    second.getState().undo();
    expect(first.getState().root.children).toHaveLength(1);
    first.getState().undo();
    expect(first.getState().root.children).toHaveLength(0);
    expect(second.getState().history.past).toHaveLength(0);
});

const noLine = { best: [], terminal: null, isSacrifice: false };
const reportResult: GameAnalysis = {
    positions: [
        {
            best: [
                {
                    score: { value: { type: "cp", value: 30 }, wdl: null },
                    depth: 20,
                    uciMoves: ["e2e4"],
                } as unknown as GameAnalysis["positions"][number]["best"][number],
            ],
            terminal: null,
            isSacrifice: false,
        },
        noLine,
        noLine,
        noLine,
    ],
    novelty: { kind: "notRequested" },
};

/** Applies `reportResult` as the store's current report operation. */
function applyReport(store: ReturnType<typeof storeWithMoves>, createdAt = 1) {
    store.getState().setReportOperationId("report-operation");
    const { root } = store.getState();
    return store.getState().applyReport(reportResult, {
        operationId: "report-operation",
        fingerprint: reportRootFingerprint(root.fen, getMainLine(root)),
        engine: "Stockfish",
        goMode: { t: "Depth", c: 12 },
        marks: true,
        lines: true,
        createdAt,
    });
}

test.each([
    [
        "appendMove",
        (s: ReturnType<typeof storeWithMoves>) =>
            s.getState().appendMove({ payload: parseUci("b8c6")! }),
    ],
    ["setStart", (s: ReturnType<typeof storeWithMoves>) => s.getState().setStart([0, 0])],
    ["setGameEnd", (s: ReturnType<typeof storeWithMoves>) => s.getState().setGameEnd([0, 0, 0])],
    ["applyReport", (s: ReturnType<typeof storeWithMoves>) => applyReport(s)],
] as const)("%s is one undoable step", (_name, edit) => {
    const store = storeWithMoves();
    const { root, headers } = store.getState();
    const steps = store.getState().history.past.length;
    edit(store);
    expect(store.getState().history.past).toHaveLength(steps + 1);
    store.getState().undo();
    expect(store.getState().root).toBe(root);
    expect(store.getState().headers).toEqual(headers);
});

test("clearing the game end and typing its termination are undoable, typing as one step", () => {
    const store = storeWithMoves();
    store.getState().setGameEnd([0, 0, 0]);
    const ended = store.getState().root;
    for (const text of ["T", "Ti", "Time"]) store.getState().setTermination(text);
    store.getState().clearGameEnd();
    expect(store.getState().history.past).toHaveLength(4);

    store.getState().undo();
    expect(store.getState().root.children[0].children[0].children[0].gameEnd).toEqual({
        termination: "Time",
    });
    store.getState().undo();
    expect(store.getState().root).toBe(ended);
});

test("undo restores arrows erased by a click on the board", () => {
    const store = storeWithMoves();
    const arrows = [{ orig: "e2", dest: "e4", brush: "green" }] as const;
    store.getState().setShapes([...arrows]);
    store.getState().clearShapes();
    expect(store.getState().currentNode().shapes).toEqual([]);
    store.getState().undo();
    expect(store.getState().currentNode().shapes).toEqual(arrows);
});

test.each(["promoteVariation", "promoteToMainline"] as const)(
    "undo of %s restores the previous main line",
    (action) => {
        const store = storeWithMoves();
        store.getState().goToMove([0]);
        store.getState().makeMove({ payload: "c5" });
        const before = store.getState().root;
        store.getState()[action]([0, 1]);
        expect(store.getState().root.children[0].children[0].san).toBe("c5");

        store.getState().undo();
        expect(store.getState().root).toBe(before);
        store.getState().redo();
        expect(store.getState().root.children[0].children[0].san).toBe("c5");
    },
);

test("undo of a deleted variation restores the moves and the cursor that edited them", () => {
    const store = storeWithMoves();
    store.getState().goToMove([0]);
    store.getState().makeMove({ payload: "c5" });
    expect(store.getState().position).toEqual([0, 1]);
    store.getState().deleteMove([0, 1]);
    expect(store.getState().root.children[0].children).toHaveLength(1);

    store.getState().undo();
    expect(store.getState().root.children[0].children.map((n) => n.san)).toEqual(["e5", "c5"]);
    expect(store.getState().position).toEqual([0, 1]);
    expect(getNodeAtPath(store.getState().root, store.getState().position).san).toBe("c5");
});

test("each undoable edit is one step, undone in reverse order", () => {
    const store = storeWithMoves();
    store.getState().setAnnotation("!");
    store.getState().toggleDiagram();
    store.getState().setResult("1-0");

    store.getState().undo();
    expect(store.getState().headers.result).toBe("*");
    expect(store.getState().currentNode().diagram).toBe(true);
    store.getState().undo();
    expect(store.getState().currentNode().diagram).toBeUndefined();
    expect(store.getState().currentNode().nags).toEqual([1]);
    store.getState().undo();
    expect(store.getState().currentNode().nags).toEqual([]);
    // makeMoves played the three moves as one step.
    store.getState().undo();
    expect(store.getState().root.children).toHaveLength(0);
    expect(store.getState().history.past).toHaveLength(0);
});

test("a new edit after undo discards the redo steps", () => {
    const store = storeWithMoves();
    store.getState().setComment("first");
    store.getState().undo();
    expect(store.getState().history.future).toHaveLength(1);
    store.getState().setAnnotation("?");
    expect(store.getState().history.future).toHaveLength(0);
    store.getState().redo();
    expect(store.getState().currentNode().comment).toBe("");
});

test("typing into one comment is one step, a comment on another move is another", () => {
    const store = storeWithMoves();
    for (const text of ["G", "Go", "Goo", "Good"]) store.getState().setComment(text);
    store.getState().goToMove([0]);
    store.getState().setComment("x");
    store.getState().goToMove([0, 0, 0]);
    expect(store.getState().history.past).toHaveLength(3);

    store.getState().undo();
    expect(store.getState().root.children[0].comment).toBe("");
    store.getState().undo();
    expect(store.getState().currentNode().comment).toBe("");
    expect(store.getState().position).toEqual([0, 0, 0]);
});

test("typing into one header field is one step", () => {
    const store = createTreeStore();
    for (const white of ["C", "Ca", "Carl"]) {
        store.getState().setHeaders({ ...store.getState().headers, white });
    }
    store.getState().setHeaders({ ...store.getState().headers, black: "B" });
    expect(store.getState().history.past).toHaveLength(2);
    store.getState().undo();
    store.getState().undo();
    expect(store.getState().headers.white).toBe(defaultTree().headers.white);
});

test("navigation, engine scores and flipping the board are not undoable steps", () => {
    const store = storeWithMoves();
    const steps = store.getState().history.past.length;
    store.getState().goToStart();
    store.getState().goToEnd();
    store.getState().setEngineScore({ value: { type: "cp", value: 20 }, wdl: null });
    store.getState().setHeaders({ ...store.getState().headers, orientation: "black" });
    // Replaying an existing move only moves the cursor.
    store.getState().goToStart();
    store.getState().makeMove({ payload: "e4" });
    expect(store.getState().history.past).toHaveLength(steps);
});

test("undo keeps the current board orientation", () => {
    const store = storeWithMoves();
    store.getState().setComment("c");
    store.getState().setHeaders({ ...store.getState().headers, orientation: "black" });
    store.getState().undo();
    expect(store.getState().headers.orientation).toBe("black");
    expect(store.getState().currentNode().comment).toBe("");
});

test("undo across a new start position restores the old game and its identity", () => {
    const store = storeWithMoves();
    const documentId = store.getState().documentId;
    store.getState().setFen("4k3/8/8/8/8/8/8/4K3 w - - 0 1");
    expect(store.getState().documentId).not.toBe(documentId);
    store.getState().undo();
    expect(store.getState().root.children).toHaveLength(1);
    expect(store.getState().documentId).toBe(documentId);
    expect(store.getState().position).toEqual([0, 0, 0]);
});

test("undo and redo are refused during a practice drill", () => {
    const store = storeWithMoves();
    store.getState().setComment("c");
    store.getState().setPracticePath([0, 0]);
    store.getState().undo();
    expect(store.getState().currentNode().comment).toBe("c");
    store.getState().setPracticePath(null);
    store.getState().undo();
    expect(store.getState().currentNode().comment).toBe("");

    store.getState().setPracticePath([0, 0]);
    store.getState().redo();
    expect(store.getState().currentNode().comment).toBe("");
    store.getState().setPracticePath(null);
    store.getState().redo();
    expect(store.getState().currentNode().comment).toBe("c");
});

test("the history keeps the newest steps up to its limit", () => {
    const store = createTreeStore();
    store.getState().makeMove({ payload: "e4" });
    for (let i = 0; i < TREE_HISTORY_LIMIT + 5; i++) {
        store.getState().setAnnotation(i % 2 === 0 ? "!" : "?");
    }
    expect(store.getState().history.past).toHaveLength(TREE_HISTORY_LIMIT);
    for (let i = 0; i < TREE_HISTORY_LIMIT; i++) store.getState().undo();
    // The move and the first annotations were dropped, so the oldest step left is an annotation.
    expect(store.getState().root.children).toHaveLength(1);
    expect(store.getState().history.past).toHaveLength(0);
});

test("installing another document clears the history", () => {
    const store = storeWithMoves();
    store.getState().setState(defaultTree());
    expect(store.getState().history.past).toHaveLength(0);
    store.getState().undo();
    expect(store.getState().root.children).toHaveLength(0);

    const other = storeWithMoves();
    other.getState().reset();
    expect(other.getState().history.past).toHaveLength(0);

    const id = crypto.randomUUID();
    persistedIds.push(id);
    const persisted = createTreeStore(id);
    persisted.getState().makeMove({ payload: "e4" });
    retargetTreeStore(id, id, defaultTree());
    expect(persisted.getState().history.past).toHaveLength(0);
});

test("rehydrating a stored tree clears the history, even from a payload that carries one", async () => {
    const id = crypto.randomUUID();
    persistedIds.push(id);
    const store = createTreeStore(id);
    store.getState().makeMove({ payload: "e4" });
    expect(store.getState().history.past).toHaveLength(1);
    tabStorage.flush();
    const stored = defaultTree();
    sessionStorage.setItem(
        id,
        serializeStorageValue({
            version: 1,
            state: { ...stored, history: { past: [stored], future: [], mergeKey: null } },
        }),
    );
    await retryTreeStoreStorage(id);
    expect(store.getState().root.children).toHaveLength(0);
    expect(store.getState().history.past).toHaveLength(0);
});

test("the history never reaches tab storage", () => {
    const id = crypto.randomUUID();
    persistedIds.push(id);
    const store = createTreeStore(id);
    store.getState().makeMove({ payload: "e4" });
    store.getState().setComment("saved");
    tabStorage.flush();
    const payload = deserializeStorageValue<{ state: Record<string, unknown> }>(
        sessionStorage.getItem(id)!,
    )!;
    expect(payload.state).not.toHaveProperty("history");
    expect(store.getState().history.past).toHaveLength(2);
});

test("undo and redo of a report restore its summary with the tree and leave the run flags alone", () => {
    const store = storeWithMoves();
    applyReport(store, 1);
    const first = store.getState().report.summary;
    expect(first?.createdAt).toBe(1);
    applyReport(store, 2);
    expect(store.getState().report.summary?.createdAt).toBe(2);

    // A run in progress while the user steps through history keeps its flags.
    store.getState().setReportOperationId("running");
    store.getState().setReportInProgress(true);
    store.getState().undo();
    expect(store.getState().report).toEqual({
        inProgress: true,
        operationId: "running",
        summary: first,
    });
    store.getState().undo();
    expect(store.getState().report.summary).toBeNull();
    expect(store.getState().root.score).toBeNull();
    store.getState().redo();
    expect(store.getState().report.summary).toEqual(first);
    expect(store.getState().report.inProgress).toBe(true);
    expect(store.getState().report.operationId).toBe("running");
});

test("the comment before a variation's first move is guarded, one undo step, and saved to PGN", () => {
    const store = storeWithMoves();
    store.getState().goToMove([0]);
    store.getState().makeMove({ payload: "c5" });
    expect(store.getState().position).toEqual([0, 1]);
    const before = store.getState().history.past.length;
    for (const text of ["A", "Al", "Also"]) store.getState().setStartingComment(text);
    expect(store.getState().currentNode().startingComment).toBe("Also");
    expect(store.getState().history.past).toHaveLength(before + 1);

    const pgn = getPGN(store.getState().root, {
        headers: null,
        comments: true,
        extraMarkups: true,
        glyphs: true,
        variations: true,
    });
    expect(pgn).toContain("({Also} 1... c5");
    const reread = parsePgn(pgn)[0].moves.children[0].children[1].data;
    expect(reread.startingComments).toEqual(["Also"]);

    store.getState().undo();
    expect(store.getState().currentNode()).not.toHaveProperty("startingComment");

    // A mainline move has no slot of its own in front of it: the action changes nothing.
    store.getState().goToMove([0, 0]);
    const root = store.getState().root;
    store.getState().setStartingComment("refused");
    expect(store.getState().root).toBe(root);
    store.getState().goToStart();
    store.getState().setStartingComment("refused");
    expect(store.getState().root).toBe(root);
});
