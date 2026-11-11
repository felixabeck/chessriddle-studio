import type { DrawBrush, DrawShape } from "@lichess-org/chessground/draw";
import { defaults } from "@lichess-org/chessground/state";
import { makeSquare, parseSquare } from "chessops";
import type { CommentShape } from "chessops/pgn";

const legacyBrushes = defaults().drawable.brushes;
export const PGN_COMMENT_COMMAND = /\s?\[%([A-Za-z0-9_]+)(\s[^\]]*)?\]\s?/g;

// PGN identities, including O = Orange and C = Cyan: https://pgn.echecs.dev/
// PGN does not encode source-application RGB values. Yellow is a clear yellow, not chessground's
// orange-yellow, so it stays distinct from orange. The drawing modifiers live in the chessground
// patch (patches/@lichess-org__chessground@10.1.1.patch) and are listed by DRAWING_MODIFIERS.
export const PGN_DRAWING_COLORS = {
    G: { name: "green", brush: legacyBrushes.green },
    R: { name: "red", brush: legacyBrushes.red },
    Y: { name: "yellow", brush: { key: "y", color: "#e8c500", opacity: 1, lineWidth: 10 } },
    B: { name: "blue", brush: legacyBrushes.blue },
    O: { name: "orange", brush: { key: "o", color: "#ff6600", opacity: 1, lineWidth: 10 } },
    C: { name: "cyan", brush: { key: "c", color: "#00bcd4", opacity: 1, lineWidth: 10 } },
} as const;

/** Right-click modifiers per drawing colour, as implemented by the chessground patch. */
export const DRAWING_MODIFIERS: { color: DrawingColor; modifiers: ("shift" | "ctrl" | "alt")[] }[] =
    [
        { color: "green", modifiers: [] },
        { color: "red", modifiers: ["shift"] },
        { color: "blue", modifiers: ["alt"] },
        { color: "yellow", modifiers: ["shift", "alt"] },
        { color: "orange", modifiers: ["ctrl"] },
        { color: "cyan", modifiers: ["ctrl", "alt"] },
    ];

export type DrawingColor = (typeof PGN_DRAWING_COLORS)[keyof typeof PGN_DRAWING_COLORS]["name"];
export type PgnDrawing = Omit<CommentShape, "color"> & { color: DrawingColor };

export const pgnDrawingBrushes = Object.fromEntries(
    Object.values(PGN_DRAWING_COLORS).map(({ name, brush }) => [name, brush]),
) as Record<DrawingColor, DrawBrush>;

function drawingCode(brush: string | undefined): string | undefined {
    return Object.entries(PGN_DRAWING_COLORS).find(([, color]) => color.name === brush)?.[0];
}

export function toDrawShape(shape: PgnDrawing): DrawShape {
    return { orig: makeSquare(shape.from), dest: makeSquare(shape.to), brush: shape.color };
}

/** Extract supported entries independently, leaving every residual entry byte-for-byte intact. */
export function extractPgnDrawings(comment: string): { text: string; shapes: PgnDrawing[] } {
    const shapes: PgnDrawing[] = [];
    const text = comment.replace(PGN_COMMENT_COMMAND, (match, name: string, body?: string) => {
        if ((name !== "cal" && name !== "csl") || !body) return match;
        const residual: string[] = [];
        for (const entry of body.slice(1).split(",")) {
            // Accept both lengths, as chessops did, and normalize equal endpoints on export.
            const valid = /^[A-Z][a-h][1-8](?:[a-h][1-8])?$/.test(entry);
            const color = Object.entries(PGN_DRAWING_COLORS).find(
                ([code]) => code === entry[0],
            )?.[1];
            const from = valid ? parseSquare(entry.slice(1, 3)) : undefined;
            const to = entry.length === 3 ? from : valid ? parseSquare(entry.slice(3)) : undefined;
            if (color && from !== undefined && to !== undefined) {
                shapes.push({ color: color.name, from, to });
            } else {
                residual.push(entry);
            }
        }
        if (residual.length === 0) return "  ";
        return match.replace(body, () => body[0] + residual.join(","));
    });
    return { text, shapes };
}

/** Both imported equal-endpoint shapes and destination-absent user circles are square markings. */
export function makePgnDrawings(shapes: DrawShape[]): string {
    const squares: string[] = [];
    const arrows: string[] = [];
    for (const shape of shapes) {
        const code = drawingCode(shape.brush);
        if (!code) continue;
        if (shape.dest === undefined || shape.dest === shape.orig) {
            squares.push(code + shape.orig);
        } else {
            arrows.push(code + shape.orig + shape.dest);
        }
    }
    return (
        (squares.length ? `[%csl ${squares.join(",")}]` : "") +
        (arrows.length ? `[%cal ${arrows.join(",")}]` : "")
    );
}
