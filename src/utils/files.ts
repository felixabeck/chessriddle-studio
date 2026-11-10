import { tauri } from "@/platform/tauri";
import { chessBaseGuideAtom } from "@/components/library/chessBaseGuideState";
import { Result } from "@badrap/result";
import { platform } from "@/platform/native";
import { errorUnlessCancelled, normalizeError, runWithAppliedRecovery } from "@/platform/errors";
import { defaultGame, makePgn } from "chessops/pgn";
import { getDefaultStore } from "jotai";
import useSWR from "swr";
import type { FileMetadata, FileType } from "@/components/files/file";
import { lineTitleOf } from "@/components/files/lineTitle";
import {
    reconcileWorkspaceListing,
    type WorkspaceListingCache,
} from "@/components/files/workspaceListing";
import type {
    FileWorkspaceHandle,
    WorkspaceFileContent,
    WriteExpectation,
    WriteStamp,
} from "@/bindings";
import {
    addRecentFileAtom,
    fileWorkspaceAtom,
    fileWorkspaceDisplayNameAtom,
    tabFamily,
} from "@/state/atoms";
import { beginFileWrite, setFileFreshness } from "@/state/fileFreshness";
import { beginFileOpen, StaleFileGameError } from "@/state/fileStructureChange";
import { parsePGN } from "./chess";
import { fileWorkspaceKey } from "./pathCapabilities";
import { createTab, type SetTabs } from "./tabs";
import { getGameName, type GameHeaders } from "./treeReducer";

export function getFileGameName(
    headers: GameHeaders,
    file: Pick<FileMetadata, "name" | "metadata">,
): string {
    if (file.metadata.type === "repertoire") {
        return lineTitleOf(headers).name ?? file.name.replace(/\.pgn$/i, "");
    }
    const name = getGameName(headers);
    return name === "Unknown" || name === "?" ? file.name.replace(/\.pgn$/i, "") : name;
}

export function usePlatform() {
    const r = useSWR("os", async () => {
        return platform();
    });
    return { os: r.data, ...r };
}

/** A recognised ChessBase selection ends the pick and opens the shared migration guide. */
export async function pickPgnWorkspace() {
    try {
        return await tauri.issuePgnWorkspace();
    } catch (error) {
        if (normalizeError(error).chessBaseDatabase) {
            getDefaultStore().set(chessBaseGuideAtom, "selected");
            return null;
        }
        if (errorUnlessCancelled(error) === null) return null;
        throw error;
    }
}

export async function pickPgnFile(
    destination: "existing" | "export" = "existing",
): Promise<FileMetadata | null> {
    let descriptor;
    try {
        descriptor =
            destination === "export"
                ? await tauri.issuePgnExportDestination()
                : await pickPgnWorkspace();
    } catch (error) {
        if (errorUnlessCancelled(error) === null) return null;
        throw error;
    }
    if (!descriptor) return null;
    const count = await tauri.countPgnGames(descriptor.handle);
    return {
        type: "file",
        handle: descriptor.handle,
        name: descriptor.displayName.replace(/\.pgn$/i, ""),
        numGames: count,
        metadata: { type: "game", tags: [] },
        lastModified: Date.now(),
    };
}

export async function ensureFileWorkspace(): Promise<FileWorkspaceHandle | null> {
    const store = getDefaultStore();
    const existing = store.get(fileWorkspaceAtom);
    if (existing) return existing;
    try {
        const result = await tauri.issueFileWorkspace();
        store.set(fileWorkspaceAtom, result.handle);
        store.set(fileWorkspaceDisplayNameAtom, result.displayName);
        return result.handle;
    } catch (error) {
        if (errorUnlessCancelled(error) === null) return null;
        throw error;
    }
}

export async function readFileGame(
    handle: FileWorkspaceHandle,
    gameNumber: number,
    signal?: AbortSignal,
) {
    return tauri.readGame(handle, gameNumber, signal ? { signal } : undefined);
}

