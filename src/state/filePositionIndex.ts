import type { ErrorCategory, FileWorkspaceHandle } from "@/bindings";
import type { FileMetadata } from "@/components/files/file";
import {
    errorUnlessCancelled,
    normalizeError,
    safeFailureContext,
    warnSafely,
} from "@/platform/errors";
import { tauri } from "@/platform/tauri";
import { scanChapterPositions, type ChapterScanResult } from "@/state/chapterScan";
import { getFileGameName } from "@/utils/files";
import { fileWorkspaceKey } from "@/utils/pathCapabilities";
import type { FileChapterOccurrence } from "@/state/transpositionTarget";

export type FilePositionIndexBounds = {
    maxChapters: number;
    maxBytes: number;
    maxPositions: number;
    pageSize: number;
    maxFiles: number;
};

/**
 * Measured once on 2026-11-24 at the limit (500 chapters, 4,804,500 bytes, 200,000 positions,
 * page size 100, mocked `lexPgn`): total build 5,753.0 ms, max per-chapter
 * parse+yield gap 27.04 ms, within the budget in
 * `tasks/plans/2026-11-24-file-wide-transpositions.md` (Risks R1: within a few seconds at the
 * limit with no main-thread block above one chapter's parse). This is not a test: the limit
 * semantics are tested with small bounds.
 */
export const MAX_FILE_INDEX_CHAPTERS = 500;
export const MAX_FILE_INDEX_BYTES = 5 * 1024 * 1024;
export const MAX_FILE_INDEX_POSITIONS = 200_000;
export const FILE_INDEX_PAGE_SIZE = 100;
export const MAX_INDEXED_FILES = 3;

export type FileIndexTarget = Pick<FileMetadata, "handle" | "name" | "metadata">;

export type IndexedChapter = {
    name: string;
    rootKey: string;
};

export type IndexedFileOccurrence = {
    chapter: number;
    path: number[];
    hasContinuation: boolean;
    moveOrder: string;
};

export type FilePositionIndex = {
    revision: string;
    chapters: ReadonlyMap<number, IndexedChapter>;
    positions: ReadonlyMap<string, readonly IndexedFileOccurrence[]>;
};

export type FileIndexExitStatus = "built" | "ineligible" | "failed" | "cancelled" | "evicted";

export type FilePositionIndexRequest = {
    release: () => void;
    finished: Promise<FileIndexExitStatus>;
};

const PGN_CONTENT_ERROR_CATEGORIES: ReadonlySet<ErrorCategory> = new Set([
    "parsing",
    "invalid-input",
    "chess-data",
]);

const encoder = new TextEncoder();

function isCancellationError(cause: unknown): boolean {
    return errorUnlessCancelled(cause) === null;
}

function isPgnContentError(cause: unknown): boolean {
    const { backendCategory } = normalizeError(cause);
    return backendCategory !== undefined && PGN_CONTENT_ERROR_CATEGORIES.has(backendCategory);
}

function yieldToEventLoop(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(new DOMException("Cancellation", "AbortError"));
    return new Promise((resolve, reject) => {
        const onAbort = () => {
            clearTimeout(timer);
            reject(new DOMException("Cancellation", "AbortError"));
        };
        const timer = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
        }, 0);
        signal.addEventListener("abort", onAbort, { once: true });
    });
}

type BuildResult =
    | { outcome: "built"; index: FilePositionIndex }
    | { outcome: "ineligible" | "failed" | "cancelled" };

