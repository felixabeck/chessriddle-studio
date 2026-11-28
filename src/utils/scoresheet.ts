import { INITIAL_FEN, makeFen } from "chessops/fen";
import { makeSan, parseSan } from "chessops/san";
import type { Outcome, ScoresheetGame, ScoresheetMove } from "@/bindings";
import { headersToPGN, makeClk, parsePGN } from "@/utils/chess";
import { positionFromFen } from "@/utils/chessops";
import {
    countMainPly,
    createNode,
    deriveScoresheetRemaining,
    getBoardState,
    getNodeAtPath,
    getResolvedPathLength,
    type GameHeaders,
    type ScoresheetRemaining,
    type ScoresheetReview,
    type ScoresheetReviewLayout,
    type TreeNode,
    type TreeState,
} from "@/utils/treeReducer";

export const SCORESHEET_PHOTOS_TAG = "ScoresheetPhotos";
export const MAX_SCORESHEET_PHOTOS = 4;
const PHOTO_ID_HEX_LEN = 64;
const MAX_SCORESHEET_PHOTOS_TAG_LEN =
    MAX_SCORESHEET_PHOTOS * PHOTO_ID_HEX_LEN + (MAX_SCORESHEET_PHOTOS - 1);
const PHOTO_ID_RE = /^[0-9a-f]{64}$/;

/** Upper end of the normalised layout coordinates (0..=1000 of a photo's width or height). */
export const SCORESHEET_LAYOUT_SCALE = 1000;
/** Bounds the native reading enforces on a layout (`src-tauri/src/coach/scoresheet.rs`). */
export const MAX_SCORESHEET_LAYOUT_BLOCKS = 16;
export const MAX_SCORESHEET_LAYOUT_BLOCK_ROWS = 100;
export const MAX_SCORESHEET_MOVE_NUMBER = 300;
/** How far the marker reaches past its cell: a fraction of a row above and below. */
const MARKER_ROW_MARGIN = 0.2;
/** How far the marker reaches past its cell: a fraction of the block's width left and right. */
const MARKER_COLUMN_MARGIN = 0.03;

/**
 * Strictly parses an untrusted `ScoresheetPhotos` PGN tag value into 1–4 lowercase 64-hex ids.
 * Returns `null` for absent or malformed values; malformed values must be preserved untouched.
 */
export function parseScoresheetPhotosTag(raw: string | undefined): string[] | null {
    if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_SCORESHEET_PHOTOS_TAG_LEN) {
        return null;
    }
    const parts = raw.split(",");
    if (parts.length === 0 || parts.length > MAX_SCORESHEET_PHOTOS) {
        return null;
    }
    for (const part of parts) {
        if (!PHOTO_ID_RE.test(part)) return null;
    }
    return parts;
}

/** Formats 1–4 validated 64-hex photo ids into a `ScoresheetPhotos` tag value, or `null` if invalid. */
export function formatScoresheetPhotosTag(ids: readonly string[]): string | null {
    if (ids.length === 0 || ids.length > MAX_SCORESHEET_PHOTOS) return null;
    for (const id of ids) {
        if (!PHOTO_ID_RE.test(id)) return null;
    }
    return ids.join(",");
}

/** Returns the validated photo ids referenced by `headers.other.ScoresheetPhotos`, or `null`. */
export function getScoresheetPhotoIds(headers: GameHeaders | undefined): string[] | null {
    return parseScoresheetPhotosTag(headers?.other?.[SCORESHEET_PHOTOS_TAG]);
}

/** Whether the Photo panel is available for a tab: active review OR well-formed photo reference. */
export function hasScoresheetPhotoPanel(
    state: Pick<TreeState, "scoresheetReview" | "headers">,
): boolean {
    return state.scoresheetReview !== undefined || getScoresheetPhotoIds(state.headers) !== null;
}

/** Returns a new `GameHeaders` with `headers.other.ScoresheetPhotos` set to the validated `ids`. */
export function withScoresheetPhotoIds(headers: GameHeaders, ids: readonly string[]): GameHeaders {
    const tagValue = formatScoresheetPhotosTag(ids);
    if (tagValue === null) return headers;
    return {
        ...headers,
        other: {
            ...headers.other,
            [SCORESHEET_PHOTOS_TAG]: tagValue,
        },
    };
}

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
        const move = game.moves[ply];
        movetextParts.push(move.san);
        if (move.clock != null) {
            movetextParts.push(`{[%clk ${makeClk(move.clock)}]}`);
        }
    }
    const movetext = movetextParts.join(" ");
    return movetext ? `${headerPgn}\n${movetext} ${result}\n` : `${headerPgn}\n${result}\n`;
}

/**
 * Builds a review-ready `TreeState` from a native `ScoresheetGame`:
 * - composes PGN and parses it through `parsePGN`
 * - attaches validated `photoIds` onto `tree.headers` when supplied
 * - verifies that the parsed main line has the exact number of returned moves
 * - removes any game-end marker when the reading stopped early (completely read games keep the default)
 * - marks unsure main-line nodes, sets `scoresheetReview` (with the reading's layout bound to the
 *   attached photo ids), and marks the tree `dirty`.
 */
