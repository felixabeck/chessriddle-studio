import {
    Castles,
    Chess,
    type Color,
    IllegalSetup,
    type Move,
    type PositionError,
    opposite,
    parseUci,
    type Setup,
    type Square,
    squareFile,
    squareRank,
} from "chessops";
import { type FenError, InvalidFen, makeFen, parseFen } from "chessops/fen";
import { parseSan } from "chessops/san";
import type { TFunction } from "i18next";

export function positionFromFen(fen: string): [Chess, null] | [null, FenError | PositionError] {
    const [setup, error] = parseFen(fen).unwrap(
        (v) => [v, null],
        (e) => [null, e],
    );
    if (error) {
        return [null, error];
    }

    return Chess.fromSetup(setup).unwrap(
        (v) => [v, null],
        (e) => [null, e],
    );
}

export function swapMove(fen: string, color?: Color) {
    const setup = parseFen(fen).unwrap();
    if (color) {
        setup.turn = color;
    } else {
        setup.turn = setup.turn === "white" ? "black" : "white";
    }

    return makeFen(setup);
}

/**
 * A piece editor must not carry transient game state into a different board.
 * Chessops filters existing castling rights against the edited kings and rooks,
 * preserving valid Chess960 rights without inventing any new ones.
 * En-passant is a consequence of the last move and is therefore cleared.
 */
export function normalizeEditedFen(fen: string): string | null {
    const parsed = parseFen(fen);
    if (parsed.isErr) return null;
    const setup = parsed.value;
    setup.epSquare = undefined;
    setup.castlingRights = Castles.fromSetup(setup).castlingRights;
    return makeFen(setup);
}

export function squareToCoordinates(square: Square, orientation: "white" | "black") {
    let file = squareFile(square) + 1;
    let rank = squareRank(square) + 1;
    if (orientation === "black") {
        file = 9 - file;
        rank = 9 - rank;
    }
    return { file, rank };
}

const chessopsErrorKeys = {
    [IllegalSetup.Empty]: "Errors.EmptyBoard",
    [IllegalSetup.Kings]: "Errors.InvalidKings",
    [IllegalSetup.OppositeCheck]: "Errors.OppositeCheck",
    [IllegalSetup.PawnsOnBackrank]: "Errors.PawnsOnBackrank",
    [InvalidFen.Board]: "Errors.InvalidBoard",
    [InvalidFen.Castling]: "Errors.InvalidCastlingRights",
    [InvalidFen.EpSquare]: "Errors.InvalidEpSquare",
    [InvalidFen.Fen]: "Errors.InvalidFen",
    [InvalidFen.Fullmoves]: "Errors.InvalidFullmoves",
    [InvalidFen.Halfmoves]: "Errors.InvalidHalfmoves",
    [InvalidFen.Pockets]: "Errors.InvalidPockets",
    [InvalidFen.RemainingChecks]: "Errors.InvalidRemainingChecks",
    [InvalidFen.Turn]: "Errors.InvalidTurn",
} as const satisfies Partial<Record<IllegalSetup | InvalidFen, `Errors.${string}`>>;

type ChessopsErrorKey =
    | (typeof chessopsErrorKeys)[keyof typeof chessopsErrorKeys]
    | "Errors.Unknown";

function chessopsErrorKey(error: PositionError | FenError): ChessopsErrorKey {
    return Object.hasOwn(chessopsErrorKeys, error.message)
        ? chessopsErrorKeys[error.message as keyof typeof chessopsErrorKeys]
        : "Errors.Unknown";
}

/** Translates a chessops error through the catalogue. */
export function translateChessopsError(t: TFunction, error: PositionError | FenError): string {
    return t(chessopsErrorKey(error));
}

export function getPiecesCount(pos: Chess) {
    return (
        pos.board.pawn.size() +
        pos.board.knight.size() +
        pos.board.bishop.size() +
        pos.board.rook.size() +
        pos.board.queen.size() +
        pos.board.king.size()
    );
}

export function hasCaptures(pos: Chess) {
    for (const [from, dests] of pos.allDests()) {
        for (const to of dests) {
            if (
                pos.board[opposite(pos.turn)].has(to) ||
                (pos.board.pawn.has(from) && to === pos.epSquare)
            ) {
                return true;
            }
        }
    }
    return false;
}

export function isOp1(pos: Chess) {
    const whitePawns = pos.board.pawn.intersect(pos.board.white);
    const blackPawns = pos.board.pawn.intersect(pos.board.black);

    // Exclude positions where one side has only a king and at most one pawn
    const whiteSize = pos.board.white.size();
    const blackSize = pos.board.black.size();
    if (whiteSize <= 2 && whitePawns.size() === whiteSize - 1) return false;
    if (blackSize <= 2 && blackPawns.size() === blackSize - 1) return false;

    // Check for at least one opposing pair of pawns
    let shifted = whitePawns.shl64(8);
    let squaresInFront = shifted;
    for (let i = 0; i < 4 && shifted.nonEmpty(); i++) {
        shifted = shifted.shl64(8);
        squaresInFront = squaresInFront.union(shifted);
    }
    return squaresInFront.intersects(blackPawns);
}

export function parseSanOrUci(pos: Chess, sanOrUci: string): Move | null {
    const sanParsed = parseSan(pos, sanOrUci);
    if (sanParsed) {
        return sanParsed;
    }

    const uciParsed = parseUci(sanOrUci);
    if (uciParsed && pos.isLegal(uciParsed)) {
        return uciParsed;
    }

    return null;
}

export function getCastlingSquare(setup: Setup, color: "w" | "b", side: "q" | "k") {
    const chessColor = color === "w" ? "white" : "black";
    const castlingSide = side === "q" ? "a" : "h";
    // Keep the referenced rook before considering candidates for enabling a lost right.
    return (
        Castles.fromSetup(setup).rook[chessColor][castlingSide] ??
        Castles.fromSetup({ ...setup, castlingRights: setup.board.rook }).rook[chessColor][
            castlingSide
        ]
    );
}
