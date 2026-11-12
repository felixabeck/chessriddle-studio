import { useTabAtom, useOwnerTab } from "@/state/tabScope";
import {
  Alert,
  Badge,
  Button,
  Card,
  Divider,
  Group,
  Paper,
  Progress,
  SimpleGrid,
  Stack,
  Tabs,
  Text,
  ThemeIcon,
  Tooltip,
} from "@mantine/core";
import { useToggle } from "@mantine/hooks";
import AppModal from "../../common/AppModal";
import { Undo2, ArrowRight, BookOpen, Check, Info, Target, X } from "lucide-react";
import { useAtom, useAtomValue, useSetAtom, useStore as useAtomStore } from "jotai";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { useTranslation } from "react-i18next";
import { formatDate, type ReviewLog } from "ts-fsrs";
import { normalizeError, type AppError } from "@/platform/errors";
import { formatMoveNumber, formatNumber } from "@/utils/format";
import { useStore } from "zustand";
import { useTreeViewDeferred } from "@/state/deferredTreeView";
import ConfirmModal from "@/components/common/ConfirmModal";
import Comment from "@/components/common/Comment";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import { IconAction } from "@/components/common/IconAction";
import {
  buildFromTree,
  formatReviewInterval,
  classifyPracticeAnswer,
  getCardStatus,
  getNextReviewTimes,
  getStats,
  resolvePracticeCard,
  syncDeck,
  updateCardPerformance,
} from "@/components/files/opening";
import {
  activeTabAtom,
  tabsAtom,
  evalOpenFamily,
  invisibleFamily,
  practiceTabFamily,
  showCommentsFamily,
  deckAtomFamily,
  type PracticeSessionStats,
  practiceCardStartTimeFamily,
  practiceCompletedSummaryFamily,
  practiceMoveControllerFamily,
  practiceSessionStatsFamily,
  practiceStateFamily,
  practiceGradingAtom,
  practiceNewPerSessionAtom,
} from "@/state/atoms";
import {
  loadPracticeReviews,
  PRACTICE_LOG_PAGE_SIZE,
  type PracticeDeckValue,
  type PracticeDeckKey,
} from "@/state/practiceStorage";
import { getTabFile, getTabGameNumber } from "@/utils/tabs";
import { fileWorkspaceKey } from "@/utils/pathCapabilities";
import { backgroundHotkeyOptions } from "@/utils/keyboardOwnership";
import { findFen, getBoardState, getNodeAtPath } from "@/utils/treeReducer";
import RepertoireInfo from "./RepertoireInfo";
import { useDueBoundaryRerender } from "./useDueBoundaryRerender";
import { collectRetainedPracticePositions } from "./retainedPositions";
import { useScaledMaxWidth } from "@/hooks/useScaledMaxWidth";
import paneClasses from "@/components/common/PaneTabs.module.css";
import { COMPACT_PANE_TABS_WIDTH_EM } from "@/components/boards/paneTabs";
import {
  advancePracticeQueue,
  buildPracticeQueue,
  buildPracticeReplay,
  getAutomaticPracticeGrade,
  PRACTICE_REPLAY_STEP_MS,
  canSubmitPracticeMove,
  emptyPracticeStats,
  idlePracticeSession,
  practiceSessionReducer,
  type PracticeSession,
} from "./session";

const PRACTICE_ADVANCE_DELAY_MS = 300;
const PRACTICE_START_BUTTON_STYLE = { scrollMarginBlock: "var(--mantine-spacing-xs)" };