/** Marks the file as being written by the app for the duration of `mutation`, so the freshness
 * poll never classifies the app's own atomic replacement as another program's. */
export async function withFileWrite<T>(
    handle: FileWorkspaceHandle,
    mutation: () => Promise<T>,
): Promise<T> {
    const endWrite = beginFileWrite(fileWorkspaceKey(handle));
    try {
        return await mutation();
    } finally {
        endWrite();
    }
}

export async function writeFileGame(
    handle: FileWorkspaceHandle,
    gameNumber: number,
    pgn: string,
    expectation: WriteExpectation,
): Promise<WriteStamp> {
    return withFileWrite(handle, () => tauri.writeGame(handle, gameNumber, pgn, expectation));
}

export async function setFileGameSection(
    handle: FileWorkspaceHandle,
    gameNumber: number,
    section: string | null,
    stamp: string,
    revision: string,
): Promise<WriteStamp> {
    return withFileWrite(handle, () =>
        tauri.setGameSection(handle, gameNumber, section, stamp, revision),
    );
}

export async function loadFileGame(
    handle: FileWorkspaceHandle,
    gameNumber: number,
    signal?: AbortSignal,
): Promise<
    Awaited<ReturnType<typeof readFileGame>> & {
        tree: Awaited<ReturnType<typeof parsePGN>> & {
            linkedSource?: import("@/bindings").LinkedGameLocator | null;
        };
    }
> {
    const game = await readFileGame(handle, gameNumber, signal);
    const tree = await parsePGN(game.pgn, undefined, { signal });
    tree.sourceStamp = game.stamp;
    const linkedSource = game.linked ?? null;
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    return { ...game, tree: linkedSource ? { ...tree, linkedSource } : tree };
}

export async function openFile(
    file: FileMetadata,
    setTabs: SetTabs,
    options?: {
        gameNumber?: number;
        tabName?: string;
        ownerId?: string;
        panel?: "practice";
        store?: ReturnType<typeof getDefaultStore>;
        expected?: { stamp: string; revision: string };
    },
) {
    const store = options?.store ?? getDefaultStore();
    const gameNumber = options?.gameNumber ?? 0;
    const endOpen = beginFileOpen(fileWorkspaceKey(file.handle));
    try {
        const loaded = await loadFileGame(file.handle, gameNumber);
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
            store.set(tabFamily(id), "practice");
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

export async function createFile({
    filename,
    filetype,
    content,
    workspace,
    parent,
    listingCache,
}: {
    filename: string;
    filetype: FileType;
    content?: WorkspaceFileContent;
    workspace: FileWorkspaceHandle;
    parent: FileWorkspaceHandle;
    listingCache: WorkspaceListingCache;
}): Promise<Result<FileMetadata>> {
    try {
        const expected = filename.toLowerCase();
        const withoutPgn = expected.replace(/\.pgn$/i, "");
        const entry = await runWithAppliedRecovery(
            () =>
                tauri.createWorkspaceFile(
                    workspace,
                    parent,
                    filename,
                    { type: filetype, tags: [] },
                    content ?? { kind: "text", pgn: makePgn(defaultGame()) },
                ),
            async () =>
                (await tauri.listFileWorkspace(parent)).entries.find((candidate) => {
                    const actual = candidate.name.toLowerCase();
                    return actual === expected || actual === withoutPgn;
                }),
            () => reconcileWorkspaceListing(workspace, listingCache),
        );
        if (!entry.metadata || entry.gameCount === null)
            return Result.err(Error("Native workspace returned incomplete file metadata"));
        return Result.ok({
            type: "file",
            handle: entry.handle,
            name: entry.name,
            numGames: entry.gameCount,
            metadata: { type: entry.metadata.type, tags: entry.metadata.tags },
            lastModified: Number(entry.lastModified),
        });
    } catch (error) {
        return Result.err(error instanceof Error ? error : Error(String(error)));
    }
}
