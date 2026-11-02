import { z } from "zod";
import {
    fileWorkspaceHandleSchema,
    databaseHandleSchema,
    linkedGameLocatorSchema,
} from "@/utils/pathCapabilities";

const fileRecentSchema = z.object({
    name: z.string(),
    handle: fileWorkspaceHandleSchema,
    type: z.enum(["game", "repertoire", "tournament", "puzzle", "other"]),
    lastOpened: z.number(),
});

export const recentFileSchema = z.union([
    fileRecentSchema,
    z.object({
        kind: z.literal("database"),
        name: z.string(),
        database: databaseHandleSchema,
        gameId: z.number().int(),
        linked: z
            .object({
                locator: linkedGameLocatorSchema,
                signature: z.object({
                    white: z.string().nullable(),
                    black: z.string().nullable(),
                    event: z.string().nullable(),
                    site: z.string().nullable(),
                    date: z.string().nullable(),
                    round: z.string().nullable(),
                }),
            })
            .optional(),
        databaseTitle: z.string().optional(),
        lastOpened: z.number(),
    }),
]);
export type RecentFile = z.infer<typeof recentFileSchema>;
export type RecentDatabaseGame = Extract<RecentFile, { kind: "database" }>;
export type RecentEntryInput =
    | Omit<z.infer<typeof fileRecentSchema>, "lastOpened">
    | Omit<RecentDatabaseGame, "lastOpened">;

export function isDatabaseRecent(file: RecentFile): file is RecentDatabaseGame {
    return "kind" in file && file.kind === "database";
}
