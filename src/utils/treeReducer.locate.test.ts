import { expect, test } from "vitest";
import { createTreeStore } from "@/state/store/tree";
import { defaultTree, getBoardState, getNodeAtPath, locateBoardState } from "@/utils/treeReducer";

/** Where a line that starts from `fen` can go in the tree now, as the Coach's insert asks it. */
function resolveCoachInsertPath(
    root: Parameters<typeof locateBoardState>[0],
    path: readonly number[],
    fen: string,
) {
    return locateBoardState(root, path, getBoardState(fen))?.position ?? null;
}

function game(fen?: string) {
    const store = createTreeStore();
    store.getState().setState(defaultTree(fen));
    return store;
}

test("the remembered path is used while it still leads to the question's position", () => {
    const store = game();
    store.getState().makeMoves({ payload: ["e4", "e5", "Nf3"] });
    const { root } = store.getState();
    const fen = getNodeAtPath(root, [0, 0]).fen;
    expect(resolveCoachInsertPath(root, [0, 0], fen)).toEqual([0, 0]);
    // Clocks differ between the stored FEN and the node: the position is what counts.
    expect(resolveCoachInsertPath(root, [0, 0], fen.replace(/ \d+ \d+$/, " 9 30"))).toEqual([0, 0]);
});

test("a path that no longer resolves completely falls back to a search for the position", () => {
    const store = game();
    store.getState().makeMoves({ payload: ["e4", "e5", "Nf3"] });
    const fen = store.getState().currentNode().fen;
    const path = [...store.getState().position];
    store.getState().deleteMove([0, 0, 0]);
    expect(resolveCoachInsertPath(store.getState().root, path, fen)).toBeNull();

    // The same position is reached again elsewhere in the tree: the line can go there.
    store.getState().goToMove([]);
    store.getState().makeMoves({ payload: ["Nf3", "e5", "e4"] });
    const found = resolveCoachInsertPath(store.getState().root, path, fen);
    expect(found).toEqual([1, 0, 0]);
});

test("a path that resolves to another position is not trusted", () => {
    const store = game();
    store.getState().makeMoves({ payload: ["e4", "e5"] });
    const fen = store.getState().currentNode().fen;
    // The first move is replaced: index 0 now leads somewhere else.
    store.getState().deleteMove([0]);
    store.getState().makeMoves({ payload: ["d4", "d5"] });
    const { root } = store.getState();
    expect(getNodeAtPath(root, [0, 0]).san).toBe("d5");
    expect(resolveCoachInsertPath(root, [0, 0], fen)).toBeNull();
});

test("a game that starts with Black to move resolves like any other", () => {
    const start = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
    const store = game(start);
    store.getState().makeMoves({ payload: ["e5", "Nf3"] });
    const { root } = store.getState();
    expect(resolveCoachInsertPath(root, [], start)).toEqual([]);
    expect(resolveCoachInsertPath(root, [0, 0], getNodeAtPath(root, [0, 0]).fen)).toEqual([0, 0]);
});

test("a node the caller does not accept is passed over, on the remembered path and in the search", () => {
    const store = game();
    // The same position twice: once as the end of a line, once with a move after it.
    store.getState().makeMoves({ payload: ["e4", "e5", "Nf3", "Nc6", "Nc3"] });
    store.getState().goToMove([]);
    store.getState().makeMoves({ payload: ["Nc3", "e5", "Nf3", "Nc6", "e4", "Bc5"] });
    const { root } = store.getState();
    const leaf = getNodeAtPath(root, [0, 0, 0, 0, 0]);
    expect(leaf.children).toHaveLength(0);
    const state = getBoardState(leaf.fen);
    expect(locateBoardState(root, [0, 0, 0, 0, 0], state)?.position).toEqual([0, 0, 0, 0, 0]);
    const continued = locateBoardState(
        root,
        [0, 0, 0, 0, 0],
        state,
        (node) => node.children.length > 0,
    );
    expect(continued?.position).toEqual([1, 0, 0, 0, 0]);
    expect(continued?.node.children[0].san).toBe("Bc5");
});

test("the remembered path wins over an earlier node with the same position", () => {
    const store = game();
    // The same position at the end of two lines; the remembered path is the later one.
    store.getState().makeMoves({ payload: ["e4", "e5", "Nf3", "Nc6", "Nc3"] });
    store.getState().goToMove([]);
    store.getState().makeMoves({ payload: ["Nc3", "e5", "Nf3", "Nc6", "e4"] });
    const { root } = store.getState();
    const remembered = [1, 0, 0, 0, 0];
    const node = getNodeAtPath(root, remembered);
    const state = getBoardState(node.fen);
    expect(getBoardState(getNodeAtPath(root, [0, 0, 0, 0, 0]).fen)).toBe(state);

    const found = locateBoardState(root, remembered, state);
    expect(found?.position).toEqual(remembered);
    expect(found?.node).toBe(node);
    // The answer is a path of its own, not the caller's array.
    expect(found?.position).not.toBe(remembered);
});

test("a path that runs past the end of its line is not returned, even where the line ends on the position", () => {
    const store = game();
    store.getState().makeMoves({ payload: ["e4", "e5"] });
    const { root } = store.getState();
    const end = getNodeAtPath(root, [0, 0]);
    expect(end.children).toHaveLength(0);
    // `[0, 0, 7]` no longer resolves; walking it stops on the node the search finds at `[0, 0]`.
    const found = locateBoardState(root, [0, 0, 7], getBoardState(end.fen));
    expect(found?.position).toEqual([0, 0]);
    expect(found?.node).toBe(end);
});
