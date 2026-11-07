import { tauri } from "@/platform/tauri";
import databaseCatalogDocument from "@/catalogs/databases.json?raw";
import databaseCatalogSignature from "@/catalogs/databases.json.minisig?raw";
import puzzleCatalogDocument from "@/catalogs/puzzles.json?raw";
import puzzleCatalogSignature from "@/catalogs/puzzles.json.minisig?raw";
import { z } from "zod";
import useSWR, { type Arguments, type ScopedMutator } from "swr";
import {
    type DatabaseInfo,
    type DatabaseHandle,
    type DatabaseRootHandle,
    type GameQuery,
    type NormalizedGame,
    type Player,
    type PlayerQuery,
    type PuzzleDatabaseInfo,
    type QueryResponse,
} from "@/bindings";
import { capabilityKey } from "@/utils/pathCapabilities";
import { collectSequential } from "@/utils/collectSequential";
import { loadSignedCatalog } from "@/utils/signedCatalog";
import { logFailureSafely, normalizeError, safeFailureContext } from "@/platform/errors";
import i18n from "i18next";
import { getDefaultStore } from "jotai";
import { fileWorkspaceAtom } from "@/state/atoms";

export type SuccessDatabaseInfo = Extract<DatabaseInfo, { type: "success" }> & {
    collection?: import("@/bindings").CollectionDescriptor;
};
export type ManagedDatabaseInfo = DatabaseInfo & {
    file: DatabaseHandle;
    collection?: import("@/bindings").CollectionDescriptor;
};
export type DatabaseList = {
    databases: ManagedDatabaseInfo[];
    unread: { filename: string; error: string }[];
    root: DatabaseRootHandle;
    /** Absent when linked collections are unsupported, rather than an empty authoritative listing. */
    collections?: import("@/bindings").CollectionDescriptor[];
};

/** Collect original cache keys through SWR's public matcher without changing or revalidating them. */
export async function collectSWRKeys(
    mutate: ScopedMutator,
    matches: (key: Arguments) => boolean,
): Promise<Arguments[]> {
    const keys: Arguments[] = [];
    await mutate((key) => {
        if (matches(key)) keys.push(key);
        return false;
    });
    return keys;
}

/** Error::InvalidInput from src-tauri/src/db/migrations.rs validate_existing_database. */
export const DATABASE_NOT_INITIALIZED = "Invalid input: Database has not been initialized yet";

export type DownloadableDatabaseInfo = {
    title: string;
    description: string;
    player_count: number;
    game_count: number;
    storage_size: number;
    downloadLink: string;
    sha256: string;
    signature: string;
};

/** A puzzle database advertised by the bundled signed catalog.
 *
 * Unlike locally installed puzzle databases, a catalog entry has no path
 * capability. It becomes a local database only after the native download has
 * verified and installed it.
 */
export type DownloadablePuzzleDatabase = Pick<
    PuzzleDatabaseInfo,
    "title" | "description" | "puzzleCount"
> & {
    /** JSON cannot represent the native bigint storage size. */
    storageSize: number;
    downloadLink: string;
    sha256: string;
    signature: string;
};

const downloadableDatabaseSchema: z.ZodType<DownloadableDatabaseInfo, z.ZodTypeDef, unknown> = z
    .object({
        title: z.string().min(1),
        description: z.string().default(""),
        player_count: z.number(),
        game_count: z.number(),
        storage_size: z.number(),
        downloadLink: z.string().url(),
        sha256: z.string().regex(/^[a-fA-F0-9]{64}$/),
        signature: z.string().min(1),
    })
    .passthrough();
const downloadableDatabaseManifestSchema: z.ZodType<
    DownloadableDatabaseInfo[],
    z.ZodTypeDef,
    unknown
> = z.array(downloadableDatabaseSchema);

const downloadablePuzzleDatabaseSchema: z.ZodType<DownloadablePuzzleDatabase> = z
    .object({
        title: z.string().min(1),
        description: z.string(),
        puzzleCount: z.number().int().nonnegative(),
        storageSize: z.number().int().nonnegative(),
        downloadLink: z.string().url(),
        sha256: z.string().regex(/^[a-fA-F0-9]{64}$/),
        signature: z.string().min(1),
    })
    .strict();

/** Stable renderer identity for an opaque database capability.
 *
 * Handles are values, not strings: UI controls need a string key while native
 * commands must keep the original branded object. Keep that conversion at the
 * boundary instead of leaking path-shaped values through state.
 */
export function databaseHandleKey(handle: DatabaseHandle): string {
    return capabilityKey(handle);
}

export function sameDatabaseHandle(
    left: DatabaseHandle | null | undefined,
    right: DatabaseHandle | null | undefined,
): boolean {
    return left !== undefined && left !== null && right !== undefined && right !== null
        ? databaseHandleKey(left) === databaseHandleKey(right)
        : left === right;
}

export function databaseHandleFromKey(
    databases: readonly ManagedDatabaseInfo[],
    key: string | null,
): DatabaseHandle | null {
    if (!key) return null;
    return databases.find((database) => databaseHandleKey(database.file) === key)?.file ?? null;
}

