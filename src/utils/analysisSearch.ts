import { Chess, opposite, parseUci, type Color } from "chessops";
import { makeFen } from "chessops/fen";
import { positionFromFen } from "@/utils/chessops";

type AnalysisPosition = { position: Chess | null; finalFen: string | null };
export type AnalysisSearch = AnalysisPosition &
    (
        | {
              available: true;
              searchingFen: string;
              searchingMoves: string[];
              searchingTurn: Color;
              searchedBoardFen: string;
              key: string;
          }
        | {
              available: false;
              searchingFen: null;
              searchingMoves: null;
              searchingTurn: null;
              searchedBoardFen: null;
              key: null;
          }
    );

function unavailable(position: Chess | null = null): AnalysisSearch {
    return {
        available: false,
        position,
        finalFen: position ? makeFen(position.toSetup()) : null,
        searchingFen: null,
        searchingMoves: null,
        searchingTurn: null,
        searchedBoardFen: null,
        key: null,
    };
}

/** The native searched position and its line-memory key, including threat mode. */
export function analysisSearch(fen: string, moves: string[], threat: boolean): AnalysisSearch {
    const [position] = positionFromFen(fen);
    if (!position) return unavailable();
    for (const uci of moves) {
        const move = parseUci(uci);
        if (!move || !position.isLegal(move)) return unavailable();
        position.play(move);
    }
    const finalFen = makeFen(position.toSetup());
    let searchedBoardFen = finalFen;
    if (threat) {
        const setup = position.toSetup();
        setup.turn = opposite(setup.turn);
        // The previous move's en-passant right expires when skipping this turn.
        setup.epSquare = undefined;
        const hypothetical = Chess.fromSetup(setup);
        if (hypothetical.isErr) return unavailable(position);
        searchedBoardFen = makeFen(hypothetical.value.toSetup());
    }
    const searchingFen = threat ? searchedBoardFen : fen;
    const searchingMoves = threat ? [] : moves;
    return {
        available: true,
        position,
        finalFen,
        searchingFen,
        searchingMoves,
        searchingTurn: threat ? opposite(position.turn) : position.turn,
        searchedBoardFen,
        key: `${searchingFen}:${searchingMoves.join(",")}`,
    };
}
