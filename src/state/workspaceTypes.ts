import { z } from "zod";
import { fileMetadataSchema } from "@/components/files/file";
import {
    databaseHandleSchema,
    explorerOnlineSourceSchema,
    linkedGameLocatorSchema,
} from "@/utils/pathCapabilities";
import type { LocalOptions } from "@/utils/db";
import {
    explorerFiltersSchema,
    isDefaultExplorerFilters,
    MAX_DATABASE_KEY_LENGTH,
    normalizeExplorerFilters,
} from "./explorerFilters";

const gameOriginSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("none") }),
    z.object({ kind: z.literal("databaseDraft"), database: databaseHandleSchema }),
    z.object({ kind: z.literal("fileDraft"), file: fileMetadataSchema }),
    z.object({ kind: z.literal("file"), file: fileMetadataSchema, gameNumber: z.number() }),
    z.object({ kind: z.literal("temp_file"), file: fileMetadataSchema, gameNumber: z.number() }),
    // Existing database origins remain readable. Native resolution runs before tab admission/save.
    z.object({
        kind: z.literal("database"),
        database: databaseHandleSchema,
        gameId: z.number(),
        linked: linkedGameLocatorSchema.optional(),
    }),
]);

const tabExplorerOptionsSchema = explorerFiltersSchema
    .extend({
        player_database: z.string().min(1).max(MAX_DATABASE_KEY_LENGTH).optional(),
    })
    .strict();

const explorerFurtherColumnSchema = z.union([z.literal("reference"), explorerOnlineSourceSchema]);
const MAX_EXPLORER_FURTHER_COLUMNS = 1 + explorerOnlineSourceSchema.options.length;

const tabExplorerSchema = z
    .object({
        firstSource: explorerOnlineSourceSchema.optional(),
        pinned: databaseHandleSchema.optional(),
        comparison: z
            .object({
                database: databaseHandleSchema,
                player: z.number().int(),
            })
            .strict()
            .optional(),
        further: z
            .array(explorerFurtherColumnSchema)
            .min(1)
            .max(MAX_EXPLORER_FURTHER_COLUMNS)
            .refine((columns) => new Set(columns).size === columns.length)
            .optional(),
        options: tabExplorerOptionsSchema.optional(),
    })
    .strict()
    .refine((value) => Object.keys(value).length > 0);

const currentTabSchema = z.object({
    name: z.string(),
    value: z.string(),
    treeKey: z.string().uuid().optional(),
    type: z.enum(["new", "play", "analysis", "puzzles"]),
    puzzleSource: z.enum(["chessriddle", "offline"]).optional().catch(undefined),
    gameOrigin: gameOriginSchema,
    explorer: tabExplorerSchema.optional(),
});

export type GameOrigin = z.infer<typeof gameOriginSchema>;
type TabExplorerOptions = z.infer<typeof tabExplorerOptionsSchema>;
export type TabExplorer = z.infer<typeof tabExplorerSchema>;
export type Tab = z.infer<typeof currentTabSchema>;

function buildTabSchema(
    explorer: z.ZodType<TabExplorer | undefined, z.ZodTypeDef, unknown>,
): z.ZodType<Tab, z.ZodTypeDef, unknown> {
    const current = currentTabSchema.extend({ explorer });
    return z.union([
        current,
        current.extend({ type: z.literal("chessriddleTraining") }).transform((tab) => ({
            ...tab,
            type: "puzzles" as const,
            puzzleSource: "chessriddle" as const,
        })),
    ]) as z.ZodType<Tab, z.ZodTypeDef, unknown>;
}

export const tabSchema = buildTabSchema(tabExplorerSchema.optional());

/** Lenient tab schema for reading stored workspaces: drops only an invalid `explorer`. */
export const storedTabSchema: z.ZodType<Tab, z.ZodTypeDef, unknown> = buildTabSchema(
    tabExplorerSchema.optional().catch(undefined),
).transform((tab) => {
    if (tab.explorer !== undefined) return tab;
    const { explorer: _dropped, ...rest } = tab;
    return rest;
});

/** Canonical persisted form of a tab's own explorer filters; returns `undefined` at defaults. */
export function canonicalTabExplorerOptions(
    options: Pick<
        LocalOptions,
        | "player"
        | "player_database"
        | "color"
        | "start_date"
        | "end_date"
        | "result"
        | "elo"
        | "exclude_fast_events"
    >,
): TabExplorerOptions | undefined {
    const filters = normalizeExplorerFilters({
        player: options.player,
        color: options.color,
        start_date: options.start_date,
        end_date: options.end_date,
        result: options.result,
        elo: options.elo,
        exclude_fast_events: options.exclude_fast_events,
    });
    if (isDefaultExplorerFilters(filters)) return undefined;
    const { exclude_fast_events, ...rest } = filters;
    return {
        ...rest,
        ...(exclude_fast_events ? { exclude_fast_events: true as const } : {}),
        ...(filters.player !== null && options.player_database
            ? { player_database: options.player_database }
            : {}),
    };
}

export function getTabTreeKey(tab: Tab): string {
    return tab.treeKey ?? tab.value;
}

export function newWorkspaceId(reservedIds: Iterable<string> = []) {
    const reserved = new Set(reservedIds);
    for (let attempt = 0; attempt < 32; attempt++) {
        const id = crypto.randomUUID();
        if (
            !reserved.has(id) &&
            (typeof sessionStorage === "undefined" || sessionStorage.getItem(id) === null)
        ) {
            return id;
        }
    }
    throw new Error("Could not allocate a unique tab ID.");
}