async function buildFilePositionIndex(
    file: FileIndexTarget,
    revision: string,
    signal: AbortSignal,
    bounds: FilePositionIndexBounds,
): Promise<BuildResult> {
    const fileKey = fileWorkspaceKey(file.handle);
    try {
        if (signal.aborted) return { outcome: "cancelled" };

        const chapterCount = await tauri.countPgnGames(file.handle, { signal });
        if (signal.aborted) return { outcome: "cancelled" };
        if (chapterCount < 2 || chapterCount > bounds.maxChapters) {
            return { outcome: "ineligible" };
        }

        let next = 0;
        let totalBytes = 0;
        let totalPositions = 0;
        let parsedAnyChapter = false;
        let skippedChapters = 0;
        let firstSkipCause: unknown;
        const chapters = new Map<number, IndexedChapter>();
        const positions = new Map<string, IndexedFileOccurrence[]>();

        while (next < chapterCount) {
            if (signal.aborted) return { outcome: "cancelled" };
            const end = Math.min(chapterCount - 1, next + bounds.pageSize - 1);
            const page = await tauri.readGames(file.handle, next, end, { signal });
            if (signal.aborted) return { outcome: "cancelled" };

            if (page.length === 0) {
                throw new Error(`Empty game page returned at chapter ${next} of ${chapterCount}`);
            }
            if (next + page.length > chapterCount) {
                throw new Error(
                    `Game page exceeded counted chapters (${next + page.length} > ${chapterCount})`,
                );
            }

            for (const game of page) {
                if (game.revision !== revision) {
                    throw new Error(
                        `File revision changed during index build (expected ${revision}, got ${game.revision})`,
                    );
                }
            }

            for (const game of page) {
                if (game.omission === "tooLarge") {
                    return { outcome: "ineligible" };
                }
                totalBytes += encoder.encode(game.pgn).length;
                if (totalBytes > bounds.maxBytes) {
                    return { outcome: "ineligible" };
                }
            }

            for (let offset = 0; offset < page.length; offset++) {
                const chapterIndex = next + offset;
                const game = page[offset];
                if (!game.present) {
                    skippedChapters++;
                    firstSkipCause ??= new Error(`Chapter ${chapterIndex} is absent`);
                    continue;
                }

                if (parsedAnyChapter) {
                    await yieldToEventLoop(signal);
                }
                if (signal.aborted) return { outcome: "cancelled" };
                parsedAnyChapter = true;

                let scanResult: ChapterScanResult;
                let overPositionLimit = false;
                try {
                    scanResult = await scanChapterPositions(
                        game.pgn,
                        (occ) => {
                            totalPositions++;
                            if (totalPositions > bounds.maxPositions) {
                                overPositionLimit = true;
                                return false;
                            }
                            const entry: IndexedFileOccurrence = {
                                chapter: chapterIndex,
                                path: occ.path,
                                hasContinuation: occ.hasContinuation,
                                moveOrder: occ.moveOrder,
                            };
                            const existing = positions.get(occ.boardState);
                            if (existing) existing.push(entry);
                            else positions.set(occ.boardState, [entry]);
                            return true;
                        },
                        { signal },
                    );
                } catch (cause) {
                    if (signal.aborted || isCancellationError(cause)) {
                        return { outcome: "cancelled" };
                    }
                    if (isPgnContentError(cause)) {
                        skippedChapters++;
                        firstSkipCause ??= cause;
                        continue;
                    }
                    throw cause;
                }

                if (overPositionLimit) {
                    return { outcome: "ineligible" };
                }

                chapters.set(chapterIndex, {
                    name: getFileGameName(scanResult.headers, file),
                    rootKey: scanResult.rootKey,
                });
            }

            next += page.length;
        }

        if (skippedChapters > 0) {
            const failure = safeFailureContext(
                firstSkipCause ?? new Error("Chapter absent from file"),
            );
            warnSafely(
                `File position index skipped ${skippedChapters} chapter(s) (${JSON.stringify({
                    fileKey,
                    revision,
                    failure,
                })})`,
            );
        }

        return {
            outcome: "built",
            index: { revision, chapters, positions },
        };
    } catch (cause) {
        if (signal.aborted || isCancellationError(cause)) {
            return { outcome: "cancelled" };
        }
        const failure = safeFailureContext(cause);
        warnSafely(
            `File position index build failed (${JSON.stringify({
                fileKey,
                revision,
                failure,
            })})`,
        );
        return { outcome: "failed" };
    }
}

type RegistryEntry =
    | {
          status: "building";
          revision: string;
          controller: AbortController;
          owners: Set<symbol>;
          evicted: boolean;
          finished: Promise<FileIndexExitStatus>;
      }
    | {
          status: "built";
          revision: string;
          index: FilePositionIndex;
      }
    | {
          status: "ineligible";
          revision: string;
      }
    | {
          status: "failed";
          revision: string;
      };

