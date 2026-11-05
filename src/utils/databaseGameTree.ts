import type { DatabaseHandle, NormalizedGame } from "@/bindings";
import { logFailureSafely, safeFailureContext } from "@/platform/errors";
import { tauri, type NativeReadOptions } from "@/platform/tauri";
import { decodePgnTagValue, parsePGN } from "./chess";
import type { TreeState } from "./treeReducer";

/** Seed only the initial view. A remembered choice always wins and no edit is made. */
export async function seedDatabaseOrientation(
    tree: TreeState,
    database: DatabaseHandle,
    gameId: number,
    options?: NativeReadOptions,
) {
    if (tree.headers.orientation || options?.signal?.aborted) return tree;
    try {
        const orientation = await tauri.inferGameOrientation(database, gameId);
        if (orientation && !options?.signal?.aborted) tree.headers.orientation = orientation;
    } catch (cause) {
        const primaryFailure = safeFailureContext(cause);
        await logFailureSafely(
            `Database orientation inference failed: ${primaryFailure.message}`,
            { operation: "inferGameOrientation", primaryFailure },
            "Database orientation inference logging failed",
        );
    }
    return tree;
}

export function databaseGameHeaders(game: NormalizedGame) {
    // Event and Site retain PGN escapes in the database. Tree headers contain decoded text.
    return { ...game, event: decodePgnTagValue(game.event), site: decodePgnTagValue(game.site) };
}

/** Convert a row using its own starting position, headers and row stamp. */
export async function databaseGameToTree(
    game: NormalizedGame,
    database?: DatabaseHandle,
    options?: NativeReadOptions,
) {
    const tree = await parsePGN(game.moves, game.fen, options);
    tree.headers = databaseGameHeaders(game);
    tree.sourceStamp = game.stamp ?? null;
    return database ? seedDatabaseOrientation(tree, database, game.id, options) : tree;
}