export function defaultDatabaseProgressId(downloadLink: string): string {
    return `db:${downloadLink}`;
}

export function defaultPuzzleDatabaseProgressId(downloadLink: string): string {
    return `puzzle_db:${downloadLink}`;
}

export const puzzleDatabaseExtension = ".db3";

export function manifestDatabaseInstallCard(
    installed: readonly { type: string; title?: string }[],
    manifest: { downloadLink: string; title: string },
): { progressId: string; initInstalled: boolean } {
    return {
        progressId: defaultDatabaseProgressId(manifest.downloadLink),
        initInstalled: installed.some(
            (database) => database.type === "success" && database.title === manifest.title,
        ),
    };
}

export function manifestPuzzleDatabaseInstallCard(
    installed: readonly Pick<PuzzleDatabaseInfo, "title">[],
    manifest: { downloadLink: string; title: string },
): { progressId: string; initInstalled: boolean } {
    return {
        progressId: defaultPuzzleDatabaseProgressId(manifest.downloadLink),
        initInstalled: installed.some(
            (database) => database.title.replace(puzzleDatabaseExtension, "") === manifest.title,
        ),
    };
}

export type Sides = "WhiteBlack" | "BlackWhite" | "Any";

export interface CompleteGame {
    game: NormalizedGame;
    currentMove: number[];
}

export type Speed =
    | "UltraBullet"
    | "Bullet"
    | "Blitz"
    | "Rapid"
    | "Classical"
    | "Correspondence"
    | "Unknown";

export const ELO_FILTER_MAX = 3000;

function normalizeRange(range?: [number, number] | null): [number, number] | undefined {
    if (!range || (range[0] === 0 && range[1] === ELO_FILTER_MAX)) {
        return undefined;
    }
    return range;
}

export async function query_games(
    db: DatabaseHandle,
    query: GameQuery,
    options?: { signal?: AbortSignal },
): Promise<QueryResponse<NormalizedGame[]>> {
    return await tauri.getGames(
        db,
        {
            player1: query.player1,
            range1: normalizeRange(query.range1),
            player2: query.player2,
            range2: normalizeRange(query.range2),
            tournament_id: query.tournament_id,
            sides: query.sides,
            outcome: query.outcome,
            start_date: query.start_date,
            end_date: query.end_date,
            position: null,
            options: {
                skipCount: query.options?.skipCount ?? false,
                page: query.options?.page,
                pageSize: query.options?.pageSize,
                sort: query.options?.sort || "id",
                direction: query.options?.direction || "desc",
            },
        },
        options,
    );
}

export async function query_players(
    db: DatabaseHandle,
    query: PlayerQuery,
    options?: { signal?: AbortSignal },
): Promise<QueryResponse<Player[]>> {
    return await tauri.getPlayers(
        db,
        {
            options: {
                skipCount: query.options.skipCount || false,
                page: query.options.page,
                pageSize: query.options.pageSize,
                sort: query.options.sort,
                direction: query.options.direction,
            },
            name: query.name,
            nameMatch: query.nameMatch,
            range: normalizeRange(query.range),
        },
        options,
    );
}

function databaseReadErrorMessage(permission: boolean, missing: boolean): string {
    if (permission) return i18n.t("Databases.LoadError.Permission");
    if (missing) return i18n.t("Databases.LoadError.Missing");
    return i18n.t("Databases.LoadError.Title");
}

export async function getDatabases(options: { signal?: AbortSignal } = {}): Promise<DatabaseList> {
    const store = getDefaultStore();
    const workspace = store.get(fileWorkspaceAtom);
    const root = await tauri.getDatabaseWorkspace();
    const databases = await tauri.listWorkspaceDatabases(root, options);
    const linkedSupported = await tauri.linkedCollectionsSupported();
    const collections = linkedSupported
        ? await tauri.listLinkedCollections(workspace, options)
        : [];
    const retired = new Set(
        collections.flatMap((collection) =>
            collection.retiredDatabase ? [databaseHandleKey(collection.retiredDatabase)] : [],
        ),
    );
    const { values } = await collectSequential(
        databases.entries.filter((database) => !retired.has(databaseHandleKey(database.handle))),
        (database, index) => getDatabase(database.handle, database.filename, index, options.signal),
        { signal: options.signal, operation: "getDatabases metadata" },
    );
    for (const collection of collections) {
        if (collection.status === "trashed" && !collection.account) continue;
        if (collection.status === "retired" || !collection.database) continue;
        if (collection.status !== "ready") {
            values.push({
                type: "error",
                file: collection.database,
                filename: collection.name,
                indexed: false,
                error: i18n.t("Collections.Unavailable", {
                    defaultValue:
                        "The search index is unavailable. Retry, or select the collection's source file again.",
                }),
                collection,
            });
            continue;
        }
        const database = await getDatabase(
            collection.database,
            collection.name,
            values.length,
            options.signal,
        );
        values.push({ ...database, collection });
    }
    return {
        databases: values,
        collections: linkedSupported ? collections : undefined,
        root,
        unread: databases.unread.map(({ filename, category }) => ({
            filename,
            error: databaseReadErrorMessage(
                category === "permission",
                category === "missing-resource",
            ),
        })),
    };
}