function PracticePanel() {
  const { t, i18n } = useTranslation();
  const compactTabs = useScaledMaxWidth(COMPACT_PANE_TABS_WIDTH_EM);

  const store = useContext(TreeStateContext)!;
  const root = useStore(store, (s) => s.root);
  const headers = useStore(store, (s) => s.headers);
  const setPracticePath = useStore(store, (s) => s.setPracticePath);
  const currentFen = useStore(store, (s) => s.currentNode().fen);
  const treeViewDeferred = useTreeViewDeferred(store);

  const [currentTab] = useOwnerTab();
  const atomStore = useAtomStore();
  const activeTab = useAtomValue(activeTabAtom);
  const tabFile = getTabFile(currentTab);
  const [resetModal, toggleResetModal] = useToggle();
  const [repairModal, toggleRepairModal] = useToggle();
  const deckIdentity = {
    file: tabFile ? fileWorkspaceKey(tabFile.handle) : "",
    game: getTabGameNumber(currentTab),
  };

  const [deck, setDeck] = useAtom(deckAtomFamily(deckIdentity));

  const [syncMessage, setSyncMessage] = useState<{
    added: number;
    removed: number;
  } | null>(null);
  const deckPositionsRef = useRef(deck.positions);
  deckPositionsRef.current = deck.positions;
  // The tree and deck scope (orientation, start) last diffed into the deck. A remount renders
  // the atom's previous "ready" snapshot before hydration starts, and a sync diffed from it is
  // dropped while the deck loads, so a new hydration (loading or read-failed) forgets it and the
  // hydrated deck is diffed again. Ratings do not reset it: re-diffing the whole tree after every
  // rating would cost O(tree).
  const lastSyncedRef = useRef<{ root: typeof root; scope: string } | null>(null);
  const syncMessageTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const deckCanWrite = deck.status === "ready";

  useEffect(() => {
    if (deck.status === "loading" || deck.status === "read-failed") {
      lastSyncedRef.current = null;
      return;
    }
    if (treeViewDeferred) return;
    if (deck.status !== "ready" || deckIdentity.file === "") return;

    const orientation = headers.orientation || "white";
    const start = headers.start || [];
    const scope = `${orientation}:${start.join(",")}`;
    const lastSynced = lastSyncedRef.current;
    if (lastSynced?.root === root && lastSynced.scope === scope) return;

    if (deckPositionsRef.current.length === 0) {
      const newDeck = buildFromTree(root, orientation, start);
      if (newDeck.length > 0) setDeck({ type: "sync", positions: newDeck });
    } else {
      // Sync existing deck with tree changes
      const { positions, added, removed, updated, reordered } = syncDeck(
        deckPositionsRef.current,
        root,
        orientation,
        start,
        () =>
          collectRetainedPracticePositions({
            tabs: atomStore.get(tabsAtom),
            currentTabId: currentTab?.value,
            identity: { file: deckIdentity.file, game: deckIdentity.game },
            existing: deckPositionsRef.current,
          }),
      );
      if (added > 0 || removed > 0 || updated > 0 || reordered) {
        setDeck((prev) => ({ ...prev, positions }));
      }
      if (added > 0 || removed > 0) {
        setSyncMessage({ added, removed });
        if (syncMessageTimerRef.current) clearTimeout(syncMessageTimerRef.current);
        syncMessageTimerRef.current = setTimeout(() => {
          syncMessageTimerRef.current = null;
          setSyncMessage(null);
        }, 5000);
      }
    }
    lastSyncedRef.current = { root, scope };
  }, [
    root,
    headers,
    setDeck,
    deck.status,
    deckIdentity.file,
    deckIdentity.game,
    treeViewDeferred,
    atomStore,
    currentTab?.value,
  ]);

  const stats = getStats(deck.positions);
  useDueBoundaryRerender(
    stats.nextDue,
    JSON.stringify([deckIdentity.file, deckIdentity.game, currentTab?.value]),
  );

  const setInvisible = useSetAtom(useTabAtom(invisibleFamily));
  const setShowComments = useSetAtom(useTabAtom(showCommentsFamily));
  const setEvalOpen = useSetAtom(useTabAtom(evalOpenFamily));
  const [practiceState, setPracticeState] = useAtom(useTabAtom(practiceStateFamily));
  const [, setPracticeMoveController] = useAtom(useTabAtom(practiceMoveControllerFamily));
  const [sessionStats, setSessionStats] = useAtom(useTabAtom(practiceSessionStatsFamily));
  const [completedSummary, setCompletedSummary] = useAtom(
    useTabAtom(practiceCompletedSummaryFamily),
  );
  const setCardStartTime = useSetAtom(useTabAtom(practiceCardStartTimeFamily));
  const practiceGrading = useAtomValue(practiceGradingAtom);
  const newPerSession = useAtomValue(practiceNewPerSessionAtom);
  const sessionRef = useRef<PracticeSession>(idlePracticeSession());
  const sessionStatsRef = useRef(sessionStats);
  sessionStatsRef.current = sessionStats;
  const deckRef = useRef(deck);
  deckRef.current = deck;
  const presentationRef = useRef({ failed: false, learning: false, rated: false, startedAt: 0 });
  const [alternative, setAlternative] = useState(false);
  const navigationTimersRef = useRef(new Set<ReturnType<typeof setTimeout>>());
  const endPracticeSessionRef = useRef<() => void>(() => undefined);

  const clearPracticeTimers = useCallback(() => {
    for (const timer of navigationTimersRef.current) clearTimeout(timer);
    navigationTimersRef.current.clear();
    if (syncMessageTimerRef.current) clearTimeout(syncMessageTimerRef.current);
    syncMessageTimerRef.current = null;
  }, []);

  const setSession = useCallback(
    (next: PracticeSession) => {
      sessionRef.current = next;
      const { token: _token, ...visible } = next;
      setPracticeState(visible);
    },
    [setPracticeState],
  );

  const publishStats = useCallback(
    (next: PracticeSessionStats) => {
      sessionStatsRef.current = next;
      setSessionStats(next);
    },
    [setSessionStats],
  );

  const endPracticeSession = useCallback(() => {
    if (sessionRef.current.phase === "idle") return;
    clearPracticeTimers();
    const summary = sessionStatsRef.current;
    setSession(
      practiceSessionReducer(sessionRef.current, {
        type: "end",
        token: sessionRef.current.token,
      }),
    );
    setPracticePath(null);
    setInvisible(false);
    setShowComments(true);
    setEvalOpen(true);
    setCardStartTime(0);
    setPracticeMoveController(null);
    publishStats(emptyPracticeStats());
    setCompletedSummary(summary.correct + summary.incorrect > 0 ? summary : null);
  }, [
    clearPracticeTimers,
    setSession,
    setPracticePath,
    setInvisible,
    setShowComments,
    setEvalOpen,
    setCardStartTime,
    setPracticeMoveController,
    publishStats,
    setCompletedSummary,
  ]);
  endPracticeSessionRef.current = endPracticeSession;

  useEffect(() => {
    if (practiceState.phase === "idle") setPracticePath(null);
  }, [practiceState.phase, setPracticePath]);

  const scheduleForSession = useCallback((token: number, callback: () => void, delay: number) => {
    const timer = setTimeout(() => {
      navigationTimersRef.current.delete(timer);
      if (sessionRef.current.token === token && sessionRef.current.phase !== "idle") callback();
    }, delay);
    navigationTimersRef.current.add(timer);
    return () => {
      clearTimeout(timer);
      navigationTimersRef.current.delete(timer);
    };
  }, []);

  const rateCard = useCallback(
    (positionKey: string, grade: 1 | 2 | 3 | 4) => {
      // A refused write consumes this presentation's rating too.
      if (presentationRef.current.rated) return;
      presentationRef.current.rated = true;
      const currentDeck = deckRef.current;
      const index = currentDeck.positions.findIndex(
        (position) => getBoardState(position.fen) === positionKey,
      );
      const sourcePosition = currentDeck.positions[index];
      if (
        !sourcePosition ||
        (currentDeck.status !== "ready" && currentDeck.status !== "write-pending")
      )
        return;
      const update = updateCardPerformance(
        currentDeck.positions,
        index,
        sourcePosition.card,
        grade,
      );
      if (!update) return;
      deckRef.current = { ...currentDeck, positions: update.positions, status: "write-pending" };
      void setDeck({ type: "rating", ...update, sourcePosition });
    },
    [setDeck],
  );

  const currentCard = deck.positions.find(
    (position) => getBoardState(position.fen) === practiceState.positionKey,
  );
  const liveCard = resolvePracticeCard(
    root,
    practiceState.positionKey ?? "",
    headers.orientation || "white",
    headers.start || [],
  );
  const answerFrame = liveCard?.frame;
  const answerNode = answerFrame?.node.children[0];
  const answerComment = answerNode?.comment?.trim() || "";
  const manualPrompt =
    practiceState.phase === "correct" &&
    sessionStats.mode === "anki" &&
    !presentationRef.current.failed &&
    !presentationRef.current.learning &&
    practiceGrading === "manual";

  const newPractice = useCallback(
    (transition: "first" | "next" | "restart" = "next") => {
      clearPracticeTimers();
      let latest = sessionStatsRef.current;
      const state = store.getState();
      let resolved: ReturnType<typeof resolvePracticeCard>;
      while (latest.remainingPositionKeys.length > 0) {
        const key = latest.remainingPositionKeys[0];
        resolved = resolvePracticeCard(
          state.root,
          key,
          state.headers.orientation || "white",
          state.headers.start || [],
        );
        if (resolved) break;
        latest = { ...latest, ...advancePracticeQueue(latest, latest.mode) };
      }
      publishStats(latest);
      if (!resolved || latest.remainingPositionKeys.length === 0) {
        endPracticeSession();
        return;
      }
      const key = latest.remainingPositionKeys[0];
      const { frame } = resolved;
      const card = deckRef.current.positions.find(
        (position) => getBoardState(position.fen) === key,
      );
      // A restarted replay still belongs to this presentation, unless its queue entry was dropped.
      const samePresentation = transition === "restart" && key === sessionRef.current.positionKey;
      presentationRef.current = samePresentation
        ? { ...presentationRef.current, startedAt: 0 }
        : {
            failed: false,
            learning:
              latest.mode === "anki" &&
              card?.card.reps === 0 &&
              !latest.introducedPositionKeys.includes(key),
            rated: false,
            startedAt: 0,
          };
      setAlternative(false);
      setInvisible(true);
      setShowComments(false);
      setEvalOpen(false);
      setCardStartTime(0);
      setPracticePath(frame.position);
      const replay = buildPracticeReplay(
        transition === "first" ? null : state.position,
        frame.position,
        state.headers.start || [],
      );
      state.goToMove(replay.startPath);
      const token = sessionRef.current.token + 1;
      setSession(
        practiceSessionReducer(sessionRef.current, {
          type: "replay",
          token,
          fen: frame.node.fen,
          positionKey: key,
        }),
      );

      const step = () => {
        const live = store.getState();
        const liveCard = resolvePracticeCard(
          live.root,
          key,
          live.headers.orientation || "white",
          live.headers.start || [],
        );
        if (!liveCard) {
          publishStats({
            ...sessionStatsRef.current,
            ...advancePracticeQueue(sessionStatsRef.current, latest.mode),
          });
          newPractice();
          return;
        }
        const liveFrame = liveCard.frame;
        // Re-resolve both paths after every delay. Edits may have reordered this branch.
        const next = buildPracticeReplay(
          live.position,
          liveFrame.position,
          live.headers.start || [],
        );
        live.setPracticePath(liveFrame.position);
        if (next.startPath.length !== live.position.length) live.goToMove(next.startPath);
        if (next.steps.length > 0) live.goToMove(next.steps[0]);
        const arrived = store.getState().position;
        if (
          arrived.length === liveFrame.position.length &&
          arrived.every((index, depth) => index === liveFrame.position[depth])
        ) {
          presentationRef.current.startedAt = Date.now();
          setCardStartTime(Date.now());
          setSession(
            practiceSessionReducer(sessionRef.current, {
              type: "replayed",
              token,
              learning: presentationRef.current.learning,
            }),
          );
        } else {
          scheduleForSession(token, step, PRACTICE_REPLAY_STEP_MS);
        }
      };
      if (replay.steps.length === 0) step();
      else scheduleForSession(token, step, PRACTICE_REPLAY_STEP_MS);
    },
    [
      clearPracticeTimers,
      store,
      publishStats,
      endPracticeSession,
      setInvisible,
      setShowComments,
      setEvalOpen,
      setCardStartTime,
      setPracticePath,
      setSession,
      scheduleForSession,
    ],
  );

  const advancePresentation = useCallback(() => {
    const session = sessionRef.current;
    if (session.phase !== "correct" && session.phase !== "advancing") return;
    clearPracticeTimers();
    const latest = sessionStatsRef.current;
    publishStats({
      ...latest,
      ...advancePracticeQueue(
        latest,
        latest.mode,
        presentationRef.current.failed || presentationRef.current.learning,
      ),
    });
    if (session.phase === "correct")
      setSession(practiceSessionReducer(session, { type: "advance", token: session.token }));
    newPractice();
  }, [clearPracticeTimers, publishStats, setSession, newPractice]);

  const submitMove = useCallback(
    (san: string) => {
      const session = sessionRef.current;
      const live = store.getState();
      if (!canSubmitPracticeMove(session, live.currentNode().fen)) return;
      const card = resolvePracticeCard(
        live.root,
        session.positionKey ?? "",
        live.headers.orientation || "white",
        live.headers.start || [],
      );
      if (!card) {
        newPractice();
        return;
      }
      const { frame } = card;
      const classification = classifyPracticeAnswer(card, san, live.root, live.headers.start || []);
      if (
        (session.phase === "learning" || session.phase === "revealed") &&
        classification !== "answer"
      )
        return;
      if (classification === "alternative") {
        setAlternative(true);
        return;
      }
      setAlternative(false);
      const timeTaken = Date.now() - presentationRef.current.startedAt;
      if (classification === "answer") {
        const answerIndex = frame.node.children.findIndex((child) => child.san === card.answer);
        if (answerIndex < 0) return;
        live.goToMove([...frame.position, answerIndex]);
        if (session.phase === "learning") {
          const latest = sessionStatsRef.current;
          publishStats({
            ...latest,
            introducedPositionKeys: [...latest.introducedPositionKeys, session.positionKey!],
          });
          setSession(practiceSessionReducer(session, { type: "learned", token: session.token }));
        } else {
          if (session.phase === "waiting" && !presentationRef.current.failed) {
            const latest = sessionStatsRef.current;
            publishStats({
              ...latest,
              correct: latest.correct + 1,
              streak: latest.streak + 1,
              bestStreak: Math.max(latest.bestStreak, latest.streak + 1),
            });
            if (latest.mode === "anki" && practiceGrading === "auto")
              rateCard(session.positionKey!, getAutomaticPracticeGrade(timeTaken));
          }
          setSession(
            practiceSessionReducer(session, {
              type: "correct",
              token: session.token,
              answer: card.answer,
              timeTaken,
            }),
          );
        }
        return;
      }
      if (session.phase === "waiting") {
        presentationRef.current.failed = true;
        const latest = sessionStatsRef.current;
        publishStats({ ...latest, incorrect: latest.incorrect + 1, streak: 0 });
        if (latest.mode === "anki") rateCard(session.positionKey!, 1);
      }
      setSession(
        practiceSessionReducer(session, {
          type: "wrong",
          token: session.token,
          answer: card.answer,
          playedMove: san,
          timeTaken,
        }),
      );
    },
    [store, newPractice, publishStats, setSession, practiceGrading, rateCard],
  );

  const showMove = useCallback(() => {
    const session = sessionRef.current;
    if (session.phase !== "retry" || !session.answer) return;
    setAlternative(false);
    setSession(
      practiceSessionReducer(session, {
        type: "reveal",
        token: session.token,
        answer: session.answer,
      }),
    );
  }, [setSession]);

  function handleQualityRating(grade: 1 | 2 | 3 | 4) {
    if (!manualPrompt || sessionRef.current.phase !== "correct") return;
    rateCard(sessionRef.current.positionKey!, grade);
    advancePresentation();
  }

  function startSession(mode: PracticeSessionStats["mode"]) {
    if (!deckCanWrite) return;
    setCompletedSummary(null);
    publishStats({
      ...emptyPracticeStats(),
      mode,
      ...buildPracticeQueue(deckRef.current.positions, mode, newPerSession, new Date()),
    });
    newPractice("first");
  }
  const startPractice = () => startSession("anki");
  const startFullPractice = () => startSession("full");

  useEffect(() => {
    if (
      (practiceState.phase !== "correct" && practiceState.phase !== "advancing") ||
      manualPrompt ||
      answerComment
    )
      return;
    const token = sessionRef.current.token;
    return scheduleForSession(token, advancePresentation, PRACTICE_ADVANCE_DELAY_MS);
  }, [practiceState.phase, manualPrompt, answerComment, scheduleForSession, advancePresentation]);

  useEffect(() => {
    if (practiceState.phase === "idle") {
      setPracticeMoveController(null);
      return;
    }
    setPracticeMoveController({
      canMove: canSubmitPracticeMove(sessionRef.current, currentFen),
      hintSan:
        (practiceState.phase === "learning" || practiceState.phase === "revealed") &&
        currentFen === practiceState.currentFen
          ? liveCard?.answer
          : undefined,
      submitMove,
    });
    return () => setPracticeMoveController(null);
  }, [
    currentFen,
    liveCard?.answer,
    practiceState.phase,
    practiceState.currentFen,
    setPracticeMoveController,
    submitMove,
  ]);

  useEffect(() => {
    if (sessionRef.current.phase !== "idle" && activeTab !== currentTab?.value)
      endPracticeSession();
  }, [activeTab, currentTab?.value, endPracticeSession]);
  useEffect(
    () => () => {
      clearPracticeTimers();
      endPracticeSessionRef.current();
    },
    [clearPracticeTimers, deckIdentity.file, deckIdentity.game, currentTab?.treeKey],
  );
  useHotkeys("1", () => handleQualityRating(1), {
    ...backgroundHotkeyOptions,
    enabled: manualPrompt,
  });
  useHotkeys("2", () => handleQualityRating(2), {
    ...backgroundHotkeyOptions,
    enabled: manualPrompt,
  });
  useHotkeys("3", () => handleQualityRating(3), {
    ...backgroundHotkeyOptions,
    enabled: manualPrompt,
  });
  useHotkeys("4", () => handleQualityRating(4), {
    ...backgroundHotkeyOptions,
    enabled: manualPrompt,
  });
  useHotkeys(
    "space",
    () => {
      const phase = sessionRef.current.phase;
      if (phase === "retry") showMove();
      else if (phase === "learning" || phase === "revealed") {
        const state = store.getState();
        const card = resolvePracticeCard(
          state.root,
          sessionRef.current.positionKey ?? "",
          state.headers.orientation || "white",
          state.headers.start || [],
        );
        if (card) submitMove(card.answer);
      } else if (!manualPrompt && answerComment) advancePresentation();
    },
    {
      ...backgroundHotkeyOptions,
      enabled:
        practiceState.phase === "retry" ||
        practiceState.phase === "learning" ||
        practiceState.phase === "revealed" ||
        (!manualPrompt &&
          !!answerComment &&
          (practiceState.phase === "correct" || practiceState.phase === "advancing")),
    },
  );

  const [positionsOpen, setPositionsOpen] = useToggle();
  const [logsOpen, setLogsOpen] = useToggle();
  const [tab, setTab] = useAtom(useTabAtom(practiceTabFamily));
  const displayedSessionStats = completedSummary ?? sessionStats;
  const showPracticeContent =
    deck.status === "ready" || deck.status === "write-pending" || deck.status === "write-blocked";

  useEffect(() => {
    if (tab !== "train" && practiceState.phase !== "idle") endPracticeSession();
  }, [endPracticeSession, practiceState.phase, tab]);

  useEffect(() => {
    if (
      practiceState.phase !== "idle" &&
      (deck.status === "write-blocked" || deck.status === "read-failed")
    )
      endPracticeSession();
  }, [deck.status, practiceState.phase, endPracticeSession]);

  useEffect(() => {
    const session = sessionRef.current;
    if (session.phase === "idle") return;
    if (session.phase === "replaying") {
      newPractice("restart");
      return;
    }
    const card = resolvePracticeCard(
      root,
      session.positionKey ?? "",
      headers.orientation || "white",
      headers.start || [],
    );
    if (!card) {
      const latest = sessionStatsRef.current;
      publishStats({ ...latest, ...advancePracticeQueue(latest, latest.mode) });
      newPractice();
    } else if (
      card.fen !== session.currentFen ||
      (session.answer !== undefined && card.answer !== session.answer)
    ) {
      setSession(
        practiceSessionReducer(session, {
          type: "rebind",
          token: session.token,
          fen: card.fen,
          answer: card.answer,
        }),
      );
      setPracticePath(card.frame.position);
      if (
        session.phase === "learning" ||
        session.phase === "waiting" ||
        session.phase === "retry" ||
        session.phase === "revealed"
      ) {
        store.getState().goToMove(card.frame.position);
      }
    }
  }, [
    root,
    headers.start,
    headers.orientation,
    deck.positions,
    newPractice,
    publishStats,
    setSession,
    setPracticePath,
    store,
  ]);

  return (
    <>
      <Tabs
        h="100%"
        orientation={compactTabs ? "horizontal" : "vertical"}
        placement="right"
        value={tab}
        onChange={(v) => setTab(v!)}
        data-compact={compactTabs || undefined}
        classNames={{
          root: paneClasses.root,
          list: paneClasses.list,
          panel: paneClasses.panel,
          tab: paneClasses.tab,
          tabLabel: paneClasses.label,
        }}
        style={{
          display: "flex",
          minHeight: 0,
          overflow: "hidden",
        }}
      >
        <Tabs.List>
          <Tabs.Tab value="train">{t("Board.Practice.Train")}</Tabs.Tab>
          <Tabs.Tab value="build">{t("Board.Practice.Build")}</Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel
          value="train"
          style={{ flex: 1, minWidth: 0, minHeight: 0, overflowY: "auto", overflowX: "hidden" }}
        >
          <Stack p="sm" gap="md">
            {deck.status === "loading" && (
              <Alert icon={<Info />}>{t("Board.Practice.Loading")}</Alert>
            )}
            {deck.status === "read-failed" && (
              <Alert
                icon={<Info />}
                color="danger"
                title={t("Board.Practice.ReadFailed", { cause: deck.error?.message })}
              >
                <Stack gap="xs">
                  <Group gap="xs">
                    <Button
                      variant="light"
                      color="danger"
                      size="xs"
                      onClick={() => setDeck({ type: "retry" })}
                    >
                      {t("Board.Practice.Retry")}
                    </Button>
                    {deck.repairable !== false && (
                      <Button
                        variant="light"
                        color="danger"
                        size="xs"
                        onClick={() => toggleRepairModal()}
                      >
                        {t("Board.Practice.Repair")}
                      </Button>
                    )}
                  </Group>
                </Stack>
              </Alert>
            )}
            {deck.status === "write-blocked" && (
              <Alert
                icon={<Info />}
                color="danger"
                title={t("Board.Practice.WriteBlocked", { cause: deck.error?.message })}
              />
            )}
            {showPracticeContent && (
              <>
                {stats.total === 0 && (
                  <Alert icon={<Info />}>
                    <Stack gap="xs">
                      <Text fz="sm">{t("Board.Practice.NoPositionForTrain1")}</Text>
                      <Button variant="light" size="xs" onClick={() => setTab("build")}>
                        {t("Board.Practice.GoToBuild")}
                      </Button>
                    </Stack>
                  </Alert>
                )}
                {syncMessage && (
                  <Alert
                    title={t("Board.Practice.DeckSynced")}
                    withCloseButton
                    onClose={() => setSyncMessage(null)}
                  >
                    {syncMessage.added > 0 &&
                      t("Board.Practice.SyncAdded", {
                        count: syncMessage.added ?? 0,
                        number: formatNumber(syncMessage.added ?? 0),
                      })}
                    {syncMessage.added > 0 && syncMessage.removed > 0 && " · "}
                    {syncMessage.removed > 0 &&
                      t("Board.Practice.SyncRemoved", {
                        count: syncMessage.removed ?? 0,
                        number: formatNumber(syncMessage.removed ?? 0),
                      })}
                  </Alert>
                )}
                {deck.unappliedReviews > 0 && !deck.orphansAcknowledged && (
                  <Alert color="warning">
                    <Group justify="space-between" wrap="nowrap">
                      <Text fz="sm">
                        {t("Board.Practice.UnappliedReviews", {
                          count: deck.unappliedReviews,
                        })}
                      </Text>
                      <Button
                        variant="subtle"
                        size="compact-xs"
                        onClick={() => setDeck({ type: "acknowledge" })}
                      >
                        {t("Board.Practice.DismissUnappliedReviews")}
                      </Button>
                    </Group>
                  </Alert>
                )}
                {stats.total > 0 && (
                  <>
                    {practiceState.phase === "idle" ? (
                      <Stack gap="sm">
                        <Text fz="sm" c="dimmed">
                          {t("Board.Practice.Explanation")}
                        </Text>
                        <Stack gap="sm" mt="sm">
                          {deckCanWrite &&
                          stats.due === 0 &&
                          Math.min(stats.unseen, newPerSession) === 0 ? (
                            <Paper p="sm" withBorder>
                              <Stack gap="xs" align="center">
                                <ThemeIcon size="xl" radius="xl" color="success" variant="light">
                                  <Check size={24} />
                                </ThemeIcon>
                                <Text ta="center" fw={500}>
                                  {t("Board.Practice.PracticedAll1")}
                                </Text>
                                <Text ta="center" fz="sm" c="dimmed">
                                  {stats.nextDue &&
                                    t("Board.Practice.NextDue", {
                                      date: new Intl.DateTimeFormat(i18n.language, {
                                        month: "short",
                                        day: "numeric",
                                        hour: "2-digit",
                                        minute: "2-digit",
                                      }).format(stats.nextDue),
                                    })}
                                </Text>
                              </Stack>
                            </Paper>
                          ) : (
                            <Button
                              size="md"
                              variant="light"
                              fullWidth
                              onClick={startPractice}
                              style={PRACTICE_START_BUTTON_STYLE}
                              disabled={!deckCanWrite}
                              leftSection={<Target size={20} />}
                              justify="space-between"
                              rightSection={
                                <Badge size="sm" color="gold">
                                  {stats.due + Math.min(stats.unseen, newPerSession)}
                                </Badge>
                              }
                            >
                              {t("Board.Practice.StartPractice")}
                            </Button>
                          )}
                          <Button
                            size="md"
                            variant="light"
                            color="gray"
                            fullWidth
                            onClick={startFullPractice}
                            style={PRACTICE_START_BUTTON_STYLE}
                            disabled={!deckCanWrite}
                            leftSection={<BookOpen size={20} />}
                            justify="space-between"
                            rightSection={
                              <Badge size="sm" color="gray">
                                {deck.positions.length}
                              </Badge>
                            }
                          >
                            {t("Board.Practice.PracticeFullRepertoire")}
                          </Button>
                        </Stack>

                        <Text fz="xs">
                          {t("Board.Practice.LearnedProgress", {
                            learned: stats.learned,
                            total: stats.total,
                          })}
                        </Text>
                        <Progress.Root size="sm">
                          <Progress.Section value={(stats.learned / stats.total) * 100} />
                        </Progress.Root>
                        <SimpleGrid cols={3} spacing="xs">
                          <Paper p="xs" withBorder radius="sm">
                            <Text fz="xs" c="dimmed">
                              {t("Board.Practice.Due")}
                            </Text>
                            <Text fw={700}>{stats.due}</Text>
                          </Paper>
                          <Paper p="xs" withBorder radius="sm">
                            <Text fz="xs" c="dimmed">
                              {t("Board.Practice.New")}
                            </Text>
                            <Text fw={700}>{stats.unseen}</Text>
                          </Paper>
                          <Paper p="xs" withBorder radius="sm">
                            <Text fz="xs" c="dimmed">
                              {t("Board.Practice.Learned")}
                            </Text>
                            <Text fw={700}>{stats.learned}</Text>
                          </Paper>
                        </SimpleGrid>
                        {displayedSessionStats.correct + displayedSessionStats.incorrect > 0 && (
                          <Text fz="sm">
                            {t("Board.Practice.SessionSummary", {
                              correct: displayedSessionStats.correct,
                              incorrect: displayedSessionStats.incorrect,
                              accuracy: Math.round(
                                (100 * displayedSessionStats.correct) /
                                  (displayedSessionStats.correct + displayedSessionStats.incorrect),
                              ),
                              bestStreak: displayedSessionStats.bestStreak,
                            })}
                          </Text>
                        )}
                      </Stack>
                    ) : (
                      <Group justify="space-between" wrap="nowrap">
                        <Text fz="sm">
                          {t("Board.Practice.SessionLine", {
                            remaining: sessionStats.remainingPositionKeys.length,
                            correct: sessionStats.correct,
                            incorrect: sessionStats.incorrect,
                          })}
                        </Text>
                        <IconAction label={t("Common.Stop")} onClick={endPracticeSession}>
                          <X size={16} />
                        </IconAction>
                      </Group>
                    )}

                    {practiceState.phase === "replaying" && (
                      <Text fz="sm" c="dimmed">
                        {t("Board.Practice.Replaying")}
                      </Text>
                    )}
                    {(practiceState.phase === "waiting" ||
                      practiceState.phase === "retry" ||
                      practiceState.phase === "learning" ||
                      practiceState.phase === "revealed") && (
                      <Paper p="sm" withBorder>
                        <Stack gap="xs">
                          {currentFen !== practiceState.currentFen ? (
                            <>
                              <Text fz="sm">{t("Board.Practice.NotOnPosition")}</Text>
                              <Button
                                variant="light"
                                size="xs"
                                leftSection={<Undo2 size={14} />}
                                onClick={() => {
                                  const state = store.getState();
                                  const card = resolvePracticeCard(
                                    state.root,
                                    sessionRef.current.positionKey ?? "",
                                    state.headers.orientation || "white",
                                    state.headers.start || [],
                                  );
                                  const frame = card?.frame;
                                  if (!frame) {
                                    newPractice();
                                    return;
                                  }
                                  state.goToMove(frame.position);
                                  state.setPracticePath(frame.position);
                                  setInvisible(true);
                                }}
                              >
                                {t("Board.Practice.GoBackToPosition")}
                              </Button>
                            </>
                          ) : (
                            <>
                              {practiceState.phase === "waiting" && (
                                <Text fz="sm">{t("Board.Practice.MakeYourMove")}</Text>
                              )}
                              {practiceState.phase === "retry" && (
                                <Text fz="sm">{t("Board.Practice.TryAgain")}</Text>
                              )}
                              {practiceState.phase === "learning" && (
                                <Text fz="sm">
                                  {t("Board.Practice.LearnMove", {
                                    move: answerFrame
                                      ? formatMoveNumber(answerFrame.node.halfMoves + 1) +
                                        " " +
                                        liveCard?.answer
                                      : liveCard?.answer,
                                  })}
                                </Text>
                              )}
                              {practiceState.phase === "revealed" && (
                                <Text fz="sm">
                                  {t("Board.Practice.PlayRevealedMove", {
                                    move: liveCard?.answer,
                                  })}
                                </Text>
                              )}
                              {alternative && (
                                <Text fz="sm">{t("Board.Practice.Alternative")}</Text>
                              )}
                              {practiceState.phase === "retry" && (
                                <Button variant="light" size="xs" onClick={showMove}>
                                  {t("Board.Practice.ShowMove")}
                                </Button>
                              )}
                            </>
                          )}
                        </Stack>
                      </Paper>
                    )}
                    {manualPrompt && (
                      <QualityRatingPanel
                        onRate={handleQualityRating}
                        card={currentCard?.card}
                        timeTaken={practiceState.timeTaken}
                      />
                    )}
                    {answerComment &&
                      (practiceState.phase === "learning" ||
                        practiceState.phase === "correct" ||
                        practiceState.phase === "advancing") && (
                        <Paper p="sm" withBorder>
                          <Comment comment={answerComment} />
                        </Paper>
                      )}
                    {answerComment &&
                      !manualPrompt &&
                      (practiceState.phase === "correct" ||
                        practiceState.phase === "advancing") && (
                        <Button variant="light" onClick={advancePresentation}>
                          {t("Board.Practice.Continue")}
                        </Button>
                      )}

                    <Divider />

                    <Group gap="xs">
                      <Button variant="subtle" size="xs" onClick={() => setPositionsOpen(true)}>
                        {t("Board.Practice.ShowAll")}
                      </Button>
                      <Button variant="subtle" size="xs" onClick={() => setLogsOpen(true)}>
                        {t("Board.Practice.ShowLogs")}
                      </Button>
                      <Button
                        variant="subtle"
                        size="xs"
                        color="danger"
                        disabled={!deckCanWrite}
                        onClick={() => toggleResetModal()}
                      >
                        {t("Common.Reset")}
                      </Button>
                    </Group>
                  </>
                )}
              </>
            )}
          </Stack>
        </Tabs.Panel>

        <Tabs.Panel value="build" style={{ overflow: "hidden" }}>
          <RepertoireInfo />
        </Tabs.Panel>
      </Tabs>

      <ConfirmModal
        title={t("Board.Practice.Reset.Title")}
        description={t("Board.Practice.Reset.Description", {
          name: tabFile?.name,
        })}
        opened={resetModal}
        onClose={toggleResetModal}
        onConfirm={async () => {
          const cards = buildFromTree(root, headers.orientation || "white", headers.start || []);
          await setDeck({ type: "reset", positions: cards });
          endPracticeSession();
        }}
        confirmLabel={t("Common.Reset")}
      />
      <ConfirmModal
        title={t("Board.Practice.Repair.Title")}
        description={t("Board.Practice.Repair.Description", { name: tabFile?.name })}
        opened={repairModal}
        onClose={toggleRepairModal}
        onConfirm={async () => {
          await setDeck({ type: "repair" });
        }}
        confirmLabel={t("Board.Practice.Repair")}
      />
      {positionsOpen && (
        <PositionsModal open={positionsOpen} setOpen={setPositionsOpen} deck={deck} />
      )}
      <LogsModal
        open={logsOpen}
        setOpen={setLogsOpen}
        identity={deckIdentity}
        generation={deck.generation}
        epoch={deck.epoch}
      />
    </>
  );
}

