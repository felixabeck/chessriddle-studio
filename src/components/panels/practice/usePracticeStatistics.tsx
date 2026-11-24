import { useAtomValue } from "jotai";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { CollectionDescriptor, DatabaseHandle } from "@/bindings";
import { notifyUnlessCancelled } from "@/components/files/notifyError";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import { isTreeViewDeferred, useTreeView } from "@/state/deferredTreeView";
import { coverageMinGamesAtom } from "@/state/atoms";
import { useReferenceResolution } from "./useReferenceResolution";
import { isPrefix } from "@/utils/misc";
import { computeTreeCoverage } from "@/utils/repertoire";
import { getBoardState, getMemoizedBoardStateMap } from "@/utils/treeReducer";
import { useTranslation } from "react-i18next";

export type CoverageStatus = "absent" | "loading" | "error" | "success";

export type PracticeStatistics = {
  coverageResult: Awaited<ReturnType<typeof computeTreeCoverage>> | null;
  coverageStatus: CoverageStatus;
  coverageMap: Map<string, number> | undefined;
  retryCoverage: () => void;
  referenceDb: DatabaseHandle | null;
  selectedReference: DatabaseHandle | null;
  selectedReferenceKey: string | null;
  referenceKey: string | null;
  currencyGeneration: CollectionDescriptor["generation"] | undefined;
  currencyStatus: CollectionDescriptor["status"] | undefined;
  currencyError: unknown;
  currencyPending: boolean;
};

export const PracticeStatisticsContext = createContext<PracticeStatistics | null>(null);

export function usePracticeStatisticsContext(): PracticeStatistics | null {
  return useContext(PracticeStatisticsContext);
}

export function usePracticeStatistics(): PracticeStatistics {
  const { t } = useTranslation();
  const errorTitle = t("Common.Error");
  const errorTitleRef = useRef(errorTitle);
  errorTitleRef.current = errorTitle;

  const store = useContext(TreeStateContext)!;
  const { root, headers } = useTreeView(store);

  const {
    selectedReference,
    selectedReferenceKey,
    referenceDb,
    referenceKey,
    currencyGeneration,
    currencyStatus,
    currencyError,
    currencyPending,
  } = useReferenceResolution();
  useEffect(() => {
    if (currencyError) notifyUnlessCancelled(errorTitleRef.current, currencyError);
  }, [currencyError]);

  const minGames = useAtomValue(coverageMinGamesAtom);
  const orientation = useMemo(() => headers.orientation || "white", [headers.orientation]);
  const startPath = useMemo(() => headers.start || [], [headers.start]);
  const boardStateMap = useMemo(() => {
    if (isTreeViewDeferred(store)) return {};
    return getMemoizedBoardStateMap(root, startPath);
  }, [root, startPath, store]);
  const startStateMoves = useMemo(() => {
    const movesMap = new Map<string, Map<string, string>>();
    for (const [fen, entries] of Object.entries(boardStateMap)) {
      const perFenMap = new Map<string, string>();
      for (const { node, path } of entries) {
        if (isPrefix(startPath, path)) {
          for (const child of node.children) {
            if (child.san) {
              perFenMap.set(child.san, getBoardState(child.fen));
            }
          }
        }
      }
      if (perFenMap.size > 0) {
        movesMap.set(fen, perFenMap);
      }
    }
    return movesMap;
  }, [boardStateMap, startPath]);

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
    // fetchTreeStatistics walks the whole tree before its first await. That stays off this commit.
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

  return {
    coverageResult,
    coverageStatus,
    coverageMap,
    retryCoverage,
    referenceDb,
    selectedReference,
    selectedReferenceKey,
    referenceKey,
    currencyGeneration,
    currencyStatus,
    currencyError,
    currencyPending,
  };
}

export function PracticeStatisticsProvider({ children }: { children: ReactNode }) {
  const value = usePracticeStatistics();
  return (
    <PracticeStatisticsContext.Provider value={value}>
      {children}
    </PracticeStatisticsContext.Provider>
  );
}