async function getDatabase(
    file: DatabaseHandle,
    filename: string,
    itemIndex: number,
    signal?: AbortSignal,
): Promise<ManagedDatabaseInfo> {
    try {
        return { type: "success", ...(await tauri.getDbInfo(file)), file };
    } catch (cause) {
        const databaseAdmission = normalizeError(cause).databaseAdmission === true;
        const primaryFailure = safeFailureContext(cause);
        if (signal?.aborted || primaryFailure.category === "cancelled") throw cause;
        const logContext = {
            operation: "getDatabases metadata",
            itemIndex,
            filename,
            primaryFailure,
        };
        await logFailureSafely(
            `getDatabases metadata item ${itemIndex} (${filename}) failed: ${primaryFailure.message}`,
            logContext,
            "Database metadata logging failed",
        );
        let error: string;
        if (databaseAdmission) {
            error = i18n.t("Databases.LoadError.Admission");
        } else if (primaryFailure.message === DATABASE_NOT_INITIALIZED) {
            error = i18n.t("Databases.ImportUnfinished");
        } else {
            error = databaseReadErrorMessage(
                primaryFailure.category === "permission",
                primaryFailure.category === "not-found",
            );
        }
        return {
            type: "error",
            file,
            filename,
            indexed: false,
            error,
            ...(databaseAdmission ? { databaseAdmission: true } : {}),
        };
    }
}

export function useDefaultDatabases(opened: boolean) {
    const { data, error, isLoading } = useSWR(opened ? "default-dbs" : null, async () => {
        return await getDefaultDatabases();
    });
    return {
        defaultDatabases: data,
        error,
        isLoading,
    };
}

/** Bundled default database catalog; throws `CatalogVerificationError` when its signature fails. */
export async function getDefaultDatabases(): Promise<DownloadableDatabaseInfo[]> {
    return await loadSignedCatalog(
        databaseCatalogDocument,
        databaseCatalogSignature,
        downloadableDatabaseManifestSchema,
    );
}

/** Bundled default puzzle catalog; throws `CatalogVerificationError` when its signature fails. */
export async function getDefaultPuzzleDatabases(): Promise<DownloadablePuzzleDatabase[]> {
    return await loadSignedCatalog(
        puzzleCatalogDocument,
        puzzleCatalogSignature,
        z.array(downloadablePuzzleDatabaseSchema),
    );
}

export interface Opening {
    move: string;
    white: number;
    black: number;
    draw: number;
    unknown?: number;
}

export type LocalOptions = {
    path: DatabaseHandle | null;
    fen: string;
    type: "exact" | "partial";
    player: number | null;
    /** Database identity that owns the database-local player id. */
    player_database?: string;
    color: "white" | "black";
    start_date?: string;
    end_date?: string;
    result: "any" | "whitewon" | "draw" | "blackwon";
    /** Elo band both players must satisfy, with the full band meaning no filter. */
    elo?: [number, number];
    /** Drop games whose event name contains blitz, bullet, or armageddon. */
    exclude_fast_events?: boolean;
    include_unknown_results?: boolean;
    sample_order?: NonNullable<GameQuery["sample_order"]>;
};

export function getEffectiveLocalPlayer(
    options: Pick<LocalOptions, "player" | "player_database">,
    database: DatabaseHandle | null,
): number | null {
    return database && options.player_database === databaseHandleKey(database)
        ? options.player
        : null;
}

export async function getTournamentGames(file: DatabaseHandle, id: number, signal?: AbortSignal) {
    return await query_games(
        file,
        {
            options: {
                direction: "asc",
                sort: "id",
                skipCount: true,
            },
            tournament_id: id,
        },
        { signal },
    );
}

export async function searchPosition(options: LocalOptions, tab: string, signal?: AbortSignal) {
    // One band applied to both colours: position search bounds White by range1, Black by range2.
    const elo = normalizeRange(options.elo);
    const player = getEffectiveLocalPlayer(options, options.path);
    return await tauri.searchPosition(
        options.path!,
        {
            player1: options.color === "white" ? player : undefined,
            player2: options.color === "black" ? player : undefined,
            position: {
                fen: options.fen,
                type_: options.type,
            },
            start_date: options.start_date,
            end_date: options.end_date,
            ...(options.result !== "any" ? { wanted_result: options.result } : {}),
            ...(elo ? { range1: elo, range2: elo } : {}),
            ...(options.exclude_fast_events ? { exclude_fast_events: true } : {}),
            ...(options.include_unknown_results !== undefined
                ? { include_unknown_results: options.include_unknown_results }
                : {}),
            ...(options.sample_order !== undefined ? { sample_order: options.sample_order } : {}),
        },
        tab,
        { signal },
    );
}
