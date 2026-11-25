import { notifications } from "@mantine/notifications";
import { useAtom, useAtomValue, useSetAtom, useStore } from "jotai";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { warnSafely } from "@/platform/errors";
import { getFileFreshness, subscribeFileFreshness } from "@/state/fileFreshness";
import { tabStorage } from "@/state/store/tabStorage";
import { getTabTreeKey } from "@/state/workspaceTypes";
import { useTabCommands } from "@/components/tabs/TabCommands";
import {
  activeTabAtom,
  practiceRunRequestFamily,
  practiceRunSummaryFamily,
  practiceSegmentGateFamily,
  practiceSessionEndAtom,
  practiceTabFamily,
  tabFamily,
  tabsAtom,
  timedRunAtom,
  timedRunLaunchAtom,
  type PracticeSessionEndReport,
  type TimedRun,
  type TimedRunSegment,
} from "@/state/atoms";
import { getCachedTreeStore } from "@/state/store/tree";
import { openFile } from "@/utils/openFile";
import { findChapterTab, type SetTabs, type Tab } from "@/utils/tabs";
import { isAbortError } from "./prepareTimedRun";
import { planNextSegment, removeChapterCandidates, removeSegmentCandidates } from "./runPlanner";

/** PracticePanel publishes the gate only once it mounts. TreeRecoveryGate and
 *  FileFreshnessGate keep it unmounted for an unreadable tree or a blocked file,
 *  which we skip as soon as those surfaces report that state. A still-null gate
 *  is a hydrate or reconcile in progress; 60s is long enough for a slow deck
 *  read and short enough that a stuck panel cannot hang the run. */
export const TIMED_RUN_GATE_WAIT_MS = 60_000;

function abortError(): DOMException {
  return new DOMException("Aborted", "AbortError");
}

function subscribeUntil<T>(
  signal: AbortSignal,
  subscribe: (check: () => void) => () => void,
  read: () => T | undefined,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      cleanup();
      reject(signal.reason ?? abortError());
    };
    const check = () => {
      const value = read();
      if (value === undefined || settled) return;
      cleanup();
      resolve(value);
    };
    const unsubscribe = subscribe(check);
    function cleanup() {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      unsubscribe();
    }
    if (signal.aborted) {
      cleanup();
      reject(signal.reason ?? abortError());
      return;
    }
    signal.addEventListener("abort", onAbort);
    check();
  });
}

function settle<T>(
  promise: Promise<T>,
): Promise<{ status: "fulfilled"; value: T } | { status: "rejected"; reason: unknown }> {
  return promise.then(
    (value) => ({ status: "fulfilled" as const, value }),
    (reason) => ({ status: "rejected" as const, reason }),
  );
}

async function raceLinked<T>(
  parent: AbortSignal,
  starters: readonly ((signal: AbortSignal) => Promise<T>)[],
): Promise<T> {
  const child = new AbortController();
  const onParentAbort = () => child.abort(parent.reason);
  if (parent.aborted) child.abort(parent.reason);
  else parent.addEventListener("abort", onParentAbort);
  const tasks = starters.map((start) => settle(start(child.signal)));
  try {
    const first = await Promise.race(tasks);
    child.abort();
    if (first.status === "rejected") throw first.reason;
    return first.value;
  } finally {
    child.abort();
    parent.removeEventListener("abort", onParentAbort);
  }
}

function driverOwnsRun(
  store: ReturnType<typeof useStore>,
  runId: string,
  generation: number,
  generationRef: { current: number },
  signal: AbortSignal,
): boolean {
  if (generationRef.current !== generation || signal.aborted) return false;
  const current = store.get(timedRunAtom);
  return current?.id === runId && current.phase === "running";
}

function finishRun(
  store: ReturnType<typeof useStore>,
  run: TimedRun,
  phase: "finished" | "cancelled",
) {
  const current = store.get(timedRunAtom);
  if (current?.id !== run.id || current.phase !== "running") return;
  const tabId = run.currentSegment?.tabId ?? run.lastSegmentTabId;
  if (tabId) store.set(practiceRunRequestFamily(tabId), null);
  const answers = run.correct + run.incorrect;
  if (answers > 0 && tabId) {
    store.set(practiceRunSummaryFamily(tabId), {
      positions: answers,
      correct: run.correct,
      incorrect: run.incorrect,
      elapsedMs: Date.now() - run.startedAt,
    });
  }
  store.set(timedRunAtom, { ...run, phase });
  const launch = store.get(timedRunLaunchAtom);
  if (launch?.id === run.id) store.set(timedRunLaunchAtom, null);
}

