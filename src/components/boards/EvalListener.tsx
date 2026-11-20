import { useTabAtom, useOwnerTabId } from "@/state/tabScope";
import { tauriSubscriptions } from "@/platform/tauri";
import { errorUnlessCancelled } from "@/platform/errors";
import equal from "fast-deep-equal";
import { getDefaultStore, useAtom, useAtomValue } from "jotai";
import {
  startTransition,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
} from "react";
import { useTranslation } from "react-i18next";
import { match } from "ts-pattern";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type { BestMovesPayload, EngineOptions, GoMode } from "@/bindings";
import { notifyListenerError, notifyUnlessCancelled } from "@/components/files/notifyError";
import {
  activeTabAtom,
  closingTabsAtom,
  threatFamily,
  engineMovesFamily,
  engineTerminalFamily,
  engineRetryFamily,
  engineProgressFamily,
  enginesAtom,
  tabEngineSettingsFamily,
  tabsAtom,
} from "@/state/atoms";
import { getVariationLine } from "@/utils/chess";
import { getBestMoves as chessdbGetBestMoves } from "@/utils/chessdb/api";
import { analysisSearch } from "@/utils/analysisSearch";
import { AnalysisLineMemory } from "@/utils/analysisLineMemory";
import {
  engineIdentity,
  engineLineContext,
} from "@/components/panels/analysis/analysisLineContext";
import { createLiveEngineScoreAtom } from "@/components/panels/analysis/useDisplayedEngineLines";
import { normalizeEngineOptions } from "@/components/engines/engineOptions";
import {
  type Engine,
  type LocalEngine,
  getBestMoves as localGetBestMoves,
  prepareEngineSearch,
  releaseEngineSearch,
  stopEngine,
} from "@/utils/engines";
import { getBestMoves as lichessGetBestMoves } from "@/utils/lichess/api";
import { useTauriListener } from "@/platform/useTauriListener";
import { TreeStateContext } from "../common/TreeStateContext";

type SearchAttempt = {
  fingerprint: string;
  engineIdentity: string;
  tab: string;
  nativeOwner: NativeSearchOwner | null;
  predecessorOwner: NativeSearchOwner | null;
  cancelled: boolean;
  hasLines: boolean;
  failed: boolean;
  dispatched: boolean;
};

type NativeSearchOwner = {
  engine: LocalEngine;
  tab: string;
  generation: string;
  stopPromise: Promise<boolean> | null;
  releasePromise: Promise<void> | null;
};

function stopNativeOwner(
  owner: NativeSearchOwner,
  onError: (error: unknown) => void,
): Promise<boolean> {
  owner.stopPromise ??= stopEngine(owner.engine, owner.tab, owner.generation).catch((error) => {
    // O1 guarantees the failed stop left no actor serving this generation.
    // Memoize a terminal non-retained outcome so it cannot poison successors.
    onError(error);
    return false;
  });
  return owner.stopPromise;
}

function releaseNativeOwner(
  owner: NativeSearchOwner,
  onError: (error: unknown) => void,
): Promise<void> {
  owner.releasePromise ??= releaseEngineSearch(owner.engine, owner.tab, owner.generation).catch(
    (error) => {
      onError(error);
    },
  );
  return owner.releasePromise;
}

function EvalListener() {
  const [engines] = useAtom(enginesAtom);
  const threat = useAtomValue(useTabAtom(threatFamily));
  const store = useContext(TreeStateContext)!;
  const fen = useStore(store, (s) => s.root.fen);

  const moves = useStore(
    store,
    useShallow((s) => getVariationLine(s.root, s.position)),
  );

  const { position, searchingFen, searchingMoves, key } = useMemo(
    () => analysisSearch(fen, moves, threat),
    [fen, moves, threat],
  );
  const isGameOver = position?.isEnd() ?? false;

  const tabId = useOwnerTabId();
  // The one writer of the node's engine score. It follows the engines' live score for this
  // position, so the score belongs to the first engine in list order that has lines, whatever
  // its type, and changes hands when that engine is reordered, disabled or outpaced. The write
  // is bound to the position the score was read for, never to when the effect happens to run.
  const liveScore = useAtomValue(
    useMemo(() => createLiveEngineScoreAtom(tabId, fen, moves), [tabId, fen, moves]),
  ).source?.score;
  useEffect(() => {
    if (!liveScore) return;
    const state = store.getState();
    if (state.root.fen !== fen || !equal(getVariationLine(state.root, state.position), moves))
      return;
    if (equal(state.currentNode().engineScore, liveScore)) return;
    state.setEngineScore(liveScore);
  }, [liveScore, store, fen, moves]);

  return (engines ?? [])
    .filter((e) => e.loaded)
    .map((e) => (
      <EngineListener
        key={e.id}
        engine={e}
        isGameOver={isGameOver}
        searchingFen={searchingFen}
        searchingMoves={searchingMoves}
        searchedKey={key}
      />
    ));
}

