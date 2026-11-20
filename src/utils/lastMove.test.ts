import { parseUci } from "chessops";
import { expect, test } from "vitest";
import { lastMoveSquares, lastMoveTarget } from "./chessops";

test.each([
    ["e2e4", "e4", ["e2", "e4"]],
    ["e1h1", "O-O", ["e1", "g1"]],
    ["e1a1", "O-O-O+", ["e1", "c1"]],
    ["e8h8", "O-O", ["e8", "g8"]],
    ["e8a8", "O-O-O", ["e8", "c8"]],
    // A rook move that only looks like the castling encoding keeps its own squares.
    ["e1h1", "Rh1", ["e1", "h1"]],
])("the last-move squares of %s (%s) are %j", (uci, san, squares) => {
    const node = { move: parseUci(uci)!, san };
    expect(lastMoveSquares(node)).toEqual(squares);
});

test("a node without a move has no last-move squares", () => {
    expect(lastMoveSquares({ move: null, san: null })).toBeUndefined();
    expect(lastMoveTarget({ move: null, san: null })).toBeUndefined();
});
