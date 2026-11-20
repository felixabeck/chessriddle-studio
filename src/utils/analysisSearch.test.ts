import { INITIAL_FEN } from "chessops/fen";
import { expect, test } from "vitest";
import { analysisSearch } from "./analysisSearch";
import { positionFromFen } from "@/utils/chessops";

test("normal keys preserve root FEN and move sequence while threat keys swap the final position", () => {
    const moves = ["e2e4", "e7e5"];
    const normal = analysisSearch(INITIAL_FEN, moves, false);
    expect(normal.searchingFen).toBe(INITIAL_FEN);
    expect(normal.searchingMoves).toEqual(moves);
    expect(normal.searchingTurn).toBe("white");
    expect(normal.key).toBe(`${INITIAL_FEN}:e2e4,e7e5`);
    expect(normal.finalFen).toBe("rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2");
    const threat = analysisSearch(INITIAL_FEN, moves, true);
    expect(threat.key).toBe("rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 2:");
    expect(threat.searchingMoves).toEqual([]);
    expect(threat.position?.turn).toBe("white");
    expect(threat.searchingTurn).toBe("black");
});

test("black-root normal identity retains en-passant while threat analysis expires it", () => {
    const fen = "rnbqkbnr/pppppppp/8/4P3/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 7";
    const normal = analysisSearch(fen, ["d7d5"], false);
    expect(normal.key).toBe(`${fen}:d7d5`);
    expect(normal.finalFen).toBe("rnbqkbnr/ppp1pppp/8/3pP3/8/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 8");
    expect(analysisSearch(fen, [], false).searchingTurn).toBe("black");
    expect(analysisSearch(fen, [], true).searchingTurn).toBe("white");
    expect(analysisSearch(fen, ["d7d5"], true).key).toBe(
        "rnbqkbnr/ppp1pppp/8/3pP3/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 8:",
    );
});

test("invalid roots and illegal or malformed replay have no fabricated search identity", () => {
    const invalid = analysisSearch("invalid", ["e2e4"], true);
    expect(invalid.position).toBeNull();
    expect(invalid.finalFen).toBeNull();
    expect(invalid.searchingTurn).toBeNull();
    expect(invalid.available).toBe(false);
    expect(invalid.key).toBeNull();
    for (const threat of [false, true]) {
        for (const moves of [["bad", "e2e4"], ["e2e5"], ["e2e4", "e2e3"]]) {
            expect(analysisSearch(INITIAL_FEN, moves, threat)).toMatchObject({
                available: false,
                key: null,
                searchingFen: null,
                searchingMoves: null,
                searchedBoardFen: null,
            });
        }
    }
});

test.each([
    ["4k3/8/8/8/3p4/8/4P3/4K3 w - - 0 7", "e2e4", "white"],
    ["4k3/3p4/8/4P3/8/8/8/4K3 b - - 0 7", "d7d5", "black"],
])(
    "capturable double push expires en-passant before validating the threat board from %s",
    (fen, move, turn) => {
        const normal = analysisSearch(fen, [move], false);
        expect(positionFromFen(normal.finalFen!)[0]?.epSquare).toBeDefined();
        const threat = analysisSearch(fen, [move], true);
        expect(threat.available).toBe(true);
        const [board, error] = positionFromFen(threat.searchingFen!);
        expect(error).toBeNull();
        expect(board?.turn).toBe(turn);
        expect(board?.epSquare).toBeUndefined();
        expect(threat.searchedBoardFen).toBe(threat.searchingFen);
        expect(threat.searchingMoves).toEqual([]);
    },
);

test.each(["4k3/8/8/8/8/8/4r3/4K3 w - - 0 7", "4k3/4R3/8/8/8/8/8/4K3 b - - 0 7"])(
    "a side in check cannot skip its turn in %s",
    (fen) => {
        expect(analysisSearch(fen, [], false).available).toBe(true);
        const threat = analysisSearch(fen, [], true);
        expect(threat.position?.isCheck()).toBe(true);
        expect(threat.available).toBe(false);
        expect(threat.key).toBeNull();
        expect(threat.searchingFen).toBeNull();
        expect(threat.finalFen).toBe(fen);
    },
);

test.each(["white", "black"])(
    "threat boards preserve Chess960 castling and clocks from %s",
    (turn) => {
        const fen = `1r1k3r/8/8/8/8/8/8/1R1K3R ${turn === "white" ? "w" : "b"} HBhb - 19 23`;
        const threat = analysisSearch(fen, [], true);
        expect(threat.available).toBe(true);
        const [board, error] = positionFromFen(threat.searchingFen!);
        expect(error).toBeNull();
        expect(
            board?.castles.castlingRights.equals(positionFromFen(fen)[0]!.castles.castlingRights),
        ).toBe(true);
        expect(board?.halfmoves).toBe(19);
        expect(board?.fullmoves).toBe(23);
    },
);
