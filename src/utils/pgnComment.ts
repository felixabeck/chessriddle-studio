import { type Evaluation, parseComment } from "chessops/pgn";
import { extractPgnDrawings, PGN_COMMENT_COMMAND, type PgnDrawing } from "./drawings";
import { GAME_END_COMMAND, GAME_END_PROSE, type TreeNode } from "./treeReducer";

/** Drawings are extracted per entry before chessops parses the other modeled fields. */
const MODELED_COMMANDS = new Set(["eval", "clk"]);
/**
 * `++underline++` in comment Markdown: non-empty, on one line, without a nested `++`, and with
 * no whitespace just inside either delimiter, so chess prose such as `Qh7++ Kh8 Qg8++` stays
 * text. The notation reader and the Annotate editor both parse with it.
 */
export const COMMENT_UNDERLINE = /\+\+((?!\s)(?:(?!\+\+)[^\n])*?[^\s\n])\+\+/;

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
    const rest = drawings.text.replace(
        PGN_COMMENT_COMMAND,
        (match, name: string, body?: string) => {
            if (modelGameEnd && name === GAME_END_COMMAND) {
                const termination = body?.trim();
                gameEnds.push(termination ? { termination } : {});
                return " ";
            }
            if (MODELED_COMMANDS.has(name) && isWellFormedModeled(match.trim())) return match;
            commands.push(match);
            return " ";
        },
    );
    const parsed = parseComment(rest);
    return {
        text: gameEnds.length > 0 && parsed.text.trim() === GAME_END_PROSE ? "" : parsed.text,
        commands: commands.join("").trim(),
        evaluation: parsed.evaluation,
        shapes: drawings.shapes,
        clock: parsed.clock,
        gameEnds,
    };
}