export function createFilePositionIndexRegistry(
    boundsOverrides?: Partial<FilePositionIndexBounds>,
) {
    const bounds: FilePositionIndexBounds = {
        maxChapters: MAX_FILE_INDEX_CHAPTERS,
        maxBytes: MAX_FILE_INDEX_BYTES,
        maxPositions: MAX_FILE_INDEX_POSITIONS,
        pageSize: FILE_INDEX_PAGE_SIZE,
        maxFiles: MAX_INDEXED_FILES,
        ...boundsOverrides,
    };

    const entries = new Map<string, RegistryEntry>();
    const listeners = new Set<() => void>();

    function notify() {
        for (const listener of [...listeners]) {
            try {
                listener();
            } catch (cause) {
                const failure = safeFailureContext(cause);
                warnSafely(
                    `File position index subscriber failed (${JSON.stringify({ failure })})`,
                );
            }
        }
    }

    function evictOldestIfNeeded(keepKey: string) {
        while (entries.size > bounds.maxFiles) {
            const oldest = entries.entries().next();
            if (oldest.done) break;
            const [oldestKey, oldestEntry] = oldest.value;
            if (oldestKey === keepKey) break;
            entries.delete(oldestKey);
            if (oldestEntry.status === "building") {
                oldestEntry.evicted = true;
                oldestEntry.controller.abort();
            }
        }
    }

    function makeRelease(
        key: string,
        entry: Extract<RegistryEntry, { status: "building" }>,
        owner: symbol,
    ) {
        let released = false;
        return () => {
            if (released) return;
            released = true;
            entry.owners.delete(owner);
            if (entry.owners.size === 0 && entries.get(key) === entry) {
                entries.delete(key);
                entry.controller.abort();
                notify();
            }
        };
    }

    function request(file: FileIndexTarget, revision: string): FilePositionIndexRequest {
        const key = fileWorkspaceKey(file.handle);
        const existing = entries.get(key);
        if (existing && existing.revision === revision) {
            entries.delete(key);
            entries.set(key, existing);
            if (existing.status !== "building") {
                return {
                    release: () => undefined,
                    finished: Promise.resolve(existing.status),
                };
            }
            const owner = Symbol();
            existing.owners.add(owner);
            return {
                release: makeRelease(key, existing, owner),
                finished: existing.finished,
            };
        }

        if (existing) {
            entries.delete(key);
            if (existing.status === "building") {
                existing.controller.abort();
            }
        }

        const controller = new AbortController();
        const owner = Symbol();
        const owners = new Set([owner]);
        let resolveFinished!: (status: FileIndexExitStatus) => void;
        const finished = new Promise<FileIndexExitStatus>((resolve) => {
            resolveFinished = resolve;
        });

        const entry: Extract<RegistryEntry, { status: "building" }> = {
            status: "building",
            revision,
            controller,
            owners,
            evicted: false,
            finished,
        };
        entries.set(key, entry);
        evictOldestIfNeeded(key);

        void buildFilePositionIndex(file, revision, controller.signal, bounds).then((result) => {
            if (entry.evicted) {
                resolveFinished("evicted");
                return;
            }
            if (result.outcome === "cancelled" || controller.signal.aborted) {
                const removed = entries.get(key) === entry;
                if (removed) entries.delete(key);
                resolveFinished("cancelled");
                if (removed) notify();
                return;
            }
            if (entries.get(key) !== entry) {
                resolveFinished("cancelled");
                return;
            }

            if (result.outcome === "built") {
                entries.set(key, { status: "built", revision, index: result.index });
            } else if (result.outcome === "ineligible") {
                entries.set(key, { status: "ineligible", revision });
            } else {
                entries.set(key, { status: "failed", revision });
            }
            resolveFinished(result.outcome);
            notify();
        });

        notify();

        return {
            release: makeRelease(key, entry, owner),
            finished,
        };
    }

    function getIndex(
        handle: FileWorkspaceHandle,
        verifiedRevision: string | null,
    ): FilePositionIndex | null {
        if (verifiedRevision === null) return null;
        const entry = entries.get(fileWorkspaceKey(handle));
        if (!entry || entry.status !== "built" || entry.revision !== verifiedRevision) {
            return null;
        }
        return entry.index;
    }

    function subscribe(listener: () => void): () => void {
        listeners.add(listener);
        return () => {
            listeners.delete(listener);
        };
    }

    function reset(): void {
        for (const entry of entries.values()) {
            if (entry.status === "building") {
                entry.controller.abort();
            }
        }
        entries.clear();
        listeners.clear();
    }

    return {
        request,
        getIndex,
        subscribe,
        reset,
    };
}

const defaultRegistry = createFilePositionIndexRegistry();

export const requestFilePositionIndex = defaultRegistry.request;
export const getFilePositionIndex = defaultRegistry.getIndex;
export const subscribeFilePositionIndex = defaultRegistry.subscribe;
export const resetFilePositionIndexForTests = defaultRegistry.reset;

/**
 * Looks up occurrences of `boardState` in `index`, ignoring the tab's active `excludeChapter`
 * because the open tree holds the authoritative state for its own chapter.
 */
export function getFileChapterOccurrences(
    index: FilePositionIndex,
    boardState: string,
    excludeChapter?: number,
): FileChapterOccurrence[] {
    const raw = index.positions.get(boardState);
    if (!raw || raw.length === 0) return [];
    const occurrences: FileChapterOccurrence[] = [];
    for (const occ of raw) {
        if (excludeChapter !== undefined && occ.chapter === excludeChapter) continue;
        const chapterInfo = index.chapters.get(occ.chapter);
        if (!chapterInfo) continue;
        occurrences.push({
            chapter: occ.chapter,
            chapterName: chapterInfo.name,
            path: occ.path,
            hasContinuation: occ.hasContinuation,
            rootKey: chapterInfo.rootKey,
            moveOrder: occ.moveOrder,
        });
    }
    return occurrences;
}
