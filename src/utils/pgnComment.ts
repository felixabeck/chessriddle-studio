import { type Evaluation, parseComment } from "chessops/pgn";
import { extractPgnDrawings, PGN_COMMENT_COMMAND, type PgnDrawing } from "./drawings";
import {
    GAME_END_COMMAND,
    GAME_END_PROSE,
    REVIEW_MARK_COMMAND,
    type TreeNode,
} from "./treeReducer";

/** Drawings are extracted per entry before chessops parses the other modeled fields. */
const MODELED_COMMANDS = new Set(["eval", "clk"]);
/**
 * `++underline++` in comment Markdown: non-empty, on one line, without a nested `++`, and with
 * no whitespace just inside either delimiter, so chess prose such as `Qh7++ Kh8 Qg8++` stays
 * text. The notation reader and the Annotate editor both parse with it.
 */
export const COMMENT_UNDERLINE = /\+\+((?!\s)(?:(?!\+\+)[^\n])*?[^\s\n])\+\+/;

/** ChessBase's diagram marker inside a comment: "show a board of this position here". */
export const DIAGRAM_MARKER = "[#]";
const DIAGRAM_MARKER_PATTERN = /\s*\[#\]\s*/g;

/**
 * Lifts every diagram marker out of comment text. Each marker and the whitespace around it
 * becomes one space and the result is trimmed; text without a marker is returned untouched.
 */
export function extractDiagramMarker(comment: string): { text: string; diagram: boolean } {
    if (!comment.includes(DIAGRAM_MARKER)) return { text: comment, diagram: false };
    return { text: comment.replace(DIAGRAM_MARKER_PATTERN, " ").trim(), diagram: true };
}

export type SplitComment = {
    /** What a reader sees: the comment without any `[%…]` command. */
    text: string;
    /** Every command the tree does not model, verbatim, for writing back. Never longer than the
     *  comment it came from: the slices are concatenated with the whitespace they had. */
    commands: string;
    evaluation?: Evaluation;
    shapes: PgnDrawing[];
    clock?: number;
    gameEnds: NonNullable<TreeNode["gameEnd"]>[];
    /** The comment carried a diagram marker, which is not part of `text`. */
    diagram: boolean;
    /** The comment carried a Studio review mark (`[%crreview]`), never kept in `commands`. */
    reviewMark: boolean;
};

/** A modeled command chessops accepts: parsing it alone leaves no text behind. */
function isWellFormedModeled(command: string): boolean {
    return parseComment(command).text === "";
}

/**
 * Splits one PGN comment into its prose and its embedded commands. Commands the tree does not
 * model (`%evp`, `%emt`, `%timestamp`, …) are kept verbatim so a save writes them back; a modeled
 * command chessops refuses as malformed is kept the same way rather than shown as prose. One pass
 * in source order, so the kept commands keep their order.
 */
export function splitPgnComment(comment: string, modelGameEnd = false): SplitComment {
    const drawings = extractPgnDrawings(comment);
    const commands: string[] = [];
    const gameEnds: SplitComment["gameEnds"] = [];
    let reviewMark = false;
    const marker = extractDiagramMarker(drawings.text);
    const rest = marker.text.replace(PGN_COMMENT_COMMAND, (match, name: string, body?: string) => {
        if (modelGameEnd && name === GAME_END_COMMAND) {
            const termination = body?.trim();
            gameEnds.push(termination ? { termination } : {});
            return " ";
        }
        if (name === REVIEW_MARK_COMMAND) {
            reviewMark = true;
            return " ";
        }
        if (MODELED_COMMANDS.has(name) && isWellFormedModeled(match.trim())) return match;
        commands.push(match);
        return " ";
    });
    const parsed = parseComment(rest);
    return {
        text: gameEnds.length > 0 && parsed.text.trim() === GAME_END_PROSE ? "" : parsed.text,
        commands: commands.join("").trim(),
        evaluation: parsed.evaluation,
        shapes: drawings.shapes,
        clock: parsed.clock,
        gameEnds,
        diagram: marker.diagram,
        reviewMark,
    };
}

/** Every embedded command and diagram marker; a match may carry one adjacent space. */
const KEPT_COMMENT_MARKUP = new RegExp(
    `${PGN_COMMENT_COMMAND.source}|${DIAGRAM_MARKER.replace(/[[\]]/g, "\\$&")}`,
    "g",
);

/**
 * Replaces the prose of a verbatim PGN comment and keeps everything else it carries: each
 * embedded command and diagram marker stays, in its order, in front of the new prose. Reading the
 * result with `splitPgnComment` gives back `text` (trimmed). Empty when nothing is left.
 */
export function replacePgnCommentText(comment: string, text: string): string {
    const kept = (comment.match(KEPT_COMMENT_MARKUP) ?? []).map((part) => part.trim());
    return [...kept, text.trim()].filter((part) => part !== "").join(" ");
}
