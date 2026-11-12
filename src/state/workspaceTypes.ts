import { z } from "zod";
import { fileMetadataSchema } from "@/components/files/file";
import { databaseHandleSchema, linkedGameLocatorSchema } from "@/utils/pathCapabilities";

const gameOriginSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("none") }),
    z.object({ kind: z.literal("databaseDraft"), database: databaseHandleSchema }),
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

const currentTabSchema = z.object({
    name: z.string(),
    value: z.string(),
    treeKey: z.string().uuid().optional(),
    type: z.enum(["new", "play", "analysis", "puzzles"]),
    puzzleSource: z.enum(["chessriddle", "offline"]).optional().catch(undefined),
    gameOrigin: gameOriginSchema,
});

export const tabSchema = z.union([
    currentTabSchema,
    currentTabSchema.extend({ type: z.literal("chessriddleTraining") }).transform((tab) => ({
        ...tab,
        type: "puzzles" as const,
        puzzleSource: "chessriddle" as const,
    })),
]);

export type GameOrigin = z.infer<typeof gameOriginSchema>;
export type Tab = z.infer<typeof tabSchema>;

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
