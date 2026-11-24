import { isPrefix } from "./misc";

/** Empty Start excludes the root. Otherwise, practice includes Start and its descendants. */
export function isInPracticeScope(position: number[], start: number[]): boolean {
    return start.length === 0 ? position.length > 0 : isPrefix(start, position);
}

/** The card-construction own-turn predicate: half-move parity against orientation, not the FEN side. */
export function isUserToMove(halfMoves: number, color: "white" | "black"): boolean {
    return color === "white" ? halfMoves % 2 === 0 : halfMoves % 2 === 1;
}
