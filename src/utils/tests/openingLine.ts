import { Chess } from "chessops/chess";
import { makeFen, parseFen } from "chessops/fen";
import { parseSan } from "chessops/san";
import { expect } from "vitest";
import { createNode, defaultTree, type TreeNode } from "../treeReducer";

export function openingLine(moves: string[], fen?: string): TreeNode {
    const root = defaultTree(fen).root;
    const position = Chess.fromSetup(parseFen(root.fen).unwrap()).unwrap();
    let node = root;
    for (const san of moves) {
        const move = parseSan(position, san)!;
        expect(move).toBeDefined();
        position.play(move);
        const child = createNode({
            fen: makeFen(position.toSetup()),
            move,
            san,
            halfMoves: node.halfMoves + 1,
        });
        node.children.push(child);
        node = child;
    }
    return root;
}