function EngineListener({
  engine,
  isGameOver,
  searchingFen,
  searchingMoves,
  searchedKey,
}: {
  engine: Engine;
  isGameOver: boolean;
  searchingFen: string | null;
  searchingMoves: string[] | null;
  searchedKey: string | null;
}) {
  const { t } = useTranslation();
  const ownerTabId = useOwnerTabId();

  const [, setProgress] = useAtom(engineProgressFamily({ engine: engine.id, tab: ownerTabId }));

  const [, setEngineVariation] = useAtom(engineMovesFamily({ engine: engine.id, tab: ownerTabId }));
  const [, setTerminal] = useAtom(engineTerminalFamily({ engine: engine.id, tab: ownerTabId }));
  const [retry, setRetry] = useAtom(engineRetryFamily({ engine: engine.id, tab: ownerTabId }));
  const [settings] = useAtom(
    tabEngineSettingsFamily({
      engineId: engine.id,
      defaultSettings: engine.settings ?? undefined,
      defaultGo: engine.go ?? undefined,
      tab: ownerTabId,
    }),
  );
  const settingsFingerprint = JSON.stringify(settings);
  const lineContext = engineLineContext(settings, engine);
  const activeAttempt = useRef<SearchAttempt | null>(null);
  // A preparation does not yet own the previous warm actor. Retain its exact
  // owner until a later stop confirms which search the actor actually served.
  const retainedOwner = useRef<NativeSearchOwner | null>(null);
  const transitionRunning = useRef(false);
  const pendingTransition = useRef<(() => Promise<void>) | null>(null);
  const translation = useRef(t);
  translation.current = t;
  const notifyFailure = useCallback(
    (error: unknown) => notifyUnlessCancelled(translation.current("Common.Error"), error),
    [],
  );
  const [closeRevision, advanceCloseRevision] = useReducer((revision: number) => revision + 1, 0);
  const mounted = useRef(false);
  const enabled = useRef(settings.enabled);
  const gameOver = useRef(isGameOver);
  enabled.current = settings.enabled;
  gameOver.current = isGameOver;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      setTerminal(null);
      setRetry(0);
      const attempt = activeAttempt.current;
      for (const owner of new Set([
        attempt?.nativeOwner,
        attempt?.predecessorOwner,
        retainedOwner.current,
      ])) {
        if (!owner) continue;
        void releaseNativeOwner(owner, notifyFailure);
      }
    };
  }, [notifyFailure, setTerminal, setRetry]);
  useEffect(() => {
    const jotaiStore = getDefaultStore();
    const tab = ownerTabId;
    let wasClosing = jotaiStore.get(closingTabsAtom).has(tab);
    return jotaiStore.sub(closingTabsAtom, () => {
      const isClosing = jotaiStore.get(closingTabsAtom).has(tab);
      if (isClosing && !wasClosing) {
        const attempt = activeAttempt.current;
        if (attempt?.tab === tab) attempt.cancelled = true;
        setProgress(0);
        setTerminal(null);
      } else if (!isClosing && wasClosing) {
        advanceCloseRevision();
      }
      wasClosing = isClosing;
    });
  }, [ownerTabId, setProgress, setTerminal]);
  const requestFingerprint = JSON.stringify({
    tab: ownerTabId,
    closeRevision,
    fen: searchingFen,
    moves: searchingMoves,
    settings: settingsFingerprint,
    engine: engineIdentity(engine),
    searchedKey,
    retry,
  });
  const currentFingerprint = useRef(requestFingerprint);
  currentFingerprint.current = requestFingerprint;
  const isCurrentAttempt = useCallback((attempt: SearchAttempt) => {
    const jotaiStore = getDefaultStore();
    return (
      mounted.current &&
      activeAttempt.current === attempt &&
      !attempt.cancelled &&
      !attempt.failed &&
      currentFingerprint.current === attempt.fingerprint &&
      enabled.current &&
      !gameOver.current &&
      !jotaiStore.get(closingTabsAtom).has(attempt.tab) &&
      jotaiStore.get(tabsAtom).some((candidate) => candidate.value === attempt.tab) &&
      // Read the engine list itself rather than trusting this component's
      // mount: an engine unloaded while its search was pending is committed
      // to the store before the passive unmount cleanup clears `mounted`.
      (jotaiStore.get(enginesAtom) ?? []).some(
        (candidate) => candidate.loaded && engineIdentity(candidate) === attempt.engineIdentity,
      )
    );
  }, []);
  const onBestMoves = useCallback(
    ({ payload }: { payload: BestMovesPayload }) => {
      const ev = payload.bestLines;
      if (
        searchedKey !== null &&
        payload.engine === engine.id &&
        payload.tab === ownerTabId &&
        payload.fen === searchingFen &&
        equal(payload.moves, searchingMoves) &&
        activeAttempt.current?.nativeOwner?.generation === payload.generation &&
        activeAttempt.current !== null &&
        isCurrentAttempt(activeAttempt.current) &&
        ev.length > 0 &&
        ev.every(
          (line) =>
            line && line.score && Array.isArray(line.uciMoves) && Array.isArray(line.sanMoves),
        )
      ) {
        const attempt = activeAttempt.current;
        attempt.hasLines = true;
        setTerminal(null);
        startTransition(() => {
          setEngineVariation((prev) => {
            const newMap = new AnalysisLineMemory(prev);
            newMap.remember(searchedKey, ev, attempt);
            return newMap;
          });
          setProgress(payload.progress);
        });
      }
    },
    [
      ownerTabId,
      searchingFen,
      searchingMoves,
      engine.id,
      setEngineVariation,
      setTerminal,
      setProgress,
      searchedKey,
      isCurrentAttempt,
    ],
  );
  const subscribeBestMoves = useCallback(
    (listener: (event: { payload: BestMovesPayload }) => void) =>
      tauriSubscriptions.bestMoves(listener),
    [],
  );
  useTauriListener(subscribeBestMoves, onBestMoves, { onError: notifyListenerError });

  const getBestMoves = useMemo(
    () =>
      match(engine.type)
        .with(
          "local",
          () => (tab: string, goMode: GoMode, options: EngineOptions, generation: string) =>
            localGetBestMoves(engine as LocalEngine, tab, goMode, options, generation),
        )
        .with(
          "chessdb",
          () => (tab: string, goMode: GoMode, options: EngineOptions) =>
            chessdbGetBestMoves(tab, goMode, options),
        )
        .with(
          "lichess",
          () => (tab: string, goMode: GoMode, options: EngineOptions) =>
            lichessGetBestMoves(tab, goMode, options),
        )
        .exhaustive(),
    [engine],
  );

  useEffect(() => {
    const previous = activeAttempt.current;
    if (previous?.fingerprint === requestFingerprint && !previous.cancelled) return;
    if (previous) previous.cancelled = true;
    const attempt: SearchAttempt = {
      fingerprint: requestFingerprint,
      engineIdentity: engineIdentity(engine),
      tab: ownerTabId,
      nativeOwner: null,
      predecessorOwner: previous?.nativeOwner ?? previous?.predecessorOwner ?? null,
      cancelled: false,
      hasLines: false,
      failed: false,
      dispatched: false,
    };
    activeAttempt.current = attempt;
    setTerminal(null);
    if (
      !settings.enabled ||
      previous?.tab !== ownerTabId ||
      previous?.engineIdentity !== attempt.engineIdentity
    ) {
      for (const owner of new Set([attempt.predecessorOwner, retainedOwner.current])) {
        if (!owner) continue;
        void releaseNativeOwner(owner, notifyFailure);
      }
    }
    setEngineVariation((prev) => {
      const memory = new AnalysisLineMemory(prev);
      if (memory.context !== lineContext) {
        const empty = new AnalysisLineMemory();
        empty.context = lineContext;
        return empty;
      }
      return memory;
    });
    setProgress(0);
  }, [
    ownerTabId,
    engine,
    requestFingerprint,
    setEngineVariation,
    setTerminal,
    setProgress,
    settings.enabled,
    settingsFingerprint,
    lineContext,
    notifyFailure,
  ]);

  useEffect(() => {
    const attempt = activeAttempt.current;
    if (!attempt || attempt.fingerprint !== requestFingerprint || attempt.dispatched) return;
    attempt.dispatched = true;
    const terminalIdentity = (key: string) => ({
      searchedKey: key,
      context: lineContext,
      fingerprint: attempt.fingerprint,
      engineIdentity: attempt.engineIdentity,
      generation: attempt.nativeOwner?.generation ?? null,
      retry,
    });
    const finishWithoutLines = (
      type: "completed-without-lines" | "not-in-database" = "completed-without-lines",
    ) => {
      if (searchedKey !== null && isCurrentAttempt(attempt) && !attempt.hasLines) {
        setTerminal({ ...terminalIdentity(searchedKey), type });
        if (engine.type !== "local") setProgress(100);
      }
    };
    const failAttempt = (error: unknown) => {
      if (searchedKey === null || !isCurrentAttempt(attempt)) return;
      const failure = errorUnlessCancelled(error);
      if (!failure || failure.category === "cancelled") return;
      attempt.failed = true;
      setTerminal({
        ...terminalIdentity(searchedKey),
        type: "failed",
        snapshot: failure.engineFailure,
        message: failure.message,
        cleanupFailed: failure.backendCategory === "operation-and-cleanup",
      });
      setProgress(0);
      notifyUnlessCancelled(t("Common.Error"), error);
    };
    const runSearch = async () => {
      // A local engine has one native search slot per tab.  Cancelling it on
      // every identity change gives FEN/settings/go-mode changes a real
      // cancellation boundary instead of merely hiding stale UI results.
      if (attempt.predecessorOwner) {
        if (attempt.predecessorOwner.releasePromise) {
          await attempt.predecessorOwner.releasePromise;
        } else if (await stopNativeOwner(attempt.predecessorOwner, notifyFailure)) {
          retainedOwner.current = attempt.predecessorOwner;
        }
        attempt.predecessorOwner = null;
      }
      // Absence is a lifecycle boundary too. Retire the predecessor above,
      // without reserving a generation or submitting a local or remote request.
      if (searchingFen === null || searchingMoves === null || searchedKey === null) return;
      if (engine.type === "local") {
        if (!isCurrentAttempt(attempt)) return;
        let nativeGeneration: string;
        try {
          nativeGeneration = await prepareEngineSearch(engine, ownerTabId);
        } catch (error) {
          failAttempt(error);
          return;
        }
        if (!isCurrentAttempt(attempt)) {
          try {
            const jotaiStore = getDefaultStore();
            const ownerDisappeared =
              !mounted.current ||
              !enabled.current ||
              jotaiStore.get(activeTabAtom) !== ownerTabId ||
              !(jotaiStore.get(enginesAtom) ?? []).some(
                (candidate) =>
                  candidate.loaded && engineIdentity(candidate) === attempt.engineIdentity,
              );
            if (ownerDisappeared) await releaseEngineSearch(engine, ownerTabId, nativeGeneration);
            else await stopEngine(engine, ownerTabId, nativeGeneration);
          } catch (error) {
            notifyUnlessCancelled(t("Common.Error"), error);
          }
          return;
        }
        attempt.nativeOwner = {
          engine,
          tab: ownerTabId,
          generation: nativeGeneration,
          stopPromise: null,
          releasePromise: null,
        };
      }
      if (!isCurrentAttempt(attempt)) return;

      const options = normalizeEngineOptions(settings.settings ?? []);
      // The command lives for the whole search. Only stop and preparation
      // occupy the transition slot; new navigation must be able to stop it.
      void getBestMoves(
        ownerTabId,
        settings.go,
        { moves: searchingMoves, fen: searchingFen, extraOptions: options },
        attempt.nativeOwner?.generation ?? "",
      )
        .then((result) => {
          if (result && !Array.isArray(result)) {
            finishWithoutLines(result.type);
            return;
          }
          if (
            isCurrentAttempt(attempt) &&
            result &&
            result[1].length > 0 &&
            result[1].every((line) => line && line.score && Array.isArray(line.uciMoves))
          ) {
            const [progress, bestMoves] = result;
            attempt.hasLines = true;
            setTerminal(null);
            setEngineVariation((prev) => {
              const newMap = new AnalysisLineMemory(prev);
              newMap.remember(searchedKey, bestMoves, attempt);
              return newMap;
            });
            setProgress(progress);
          }
          finishWithoutLines();
        })
        .catch(failAttempt);
    };
    // Each queued transition handles terminal failures for its own captured attempt.
    pendingTransition.current = () => runSearch().catch(failAttempt);
    if (transitionRunning.current) return;
    transitionRunning.current = true;
    const drain = async () => {
      try {
        while (pendingTransition.current) {
          const next = pendingTransition.current;
          pendingTransition.current = null;
          await next();
        }
      } finally {
        transitionRunning.current = false;
      }
    };
    void drain();
  }, [
    settings.enabled,
    settingsFingerprint,
    settings.go,
    settings.settings,
    searchingFen,
    searchingMoves,
    isGameOver,
    ownerTabId,
    getBestMoves,
    setEngineVariation,
    setTerminal,
    setProgress,
    engine,
    requestFingerprint,
    isCurrentAttempt,
    t,
    notifyFailure,
    searchedKey,
    lineContext,
    retry,
  ]);
  return null;
}

export default EvalListener;
