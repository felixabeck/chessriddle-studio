import { makeUci } from "chessops";
import { normalizeError } from "@/platform/errors";
import type { TreeNode } from "@/utils/treeReducer";

// Raw `makeUci` on purpose, not `getMainLine`: during a game the tree is rebuilt from native's
// reported moves (`setFen`, then `syncTreeWithMoves`), and native echoes each move in the
// notation it received — `e1g1` from a board move or a standard engine, `e1h1` from a parsed
// PGN castle sent as `initialMoves`. The poll compares against that raw echo; `getMainLine`
// would normalise every castle to `e1h1` and break the prefix check.
export function getMainlineUcis(root: TreeNode): string[] {
    const moves: string[] = [];
    let node = root;
    while (node.children.length > 0) {
        node = node.children[0];
        if (node.move) {
            moves.push(makeUci(node.move));
        }
    }
    return moves;
}

/**
 * A throttled renderer update belongs to exactly one native game session.
 *
 * The asymmetry between the two null checks is deliberate, so do not "restore" it:
 * `currentGeneration` is a plain counter that is never null (`useRef(0)` in `useNativeGameOwnership`),
 * so `queuedGeneration === currentGeneration` already excludes a null queue on its own.
 * `currentSession` really can be null — it is cleared during a session handoff — so without
 * the explicit check a queued update carrying no session would compare `null === null` and
 * be accepted as current, which is exactly the stale update this gate exists to reject.
 */
export function isCurrentQueuedGameUpdate(
    queuedGeneration: number | null,
    currentGeneration: number,
    queuedSession: bigint | null,
    currentSession: bigint | null,
): boolean {
    return (
        queuedGeneration === currentGeneration &&
        queuedSession !== null &&
        queuedSession === currentSession
    );
}

export async function abortExactGame(
    gameId: string,
    session: bigint,
    abort: (gameId: string, expectedSession: bigint) => Promise<unknown>,
): Promise<void> {
    try {
        await abort(gameId, session);
    } catch (error) {
        if (normalizeError(error).backendCategory !== "missing-resource") throw error;
    }
}

export async function abortExactTabGame(
    tabId: string,
    getGameId: (tabId: string) => string | null,
    getSession: (tabId: string) => bigint | null,
    abort: (gameId: string, expectedSession: bigint) => Promise<unknown>,
    clear?: (gameId: string, session: bigint) => void,
): Promise<string | null> {
    const gameId = getGameId(tabId);
    const session = getSession(tabId);
    if (!gameId || session === null) return null;
    await abortExactGame(gameId, session, abort);
    clear?.(gameId, session);
    return gameId;
}
