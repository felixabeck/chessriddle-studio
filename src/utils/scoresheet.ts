import { INITIAL_FEN, makeFen } from "chessops/fen";
import { makeSan, parseSan } from "chessops/san";
import type { Outcome, ScoresheetGame, ScoresheetMove } from "@/bindings";
import { headersToPGN, parsePGN } from "@/utils/chess";
import { positionFromFen } from "@/utils/chessops";
import {
    countMainPly,
    createNode,
    deriveScoresheetRemaining,
    getNodeAtPath,
    getResolvedPathLength,
    type ScoresheetReview,
    type TreeNode,
    type TreeState,
} from "@/utils/treeReducer";

function normalizeOutcome(raw: string): Outcome {
    if (raw === "1-0" || raw === "0-1" || raw === "1/2-1/2") return raw;
    return "*";
}

function parseOptionalElo(raw: string): number | undefined {
    if (!/^\d{1,4}$/.test(raw)) return undefined;
    return Number.parseInt(raw, 10);
}

/** Composes PGN text from a native `ScoresheetGame` using `headersToPGN` and numbered SAN moves. */
export function scoresheetGameToPgn(game: ScoresheetGame): string {
    const result = normalizeOutcome(game.headers.result);
    const headerPgn = headersToPGN({
        id: 0,
        fen: INITIAL_FEN,
        event: game.headers.event || "?",
        site: game.headers.site || "?",
        date: game.headers.date || "????.??.??",
        round: game.headers.round || "?",
        white: game.headers.white || "?",
        black: game.headers.black || "?",
        result,
        white_elo: parseOptionalElo(game.headers.whiteElo),
        black_elo: parseOptionalElo(game.headers.blackElo),
    });

    const movetextParts: string[] = [];
    for (let ply = 0; ply < game.moves.length; ply += 1) {
        if (ply % 2 === 0) {
            movetextParts.push(`${Math.floor(ply / 2) + 1}.`);
        }
        movetextParts.push(game.moves[ply].san);
    }
    const movetext = movetextParts.join(" ");
    return movetext ? `${headerPgn}\n${movetext} ${result}\n` : `${headerPgn}\n${result}\n`;
}

/**
 * Builds a review-ready `TreeState` from a native `ScoresheetGame`:
 * - composes PGN and parses it through `parsePGN`
 * - verifies that the parsed main line has the exact number of returned moves
 * - removes any game-end marker when the reading stopped early (completely read games keep the default)
 * - marks unsure main-line nodes, sets `scoresheetReview`, and marks the tree `dirty`.
 */
export async function buildScoresheetTree(
    game: ScoresheetGame,
    options?: { signal?: AbortSignal },
): Promise<TreeState> {
    const pgn = scoresheetGameToPgn(game);
    const tree = await parsePGN(pgn, undefined, options);

    const mainLine: TreeNode[] = [];
    let current = tree.root.children[0];
    while (current) {
        mainLine.push(current);
        current = current.children[0];
    }

    if (mainLine.length !== game.moves.length) {
        throw new Error(
            `Scoresheet move count mismatch: expected ${game.moves.length}, parsed ${mainLine.length}`,
        );
    }

    if (game.stopped) {
        for (const node of mainLine) {
            delete node.gameEnd;
        }
    }

    for (let i = 0; i < game.moves.length; i += 1) {
        if (game.moves[i].unsure) {
            mainLine[i].unsure = true;
        }
    }

    tree.scoresheetReview = game.stopped
        ? {
              stopped: {
                  ply: game.stopped.ply,
                  tokens: [...game.stopped.tokens],
              },
          }
        : {};
    tree.dirty = true;
    return tree;
}

type ScoresheetContinuationPlan =
    | {
          kind: "after-stop";
          /** Remaining sheet tokens from `tokens[L - ply]` onward. */
          moves: ScoresheetMove[];
      }
    | {
          kind: "replace-middle";
          /** Path of the main-line parent of the fork (all 0s). */
          parentPath: number[];
          /** Number of leading entries in `moves` that come from the old main line after the replaced move. */
          oldMainLineMoveCount: number;
          /** Moves to replay: old main line after the replaced move, then (when `L >= ply`) remaining sheet tokens. */
          moves: ScoresheetMove[];
      };

