import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CollectionDescriptor, DatabaseHandle } from "@/bindings";
import { notifyUnlessCancelled } from "@/components/files/notifyError";
import { isTreeViewDeferred } from "@/state/deferredTreeView";
import type { TreeStore } from "@/state/store/tree";
import { computeTreeCoverage } from "@/utils/repertoire";
import type { TreeNode } from "@/utils/treeReducer";
import type { DbMovesMap } from "./useReferenceMoves";

export type CoverageStatus = "absent" | "loading" | "error" | "success";

export type UseRepertoireCoverageParams = {
    store: TreeStore;
    root: TreeNode;
    orientation: "white" | "black";
    referenceDb: DatabaseHandle | null;
    selectedReferenceKey: string | null;
    currencyGeneration: CollectionDescriptor["generation"] | undefined;
    currencyStatus: CollectionDescriptor["status"] | undefined;
    currencyError: unknown;
    currencyPending: boolean;
    minGames: number;
    startPath: number[];
    startStateMoves: Map<string, Map<string, string>>;
    replaceMoves: (moves: DbMovesMap) => void;
    errorTitle: string;
};

export function useRepertoireCoverage({
    store,
    root,
    orientation,
    referenceDb,
    selectedReferenceKey,
    currencyGeneration,
    currencyStatus,
    currencyError,
    currencyPending,
    minGames,
    startPath,
    startStateMoves,
    replaceMoves,
    errorTitle,
}: UseRepertoireCoverageParams) {
    const errorTitleRef = useRef(errorTitle);
    errorTitleRef.current = errorTitle;
    const replaceMovesRef = useRef(replaceMoves);
    replaceMovesRef.current = replaceMoves;

    const [coverageRetry, setCoverageRetry] = useState(0);
    const coverageInput = useMemo(
        () => ({
            root,
            orientation,
            referenceDb,
            selectedReference: selectedReferenceKey,
            generation: currencyGeneration,
            status: currencyStatus,
            error: currencyError,
            pending: currencyPending,
            minGames,
            startPath,
            startStateMoves,
            retry: coverageRetry,
        }),
        [
            root,
            orientation,
            referenceDb,
            selectedReferenceKey,
            currencyGeneration,
            currencyStatus,
            currencyError,
            currencyPending,
            minGames,
            startPath,
            startStateMoves,
            coverageRetry,
        ],
    );
    type CoverageOutcome = { input: typeof coverageInput } & (
        | { status: "loading" | "error" }
        | { status: "success"; result: Awaited<ReturnType<typeof computeTreeCoverage>> }
    );
    const [coverageOutcome, setCoverageOutcome] = useState<CoverageOutcome | null>(null);
    const liveCoverageInput = useRef(coverageInput);
    liveCoverageInput.current = coverageInput;
    const currentCoverage = coverageOutcome?.input === coverageInput ? coverageOutcome : null;
    const coverageResult = currentCoverage?.status === "success" ? currentCoverage.result : null;
    const coverageStatus: CoverageStatus = !referenceDb
        ? "absent"
        : (currentCoverage?.status ?? "loading");
    const coverageMap = coverageResult?.coverageMap;
    const retryCoverage = useCallback(() => setCoverageRetry((attempt) => attempt + 1), []);

    useEffect(() => {
        // buildDbCache walks the whole tree before its first await. That stays off this commit.
        if (isTreeViewDeferred(store)) return;
        if (!coverageInput.referenceDb) return;
        const controller = new AbortController();
        const isCurrent = () =>
            !controller.signal.aborted && liveCoverageInput.current === coverageInput;
        setCoverageOutcome({ input: coverageInput, status: "loading" });

        computeTreeCoverage(
            coverageInput.root,
            coverageInput.orientation,
            coverageInput.referenceDb,
            coverageInput.minGames,
            coverageInput.startPath,
            coverageInput.startStateMoves,
            controller.signal,
        )
            .then((result) => {
                if (isCurrent()) {
                    setCoverageOutcome({ input: coverageInput, status: "success", result });
                    replaceMovesRef.current(result.dbMovesMap);
                }
            })
            .catch((error) => {
                if (isCurrent()) {
                    setCoverageOutcome({ input: coverageInput, status: "error" });
                    notifyUnlessCancelled(errorTitleRef.current, error);
                }
            });
        return () => controller.abort();
    }, [coverageInput, store]);

    return { coverageResult, coverageStatus, coverageMap, retryCoverage };
}
