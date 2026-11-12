import { z } from "zod";
import type {
    ErrorCategory,
    FileWorkspaceHandle,
    WorkspaceEntry,
    WorkspaceListing,
} from "@/bindings";
import { i18nKey } from "@/utils/i18nKey";
import {
    capabilityKey,
    fileWorkspaceHandleSchema,
    fileWorkspaceKey,
} from "@/utils/pathCapabilities";

const fileTypeSchema = z.enum(["repertoire", "game", "tournament", "puzzle", "other"]);
export type FileType = z.infer<typeof fileTypeSchema>;

// The i18nKey marker keeps these keys for the i18n extractor.
export const FILE_TYPES = [
    { translationKey: i18nKey("Files.FileType.Game"), value: "game" },
    { translationKey: i18nKey("Files.FileType.Repertoire"), value: "repertoire" },
    { translationKey: i18nKey("Files.FileType.Tournament"), value: "tournament" },
    { translationKey: i18nKey("Files.FileType.Puzzle"), value: "puzzle" },
    { translationKey: i18nKey("Files.FileType.Other"), value: "other" },
] as const satisfies readonly { translationKey: string; value: FileType }[];

export const fileInfoMetadataSchema = z.object({
    type: fileTypeSchema,
    tags: z.array(z.string()),
});

export const fileMetadataSchema = z.object({
    type: z.literal("file"),
    handle: fileWorkspaceHandleSchema,
    name: z.string(),
    numGames: z.number(),
    metadata: fileInfoMetadataSchema,
    lastModified: z.number(),
    readError: z.custom<ErrorCategory>().optional(),
});
export type FileMetadata = z.infer<typeof fileMetadataSchema>;

export type Directory = {
    type: "directory";
    handle: FileWorkspaceHandle;
    children: Entry[];
    name: string;
    lastModified: number;
};

export type UnreadableEntry = {
    type: "unreadable";
    name: string;
    category: ErrorCategory;
    key: string;
};
export type UsableEntry = FileMetadata | Directory;
export type Entry = UsableEntry | UnreadableEntry;

export function findEntry(entries: Entry[], key: string, kind: Entry["type"]): UsableEntry | null {
    for (const entry of entries) {
        if (
            entry.type !== "unreadable" &&
            entry.type === kind &&
            fileWorkspaceKey(entry.handle) === key
        )
            return entry;
        if (entry.type === "directory") {
            const child = findEntry(entry.children, key, kind);
            if (child) return child;
        }
    }
    return null;
}

export function workspaceEntryToEntry(entry: WorkspaceEntry, unreadKey = ""): Entry {
    if (entry.kind === "directory") {
        return {
            type: "directory",
            handle: entry.handle,
            name: entry.name,
            children: convertEntries(entry.children, entry.handle),
            lastModified: Number(entry.lastModified),
        };
    }
    if (!entry.metadata || entry.gameCount === null) {
        if (entry.readError) {
            return {
                type: "unreadable",
                name: entry.name,
                category: entry.readError,
                key: unreadKey,
            };
        }
        throw new Error("Native workspace returned an incomplete PGN entry");
    }
    return {
        type: "file",
        handle: entry.handle,
        name: entry.name,
        numGames: entry.gameCount,
        metadata: { type: entry.metadata.type, tags: entry.metadata.tags },
        lastModified: Number(entry.lastModified),
        ...(entry.readError ? { readError: entry.readError } : {}),
    };
}

function convertEntries(entries: WorkspaceEntry[], parent: FileWorkspaceHandle): Entry[] {
    let unreadIndex = 0;
    return entries.map((entry) =>
        workspaceEntryToEntry(
            entry,
            entry.readError && (!entry.metadata || entry.gameCount === null)
                ? `${capabilityKey(parent)}:unread:${unreadIndex++}`
                : "",
        ),
    );
}

/** Attach handle-free children only to parents prepared by this listing. */
export function workspaceListingToEntries(
    listing: WorkspaceListing,
    root: FileWorkspaceHandle,
): Entry[] {
    const entries = convertEntries(listing.entries, root);
    const parents = new Map<string, Entry[]>([[capabilityKey(root), entries]]);
    const visit = (nodes: Entry[]) => {
        for (const entry of nodes) {
            if (entry.type === "directory") {
                parents.set(capabilityKey(entry.handle), entry.children);
                visit(entry.children);
            }
        }
    };
    visit(entries);
    for (const unread of listing.unread) {
        const parent = unread.parent ?? root;
        const siblings = parents.get(capabilityKey(parent));
        if (!siblings) throw new Error("Native workspace returned an unprepared parent");
        const index = siblings.filter((entry) => entry.type === "unreadable").length;
        siblings.push({
            type: "unreadable",
            name: unread.name,
            category: unread.category,
            key: `${capabilityKey(parent)}:unread:${index}`,
        });
    }
    return entries;
}
