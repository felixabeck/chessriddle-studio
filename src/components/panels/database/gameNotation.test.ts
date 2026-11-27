import { INITIAL_FEN } from "chessops/fen";
import { describe, expect, test } from "vitest";
import { gameNotationPreview, type GameNotationPart } from "./gameNotation";

function textOf(parts: readonly GameNotationPart[]): string {
    return parts
        .map((part) => (part.moveNumber ? `${part.moveNumber} ${part.san}` : part.san))
        .join(" ");
}

describe("gameNotationPreview", () => {
    test("formats up to 8 plies and full continuation from the standard start", () => {
        const result = gameNotationPreview({
            fen: INITIAL_FEN,
            moves: "1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 *",
        });
        expect(textOf(result.preview)).toBe("1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6");
        expect(textOf(result.full)).toBe("1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7");
        expect(result.hasMore).toBe(true);
        expect(result.preview[0]).toEqual({ moveNumber: "1.", san: "e4" });
    });

    test("anchors to a non-standard start FEN with Black to move", () => {
        const fen = "rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 14";
        const result = gameNotationPreview({
            fen,
            moves: "14... Bxd5 15. Nxd5 Nc6 16. c4 *",
        });
        // Use a legal Black move from that FEN: Nc6 then Bb5.
        const legal = gameNotationPreview({
            fen,
            moves: "14... Nc6 15. Bb5 a6 *",
        });
        expect(result.preview).toEqual([]);
        expect(textOf(legal.preview)).toBe("14... Nc6 15. Bb5 a6");
        expect(textOf(legal.full)).toBe("14... Nc6 15. Bb5 a6");
        expect(legal.hasMore).toBe(false);
        expect(legal.preview[0]).toEqual({ moveNumber: "14...", san: "Nc6" });
    });

    test("normalizes a legacy start FEN with an impossible en-passant square", () => {
        const legacyFen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq e6 0 1";
        const result = gameNotationPreview(
            { fen: legacyFen, moves: "1. e4 e5 2. Nf3 *" },
            "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
        );
        expect(textOf(result.preview)).toBe("1... e5 2. Nf3");
        expect(result.hasMore).toBe(false);
    });

    test("parses full PGN with headers, comments, NAGs and variations while anchoring start to game.fen", () => {
        const customFen = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
        const pgn = [
            '[Event "Rated Blitz"]',
            '[White "Alpha"]',
            '[Black "Beta"]',
            `[FEN "${INITIAL_FEN}"]`,
            "",
            "1... c5 { [%clk 0:03:00] } 2. Nf3 $1 (2. Nc3 Nc6) 2... d6 3. d4 cxd4 *",
        ].join("\n");
        const result = gameNotationPreview({ fen: customFen, moves: pgn });
        expect(textOf(result.full)).toBe("1... c5 2. Nf3 d6 3. d4 cxd4");
    });

    test("anchors mid-game on the first matching board state", () => {
        const afterE4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
        const result = gameNotationPreview(
            {
                fen: INITIAL_FEN,
                moves: "1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 *",
            },
            afterE4,
        );
        expect(textOf(result.preview)).toBe("1... e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O");
        expect(textOf(result.full)).toBe(
            "1... e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1",
        );
        expect(result.hasMore).toBe(true);
        expect(result.preview[0]).toEqual({ moveNumber: "1...", san: "e5" });
    });

    test("returns empty without fallback when target matches the game's last position", () => {
        const afterE4E5 = "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2";
        const result = gameNotationPreview({ fen: INITIAL_FEN, moves: "1. e4 e5 *" }, afterE4E5);
        expect(result).toEqual({ preview: [], full: [], hasMore: false });
    });

    test("falls back to game start when target is absent or undefined", () => {
        const d4Fen = "rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq - 0 1";
        const absent = gameNotationPreview({ fen: INITIAL_FEN, moves: "1. e4 e5 2. Nf3 *" }, d4Fen);
        const undef = gameNotationPreview(
            { fen: INITIAL_FEN, moves: "1. e4 e5 2. Nf3 *" },
            undefined,
        );
        expect(textOf(absent.preview)).toBe("1. e4 e5 2. Nf3");
        expect(textOf(undef.preview)).toBe("1. e4 e5 2. Nf3");
    });

    test("keeps only the legal prefix before an illegal SAN", () => {
        const result = gameNotationPreview({
            fen: INITIAL_FEN,
            moves: "1. e4 e5 2. Nf3 Qh5 3. Nc3 *",
        });
        expect(textOf(result.full)).toBe("1. e4 e5 2. Nf3");
        expect(result.hasMore).toBe(false);
    });

    test("returns empty for invalid start FEN or garbage movetext", () => {
        expect(gameNotationPreview({ fen: "invalid-fen", moves: "1. e4 e5 *" })).toEqual({
            preview: [],
            full: [],
            hasMore: false,
        });
        expect(gameNotationPreview({ fen: INITIAL_FEN, moves: "not moves ;;; ***" })).toEqual({
            preview: [],
            full: [],
            hasMore: false,
        });
    });

    test("sets hasMore=false when 8 or fewer plies remain", () => {
        const exactly8 = gameNotationPreview({
            fen: INITIAL_FEN,
            moves: "1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 *",
        });
        expect(exactly8.preview).toHaveLength(8);
        expect(exactly8.hasMore).toBe(false);
    });
});
