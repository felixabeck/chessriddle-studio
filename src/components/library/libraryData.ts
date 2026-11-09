import type { CollectionDescriptor, DatabaseHandle } from "@/bindings";
import type { Entry, FileMetadata, UnreadableEntry } from "@/components/files/file";
import type { LastOpened } from "@/state/lastOpened";
import type { RecentFile } from "@/state/recentFiles";
import { databaseHandleKey, sameDatabaseHandle, type ManagedDatabaseInfo } from "@/utils/db";
import { fileWorkspaceKey } from "@/utils/pathCapabilities";

export function collectionFiles(entries: readonly Entry[]): FileMetadata[] {
    return entries.flatMap((entry) =>
        entry.type === "file"
            ? [entry]
            : entry.type === "directory"
              ? collectionFiles(entry.children)
              : [],
    );
}

export function joinLibraryCollections(
    entries: readonly Entry[],
    collections: readonly CollectionDescriptor[],
) {
    const files = collectionFiles(entries);
    const byFile = new Map<string, CollectionDescriptor>();
    for (const collection of collections) {
        const key = fileWorkspaceKey(collection.file);
        if (collection.status !== "retired" && !byFile.has(key)) byFile.set(key, collection);
    }
    const missing = collections.filter(
        (collection) =>
            !["trashed", "retired", "preservedOriginal", "ready"].includes(collection.status) &&
            !files.some(
                (file) => fileWorkspaceKey(file.handle) === fileWorkspaceKey(collection.file),
            ),
    );
    return { files, byFile, missing };
}

export function standaloneDatabases(
    databases: readonly ManagedDatabaseInfo[],
    conversions: readonly { targetDatabase: DatabaseHandle | null }[],
) {
    return databases.filter(
        (item) =>
            !item.collection &&
            !conversions.some((entry) => sameDatabaseHandle(item.file, entry.targetDatabase)),
    );
}

export type LibraryRow =
    | {
          kind: "file";
          key: string;
          name: string;
          modified: number;
          opened?: number;
          file: FileMetadata | Extract<RecentFile, { handle: unknown }>;
      }
    | {
          kind: "collection";
          key: string;
          name: string;
          modified: number;
          opened?: number;
          collection: CollectionDescriptor;
      }
    | {
          kind: "database";
          key: string;
          name: string;
          modified: number;
          opened?: number;
          database: ManagedDatabaseInfo;
      };

export type LibraryProjectionInput = {
    entries?: readonly Entry[];
    collections?: readonly CollectionDescriptor[];
    databases?: readonly ManagedDatabaseInfo[];
    conversions?: readonly { targetDatabase: DatabaseHandle | null }[];
    recents?: readonly RecentFile[];
    lastOpened?: LastOpened;
    listingError?: unknown;
    databaseError?: unknown;
};

/** Opened items precede never-opened items, whose fallback is modified time. */
export function compareLibraryRows(left: LibraryRow, right: LibraryRow): number {
    if (left.opened !== undefined || right.opened !== undefined) {
        if (left.opened === undefined) return 1;
        if (right.opened === undefined) return -1;
        if (left.opened !== right.opened) return right.opened - left.opened;
    }
    return (
        right.modified - left.modified || (left.key < right.key ? -1 : left.key > right.key ? 1 : 0)
    );
}

export function projectLibrary(input: LibraryProjectionInput) {
    const {
        entries = [],
        collections = [],
        databases = [],
        conversions = [],
        recents = [],
        lastOpened = {},
    } = input;
    const join = joinLibraryCollections(entries, collections);
    const rows = new Map<string, LibraryRow>();
    const unread: UnreadableEntry[] = [];
    const collectUnread = (nodes: readonly Entry[]) => {
        for (const node of nodes) {
            if (node.type === "unreadable") unread.push(node);
            else if (node.type === "directory") collectUnread(node.children);
        }
    };
    collectUnread(entries);
    const opened = new Map(Object.entries(lastOpened));
    for (const recent of recents) {
        const key =
            "kind" in recent ? databaseHandleKey(recent.database) : fileWorkspaceKey(recent.handle);
        opened.set(key, Math.max(opened.get(key) ?? 0, recent.lastOpened));
    }
    const hiddenCollection = (collection: CollectionDescriptor) =>
        ["retired", "trashed", "preservedOriginal"].includes(collection.status) ||
        conversions.some((conversion) =>
            sameDatabaseHandle(conversion.targetDatabase, collection.database),
        );
    const knownFiles = new Set(
        collections
            .filter(
                (collection) =>
                    collection.status !== "preservedOriginal" && collection.status !== "retired",
            )
            .map((collection) => fileWorkspaceKey(collection.file)),
    );
    for (const file of join.files) {
        const key = fileWorkspaceKey(file.handle);
        if (!knownFiles.has(key))
            rows.set(key, {
                kind: "file",
                key,
                name: file.name,
                file,
                modified: file.lastModified,
                opened: opened.get(key),
            });
    }
    for (const recent of recents) {
        if ("kind" in recent) continue;
        const key = fileWorkspaceKey(recent.handle);
        if (!rows.has(key) && !knownFiles.has(key))
            rows.set(key, {
                kind: "file",
                key,
                name: recent.name,
                file: recent,
                modified: 0,
                opened: opened.get(key),
            });
    }
    for (const collection of collections) {
        if (hiddenCollection(collection)) continue;
        const fileKey = fileWorkspaceKey(collection.file);
        const databaseKey = collection.database ? databaseHandleKey(collection.database) : "";
        const times = [opened.get(fileKey), opened.get(databaseKey)].filter(
            (time): time is number => time !== undefined,
        );
        rows.set(`linked:${collection.id}`, {
            kind: "collection",
            key: `linked:${collection.id}`,
            name: collection.name,
            collection,
            modified:
                join.files.find((file) => fileWorkspaceKey(file.handle) === fileKey)
                    ?.lastModified ?? 0,
            opened: times.length ? Math.max(...times) : undefined,
        });
    }
    for (const database of standaloneDatabases(databases, conversions)) {
        const key = databaseHandleKey(database.file);
        rows.set(key, {
            kind: "database",
            key,
            name: database.type === "success" ? database.title : database.filename,
            database,
            modified: 0,
            opened: opened.get(key),
        });
    }
    return {
        rows: [...rows.values()].sort(compareLibraryRows),
        unread,
        failedFiles: join.files.filter((file) => file.readError),
        listingError: input.listingError,
        databaseError: input.databaseError,
    };
}
