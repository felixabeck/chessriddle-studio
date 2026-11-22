/** Recent files and last-opened timestamps. */
import type { SetStateAction } from "react";
import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";
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
import { createZodStorage, initializeBeforeUse } from "../utils";
import { documentPreferences, initializeRendererState } from "./rendererState";

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

/** Refresh native identities without changing the last-opened timestamp. */
export const updateRecentFilesAtom = atom(null, (get, set, files: SetStateAction<RecentFile[]>) => {
    set(
        recentFilesAtom,
        dedupeRecentFiles(typeof files === "function" ? files(get(recentFilesAtom)) : files),
    );
});

export const recentFilesAtom = initializeBeforeUse(
    atomWithStorage<RecentFile[]>(
        "recent-files",
        [],
        createZodStorage(z.array(recentFileSchema), localStorage),
    ),
    initializeRendererState,
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
