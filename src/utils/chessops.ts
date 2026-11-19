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

/**
 * Flip or set the side to move. An en-passant square belongs to the side that
 * just moved, so it is cleared whenever the resulting turn differs from the
 * parsed turn. Passing the current color leaves the position unchanged.
 */
export function swapMove(fen: string, color?: Color) {
    const setup = parseFen(fen).unwrap();
    const parsedTurn = setup.turn;
    if (color) {
        setup.turn = color;
    } else {
        setup.turn = setup.turn === "white" ? "black" : "white";
    }
    if (setup.turn !== parsedTurn) {
        setup.epSquare = undefined;
    }

    return makeFen(setup);
}

/**
 * Rewrites an en-passant field to "-" when the native side would reject it, keeping every
 * other byte of the FEN. The test mirrors shakmaty's `EnPassant::from_setup`, which the
 * engine, the game report and the database importer apply: the square is on the mover's
 * sixth rank, an opposing pawn stands in front of it, and both the square and the pawn's
 * origin are empty. chessops' own check omits the empty-square test, so it cannot be reused.
 * A FEN that does not parse is returned unchanged for its caller's own validation.
 */
export function dropInvalidEpSquare(fen: string): string {
    const parsed = parseFen(fen);
    if (parsed.isErr) return fen;
    const { board, turn, epSquare } = parsed.value;
    if (epSquare === undefined) return fen;
    const forward = turn === "white" ? 8 : -8;
    const pushedTo = epSquare - forward;
    const pushedFrom = epSquare + forward;
    const valid =
        squareRank(epSquare) === (turn === "white" ? 5 : 2) &&
        board.pawn.has(pushedTo) &&
        board[opposite(turn)].has(pushedTo) &&
        !board.occupied.has(epSquare) &&
        !board.occupied.has(pushedFrom);
    if (valid) return fen;
    // Same field separators parseFen accepts; the separators are kept at the odd indices.
    const parts = fen.split(/([\s_]+)/);
    parts[6] = "-";
    return parts.join("");
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
