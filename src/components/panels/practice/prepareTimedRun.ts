import type { DatabaseHandle, FileWorkspaceHandle } from "@/bindings";
import { inScopeCards } from "@/components/files/opening";
import type { Position } from "@/utils/practicePosition";
import { validWeight } from "@/utils/practicePosition";
import { applyReachWeights, computeReachWeights, fetchTreesStatistics } from "@/utils/repertoire";
import type { GameHeaders, TreeNode } from "@/utils/treeReducer";
import { loadFileGame } from "@/utils/files";

export type TimedRunPrepareChapter = {
    file: string;
    game: number;
    positions: Position[];
    handle: FileWorkspaceHandle;
};

export type TimedRunPrepareTree = {
    root: TreeNode;
    headers: GameHeaders;
};

export type TimedRunPrepareDeps = {
    loadTree: (
        handle: FileWorkspaceHandle,
        game: number,
        signal: AbortSignal,
    ) => Promise<TimedRunPrepareTree>;
    writeDeck: (file: string, game: number, positions: Position[]) => Promise<void>;
    fetchStatistics?: typeof fetchTreesStatistics;
};

export type TimedRunPrepareResult =
    | { status: "aborted" }
    | { status: "ready"; statsFailed: boolean; statsError?: unknown };

export function isAbortError(error: unknown): boolean {
    return error instanceof DOMException
        ? error.name === "AbortError"
        : error instanceof Error && error.name === "AbortError";
}

function chapterNeedsWeights(positions: readonly Position[]): boolean {
    return inScopeCards(positions).some((position) => validWeight(position.weight) === undefined);
}

export const defaultTimedRunPrepareDeps: TimedRunPrepareDeps = {
    loadTree: async (handle, game, signal) => {
        const loaded = await loadFileGame(handle, game, signal);
        return { root: loaded.tree.root, headers: loaded.tree.headers };
    },
    writeDeck: async () => {
        throw new Error("writeDeck must be supplied by the entry point");
    },
};

export async function prepareTimedRunWeights(options: {
    chapters: readonly TimedRunPrepareChapter[];
    referenceDb: DatabaseHandle;
    signal: AbortSignal;
    deps?: Partial<TimedRunPrepareDeps>;
}): Promise<TimedRunPrepareResult> {
    const deps: TimedRunPrepareDeps = { ...defaultTimedRunPrepareDeps, ...options.deps };
    const fetchStatistics = deps.fetchStatistics ?? fetchTreesStatistics;
    const needingWeights = options.chapters.filter((chapter) =>
        chapterNeedsWeights(chapter.positions),
    );
    if (needingWeights.length === 0) return { status: "ready", statsFailed: false };

    type Loaded = TimedRunPrepareChapter & TimedRunPrepareTree;
    const loaded: Loaded[] = [];
    for (const chapter of needingWeights) {
        if (options.signal.aborted) return { status: "aborted" };
        try {
            const tree = await deps.loadTree(chapter.handle, chapter.game, options.signal);
            if (options.signal.aborted) return { status: "aborted" };
            loaded.push({ ...chapter, ...tree });
        } catch (error) {
            if (isAbortError(error) || options.signal.aborted) return { status: "aborted" };
        }
    }
    if (loaded.length === 0) return { status: "ready", statsFailed: false };

    let statistics;
    try {
        statistics = await fetchStatistics(
            loaded.map((chapter) => ({
                root: chapter.root,
                startPath: chapter.headers.start || [],
            })),
            options.referenceDb,
            options.signal,
        );
    } catch (error) {
        if (isAbortError(error) || options.signal.aborted) return { status: "aborted" };
        return { status: "ready", statsFailed: true, statsError: error };
    }
    if (options.signal.aborted) return { status: "aborted" };

    for (const chapter of loaded) {
        if (options.signal.aborted) return { status: "aborted" };
        const orientation = chapter.headers.orientation || "white";
        const startPath = chapter.headers.start || [];
        const weights = computeReachWeights(chapter.root, orientation, startPath, statistics);
        if (!weights) continue;
        const updated = applyReachWeights(chapter.positions, weights);
        if (!updated) continue;
        try {
            await deps.writeDeck(chapter.file, chapter.game, updated);
        } catch (error) {
            if (isAbortError(error) || options.signal.aborted) return { status: "aborted" };
        }
        if (options.signal.aborted) return { status: "aborted" };
    }
    return { status: "ready", statsFailed: false };
}
