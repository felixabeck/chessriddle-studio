import type { Color } from "chessops";
import type { RepertoirePartialReason, RepertoireSnapshot } from "@/state/repertoireIndex";
import { ANNOTATION_INFO } from "./annotation";
import type { ReviewFact } from "./gameReview";
import { chapterOrientation } from "./opponentPreparation";
import type { Session } from "./session";
import { type GameHeaders, getBoardState, type TreeNode } from "./treeReducer";

/** Maximum number of repertoire candidate moves named in a deviation sentence. */
export const MAX_REPERTOIRE_DEVIATION_MOVES = 3;

export interface MainlineNovelty {
    /** 1-based mainline index (`mainline[mainlineIndex]`). */
    mainlineIndex: number;
    halfMoves: number;
    san: string;
    /** Path to the position before the novelty move. */
    beforePath: number[];
    /** Full FEN of the position before the novelty move. */
    beforeFen: string;
    /** First move of a better line when one exists, else `null`. */
    betterSan: string | null;
}

export interface RepertoireWalkMove {
    /** 1-based mainline index (`mainline[mainlineIndex]`). */
    mainlineIndex: number;
    /** Path of the played move itself. */
    path: number[];
    /** Path to the position before the played move. */
    beforePath: number[];
    /** Full FEN of the position before the played move. */
    beforeFen: string;
    halfMoves: number;
    san: string;
}

export type RepertoireComparison =
    | { kind: "partial"; reason: RepertoirePartialReason }
    | {
          kind: "deviation";
          move: RepertoireWalkMove;
          repertoireMoves: string[];
          fileName: string;
      }
    | { kind: "followed"; lastMove: RepertoireWalkMove }
    | { kind: "none" };

function normalizeAccountName(value: string | undefined): string | null {
    if (!value) return null;
    const trimmed = value.trim().toLowerCase();
    return trimmed.length > 0 ? trimmed : null;
}

function normalizeHeaderPlayerName(value: string | undefined): string | null {
    const normalized = normalizeAccountName(value);
    return normalized === null || normalized === "?" ? null : normalized;
}

/**
 * Resolves the user's side for a game: the side whose player name matches a Lichess username,
 * Chess.com username, or session alias (ignoring case and outer whitespace). When both sides or
 * neither match, falls back to `headers.orientation`, or White when absent (D7).
 */
export function resolveUserSide(
    headers: Pick<GameHeaders, "white" | "black" | "orientation">,
    sessions: readonly Session[],
): Color {
    const accountNames = new Set<string>();
    for (const session of sessions) {
        const lichess = normalizeAccountName(session.lichess?.username);
        if (lichess) accountNames.add(lichess);
        const chessCom = normalizeAccountName(session.chessCom?.username);
        if (chessCom) accountNames.add(chessCom);
        const alias = normalizeAccountName(session.alias);
        if (alias) accountNames.add(alias);
    }

    const white = normalizeHeaderPlayerName(headers.white);
    const black = normalizeHeaderPlayerName(headers.black);
    const whiteMatches = white !== null && accountNames.has(white);
    const blackMatches = black !== null && accountNames.has(black);

    if (whiteMatches && !blackMatches) return "white";
    if (blackMatches && !whiteMatches) return "black";
    return chapterOrientation(headers.orientation);
}

/**
 * Finds the mainline move carrying the novelty mark (`N` / NAG 146), together with its
 * before-position and optional first better-line move.
 */
export function findMainlineNovelty(
    root: TreeNode,
    facts?: readonly ReviewFact[],
    summaryCurrent = false,
): MainlineNovelty | null {
    const noveltyNag = ANNOTATION_INFO.N.nag;
    let beforeNode = root;
    const beforePath: number[] = [];

    while (beforeNode.children.length > 0) {
        const node = beforeNode.children[0];
        const mainlineIndex = beforePath.length + 1;
        if (node.nags.includes(noveltyNag) && node.san) {
            const factBetter =
                summaryCurrent && facts
                    ? (facts.find((fact) => fact.mainlineIndex === mainlineIndex)?.betterLine[0] ??
                      null)
                    : null;
            const treeBetter =
                beforeNode.children.slice(1).find((child) => child.reportLine)?.san ?? null;
            return {
                mainlineIndex,
                halfMoves: node.halfMoves,
                san: node.san,
                beforePath: [...beforePath],
                beforeFen: beforeNode.fen,
                betterSan: factBetter ?? treeBetter,
            };
        }
        beforePath.push(0);
        beforeNode = node;
    }

    return null;
}

type IndexedPositionMoves = {
    moves: string[];
    moveSet: Set<string>;
    fileName: string;
};

/**
 * Compares the game's mainline against `snapshot` for `userSide` (O6).
 *
 * Refuses to draw conclusions from a partial index (for any of the three partial reasons), and
 * compares only positions where `userSide` is to move, deriving colour from root-anchored
 * `halfMoves` rather than `path.length % 2`.
 */
export function compareGameToRepertoire(
    root: TreeNode,
    snapshot: RepertoireSnapshot,
    userSide: Color,
): RepertoireComparison {
    if (
        snapshot.partial ||
        snapshot.partialReason !== null ||
        snapshot.files.some((file) => file.partial)
    ) {
        return { kind: "partial", reason: snapshot.partialReason ?? "read-failed" };
    }

    const movesByBoardState = new Map<string, IndexedPositionMoves>();
    for (const file of snapshot.files) {
        for (const chapter of file.chapters) {
            if (chapterOrientation(chapter.headers.orientation) !== userSide) continue;
            const { nodes } = chapter;
            for (const node of nodes) {
                if (node.parent < 0 || node.san === null) continue;
                const parentNode = nodes[node.parent];
                if (!parentNode) continue;
                let entry = movesByBoardState.get(parentNode.boardState);
                if (!entry) {
                    entry = { moves: [], moveSet: new Set(), fileName: file.file.name };
                    movesByBoardState.set(parentNode.boardState, entry);
                }
                if (!entry.moveSet.has(node.san)) {
                    entry.moveSet.add(node.san);
                    entry.moves.push(node.san);
                }
            }
        }
    }

    let beforeNode = root;
    const beforePath: number[] = [];
    let lastFollowed: RepertoireWalkMove | null = null;

    while (beforeNode.children.length > 0) {
        const node = beforeNode.children[0];
        const mainlineIndex = beforePath.length + 1;
        const path = [...beforePath, 0];
        if (!node.san) break;

        const mover: Color = node.halfMoves % 2 === 1 ? "white" : "black";
        if (mover === userSide) {
            const entry = movesByBoardState.get(getBoardState(beforeNode.fen));
            if (!entry || entry.moves.length === 0) break;

            const walkMove: RepertoireWalkMove = {
                mainlineIndex,
                path,
                beforePath: [...beforePath],
                beforeFen: beforeNode.fen,
                halfMoves: node.halfMoves,
                san: node.san,
            };
            if (entry.moveSet.has(node.san)) {
                lastFollowed = walkMove;
            } else {
                return {
                    kind: "deviation",
                    move: walkMove,
                    repertoireMoves: entry.moves.slice(0, MAX_REPERTOIRE_DEVIATION_MOVES),
                    fileName: entry.fileName,
                };
            }
        }

        beforePath.push(0);
        beforeNode = node;
    }

    return lastFollowed ? { kind: "followed", lastMove: lastFollowed } : { kind: "none" };
}
