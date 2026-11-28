import { getDefaultStore } from "jotai";
import type { StoreApi } from "zustand";
import type { FileMetadata } from "@/components/files/file";
import { fileWorkspaceAtom } from "@/state/atoms";
import { readRepertoireIndex, refreshRepertoireIndex } from "@/state/repertoireIndex";
import type { TreeStoreState } from "@/state/store/tree";
import { fileWorkspaceKey } from "@/utils/pathCapabilities";

export type RepertoireColor = "white" | "black";

type ColoredChapter = { headers: { orientation?: RepertoireColor | null } };

/**
 * The color every chapter that has one agrees on, or `null` when no chapter has a color or two
 * chapters disagree. Chapters without a color do not vote: they are what this color fills in.
 */
export function sharedChapterColor(chapters: readonly ColoredChapter[]): RepertoireColor | null {
    let shared: RepertoireColor | null = null;
    for (const { headers } of chapters) {
        const color = headers.orientation;
        if (!color) continue;
        if (shared !== null && shared !== color) return null;
        shared = color;
    }
    return shared;
}

/** Whether `file` is a repertoire, the only kind of file whose games carry a color. */
export function isRepertoireFile(file: FileMetadata): boolean {
    return file.metadata.type === "repertoire";
}

/**
 * The color of repertoire `file` as its indexed chapters share it (see `sharedChapterColor`), or
 * `null` when the file is no repertoire, is not in the index (outside the index bounds or
 * unreadable), or its chapters have no common color.
 */
export async function repertoireFileColor(file: FileMetadata): Promise<RepertoireColor | null> {
    if (!isRepertoireFile(file)) return null;
    const workspace = getDefaultStore().get(fileWorkspaceAtom);
    await refreshRepertoireIndex(workspace);
    const key = fileWorkspaceKey(file.handle);
    const indexed = readRepertoireIndex(workspace)?.files.find((f) => f.workspaceKey === key);
    return indexed ? sharedChapterColor(indexed.chapters) : null;
}

/**
 * Whether the game in `store`, saved into `file`, needs a color filled in: `file` is a repertoire
 * and the game has none. Synchronous, so callers that do not need one keep their timing.
 */
export function needsRepertoireColor(store: StoreApi<TreeStoreState>, file: FileMetadata): boolean {
    return isRepertoireFile(file) && !store.getState().headers.orientation;
}

/**
 * Gives the game in `store` `color` when it still has none, so a chapter added to or edited in a
 * Black repertoire is saved — and shown — as Black. The caller looks the color up with
 * `repertoireFileColor` and checks it still owns the game before calling this. Returns whether the
 * headers changed.
 */
export function fillRepertoireColor(
    store: StoreApi<TreeStoreState>,
    color: RepertoireColor | null,
): boolean {
    const { headers, setHeaders } = store.getState();
    if (color === null || headers.orientation) return false;
    setHeaders({ ...headers, orientation: color });
    return true;
}
