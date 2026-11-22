import { getPGN } from "@/utils/chess";
import type { GameHeaders, TreeNode } from "@/utils/treeReducer";

/** The bound the native side enforces on the game text of a turn. */
export const MAX_COACH_GAME_BYTES = 24 * 1024;

const encoder = new TextEncoder();
const fits = (text: string) => encoder.encode(text).length <= MAX_COACH_GAME_BYTES;

/**
 * The line through `position` and on along the first continuation, without side variations. The
 * nodes are shallow copies: only their child lists differ from the game's.
 */
function currentLine(root: TreeNode, position: readonly number[]): TreeNode {
    const copy: TreeNode = { ...root, children: [] };
    let source = root;
    let target = copy;
    for (let depth = 0; ; depth++) {
        const next = source.children[depth < position.length ? position[depth] : 0];
        if (!next) return copy;
        const child: TreeNode = { ...next, children: [] };
        target.children = [child];
        source = next;
        target = child;
    }
}

/**
 * The game as the Coach is told it: the PGN with comments and variations when that fits the
 * bound; otherwise only the line the board is on (always whole up to the board's position), first
 * with and then without comments. A game whose bare line is still too long is left out.
 */
export function coachGameContext(
    root: TreeNode,
    headers: GameHeaders,
    position: readonly number[],
): string {
    const write = (tree: TreeNode, comments: boolean, variations: boolean) =>
        getPGN(tree, { headers, glyphs: true, comments, variations, extraMarkups: false });
    const whole = write(root, true, true);
    if (fits(whole)) return whole;
    const line = currentLine(root, position);
    const commented = write(line, true, false);
    if (fits(commented)) return commented;
    const bare = write(line, false, false);
    return fits(bare) ? bare : "";
}

/** Plies played before `fen`, from its side to move and move number: what move numbers count from. */
export function halfMovesOfFen(fen: string): number {
    const fields = fen.split(/[\s_]+/);
    const fullMoves = Math.max(1, Number.parseInt(fields[5] ?? "1", 10) || 1);
    return (fullMoves - 1) * 2 + (fields[1] === "b" ? 1 : 0);
}
