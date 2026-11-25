import { tauri } from "@/platform/tauri";
import { chessBaseGuideAtom } from "@/components/library/chessBaseGuideState";
import { Result } from "@badrap/result";
import { platform } from "@/platform/native";
import { errorUnlessCancelled, normalizeError, runWithAppliedRecovery } from "@/platform/errors";
import { defaultGame, makePgn } from "chessops/pgn";
import { getDefaultStore } from "jotai";
import useSWR from "swr";
import type { FileMetadata, FileType } from "@/components/files/file";
import { lineTitleOf } from "./lineTitle";
import { reconcileWorkspaceListing, type WorkspaceListingCache } from "./workspaceListing";
import type {
    FileWorkspaceHandle,
    WorkspaceFileContent,
    WriteExpectation,
    WriteStamp,
} from "@/bindings";
import { fileWorkspaceAtom, fileWorkspaceDisplayNameAtom } from "@/state/atoms";
import { beginFileWrite } from "@/state/fileFreshness";
import { isAbsentHeader } from "@/state/gameSignature";
import { parsePGN } from "./chess";
import { fileWorkspaceKey } from "./pathCapabilities";
import { getGameName, type GameHeaders } from "./treeReducer";

const NATIVE_TRIM =
    /^[\t\n\v\f\r\u0020\u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+|[\t\n\v\f\r\u0020\u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+$/g;

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

function sameHeaderValue(
    a: string | null | undefined,
    b: string | null | undefined,
    kind: "name" | "date" | "round",
): boolean {
    const absentA = isAbsentHeader(a, kind);
    const absentB = isAbsentHeader(b, kind);
    return absentA || absentB ? absentA === absentB : a === b;
}

export function sameGameIdentity(a: GameHeaders, b: GameHeaders): boolean {
    return (
        sameHeaderValue(a.white, b.white, "name") &&
        sameHeaderValue(a.black, b.black, "name") &&
        sameHeaderValue(a.date, b.date, "date") &&
        sameHeaderValue(a.round, b.round, "round") &&
        a.fen === b.fen
    );
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
        const result = await tauri.issueFileWorkspace(null);
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

export async function setFileGameOrientation(
    handle: FileWorkspaceHandle,
    gameNumber: number,
    orientation: "white" | "black",
    stamp: string,
    revision: string,
): Promise<WriteStamp> {
    return withFileWrite(handle, () =>
        tauri.setGameOrientation(handle, gameNumber, orientation, stamp, revision),
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
    if (signal?.aborted) throw new DOMException("Cancellation", "AbortError");
    return { ...game, tree: linkedSource ? { ...tree, linkedSource } : tree };
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
        // Mirror native pgn_name (Rust's str::trim, ASCII case-insensitive .pgn check, append) and
        // listing's case-sensitive repeated .pgn strip. Never case-fold names (d-20261018-04).
        // Trim Unicode White_Space, deliberately not JS trim(), which also strips U+FEFF.
        const trimmed = filename.replace(NATIVE_TRIM, "");
        const leaf = /\.pgn$/i.test(trimmed) ? trimmed : `${trimmed}.pgn`;
        const listedName = leaf.replace(/(?:\.pgn)+$/, "");
        const entry = await runWithAppliedRecovery(
            () =>
                tauri.createWorkspaceFile(
                    workspace,
                    parent,
                    filename,
                    { type: filetype, tags: [] },
                    content ?? { kind: "text", pgn: makePgn(defaultGame()) },
                ),
            async () => {
                const listing = await tauri.listFileWorkspace(parent);
                if (
                    listing.unread.some(
                        (candidate) =>
                            candidate.parent === null &&
                            candidate.kind !== "directory" &&
                            (candidate.name === listedName || candidate.name === leaf),
                    )
                ) {
                    return undefined;
                }
                const matches = listing.entries.filter(
                    (candidate) =>
                        candidate.kind === "file" &&
                        (candidate.name === listedName || candidate.name === leaf),
                );
                return matches.length === 1 ? matches[0] : undefined;
            },
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
