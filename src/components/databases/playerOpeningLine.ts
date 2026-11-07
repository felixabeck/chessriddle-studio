import { Chess, type Color } from "chessops";
import { makeFen } from "chessops/fen";
import { makeSan } from "chessops/san";
import { parseSanOrUci } from "@/utils/chessops";
import { createNode, defaultTree } from "@/utils/treeReducer";

/** One mainline supplies both the card position and the admitted analysis tree. */
export function playerOpeningLine(moves: string[], color: Color) {
    const tree = defaultTree();
    tree.headers.orientation = color;
    const position = Chess.default();
    let node = tree.root;
    const notation: string[] = [];
    for (const san of moves) {
        const move = parseSanOrUci(position, san);
        if (!move) break;
        const canonicalSan = makeSan(position, move);
        notation.push(
            `${position.turn === "white" ? `${position.fullmoves}. ` : ""}${canonicalSan}`,
        );
        position.play(move);
        const next = createNode({
            move,
            san: canonicalSan,
            fen: makeFen(position.toSetup()),
            halfMoves: node.halfMoves + 1,
        });
        node.children.push(next);
        node = next;
        tree.position.push(0);
    }
    return { tree, fen: node.fen, notation: notation.join(" ") };
}