function QualityRatingPanel({
  onRate,
  card,
  timeTaken,
}: {
  onRate: (grade: 1 | 2 | 3 | 4) => void;
  card?: import("ts-fsrs").Card;
  timeTaken?: number;
}) {
  const { t } = useTranslation();
  const reviewTimes = card ? getNextReviewTimes(card) : null;

  return (
    <Paper p="sm" withBorder>
      <Stack gap="sm" align="center">
        <Group gap="xs">
          <ThemeIcon size="md" color="success" variant="light" radius="xl">
            <Check size={16} />
          </ThemeIcon>
          <Text fw={500} c="success">
            {t("Board.Practice.Correct")}
          </Text>
          {timeTaken !== undefined && (
            <Text fz="xs" c="dimmed">
              ({t("Common.SecondsShort", { value: (timeTaken / 1000).toFixed(1) })})
            </Text>
          )}
        </Group>
        <Text fz="sm" c="dimmed">
          {t("Board.Practice.HowDifficult")}
        </Text>
        <SimpleGrid cols={4} spacing="xs" style={{ width: "100%" }}>
          <Tooltip label={t("Board.Practice.AgainHint")}>
            <Button
              color="danger"
              variant="light"
              size="compact-md"
              onClick={() => onRate(1)}
              style={{ height: "auto", padding: "4px 0" }}
            >
              <Stack gap={0} align="center">
                <Text fz="xs" fw={600}>
                  {t("Board.Practice.Again")}
                </Text>
                <Text fz={10} c="dimmed">
                  {reviewTimes ? formatReviewInterval(reviewTimes[1]) : ""}
                </Text>
              </Stack>
            </Button>
          </Tooltip>
          <Tooltip label={t("Board.Practice.HardHint")}>
            <Button
              color="warning"
              variant="light"
              size="compact-md"
              onClick={() => onRate(2)}
              style={{ height: "auto", padding: "4px 0" }}
            >
              <Stack gap={0} align="center">
                <Text fz="xs" fw={600}>
                  {t("Board.Practice.Hard")}
                </Text>
                <Text fz={10} c="dimmed">
                  {reviewTimes ? formatReviewInterval(reviewTimes[2]) : ""}
                </Text>
              </Stack>
            </Button>
          </Tooltip>
          <Tooltip label={t("Board.Practice.GoodHint")}>
            <Button
              color="gold"
              variant="light"
              size="compact-md"
              onClick={() => onRate(3)}
              style={{ height: "auto", padding: "4px 0" }}
            >
              <Stack gap={0} align="center">
                <Text fz="xs" fw={600}>
                  {t("Board.Practice.Good")}
                </Text>
                <Text fz={10} c="dimmed">
                  {reviewTimes ? formatReviewInterval(reviewTimes[3]) : ""}
                </Text>
              </Stack>
            </Button>
          </Tooltip>
          <Tooltip label={t("Board.Practice.EasyHint")}>
            <Button
              color="success"
              variant="light"
              size="compact-md"
              onClick={() => onRate(4)}
              style={{ height: "auto", padding: "4px 0" }}
            >
              <Stack gap={0} align="center">
                <Text fz="xs" fw={600}>
                  {t("Board.Practice.Easy")}
                </Text>
                <Text fz={10} c="dimmed">
                  {reviewTimes ? formatReviewInterval(reviewTimes[4]) : ""}
                </Text>
              </Stack>
            </Button>
          </Tooltip>
        </SimpleGrid>
        <Text fz={10} c="dimmed">
          {t("Board.Practice.KeyboardHint")}
        </Text>
      </Stack>
    </Paper>
  );
}

