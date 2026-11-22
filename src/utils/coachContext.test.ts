import { expect, test } from "vitest";
import { defaultTree } from "@/utils/treeReducer";
import { createTreeStore } from "@/state/store/tree";
import { coachGameContext, MAX_COACH_GAME_BYTES } from "./coachContext";

function game(moves: string[]) {
    const store = createTreeStore();
    store.getState().setState(defaultTree());
    const result = store.getState().makeMoves({ payload: moves });
    expect(result.success).toBe(true);
    return store;
}

test("a game that fits is sent whole, with comments and variations", () => {
    const store = game(["e4", "e5", "Nf3"]);
    store.getState().setComment("King's knight.");
    store.getState().goToMove([0, 0]);
    store.getState().makeMoves({ payload: ["Bc4"] });
    const state = store.getState();
    const text = coachGameContext(state.root, state.headers, state.position);
    expect(text).toContain("1. e4 e5 2. Nf3");
    expect(text).toContain("King's knight.");
    expect(text).toContain("(2. Bc4");
});

test("a game that is too large keeps the board's line whole and drops the rest", () => {
    const store = game(["e4", "e5"]);
    // A side line off the first move with a huge comment, and the line the board is on.
    store.getState().goToMove([0]);
    store.getState().makeMoves({ payload: ["c5", "Nf3"] });
    store.getState().setComment("x".repeat(MAX_COACH_GAME_BYTES));
    store.getState().goToMove([0, 0]);
    store.getState().makeMoves({ payload: ["Nf3", "Nc6"] });
    store.getState().setComment("On the board's line.");
    const state = store.getState();
    expect(state.position).toEqual([0, 0, 0, 0]);
    const text = coachGameContext(state.root, state.headers, state.position);
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(MAX_COACH_GAME_BYTES);
    expect(text).toContain("1. e4 e5 2. Nf3 Nc6");
    expect(text).toContain("On the board's line.");
    expect(text).not.toContain("c5");
});

test("comments go before the line does, and a line that cannot fit is left out", () => {
    const store = game(["e4", "e5"]);
    store.getState().setComment("y".repeat(MAX_COACH_GAME_BYTES));
    let state = store.getState();
    const text = coachGameContext(state.root, state.headers, state.position);
    expect(text).toContain("1. e4 e5");
    expect(text).not.toContain("yyyy");

    store.getState().setHeaders({ ...state.headers, event: "z".repeat(MAX_COACH_GAME_BYTES) });
    state = store.getState();
    expect(coachGameContext(state.root, state.headers, state.position)).toBe("");
});
