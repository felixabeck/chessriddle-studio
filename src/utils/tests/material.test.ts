import { expect, test } from "vitest";
import { INITIAL_FEN } from "chessops/fen";
import { getMaterialDiff } from "../chess";

const noPieces = { p: 0, n: 0, b: 0, r: 0, q: 0 };

test("the starting position has no captures or material difference", () => {
    expect(getMaterialDiff(INITIAL_FEN)).toEqual({
        pieces: noPieces,
        whiteCaptured: noPieces,
        blackCaptured: noPieces,
        diff: 0,
    });
});

test.each([
    { role: "q", piece: "Q", value: 9 },
    { role: "r", piece: "R", value: 5 },
    { role: "b", piece: "B", value: 3 },
    { role: "n", piece: "N", value: 3 },
] as const)("a white pawn promoted to $role is not captured", ({ role, piece, value }) => {
    const material = getMaterialDiff(
        `rnbq${piece}bnr/pppppppp/k7/8/8/8/PPPP1PPP/RNBQKBNR b KQ - 0 1`,
    );

    expect(material).toEqual({
        pieces: { ...noPieces, p: -1, [role]: 1 },
        whiteCaptured: noPieces,
        blackCaptured: noPieces,
        diff: value - 1,
    });
});

test.each([
    { role: "q", piece: "q", value: 9 },
    { role: "r", piece: "r", value: 5 },
    { role: "b", piece: "b", value: 3 },
    { role: "n", piece: "n", value: 3 },
] as const)("a black pawn promoted to $role is not captured", ({ role, piece, value }) => {
    const material = getMaterialDiff(
        `rnbqkbnr/pppp1ppp/8/8/8/K7/PPPPPPPP/RNBQ${piece}BNR w kq - 0 1`,
    );

    expect(material).toEqual({
        pieces: { ...noPieces, p: 1, [role]: -1 },
        whiteCaptured: noPieces,
        blackCaptured: noPieces,
        diff: 1 - value,
    });
});

test("a missing black pawn is still captured", () => {
    const material = getMaterialDiff("rnbqkbnr/ppp1pppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");

    expect(material?.whiteCaptured).toEqual({ ...noPieces, p: 1 });
    expect(material?.blackCaptured).toEqual(noPieces);
});

test("a white promotion does not explain a missing black pawn", () => {
    const material = getMaterialDiff("rnbqQbnr/ppp1pppp/k7/8/8/8/PPPP1PPP/RNBQKBNR b KQ - 0 1");

    expect(material?.whiteCaptured).toEqual({ ...noPieces, p: 1 });
    expect(material?.blackCaptured).toEqual(noPieces);
});

test("only promoted pawns are excluded when a pawn was also captured", () => {
    const material = getMaterialDiff("rnbqQbnr/pppppppp/k7/8/8/8/PPP2PPP/RNBQKBNR b KQ - 0 1");

    expect(material?.whiteCaptured).toEqual(noPieces);
    expect(material?.blackCaptured).toEqual({ ...noPieces, p: 1 });
});

test("multiple promotion roles account for multiple missing pawns", () => {
    const material = getMaterialDiff("rnbqQbnr/pppppppp/k7/8/8/3N4/PPP2PPP/RNBQKBNR b KQ - 0 1");

    expect(material?.whiteCaptured).toEqual(noPieces);
    expect(material?.blackCaptured).toEqual(noPieces);
    expect(material?.pieces).toEqual({ ...noPieces, p: -2, n: 1, q: 1 });
    expect(material?.diff).toBe(10);
});