function PositionsModal({
  open,
  setOpen,
  deck,
}: {
  open: boolean;
  setOpen: (open: boolean) => void;
  deck: PracticeDeckValue;
}) {
  const { t } = useTranslation();

  const store = useContext(TreeStateContext)!;
  const root = useStore(store, (s) => s.root);
  const headers = useStore(store, (s) => s.headers);
  const goToMove = useStore(store, (s) => s.goToMove);
  return (
    <AppModal
      opened={open}
      onClose={() => setOpen(false)}
      size="xl"
      title={<b>{t("Board.Practice.Positions")}</b>}
    >
      {deck.positions.length === 0 && <Text>{t("Board.Practice.NoPositionsYet")}</Text>}
      <SimpleGrid cols={2}>
        {deck.positions.map((c) => {
          const resolved = resolvePracticeCard(
            root,
            getBoardState(c.fen),
            headers.orientation || "white",
            headers.start || [],
          );
          if (!resolved) return null;
          const node = resolved.frame.node;
          const status = getCardStatus(c.card);
          return (
            <Card key={c.fen}>
              <Text>{`${formatMoveNumber(node.halfMoves + 1)} ${resolved.answer}`}</Text>
              <Divider my="xs" />
              <Group justify="space-between">
                <Stack>
                  <Text tt="uppercase" fw="bold" fz="sm">
                    {t("Board.Practice.Status")}
                  </Text>
                  <Badge
                    color={status === "unseen" ? "gray" : status === "due" ? "warning" : "gold"}
                  >
                    {status === "unseen"
                      ? t("Board.Practice.Unseen")
                      : status === "due"
                        ? t("Board.Practice.Due")
                        : t("Board.Practice.Practiced")}
                  </Badge>
                </Stack>
                <Stack>
                  <Text tt="uppercase" fw="bold" fz="sm">
                    {t("Board.Practice.Due")}
                  </Text>
                  <Text>{formatDate(c.card.due)}</Text>
                </Stack>
                <IconAction
                  label={t("Board.Practice.GoBackToPosition")}
                  variant="subtle"
                  onClick={() => {
                    const state = store.getState();
                    const current = resolvePracticeCard(
                      state.root,
                      getBoardState(c.fen),
                      state.headers.orientation || "white",
                      state.headers.start || [],
                    );
                    if (!current) return;
                    goToMove(current.frame.position);
                    setOpen(false);
                  }}
                >
                  <ArrowRight />
                </IconAction>
              </Group>
            </Card>
          );
        })}
      </SimpleGrid>
    </AppModal>
  );
}