export async function buildScoresheetTree(
    game: ScoresheetGame,
    options?: { signal?: AbortSignal; photoIds?: readonly string[] },
): Promise<TreeState> {
    const pgn = scoresheetGameToPgn(game);
    const tree = await parsePGN(pgn, undefined, options);
    if (options?.photoIds) {
        tree.headers = withScoresheetPhotoIds(tree.headers, options.photoIds);
    }

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

    const layout: ScoresheetReviewLayout | undefined =
        game.layout && game.layout.length > 0
            ? {
                  photoIds: getScoresheetPhotoIds(tree.headers),
                  blocks: game.layout.map((block) => structuredClone(block)),
              }
            : undefined;
    tree.scoresheetReview = {
        ...(game.stopped
            ? {
                  stopped: {
                      ply: game.stopped.ply,
                      tokens: [...game.stopped.tokens],
                      ...(game.stopped.clocks != null ? { clocks: [...game.stopped.clocks] } : {}),
                  },
              }
            : {}),
        ...(layout ? { layout } : {}),
    };
    tree.dirty = true;
    return tree;
}

type ScoresheetContinuationPlan =
    | {
          kind: "after-stop";
          /** Remaining sheet tokens from `tokens[L - ply]` onward. */
          moves: ScoresheetMove[];
          /** Clock recorded at the stopped ply, when the user's move sits right on it (`L === ply + 1`). */
          stoppedPlyClock?: number;
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

function remainingToScoresheetMoves(
    remaining: Pick<ScoresheetRemaining, "tokens" | "clocks">,
): ScoresheetMove[] {
    return remaining.tokens.map((san, index) => {
        const clock = remaining.clocks?.[index];
        return typeof clock === "number" ? { san, unsure: false, clock } : { san, unsure: false };
    });
}

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
        const stoppedPlyClock =
            mainLineLength === stopped.ply + 1 && typeof stopped.clocks?.[0] === "number"
                ? stopped.clocks[0]
                : undefined;
        return {
            kind: "after-stop",
            moves: remainingToScoresheetMoves(remaining),
            ...(stoppedPlyClock !== undefined ? { stoppedPlyClock } : {}),
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
        moves.push(
            cur.clock !== undefined
                ? { san: cur.san, unsure: cur.unsure === true, clock: cur.clock }
                : { san: cur.san, unsure: cur.unsure === true },
        );
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
            moves.push(...remainingToScoresheetMoves(remaining));
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
 * Preserves each move's `unsure` mark and `clock` (in seconds). Returns the number of moves appended.
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
        if (entry.clock != null) nextNode.clock = entry.clock;
        if (entry.unsure) nextNode.unsure = true;
        tail.children.push(nextNode);
        tail = nextNode;
        replayed += 1;
    }
    return replayed;
}

/** A point in normalised photo coordinates (0..=1000 of the width and height). */
export type ScoresheetPoint = readonly [x: number, y: number];

/** Where the marker of one move goes: the photo page and the marker's four corners. */
export interface ScoresheetCell {
    page: number;
    /** Top-left, top-right, bottom-right, bottom-left, in normalised photo coordinates. */
    quad: readonly [ScoresheetPoint, ScoresheetPoint, ScoresheetPoint, ScoresheetPoint];
}

function lerpPoint(a: ScoresheetPoint, b: ScoresheetPoint, t: number): ScoresheetPoint {
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

/**
 * Finds the scoresheet cell of the move at `position`: its photo page and the marker quad, the
 * cell interpolated between the block's four corners and widened by a small margin so it reads as
 * an approximate region. The sheet ply is the node's `halfMoves`, so this applies to main-line and
 * variation moves alike. Returns `null` without a layout, at the start position, for a tree that does
 * not start at the standard position, for an unresolvable path, and for a move no block covers.
 */
export function findScoresheetCell(
    layout: ScoresheetReviewLayout | undefined,
    root: TreeNode,
    position: readonly number[],
): ScoresheetCell | null {
    if (!layout || position.length === 0) return null;
    if (root.halfMoves !== 0 || getBoardState(root.fen) !== getBoardState(INITIAL_FEN)) return null;
    if (getResolvedPathLength(root, position) !== position.length) return null;
    const ply = getNodeAtPath(root, [...position]).halfMoves;
    if (ply < 1) return null;
    const moveNumber = Math.ceil(ply / 2);
    const white = ply % 2 === 1;
    const block = layout.blocks.find(
        (candidate) =>
            moveNumber >= candidate.firstMove && moveNumber < candidate.firstMove + candidate.rows,
    );
    if (!block) return null;

    const row = moveNumber - block.firstMove;
    const top = (row - MARKER_ROW_MARGIN) / block.rows;
    const bottom = (row + 1 + MARKER_ROW_MARGIN) / block.rows;
    const left = (white ? 0 : 0.5) - MARKER_COLUMN_MARGIN;
    const right = (white ? 0.5 : 1) + MARKER_COLUMN_MARGIN;
    const at = (u: number, v: number): ScoresheetPoint =>
        lerpPoint(
            lerpPoint(block.topLeft, block.topRight, u),
            lerpPoint(block.bottomLeft, block.bottomRight, u),
            v,
        );
    return {
        page: block.page,
        quad: [at(left, top), at(right, top), at(right, bottom), at(left, bottom)],
    };
}

/** Whether `layout` belongs to the photos named by `photoIds` (`null` = no stored photos). */
export function scoresheetLayoutMatchesPhotos(
    layout: ScoresheetReviewLayout,
    photoIds: readonly string[] | null,
): boolean {
    if (layout.photoIds === null || photoIds === null) return layout.photoIds === photoIds;
    return (
        layout.photoIds.length === photoIds.length &&
        layout.photoIds.every((id, index) => id === photoIds[index])
    );
}
