import { Chess, parseSquare } from "chessops";
import { INITIAL_FEN } from "chessops/fen";
import { describe, expect, test } from "vitest";
import { dropInvalidEpSquare, hasCaptures, isOp1, positionFromFen, swapMove } from "./chessops";

function position(fen: string) {
    const [pos, error] = positionFromFen(fen);
    if (!pos) throw error;
    return pos;
}

describe("swapMove", () => {
    test("toggles the side to move", () => {
        const blackToMove = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1";
        expect(swapMove(INITIAL_FEN)).toBe(blackToMove);
        expect(swapMove(blackToMove)).toBe(INITIAL_FEN);
    });

    test("sets an explicit color whether or not it matches the current turn", () => {
        expect(swapMove(INITIAL_FEN, "white")).toBe(INITIAL_FEN);
        expect(swapMove(swapMove(INITIAL_FEN), "white")).toBe(INITIAL_FEN);
        expect(swapMove(INITIAL_FEN, "black")).toBe(swapMove(INITIAL_FEN));
    });

    test("clears an en-passant square when the turn actually changes", () => {
        const withEp = "rnbqkb1r/ppp1pppp/5n2/3pP3/8/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 3";
        expect(swapMove(withEp, "black")).toBe(
            "rnbqkb1r/ppp1pppp/5n2/3pP3/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 3",
        );
        expect(swapMove(withEp, "white")).toBe(withEp);
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

describe("dropInvalidEpSquare", () => {
    test.each([
        // Wrong side: the pawn on e4 was pushed by White, yet Black's ep square is on rank 6.
        ["4k3/8/8/8/4P3/8/8/4K3 b - e6 0 1", "4k3/8/8/8/4P3/8/8/4K3 b - - 0 1"],
        // No pawn was pushed in front of the square.
        [
            "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq e3 0 1",
            "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
        ],
        ["4k3/8/8/8/8/8/8/4K3 w - e6 0 1", "4k3/8/8/8/8/8/8/4K3 w - - 0 1"],
        // The square itself is occupied, which chessops' own check accepts.
        ["4k3/8/4n3/4p3/8/8/8/4K3 w - e6 0 1", "4k3/8/4n3/4p3/8/8/8/4K3 w - - 0 1"],
        // The pawn's origin is occupied.
        ["4k3/4n3/8/4p3/8/8/8/4K3 w - e6 0 1", "4k3/4n3/8/4p3/8/8/8/4K3 w - - 0 1"],
        // Other separators and clock fields stay byte-identical.
        ["4k3/8/8/8/8/8/8/4K3_w_-_e6_7_42", "4k3/8/8/8/8/8/8/4K3_w_-_-_7_42"],
    ])("drops the impossible square in %s", (fen, expected) => {
        expect(dropInvalidEpSquare(fen)).toBe(expected);
    });

    test.each([
        // Structurally valid without a legal capture: shakmaty accepts it, so it is kept.
        "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1",
        "rnbqkb1r/ppp1pppp/5n2/3pP3/8/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 3",
        INITIAL_FEN,
        "4k3/8/8/8/8/8/8/4K3 w - -",
        "not a fen e6",
    ])("keeps %s", (fen) => {
        expect(dropInvalidEpSquare(fen)).toBe(fen);
    });
});
