import { expect, test } from "vitest";
import { createTreeStore } from "@/state/store/tree";
import { defaultTree, getNodeAtPath } from "@/utils/treeReducer";
import { resolveCoachInsertPath } from "./coachInsert";

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
