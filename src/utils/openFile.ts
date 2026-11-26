import { getDefaultStore } from "jotai";
import type { FileMetadata } from "@/components/files/file";
import { addRecentFileAtom, applyPreviewMovesHidden } from "@/state/atoms";
import { selectStripTab } from "@/state/stripTab";
import { setFileFreshness } from "@/state/fileFreshness";
import { beginFileOpen, StaleFileGameError } from "@/state/fileStructureChange";
import { getFileGameName, loadFileGame } from "./files";
import { fileWorkspaceKey } from "./pathCapabilities";
import { createTab, type SetTabs } from "./tabs";

export async function openFile(
    file: FileMetadata,
    setTabs: SetTabs,
    options?: {
        gameNumber?: number;
        tabName?: string;
        ownerId?: string;
        panel?: "practice";
        store?: ReturnType<typeof getDefaultStore>;
        signal?: AbortSignal;
        expected?: { stamp: string; revision: string };
        /** Opened from a game preview: the tab starts with its moves hidden when the hide-preview-moves preference is on. */
        fromPreview?: boolean;
    },
) {
    const store = options?.store ?? getDefaultStore();
    const gameNumber = options?.gameNumber ?? 0;
    const endOpen = beginFileOpen(fileWorkspaceKey(file.handle));
    try {
        const loaded = await loadFileGame(file.handle, gameNumber, options?.signal);
        const expected = options?.expected;
        if (
            expected &&
            (expected.stamp !== loaded.stamp || expected.revision !== loaded.revision)
        ) {
            throw new StaleFileGameError();
        }
        const tabName = options?.tabName ?? getFileGameName(loaded.tree.headers, file);

        const id = await createTab({
            tab: {
                name: tabName,
                type: "analysis",
            },
            setTabs,
            initialTree: loaded.tree,
            ownerId: options?.ownerId,
            store,
            signal: options?.signal,
            gameOrigin: {
                kind: "file",
                file,
                gameNumber,
            },
        });
        if (id === null) return null;

        // The tree was just read from disk, so the gate need not read it a second time.
        if (!loaded.present && gameNumber < file.numGames) {
            setFileFreshness(id, "unavailable");
        } else {
            setFileFreshness(id, "verified", { verifiedRevision: loaded.revision });
        }

        if (options?.panel === "practice") {
            selectStripTab(store, id, "practice");
        }

        if (options?.fromPreview) {
            applyPreviewMovesHidden(store, id);
        }

        store.set(addRecentFileAtom, {
            name: file.name,
            handle: file.handle,
            type: file.metadata.type,
        });

        return id;
    } finally {
        endOpen();
    }
}
