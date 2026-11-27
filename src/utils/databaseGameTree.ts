import type { DatabaseHandle, NormalizedGame } from "@/bindings";
import { logFailureSafely, safeFailureContext } from "@/platform/errors";
import { tauri, type NativeReadOptions } from "@/platform/tauri";
import { decodePgnTagValue, parsePGN } from "./chess";
import { databaseHandleKey } from "./db";
import { parseScoresheetPhotosTag, SCORESHEET_PHOTOS_TAG } from "./scoresheet";
import { applyGameEndLoadDefault, type TreeState } from "./treeReducer";

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
        const item = `database ${databaseHandleKey(database)}, game ${gameId}`;
        await logFailureSafely(
            `Database orientation inference failed for ${item}: ${primaryFailure.message}`,
            { operation: "inferGameOrientation", item, primaryFailure },
            "Database orientation inference logging failed",
        );
    }
    return tree;
}

export function databaseGameHeaders(game: NormalizedGame) {
    // Event and Site retain PGN escapes in the database. Tree headers contain decoded text.
    const { scoresheet_photos, ...rest } = game;
    const headers: Omit<NormalizedGame, "scoresheet_photos"> & {
        other?: Record<string, string>;
    } = {
        ...rest,
        event: decodePgnTagValue(game.event),
        site: decodePgnTagValue(game.site),
    };
    if (
        typeof scoresheet_photos === "string" &&
        parseScoresheetPhotosTag(scoresheet_photos) !== null
    ) {
        headers.other = { [SCORESHEET_PHOTOS_TAG]: scoresheet_photos };
    }
    return headers;
}

/** Convert a row using its own starting position, headers and row stamp. */
export async function databaseGameToTree(
    game: NormalizedGame,
    database?: DatabaseHandle,
    options?: NativeReadOptions,
) {
    const tree = await parsePGN(game.moves, game.fen, options);
    tree.headers = databaseGameHeaders(game);
    applyGameEndLoadDefault(tree);
    tree.sourceStamp = game.stamp ?? null;
    return database ? seedDatabaseOrientation(tree, database, game.id, options) : tree;
}