function cancelInFlightRun(store: ReturnType<typeof useStore>) {
  const current = store.get(timedRunAtom);
  if (current?.phase === "running") finishRun(store, current, "cancelled");
}

export default function TimedRunOwner() {
  const { t } = useTranslation();
  const jotaiStore = useStore();
  const { closeTab, selectTab } = useTabCommands();
  const [, setTabs] = useAtom(tabsAtom);
  const launch = useAtomValue(timedRunLaunchAtom);
  const setLaunch = useSetAtom(timedRunLaunchAtom);
  const setRun = useSetAtom(timedRunAtom);
  const setSessionEnd = useSetAtom(practiceSessionEndAtom);
  const skipMessage = t("Board.Practice.SegmentSkipped");

  const closeTabRef = useRef(closeTab);
  closeTabRef.current = closeTab;
  const selectTabRef = useRef(selectTab);
  selectTabRef.current = selectTab;
  const setTabsRef = useRef(setTabs);
  setTabsRef.current = setTabs;
  const skipMessageRef = useRef(skipMessage);
  skipMessageRef.current = skipMessage;
  const generationRef = useRef(0);

  useEffect(() => {
    return () => {
      generationRef.current += 1;
      cancelInFlightRun(jotaiStore);
    };
  }, [jotaiStore]);

  useEffect(() => {
    if (!launch) return;
    const existing = jotaiStore.get(timedRunAtom);
    if (existing?.id === launch.id) return;

    const generation = ++generationRef.current;
    const controller = new AbortController();
    cancelInFlightRun(jotaiStore);
    setSessionEnd(null);

    const run: TimedRun = {
      id: launch.id,
      deadline: launch.deadline,
      startedAt: launch.startedAt,
      newTabId: launch.newTabId,
      candidates: launch.candidates,
      chapters: launch.chapters,
      presentedCount: 0,
      correct: 0,
      incorrect: 0,
      currentSegment: null,
      previous: null,
      openedTabIds: [],
      lastSegmentTabId: null,
      phase: "running",
    };
    setRun(run);

    void driveRun({
      initial: run,
      store: jotaiStore,
      signal: controller.signal,
      generation,
      generationRef,
      setSessionEnd,
      setTabs: setTabsRef,
      selectTab: selectTabRef,
      closeTab: closeTabRef,
      skipMessage: skipMessageRef,
    });

    return () => {
      controller.abort();
    };
  }, [jotaiStore, launch, setLaunch, setRun, setSessionEnd]);

  return null;
}

