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
    createNode,
    defaultTree,
    getMemoizedBoardStateMap,
    getNodeAtPath,
    getEffectiveGameEnd,
    getEffectiveTermination,
    MAX_GAME_END_TERMINATION_LENGTH,
    treeIterator,
    type TreeNode,
} from "@/utils/treeReducer";
import { positionFromFen } from "@/utils/chessops";
import * as sound from "@/utils/sound";
import {
    closeTreeStore,
    createTreeStore,
    discardTreeStoreStorage,
    nextContinuation,
    nextLineStart,
    retryTreeStoreStorage,
    validateMoveSequence,
} from "./tree";
import { tabStorage } from "./tabStorage";
import { serializeStorageValue } from "./debouncedStorage";
import { emptyPuzzleSession } from "@/state/puzzleSession";

const persistedIds: string[] = [];

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

// 1.e4 (1.d4 d5 (1...Nf6 2.c4) 2.c4) (1.c4) 1...e5 2.Nf3 (2.Nc3) 2...Nc6
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
            ],
        }),
        fixtureNode("c4"),
    ];
    return tree;
}

test.each([
    { from: [0, 0, 0, 0], to: [1], why: "main line end goes to the first root alternative" },
    { from: [1, 0, 0], to: [1, 1], why: "a line is followed by its own nested variation" },
    { from: [1, 1, 0], to: [2], why: "a nested line is followed by the next sibling line" },
    {
        from: [2],
        to: [0, 0, 1],
        why: "the root alternatives are followed by later main-line forks",
    },
    { from: [0, 0, 1], to: null, why: "the last line in the notation has no successor" },
    { from: [0, 0], to: [1], why: "any move inside a line names the same successor" },
    { from: [], to: null, why: "the start position belongs to no line" },
])("nextLineStart: $why", ({ from, to }) => {
    expect(nextLineStart(linesTree().root, from)).toEqual(to);
});

test("goToBranchEndOrNextLine walks every line once, in notation order", () => {
    const store = createTreeStore(undefined, linesTree());
    const visited: string[] = [];
    for (let i = 0; i < 12; i += 1) {
        store.getState().goToBranchEndOrNextLine();
        visited.push(store.getState().position.join("."));
    }
    expect(visited).toEqual([
        "0.0.0.0",
        "1",
        "1.0.0",
        "1.1",
        "1.1.0",
        "2",
        "0.0.1",
        "0.0.1",
        "0.0.1",
        "0.0.1",
        "0.0.1",
        "0.0.1",
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