/**
 * Determines whether "Continue with the rest of the sheet" is enabled at `position` and returns
 * the exact move sequence to replay, or `null` when neither situation applies:
 *
 * 1. After a stop: `position` is the last move of the main line, `L > ply`, and a sheet token
 *    remains at `tokens[L - ply]`. Never enabled for `L <= ply`.
 * 2. After a wrong move in the middle: `position` is a variation of exactly one move beside a
 *    main-line move, with at least one move to replay (old main-line moves after the replaced
 *    one, followed when `L >= ply` by sheet tokens from the old line's length on).
 */
export function planScoresheetContinuation(
    root: TreeNode,
    position: readonly number[],
    scoresheetReview: ScoresheetReview | undefined,
): ScoresheetContinuationPlan | null {
    if (!scoresheetReview) return null;
    if (position.length === 0 || getResolvedPathLength(root, position) !== position.length) {
        return null;
    }

    const onMainLine = position.every((index) => index === 0);
    if (onMainLine) {
        const stopped = scoresheetReview.stopped;
        if (!stopped) return null;
        const mainLineLength = countMainPly(root);
        if (position.length !== mainLineLength || mainLineLength <= stopped.ply) {
            return null;
        }
        const remaining = deriveScoresheetRemaining(stopped, mainLineLength, root.halfMoves);
        if (!remaining || remaining.tokens.length === 0) return null;
        return {
            kind: "after-stop",
            moves: remaining.tokens.map((san) => ({ san, unsure: false })),
        };
    }

    const parentPath = position.slice(0, -1);
    if (!parentPath.every((index) => index === 0)) return null;

    const parent = getNodeAtPath(root, parentPath);
    const userNode = parent.children[position[position.length - 1]];
    if (userNode.children.length > 0) return null;
    const replacedNode = parent.children[0];

    const moves: ScoresheetMove[] = [];
    let cur = replacedNode.children[0];
    while (cur && cur.san !== null) {
        moves.push({ san: cur.san, unsure: cur.unsure === true });
        cur = cur.children[0];
    }
    const oldMainLineMoveCount = moves.length;

    const oldMainLineLength = countMainPly(root);
    if (scoresheetReview.stopped && oldMainLineLength >= scoresheetReview.stopped.ply) {
        const remaining = deriveScoresheetRemaining(
            scoresheetReview.stopped,
            oldMainLineLength,
            root.halfMoves,
        );
        if (remaining) {
            for (const token of remaining.tokens) {
                moves.push({ san: token, unsure: false });
            }
        }
    }

    if (moves.length === 0) return null;

    return {
        kind: "replace-middle",
        parentPath,
        oldMainLineMoveCount,
        moves,
    };
}

/**
 * Whether the line starting at `startNode` is plain: no sub-variations, comments, annotations,
 * shapes, NAGs, diagram markers, or non-final game-end markers. `unsure` marks and a `gameEnd`
 * marker on the line's last move do not disqualify it.
 */
export function isPlainScoresheetLine(startNode: TreeNode): boolean {
    let cur: TreeNode | undefined = startNode;
    while (cur) {
        const isLastNode = cur.children.length === 0;
        if (
            cur.children.length > 1 ||
            cur.comment !== "" ||
            cur.startingComment !== undefined ||
            cur.commands !== undefined ||
            cur.nags.length > 0 ||
            cur.shapes.length > 0 ||
            (!isLastNode && cur.gameEnd !== undefined) ||
            cur.diagram !== undefined
        ) {
            return false;
        }
        cur = cur.children[0];
    }
    return true;
}

/**
 * Strictly parses and appends `moves` as a linear chain under `tailNode`, stopping at the first
 * token that is not a legal SAN move in the current position (`?` is never legal).
 * Preserves each move's `unsure` mark. Returns the number of moves appended.
 */
export function replayScoresheetMoves(
    tailNode: TreeNode,
    moves: readonly ScoresheetMove[],
): number {
    const [pos] = positionFromFen(tailNode.fen);
    if (!pos) return 0;
    let tail = tailNode;
    let halfMoves = tailNode.halfMoves;
    let replayed = 0;
    for (const entry of moves) {
        if (!entry.san || entry.san === "?") break;
        const move = parseSan(pos, entry.san);
        if (!move || !pos.isLegal(move)) break;
        const san = makeSan(pos, move);
        pos.play(move);
        halfMoves += 1;
        const nextNode = createNode({
            fen: makeFen(pos.toSetup()),
            move,
            san,
            halfMoves,
        });
        if (entry.unsure) nextNode.unsure = true;
        tail.children.push(nextNode);
        tail = nextNode;
        replayed += 1;
    }
    return replayed;
}
