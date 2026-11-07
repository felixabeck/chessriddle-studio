import type { Color } from "chessops";
import { makeMove } from "@/state/store/tree";
import { getMoveText } from "@/utils/chess";
import { parseSanOrUci, positionFromFen } from "@/utils/chessops";
import { defaultTree, getNodeAtPath } from "@/utils/treeReducer";

/** One mainline supplies both the card position and the admitted analysis tree. */
export function playerOpeningLine(moves: string[], color: Color) {
    const tree = defaultTree();
    tree.headers.orientation = color;
    let node = tree.root;
    const notation: string[] = [];
    for (const san of moves) {
        const [position] = positionFromFen(node.fen);
        if (!position) break;
        const move = parseSanOrUci(position, san);
        if (!move) break;
        makeMove({
            state: tree,
            move,
            last: true,
            sound: false,
            changeHeaders: false,
        });
        node = getNodeAtPath(tree.root, tree.position);
        notation.push(getMoveText(node, { glyphs: false, comments: false, extraMarkups: false }));
    }
    return { tree, fen: node.fen, notation: notation.join("").trim() };
}
