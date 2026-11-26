import { parseUci } from "chessops";
import { INITIAL_FEN, makeFen } from "chessops/fen";
import { makeSan } from "chessops/san";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import type { Outcome } from "@/bindings";
import i18n from "@/i18n";
import enUSCatalogue from "@/translation/en-US.json";
import deDECatalogue from "@/translation/de-DE.json";
import { fixtureNode } from "@/tests/treeFixtures";
import {
    countMainPly,
    createNode,
    defaultTree,
    deriveScoresheetRemaining,
    getMainLineUnsurePaths,
    getMemoizedBoardStateMap,
    getNodeAtPath,
    getEffectiveGameEnd,
    getEffectiveTermination,
    MAX_GAME_END_TERMINATION_LENGTH,
    stripUnsureMarks,
    treeIterator,
    treeIteratorMainLine,
    type TreeNode,
} from "@/utils/treeReducer";
import { newCoachSession } from "@/state/coachSession";
import {
    clearAllScoresheetPhotosForTests,
    getScoresheetPhotos,
    setScoresheetPhotos,
} from "@/state/scoresheetPhotos";
import { positionFromFen } from "@/utils/chessops";
import { mergeIntoRepertoire } from "@/utils/repertoireImport";
import * as sound from "@/utils/sound";
import {
    closeTreeStore,
    createTreeStore,
    discardTreeStoreStorage,
    nextContinuation,
    nextSiblingVariationOrMainMove,
    prepareTreeStoreRetarget,
    retargetTreeStore,
    retryTreeStoreStorage,
    validateMoveSequence,
} from "./tree";
import { tabStorage } from "./tabStorage";
import { deserializeStorageValue, serializeStorageValue } from "./debouncedStorage";
import { emptyPuzzleSession } from "@/state/puzzleSession";

const persistedIds: string[] = [];

test.each(["setFen", "setHeaders", "setState", "reset"] as const)(
    "%s replaces the document identity",
    (action) => {
        const store = createTreeStore();
        const before = store.getState().documentId;
        expect(before).toBeGreaterThan(0);
        const fen = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
        if (action === "setFen") store.getState().setFen(INITIAL_FEN);
        else if (action === "setHeaders")
            store.getState().setHeaders({ ...store.getState().headers, fen });
        else if (action === "setState") store.getState().setState(defaultTree());
        else store.getState().reset();
        expect(store.getState().documentId).toBeGreaterThan(before);
    },
);

test("setHeaders with a tag that differs only by an impossible en-passant square keeps the moves", () => {
    const tagged = "4k3/8/8/8/4P3/8/8/4K3 b - e6 0 1";
    const store = createTreeStore();
    store.getState().setFen(tagged);
    expect(store.getState().root.fen).toBe("4k3/8/8/8/4P3/8/8/4K3 b - - 0 1");
    store.getState().makeMove({ payload: "Kd7" });
    const id = store.getState().documentId;

    store.getState().setHeaders({ ...store.getState().headers, fen: tagged, white: "A" });

    expect(store.getState().root.children).toHaveLength(1);
    expect(store.getState().documentId).toBe(id);
    expect(store.getState().headers.white).toBe("A");
    expect(store.getState().headers.fen).toBe(store.getState().root.fen);
});

test("a tab persisted with an impossible en-passant root is normalized on rehydrate and keeps its moves", async () => {
    const tagged = "4k3/8/8/8/4P3/8/8/4K3 b - e6 0 1";
    const installed = "4k3/8/8/8/4P3/8/8/4K3 b - - 0 1";
    const source = createTreeStore();
    source.getState().setFen(installed);
    source.getState().makeMove({ payload: "Kd7" });
    const tree = structuredClone({
        ...defaultTree(),
        root: { ...source.getState().root, fen: tagged },
        headers: { ...source.getState().headers, fen: tagged },
    });
    const id = crypto.randomUUID();
    persistedIds.push(id);
    const store = createTreeStore(id);
    sessionStorage.setItem(id, serializeStorageValue({ version: 1, state: tree }));
    await retryTreeStoreStorage(id);

    expect(store.getState().root.fen).toBe(installed);
    expect(store.getState().headers.fen).toBe(installed);
    expect(store.getState().root.children).toHaveLength(1);

    store.getState().setHeaders({ ...store.getState().headers, fen: tagged, white: "A" });
    expect(store.getState().root.children).toHaveLength(1);
});

test("ordinary edits keep the document identity", () => {
    const store = createTreeStore();
    const id = store.getState().documentId;
    expect(id).toBeGreaterThan(0);
    store.getState().setComment("Comment");
    expect(store.getState().documentId).toBe(id);
    store.getState().setAnnotation("!");
    expect(store.getState().documentId).toBe(id);
    store.getState().setShapes([{ orig: "e2", dest: "e4", brush: "green" }]);
    expect(store.getState().documentId).toBe(id);
    store.getState().makeMove({ payload: "e4" });
    expect(store.getState().documentId).toBe(id);
});

test("setAnnotation ignores the root and annotates a move node", () => {
    const store = createTreeStore();
    expect(store.getState().position).toEqual([]);
    store.getState().setAnnotation("+-");
    expect(store.getState().root.nags).toEqual([]);
    expect(store.getState().dirty).toBe(false);

    store.getState().makeMove({ payload: "e4" });
    expect(store.getState().position).toEqual([0]);
    store.getState().setAnnotation("+-");
    expect(store.getState().root.children[0].nags).toEqual([18]);
    expect(store.getState().dirty).toBe(true);
});

test("retargeting installs a fresh document identity only on installation", () => {
    const id = crypto.randomUUID();
    persistedIds.push(id);
    const store = createTreeStore(id);
    const before = store.getState().documentId;
    expect(before).toBeGreaterThan(0);
    const install = prepareTreeStoreRetarget(id, id, defaultTree());
    expect(store.getState().documentId).toBe(before);
    install();
    const installed = store.getState().documentId;
    expect(installed).toBeGreaterThan(before);
    retargetTreeStore(id, id, defaultTree());
    expect(store.getState().documentId).toBeGreaterThan(installed);
});

test("document identity is excluded from persisted bytes and ignored on rehydrate", async () => {
    const id = crypto.randomUUID();
    persistedIds.push(id);
    const store = createTreeStore(id);
    const documentId = store.getState().documentId;
    store.getState().setComment("Saved comment");
    tabStorage.flush();
    const payload = deserializeStorageValue<{ state: Record<string, unknown> }>(
        sessionStorage.getItem(id)!,
    )!;
    expect(payload.state).not.toHaveProperty("documentId");
    expect(documentId).toBeGreaterThan(0);
    // A legacy or tampered payload cannot install an identity from storage.
    sessionStorage.setItem(
        id,
        serializeStorageValue({
            version: 1,
            state: { ...defaultTree(), documentId: -100 },
        }),
    );
    await retryTreeStoreStorage(id);
    expect(store.getState().documentId).toBe(documentId);
    expect(store.getState().root.comment).toBe("");
});

test("setGameEnd keeps one flag, carries effective termination and clearGameEnd removes every flag", () => {
    const store = createTreeStore();
    store.getState().makeMoves({ payload: ["e4", "e5", "Nf3"] });
    store.getState().goToStart();
    store.getState().makeMove({ payload: "d4" });
    const tree = structuredClone({
        root: store.getState().root,
        headers: store.getState().headers,
    });
    tree.root.gameEnd = { termination: "Root is inert" };
    tree.root.children[0].gameEnd = { termination: "Abandoned" };
    tree.root.children[0].children[0].gameEnd = {};
    tree.root.children[1].gameEnd = { termination: "Variation is inert" };
    tree.headers.other = { Termination: "Stale copy", Annotator: "Player" };
    store.setState({ ...tree, dirty: false });
    store.getState().setGameEnd([0, 0, 0]);
    expect(
        Array.from(treeIterator(store.getState().root))
            .filter(({ node }) => node.gameEnd)
            .map(({ position }) => position),
    ).toEqual([[0, 0, 0]]);
    expect(getEffectiveTermination(store.getState())).toBe("Abandoned");
    expect(store.getState().dirty).toBe(true);
    store.getState().save();
    store.getState().setTermination("Time forfeit");
    expect(getEffectiveTermination(store.getState())).toBe("Time forfeit");
    expect(store.getState().headers.other).toEqual({ Annotator: "Player" });
    expect(store.getState().dirty).toBe(true);
    store.getState().setTermination("");
    expect(getEffectiveGameEnd(store.getState().root)?.node.gameEnd).toEqual({});
    expect(getEffectiveTermination(store.getState())).toBeUndefined();
    store.getState().save();
    store.getState().clearGameEnd();
    expect(Array.from(treeIterator(store.getState().root)).every(({ node }) => !node.gameEnd)).toBe(
        true,
    );
    expect(store.getState().dirty).toBe(true);
});

test("setGameEnd carries the fallback header termination and setTermination removes its copy", () => {
    const store = createTreeStore();
    store.getState().makeMove({ payload: "e4" });
    store
        .getState()
        .setHeaders({ ...store.getState().headers, other: { Termination: "Abandoned" } });
    store.getState().setGameEnd([0]);
    expect(getEffectiveGameEnd(store.getState().root)?.node.gameEnd).toEqual({
        termination: "Abandoned",
    });
    store.getState().setTermination("");
    expect(store.getState().headers.other?.Termination).toBeUndefined();
    expect(getEffectiveTermination(store.getState())).toBeUndefined();
});

test("game-end actions reject invalid paths and invalid termination without changing state", () => {
    const store = createTreeStore();
    store.getState().makeMove({ payload: "e4" });
    store.getState().save();
    const before = store.getState();
    for (const path of [[], [1], [0, 0], [-1], [0.5], [NaN], [Infinity], undefined, null, "0"]) {
        before.setGameEnd(path as number[]);
        expect(store.getState()).toBe(before);
    }
    before.setTermination("Abandoned");
    expect(store.getState()).toBe(before);
    before.setGameEnd([0]);
    store.getState().save();
    const marked = store.getState();
    for (const text of [null, undefined, 42, "x".repeat(MAX_GAME_END_TERMINATION_LENGTH + 1)]) {
        marked.setTermination(text as string);
        expect(store.getState()).toBe(marked);
    }
});

test("clearGameEnd removes inert variation and root flags even without an effective end", () => {
    const tree = defaultTree();
    tree.root.gameEnd = {};
    tree.root.children = [fixtureNode("e4"), { ...fixtureNode("d4"), gameEnd: {} }];
    const store = createTreeStore(undefined, tree);
    expect(getEffectiveGameEnd(store.getState().root)).toBeUndefined();
    store.getState().clearGameEnd();
    expect(Array.from(treeIterator(store.getState().root)).every(({ node }) => !node.gameEnd)).toBe(
        true,
    );
    expect(store.getState().dirty).toBe(true);
});

test.each([false, true])(
    "adjudication past a game end preserves the recorded result for existing child=%s",
    (existing) => {
        const tree = defaultTree("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 98 1");
        tree.headers.result = "0-1";
        const store = createTreeStore(undefined, tree);
        store.getState().makeMove({ payload: "Nf3" });
        if (existing) {
            store.getState().makeMove({ payload: "Nf6", changeHeaders: false });
        }
        store.getState().setGameEnd([0]);
        store.getState().goToMove([0]);
        store.getState().save();
        store.getState().makeMove({ payload: "Nf6" });
        expect(store.getState().headers.result).toBe("0-1");
        expect(store.getState().dirty).toBe(!existing);
        expect(store.getState().position).toEqual([0, 0]);
    },
);

test("session transition saves the latest accepted tree before publication and bypasses mutable actions", () => {
    const id = crypto.randomUUID();
    persistedIds.push(id);
    const store = createTreeStore(id);
    store.getState().makeMoves({ payload: ["e4", "e5"] });
    store.getState().setComment("played annotation");
    const before = store.getState();
    vi.spyOn(before, "setState").mockImplementation(() => {
        throw new Error("must bypass action");
    });
    const observed: unknown[] = [];
    const unsubscribe = store.subscribe((state) => {
        observed.push(tabStorage.read(id)?.state);
        expect(sessionStorage.getItem(id)).not.toBeNull();
        expect(state.puzzleSession).toEqual(emptyPuzzleSession());
    });
    expect(
        before.transitionPuzzleSession((draft) => {
            draft.puzzleSession = emptyPuzzleSession();
        }),
    ).toEqual({ success: true, persistence: "saved" });
    unsubscribe();
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({ position: [0, 0], puzzleSession: emptyPuzzleSession() });
    expect(store.getState().currentNode().comment).toBe("played annotation");
    expect(before.puzzleSession).toBeUndefined();
    expect(tabStorage.pendingCount()).toBe(0);
    expect(Object.isFrozen(store.getState().puzzleSession)).toBe(true);
    store.getState().goToPrevious();
    expect(tabStorage.flush()).toEqual([]);
    expect(tabStorage.read(id)?.state).toMatchObject({
        position: [0],
        puzzleSession: emptyPuzzleSession(),
    });
});

test("refused session completion preserves accepted moves, live identity and saved bytes until retry", () => {
    const id = crypto.randomUUID();
    persistedIds.push(id);
    const store = createTreeStore(id);
    store.getState().transitionPuzzleSession((draft) => {
        draft.puzzleSession = emptyPuzzleSession();
    });
    const bytes = sessionStorage.getItem(id);
    store.getState().makeMoves({ payload: ["e4", "e5"] });
    const before = store.getState();
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
        throw new DOMException("full", "QuotaExceededError");
    });
    const result = before.transitionPuzzleSession((draft) => {
        draft.puzzleSession!.selectedAttemptId = "unresolved";
        draft.headers.event = "completion candidate";
    });
    expect(result).toMatchObject({ success: false });
    expect(store.getState()).toBe(before);
    expect(store.getState().position).toEqual([0, 0]);
    expect(sessionStorage.getItem(id)).toBe(bytes);
    expect(tabStorage.pendingCount()).toBe(1);
    setItem.mockRestore();
    expect(
        before.transitionPuzzleSession((draft) => {
            draft.puzzleSession!.selectedAttemptId = "unresolved";
        }),
    ).toEqual({ success: true, persistence: "saved" });
    expect(before.puzzleSession!.selectedAttemptId).toBeNull();
    expect(tabStorage.pendingCount()).toBe(0);
    expect(tabStorage.flush()).toEqual([]);
    expect(tabStorage.read(id)?.state).toMatchObject({
        position: [0, 0],
        puzzleSession: { selectedAttemptId: "unresolved" },
    });
});

test("memory provider transitions validate and publish without browser persistence", () => {
    const store = createTreeStore();
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const before = store.getState();
    expect(
        before.transitionPuzzleSession((draft) => {
            draft.puzzleSession = emptyPuzzleSession();
            draft.root.comment = "memory";
        }),
    ).toEqual({ success: true, persistence: "memory" });
    expect(store.getState().root.comment).toBe("memory");
    expect(before.root.comment).toBe("");
    expect(setItem).not.toHaveBeenCalled();
    const installed = store.getState();
    expect(
        installed.transitionPuzzleSession((draft) => {
            draft.root.clock = Infinity;
        }),
    ).toEqual({ success: false, error: new Error("Cannot persist an invalid game tree.") });
    expect(store.getState()).toBe(installed);
    setItem.mockRestore();
});

