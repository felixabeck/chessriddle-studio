/** Recent files and last-opened timestamps. */
import type { SetStateAction } from "react";
import { atom } from "jotai";
import { z } from "zod";
import { normalizeGameSignature } from "../gameSignature";
import { recentFileSchema, type RecentFile, type RecentEntryInput } from "../recentFiles";
import {
    boundLastOpened,
    createLastOpenedStorage,
    databaseGameOpenedKey,
    type LastOpened,
} from "../lastOpened";
import { fileWorkspaceKey, capabilityKey } from "../../utils/pathCapabilities";
import { createZodStorage } from "../utils";
import { documentPreferences } from "./rendererState";

const MAX_RECENT_FILES = 10;

export {
    recentFileSchema,
    isDatabaseRecent,
    type RecentFile,
    type RecentDatabaseGame,
    type RecentEntryInput,
} from "../recentFiles";

export function recentFileKey(file: RecentFile | RecentEntryInput): string {
    if (!("kind" in file)) return fileWorkspaceKey(file.handle);
    return JSON.stringify([
        "database",
        capabilityKey(file.database),
        file.linked
            ? [file.linked.locator.collection, normalizeGameSignature(file.linked.signature)]
            : file.gameId,
    ]);
}

export function dedupeRecentFiles(files: RecentFile[]): RecentFile[] {
    const seen = new Set<string>();
    return [...files]
        .sort((a, b) => b.lastOpened - a.lastOpened)
        .filter((file) => {
            const key = recentFileKey(file);
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        })
        .slice(0, MAX_RECENT_FILES);
}

type FileRecent = Extract<RecentFile, { handle: unknown }>;

/** After a Library sidecar type or name write, keep matching Recent-file rows in sync. */
export function patchRecentFilesSidecar({
    setRecentFiles,
    fileKey,
    name,
    type,
}: {
    setRecentFiles: (files: SetStateAction<RecentFile[]>) => void;
    fileKey: string;
    name: string;
    type: FileRecent["type"];
}): void {
    setRecentFiles((files) => {
        let changed = false;
        const next = files.map((file) => {
            if ("kind" in file) return file;
            if (fileWorkspaceKey(file.handle) !== fileKey) return file;
            if (file.name === name && file.type === type) return file;
            changed = true;
            return { ...file, name, type };
        });
        return changed ? next : files;
    });
}

/** Refresh native identities, or patch sidecar name/type, without changing last-opened. */
export const updateRecentFilesAtom = atom(null, (get, set, files: SetStateAction<RecentFile[]>) => {
    const current = get(recentFilesAtom);
    const next = typeof files === "function" ? files(current) : files;
    if (next === current) return;
    set(recentFilesAtom, dedupeRecentFiles(next));
});

export const recentFilesAtom = documentPreferences.atomWithStorage<RecentFile[]>(
    "recent-files",
    [],
    createZodStorage(z.array(recentFileSchema), localStorage),
);

export const lastOpenedAtom = documentPreferences.atomWithStorage<LastOpened>(
    "last-opened",
    {},
    createLastOpenedStorage(localStorage),
);

export const recordLastOpenedAtom = atom(null, (get, set, keys: string[]) => {
    const now = Date.now();
    set(
        lastOpenedAtom,
        boundLastOpened({
            ...Object.fromEntries(keys.map((key) => [key, now])),
            ...Object.fromEntries(
                Object.entries(get(lastOpenedAtom)).filter(([key]) => !keys.includes(key)),
            ),
        }),
    );
});

export const addRecentFileAtom = atom(null, (get, set, file: RecentEntryInput) => {
    const current = get(recentFilesAtom);
    set(recentFilesAtom, dedupeRecentFiles([{ ...file, lastOpened: Date.now() }, ...current]));
    set(
        recordLastOpenedAtom,
        "kind" in file
            ? [capabilityKey(file.database), databaseGameOpenedKey(file.database, file.gameId)]
            : [fileWorkspaceKey(file.handle)],
    );
});
