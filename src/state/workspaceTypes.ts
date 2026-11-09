import { z } from "zod";
import { type FileMetadata, fileMetadataSchema } from "@/components/files/file";
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

export const tabSchema = z.object({
    name: z.string(),
    value: z.string(),
    treeKey: z.string().uuid().optional(),
    type: z.enum(["new", "play", "analysis", "puzzles", "chessriddleTraining"]),
    gameOrigin: gameOriginSchema,
});

export type GameOrigin = z.infer<typeof gameOriginSchema>;
export type Tab = z.infer<typeof tabSchema>;
export type TabFile = FileMetadata;

export function tabHasTree(tab: Pick<Tab, "type">): boolean {
    return tab.type !== "new" && tab.type !== "chessriddleTraining";
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