test("session transition bounds incoming history before saving and protects selected attempt", () => {
    const id = crypto.randomUUID();
    persistedIds.push(id);
    const store = createTreeStore(id);
    const puzzle = {
        id: 1,
        fen: INITIAL_FEN,
        moves: ["e2e4"],
        rating: 1500,
        rating_deviation: 50,
        popularity: 90,
        nb_plays: 100,
        completion: "incomplete" as const,
    };
    const result = store.getState().transitionPuzzleSession((draft) => {
        draft.puzzleSession = {
            version: 1,
            attempts: Array.from({ length: 101 }, (_, i) => ({
                attemptId: `attempt-${i}`,
                puzzle,
            })),
            selectedAttemptId: "attempt-0",
        };
    });
    expect(result).toEqual({ success: true, persistence: "saved" });
    expect(store.getState().puzzleSession!.attempts).toHaveLength(100);
    expect(
        store
            .getState()
            .puzzleSession!.attempts.slice(0, 2)
            .map((attempt) => attempt.attemptId),
    ).toEqual(["attempt-0", "attempt-2"]);
    expect(tabStorage.read(id)?.state).toMatchObject({
        puzzleSession: store.getState().puzzleSession,
    });
});

test("tree replacement and reset clear an absent optional session instead of retaining a prior owner", () => {
    const store = createTreeStore(undefined, {
        ...defaultTree(),
        puzzleSession: emptyPuzzleSession(),
    });
    store.getState().setState(defaultTree());
    expect(store.getState().puzzleSession).toBeUndefined();
    store.getState().transitionPuzzleSession((draft) => {
        draft.puzzleSession = emptyPuzzleSession();
    });
    store.getState().reset();
    expect(store.getState().puzzleSession).toBeUndefined();
});

test("session admission publishes the same canonical cursor that its saved tree restores", () => {
    const id = crypto.randomUUID();
    persistedIds.push(id);
    const store = createTreeStore(id);
    const result = store.getState().transitionPuzzleSession((draft) => {
        draft.puzzleSession = emptyPuzzleSession();
        draft.position = [9];
        draft.headers.start = [9];
    });
    expect(result.success).toBe(true);
    expect(store.getState().position).toEqual([]);
    expect(store.getState().headers.start).toBeUndefined();
    expect(tabStorage.read(id)?.state).toMatchObject({
        position: [],
        puzzleSession: emptyPuzzleSession(),
    });
});

test("retired session store cannot recreate removed storage", () => {
    const id = crypto.randomUUID();
    const store = createTreeStore(id);
    closeTreeStore(id);
    tabStorage.remove(id);
    expect(
        store.getState().transitionPuzzleSession((draft) => {
            draft.puzzleSession = emptyPuzzleSession();
        }),
    ).toMatchObject({ success: false });
    expect(sessionStorage.getItem(id)).toBeNull();
    expect(tabStorage.pendingCount()).toBe(0);
});
beforeAll(async () => {
    await i18n.init({
        lng: "en-US",
        fallbackLng: "en-US",
        resources: {
            "en-US": { translation: enUSCatalogue.translation },
            "de-DE": { translation: deDECatalogue.translation },
        },
        interpolation: { escapeValue: false },
    });
});
afterEach(() => {
    for (const id of persistedIds.splice(0)) {
        closeTreeStore(id);
        tabStorage.remove(id);
    }
});

function threeBranchStore() {
    const tree = defaultTree();
    const deepA = fixtureNode("deep-a");
    const deepB = fixtureNode("deep-b");
    const deepC = fixtureNode("deep-c");
    tree.root.children = [
        fixtureNode("a", { children: [deepA] }),
        fixtureNode("b", { children: [deepB] }),
        fixtureNode("c", { children: [deepC] }),
    ];
    return { store: createTreeStore(undefined, tree), deepA, deepB, deepC };
}

function nestedPracticePathStore() {
    const grandchildren = (prefix: string) =>
        Array.from({ length: 4 }, (_, index) => {
            const grandchild = fixtureNode(`${prefix}-${index}`);
            const childCount = prefix === "a" && index === 2 ? 2 : 1;
            grandchild.children = Array.from({ length: childCount }, (_, childIndex) =>
                fixtureNode(`${prefix}-${index}-${childIndex}`),
            );
            return grandchild;
        });

    const tree = defaultTree();
    tree.root.children = [
        fixtureNode("a", { children: grandchildren("a") }),
        fixtureNode("b", { children: grandchildren("b") }),
    ];
    return createTreeStore(undefined, tree);
}

function addMove(parent: TreeNode, uci: string): TreeNode {
    const move = parseUci(uci);
    const [position] = positionFromFen(parent.fen);
    if (!move || !position) throw new Error(`Invalid fixture move: ${uci}`);
    const san = makeSan(position, move);
    if (san === "--") throw new Error(`Illegal fixture move: ${uci}`);
    position.play(move);
    const child = createNode({
        fen: makeFen(position.toSetup()),
        move,
        san,
        halfMoves: parent.halfMoves + 1,
    });
    parent.children.push(child);
    return child;
}

function mainlinePrependStore() {
    const tree = defaultTree();
    const e4 = addMove(tree.root, "e2e4");
    const d4 = addMove(tree.root, "d2d4");

    for (const uci of ["e7e5", "c7c5", "e7e6", "c7c6"]) {
        const reply = addMove(e4, uci);
        const continuations = uci === "e7e5" ? ["g1f3", "f1c4", "b1c3"] : ["g1f3"];
        for (const continuation of continuations) {
            addMove(addMove(reply, continuation), "b8c6");
        }
    }

    for (const uci of ["d7d5", "g8f6", "e7e6", "f7f5"]) {
        addMove(addMove(d4, uci), "c2c4");
    }

    return createTreeStore(undefined, tree);
}

test.each(["nextBranch", "previousBranch"] as const)(
    "%s cycles to c5 after descending from e4 into its fork",
    (action) => {
        const tree = defaultTree();
        const e4 = addMove(tree.root, "e2e4");
        addMove(e4, "e7e5");
        const c5 = addMove(e4, "c7c5");
        tree.position = [0];
        const store = createTreeStore(undefined, tree);

        store.getState()[action]();

        expect(store.getState().position).toEqual([0, 1]);
        expect(store.getState().currentNode()).toBe(c5);
    },
);

test.each(["nextBranch", "previousBranch"] as const)(
    "%s cycles from e4 to d4 at the parent fork",
    (action) => {
        const tree = defaultTree();
        const e4 = addMove(tree.root, "e2e4");
        const d4 = addMove(tree.root, "d2d4");
        addMove(e4, "e7e5");
        tree.position = [0];
        const store = createTreeStore(undefined, tree);

        store.getState()[action]();

        expect(store.getState().position).toEqual([1]);
        expect(store.getState().currentNode()).toBe(d4);
    },
);

// 1.e4 (1.d4 d5 (1...Nf6 2.c4) (1...e6 2.c4) 2.c4) (1.c4) 1...e5 2.Nf3 (2.Nc3) 2...Nc6
function linesTree() {
    const tree = defaultTree();
    tree.root.children = [
        fixtureNode("e4", {
            children: [
                fixtureNode("e5", {
                    halfMoves: 2,
                    children: [
                        fixtureNode("Nf3", {
                            halfMoves: 3,
                            children: [fixtureNode("Nc6", { halfMoves: 4 })],
                        }),
                        fixtureNode("Nc3", { halfMoves: 3 }),
                    ],
                }),
            ],
        }),
        fixtureNode("d4", {
            children: [
                fixtureNode("d5", {
                    halfMoves: 2,
                    children: [fixtureNode("c4", { halfMoves: 3 })],
                }),
                fixtureNode("Nf6", {
                    halfMoves: 2,
                    children: [fixtureNode("c4", { halfMoves: 3 })],
                }),
                fixtureNode("e6", {
                    halfMoves: 2,
                    children: [fixtureNode("c4", { halfMoves: 3 })],
                }),
            ],
        }),
        fixtureNode("c4"),
    ];
    return tree;
}

test.each([
    { from: [1, 0, 0], to: [2], why: "a variation end goes to the next sibling variation" },
    { from: [2], to: [0], why: "the last root sibling returns to the main move" },
    {
        from: [1, 1, 0],
        to: [1, 2],
        why: "a nested variation end goes to the next sibling variation",
    },
    { from: [1, 2, 0], to: [1, 0], why: "a nested last sibling returns to its fork's main move" },
    {
        from: [0, 0, 1],
        to: [0, 0, 0],
        why: "a last sibling off the main line returns to its fork's main move",
    },
    { from: [0, 0, 0, 0], to: null, why: "the main line end has no target" },
    { from: [1], to: [2], why: "a move inside a variation names the same target as its end" },
    { from: [1, 1], to: [1, 2], why: "a move inside a nested variation names the same target" },
    { from: [0, 0], to: null, why: "a move inside the main line has no target" },
    { from: [], to: null, why: "the start position belongs to no line" },
])("nextSiblingVariationOrMainMove: $why", ({ from, to }) => {
    expect(nextSiblingVariationOrMainMove(linesTree().root, from)).toEqual(to);
});