async function driveRun(options: {
  initial: TimedRun;
  store: ReturnType<typeof useStore>;
  signal: AbortSignal;
  generation: number;
  generationRef: { current: number };
  setSessionEnd: (report: PracticeSessionEndReport | null) => void;
  setTabs: { current: SetTabs };
  selectTab: { current: (tabId: string) => void };
  closeTab: { current: (tabId: string | null, discard?: boolean) => Promise<void> };
  skipMessage: { current: string };
}) {
  let run = options.initial;
  const owns = () =>
    driverOwnsRun(options.store, run.id, options.generation, options.generationRef, options.signal);

  const publish = (next: TimedRun) => {
    if (!owns()) return;
    run = next;
    options.store.set(timedRunAtom, next);
  };

  const skipChapter = (file: string, game: number) => {
    if (!owns()) return;
    notifications.show({ color: "warning", message: options.skipMessage.current });
    const openedTab = run.currentSegment?.tabId
      ? {
          tabId: run.currentSegment.tabId,
          openedByRun: run.openedTabIds.includes(run.currentSegment.tabId),
        }
      : run.previous;
    publish({
      ...run,
      candidates: removeChapterCandidates(run.candidates, file, game),
      currentSegment: null,
      previous: openedTab,
      lastSegmentTabId: run.currentSegment?.tabId ?? run.lastSegmentTabId,
    });
  };

  try {
    let first = true;
    while (owns()) {
      const remainingSeconds = (run.deadline - Date.now()) / 1000;
      const plan = planNextSegment(
        run.candidates,
        remainingSeconds,
        run.presentedCount,
        Date.now() - run.startedAt,
      );
      if (!plan) {
        finishRun(options.store, run, "finished");
        return;
      }
      const chapter = run.chapters.find(
        (entry) => entry.file === plan.file && entry.game === plan.game,
      );
      const segment: TimedRunSegment = {
        id: crypto.randomUUID(),
        file: plan.file,
        game: plan.game,
        positionKeys: plan.positionKeys,
        tabId: null,
        status: "opening",
      };
      publish({ ...run, currentSegment: segment });

      const step = new AbortController();
      const onRunAbort = () => step.abort(options.signal.reason);
      if (options.signal.aborted) step.abort(options.signal.reason);
      else options.signal.addEventListener("abort", onRunAbort);
      try {
        const existing = chapter
          ? findChapterTab(options.store.get(tabsAtom), plan.file, plan.game)
          : undefined;
        const origin = options.store.get(activeTabAtom);
        const target = existing?.value;
        const present = new Set(options.store.get(tabsAtom).map((tab) => tab.value));
        type OpenOutcome =
          | { kind: "opened"; tabId: string; openedByRun: boolean }
          | { kind: "missing" }
          | { kind: "left" };
        const outcome = await raceLinked<OpenOutcome>(step.signal, [
          async (signal) => {
            const opened = await openSegment({
              run,
              segment,
              chapter,
              existing,
              first,
              store: options.store,
              signal,
              owns,
              setTabs: options.setTabs.current,
              selectTab: options.selectTab.current,
            });
            return opened ? { kind: "opened", ...opened } : { kind: "missing" };
          },
          (signal) =>
            watchOpenLeave(options.store, origin, target, present, signal).then(() => ({
              kind: "left" as const,
            })),
        ]);
        if (outcome.kind === "left") throw abortError();
        if (outcome.kind === "missing") {
          if (step.signal.aborted || options.signal.aborted) throw abortError();
          skipChapter(plan.file, plan.game);
          continue;
        }
        first = false;

        const openedByRun = outcome.openedByRun || run.openedTabIds.includes(outcome.tabId);
        const openedTabIds = openedByRun
          ? run.openedTabIds.includes(outcome.tabId)
            ? run.openedTabIds
            : [...run.openedTabIds, outcome.tabId]
          : run.openedTabIds;
        const active: TimedRunSegment = {
          ...segment,
          tabId: outcome.tabId,
          status: "waiting",
        };
        const previous = run.previous;
        if (!owns() || step.signal.aborted) throw abortError();
        publish({
          ...run,
          currentSegment: active,
          previous,
          openedTabIds,
          lastSegmentTabId: outcome.tabId,
        });
        await closePreviousIfOwned(
          options.store,
          previous,
          outcome.tabId,
          options.closeTab.current,
          step.signal,
          owns,
        );
        if (step.signal.aborted || !owns()) throw abortError();

        type GateOutcome = "ready" | "skip" | "left";
        const gate = await raceLinked<GateOutcome>(step.signal, [
          (signal) => waitForGate(options.store, outcome.tabId, signal),
          (signal) => waitForBlockedSurface(options.store, outcome.tabId, signal),
          (signal) => waitGateTimeout(signal),
          (signal) => watchLeave(options.store, outcome.tabId, signal),
        ]);
        if (gate === "left") throw abortError();
        if (gate === "skip") {
          skipChapter(plan.file, plan.game);
          continue;
        }

        if (!owns() || step.signal.aborted) throw abortError();
        publish({ ...run, currentSegment: { ...active, status: "active" } });
        options.setSessionEnd(null);
        options.store.set(practiceRunRequestFamily(outcome.tabId), {
          runId: run.id,
          segmentId: segment.id,
          positionKeys: plan.positionKeys,
          deadline: run.deadline,
        });
        const ended = await raceLinked<PracticeSessionEndReport | "left">(step.signal, [
          (signal) => waitForSessionEnd(options.store, run.id, segment.id, signal),
          (signal) => watchLeave(options.store, outcome.tabId, signal),
        ]);
        if (!owns()) return;
        options.store.set(practiceRunRequestFamily(outcome.tabId), null);
        if (ended === "left") throw abortError();
        const report = ended;

        const presented = report.correct + report.incorrect;
        const nextCandidates =
          report.reason === "queue-exhausted" || report.reason === "deadline"
            ? removeSegmentCandidates(run.candidates, plan)
            : run.candidates;
        const nextRun: TimedRun = {
          ...run,
          candidates: nextCandidates,
          presentedCount: run.presentedCount + presented,
          correct: run.correct + report.correct,
          incorrect: run.incorrect + report.incorrect,
          currentSegment: { ...active, status: "active" },
          previous: { tabId: outcome.tabId, openedByRun },
          openedTabIds,
          lastSegmentTabId: outcome.tabId,
        };
        if (report.reason === "queue-exhausted") {
          publish(nextRun);
          continue;
        }
        finishRun(options.store, nextRun, report.reason === "deadline" ? "finished" : "cancelled");
        return;
      } catch (error) {
        if (isAbortError(error) || options.signal.aborted || step.signal.aborted) throw error;
        warnSafely(
          `Timed run ${run.id} skipped ${plan.file}:${plan.game}: ${error instanceof Error ? error.message : String(error)}`,
        );
        skipChapter(plan.file, plan.game);
      } finally {
        step.abort();
        options.signal.removeEventListener("abort", onRunAbort);
      }
    }
    if (owns()) finishRun(options.store, run, "cancelled");
  } catch (error) {
    if (!isAbortError(error) && !options.signal.aborted) {
      warnSafely(`Timed run failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (owns()) finishRun(options.store, run, "cancelled");
  }
}

async function openSegment(options: {
  run: TimedRun;
  segment: TimedRunSegment;
  chapter: TimedRun["chapters"][number] | undefined;
  existing: Tab | undefined;
  first: boolean;
  store: ReturnType<typeof useStore>;
  signal: AbortSignal;
  owns: () => boolean;
  setTabs: SetTabs;
  selectTab: (tabId: string) => void;
}): Promise<{ tabId: string; openedByRun: boolean } | null> {
  if (options.signal.aborted || !options.owns() || !options.chapter) return null;
  if (options.existing) {
    options.store.set(tabFamily(options.existing.value), "practice");
    options.store.set(practiceTabFamily(options.existing.value), "train");
    options.selectTab(options.existing.value);
    return {
      tabId: options.existing.value,
      openedByRun: options.run.openedTabIds.includes(options.existing.value),
    };
  }
  const tabId = await openFile(options.chapter.metadata, options.setTabs, {
    gameNumber: options.segment.game,
    ownerId: options.first ? options.run.newTabId : undefined,
    panel: "practice",
    store: options.store,
    signal: options.signal,
  });
  if (options.signal.aborted || !options.owns() || !tabId) return null;
  options.store.set(tabFamily(tabId), "practice");
  options.store.set(practiceTabFamily(tabId), "train");
  options.selectTab(tabId);
  return { tabId, openedByRun: true };
}

const CLOSE_BLOCKED_TREE_STATUSES = new Set(["not-read", "unreadable", "unavailable"]);

async function closePreviousIfOwned(
  store: ReturnType<typeof useStore>,
  previous: TimedRun["previous"],
  currentTabId: string,
  closeTab: (tabId: string | null, discard?: boolean) => Promise<void>,
  signal: AbortSignal,
  owns: () => boolean,
) {
  if (!previous || !previous.openedByRun || previous.tabId === currentTabId) return;
  const tree = getCachedTreeStore(previous.tabId);
  if (tree?.getState().dirty) return;
  const tab = store.get(tabsAtom).find((entry) => entry.value === previous.tabId);
  const treeKey = tab ? getTabTreeKey(tab) : previous.tabId;
  if (CLOSE_BLOCKED_TREE_STATUSES.has(tabStorage.getStatus(treeKey).kind)) return;
  if (signal.aborted || !owns()) return;
  await closeTab(previous.tabId);
}

function waitForGate(
  store: ReturnType<typeof useStore>,
  tabId: string,
  signal: AbortSignal,
): Promise<"ready" | "skip"> {
  return subscribeUntil(
    signal,
    (check) => store.sub(practiceSegmentGateFamily(tabId), check),
    () => {
      const gate = store.get(practiceSegmentGateFamily(tabId));
      if (!gate) return undefined;
      if (gate.status === "read-failed" || gate.status === "write-blocked") return "skip";
      if (gate.synced && gate.status === "ready") return "ready";
      return undefined;
    },
  );
}

function waitForBlockedSurface(
  store: ReturnType<typeof useStore>,
  tabId: string,
  signal: AbortSignal,
): Promise<"skip"> {
  const tab = store.get(tabsAtom).find((entry) => entry.value === tabId);
  const treeKey = tab ? getTabTreeKey(tab) : tabId;
  return subscribeUntil(
    signal,
    (check) => {
      const unsubs = [
        tabStorage.subscribeStatus(treeKey, check),
        subscribeFileFreshness(tabId, check),
      ];
      return () => unsubs.forEach((unsub) => unsub());
    },
    () => {
      const status = tabStorage.getStatus(treeKey);
      if (status.kind === "unreadable" || status.kind === "unavailable") return "skip";
      const freshness = getFileFreshness(tabId);
      if (freshness.state === "conflict" || freshness.state === "unavailable") return "skip";
      return undefined;
    },
  );
}

function waitGateTimeout(signal: AbortSignal): Promise<"skip"> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? abortError());
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve("skip");
    }, TIMED_RUN_GATE_WAIT_MS);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? abortError());
    };
    signal.addEventListener("abort", onAbort);
  });
}

function waitForSessionEnd(
  store: ReturnType<typeof useStore>,
  runId: string,
  segmentId: string,
  signal: AbortSignal,
): Promise<PracticeSessionEndReport> {
  return subscribeUntil(
    signal,
    (check) => store.sub(practiceSessionEndAtom, check),
    () => {
      const report = store.get(practiceSessionEndAtom);
      if (!report) return undefined;
      if (report.runId !== runId || report.segmentId !== segmentId) return undefined;
      return report;
    },
  );
}

function isRunTabActive(store: ReturnType<typeof useStore>, tabId: string): boolean {
  const tabs = store.get(tabsAtom);
  if (!tabs.some((tab) => tab.value === tabId)) return false;
  if (store.get(activeTabAtom) !== tabId) return false;
  return (
    store.get(tabFamily(tabId)) === "practice" && store.get(practiceTabFamily(tabId)) === "train"
  );
}

function leftDuringOpen(
  store: ReturnType<typeof useStore>,
  origin: string | null,
  target: string | undefined,
  present: ReadonlySet<string>,
): boolean {
  const active = store.get(activeTabAtom);
  if (active === null) return true;
  if (present.has(active) && active !== origin && active !== target) return true;
  if (active !== origin) return false;
  const originTab = store.get(tabsAtom).find((tab) => tab.value === origin);
  if (!originTab || originTab.type === "new") return false;
  return (
    store.get(tabFamily(origin)) !== "practice" || store.get(practiceTabFamily(origin)) !== "train"
  );
}

function watchOpenLeave(
  store: ReturnType<typeof useStore>,
  origin: string | null,
  target: string | undefined,
  present: ReadonlySet<string>,
  signal: AbortSignal,
): Promise<"left"> {
  return subscribeUntil(
    signal,
    (check) => {
      const unsubs = [store.sub(activeTabAtom, check), store.sub(tabsAtom, check)];
      if (origin) {
        unsubs.push(
          store.sub(tabFamily(origin), check),
          store.sub(practiceTabFamily(origin), check),
        );
      }
      return () => unsubs.forEach((unsub) => unsub());
    },
    () => (leftDuringOpen(store, origin, target, present) ? "left" : undefined),
  );
}

function watchLeave(
  store: ReturnType<typeof useStore>,
  tabId: string,
  signal: AbortSignal,
): Promise<"left"> {
  return subscribeUntil(
    signal,
    (check) => {
      const unsubs = [
        store.sub(tabsAtom, check),
        store.sub(activeTabAtom, check),
        store.sub(tabFamily(tabId), check),
        store.sub(practiceTabFamily(tabId), check),
      ];
      return () => unsubs.forEach((unsub) => unsub());
    },
    () => (isRunTabActive(store, tabId) ? undefined : "left"),
  );
}
