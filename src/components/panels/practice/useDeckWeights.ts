import { useEffect, useRef } from "react";
import type { PracticeDeckValue } from "@/state/practiceStorage";
import { applyReachWeights, computeReachWeights, reachWeightsChange } from "@/utils/repertoire";
import type { GameHeaders, TreeNode } from "@/utils/treeReducer";
import type { PracticeStatistics } from "./usePracticeStatistics";
import type { UseDeckSyncResult } from "./useDeckSync";

export type UseDeckWeightsParams = {
    root: TreeNode;
    headers: GameHeaders;
    treeViewDeferred: boolean;
    deck: PracticeDeckValue;
    setDeck: UseDeckSyncResult["setDeck"];
    statistics: PracticeStatistics;
};

export function useDeckWeights({
    root,
    headers,
    treeViewDeferred,
    deck,
    setDeck,
    statistics,
}: UseDeckWeightsParams) {
    const setDeckRef = useRef(setDeck);
    setDeckRef.current = setDeck;

    useEffect(() => {
        if (treeViewDeferred) return;
        if (deck.status !== "ready") return;
        if (statistics.statisticsStatus !== "success" || !statistics.statisticsResult) return;

        const orientation = headers.orientation || "white";
        const startPath = headers.start || [];
        const weights = computeReachWeights(
            root,
            orientation,
            startPath,
            statistics.statisticsResult.dbMovesMap,
        );
        if (!weights) return;

        if (!reachWeightsChange(deck.positions, weights)) return;

        setDeckRef.current((previous) => {
            if (previous.status !== "ready") return previous;
            const updated = applyReachWeights(previous.positions, weights);
            return updated ? { ...previous, positions: updated } : previous;
        });
    }, [
        root,
        headers,
        treeViewDeferred,
        deck.status,
        deck.positions,
        statistics.statisticsStatus,
        statistics.statisticsResult,
    ]);
}