test("goToBranchEndOrNextLine returns through fork siblings and stops at the main line end", () => {
    const tree = linesTree();
    tree.position = [1, 1];
    const store = createTreeStore(undefined, tree);
    const visited: number[][] = [];
    for (let i = 0; i < 9; i += 1) {
        store.getState().goToBranchEndOrNextLine();
        visited.push(store.getState().position);
    }
    expect(visited).toEqual([
        [1, 1, 0],
        [1, 2],
        [1, 2, 0],
        [1, 0],
        [1, 0, 0],
        [2],
        [0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
    ]);
});

test("goToBranchEndOrNextLine stays at a line end during a practice drill", () => {
    const tree = linesTree();
    tree.position = [2];
    const store = createTreeStore(undefined, tree);
    store.getState().setPracticePath([2]);

    store.getState().goToBranchEndOrNextLine();

    expect(store.getState().position).toEqual([2]);
});

/** 1.e4 e5 2.Nf3 Nc6, with 1...c5 as a sibling of 1...e5. */
function practiceDrillTree() {
    const tree = defaultTree();
    const e4 = addMove(tree.root, "e2e4");
    const e5 = addMove(e4, "e7e5");
    addMove(e4, "c7c5");
    addMove(addMove(e5, "g1f3"), "b8c6");
    tree.position = [0, 0];
    return tree;
}

test.each([
    "goToEnd",
    "goToBranchEnd",
    "goToBranchEndOrNextLine",
    "nextBranching",
    "nextBranch",
    "previousBranch",
    "goToNextOpenVariation",
] as const)("%s stays at the practice card", (action) => {
    const store = createTreeStore(undefined, practiceDrillTree());
    store.getState().setPracticePath([0, 0]);

    store.getState()[action]();

    expect(store.getState().position).toEqual([0, 0]);
});

test.each(["goToEnd", "goToBranchEnd", "goToBranchEndOrNextLine", "nextBranching"] as const)(
    "%s follows the drill prefix to the practice card",
    (action) => {
        const store = createTreeStore(undefined, practiceDrillTree());
        store.getState().setPracticePath([0, 0, 0, 0]);

        store.getState()[action]();

        expect(store.getState().position).toEqual([0, 0, 0, 0]);
    },
);

test.each(["nextBranch", "previousBranch", "goToNextOpenVariation"] as const)(
    "%s follows the drill prefix onto the sibling card",
    (action) => {
        const store = createTreeStore(undefined, practiceDrillTree());
        store.getState().setPracticePath([0, 1]);

        store.getState()[action]();

        expect(store.getState().position).toEqual([0, 1]);
    },
);

test("nextBranch's fluid arm follows the drill prefix onto the child card", () => {
    const tree = practiceDrillTree();
    tree.position = [0];
    const store = createTreeStore(undefined, tree);
    store.getState().setPracticePath([0, 1]);

    store.getState().nextBranch();

    expect(store.getState().position).toEqual([0, 1]);
});

test("nextBranch's fluid arm stays put when the sibling is off the drill", () => {
    const tree = practiceDrillTree();
    tree.position = [0];
    const store = createTreeStore(undefined, tree);
    store.getState().setPracticePath([0, 0]);

    store.getState().nextBranch();

    expect(store.getState().position).toEqual([0]);
});

test("goToAnnotation does not leave the practice drill line", () => {
    const tree = practiceDrillTree();
    const nf3 = getNodeAtPath(tree.root, [0, 0, 0]);
    nf3.nags = [1];
    const store = createTreeStore(undefined, tree);
    store.getState().setPracticePath([0, 0]);

    store.getState().goToAnnotation("!", "white");

    expect(store.getState().position).toEqual([0, 0]);
});

test("goToAnnotation follows the drill prefix to an annotated card line node", () => {
    const tree = practiceDrillTree();
    const nf3 = getNodeAtPath(tree.root, [0, 0, 0]);
    nf3.nags = [1];
    const store = createTreeStore(undefined, tree);
    store.getState().setPracticePath([0, 0, 0, 0]);

    store.getState().goToAnnotation("!", "white");

    expect(store.getState().position).toEqual([0, 0, 0]);
});

test.each([
    { action: "goToEnd", expected: [0, 0, 0, 0] },
    { action: "goToBranchEnd", expected: [0, 0, 0, 0] },
    { action: "goToBranchEndOrNextLine", expected: [0, 0, 0, 0] },
    { action: "nextBranching", expected: [0, 0, 0, 0] },
    { action: "nextBranch", expected: [0, 1] },
    { action: "previousBranch", expected: [0, 1] },
    // 1...c5 is the tree's only side line one move long.
    { action: "goToNextOpenVariation", expected: [0, 1] },
] as const)("$action still moves when practicePath is null", ({ action, expected }) => {
    const store = createTreeStore(undefined, practiceDrillTree());

    store.getState()[action]();

    expect(store.getState().position).toEqual(expected);
});

test.each([
    { action: "nextBranch", indices: [1, 2, 0] },
    { action: "previousBranch", indices: [2, 1, 0] },
] as const)("$action wraps around three siblings at the parent fork", ({ action, indices }) => {
    const tree = defaultTree();
    const e4 = addMove(tree.root, "e2e4");
    addMove(tree.root, "d2d4");
    addMove(tree.root, "c2c4");
    addMove(e4, "e7e5");
    addMove(e4, "c7c5");
    tree.position = [0];
    const store = createTreeStore(undefined, tree);

    for (const index of indices) {
        store.getState()[action]();

        expect(store.getState().position).toEqual([index]);
        expect(store.getState().currentNode()).toBe(tree.root.children[index]);
    }
});

test("goToAnnotation leaves the cursor unchanged when the annotation is only on a variation", () => {
    const tree = defaultTree();
    const variation = fixtureNode("variation");
    variation.nags = [1];
    tree.root.children = [
        fixtureNode("mainline", { children: [fixtureNode("continuation")] }),
        variation,
    ];
    const store = createTreeStore(undefined, tree);

    store.getState().goToAnnotation("!", "white");

    expect(store.getState().position).toEqual([]);
});

test.each([
    { code: 8, glyph: "□" as const },
    { code: 11, glyph: "=" as const },
])("goToAnnotation finds alias $code for $glyph", ({ code, glyph }) => {
    const tree = defaultTree();
    const child = fixtureNode("alias");
    child.nags = [code];
    tree.root.children = [child];
    const store = createTreeStore(undefined, tree);
    store.getState().goToAnnotation(glyph, "white");
    expect(store.getState().position).toEqual([0]);
});

test("goToAnnotation finds annotations while continuing from a variation", () => {
    const tree = defaultTree();
    const continuation = fixtureNode("variation-continuation");
    continuation.nags = [1];
    const variation = fixtureNode("variation", { children: [continuation] });
    tree.root.children = [
        fixtureNode("mainline", { children: [fixtureNode("mainline-continuation"), variation] }),
    ];
    tree.position = [0, 1];
    const store = createTreeStore(undefined, tree);

    store.getState().goToAnnotation("!", "white");

    expect(store.getState().position).toEqual([0, 1, 0]);
});

test("appendMove checks repetition along the mainline append path", () => {
    const store = createTreeStore();
    for (const uci of ["g1f3", "g8f6", "f3g1", "f6g8", "g1f3", "g8f6", "f3g1"]) {
        store.getState().appendMove({ payload: parseUci(uci)! });
    }

    store.getState().goToStart();
    store.getState().appendMove({ payload: parseUci("f6g8")! });

    expect(store.getState().headers.result).toBe("1/2-1/2");
});

test.each(
    (["defaultTree", "setFen", "setHeaders"] as const).flatMap((creation) =>
        ["KQkq e3", "HAha -", "KQkq -"].map((rightsAndEp) => ({ creation, rightsAndEp })),
    ),
)(
    "$creation preserves raw $rightsAndEp while real moves count its third occurrence",
    ({ creation, rightsAndEp }) => {
        const board = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b";
        const fen = `${board} ${rightsAndEp} 0 1`;
        const store = createTreeStore(
            undefined,
            creation === "defaultTree" ? defaultTree(fen) : undefined,
        );
        if (creation === "setFen") store.getState().setFen(fen);
        if (creation === "setHeaders") {
            store.getState().setHeaders({ ...store.getState().headers, fen });
        }
        const cycle = ["g8f6", "g1f3", "f6g8", "f3g1"];
        for (let repetition = 1; repetition <= 2; repetition++) {
            for (const [index, uci] of cycle.entries()) {
                const move = parseUci(uci)!;
                const [position] = positionFromFen(store.getState().currentNode().fen);
                expect(position!.isLegal(move)).toBe(true);
                store.getState().makeMove({
                    payload: move,
                    clock: 120_000 - (4 * (repetition - 1) + index) * 1_000,
                });
                expect(store.getState().position).toEqual(
                    Array(4 * (repetition - 1) + index + 1).fill(0),
                );
            }
            const state = store.getState();
            expect(state.root.fen).toBe(fen);
            expect(state.headers.fen).toBe(fen);
            expect(state.currentNode()).toMatchObject({
                fen: `${board} KQkq - ${4 * repetition} ${2 * repetition + 1}`,
                halfMoves: 4 * repetition + 1,
                clock: 121 - 4 * repetition,
            });
            expect(state.headers.result).toBe(repetition === 1 ? "*" : "1/2-1/2");
            const currentCyclePath = [...state.position];
            expect(nextContinuation(state)?.path).toEqual([]);
            expect(nextContinuation(state)?.children).toBe(state.root.children);
            state.setPracticePath(currentCyclePath);
            expect(nextContinuation(store.getState())).toBeNull();
            store.getState().goToNext();
            expect(store.getState().position).toEqual(currentCyclePath);
            store.getState().setPracticePath(null);
            store.getState().setHeaders({ ...store.getState().headers, start: [0] });
            expect(nextContinuation(store.getState())?.path).toEqual(
                repetition === 1 ? undefined : [0, 0, 0, 0],
            );
            store.getState().setHeaders({ ...store.getState().headers, start: undefined });
            state.goToNext();
            expect(store.getState().position).toEqual([0]);
            store.getState().goToMove(currentCyclePath);
            expect(store.getState().position).toEqual(currentCyclePath);
        }
    },
);

test.each(["KQkq e3", "HAha -"])(
    "%s repetition counts the selected batch path without borrowing sibling occurrences",
    (rightsAndEp) => {
        const fen = `rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b ${rightsAndEp} 0 1`;
        const store = createTreeStore(undefined, defaultTree(fen));
        expect(
            store.getState().makeMoves({ payload: ["g8f6", "g1f3", "f6g8", "f3g1"] }).success,
        ).toBe(true);
        expect(store.getState().headers.result).toBe("*");
        store.getState().goToStart();
        const siblingCycle = ["g8h6", "g1h3", "h6g8", "h3g1"];
        expect(store.getState().makeMoves({ payload: siblingCycle }).success).toBe(true);
        expect(store.getState().position).toEqual([1, 0, 0, 0]);
        expect(store.getState().headers.result).toBe("*");
        expect(store.getState().makeMoves({ payload: siblingCycle }).success).toBe(true);
        expect(store.getState().position).toEqual([1, 0, 0, 0, 0, 0, 0, 0]);
        expect(store.getState().headers.result).toBe("*");
        expect(store.getState().root.fen).toBe(fen);
        expect(store.getState().headers.fen).toBe(fen);
        expect(getNodeAtPath(store.getState().root, [0, 0, 0, 0]).children).toEqual([]);

        store.getState().goToMove([0, 0, 0, 0]);
        expect(
            store.getState().makeMoves({ payload: ["g8f6", "g1f3", "f6g8", "f3g1"] }).success,
        ).toBe(true);
        expect(store.getState().position).toEqual(Array(8).fill(0));
        expect(store.getState().headers.result).toBe("1/2-1/2");
    },
);

test.each(
    [
        {
            kind: "checkmate",
            fen: "7k/5Q2/6K1/8/8/8/8/8 w - - 0 1",
            mainlineMove: "f7e7",
            move: "f7g7",
        },
        {
            kind: "stalemate",
            fen: "7k/5Q2/6K1/8/8/8/8/8 w - - 0 1",
            mainlineMove: "f7e7",
            move: "f7e6",
        },
        {
            kind: "fifty-move",
            fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 99 1",
            mainlineMove: "e2e4",
            move: "g1f3",
        },
        {
            kind: "insufficient material",
            fen: "7k/8/6K1/8/8/2n5/1B6/8 w - - 0 1",
            mainlineMove: "b2a1",
            move: "b2c3",
        },
    ].flatMap((testCase) => (["1-0", "0-1"] as const).map((result) => ({ ...testCase, result }))),
)(
    "makeMove preserves the loaded Result $result for $kind in a variation",
    ({ kind, fen, mainlineMove, move, result }) => {
        const tree = defaultTree(fen);
        const mainlineChild = addMove(tree.root, mainlineMove);
        const [mainlinePosition] = positionFromFen(mainlineChild.fen);
        expect(mainlinePosition!.isEnd()).toBe(false);
        tree.headers.result = result;
        const store = createTreeStore(undefined, tree);
        store.getState().goToEnd();
        store.getState().goToStart();

        const candidate = parseUci(move)!;
        const [position, error] = positionFromFen(fen);
        expect(error).toBeNull();
        expect(position!.isLegal(candidate)).toBe(true);
        position!.play(candidate);
        expect(position!.isCheckmate()).toBe(kind === "checkmate");
        expect(position!.isStalemate()).toBe(kind === "stalemate");
        expect(position!.isInsufficientMaterial()).toBe(kind === "insufficient material");
        expect(position!.halfmoves >= 100).toBe(kind === "fifty-move");

        store.getState().makeMove({ payload: candidate });

        expect(store.getState().position).toEqual([1]);
        expect(store.getState().currentNode().fen).toBe(makeFen(position!.toSetup()));
        expect(store.getState().root.children[0]).toBe(mainlineChild);
        expect(store.getState().headers.result).toBe(result);
    },
);

test("makeMove adjudicates checkmate when inserted as the new main line end", () => {
    const tree = defaultTree("7k/5Q2/6K1/8/8/8/8/8 w - - 0 1");
    const formerMainline = addMove(tree.root, "f7e7");
    const store = createTreeStore(undefined, tree);

    store.getState().makeMove({ payload: parseUci("f7g7")!, mainline: true });

    expect(store.getState().position).toEqual([0]);
    expect(store.getState().currentNode().san).toBe("Qg7#");
    expect(store.getState().currentNode().children).toEqual([]);
    expect(store.getState().root.children[1]).toBe(formerMainline);
    expect(store.getState().headers.result).toBe("1-0");
});

test("makeMove preserves the loaded Result when replaying a main line node with a continuation", () => {
    const tree = defaultTree("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 99 1");
    const child = addMove(tree.root, "g1f3");
    addMove(child, "a7a6");
    tree.headers.result = "1-0";
    const store = createTreeStore(undefined, tree);

    store.getState().makeMove({ payload: parseUci("g1f3")! });

    expect(store.getState().position).toEqual([0]);
    expect(store.getState().currentNode()).toBe(child);
    expect(store.getState().headers.result).toBe("1-0");
    expect(store.getState().dirty).toBe(false);
});

test("makeMove does not apply the 50-move result when header changes are disabled", () => {
    const tree = defaultTree("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 99 1");
    tree.headers.result = "1-0";
    const store = createTreeStore(undefined, tree);

    store.getState().makeMove({ payload: parseUci("g1f3")!, changeHeaders: false });

    expect(store.getState().headers.result).toBe("1-0");
});

test.each([
    {
        winner: "white",
        clock: 99,
        fen: "7k/5Q2/6K1/8/8/8/8/8 w - - 99 1",
        move: "f7g7",
        result: "1-0",
    },
    {
        winner: "black",
        clock: 99,
        fen: "8/8/8/8/8/6k1/5q2/7K b - - 99 1",
        move: "f2g2",
        result: "0-1",
    },
    {
        winner: "white",
        clock: 0,
        fen: "7k/5Q2/6K1/8/8/8/8/8 w - - 0 1",
        move: "f7g7",
        result: "1-0",
    },
    {
        winner: "black",
        clock: 0,
        fen: "8/8/8/8/8/6k1/5q2/7K b - - 0 1",
        move: "f2g2",
        result: "0-1",
    },
])(
    "makeMove preserves $winner checkmate at halfmove clock $clock",
    ({ fen, move, result, clock }) => {
        const [position, error] = positionFromFen(fen);
        expect(error).toBeNull();
        const matingMove = parseUci(move)!;
        expect(position!.isLegal(matingMove)).toBe(true);
        expect(makeSan(position!, matingMove)).toMatch(/#$/);
        position!.play(matingMove);
        expect(position!.isCheckmate()).toBe(true);
        expect(position!.halfmoves).toBe(clock + 1);

        const store = createTreeStore(undefined, defaultTree(fen));
        store.getState().makeMove({ payload: matingMove });

        expect(store.getState().currentNode().fen).toBe(makeFen(position!.toSetup()));
        expect(store.getState().headers.result).toBe(result);
    },
);

test.each([
    {
        kind: "fifty-move",
        fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 99 1",
        move: "g1f3",
        halfmoves: 100,
    },
    { kind: "stalemate", fen: "7k/5Q2/6K1/8/8/8/8/8 w - - 0 1", move: "f7e6", halfmoves: 1 },
    {
        kind: "insufficient material",
        fen: "7k/8/6K1/8/8/2n5/1B6/8 w - - 0 1",
        move: "b2c3",
        halfmoves: 0,
    },
])("makeMove retains the $kind draw", ({ kind, fen, move, halfmoves }) => {
    const [position, error] = positionFromFen(fen);
    expect(error).toBeNull();
    const drawingMove = parseUci(move)!;
    expect(position!.isLegal(drawingMove)).toBe(true);
    position!.play(drawingMove);
    expect(position!.isCheckmate()).toBe(false);
    expect(position!.isStalemate()).toBe(kind === "stalemate");
    expect(position!.isInsufficientMaterial()).toBe(kind === "insufficient material");
    expect(position!.halfmoves).toBe(halfmoves);

    const store = createTreeStore(undefined, defaultTree(fen));
    store.getState().makeMove({ payload: drawingMove });

    expect(store.getState().currentNode().fen).toBe(makeFen(position!.toSetup()));
    expect(store.getState().headers.result).toBe("1/2-1/2");
});

test("makeMove preserves headers when checkmate and fifty-move adjudication are disabled", () => {
    const tree = defaultTree("7k/5Q2/6K1/8/8/8/8/8 w - - 99 1");
    tree.headers.result = "0-1";
    const store = createTreeStore(undefined, tree);
    const headers = store.getState().headers;

    store.getState().makeMove({ payload: "Qg7#", changeHeaders: false });

    const [position, error] = positionFromFen(store.getState().currentNode().fen);
    expect(error).toBeNull();
    expect(position!.isCheckmate()).toBe(true);
    expect(position!.halfmoves).toBe(100);
    expect(store.getState().headers).toBe(headers);
    expect(store.getState().headers.result).toBe("0-1");
});

const adjudicationReplayCases = [
    {
        kind: "white checkmate at clock 100",
        fen: "7k/5Q2/6K1/8/8/8/8/8 w - - 99 1",
        moves: ["f7g7"],
        result: "1-0",
    },
    {
        kind: "black checkmate at clock 100",
        fen: "8/8/8/8/8/6k1/5q2/7K b - - 99 1",
        moves: ["f2g2"],
        result: "0-1",
    },
    {
        kind: "fifty-move draw",
        fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 99 1",
        moves: ["g1f3"],
        result: "1/2-1/2",
    },
    {
        kind: "stalemate",
        fen: "7k/5Q2/6K1/8/8/8/8/8 w - - 0 1",
        moves: ["f7e6"],
        result: "1/2-1/2",
    },
    {
        kind: "insufficient material",
        fen: "7k/8/6K1/8/8/2n5/1B6/8 w - - 0 1",
        moves: ["b2c3"],
        result: "1/2-1/2",
    },
    {
        kind: "threefold repetition",
        fen: INITIAL_FEN,
        moves: ["g1f3", "g8f6", "f3g1", "f6g8", "g1f3", "g8f6", "f3g1", "f6g8"],
        result: "1/2-1/2",
    },
] as const;

test.each(adjudicationReplayCases)(
    "re-entering the game-end move skips $kind adjudication",
    ({ fen, moves }) => {
        const store = createTreeStore(undefined, defaultTree(fen));
        expect(
            store.getState().makeMoves({ payload: [...moves], changeHeaders: false }).success,
        ).toBe(true);
        store.getState().setGameEnd(Array(moves.length).fill(0));
        store.getState().setResult("*");
        store.getState().goToStart();
        store.getState().save();
        expect(store.getState().makeMoves({ payload: [...moves] }).success).toBe(true);
        expect(store.getState().headers.result).toBe("*");
        expect(store.getState().dirty).toBe(false);
    },
);

function prepareAdjudicationReplay(
    testCase: (typeof adjudicationReplayCases)[number],
    editedResult: Outcome,
) {
    const store = createTreeStore(undefined, defaultTree(testCase.fen));
    for (const uci of testCase.moves) {
        const move = parseUci(uci)!;
        const [position, error] = positionFromFen(store.getState().currentNode().fen);
        expect(error).toBeNull();
        expect(position!.isLegal(move)).toBe(true);
        store.getState().makeMove({ payload: move });
    }
    expect(store.getState().headers.result).toBe(testCase.result);
    expect(store.getState().dirty).toBe(true);
    const terminalChild = store.getState().currentNode();

    store.getState().setResult(editedResult);
    store.getState().save();
    store.getState().goToStart();
    expect(store.getState().position).toEqual([]);
    expect(store.getState().headers.result).toBe(editedResult);
    expect(store.getState().dirty).toBe(false);
    const root = store.getState().root;
    const headers = store.getState().headers;

    return {
        store,
        headers,
        replay: (changeHeaders = true) => {
            for (const [index, uci] of testCase.moves.entries()) {
                store.getState().makeMove({ payload: parseUci(uci)!, changeHeaders });
                expect(store.getState().position).toEqual(Array(index + 1).fill(0));
            }
            const state = store.getState();
            expect(state.position).toHaveLength(testCase.moves.length);
            expect(state.root).toBe(root);
            expect(state.currentNode()).toBe(terminalChild);
            let node = state.root;
            for (let depth = 0; depth < testCase.moves.length; depth++) {
                expect(node.children).toHaveLength(1);
                node = node.children[0];
            }
            expect(node.children).toHaveLength(0);
        },
    };
}

test.each(adjudicationReplayCases)(
    "replaying an existing $kind changes the saved Result and marks the tree dirty",
    (testCase) => {
        const { store, replay } = prepareAdjudicationReplay(testCase, "*");

        replay();

        expect(store.getState().headers.result).toBe(testCase.result);
        expect(store.getState().dirty).toBe(true);
    },
);

test.each(adjudicationReplayCases)(
    "replaying an existing $kind with unchanged Result stays clean",
    (testCase) => {
        const { store, headers, replay } = prepareAdjudicationReplay(testCase, testCase.result);

        replay();

        expect(store.getState().headers.result).toBe(testCase.result);
        expect(store.getState().headers).toBe(headers);
        expect(store.getState().dirty).toBe(false);
    },
);

test.each(adjudicationReplayCases)(
    "replaying an existing $kind with adjudication disabled preserves the saved header",
    (testCase) => {
        const { store, headers, replay } = prepareAdjudicationReplay(testCase, "*");

        replay(false);

        expect(store.getState().headers.result).toBe("*");
        expect(store.getState().headers).toBe(headers);
        expect(store.getState().dirty).toBe(false);
    },
);

test("replaying an ordinary existing child preserves Result and stays clean", () => {
    const store = createTreeStore();
    store.getState().makeMove({ payload: "e4" });
    const child = store.getState().currentNode();
    store.getState().save();
    store.getState().goToStart();
    const headers = store.getState().headers;

    store.getState().makeMove({ payload: "e4" });

    expect(store.getState().position).toEqual([0]);
    expect(store.getState().root.children).toHaveLength(1);
    expect(store.getState().currentNode()).toBe(child);
    expect(store.getState().headers.result).toBe("*");
    expect(store.getState().headers).toBe(headers);
    expect(store.getState().dirty).toBe(false);
});

test("unreadable tree bytes survive hydration and incidental store updates", () => {
    const id = "unreadable-tree-hydration";
    const raw = "not a serialized game tree";
    persistedIds.push(id);
    sessionStorage.setItem(id, raw);

    const store = createTreeStore(id);
    expect(tabStorage.getStatus(id)).toEqual({ kind: "unreadable", rawValue: raw });
    expect(sessionStorage.getItem(id)).toBe(raw);

    store.getState().setComment("An unrelated in-memory update");
    tabStorage.flush();

    expect(tabStorage.pendingCount()).toBe(0);
    expect(sessionStorage.getItem(id)).toBe(raw);
});

test("successful discard clears unreadable bytes and resets the cached tree", () => {
    const id = "discard-tree-hydration";
    const raw = "undecodable tree data";
    persistedIds.push(id);
    sessionStorage.setItem(id, raw);
    const store = createTreeStore(id);
    store.getState().setComment("An incidental in-memory update");

    expect(discardTreeStoreStorage(id)).toBe(true);
    expect(tabStorage.getStatus(id).kind).toBe("available");
    expect(sessionStorage.getItem(id)).toBeNull();
    expect(store.getState().root.comment).toBe("");
    tabStorage.flush();
    expect(tabStorage.read(id)?.state).toMatchObject({ root: { comment: "" } });
});

test("a failed initial read stays gated until retry rehydrates the cached store", async () => {
    const id = "retry-valid-tree-hydration";
    const tree = defaultTree();
    tree.headers.event = "Saved tree after retry";
    const raw = serializeStorageValue({ version: 1, state: tree });
    sessionStorage.setItem(id, raw);
    persistedIds.push(id);
    const failure = new Error("storage refused the read");
    const originalGetItem = Storage.prototype.getItem;
    const getItem = vi
        .spyOn(Storage.prototype, "getItem")
        .mockImplementation(function (this: Storage, key) {
            if (key === id) throw failure;
            return originalGetItem.call(this, key);
        });

    const store = createTreeStore(id);
    expect(tabStorage.getStatus(id)).toEqual({ kind: "unavailable", error: failure });
    store.getState().setComment("Must not replace unread storage");
    tabStorage.flush();
    getItem.mockRestore();
    expect(sessionStorage.getItem(id)).toBe(raw);

    await expect(retryTreeStoreStorage(id)).resolves.toEqual({ kind: "available" });
    expect(createTreeStore(id)).toBe(store);
    expect(store.getState().headers.event).toBe("Saved tree after retry");
    expect(tabStorage.read(id)?.state).toMatchObject({
        headers: { event: "Saved tree after retry" },
    });
});

test("a refused read and failed retry can recover to an absent editable tree", async () => {
    const id = "retry-absent-tree-hydration";
    persistedIds.push(id);
    const failure = new Error("storage refused the read");
    const originalGetItem = Storage.prototype.getItem;
    let refused = true;
    const getItem = vi
        .spyOn(Storage.prototype, "getItem")
        .mockImplementation(function (this: Storage, key) {
            if (key === id && refused) throw failure;
            return originalGetItem.call(this, key);
        });

    const store = createTreeStore(id);
    expect(tabStorage.getStatus(id)).toEqual({ kind: "unavailable", error: failure });
    await expect(retryTreeStoreStorage(id)).resolves.toEqual({
        kind: "unavailable",
        error: failure,
    });
    expect(originalGetItem.call(sessionStorage, id)).toBeNull();

    refused = false;
    await expect(retryTreeStoreStorage(id)).resolves.toEqual({ kind: "absent" });
    getItem.mockRestore();

    expect(createTreeStore(id)).toBe(store);
    expect(store.getState().headers.event).toBe(defaultTree().headers.event);
    store.getState().setComment("Editable after absent-key retry");
    tabStorage.flush();
    expect(tabStorage.read(id)?.state).toMatchObject({
        root: { comment: "Editable after absent-key retry" },
    });
});

test("save writes the clean tree and its new source stamp together", () => {
    const id = "tree-save-source-stamp";
    persistedIds.push(id);
    const tree = defaultTree();
    tree.dirty = true;
    tree.sourceStamp = "a".repeat(64);
    tree.appendAttempted = true;
    const store = createTreeStore(id, tree);

    store.getState().save("b".repeat(64));
    tabStorage.flush();

    expect(store.getState()).toMatchObject({
        dirty: false,
        sourceStamp: "b".repeat(64),
        appendAttempted: false,
    });
    expect(tabStorage.read(id)?.state).toMatchObject({
        dirty: false,
        sourceStamp: "b".repeat(64),
        appendAttempted: false,
    });
});

type PracticePathRebasingCase = {
    name: string;
    practicePath: number[];
    mutation: "delete" | "promote";
    mutationPath: number[];
    expectedPath: number[];
} & (
    | { sameNode: true }
    // The clamp and contract-anchor rows resolve to an ancestor on the mutated chain, which Immer
    // clones, so they are checked by the resolved node's san instead of identity.
    | { sameNode: false; expectedSan: string }
);

const practicePathRebasingCases: PracticePathRebasingCase[] = [
    {
        name: "deleting a later sibling leaves the earlier practice path unchanged",
        practicePath: [0, 1, 0],
        mutation: "delete",
        mutationPath: [0, 2],
        expectedPath: [0, 1, 0],
        sameNode: true,
    },
    {
        name: "deleting an earlier sibling shifts the practice path",
        practicePath: [0, 3, 0],
        mutation: "delete",
        mutationPath: [0, 2],
        expectedPath: [0, 2, 0],
        sameNode: true,
    },
    {
        name: "deleting the practiced subtree clamps the practice path to its parent",
        practicePath: [0, 2, 0],
        mutation: "delete",
        mutationPath: [0, 2],
        expectedPath: [0],
        expectedSan: "a",
        sameNode: false,
    },
    {
        name: "promoting the practiced sibling moves its path to the mainline",
        practicePath: [0, 2, 0],
        mutation: "promote",
        mutationPath: [0, 2],
        expectedPath: [0, 0, 0],
        sameNode: true,
    },
    {
        name: "promoting a later sibling shifts the practice path right",
        practicePath: [0, 1, 0],
        mutation: "promote",
        mutationPath: [0, 2],
        expectedPath: [0, 2, 0],
        sameNode: true,
    },
    {
        name: "promoting an earlier sibling leaves the later practice path unchanged",
        practicePath: [0, 3, 0],
        mutation: "promote",
        mutationPath: [0, 1],
        expectedPath: [0, 3, 0],
        sameNode: true,
    },
    {
        name: "deleting under another branch leaves the practice path unchanged",
        practicePath: [1, 3, 0],
        mutation: "delete",
        mutationPath: [0, 2],
        expectedPath: [1, 3, 0],
        sameNode: true,
    },
    {
        name: "promoting under another branch leaves the practice path unchanged",
        practicePath: [1, 2, 0],
        mutation: "promote",
        mutationPath: [0, 2],
        expectedPath: [1, 2, 0],
        sameNode: true,
    },
    {
        name: "deleting a descendant keeps the practice path at its parent (contract anchor)",
        practicePath: [0],
        mutation: "delete",
        mutationPath: [0, 2],
        expectedPath: [0],
        expectedSan: "a",
        sameNode: false,
    },
    {
        name: "promoting a descendant keeps the practice path at its parent (contract anchor)",
        practicePath: [0],
        mutation: "promote",
        mutationPath: [0, 2],
        expectedPath: [0],
        expectedSan: "a",
        sameNode: false,
    },
];

function applyPracticePathCase(testCase: PracticePathRebasingCase) {
    const store = nestedPracticePathStore();
    store.getState().setPracticePath(testCase.practicePath);
    const nodeBeforeMutation = getNodeAtPath(store.getState().root, testCase.practicePath);

    if (testCase.mutation === "delete") store.getState().deleteMove(testCase.mutationPath);
    else store.getState().promoteVariation(testCase.mutationPath);

    const state = store.getState();
    return {
        practicePath: state.practicePath,
        nodeBeforeMutation,
        rebasedNode: getNodeAtPath(state.root, testCase.expectedPath),
    };
}

test.each(practicePathRebasingCases.filter((testCase) => testCase.sameNode))(
    "$name",
    (testCase) => {
        const result = applyPracticePathCase(testCase);
        expect(result.practicePath).toEqual(testCase.expectedPath);
        expect(result.rebasedNode).toBe(result.nodeBeforeMutation);
    },
);

test.each(
    practicePathRebasingCases.filter(
        (testCase): testCase is Extract<PracticePathRebasingCase, { sameNode: false }> =>
            !testCase.sameNode,
    ),
)("$name", (testCase) => {
    const result = applyPracticePathCase(testCase);
    expect(result.practicePath).toEqual(testCase.expectedPath);
    expect(result.rebasedNode.san).toBe(testCase.expectedSan);
});

test("promoteToMainline rebases all tracked paths through multiple promotions", () => {
    const store = nestedPracticePathStore();
    const path = [0, 2, 1];
    store.getState().goToMove(path);
    store.getState().setStart(path);
    store.getState().setPracticePath(path);
    const nodeBeforePromotion = getNodeAtPath(store.getState().root, path);

    store.getState().promoteToMainline(path);

    const state = store.getState();
    expect(state.position).toEqual([0, 0, 0]);
    expect(state.headers.start).toEqual([0, 0, 0]);
    expect(state.practicePath).toEqual([0, 0, 0]);
    expect(getNodeAtPath(state.root, state.position)).toBe(nodeBeforePromotion);
    expect(getNodeAtPath(state.root, state.headers.start!)).toBe(nodeBeforePromotion);
    expect(getNodeAtPath(state.root, state.practicePath!)).toBe(nodeBeforePromotion);
});

test("deleting the practiced node clamps the path and prevents advancing", () => {
    const store = nestedPracticePathStore();
    store.getState().goToMove([0, 2, 0]);
    store.getState().setPracticePath([0, 2, 0]);

    store.getState().deleteMove([0, 2]);

    expect(store.getState().practicePath).toEqual([0]);
    expect(store.getState().position).toEqual([0]);
    expect(getNodeAtPath(store.getState().root, [0]).san).toBe("a");
    expect(getNodeAtPath(store.getState().root, [0]).children.length).toBeGreaterThan(0);

    store.getState().goToNext();

    expect(store.getState().position).toEqual([0]);
});

test.each(["delete", "promote"] as const)("a null practicePath stays null after %s", (mutation) => {
    const store = nestedPracticePathStore();
    store.getState().setPracticePath(null);

    if (mutation === "delete") store.getState().deleteMove([0, 2]);
    else store.getState().promoteVariation([0, 2]);

    expect(store.getState().practicePath).toBeNull();
});

test("a root mainline prepend rebases the repertoire start and practice path", () => {
    const store = mainlinePrependStore();
    store.getState().setStart([0]);
    store.getState().setPracticePath([1, 0]);
    const startNode = getNodeAtPath(store.getState().root, [0]);
    const practiceNode = getNodeAtPath(store.getState().root, [1, 0]);

    store.getState().makeMove({ payload: "c4", mainline: true, changePosition: false });

    const state = store.getState();
    expect(state.headers.start).toEqual([1]);
    expect(getNodeAtPath(state.root, state.headers.start!)).toBe(startNode);
    expect(state.practicePath).toEqual([2, 0]);
    expect(getNodeAtPath(state.root, state.practicePath!)).toBe(practiceNode);
    expect(state.position).toEqual([]);
});

test("a mainline prepend at depth one shifts a repertoire start at child index zero", () => {
    const store = mainlinePrependStore();
    store.getState().goToMove([0]);
    store.getState().setStart([0, 0, 0]);
    const startNode = getNodeAtPath(store.getState().root, [0, 0, 0]);

    store.getState().makeMove({ payload: "d5", mainline: true, changePosition: false });

    const state = store.getState();
    expect(state.headers.start).toEqual([0, 1, 0]);
    expect(getNodeAtPath(state.root, state.headers.start!)).toBe(startNode);
});

test("a mainline prepend rebases a practice path through a later child", () => {
    const store = mainlinePrependStore();
    store.getState().goToMove([0]);
    store.getState().setPracticePath([0, 2, 0]);
    const practiceNode = getNodeAtPath(store.getState().root, [0, 2, 0]);

    store.getState().makeMove({ payload: "d5", mainline: true, changePosition: false });

    const state = store.getState();
    expect(state.practicePath).toEqual([0, 3, 0]);
    expect(getNodeAtPath(state.root, state.practicePath!)).toBe(practiceNode);
});

test("a mainline prepend leaves a tracked path on another root branch unchanged", () => {
    const store = mainlinePrependStore();
    store.getState().goToMove([0]);
    store.getState().setStart([1, 1, 0]);
    const startNode = getNodeAtPath(store.getState().root, [1, 1, 0]);

    store.getState().makeMove({ payload: "d5", mainline: true, changePosition: false });

    const state = store.getState();
    expect(state.headers.start).toEqual([1, 1, 0]);
    expect(getNodeAtPath(state.root, state.headers.start!)).toBe(startNode);
});

test("a mainline prepend leaves a practice path on the insertion parent unchanged", () => {
    const store = mainlinePrependStore();
    store.getState().goToMove([0]);
    store.getState().setPracticePath([0]);
    const practiceSan = getNodeAtPath(store.getState().root, [0]).san;

    store.getState().makeMove({ payload: "d5", mainline: true, changePosition: false });

    const state = store.getState();
    expect(state.practicePath).toEqual([0]);
    // The insertion parent is on the mutated chain, which Immer clones, so identity cannot hold.
    expect(getNodeAtPath(state.root, state.practicePath!).san).toBe(practiceSan);
});

test("a mainline prepend leaves absent start and null practice paths absent", () => {
    const store = mainlinePrependStore();
    store.getState().goToMove([0]);
    store.getState().setPracticePath(null);

    store.getState().makeMove({ payload: "d5", mainline: true, changePosition: false });

    expect(store.getState().headers.start).toBeUndefined();
    expect(store.getState().practicePath).toBeNull();
});

test("a mainline move already present among the children does not rebase tracked paths", () => {
    const store = mainlinePrependStore();
    store.getState().goToMove([0]);
    store.getState().setStart([0, 0, 0]);
    const startNode = getNodeAtPath(store.getState().root, [0, 0, 0]);

    store.getState().makeMove({ payload: "e5", mainline: true, changePosition: false });

    const state = store.getState();
    expect(state.headers.start).toEqual([0, 0, 0]);
    expect(getNodeAtPath(state.root, state.headers.start!)).toBe(startNode);
});

test("a mainline prepend shifts tracked paths at a deeper insertion depth", () => {
    const store = mainlinePrependStore();
    store.getState().goToMove([0, 0]);
    store.getState().setPracticePath([0, 0, 2, 0]);
    const practiceNode = getNodeAtPath(store.getState().root, [0, 0, 2, 0]);

    store.getState().makeMove({ payload: "d4", mainline: true, changePosition: false });

    const state = store.getState();
    expect(state.practicePath).toEqual([0, 0, 3, 0]);
    expect(getNodeAtPath(state.root, state.practicePath!)).toBe(practiceNode);
});

test("a non-mainline append leaves tracked paths unchanged", () => {
    const store = mainlinePrependStore();
    store.getState().goToMove([0]);
    store.getState().setStart([0, 0, 0]);
    store.getState().setPracticePath([0, 2, 0]);
    const startNode = getNodeAtPath(store.getState().root, [0, 0, 0]);
    const practiceNode = getNodeAtPath(store.getState().root, [0, 2, 0]);

    store.getState().makeMove({ payload: "d5", changePosition: false });

    const state = store.getState();
    expect(state.headers.start).toEqual([0, 0, 0]);
    expect(getNodeAtPath(state.root, state.headers.start!)).toBe(startNode);
    expect(state.practicePath).toEqual([0, 2, 0]);
    expect(getNodeAtPath(state.root, state.practicePath!)).toBe(practiceNode);
});

test("a mainline prepend with changePosition selects the new first child", () => {
    const store = mainlinePrependStore();
    store.getState().goToMove([0]);

    store.getState().makeMove({ payload: "d5", mainline: true });

    const state = store.getState();
    expect(state.position).toEqual([0, 0]);
    expect(getNodeAtPath(state.root, state.position).san).toBe("d5");
});

test("a root mainline prepend selects the new move and rebases the old start", () => {
    const store = mainlinePrependStore();
    store.getState().setStart([0]);
    const startNode = getNodeAtPath(store.getState().root, [0]);

    store.getState().makeMove({ payload: "c4", mainline: true });

    const state = store.getState();
    expect(state.position).toEqual([0]);
    expect(getNodeAtPath(state.root, state.position).san).toBe("c4");
    expect(state.headers.start).toEqual([1]);
    expect(getNodeAtPath(state.root, state.headers.start!)).toBe(startNode);
});

test("makeMoves rebases once for the first prepend and selects the final move", () => {
    const store = mainlinePrependStore();
    store.getState().goToMove([0]);
    store.getState().setStart([0, 0, 0]);
    const startNode = getNodeAtPath(store.getState().root, [0, 0, 0]);

    store.getState().makeMoves({ payload: ["d5", "Nf3"], mainline: true });

    const state = store.getState();
    expect(state.headers.start).toEqual([0, 1, 0]);
    expect(getNodeAtPath(state.root, state.headers.start!)).toBe(startNode);
    expect(state.position).toEqual([0, 0, 0]);
    expect(getNodeAtPath(state.root, state.position).san).toBe("Nf3");
});

test.each([
    ["malformed middle SAN", ["d5", "invalid", "Nf3"], 2],
    ["malformed suffix SAN", ["d5", "Nf3", "invalid"], 3],
    ["malformed middle UCI", ["d7d5", "g1z3", "b8c6"], 2],
    ["malformed suffix UCI", ["d7d5", "g1f3", "b8z6"], 3],
    ["illegal middle UCI", ["d7d5", "g1g3", "b8c6"], 2],
    ["illegal suffix UCI", ["d7d5", "g1f3", "b8b6"], 3],
] as const)("makeMoves atomically rejects %s", (_name, payload, moveNumber) => {
    const store = mainlinePrependStore();
    store.getState().goToMove([0]);
    store.getState().setStart([0, 0, 0]);
    store.getState().setPracticePath([1, 0, 0]);
    store.getState().setResult("1-0");
    store.getState().save();
    const before = store.getState();
    const playSound = vi.spyOn(sound, "playSound").mockImplementation(() => undefined);
    try {
        const result = before.makeMoves({ payload: [...payload], mainline: true });
        expect(store.getState()).toBe(before);
        expect(store.getState()).toEqual(before);
        expect(store.getState().root).toBe(before.root);
        expect(store.getState().position).toBe(before.position);
        expect(store.getState().headers).toBe(before.headers);
        expect(store.getState().practicePath).toBe(before.practicePath);
        expect(store.getState().dirty).toBe(false);
        expect(playSound).not.toHaveBeenCalled();
        expect(result).toEqual({
            success: false,
            error: new Error(
                `${enUSCatalogue.translation["MoveInput.InvalidMove"]} (${moveNumber})`,
            ),
        });
    } finally {
        playSound.mockRestore();
    }
});

test.each([
    ["en-US", enUSCatalogue.translation],
    ["de-DE", deDECatalogue.translation],
] as const)(
    "sequence rejection uses the %s catalogue without exposing untrusted input",
    async (locale, catalogue) => {
        await i18n.changeLanguage(locale);
        try {
            const token = "<untrusted-puzzle-token>";
            const moveResult = validateMoveSequence(INITIAL_FEN, ["e4", token]);
            expect(moveResult.success).toBe(false);
            if (moveResult.success) throw new Error("Expected invalid move rejection");
            expect(moveResult.error.message).toBe(`${catalogue["MoveInput.InvalidMove"]} (2)`);
            expect(moveResult.error.message).not.toContain(token);

            for (const [fen, errorKey] of [
                ["untrusted-board w - - 0 1", "Errors.InvalidBoard"],
                ["8/8/8/8/8/8/8/8 w - - 0 1", "Errors.EmptyBoard"],
            ] as const) {
                const positionResult = validateMoveSequence(fen, ["e2e4"]);
                expect(positionResult.success).toBe(false);
                if (positionResult.success) throw new Error("Expected invalid position rejection");
                const detail =
                    errorKey === "Errors.InvalidBoard"
                        ? catalogue["Errors.InvalidBoard"]
                        : catalogue["Errors.EmptyBoard"];
                expect(positionResult.error.message).toBe(
                    catalogue["Board.Analysis.InvalidPosition"].replace("{{error}}", detail),
                );
                expect(positionResult.error.message).not.toContain(fen);
            }
        } finally {
            await i18n.changeLanguage("en-US");
        }
    },
);

test("makeMoves empty batch preserves exact state and emits no sound", () => {
    const store = mainlinePrependStore();
    const before = store.getState();
    const playSound = vi.spyOn(sound, "playSound").mockImplementation(() => undefined);
    try {
        expect(before.makeMoves({ payload: [], mainline: true })).toEqual({
            success: true,
            moves: [],
        });
        expect(store.getState()).toBe(before);
        expect(playSound).not.toHaveBeenCalled();
    } finally {
        playSound.mockRestore();
    }
});

test("makeMoves validates a Black-to-move custom FEN and sounds only the final move", () => {
    const fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 23";
    const store = createTreeStore(undefined, defaultTree(fen));
    const playSound = vi.spyOn(sound, "playSound").mockImplementation(() => undefined);
    try {
        const result = store.getState().makeMoves({ payload: ["e7e5", "Nf3"], mainline: true });
        expect(result.success).toBe(true);
        const state = store.getState();
        expect(state.root.fen).toBe(fen);
        expect(state.position).toEqual([0, 0]);
        expect(state.currentNode().san).toBe("Nf3");
        expect(state.currentNode().halfMoves).toBe(state.root.halfMoves + 2);
        expect(playSound).toHaveBeenCalledOnce();
    } finally {
        playSound.mockRestore();
    }
});

test("deleteMove rebases the cursor through a later sibling by identity", () => {
    const store = nestedPracticePathStore();
    store.getState().goToMove([0, 3, 0]);
    const nodeBefore = getNodeAtPath(store.getState().root, [0, 3, 0]);

    store.getState().deleteMove([0, 2]);

    const state = store.getState();
    expect(state.position).toEqual([0, 2, 0]);
    expect(getNodeAtPath(state.root, state.position)).toBe(nodeBefore);
});

test("deleteMove rebases the repertoire start through a later sibling by identity", () => {
    const store = nestedPracticePathStore();
    store.getState().setStart([0, 3, 0]);
    const nodeBefore = getNodeAtPath(store.getState().root, [0, 3, 0]);

    store.getState().deleteMove([0, 2]);

    const state = store.getState();
    expect(state.headers.start).toEqual([0, 2, 0]);
    expect(getNodeAtPath(state.root, state.headers.start!)).toBe(nodeBefore);
});

test("deleting a sibling rebases deep cursor and repertoire start to the same nodes", () => {
    const { store, deepB, deepC } = threeBranchStore();
    store.getState().goToMove([2, 0]);
    store.getState().setStart([1, 0]);

    store.getState().deleteMove([0]);

    const state = store.getState();
    expect(state.position).toEqual([1, 0]);
    expect(state.headers.start).toEqual([0, 0]);
    expect(getNodeAtPath(state.root, state.position)).toBe(deepC);
    expect(getNodeAtPath(state.root, state.headers.start!)).toBe(deepB);
    const boardStateMap = getMemoizedBoardStateMap(state.root, state.headers.start ?? []);
    expect(boardStateMap["deep-b w - -"][0].path).toEqual([0, 0]);
    expect(boardStateMap["deep-c w - -"]).toBeUndefined();
});

test("deleteVariation removes a nested side line from its first move", () => {
    const store = nestedPracticePathStore();
    store.getState().goToMove([0, 2, 1]);
    const kept = getNodeAtPath(store.getState().root, [0, 2, 0]);

    store.getState().deleteVariation([0, 2, 1]);

    const state = store.getState();
    expect(getNodeAtPath(state.root, [0, 2]).children).toEqual([kept]);
    expect(state.position).toEqual([0, 2]);
    expect(state.dirty).toBe(true);
});

test("deleteVariation from deeper in a side line removes it from its first move", () => {
    const store = nestedPracticePathStore();
    store.getState().goToMove([0, 3, 0]);

    store.getState().deleteVariation([0, 3, 0]);

    const state = store.getState();
    expect(getNodeAtPath(state.root, [0]).children.map((child) => child.fen)).toEqual([
        "a-0 w - - 0 1",
        "a-1 w - - 0 1",
        "a-2 w - - 0 1",
    ]);
    expect(state.position).toEqual([0]);
});

test("deleteVariation on the main line changes nothing", () => {
    const store = nestedPracticePathStore();
    store.getState().goToMove([0, 0, 0]);
    store.setState({ dirty: false });
    const before = store.getState().root;

    store.getState().deleteVariation([0, 0, 0]);

    expect(store.getState().root).toBe(before);
    expect(store.getState().dirty).toBe(false);
});

test("promoteVariation on the main line leaves the game unmodified", () => {
    const store = nestedPracticePathStore();
    store.setState({ dirty: false });
    const before = store.getState().root;

    store.getState().promoteVariation([0, 0, 0]);

    expect(store.getState().root).toBe(before);
    expect(store.getState().dirty).toBe(false);
});

test("deleteMovesAfter keeps the move, clears targets after it and is one undo step", () => {
    const { store, deepA, deepB } = threeBranchStore();
    store.getState().goToMove([1, 0]);
    store.getState().setStart([1, 0]);

    store.getState().deleteMovesAfter([1]);

    let state = store.getState();
    expect(state.root.children[1].children).toEqual([]);
    expect(state.root.children[1].fen).toBe("b w - - 0 1");
    expect(state.position).toEqual([1]);
    expect(state.headers.start).toBeUndefined();
    expect(getNodeAtPath(state.root, [0, 0])).toBe(deepA);

    store.getState().undo();

    state = store.getState();
    expect(getNodeAtPath(state.root, [1, 0])).toEqual(deepB);
    expect(state.position).toEqual([1, 0]);
});

test("deleteMovesAfter keeps a target outside the cleared moves", () => {
    const { store, deepC } = threeBranchStore();
    store.getState().goToMove([2, 0]);

    store.getState().deleteMovesAfter([1]);

    expect(store.getState().position).toEqual([2, 0]);
    expect(getNodeAtPath(store.getState().root, [2, 0])).toBe(deepC);
});

test("deleteMovesAfter with a stale path never clears an ancestor's moves", () => {
    const { store } = threeBranchStore();
    store.setState({ dirty: false });
    const before = store.getState().root;

    // [1, 5] resolves only to "b", which has a move after it that must survive.
    store.getState().deleteMovesAfter([1, 5]);
    store.getState().deleteMovesAfter([2, 0, 3]);

    expect(store.getState().root).toBe(before);
    expect(store.getState().root.children[1].children).toHaveLength(1);
    expect(store.getState().dirty).toBe(false);
});

test("deleting a target subtree clears only targets inside it", () => {
    const { store, deepA } = threeBranchStore();
    store.getState().goToMove([1, 0]);
    store.getState().setStart([1, 0]);

    store.getState().deleteMove([1]);

    const state = store.getState();
    expect(state.position).toEqual([]);
    expect(state.headers.start).toBeUndefined();
    expect(getNodeAtPath(state.root, [0, 0])).toBe(deepA);
});

test("promoting a sibling rebases unrelated deep cursor and repertoire start by identity", () => {
    const { store, deepA, deepB, deepC } = threeBranchStore();
    store.getState().goToMove([0, 0]);
    store.getState().setStart([1, 0]);

    store.getState().promoteVariation([2]);

    const state = store.getState();
    expect(state.root.children.map((child) => child.fen)).toEqual([
        "c w - - 0 1",
        "a w - - 0 1",
        "b w - - 0 1",
    ]);
    expect(state.position).toEqual([1, 0]);
    expect(state.headers.start).toEqual([2, 0]);
    expect(getNodeAtPath(state.root, state.position)).toBe(deepA);
    expect(getNodeAtPath(state.root, state.headers.start!)).toBe(deepB);
    expect(getNodeAtPath(state.root, [0, 0])).toBe(deepC);
    const boardStateMap = getMemoizedBoardStateMap(state.root, state.headers.start ?? []);
    expect(boardStateMap["deep-b w - -"][0].path).toEqual([2, 0]);
    expect(boardStateMap["deep-a w - -"]).toBeUndefined();
});

test("setFen stores the normalized FEN from the installed root", () => {
    const store = createTreeStore();
    // The padded input pins the normalization contract; validating callers do not reach this case.
    store.getState().setFen(` ${INITIAL_FEN} `);

    const state = store.getState();
    expect(state.root.fen).toBe(INITIAL_FEN);
    expect(state.headers.fen).toBe(state.root.fen);
});

test("setFen with an empty FEN installs the default root and clears old paths", () => {
    const tree = defaultTree();
    tree.root.children = [fixtureNode("old-root-child")];
    tree.position = [0];
    tree.headers.start = [0];
    const store = createTreeStore(undefined, tree);
    store.getState().setPracticePath([0]);

    store.getState().setFen("");

    const state = store.getState();
    expect(state.root.fen).toBe(INITIAL_FEN);
    expect(state.headers.fen).toBe(state.root.fen);
    expect(state.headers.start).toBeUndefined();
    expect(state.practicePath).toBeNull();
    expect(state.position).toEqual([]);
});

test("setFen clears paths into the replaced root", () => {
    const tree = defaultTree();
    tree.root.children = [fixtureNode("old-root-child")];
    tree.position = [0];
    tree.headers.start = [0];
    const store = createTreeStore(undefined, tree);
    store.getState().setPracticePath([0]);

    const fen = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
    store.getState().setFen(fen);

    const state = store.getState();
    expect(state.headers.fen).toBe(state.root.fen);
    expect(state.headers.start).toBeUndefined();
    expect(state.practicePath).toBeNull();
    expect(state.position).toEqual([]);
});

test("editing headers after setFen keeps the installed position", () => {
    const store = createTreeStore();
    const fen = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";

    store.getState().setFen(fen);
    const installedRoot = store.getState().root;
    store.getState().setHeaders({ ...store.getState().headers, event: "x" });

    expect(store.getState().root).toBe(installedRoot);
    expect(store.getState().root.fen).toBe(fen);
});

test("setHeaders installing a new FEN clears paths into the replaced root", () => {
    const tree = defaultTree();
    tree.root.children = [fixtureNode("old-root-child")];
    tree.position = [0];
    tree.headers.start = [0];
    const store = createTreeStore(undefined, tree);
    store.getState().setPracticePath([0]);
    const fen = "rnbqkbnr/ppppkppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 2";

    store.getState().setHeaders({ ...store.getState().headers, fen });

    const state = store.getState();
    expect(state.headers.fen).toBe(state.root.fen);
    expect(state.headers.fen).toBe(fen);
    expect(state.headers.start).toBeUndefined();
    expect(state.practicePath).toBeNull();
    expect(state.position).toEqual([]);
});

test("editing headers after a padded setHeaders FEN keeps the moved tree", () => {
    const store = createTreeStore();
    // The padded input pins the normalization contract; validating callers do not reach this case.
    store.getState().setHeaders({
        ...store.getState().headers,
        fen: ` ${INITIAL_FEN} `,
    });
    store.getState().makeMove({ payload: parseUci("e2e4")! });
    const rootAfterMove = store.getState().root;
    const e4Node = rootAfterMove.children[0];

    store.getState().setHeaders({ ...store.getState().headers, event: "x" });

    expect(store.getState().root).toBe(rootAfterMove);
    expect(store.getState().root.children[0]).toBe(e4Node);
});

test("setHeaders with an unchanged FEN preserves tracked paths", () => {
    const tree = defaultTree();
    tree.headers.start = [0];
    const store = createTreeStore(undefined, tree);
    store.getState().setPracticePath([1, 0]);

    store.getState().setHeaders({ ...store.getState().headers, orientation: "black" });

    expect(store.getState().headers.start).toEqual([0]);
    expect(store.getState().practicePath).toEqual([1, 0]);
});

test("setState clears practicePath and keeps the supplied start path", () => {
    const store = createTreeStore();
    const tree = defaultTree();
    // Both paths resolve in the supplied tree, as parsePGN (every production caller's source)
    // guarantees.
    tree.root.children = [
        fixtureNode("a", { children: [fixtureNode("a-0")] }),
        fixtureNode("b", { children: [fixtureNode("b-0"), fixtureNode("b-1")] }),
    ];
    tree.headers.start = [1, 1];
    tree.position = [0, 0];
    tree.dirty = true;
    store.getState().setPracticePath([0]);

    store.getState().setState(tree);

    const state = store.getState();
    expect(state.practicePath).toBeNull();
    expect(state.headers.start).toEqual([1, 1]);
    expect(getNodeAtPath(state.root, state.headers.start!).san).toBe("b-1");
    expect(getNodeAtPath(state.root, state.position).san).toBe("a-0");
    expect(state.root).toBe(tree.root);
    expect(state.headers).toBe(tree.headers);
    expect(state.position).toEqual(tree.position);
    expect(state.dirty).toBe(tree.dirty);
    expect(state.report).toBe(tree.report);
});

test("reset clears practicePath, the start path and the cursor", () => {
    const tree = defaultTree();
    tree.root.children = [
        fixtureNode("old-root-child", { children: [fixtureNode("old-grandchild")] }),
    ];
    tree.headers.start = [0, 0];
    tree.position = [0, 0];
    const store = createTreeStore(undefined, tree);
    store.getState().setPracticePath([0, 0]);

    store.getState().reset();

    expect(store.getState().practicePath).toBeNull();
    expect(store.getState().headers.start).toBeUndefined();
    expect(store.getState().position).toEqual([]);
});

test("goToContinuation steps into the chosen variation instead of the main line", () => {
    const { store, deepB } = threeBranchStore();

    store.getState().goToContinuation(1);
    expect(store.getState().position).toEqual([1]);

    store.getState().goToNext();
    expect(store.getState().currentNode()).toBe(deepB);
});

test("goToContinuation refuses an index with no child", () => {
    const { store } = threeBranchStore();

    store.getState().goToContinuation(3);
    expect(store.getState().position).toEqual([]);
});

test("goToContinuation refuses any step during a practice drill", () => {
    const { store } = threeBranchStore();
    store.getState().setPracticePath([0, 0]);
    store.getState().goToContinuation(2);
    expect(store.getState().position).toEqual([]);
});

function transposedContinuationStore() {
    const tree = defaultTree();
    const target = fixtureNode("target", {
        children: [fixtureNode("main"), fixtureNode("variation")],
    });
    tree.root.children = [target, fixtureNode("leaf", { fen: target.fen })];
    tree.position = [1];
    return { store: createTreeStore(undefined, tree), target };
}

test("goToContinuation follows the selected transposed continuation", () => {
    const { store, target } = transposedContinuationStore();

    store.getState().goToContinuation(1);

    expect(store.getState().position).toEqual([0, 1]);
    expect(store.getState().currentNode()).toBe(target.children[1]);
});

test("nextContinuation returns the current node's own children", () => {
    const { store } = threeBranchStore();
    store.getState().goToMove([1]);
    const state = store.getState();

    const continuation = nextContinuation(state);

    expect(continuation?.path).toBe(state.position);
    expect(continuation?.children).toBe(state.currentNode().children);
});

test("nextContinuation returns the transposition target's path and children", () => {
    const { store, target } = transposedContinuationStore();

    const continuation = nextContinuation(store.getState());

    expect(continuation?.path).toEqual([0]);
    expect(continuation?.children).toBe(target.children);
});

test("transposed continuation skips an earlier leaf and follows the populated node", () => {
    const tree = defaultTree();
    const target = fixtureNode("target", {
        children: [fixtureNode("main"), fixtureNode("variation")],
    });
    const populatedPath = [1];
    const currentPath = [2];
    tree.root.children = [
        fixtureNode("earlier-leaf", { fen: target.fen }),
        target,
        fixtureNode("current-leaf", { fen: target.fen }),
    ];
    tree.position = currentPath;
    const store = createTreeStore(undefined, tree);

    const continuation = nextContinuation(store.getState());

    expect(continuation?.path).toEqual(populatedPath);
    expect(continuation?.children).toBe(target.children);
    store.getState().goToNext();
    expect(store.getState().position).toEqual([...populatedPath, 0]);
    store.getState().goToMove(currentPath);
    store.getState().goToContinuation(1);
    expect(store.getState().position).toEqual([...populatedPath, 1]);
});

test("nextContinuation returns null at a leaf without a transposition", () => {
    const { store } = threeBranchStore();
    store.getState().goToMove([0, 0]);

    expect(nextContinuation(store.getState())).toBeNull();
});

test("nextContinuation never transposes during an active practice drill", () => {
    const { store } = transposedContinuationStore();
    store.getState().setPracticePath([1, 0]);

    expect(nextContinuation(store.getState())).toBeNull();
});

test.each([
    { name: "three-square pawn advance", fen: INITIAL_FEN, uci: "e2e5" },
    { name: "wrong side to move", fen: INITIAL_FEN, uci: "e7e5" },
    {
        name: "exposing the king to check",
        fen: "k3r3/8/8/8/8/8/4R3/4K3 w - - 0 1",
        uci: "e2f2",
    },
])("makeMove rejects raw $name without changes or sound", ({ fen, uci }) => {
    const tree = defaultTree(fen);
    tree.headers.result = "0-1";
    const store = createTreeStore(undefined, tree);
    const before = store.getState();
    const move = parseUci(uci);
    if (!move) throw new Error("Invalid UCI fixture");
    const playSound = vi.spyOn(sound, "playSound").mockImplementation(() => undefined);
    try {
        for (let attempt = 0; attempt < 2; attempt++) {
            store.getState().makeMove({ payload: move, mainline: true, clock: 42 });

            const after = store.getState();
            expect(after.root).toBe(before.root);
            expect(after.root.children).toEqual([]);
            expect(after.position).toBe(before.position);
            expect(after.position).toEqual([]);
            expect(after.headers).toBe(before.headers);
            expect(after.headers.result).toBe("0-1");
            expect(after.dirty).toBe(false);
            expect(playSound).not.toHaveBeenCalled();
            expect(after).toBe(before);
        }
    } finally {
        playSound.mockRestore();
    }
});

test.each(["makeMove", "appendMove"] as const)(
    "%s rejects a raw move illegal at its target while preserving existing children",
    (action) => {
        const store = createTreeStore();
        store.getState().makeMove({ payload: parseUci("e2e4")! });
        if (action === "appendMove") store.getState().goToStart();
        store.getState().save();
        const before = store.getState();
        const playSound = vi.spyOn(sound, "playSound").mockImplementation(() => undefined);
        try {
            // This knight move is legal at the root, but the target after e4 has Black to move.
            store.getState()[action]({ payload: parseUci("g1f3")! });

            const after = store.getState();
            expect(after.root).toBe(before.root);
            expect(after.position).toBe(before.position);
            expect(after.headers).toBe(before.headers);
            expect(after.headers.result).toBe("*");
            expect(after.dirty).toBe(false);
            expect(after.root.children).toHaveLength(1);
            expect(after.root.children[0].children).toEqual([]);
            expect(playSound).not.toHaveBeenCalled();
            expect(after).toBe(before);
        } finally {
            playSound.mockRestore();
        }
    },
);

test.each([
    { name: "starting UCI", fen: INITIAL_FEN, uci: "e2e4", san: "e4" },
    {
        name: "Black-to-move custom position",
        fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 23",
        uci: "e7e5",
        san: "e5",
    },
    {
        name: "standard king-destination castling",
        fen: "4k3/8/8/8/8/8/8/R3K2R w KQ - 0 1",
        uci: "e1g1",
        san: "O-O",
    },
    {
        name: "standard king-to-rook castling",
        fen: "4k3/8/8/8/8/8/8/R3K2R w KQ - 0 1",
        uci: "e1a1",
        san: "O-O-O",
    },
    {
        name: "Chess960 kingside castling",
        fen: "4k3/8/8/8/8/8/8/1R1K1R2 w KQ - 0 1",
        uci: "d1f1",
        san: "O-O",
    },
    {
        name: "Chess960 queenside castling",
        fen: "4k3/8/8/8/8/8/8/1R1K1R2 w KQ - 0 1",
        uci: "d1b1",
        san: "O-O-O",
    },
    {
        name: "promotion",
        fen: "7k/P7/8/8/8/8/8/4K3 w - - 0 1",
        uci: "a7a8q",
        san: "a8=Q+",
    },
    {
        name: "underpromotion",
        fen: "7k/P7/8/8/8/8/8/4K3 w - - 0 1",
        uci: "a7a8n",
        san: "a8=N",
    },
])("makeMove preserves legal raw $name and existing-child replay", ({ fen, uci, san }) => {
    const store = createTreeStore(undefined, defaultTree(fen));
    const move = parseUci(uci)!;

    store.getState().makeMove({ payload: move });

    const child = store.getState().currentNode();
    expect(child.san).toBe(san);
    expect(child.move).toEqual(move);
    expect(store.getState().position).toEqual([0]);
    expect(store.getState().dirty).toBe(true);
    const result = store.getState().headers.result;
    store.getState().goToStart();
    store.getState().save();
    const root = store.getState().root;

    store.getState().makeMove({ payload: move });

    expect(store.getState().root).toBe(root);
    expect(store.getState().root.children).toEqual([child]);
    expect(store.getState().currentNode()).toBe(child);
    expect(store.getState().position).toEqual([0]);
    expect(store.getState().headers.result).toBe(result);
    expect(store.getState().dirty).toBe(false);
});

test("appendMove admits a legal mainline reply while the cursor starts at root", () => {
    const store = createTreeStore();
    store.getState().makeMove({ payload: parseUci("e2e4")! });
    store.getState().goToStart();

    store.getState().appendMove({ payload: parseUci("e7e5")! });

    expect(store.getState().root.children[0].children[0].san).toBe("e5");
    expect(store.getState().position).toEqual([0, 0]);
});

test("goToNextOpenVariation keeps the cursor when the tree has no open variation", () => {
    const tree = defaultTree();
    addMove(addMove(tree.root, "e2e4"), "e7e5");
    tree.position = [0];
    const store = createTreeStore(undefined, tree);
    const before = store.getState().position;

    store.getState().goToNextOpenVariation();

    expect(store.getState().position).toBe(before);
});

test("deriveScoresheetRemaining covers L < ply, L = ply, L > ply and exhausted tokens", () => {
    const stopped = { ply: 4, tokens: ["Nxe5", "d6", "Nf3"] };
    expect(deriveScoresheetRemaining(stopped, 2)).toStrictEqual({
        nextPly: 4,
        moveNumber: 3,
        color: "white",
        tokens: ["Nxe5", "d6", "Nf3"],
    });
    expect(deriveScoresheetRemaining(stopped, 4)).toStrictEqual({
        nextPly: 4,
        moveNumber: 3,
        color: "white",
        tokens: ["Nxe5", "d6", "Nf3"],
        failedToken: "Nxe5",
    });
    expect(deriveScoresheetRemaining(stopped, 5)).toStrictEqual({
        nextPly: 5,
        moveNumber: 3,
        color: "black",
        tokens: ["d6", "Nf3"],
    });
    expect(deriveScoresheetRemaining(stopped, 7)).toBeNull();
    expect(deriveScoresheetRemaining(undefined, 0)).toBeNull();
    expect(deriveScoresheetRemaining({ ply: 4, tokens: [] }, 2)).toBeNull();
});

test("stripUnsureMarks copies every node without its mark and leaves the source tree unchanged", () => {
    const root = defaultTree().root;
    const e4 = addMove(root, "e2e4");
    const d4 = addMove(root, "d2d4");
    const e5 = addMove(e4, "e7e5");
    const c5 = addMove(e4, "c7c5");
    const nf3 = addMove(c5, "g1f3");
    addMove(e5, "g1f3");
    addMove(d4, "d7d5");
    e4.unsure = true;
    nf3.unsure = true;
    const before = structuredClone(root);
    const expected = structuredClone(root);
    delete expected.children[0].unsure;
    delete expected.children[0].children[1].children[0].unsure;

    const stripped = stripUnsureMarks(root);

    expect(stripped).toStrictEqual(expected);
    expect(root).toStrictEqual(before);
    expect(stripped).not.toBe(root);
    expect(stripped.children[0]).not.toBe(e4);
});

test("getMainLineUnsurePaths never reports the root, even when it carries a mark", () => {
    const root = defaultTree().root;
    const e4 = addMove(root, "e2e4");
    root.unsure = true;
    e4.unsure = true;
    expect(getMainLineUnsurePaths(root)).toEqual([[0]]);
});

test("scoresheet review marks travel with undo, clear/finish are not undoable, and no mark is stored without a review on either write route", () => {
    const id = crypto.randomUUID();
    persistedIds.push(id);
    const initial = defaultTree();
    const e4 = addMove(initial.root, "e2e4");
    const e5 = addMove(e4, "e7e5");
    e4.unsure = true;
    e5.unsure = true;
    const alt = addMove(e4, "c7c5");
    alt.unsure = true;
    initial.scoresheetReview = { stopped: { ply: 2, tokens: ["Nf3"] } };
    initial.position = [0];

    expect(getMainLineUnsurePaths(initial.root)).toEqual([[0], [0, 0]]);
    const cleanRoot = defaultTree().root;
    expect(stripUnsureMarks(cleanRoot)).toBe(cleanRoot);

    const store = createTreeStore(id, initial);

    // clearUnsureMark clears one mark without recording undo or changing dirty.
    store.getState().clearUnsureMark();
    expect(getNodeAtPath(store.getState().root, [0]).unsure).toBeUndefined();
    expect(getNodeAtPath(store.getState().root, [0, 0]).unsure).toBe(true);
    expect(store.getState().dirty).toBe(false);
    expect(store.getState().history.past).toHaveLength(0);

    // Make an undoable move so undo history contains a root with unsure marks.
    store.getState().goToMove([0, 0]);
    store.getState().makeMove({ payload: "Nf3" });
    expect(store.getState().history.past).toHaveLength(1);

    // Finish review clears marks and review without recording an undo step or changing dirty.
    store.getState().save();
    store.getState().finishScoresheetReview();
    expect(store.getState().scoresheetReview).toBeUndefined();
    expect(getNodeAtPath(store.getState().root, [0, 0]).unsure).toBeUndefined();
    expect(store.getState().dirty).toBe(false);
    expect(store.getState().history.past).toHaveLength(1);

    // Undo restores the snapshot whose node still has unsure in memory, but scoresheetReview stays absent.
    store.getState().undo();
    expect(store.getState().scoresheetReview).toBeUndefined();
    expect(getNodeAtPath(store.getState().root, [0, 0]).unsure).toBe(true);

    // Route 1: debounced flush (partialize -> tabStorage.write -> flush) must store NO unsure marks.
    tabStorage.flush();
    const afterFlush = deserializeStorageValue(sessionStorage.getItem(id)!) as {
        state: ReturnType<typeof defaultTree>;
    };
    expect(afterFlush.state.scoresheetReview).toBeUndefined();
    expect(getNodeAtPath(afterFlush.state.root, [0, 0]).unsure).toBeUndefined();
    expect(getNodeAtPath(afterFlush.state.root, [0, 1]).unsure).toBeUndefined();

    // Route 2: direct session-change write (admitSessionTransition -> prepareTreeForStorage -> seed)
    // must also store NO unsure marks.
    const result = store.getState().transitionCoachSession(() => newCoachSession());
    expect(result.success).toBe(true);
    const afterSession = deserializeStorageValue(sessionStorage.getItem(id)!) as {
        state: ReturnType<typeof defaultTree>;
    };
    expect(afterSession.state.scoresheetReview).toBeUndefined();
    expect(getNodeAtPath(afterSession.state.root, [0, 0]).unsure).toBeUndefined();
});

test("replacing the start position clears scoresheetReview and undo afterwards stores no marks", () => {
    const id = crypto.randomUUID();
    persistedIds.push(id);
    const initial = defaultTree();
    const e4 = addMove(initial.root, "e2e4");
    e4.unsure = true;
    initial.scoresheetReview = { stopped: { ply: 1, tokens: ["e5"] } };
    const store = createTreeStore(id, initial);

    store.getState().setFen("4k3/8/8/8/8/8/8/4K3 w - - 0 1");
    expect(store.getState().scoresheetReview).toBeUndefined();

    store.getState().undo();
    expect(store.getState().scoresheetReview).toBeUndefined();
    tabStorage.flush();
    const stored = deserializeStorageValue(sessionStorage.getItem(id)!) as {
        state: ReturnType<typeof defaultTree>;
    };
    expect(getNodeAtPath(stored.state.root, [0]).unsure).toBeUndefined();
});

test("partialize keeps unsure marks while scoresheetReview is active and strips them when absent", () => {
    const id = crypto.randomUUID();
    persistedIds.push(id);
    const initial = defaultTree();
    const e4 = addMove(initial.root, "e2e4");
    e4.unsure = true;
    initial.scoresheetReview = { stopped: { ply: 1, tokens: ["e5"] } };
    const store = createTreeStore(id, initial);

    // Debounced persist while review is active must keep the mark in storage.
    store.getState().setComment("check");
    tabStorage.flush();
    const duringReview = deserializeStorageValue(sessionStorage.getItem(id)!) as {
        state: ReturnType<typeof defaultTree>;
    };
    expect(duringReview.state.scoresheetReview).toEqual({ stopped: { ply: 1, tokens: ["e5"] } });
    expect(getNodeAtPath(duringReview.state.root, [0]).unsure).toBe(true);

    // Finish review, then undo so the node carries unsure in memory without scoresheetReview.
    store.getState().finishScoresheetReview();
    store.getState().undo();
    expect(getNodeAtPath(store.getState().root, [0]).unsure).toBe(true);
    expect(store.getState().scoresheetReview).toBeUndefined();

    tabStorage.flush();
    const afterReview = deserializeStorageValue(sessionStorage.getItem(id)!) as {
        state: ReturnType<typeof defaultTree>;
    };
    expect(afterReview.state.scoresheetReview).toBeUndefined();
    expect(getNodeAtPath(afterReview.state.root, [0]).unsure).toBeUndefined();
});

test("replacing the game or start FEN clears scoresheetReview and tab photos, while unchanged-FEN setHeaders keeps both", () => {
    const PHOTO = "data:image/jpeg;base64,AAAA";
    const id = crypto.randomUUID();
    persistedIds.push(id);
    const makeReviewTree = () => ({
        ...defaultTree(),
        scoresheetReview: { stopped: { ply: 1, tokens: ["e5"] } },
    });
    const store = createTreeStore(id, makeReviewTree());

    try {
        // setHeaders with unchanged FEN keeps scoresheetReview and photos.
        setScoresheetPhotos(id, [PHOTO]);
        store.getState().setHeaders({ ...store.getState().headers, white: "Alice" });
        expect(store.getState().scoresheetReview).toEqual({
            stopped: { ply: 1, tokens: ["e5"] },
        });
        expect(getScoresheetPhotos(id)).toEqual([PHOTO]);

        // setState with another game clears scoresheetReview and photos.
        store.getState().setState(defaultTree());
        expect(store.getState().scoresheetReview).toBeUndefined();
        expect(getScoresheetPhotos(id)).toEqual([]);

        // reset clears scoresheetReview and photos.
        store.getState().setState(makeReviewTree());
        setScoresheetPhotos(id, [PHOTO]);
        store.getState().reset();
        expect(store.getState().scoresheetReview).toBeUndefined();
        expect(getScoresheetPhotos(id)).toEqual([]);

        // setFen clears scoresheetReview and photos.
        store.getState().setState(makeReviewTree());
        setScoresheetPhotos(id, [PHOTO]);
        store.getState().setFen("4k3/8/8/8/8/8/8/4K3 w - - 0 1");
        expect(store.getState().scoresheetReview).toBeUndefined();
        expect(getScoresheetPhotos(id)).toEqual([]);

        // setHeaders with a different FEN clears scoresheetReview and photos.
        store.getState().setState(makeReviewTree());
        setScoresheetPhotos(id, [PHOTO]);
        store.getState().setHeaders({
            ...store.getState().headers,
            fen: "4k3/8/8/8/4P3/8/8/4K3 b - - 0 1",
        });
        expect(store.getState().scoresheetReview).toBeUndefined();
        expect(getScoresheetPhotos(id)).toEqual([]);

        // prepareTreeStoreRetarget clears scoresheetReview and photos.
        store.getState().setState(makeReviewTree());
        setScoresheetPhotos(id, [PHOTO]);
        const nextKey = crypto.randomUUID();
        tabStorage.seed(nextKey, defaultTree());
        prepareTreeStoreRetarget(id, nextKey, defaultTree())();
        expect(store.getState().scoresheetReview).toBeUndefined();
        expect(getScoresheetPhotos(id)).toEqual([]);
        tabStorage.remove(nextKey);
    } finally {
        clearAllScoresheetPhotosForTests();
    }
});

test("continueScoresheet after a stop replays tokens[L - ply] onward, stops at illegal/?, preserves stopped, and is one undo step", () => {
    const initial = defaultTree();
    const e4 = addMove(initial.root, "e2e4");
    const e5 = addMove(e4, "e7e5");
    const nf3 = addMove(e5, "g1f3");
    // Sheet stopped at ply 3 with tokens[0] = "?". User plays 2...Nc6 (L = 4 > ply = 3).
    const nc6 = addMove(nf3, "b8c6");
    nc6.unsure = true; // even if marked, user's move must not remain unsure
    initial.scoresheetReview = {
        stopped: { ply: 3, tokens: ["?", "Bb5", "a6", "?", "Ba4"] },
    };
    initial.position = [0, 0, 0, 0];

    const store = createTreeStore(undefined, initial);
    store.getState().continueScoresheet();

    // Appended tokens[4 - 3] = "Bb5", then "a6", stopped at "?".
    const mainSans = Array.from(treeIteratorMainLine(store.getState().root))
        .slice(1)
        .map(({ node }) => node.san);
    expect(mainSans).toEqual(["e4", "e5", "Nf3", "Nc6", "Bb5", "a6"]);
    // User's move is not unsure, position stays on the user's move, stopped is never rewritten.
    expect(getNodeAtPath(store.getState().root, [0, 0, 0, 0]).unsure).toBeUndefined();
    expect(store.getState().position).toEqual([0, 0, 0, 0]);
    expect(store.getState().scoresheetReview?.stopped).toEqual({
        ply: 3,
        tokens: ["?", "Bb5", "a6", "?", "Ba4"],
    });
    expect(store.getState().dirty).toBe(true);
    expect(store.getState().history.past).toHaveLength(1);

    // One undo step restores tree, position, and marks.
    store.getState().undo();
    const restoredSans = Array.from(treeIteratorMainLine(store.getState().root))
        .slice(1)
        .map(({ node }) => node.san);
    expect(restoredSans).toEqual(["e4", "e5", "Nf3", "Nc6"]);
    expect(getNodeAtPath(store.getState().root, [0, 0, 0, 0]).unsure).toBe(true);
    expect(store.getState().position).toEqual([0, 0, 0, 0]);
});

test("continueScoresheet is a no-op for L <= ply and outside a review", () => {
    const initial = defaultTree();
    const e4 = addMove(initial.root, "e2e4");
    const e5 = addMove(e4, "e7e5");
    addMove(e5, "g1f3"); // L = 3
    initial.scoresheetReview = { stopped: { ply: 3, tokens: ["Nc6", "Bb5"] } };
    initial.position = [0, 0, 0];

    const store = createTreeStore(undefined, initial);
    // L === ply (3 === 3) -> disabled.
    store.getState().continueScoresheet();
    expect(countMainPly(store.getState().root)).toBe(3);
    expect(store.getState().history.past).toHaveLength(0);

    // L < ply (2 < 3) -> disabled.
    store.getState().deleteMove([0, 0, 0]);
    expect(countMainPly(store.getState().root)).toBe(2);
    const historyAfterDelete = store.getState().history.past.length;
    store.getState().continueScoresheet();
    expect(countMainPly(store.getState().root)).toBe(2);
    expect(store.getState().history.past).toHaveLength(historyAfterDelete);

    // Outside a review -> disabled even on a 1-move variation beside main line.
    const noReview = defaultTree();
    const r1 = addMove(noReview.root, "e2e4");
    const r2 = addMove(r1, "e7e5");
    addMove(r2, "g1f3");
    addMove(r1, "c7c5");
    noReview.position = [0, 1];
    const noReviewStore = createTreeStore(undefined, noReview);
    noReviewStore.getState().continueScoresheet();
    expect(noReviewStore.getState().position).toEqual([0, 1]);
    expect(noReviewStore.getState().history.past).toHaveLength(0);
});

test("continueScoresheet replace-middle removes plain fully-replayed old line, preserves unsure by ply, appends stopped tokens, rebases paths, and is one undo step", () => {
    const initial = defaultTree();
    const e4 = addMove(initial.root, "e2e4");
    const e5 = addMove(e4, "e7e5");
    e5.unsure = true;
    const nf3 = addMove(e5, "g1f3");
    nf3.unsure = true; // sheet ply 2
    addMove(nf3, "b8c6"); // sheet ply 3 -> L = 4
    // Extra sibling variation at [0, 1] to verify path rebasing.
    addMove(e4, "d7d5");
    // User replaces 1...e5 with 1...c5 at [0, 2].
    const c5 = addMove(e4, "c7c5");
    c5.unsure = true;
    initial.headers.start = [0, 1]; // points to 1...d5
    initial.scoresheetReview = {
        stopped: { ply: 4, tokens: ["Bb5", "a6"] },
    };
    initial.position = [0, 2];

    const store = createTreeStore(undefined, initial);
    store.getState().continueScoresheet();

    // User's line (1...c5) is promoted to main line with 2.Nf3 Nc6 3.Bb5 a6 replayed.
    const mainSans = Array.from(treeIteratorMainLine(store.getState().root))
        .slice(1)
        .map(({ node }) => node.san);
    expect(mainSans).toEqual(["e4", "c5", "Nf3", "Nc6", "Bb5", "a6"]);

    // Old line (1...e5 ...) was fully replayed and plain -> removed!
    // Only [0, 0] (c5) and [0, 1] (d5) remain under e4.
    const e4Node = getNodeAtPath(store.getState().root, [0]);
    expect(e4Node.children.map((c) => c.san)).toEqual(["c5", "d5"]);

    // Position stays on user's move (now [0, 0]), headers.start still points to 1...d5 (now [0, 1]).
    expect(store.getState().position).toEqual([0, 0]);
    expect(getNodeAtPath(store.getState().root, store.getState().headers.start!).san).toBe("d5");

    // User's move is not unsure; replayed Nf3 (ply 2) keeps its unsure mark; Nc6, Bb5, a6 do not.
    expect(getNodeAtPath(store.getState().root, [0, 0]).unsure).toBeUndefined();
    expect(getNodeAtPath(store.getState().root, [0, 0, 0]).unsure).toBe(true);
    expect(getNodeAtPath(store.getState().root, [0, 0, 0, 0]).unsure).toBeUndefined();
    expect(getNodeAtPath(store.getState().root, [0, 0, 0, 0, 0]).unsure).toBeUndefined();

    // One undo step restores the old main line, marks, position, and headers.start.
    expect(store.getState().history.past).toHaveLength(1);
    store.getState().undo();
    const restoredMain = Array.from(treeIteratorMainLine(store.getState().root))
        .slice(1)
        .map(({ node }) => node.san);
    expect(restoredMain).toEqual(["e4", "e5", "Nf3", "Nc6"]);
    expect(store.getState().position).toEqual([0, 2]);
    expect(getNodeAtPath(store.getState().root, [0, 0]).unsure).toBe(true);
    expect(getNodeAtPath(store.getState().root, [0, 0, 0]).unsure).toBe(true);
    expect(getNodeAtPath(store.getState().root, store.getState().headers.start!).san).toBe("d5");
});

test("continueScoresheet replace-middle keeps old line without marks when replay ends early or old line is not plain", () => {
    // Case A: replay ends early at an illegal move.
    // Main line: 1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4. User replaces 3. Bb5 with 3. Bc4 -> 3...a6 legal, 4. Ba4 illegal.
    const early = defaultTree();
    const m1 = addMove(early.root, "e2e4");
    const m2 = addMove(m1, "e7e5");
    const m3 = addMove(m2, "g1f3");
    const m4 = addMove(m3, "b8c6");
    const m5 = addMove(m4, "f1b5");
    m5.unsure = true;
    const m6 = addMove(m5, "a7a6");
    m6.unsure = true;
    const m7 = addMove(m6, "b5a4");
    m7.unsure = true;
    addMove(m4, "f1c4"); // user variation at [0, 0, 0, 0, 1]
    early.scoresheetReview = {};
    early.position = [0, 0, 0, 0, 1];

    const earlyStore = createTreeStore(undefined, early);
    earlyStore.getState().continueScoresheet();

    const earlyMain = Array.from(treeIteratorMainLine(earlyStore.getState().root))
        .slice(1)
        .map(({ node }) => node.san);
    expect(earlyMain).toEqual(["e4", "e5", "Nf3", "Nc6", "Bc4", "a6"]);
    expect(earlyStore.getState().position).toEqual([0, 0, 0, 0, 0]);
    // Replayed a6 kept its unsure mark.
    expect(getNodeAtPath(earlyStore.getState().root, [0, 0, 0, 0, 0, 0]).unsure).toBe(true);
    // Old line (3. Bb5 a6 4. Ba4) stays as variation [0, 0, 0, 0, 1] and loses all its marks.
    const keptOld = getNodeAtPath(earlyStore.getState().root, [0, 0, 0, 0, 1]);
    expect(keptOld.san).toBe("Bb5");
    expect(keptOld.unsure).toBeUndefined();
    expect(keptOld.children[0].unsure).toBeUndefined();
    expect(keptOld.children[0].children[0].unsure).toBeUndefined();

    // Case B: fully replayed, but old line is not plain (has a comment and a sub-variation with an unsure mark).
    const annotated = defaultTree();
    const a1 = addMove(annotated.root, "e2e4");
    const a2 = addMove(a1, "e7e5");
    a2.unsure = true;
    const a3 = addMove(a2, "g1f3");
    a3.comment = "keep me";
    const sub = addMove(a2, "f2f4");
    sub.unsure = true;
    addMove(a1, "c7c5"); // user variation at [0, 1]
    annotated.scoresheetReview = {};
    annotated.position = [0, 1];

    const annotatedStore = createTreeStore(undefined, annotated);
    annotatedStore.getState().continueScoresheet();

    const annotatedMain = Array.from(treeIteratorMainLine(annotatedStore.getState().root))
        .slice(1)
        .map(({ node }) => node.san);
    expect(annotatedMain).toEqual(["e4", "c5", "Nf3"]);
    const keptAnnotated = getNodeAtPath(annotatedStore.getState().root, [0, 1]);
    expect(keptAnnotated.san).toBe("e5");
    expect(keptAnnotated.unsure).toBeUndefined();
    expect(keptAnnotated.children[0].comment).toBe("keep me");
    expect(keptAnnotated.children[1].unsure).toBeUndefined();
});

test("continueScoresheet moves final gameEnd marker to replayed counterpart when complete game is fully replayed, and keeps it on old variation on partial replay", () => {
    // Complete game "1. e4 e5 2. Nf3 Nc6 1-0" with gameEnd on last move Nc6, corrected at move 1 (1. d4).
    const complete = defaultTree();
    complete.headers.result = "1-0";
    const c1 = addMove(complete.root, "e2e4");
    const c2 = addMove(c1, "e7e5");
    const c3 = addMove(c2, "g1f3");
    const c4 = addMove(c3, "b8c6");
    c4.gameEnd = { termination: "Normal" };
    addMove(complete.root, "d2d4"); // user replaces 1.e4 with 1.d4 at [1]
    complete.scoresheetReview = {};
    complete.position = [1];

    const completeStore = createTreeStore(undefined, complete);
    completeStore.getState().continueScoresheet();

    const completeMain = Array.from(treeIteratorMainLine(completeStore.getState().root))
        .slice(1)
        .map(({ node }) => node.san);
    expect(completeMain).toEqual(["d4", "e5", "Nf3", "Nc6"]);
    // Plain old line is removed, and gameEnd moved to the replayed counterpart (new last move Nc6).
    expect(completeStore.getState().root.children).toHaveLength(1);
    expect(getNodeAtPath(completeStore.getState().root, [0, 0, 0, 0]).gameEnd).toEqual({
        termination: "Normal",
    });

    // Partial replay: "1. e4 d5 2. exd5 1-0" corrected at 1...e5 -> 2.exd5 is illegal.
    const partial = defaultTree();
    partial.headers.result = "1-0";
    const p1 = addMove(partial.root, "e2e4");
    const p2 = addMove(p1, "d7d5");
    p2.unsure = true;
    const p3 = addMove(p2, "e4d5");
    p3.unsure = true;
    p3.gameEnd = {};
    addMove(p1, "e7e5"); // user replaces 1...d5 with 1...e5 at [0, 1]
    partial.scoresheetReview = {};
    partial.position = [0, 1];

    const partialStore = createTreeStore(undefined, partial);
    partialStore.getState().continueScoresheet();

    // New main line has no gameEnd marker; old line stays as variation with its gameEnd and without unsure marks.
    expect(getNodeAtPath(partialStore.getState().root, [0, 0]).san).toBe("e5");
    expect(getNodeAtPath(partialStore.getState().root, [0, 0]).gameEnd).toBeUndefined();
    const keptOld = getNodeAtPath(partialStore.getState().root, [0, 1]);
    expect(keptOld.san).toBe("d5");
    expect(keptOld.unsure).toBeUndefined();
    expect(keptOld.children[0].unsure).toBeUndefined();
    expect(keptOld.children[0].gameEnd).toEqual({});

    // Fully replayed but non-plain old line (comment on earlier move): stays as variation,
    // and gameEnd moves to the new main line's last move and is removed from the kept variation.
    const keptWithComment = defaultTree();
    keptWithComment.headers.result = "1-0";
    const k1 = addMove(keptWithComment.root, "e2e4");
    const k2 = addMove(k1, "e7e5");
    k2.comment = "keep variation";
    const k3 = addMove(k2, "g1f3");
    k3.gameEnd = { termination: "Normal" };
    addMove(k1, "c7c5"); // user replaces 1...e5 with 1...c5 at [0, 1]
    keptWithComment.scoresheetReview = {};
    keptWithComment.position = [0, 1];

    const keptStore = createTreeStore(undefined, keptWithComment);
    keptStore.getState().continueScoresheet();

    expect(getNodeAtPath(keptStore.getState().root, [0, 0, 0]).gameEnd).toEqual({
        termination: "Normal",
    });
    const keptVar = getNodeAtPath(keptStore.getState().root, [0, 1]);
    expect(keptVar.san).toBe("e5");
    expect(keptVar.comment).toBe("keep variation");
    expect(keptVar.children[0].gameEnd).toBeUndefined();
});

test("continueScoresheet removes plain old line when all old moves replay even if a later sheet token fails", () => {
    const initial = defaultTree();
    const e4 = addMove(initial.root, "e2e4");
    const e5 = addMove(e4, "e7e5");
    addMove(e5, "g1f3"); // L = 3
    addMove(e4, "c7c5"); // user variation at [0, 1]
    // All 1 old move (Nf3) replays, then stopped token "?" fails (replayed = 1 >= oldMainLineMoveCount = 1, < plan.moves.length = 3).
    initial.scoresheetReview = { stopped: { ply: 3, tokens: ["?", "Bb5"] } };
    initial.position = [0, 1];

    const store = createTreeStore(undefined, initial);
    store.getState().continueScoresheet();

    const mainSans = Array.from(treeIteratorMainLine(store.getState().root))
        .slice(1)
        .map(({ node }) => node.san);
    expect(mainSans).toEqual(["e4", "c5", "Nf3"]);
    // Plain old line was removed despite the later sheet token failing.
    expect(getNodeAtPath(store.getState().root, [0]).children).toHaveLength(1);
});

test("continueScoresheet after-stop is a no-op when first remaining token is illegal/? and user move has no mark", () => {
    const initial = defaultTree();
    const e4 = addMove(initial.root, "e2e4");
    const e5 = addMove(e4, "e7e5");
    const nf3 = addMove(e5, "g1f3");
    addMove(nf3, "b8c6"); // L = 4, no unsure mark
    initial.scoresheetReview = { stopped: { ply: 3, tokens: ["Nc6", "?", "a6"] } };
    initial.position = [0, 0, 0, 0];

    const store = createTreeStore(undefined, initial);
    const rootBefore = store.getState().root;
    store.getState().continueScoresheet();

    expect(store.getState().root).toBe(rootBefore);
    expect(store.getState().dirty).toBe(false);
    expect(store.getState().history.past).toHaveLength(0);
});

test("clearReviewMark clears the mark as one undoable edit and is a no-op when absent", () => {
    const initial = defaultTree();
    const e4 = addMove(initial.root, "e2e4");
    e4.reviewMark = true;
    const store = createTreeStore(undefined, initial);

    store.getState().clearReviewMark([]);
    expect(store.getState().dirty).toBe(false);
    expect(store.getState().history.past).toHaveLength(0);

    store.getState().clearReviewMark([0]);
    expect(store.getState().root.children[0].reviewMark).toBeUndefined();
    expect(store.getState().dirty).toBe(true);
    expect(store.getState().history.past).toHaveLength(1);

    // Clearing again is a no-op (no second undo entry).
    store.getState().clearReviewMark([0]);
    expect(store.getState().history.past).toHaveLength(1);

    store.getState().undo();
    expect(store.getState().root.children[0].reviewMark).toBe(true);

    store.getState().redo();
    expect(store.getState().root.children[0].reviewMark).toBeUndefined();
});

test("applyRepertoireImport applies a finished merge as one undo step, marks dirty, and keeps cursor valid", () => {
    const initial = defaultTree();
    const e4 = addMove(initial.root, "e2e4");
    addMove(e4, "e7e5");
    initial.position = [0, 0];
    const store = createTreeStore(undefined, initial);

    const game1 = defaultTree();
    const g1e4 = addMove(game1.root, "e2e4");
    addMove(g1e4, "c7c5");

    const game2 = defaultTree();
    const g2d4 = addMove(game2.root, "d2d4");
    addMove(g2d4, "d7d5");

    const snapshot = store.getState();
    const merged = mergeIntoRepertoire(snapshot, [game1, game2], "white");
    expect(merged.ok).toBe(true);
    if (!merged.ok) throw new Error("Expected merge to succeed");

    const applied = store
        .getState()
        .applyRepertoireImport(snapshot.documentId, snapshot.root, snapshot.headers, merged);
    expect(applied).toBe(true);
    expect(merged.report).toEqual({ added: 3, conflicts: 1, unplaced: 0 });
    expect(store.getState().dirty).toBe(true);
    expect(store.getState().history.past).toHaveLength(1);
    expect(store.getState().position).toEqual([0, 0]);
    expect(getNodeAtPath(store.getState().root, [0, 0]).san).toBe("e5");
    expect(getNodeAtPath(store.getState().root, [1]).reviewMark).toBe(true);

    // One undo restores the entire pre-import tree.
    store.getState().undo();
    expect(store.getState().root.children).toHaveLength(1);
    expect(store.getState().root.children[0].children).toHaveLength(1);
    expect(store.getState().position).toEqual([0, 0]);
});

test("applyRepertoireImport no-op and stale snapshot change nothing (no history, dirty unchanged)", () => {
    const initial = defaultTree();
    const e4 = addMove(initial.root, "e2e4");
    addMove(e4, "e7e5");
    const store = createTreeStore(undefined, initial);

    // No-op: identical game already present (changed === false).
    const duplicate = defaultTree();
    const de4 = addMove(duplicate.root, "e2e4");
    addMove(de4, "e7e5");
    const snap1 = store.getState();
    const noopMerged = mergeIntoRepertoire(snap1, [duplicate], "white");
    expect(noopMerged.ok).toBe(true);
    if (!noopMerged.ok) throw new Error("Expected no-op merge to succeed");
    expect(
        store
            .getState()
            .applyRepertoireImport(snap1.documentId, snap1.root, snap1.headers, noopMerged),
    ).toBe(true);
    expect(store.getState().dirty).toBe(false);
    expect(store.getState().history.past).toHaveLength(0);

    // Prepare a real merge against snap1, then mutate the store before applying.
    const extra = defaultTree();
    addMove(extra.root, "d2d4");
    const realMerged = mergeIntoRepertoire(snap1, [extra], "white");
    expect(realMerged.ok).toBe(true);
    if (!realMerged.ok) throw new Error("Expected merge to succeed");

    // Stale documentId -> rejected without changing state.
    expect(
        store
            .getState()
            .applyRepertoireImport(snap1.documentId + 1, snap1.root, snap1.headers, realMerged),
    ).toBe(false);
    expect(store.getState().dirty).toBe(false);
    expect(store.getState().history.past).toHaveLength(0);
    expect(store.getState().root.children).toHaveLength(1);

    // Stale root (same documentId, tree edited while import was in flight) -> rejected.
    store.getState().makeMove({ payload: "c4" });
    const historyAfterEdit = store.getState().history.past.length;
    expect(
        store
            .getState()
            .applyRepertoireImport(snap1.documentId, snap1.root, snap1.headers, realMerged),
    ).toBe(false);
    expect(store.getState().history.past).toHaveLength(historyAfterEdit);
    expect(store.getState().root.children.map((c) => c.san)).toEqual(["e4", "c4"]);

    // Stale headers (setHeaders between snapshot and apply) -> rejected, never reverts headers.
    const snap2 = store.getState();
    const extra2 = defaultTree();
    addMove(extra2.root, "f2f4");
    const merged2 = mergeIntoRepertoire(snap2, [extra2], "white");
    expect(merged2.ok).toBe(true);
    if (!merged2.ok) throw new Error("Expected merge to succeed");
    store.getState().setHeaders({ ...snap2.headers, white: "Carlsen" });
    const historyAfterHeaders = store.getState().history.past.length;
    expect(
        store
            .getState()
            .applyRepertoireImport(snap2.documentId, snap2.root, snap2.headers, merged2),
    ).toBe(false);
    expect(store.getState().headers.white).toBe("Carlsen");
    expect(store.getState().history.past).toHaveLength(historyAfterHeaders);
});
