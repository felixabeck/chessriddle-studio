import { Chess, parseSquare } from "chessops";
import { INITIAL_FEN } from "chessops/fen";
import { describe, expect, test } from "vitest";
import { hasCaptures, isOp1, positionFromFen, swapMove } from "./chessops";

function position(fen: string) {
    const [pos, error] = positionFromFen(fen);
    if (!pos) throw error;
    return pos;
}

describe("swapMove", () => {
    test("toggles the side to move without changing other FEN fields", () => {
        const blackToMove = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1";
        expect(swapMove(INITIAL_FEN)).toBe(blackToMove);
        expect(swapMove(blackToMove)).toBe(INITIAL_FEN);
    });

    test("sets an explicit color whether or not it matches the current turn", () => {
        expect(swapMove(INITIAL_FEN, "white")).toBe(INITIAL_FEN);
        expect(swapMove(swapMove(INITIAL_FEN), "white")).toBe(INITIAL_FEN);
        expect(swapMove(INITIAL_FEN, "black")).toBe(swapMove(INITIAL_FEN));
    });
});

describe("hasCaptures", () => {
    test("finds a legal pawn capture", () => {
        expect(hasCaptures(position("4k3/8/8/3p4/4P3/8/8/4K3 w - - 0 1"))).toBe(true);
    });

    test("returns false for the quiet starting position", () => {
        expect(hasCaptures(Chess.default())).toBe(false);
    });

    test("finds a legal en-passant capture onto an empty square", () => {
        expect(hasCaptures(position("knn5/8/8/3pP3/8/8/8/KNN5 w - d6 0 2"))).toBe(true);
    });

    test("does not count castling onto the own rook square as a capture", () => {
        const pos = position("4k3/8/8/8/8/8/8/4K2R w K - 0 1");
        expect(pos.allDests().get(parseSquare("e1")!)?.has(parseSquare("h1")!)).toBe(true);
        expect(hasCaptures(pos)).toBe(false);
    });
});

describe("isOp1", () => {
    test("finds opposing pawns on the same file", () => {
        expect(isOp1(position("4k2r/8/4p3/8/4P3/8/8/4K2R w - - 0 1"))).toBe(true);
    });

    test("returns false when no opposing pawns share a file", () => {
        expect(isOp1(position("4k2r/8/3p4/8/4P3/8/8/4K2R w - - 0 1"))).toBe(false);
    });

    test("returns false when there are no black pawns", () => {
        expect(isOp1(position("4k2r/8/8/8/4P3/8/8/4K2R w - - 0 1"))).toBe(false);
    });

    test.each(["4k2r/8/4p3/8/4P3/8/8/4K3 w - - 0 1", "4k3/8/4p3/8/4P3/8/8/4K2R w - - 0 1"])(
        "excludes a side with only a king and one pawn: %s",
        (fen) => {
            expect(isOp1(position(fen))).toBe(false);
        },
    );
});