function LogsModal({
  open,
  setOpen,
  identity,
  generation,
  epoch,
}: {
  open: boolean;
  setOpen: (open: boolean) => void;
  identity: PracticeDeckKey;
  generation: number;
  epoch?: string;
}) {
  const { t } = useTranslation();
  const store = useContext(TreeStateContext)!;
  const root = useStore(store, (s) => s.root);
  const goToMove = useStore(store, (s) => s.goToMove);
  const [logs, setLogs] = useState<Array<ReviewLog & { fen: string; id: string }>>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [pageError, setPageError] = useState<AppError | null>(null);
  const requestSequence = useRef(0);

  const loadPage = useCallback(
    async (cursor: string | null, replace: boolean) => {
      if (identity.file === "" || !epoch) return;
      const sequence = ++requestSequence.current;
      setLoading(true);
      setPageError(null);
      try {
        const page = await loadPracticeReviews(
          identity.file,
          identity.game,
          cursor,
          PRACTICE_LOG_PAGE_SIZE,
          epoch,
        );
        if (sequence !== requestSequence.current) return;
        const parsed = page.entries.map((entry) => ({
          ...(JSON.parse(entry.entry) as ReviewLog & { fen: string }),
          id: entry.id,
        }));
        setLogs((previous) => (replace ? parsed : [...previous, ...parsed]));
        setNextCursor(page.nextCursor);
      } catch (cause) {
        if (sequence === requestSequence.current) setPageError(normalizeError(cause));
      } finally {
        if (sequence === requestSequence.current) setLoading(false);
      }
    },
    [identity.file, identity.game, epoch],
  );

  useEffect(() => {
    if (!open) {
      requestSequence.current += 1;
      return;
    }
    setLogs([]);
    setNextCursor(null);
    setPageError(null);
    void loadPage(null, true);
    return () => {
      requestSequence.current += 1;
    };
  }, [generation, loadPage, open]);

  return (
    <AppModal
      opened={open}
      onClose={() => setOpen(false)}
      size="xl"
      title={<b>{t("Board.Practice.Logs")}</b>}
    >
      <SimpleGrid cols={2}>
        {logs.length === 0 && !loading && !pageError && (
          <Text>{t("Board.Practice.NoLogsYet")}</Text>
        )}
        {logs.map((log) => {
          const position = findFen(log.fen, root);
          const node = position ? getNodeAtPath(root, position) : null;

          return (
            <Card key={log.id} data-practice-entry-id={log.id}>
              <Text>{node?.san ? `${formatMoveNumber(node.halfMoves)} ${node.san}` : log.fen}</Text>

              <Divider my="xs" />
              <Group justify="space-between">
                <Stack>
                  <Text tt="uppercase" fw="bold" fz="sm">
                    {t("Board.Practice.Rating")}
                  </Text>
                  <Badge
                    color={
                      log.rating === 1
                        ? "danger"
                        : log.rating === 2
                          ? "warning"
                          : log.rating === 3
                            ? "gold"
                            : "success"
                    }
                  >
                    {log.rating === 1
                      ? t("Board.Practice.Again")
                      : log.rating === 2
                        ? t("Board.Practice.Hard")
                        : log.rating === 3
                          ? t("Board.Practice.Good")
                          : t("Board.Practice.Easy")}
                  </Badge>
                </Stack>
                <Stack>
                  <Text tt="uppercase" fw="bold" fz="sm">
                    {t("Common.Date")}
                  </Text>
                  <Text>{formatDate(log.review)}</Text>
                </Stack>
                {position && (
                  <IconAction
                    label={t("Board.Practice.GoBackToPosition")}
                    variant="subtle"
                    onClick={() => {
                      goToMove(position);
                      setOpen(false);
                    }}
                  >
                    <ArrowRight />
                  </IconAction>
                )}
              </Group>
            </Card>
          );
        })}
      </SimpleGrid>
      {pageError && (
        <Alert color="danger" mt="sm">
          {t("Board.Practice.LogsLoadFailed", { cause: pageError.message })}
        </Alert>
      )}
      {nextCursor && (
        <Button
          mt="sm"
          variant="light"
          loading={loading}
          onClick={() => void loadPage(nextCursor, false)}
        >
          {t("Board.Practice.LoadMore")}
        </Button>
      )}
    </AppModal>
  );
}

export default PracticePanel;
