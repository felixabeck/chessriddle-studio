import { INITIAL_FEN } from "chessops/fen";
import type { Outcome, ScoresheetGame } from "@/bindings";
import { headersToPGN, parsePGN } from "@/utils/chess";
import type { TreeNode, TreeState } from "@/utils/treeReducer";

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
