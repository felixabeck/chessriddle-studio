import { useTabAtom } from "@/state/tabScope";
import { tauri } from "@/platform/tauri";
import {
  Accordion,
  Alert,
  Badge,
  Button,
  Divider,
  Group,
  Paper,
  Portal,
  RangeSlider,
  ScrollArea,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Text,
} from "@mantine/core";
import { TriangleAlert, Flame, Plus, Settings, Trash2, X, ScanSearch } from "lucide-react";
import { makeSquare } from "chessops";
import { useAtom, useAtomValue, useStore as useAtomStore } from "jotai";
import { useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { type PathRef, type PuzzleDatabaseInfo } from "@/bindings";
import { IconAction } from "@/components/common/IconAction";
import { notifyUnlessCancelled } from "@/components/files/notifyError";
import {
  type PuzzleTimer,
  puzzleTimerFamily,
  hidePuzzleRatingAtom,
  jumpToNextPuzzleAtom,
  progressivePuzzlesAtom,
  puzzleRatingRangeAtom,
  puzzleThemeAtom,
  puzzleWorkspaceGenerationAtom,
  selectedPuzzleDbAtom,
  tabsAtom,
  trackPuzzleTimeAtom,
} from "@/state/atoms";
import { positionFromFen } from "@/utils/chessops";
import { makeMove as makeDraftMove, validateMoveSequence } from "@/state/store/tree";
import {
  emptyPuzzleSession,
  legacyPuzzleKey,
  puzzleSchema,
  removeLegacyPuzzleKey,
  restorePuzzleSession,
  selectedPuzzleIndex,
} from "@/state/puzzleSession";
import { persistStorageWriteError } from "@/state/store/tabStorage";
import { reportPersistError } from "@/state/persistError";
import { puzzleDatabaseExtension } from "@/utils/db";
import { formatDecimal, formatThemeLabel, formatTime } from "@/utils/format";
import { capabilityKey } from "@/utils/pathCapabilities";
import { normalizeError, runDestructiveWithRefresh } from "@/platform/errors";
import {
  captureTreePositionOwner,
  getPuzzleProgress,
  type Completion,
  getPuzzleDatabases,
  type Puzzle,
} from "@/utils/puzzles";
import { createTab, runTabCreation, useTabActions } from "@/utils/tabs";
import ChessRiddleTraining from "../chessriddle/ChessRiddleTraining";
import { useTrainingSession } from "../chessriddle/useTrainingSession";
import PuzzleSourceControl, { type PuzzleSource } from "./PuzzleSourceControl";
import { playSound } from "@/utils/sound";
import {
  defaultTree,
  getBoardState,
  getNodeAtPath,
  getResolvedPathLength,
} from "@/utils/treeReducer";
import ChallengeHistory from "../common/ChallengeHistory";
import ConfirmModal from "../common/ConfirmModal";
import GameNotation from "../common/GameNotation";
import MoveControls from "../common/MoveControls";
import { TreeStateContext } from "../common/TreeStateContext";
import AddPuzzle from "./AddPuzzle";
import PuzzleBoard from "./PuzzleBoard";

const puzzleRatingMarks = [600, 1700, 2800] as const;
const unavailableValue = "-";

function timerElapsed(timer: PuzzleTimer): number {
  return timer.startedAt === undefined ? timer.elapsed : Date.now() - timer.startedAt;
}

function activeTimer(attemptId: string, elapsed: number, now: number): PuzzleTimer {
  return { attemptId, startedAt: now - elapsed };
}

function pausedTimer(timer: PuzzleTimer, elapsed: number): PuzzleTimer {
  return timer.startedAt === undefined ? timer : { attemptId: timer.attemptId, elapsed };
}

const addOptionLabel = (label: string) => `+ ${label}`;
const emptySession = emptyPuzzleSession();

function Puzzles({ id }: { id: string }) {
  const tab = useAtomValue(tabsAtom).find((candidate) => candidate.value === id);
  const training = useTrainingSession(id, tab?.puzzleSource !== "chessriddle");
  const { updateTab } = useTabActions();
  const source =
    tab?.puzzleSource === "chessriddle" && training.available !== false ? "chessriddle" : "offline";
  const changeSource = (puzzleSource: PuzzleSource) => {
    if (training.phase === "submitting") return;
    updateTab(id, (previous) => ({ ...previous, puzzleSource }));
  };
  const sourceControl =
    training.available === true ? (
      <PuzzleSourceControl
        source={source}
        disabled={training.phase === "submitting"}
        onChange={changeSource}
      />
    ) : null;
  return source === "chessriddle" ? (
    <ChessRiddleTraining
      id={id}
      sourceControl={sourceControl}
      onOffline={() => changeSource("offline")}
    />
  ) : (
    <OfflinePuzzles id={id} sourceControl={sourceControl} />
  );
}

function OfflinePuzzles({ id, sourceControl }: { id: string; sourceControl: ReactNode }) {
  const store = useContext(TreeStateContext)!;
  const { t } = useTranslation();
  const [ready, setReady] = useState(false);
  function restore() {
    try {
      const state = store.getState();
      const session = restorePuzzleSession(id, state);
      if (
        session !== state.puzzleSession &&
        !state.transitionPuzzleSession((draft) => {
          draft.puzzleSession = session;
        }).success
      )
        return;
      removeLegacyPuzzleKey(legacyPuzzleKey(id));
      setReady(true);
    } catch (error) {
      reportPersistError(persistStorageWriteError(error));
    }
  }
  useEffect(restore, [store, id]);
  return ready ? (
    <PuzzleSessionView sourceControl={sourceControl} />
  ) : sourceControl ? (
    <Portal target="#topRight">
      <Stack>
        {sourceControl}
        <Button onClick={restore}>{t("TreeRecovery.Retry")}</Button>
      </Stack>
    </Portal>
  ) : (
    <Button onClick={restore}>{t("TreeRecovery.Retry")}</Button>
  );
}

function PuzzleSessionView({ sourceControl }: { sourceControl: ReactNode }) {
  const { t, i18n } = useTranslation();
  const commonErrorRef = useRef(t("Common.Error"));
  commonErrorRef.current = t("Common.Error");
  const store = useContext(TreeStateContext)!;
  const goToStart = useStore(store, (s) => s.goToStart);
  const makeMove = useStore(store, (s) => s.makeMove);
  const setShapes = useStore(store, (s) => s.setShapes);
  const root = useStore(store, (s) => s.root);
  const position = useStore(store, (s) => s.position);
  const session = useStore(store, (s) => s.puzzleSession) ?? emptySession;
  const puzzles = session.attempts.map((attempt) => attempt.puzzle);
  const currentPuzzle = selectedPuzzleIndex(session);
  const attemptId = session.selectedAttemptId;
  const transition = store.getState().transitionPuzzleSession;
  const firstResult = useRef<{
    attemptId: string | null;
    completion: Completion;
    timeSpent: number | undefined;
  } | null>(null);
  const [completionRetry, setCompletionRetry] = useState<{
    attemptId: string | null;
    owns: () => boolean;
    retry: () => void;
  } | null>(null);
  const mounted = useRef(true);

  const [puzzleDbs, setPuzzleDbs] = useState<PuzzleDatabaseInfo[]>([]);
  const [selectedDb, setSelectedDb] = useAtom(selectedPuzzleDbAtom);
  const [workspaceGeneration, setWorkspaceGeneration] = useAtom(puzzleWorkspaceGenerationAtom);
  const [listedWorkspaceGeneration, setListedWorkspaceGeneration] = useState<number | null>(null);

  const [settingsOpened, setSettingsOpened] = useState(false);
  const requestGeneration = useRef(0);
  const puzzleRequest = useRef<AbortController | null>(null);
  const solutionAbortRef = useRef<AbortController | null>(null);
  const listingController = useRef<AbortController | null>(null);
  const themeController = useRef<AbortController | null>(null);
  const completedThemeController = useRef<AbortController | null>(null);
  const resetWorkspaceRef = useRef<() => void>(() => {});
  const workspaceRef = useRef<string | null>(null);
  const workspaceRequest = useRef(0);
  const selectedDbRef = useRef(selectedDb);
  selectedDbRef.current = selectedDb;
  const workspaceGenerationRef = useRef(workspaceGeneration);
  workspaceGenerationRef.current = workspaceGeneration;

  async function refreshPuzzleDbs(signal?: AbortSignal): Promise<void> {
    const generation = workspaceGenerationRef.current;
    const databases = await getPuzzleDatabases(signal);
    // A listing started under an older workspace generation must not be published (f-20261106-43).
    if (signal?.aborted || !mounted.current || workspaceGenerationRef.current !== generation)
      return;
    setPuzzleDbs(databases);
  }

  const effectiveSelectedDb =
    listedWorkspaceGeneration === workspaceGeneration &&
    selectedDb &&
    puzzleDbs.some((database) => capabilityKey(database.path) === capabilityKey(selectedDb))
      ? selectedDb
      : null;
  const effectiveSelectedDbRef = useRef(effectiveSelectedDb);
  effectiveSelectedDbRef.current = effectiveSelectedDb;
  const effectiveSelectedDbKey = effectiveSelectedDb ? capabilityKey(effectiveSelectedDb) : null;

  function ownsDatabaseRequest(database: PathRef, signal: AbortSignal): boolean {
    const currentDatabase = effectiveSelectedDbRef.current;
    return (
      !signal.aborted &&
      currentDatabase !== null &&
      capabilityKey(currentDatabase) === capabilityKey(database)
    );
  }

  useEffect(() => {
    requestGeneration.current++;
    puzzleRequest.current?.abort();
    solutionAbortRef.current?.abort();
    solutionAbortRef.current = null;
    setIsPlayingSolution(false);
    completedThemeController.current?.abort();
    completedThemeController.current = null;
  }, [effectiveSelectedDbKey]);

  useEffect(() => {
    completedThemeController.current?.abort();
    completedThemeController.current = null;
  }, [attemptId]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      puzzleRequest.current?.abort();
      solutionAbortRef.current?.abort();
      solutionAbortRef.current = null;
      listingController.current?.abort();
      themeController.current?.abort();
      completedThemeController.current?.abort();
    };
  }, []);

  useEffect(() => {
    let active = true;
    const listingRequest = ++workspaceRequest.current;
    listingController.current?.abort();
    const controller = new AbortController();
    listingController.current = controller;
    requestGeneration.current++;
    puzzleRequest.current?.abort();
    void Promise.all([tauri.getPuzzleWorkspace(), getPuzzleDatabases(controller.signal)])
      .then(([workspace, databases]) => {
        if (!active || listingRequest !== workspaceRequest.current) return;
        const workspaceKey = capabilityKey(workspace.root);
        const workspaceChanged =
          workspaceRef.current !== null && workspaceRef.current !== workspaceKey;
        workspaceRef.current = workspaceKey;
        setPuzzleDbs(databases);
        setListedWorkspaceGeneration(workspaceGeneration);
        const currentSelection = selectedDbRef.current;
        if (
          workspaceChanged ||
          (currentSelection &&
            !databases.some(
              (database) => capabilityKey(database.path) === capabilityKey(currentSelection),
            ))
        ) {
          requestGeneration.current++;
          puzzleRequest.current?.abort();
          resetWorkspaceRef.current();
        }
      })
      .catch((error) => {
        if (active && listingRequest === workspaceRequest.current) {
          setPuzzleDbs([]);
          setListedWorkspaceGeneration(null);
          notifyUnlessCancelled(commonErrorRef.current, error, "puzzle");
        }
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [workspaceGeneration]);

  const [ratingRange, setRatingRange] = useAtom(puzzleRatingRangeAtom);

  const [selectedTheme, setSelectedTheme] = useAtom(puzzleThemeAtom);
  const [availableThemes, setAvailableThemes] = useState<string[]>([]);
  const [themesTableMissing, setThemesTableMissing] = useState(false);
  const effectiveSelectedTheme =
    selectedTheme && availableThemes.includes(selectedTheme) ? selectedTheme : null;

  useEffect(() => {
    let cancelled = false;
    themeController.current?.abort();
    const controller = new AbortController();
    themeController.current = controller;
    setThemesTableMissing(false);

    if (!effectiveSelectedDb) {
      setAvailableThemes([]);
      return;
    }
    const database = effectiveSelectedDb;
    const isCurrent = () => !cancelled && ownsDatabaseRequest(database, controller.signal);

    void tauri
      .getPuzzleThemes(effectiveSelectedDb, { signal: controller.signal })
      .then((themes) => {
        if (!isCurrent()) return;
        setAvailableThemes(themes);
      })
      .catch((error: Error) => {
        if (!isCurrent()) return;
        const normalized = normalizeError(error);
        setAvailableThemes([]);
        const themesUnavailable = normalized.backendCategory === "puzzle-themes-unavailable";
        setThemesTableMissing(themesUnavailable);
        if (!themesUnavailable) {
          notifyUnlessCancelled(commonErrorRef.current, error);
        }
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [effectiveSelectedDb]);

  const [jumpToNextPuzzleImmediately, setJumpToNextPuzzleImmediately] =
    useAtom(jumpToNextPuzzleAtom);

  const wonPuzzles = puzzles.filter((p) => p.completion === "correct");
  const lostPuzzles = puzzles.filter((p) => p.completion === "incorrect");

  const totalCompleted = wonPuzzles.length + lostPuzzles.length;
  const accuracy =
    totalCompleted > 0 ? Math.round((wonPuzzles.length / totalCompleted) * 100) : null;

  let currentStreak = 0;
  for (let i = puzzles.length - 1; i >= 0; i--) {
    if (puzzles[i].completion === "correct") currentStreak++;
    else if (puzzles[i].completion === "incorrect") break;
  }

  const timedWonPuzzles = wonPuzzles.filter((p) => p.timeSpent !== undefined);
  const avgTimeSeconds =
    timedWonPuzzles.length > 0
      ? timedWonPuzzles.reduce((acc, p) => acc + (p.timeSpent ?? 0), 0) /
        timedWonPuzzles.length /
        1000
      : 0;

  function admitPuzzle(
    puzzle: Puzzle,
    existingAttemptId: string | null,
    {
      isCurrent = () => true,
    }: {
      isCurrent?: () => boolean;
    } = {},
  ) {
    try {
      if (!isCurrent()) return;
      const append = existingAttemptId === null;
      if (!append) {
        const existing = store
          .getState()
          .puzzleSession?.attempts.find((attempt) => attempt.attemptId === existingAttemptId);
        if (!existing) return;
        puzzle = existing.puzzle;
      }
      const result = validateMoveSequence(puzzle.fen, puzzle.moves);
      if (!result.success) throw result.error;
      puzzleSchema.parse(puzzle);
      if (!isCurrent()) return;
      const opening = defaultTree(puzzle.fen);
      const move = result.moves[0];
      if (!move) return;
      makeDraftMove({ state: opening, move, last: false, sound: false, changeHeaders: false });
      const san = getNodeAtPath(opening.root, opening.position).san!;
      const selected = existingAttemptId ?? crypto.randomUUID();
      const previousTimer = atomStore.get(timerAtom);
      const tracking = atomStore.get(trackPuzzleTimeAtom);
      const previousSession = store.getState().puzzleSession;
      let refused = false;
      try {
        const admitted = transition((draft) => {
          const history = draft.puzzleSession ?? emptyPuzzleSession();
          if (previousTimer && (tracking || previousTimer.startedAt === undefined)) {
            const prior = history.attempts.find(
              (attempt) =>
                attempt.attemptId === previousTimer.attemptId &&
                attempt.attemptId === history.selectedAttemptId,
            );
            if (prior?.puzzle.completion === "incomplete")
              prior.puzzle.timeSpent = timerElapsed(previousTimer);
          }
          if (append) history.attempts.push({ attemptId: selected, puzzle });
          history.selectedAttemptId = selected;
          Object.assign(draft, opening, { puzzleSession: history });
        });
        refused = !admitted.success;
        if (refused) return;
      } finally {
        // Installation can notify subscribers before returning, including a subscriber throw.
        const live = store.getState();
        const admitted =
          live.puzzleSession?.selectedAttemptId === selected
            ? live.puzzleSession.attempts.find((attempt) => attempt.attemptId === selected)
            : undefined;
        const ownsSession = live.capturePuzzleSessionOwner();
        if (!refused && live.puzzleSession !== previousSession && admitted) {
          const nextTimer =
            atomStore.get(trackPuzzleTimeAtom) && admitted.puzzle.completion === "incomplete"
              ? activeTimer(selected, admitted.puzzle.timeSpent || 0, Date.now())
              : null;
          setTimer((current) =>
            mounted.current && ownsSession() && current === previousTimer ? nextTimer : current,
          );
        }
      }
      playSound(san.includes("x"), san.includes("+"));
      if (!append) {
        requestGeneration.current++;
        puzzleRequest.current?.abort();
      }
      solutionAbortRef.current?.abort();
      setIsPlayingSolution(false);
      return true;
    } catch (error) {
      if (isCurrent()) notifyUnlessCancelled(commonErrorRef.current, error);
    }
  }

  async function generatePuzzle(
    db: PathRef,
    force: boolean = false,
    isOwned: () => boolean = () => true,
  ) {
    if (!isOwned()) return;
    const liveSession = store.getState().puzzleSession ?? emptySession;
    const selectedIndex = selectedPuzzleIndex(liveSession);
    const attempts = liveSession.attempts;
    let nextIndex = attempts.findIndex(
      ({ puzzle }, i) => i > selectedIndex && puzzle.completion === "incomplete",
    );
    if (nextIndex === -1) {
      nextIndex = attempts.findIndex(
        ({ puzzle }, i) => i < selectedIndex && puzzle.completion === "incomplete",
      );
    }

    if (nextIndex !== -1 && !force) {
      const next = attempts[nextIndex];
      admitPuzzle(next.puzzle, next.attemptId, { isCurrent: isOwned });
      return;
    }

    solutionAbortRef.current?.abort();
    setIsPlayingSolution(false);

    let range = ratingRange;
    if (progressive) {
      const rating = attempts[selectedIndex]?.puzzle.rating;
      if (rating) {
        range = [rating + 50, rating + 100];
      }
    }
    const generation = ++requestGeneration.current;
    puzzleRequest.current?.abort();
    const request = new AbortController();
    puzzleRequest.current = request;
    const ownsSession = store.getState().capturePuzzleSessionOwner();
    const ownsPosition = captureTreePositionOwner(store);
    const isCurrent = () =>
      isOwned() &&
      ownsSession() &&
      ownsPosition() &&
      mounted.current &&
      generation === requestGeneration.current &&
      ownsDatabaseRequest(db, request.signal);
    let result;
    try {
      result = await tauri.getPuzzle(db, range[0], range[1], effectiveSelectedTheme, {
        signal: request.signal,
      });
    } catch (error) {
      if (isCurrent()) {
        notifyUnlessCancelled(commonErrorRef.current, error);
      }
      return;
    }
    if (!isCurrent()) return;
    const puzzle = result;
    const newPuzzle: Puzzle = {
      ...puzzle,
      moves: puzzle.moves.split(" "),
      completion: "incomplete",
    };
    if (admitPuzzle(newPuzzle, null, { isCurrent }) && progressive && range !== ratingRange)
      setRatingRange(range);
  }

  async function changeCompletion(
    completion: Completion,
    isCurrent: () => boolean = () => true,
    refreshOwner: () => void = () => {},
  ) {
    if (!isCurrent()) return false;
    const puzzle = store
      .getState()
      .puzzleSession?.attempts.find((attempt) => attempt.attemptId === attemptId)?.puzzle;
    if (!puzzle) return false;
    if (puzzle.completion !== "incomplete") return true;
    if (firstResult.current?.attemptId !== attemptId)
      firstResult.current = {
        attemptId,
        completion,
        timeSpent: selectedTimer ? timerElapsed(selectedTimer) : puzzle.timeSpent,
      };
    const first = firstResult.current;
    function queueRetry(save: () => boolean | Promise<boolean>, owns = isCurrent) {
      setCompletionRetry({
        attemptId,
        owns,
        retry: () => {
          if (!owns()) return;
          void Promise.resolve()
            .then(save)
            .then((saved) => {
              if (
                saved &&
                owns() &&
                first.completion === "correct" &&
                effectiveSelectedDb &&
                jumpToNextPuzzleImmediately
              )
                return generatePuzzle(effectiveSelectedDb, false, isCurrent);
            })
            .catch((error) => {
              if (owns()) notifyUnlessCancelled(commonErrorRef.current, error);
            });
        },
      });
    }
    let ownsSession = store.getState().capturePuzzleSessionOwner();
    let saved;
    try {
      saved = transition((draft) => {
        const selected = draft.puzzleSession!.attempts.find(
          (attempt) => attempt.attemptId === attemptId,
        )!;
        selected.puzzle = {
          ...selected.puzzle,
          completion: first.completion,
          timeSpent: first.timeSpent,
        };
      });
    } catch (error) {
      // Installation can throw from a subscriber after the complete candidate was saved.
      refreshOwner();
      if (mounted.current && isCurrent()) notifyUnlessCancelled(commonErrorRef.current, error);
      return false;
    }
    if (!saved.success) {
      queueRetry(() => changeCompletion(completion, isCurrent, refreshOwner));
      return false;
    }
    setCompletionRetry(null);
    ownsSession = store.getState().capturePuzzleSessionOwner();
    refreshOwner();
    clearTimer(timer);

    if (effectiveSelectedDb && puzzle?.id && !themesTableMissing) {
      const database = effectiveSelectedDb;
      const generation = requestGeneration.current;
      completedThemeController.current?.abort();
      const controller = new AbortController();
      completedThemeController.current = controller;
      const ownsCompletion = () =>
        isCurrent() &&
        ownsSession() &&
        mounted.current &&
        generation === requestGeneration.current &&
        ownsDatabaseRequest(database, controller.signal);
      try {
        const themes = await tauri.getThemesForPuzzle(database, puzzle.id, {
          signal: controller.signal,
        });
        const saveThemes = (): boolean => {
          if (!ownsCompletion()) return false;
          if (
            !transition((draft) => {
              draft.puzzleSession!.attempts.find(
                (attempt) => attempt.attemptId === attemptId,
              )!.puzzle.themes = themes;
            }).success
          ) {
            queueRetry(saveThemes, ownsCompletion);
            return false;
          }
          ownsSession = store.getState().capturePuzzleSessionOwner();
          refreshOwner();
          setCompletionRetry(null);
          return true;
        };
        if (!saveThemes()) return false;
      } catch (error) {
        if (
          ownsCompletion() &&
          normalizeError(error).backendCategory !== "puzzle-themes-unavailable"
        )
          notifyUnlessCancelled(t("Common.Error"), error, "puzzle");
      }
    }
    return true;
  }

  const [addOpened, setAddOpened] = useState(false);
  const [deleteModalOpened, setDeleteModalOpened] = useState(false);
  const [isPlayingSolution, setIsPlayingSolution] = useState(false);

  const [progressive, setProgressive] = useAtom(progressivePuzzlesAtom);
  const [hideRating, setHideRating] = useAtom(hidePuzzleRatingAtom);
  const [trackTime, setTrackTime] = useAtom(trackPuzzleTimeAtom);

  const atomStore = useAtomStore();
  const timerAtom = useTabAtom(puzzleTimerFamily);
  const [timer, setTimer] = useAtom(timerAtom);
  const selectedTimer = timer?.attemptId === attemptId ? timer : null;
  const timerStart = selectedTimer?.startedAt ?? null;
  const clearTimer = useCallback(
    (expected: typeof timer) => {
      setTimer((current) => (current === expected ? null : current));
    },
    [setTimer],
  );
  const [, setTick] = useState(0);
  resetWorkspaceRef.current = () => {
    if (
      !transition((draft) =>
        Object.assign(draft, defaultTree(), { puzzleSession: emptyPuzzleSession() }),
      ).success
    )
      return;
    solutionAbortRef.current?.abort();
    setAvailableThemes([]);
    setThemesTableMissing(false);
    setSelectedTheme(null);
    clearTimer(timer);
    setIsPlayingSolution(false);
  };
  const isPuzzleIncomplete = puzzles[currentPuzzle]?.completion === "incomplete";
  const savedElapsed = puzzles[currentPuzzle]?.timeSpent ?? 0;
  const elapsedTime =
    selectedTimer && isPuzzleIncomplete
      ? timerElapsed(selectedTimer)
      : puzzles[currentPuzzle]?.timeSpent || 0;

  useEffect(() => {
    const live = store.getState();
    const ownsSession = live.capturePuzzleSessionOwner();
    if (
      trackTime &&
      isPuzzleIncomplete &&
      timerStart === null &&
      attemptId &&
      live.puzzleSession === session
    ) {
      setTimer((current) =>
        ownsSession() && current === timer && atomStore.get(trackPuzzleTimeAtom)
          ? activeTimer(
              attemptId,
              selectedTimer ? timerElapsed(selectedTimer) : savedElapsed,
              Date.now(),
            )
          : current,
      );
    }
  }, [
    trackTime,
    isPuzzleIncomplete,
    timerStart,
    savedElapsed,
    attemptId,
    session,
    store,
    timer,
    setTimer,
    selectedTimer,
    atomStore,
  ]);

  useEffect(() => {
    if (!trackTime || !isPuzzleIncomplete || timerStart === null) return;

    const displayInterval = setInterval(() => {
      setTick((t) => t + 1);
    }, 100);

    return () => clearInterval(displayInterval);
  }, [trackTime, isPuzzleIncomplete, timerStart]);

  useEffect(() => {
    const ownsSession = store.getState().capturePuzzleSessionOwner();
    const saveElapsed = (freeze = false) => {
      const puzzle = store
        .getState()
        .puzzleSession?.attempts.find((attempt) => attempt.attemptId === attemptId)?.puzzle;
      if (
        ownsSession() &&
        atomStore.get(timerAtom) === timer &&
        selectedTimer &&
        puzzle?.completion === "incomplete"
      ) {
        const expected = freeze
          ? pausedTimer(selectedTimer, timerElapsed(selectedTimer))
          : selectedTimer;
        const finalElapsed = timerElapsed(expected);
        if (expected !== selectedTimer) {
          setTimer((current) => (current === timer && ownsSession() ? expected : current));
        }
        if (!ownsSession() || atomStore.get(timerAtom) !== expected) return;
        const saved = transition((draft) => {
          draft.puzzleSession!.attempts.find(
            (attempt) => attempt.attemptId === attemptId,
          )!.puzzle.timeSpent = finalElapsed;
        });
        if (saved.success) clearTimer(expected);
      }
    };
    const unload = () => saveElapsed();
    if (selectedTimer?.startedAt === undefined) saveElapsed();
    window.addEventListener("beforeunload", unload);
    window.addEventListener("pagehide", unload);
    return () => {
      window.removeEventListener("beforeunload", unload);
      window.removeEventListener("pagehide", unload);
      saveElapsed(!mounted.current);
    };
  }, [
    trackTime,
    timerStart,
    timer,
    timerAtom,
    atomStore,
    attemptId,
    isPuzzleIncomplete,
    session,
    store,
    transition,
    clearTimer,
    selectedTimer,
    setTimer,
  ]);

  const [, setTabs] = useAtom(tabsAtom);

  const turnToMove =
    puzzles[currentPuzzle] !== undefined
      ? positionFromFen(puzzles[currentPuzzle]?.fen)[0]?.turn
      : null;

  const hintMove = getPuzzleProgress(puzzles[currentPuzzle], root, position).nextMove;

  return (
    <>
      <Portal target="#left" style={{ height: "100%" }}>
        <PuzzleBoard
          key={attemptId}
          puzzles={puzzles}
          currentPuzzle={currentPuzzle}
          changeCompletion={changeCompletion}
          generatePuzzle={(database, isCurrent) => generatePuzzle(database, false, isCurrent)}
          db={effectiveSelectedDb}
          blocked={completionRetry?.attemptId === attemptId && completionRetry.owns()}
        />
      </Portal>
      <Portal target="#topRight" style={{ height: "100%" }}>
        <Paper
          h="100%"
          withBorder
          p="md"
          style={{
            overflow: "hidden",
          }}
        >
          {sourceControl && <Stack pb="sm">{sourceControl}</Stack>}
          <AddPuzzle
            puzzleDbs={puzzleDbs}
            opened={addOpened}
            setOpened={setAddOpened}
            refreshPuzzleDbs={refreshPuzzleDbs}
            onWorkspaceChanged={() => {
              // The picker starts its preview before the atom update renders, so advance its owner now.
              workspaceGenerationRef.current += 1;
              setWorkspaceGeneration((generation) => generation + 1);
            }}
          />
          <ConfirmModal
            title={t("Puzzle.DeleteDatabase")}
            description={t("Puzzle.DeleteDatabaseConfirm")}
            opened={deleteModalOpened}
            onClose={() => setDeleteModalOpened(false)}
            onConfirm={async () => {
              if (effectiveSelectedDb) {
                const deletedDb = effectiveSelectedDb;
                try {
                  await runDestructiveWithRefresh(
                    () => tauri.deletePuzzleDatabase(deletedDb),
                    () => {
                      setPuzzleDbs((dbs) =>
                        dbs.filter((db) => capabilityKey(db.path) !== capabilityKey(deletedDb)),
                      );
                      if (
                        selectedDbRef.current &&
                        capabilityKey(selectedDbRef.current) === capabilityKey(deletedDb)
                      ) {
                        requestGeneration.current++;
                        puzzleRequest.current?.abort();
                        setSelectedDb(null);
                        resetWorkspaceRef.current();
                      }
                      setDeleteModalOpened(false);
                    },
                  );
                } catch (error) {
                  notifyUnlessCancelled(t("Common.Error"), error, "puzzle");
                }
              }
            }}
          />
          <Group justify="space-between" pb="sm">
            <Select
              style={{ flex: 1 }}
              data={puzzleDbs
                .map((p) => ({
                  label: p.title.split(puzzleDatabaseExtension)[0],
                  value: capabilityKey(p.path),
                }))
                .concat({ label: addOptionLabel(t("Common.AddNew")), value: "add" })}
              value={effectiveSelectedDb ? capabilityKey(effectiveSelectedDb) : null}
              clearable={false}
              placeholder={t("Puzzle.SelectDatabase")}
              onChange={(v) => {
                if (v === "add") {
                  setAddOpened(true);
                } else {
                  requestGeneration.current++;
                  puzzleRequest.current?.abort();
                  setSelectedDb(
                    puzzleDbs.find((database) => capabilityKey(database.path) === v)?.path ?? null,
                  );
                }
              }}
            />
            <Group gap="xs">
              <IconAction
                label={t("Puzzle.DeleteDatabase")}
                color="danger"
                disabled={!effectiveSelectedDb}
                onClick={() => setDeleteModalOpened(true)}
              >
                <Trash2 size={20} />
              </IconAction>
              <IconAction
                label={t("SideBar.Settings")}
                pressed={settingsOpened}
                onClick={() => setSettingsOpened((o) => !o)}
              >
                <Settings size={20} />
              </IconAction>
            </Group>
          </Group>
          <Accordion
            value={settingsOpened ? "settings" : null}
            onChange={(v) => setSettingsOpened(v === "settings")}
            mb="sm"
          >
            <Accordion.Item value="settings">
              <Accordion.Panel>
                <Stack gap="md">
                  {themesTableMissing && (
                    <Alert
                      icon={<TriangleAlert />}
                      title={t("Puzzle.DatabaseOutdated")}
                      color="warning"
                    >
                      {t("Puzzle.DatabaseOutdatedDesc")}
                    </Alert>
                  )}
                  <div>
                    <Text size="sm" fw={500} mb={4}>
                      {t("Puzzle.RatingRange")}
                    </Text>
                    <RangeSlider
                      min={600}
                      my="md"
                      max={2800}
                      value={ratingRange}
                      onChange={setRatingRange}
                      disabled={progressive}
                      marks={puzzleRatingMarks.map((value) => ({ value, label: String(value) }))}
                    />
                  </div>
                  <Select
                    label={t("Puzzle.Theme")}
                    placeholder={t("Puzzle.AllThemes")}
                    data={availableThemes.map((theme) => ({
                      label: formatThemeLabel(theme),
                      value: theme,
                    }))}
                    value={effectiveSelectedTheme}
                    onChange={setSelectedTheme}
                    clearable
                    searchable
                  />
                  <SimpleGrid cols={2} spacing="sm">
                    <Switch
                      label={t("Puzzle.Progressive")}
                      description={t("Puzzle.Progressive.Desc")}
                      checked={progressive}
                      onChange={(event) => setProgressive(event.currentTarget.checked)}
                    />
                    <Switch
                      label={t("Puzzle.HideRating")}
                      description={t("Puzzle.HideRating.Desc")}
                      checked={hideRating}
                      onChange={(event) => setHideRating(event.currentTarget.checked)}
                    />
                    <Switch
                      label={t("Puzzle.JumpToNextPuzzleImmediately")}
                      description={t("Puzzle.JumpToNextPuzzleImmediately.Desc")}
                      checked={jumpToNextPuzzleImmediately}
                      onChange={(event) =>
                        setJumpToNextPuzzleImmediately(event.currentTarget.checked)
                      }
                    />
                    <Switch
                      label={t("Puzzle.TrackPuzzleTime")}
                      description={t("Puzzle.TrackPuzzleTime.Desc")}
                      checked={trackTime}
                      onChange={(event) => {
                        if (!event.currentTarget.checked) {
                          const live = store.getState();
                          const ownsSession = live.capturePuzzleSessionOwner();
                          const current = atomStore.get(timerAtom);
                          if (
                            current &&
                            current.attemptId === live.puzzleSession?.selectedAttemptId
                          ) {
                            const paused = pausedTimer(current, timerElapsed(current));
                            setTimer((value) =>
                              ownsSession() && value === current ? paused : value,
                            );
                          }
                          setTrackTime(false);
                        } else {
                          setTrackTime(true);
                        }
                      }}
                    />
                  </SimpleGrid>
                </Stack>
              </Accordion.Panel>
            </Accordion.Item>
          </Accordion>
          <Group grow>
            <Paper withBorder p="xs">
              <Text size="xs" c="dimmed">
                {t("Puzzle.Rating")}
              </Text>
              <Text fw={700} size="lg">
                {isPuzzleIncomplete && hideRating && puzzles[currentPuzzle]?.rating
                  ? "?"
                  : puzzles[currentPuzzle]?.rating || unavailableValue}
              </Text>
            </Paper>

            {trackTime && (
              <Paper withBorder p="xs">
                <Text size="xs" c="dimmed">
                  {t("Puzzle.Time")}
                </Text>
                <Text fw={700} size="lg" ff="monospace">
                  {formatTime(elapsedTime, i18n.language)}
                </Text>
              </Paper>
            )}

            <Paper withBorder p="xs">
              <Text size="xs" c="dimmed">
                {t("Puzzle.Accuracy")}
              </Text>
              <Text
                fw={700}
                size="lg"
                c={accuracy === null ? "dimmed" : accuracy >= 50 ? "success" : "warning"}
              >
                {accuracy !== null ? `${accuracy}%` : unavailableValue}
              </Text>
            </Paper>

            <Paper withBorder p="xs">
              <Text size="xs" c="dimmed">
                {t("Puzzle.Streak")}
              </Text>
              <Group gap={2}>
                <Text fw={700} size="lg">
                  {currentStreak}
                </Text>
                <Flame size={20} color="var(--cf-warning)" />
              </Group>
            </Paper>

            {trackTime && avgTimeSeconds > 0 && (
              <Paper withBorder p="xs">
                <Text size="xs" c="dimmed">
                  {t("Puzzle.AvgTime")}
                </Text>
                <Text fw={700} size="lg">
                  {t("Common.SecondsShort", {
                    value: formatDecimal(avgTimeSeconds, i18n.language),
                  })}
                </Text>
              </Paper>
            )}
          </Group>
          <Divider my="sm" />
          {completionRetry?.attemptId === attemptId && completionRetry.owns() && (
            <Button onClick={completionRetry.retry}>{t("Board.Practice.Retry")}</Button>
          )}
          {!isPuzzleIncomplete && (puzzles[currentPuzzle]?.themes?.length ?? 0) > 0 && (
            <Group gap="xs" mb="sm">
              {puzzles[currentPuzzle]?.themes?.map((theme) => (
                <Badge key={theme} variant="light" size="sm">
                  {formatThemeLabel(theme)}
                </Badge>
              ))}
            </Group>
          )}
          <Group justify="space-between">
            <Text fz="1.75rem" fw={500}>
              {!turnToMove
                ? ""
                : turnToMove === "white"
                  ? t("Fen.BlackToMove")
                  : t("Fen.WhiteToMove")}
            </Text>
            <Group gap="xs">
              <IconAction
                label={t("Puzzle.NewPuzzle")}
                disabled={!effectiveSelectedDb}
                onClick={() => generatePuzzle(effectiveSelectedDb!, true)}
              >
                <Plus />
              </IconAction>
              <IconAction
                label={t("Puzzle.AnalyzePosition")}
                disabled={!effectiveSelectedDb || !turnToMove}
                onClick={() => {
                  void runTabCreation({
                    create: () =>
                      createTab({
                        tab: { name: t("Puzzle.AnalysisTitle"), type: "analysis" },
                        setTabs,
                        pgn: puzzles[currentPuzzle]?.moves.join(" "),
                        headers: {
                          ...defaultTree().headers,
                          fen: puzzles[currentPuzzle]?.fen,
                          orientation: turnToMove === "white" ? "black" : "white",
                        },
                      }),
                    onError: (error) => notifyUnlessCancelled(t("Common.Error"), error),
                  });
                }}
              >
                <ScanSearch />
              </IconAction>
              <IconAction
                label={t("Puzzle.ClearSession")}
                onClick={() => {
                  if (
                    !transition((draft) =>
                      Object.assign(draft, defaultTree(), { puzzleSession: emptyPuzzleSession() }),
                    ).success
                  )
                    return;
                  requestGeneration.current++;
                  puzzleRequest.current?.abort();
                  solutionAbortRef.current?.abort();
                  clearTimer(timer);
                  setIsPlayingSolution(false);
                }}
              >
                <X />
              </IconAction>
            </Group>
          </Group>
          <Group
            grow
            preventGrowOverflow={!sourceControl}
            style={
              sourceControl
                ? {
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 10rem), 1fr))",
                  }
                : undefined
            }
          >
            <Button
              className={sourceControl ? "wrap-button" : undefined}
              mt="sm"
              variant="light"
              fullWidth
              onClick={async () => {
                solutionAbortRef.current?.abort();
                setIsPlayingSolution(false);
                const abortController = new AbortController();
                solutionAbortRef.current = abortController;
                const curPuzzle = puzzles[currentPuzzle];
                const result = validateMoveSequence(curPuzzle.fen, curPuzzle.moves);
                if (!result.success) {
                  notifyUnlessCancelled(commonErrorRef.current, result.error);
                  return;
                }

                const state = store.getState();
                const nextMove = getPuzzleProgress(curPuzzle, state.root, state.position).nextMove;
                if (!nextMove) return;
                if (curPuzzle.completion === "incomplete") {
                  void changeCompletion("incorrect");
                  if (
                    store
                      .getState()
                      .puzzleSession?.attempts.find((attempt) => attempt.attemptId === attemptId)
                      ?.puzzle.completion === "incomplete"
                  )
                    return;
                }

                const from = makeSquare(nextMove.from);
                const to = makeSquare(nextMove.to);
                const currentShapes = store.getState().currentNode().shapes;

                // Progressive hints: circle > arrow > clear
                const hasCircle = currentShapes.some((s) => s.orig === from && !s.dest);
                const hasArrow = currentShapes.some((s) => s.orig === from && s.dest === to);

                if (hasArrow) {
                  // Third click: Remove all hint shapes for this move
                  setShapes(
                    currentShapes.filter((s) => !(s.orig === from && (!s.dest || s.dest === to))),
                  );
                } else if (hasCircle) {
                  // Second click: Replace circle with arrow
                  setShapes([
                    ...currentShapes.filter((s) => !(s.orig === from && !s.dest)),
                    { orig: from, dest: to, brush: "green" },
                  ]);
                } else {
                  // First click: Add circle
                  setShapes([...currentShapes, { orig: from, dest: undefined, brush: "green" }]);
                }
              }}
              disabled={puzzles.length === 0 || !hintMove || isPlayingSolution}
            >
              {t("Puzzle.GetAHint")}
            </Button>
            <Button
              mt="sm"
              variant="light"
              fullWidth
              className={sourceControl ? "wrap-button" : undefined}
              onClick={async () => {
                solutionAbortRef.current?.abort();
                const abortController = new AbortController();
                solutionAbortRef.current = abortController;
                const curPuzzle = puzzles[currentPuzzle];
                const databaseKey = effectiveSelectedDbKey;
                let ownsSession = store.getState().capturePuzzleSessionOwner();
                const isOwner = () =>
                  mounted.current &&
                  ownsSession() &&
                  solutionAbortRef.current === abortController &&
                  !abortController.signal.aborted &&
                  store.getState().puzzleSession?.selectedAttemptId === attemptId &&
                  (effectiveSelectedDbRef.current
                    ? capabilityKey(effectiveSelectedDbRef.current)
                    : null) === databaseKey;
                let ownsPosition = captureTreePositionOwner(store);
                const isCurrent = () => isOwner() && ownsPosition();
                let awaitingCompletionRetry = false;
                setIsPlayingSolution(true);
                try {
                  const result = validateMoveSequence(curPuzzle.fen, curPuzzle.moves);
                  if (!result.success) throw result.error;
                  if (!isCurrent()) return;
                  let state = store.getState();
                  const start = state.headers.start ?? [];
                  if (
                    getBoardState(state.root.fen) !== getBoardState(curPuzzle.fen) ||
                    getResolvedPathLength(state.root, start) !== start.length ||
                    getBoardState(getNodeAtPath(state.root, start).fen) !==
                      getBoardState(curPuzzle.fen)
                  )
                    return;
                  if (curPuzzle.completion === "incomplete") {
                    void changeCompletion("incorrect", isCurrent, () => {
                      ownsSession = store.getState().capturePuzzleSessionOwner();
                      ownsPosition = captureTreePositionOwner(store);
                      state = store.getState();
                    });
                    if (
                      store
                        .getState()
                        .puzzleSession?.attempts.find((attempt) => attempt.attemptId === attemptId)
                        ?.puzzle.completion === "incomplete"
                    ) {
                      awaitingCompletionRetry = true;
                      return;
                    }
                  }
                  if (!isCurrent()) return;
                  goToStart();
                  const started = store.getState();
                  if (
                    !isOwner() ||
                    started.root !== state.root ||
                    started.position.length !== start.length ||
                    !started.position.every((index, i) => index === start[i])
                  )
                    return;
                  ownsPosition = captureTreePositionOwner(store, started);
                  for (const move of result.moves) {
                    if (!isCurrent()) return;
                    try {
                      makeMove({ payload: move, mainline: true });
                    } finally {
                      if (isOwner()) ownsPosition = captureTreePositionOwner(store);
                    }
                    await new Promise((r) => setTimeout(r, 500));
                    if (!isCurrent()) return;
                  }
                } catch (error) {
                  if (isCurrent()) notifyUnlessCancelled(commonErrorRef.current, error);
                } finally {
                  if (solutionAbortRef.current === abortController) {
                    if (!awaitingCompletionRetry) solutionAbortRef.current = null;
                    setIsPlayingSolution(false);
                  }
                }
              }}
              disabled={currentPuzzle < 0}
            >
              {t("Puzzle.ViewSolution")}
            </Button>
          </Group>
        </Paper>
      </Portal>
      <Portal target="#bottomRight" style={{ height: "100%" }}>
        <Stack h="100%" gap="xs">
          <Paper withBorder p="md" mih="5rem">
            <ScrollArea h="100%" offsetScrollbars>
              <ChallengeHistory
                challenges={puzzles.map((p) => ({
                  ...p,
                  label: p.rating?.toString() ?? unavailableValue,
                }))}
                current={currentPuzzle}
                select={(i) => {
                  if (i === currentPuzzle) return;
                  admitPuzzle(puzzles[i], session.attempts[i].attemptId);
                }}
              />
            </ScrollArea>
          </Paper>
          <Stack flex={1} gap="xs">
            <GameNotation />
            <MoveControls readOnly />
          </Stack>
        </Stack>
      </Portal>
    </>
  );
}

export default Puzzles;
