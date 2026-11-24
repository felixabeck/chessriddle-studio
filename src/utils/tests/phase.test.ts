import { describe, expect, test } from "vitest";
import type { Chess } from "chessops";
import { INITIAL_FEN } from "chessops/fen";
import { positionFromFen } from "../chessops";
import { getGamePhases } from "../phase";

function board(fen: string): Chess {
    const [position, error] = positionFromFen(fen);
    if (!position) throw new Error(`invalid test FEN ${fen}: ${String(error)}`);
    return position;
}

const START = board(INITIAL_FEN);
// 14 majors and minors, but only R, K, R left on White's first rank.
const WHITE_BACKRANK_SPARSE = board(
    "rnbqkbnr/pppppppp/8/8/2BN1N2/2B1Q3/PPPPPPPP/R3K2R w KQkq - 0 1",
);
// The mirror: only r, k, r left on Black's eighth rank.
const BLACK_BACKRANK_SPARSE = board(
    "r3k2r/pppppppp/2b1q3/2bn1n2/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
);
// One more piece home on each side: four pieces on the back rank are not sparse.
const WHITE_BACKRANK_FOUR = board("rnbqkbnr/pppppppp/8/8/2BN1N2/4Q3/PPPPPPPP/R1B1K2R w KQkq - 0 1");
const BLACK_BACKRANK_FOUR = board("r1b1k2r/pppppppp/4q3/2bn1n2/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
// 14 majors and minors and at least seven pieces on each back rank, with interlocked pawns
// on ranks 4 and 5 — the 2x2 regions there straddle the 32-bit lo/hi bitboard split. With
// White's bishop on d2 the contact score is 155, just over the threshold of 150.
const CONTACT_MIDDLEGAME = board("rnbqkbnr/8/8/PpPpPpPp/pPpPpPpP/8/3B4/RN1QKBNR w KQkq - 0 1");
// The same pawns with White's bishop on c1 and Black's knights on b7 and b6: the contact
// score is 149, just under the threshold. Shifting the hi word by one bit or the region
// rank by one lifts it over 150, so this fixture also guards the region geometry.
const CONTACT_BELOW_THRESHOLD = board(
    "r1bqkb1r/1n6/1n6/PpPpPpPp/pPpPpPpP/8/8/RNBQKBNR w KQkq - 0 1",
);
// Material boundaries, pawns at home and at least four pieces on each back rank, so neither
// back-rank sparseness nor contact (mixedness 0) can fire: only the material count decides.
const ELEVEN_PIECES = board("rnbqk1nr/pppppppp/8/8/8/8/PPPPPPPP/RNBQK2R w KQkq - 0 1");
const TEN_PIECES = board("rnbqk2r/pppppppp/8/8/8/8/PPPPPPPP/RNBQK2R w KQkq - 0 1");
const SEVEN_PIECES = board("r2qk2r/pppppppp/8/8/8/8/PPPPPPPP/RN1QK2R w KQkq - 0 1");
const SIX_PIECES = board("r2qk2r/pppppppp/8/8/8/8/PPPPPPPP/R2QK2R w KQkq - 0 1");

const NO_PHASES = { middlegamePly: null, endgamePly: null };

describe("getGamePhases", () => {
    test("an empty game and an opening-only game have no phase dividers", () => {
        expect(getGamePhases([])).toEqual(NO_PHASES);
        expect(getGamePhases([START, START, START])).toEqual(NO_PHASES);
        expect(getGamePhases([START, CONTACT_BELOW_THRESHOLD])).toEqual(NO_PHASES);
        expect(getGamePhases([START, ELEVEN_PIECES])).toEqual(NO_PHASES);
        expect(getGamePhases([START, WHITE_BACKRANK_FOUR, BLACK_BACKRANK_FOUR])).toEqual(NO_PHASES);
    });

    test("a sparse White first rank starts the middlegame with all pieces on the board", () => {
        expect(getGamePhases([START, START, WHITE_BACKRANK_SPARSE])).toEqual({
            middlegamePly: 2,
            endgamePly: null,
        });
    });

    test("a sparse Black eighth rank starts the middlegame with all pieces on the board", () => {
        expect(getGamePhases([START, BLACK_BACKRANK_SPARSE])).toEqual({
            middlegamePly: 1,
            endgamePly: null,
        });
    });

    test("piece contact across the board starts the middlegame with full back ranks", () => {
        expect(getGamePhases([START, CONTACT_BELOW_THRESHOLD, CONTACT_MIDDLEGAME])).toEqual({
            middlegamePly: 2,
            endgamePly: null,
        });
    });

    test("ten majors and minors start the middlegame, seven are not yet an endgame", () => {
        expect(getGamePhases([START, ELEVEN_PIECES, TEN_PIECES, SEVEN_PIECES])).toEqual({
            middlegamePly: 2,
            endgamePly: null,
        });
    });

    test("six majors and minors start the endgame", () => {
        expect(getGamePhases([START, TEN_PIECES, SEVEN_PIECES, SIX_PIECES])).toEqual({
            middlegamePly: 1,
            endgamePly: 3,
        });
    });

    test("the middlegame and endgame keep their first ply once found", () => {
        expect(
            getGamePhases([START, TEN_PIECES, START, SIX_PIECES, TEN_PIECES, SIX_PIECES]),
        ).toEqual({ middlegamePly: 1, endgamePly: 3 });
    });

    test("an endgame setup starts the middlegame and the endgame on the same ply", () => {
        expect(getGamePhases([SIX_PIECES, SIX_PIECES])).toEqual({
            middlegamePly: 0,
            endgamePly: 0,
        });
        expect(getGamePhases([START, SIX_PIECES])).toEqual({ middlegamePly: 1, endgamePly: 1 });
    });
});
