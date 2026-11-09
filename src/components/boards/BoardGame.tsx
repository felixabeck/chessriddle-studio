import { decodeCounter, tauri, tauriSubscriptions, type GameConfigInput } from "@/platform/tauri";
import {
  Box,
  Button,
  Checkbox,
  Divider,
  Group,
  NumberInput,
  Paper,
  Portal,
  ScrollArea,
  SegmentedControl,
  Stack,
  Text,
} from "@mantine/core";
import { useToggle } from "@mantine/hooks";
import { ArrowRightLeft, FileText, Plus, X, ScanSearch } from "lucide-react";
import type { Piece } from "chessops";
import type { Key } from "@lichess-org/chessground/types";
import { makeUci, parseUci } from "chessops";
import { INITIAL_FEN } from "chessops/fen";
import { getDefaultStore, useAtom, useAtomValue } from "jotai";
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { match } from "ts-pattern";
import { useStore } from "zustand";
import type { Outcome } from "@/bindings";
import { type EngineLog, type GameResult, type GameState as NativeGameState } from "@/bindings";
import type { ChessgroundRef } from "@/chessground/Chessground";
import {
  notifyListenerError,
  notifyUnlessCancelled,
  runUnlessCancelled,
} from "@/components/files/notifyError";
import {
  closingTabsAtom,
  enginesAtom,
  flipBoardAfterMoveAtom,
  gameIdFamily,
  gameSessionFamily,
  gameInterruptionFamily,
  gameStateFamily,
  gameInputColorAtom,
  gameOpeningBookEnabledAtom,
  gameOpeningBookMaxPlyAtom,
  gameOpeningBookHandleAtom,
  gamePlayer1SettingsAtom,
  gamePlayer2SettingsAtom,
  gameSameTimeControlAtom,
  pendingGameStartFamily,
  playersFamily,
  tabsAtom,
} from "@/state/atoms";
import { positionFromFen } from "@/utils/chessops";
import { uciNormalize } from "@/utils/chess";
import { isPrefix } from "@/utils/misc";
import { useTauriListener } from "@/platform/useTauriListener";
import { getNodeAtPath, type GameHeaders, type TreeNode } from "@/utils/treeReducer";
import EngineLogsView from "../common/EngineLogsView";
import FileInput from "../common/FileInput";
import GameInfo from "../common/GameInfo";
import GameNotation from "../common/GameNotation";
import MoveControls from "../common/MoveControls";
import NotationColumn from "../common/NotationColumn";
import { TreeStateContext } from "../common/TreeStateContext";
import Board from "./Board";
import IconAction from "../common/IconAction";
import BoardControls from "./BoardControls";
import EditingCard from "./EditingCard";
import { isCurrentQueuedGameUpdate, abortExactGame } from "./gameSession";
import {
  recordGameCommandError,
  translateGameCommandError,
  type GameCommand,
  type GameCommandError,
} from "./gameCommandError";
import { OpponentForm, type OpponentSettings } from "./OpponentForm";
import { hasStartableTimeControl, toPlayerConfig } from "./playerConfig";
import { PRODUCT_NAME } from "@/utils/product.json";
import {
  engineFailureMessage,
  engineTerminalLogs,
} from "../panels/analysis/useDisplayedEngineLines";

function gameResultToOutcome(result: GameResult): Outcome {
  const outcomes = {
    whiteWins: "1-0",
    blackWins: "0-1",
    draw: "1/2-1/2",
    interrupted: "*",
  } satisfies Record<GameResult["type"], Outcome>;
  return outcomes[result.type];
}

const RECONCILIATION_INTERVAL_MS = 1000;
const RECONCILIATION_INITIAL_BACKOFF_MS = 1000;
const RECONCILIATION_BACKOFF_FACTOR = 2;
const RECONCILIATION_MAX_BACKOFF_MS = 8000;

function getMainlineUcis(root: TreeNode): string[] {
  const moves: string[] = [];
  let node = root;
  while (node.children.length > 0) {
    node = node.children[0];
    if (node.move) {
      moves.push(makeUci(node.move));
    }
  }
  return moves;
}

type BackendMove = { uci: string; clock: number | null; fenAfter?: string };

type GameCommandContext = {
  gameId: string;
  session: bigint;
  generation: number;
};

type GameCommandOptions<TResult, TReturn> = {
  command: GameCommand;
  unavailable: TReturn;
  action: (context: GameCommandContext) => Promise<TResult>;
  onSuccess: (result: TResult, context: GameCommandContext) => TReturn | Promise<TReturn>;
  recover?: (context: GameCommandContext) => Promise<NativeGameState>;
  canApplySuccess?: (result: TResult, context: GameCommandContext) => boolean;
};

function mapBackendMoves(
  moves: { uci: string; clock: bigint | null; fenAfter?: string }[],
): BackendMove[] {
  return moves.map((m) => ({
    uci: m.uci,
    clock: m.clock !== null ? Number(m.clock) : null,
    fenAfter: m.fenAfter,
  }));
}

function BoardGame({ tabId: ownerTabId }: { tabId: string }) {
  const { t } = useTranslation();
  const tRef = useRef(t);
  tRef.current = t;
  const atomStore = getDefaultStore();
  const {
    ownerGameStateAtom,
    ownerPlayersAtom,
    ownerGameIdAtom,
    ownerSessionAtom,
    ownerPendingStartAtom,
    ownerInterruptionAtom,
  } = useMemo(
    () => ({
      ownerGameStateAtom: gameStateFamily(ownerTabId),
      ownerPlayersAtom: playersFamily(ownerTabId),
      ownerGameIdAtom: gameIdFamily(ownerTabId),
      ownerSessionAtom: gameSessionFamily(ownerTabId),
      ownerPendingStartAtom: pendingGameStartFamily(ownerTabId),
      ownerInterruptionAtom: gameInterruptionFamily(ownerTabId),
    }),
    [ownerTabId],
  );

  const [editingMode, toggleEditingMode] = useToggle();
  const [selectedPiece, setSelectedPiece] = useState<Piece | null>(null);

  const [inputColor, setInputColor] = useAtom(gameInputColorAtom);
  function cycleColor() {
    setInputColor((prev) =>
      match(prev)
        .with("white", () => "black" as const)
        .with("black", () => "random" as const)
        .with("random", () => "white" as const)
        .exhaustive(),
    );
  }

  const [player1Settings, setPlayer1Settings] = useAtom(gamePlayer1SettingsAtom);
  const [player2Settings, setPlayer2Settings] = useAtom(gamePlayer2SettingsAtom);

  function getPlayers() {
    let isPlayer1White = inputColor === "white";

    if (inputColor === "random") {
      isPlayer1White = Math.random() > 0.5;
    }

    return {
      white: isPlayer1White ? player1Settings : player2Settings,
      black: isPlayer1White ? player2Settings : player1Settings,
    };
  }

  const store = useContext(TreeStateContext)!;
  const root = useStore(store, (s) => s.root);
  const headers = useStore(store, (s) => s.headers);
  const resetTree = useStore(store, (s) => s.reset);
  const initialFenRef = useRef(root.fen);

  const [, setTabs] = useAtom(tabsAtom);
  const autoFlipBoard = useAtomValue(flipBoardAfterMoveAtom);
  const closingTabs = useAtomValue(closingTabsAtom);
  const isTabClosing = closingTabs.has(ownerTabId);

  const boardRef = useRef(null);
  const cgRef = useRef<ChessgroundRef>(null);
  const gameState = useAtomValue(ownerGameStateAtom);
  const players = useAtomValue(ownerPlayersAtom);

  const [whiteTime, setWhiteTime] = useState<number | null>(null);
  const [blackTime, setBlackTime] = useState<number | null>(null);
  const gameId = useAtomValue(ownerGameIdAtom);
  const backendSession = useAtomValue(ownerSessionAtom);
  const liveGameIdRef = useRef<string | null>(gameId);
  liveGameIdRef.current = gameId;
  const sessionGenerationRef = useRef(0);
  const backendSessionRef = useRef<bigint | null>(backendSession);
  backendSessionRef.current = backendSession;
  const moveRevisionRef = useRef(BigInt(-1));
  const clockRevisionRef = useRef(BigInt(-1));
  const pendingMovesRef = useRef<{
    moves: { uci: string; clock: number | null }[];
    revision: bigint;
  } | null>(null);
  const pendingTimesRef = useRef<{
    white: number | null;
    black: number | null;
    revision: bigint;
  } | null>(null);
  const queuedUpdateGenerationRef = useRef<number | null>(null);
  const queuedUpdateGameIdRef = useRef<string | null>(null);
  const queuedUpdateSessionRef = useRef<bigint | null>(null);
  const throttleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const premoveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const commandTokenRef = useRef<symbol | null>(null);
  const logSequenceRef = useRef(0);
  const logsOpenedRef = useRef(false);
  const mountedRef = useRef(true);
  mountedRef.current = true;
  const mountLeaseRef = useRef<symbol | null>(null);
  const reconciliationInFlightRef = useRef(false);
  const reconciliationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconciliationPollRef = useRef<(() => Promise<void>) | null>(null);
  const reconciliationScheduleRef = useRef<((delayMs: number) => void) | null>(null);
  const reconciliationBackoffMsRef = useRef(RECONCILIATION_INITIAL_BACKOFF_MS);
  const reconciliationOutageNotifiedRef = useRef(false);
  const reconciliationRequestIdRef = useRef(0);
  const reconciliationValidAfterRequestIdRef = useRef(0);
  const [pendingCommand, setPendingCommand] = useState<
    "start" | "move" | "takeback" | "abort" | "resign" | null
  >(null);
  const [commandError, setCommandError] = useState<GameCommandError | null>(null);
  const [interruption, setInterruption] = useAtom(ownerInterruptionAtom);
  useEffect(() => {
    if (gameState === "settingUp") setInterruption(null);
  }, [gameState, setInterruption]);
  const clearQueuedGameUpdates = useCallback(() => {
    if (throttleTimerRef.current) clearTimeout(throttleTimerRef.current);
    if (premoveTimerRef.current) clearTimeout(premoveTimerRef.current);
    throttleTimerRef.current = null;
    premoveTimerRef.current = null;
    pendingMovesRef.current = null;
    pendingTimesRef.current = null;
    queuedUpdateGenerationRef.current = null;
    queuedUpdateGameIdRef.current = null;
    queuedUpdateSessionRef.current = null;
  }, []);
  const ownerTabExists = useCallback(
    () => atomStore.get(tabsAtom).some((tab) => tab.value === ownerTabId),
    [atomStore, ownerTabId],
  );
  const ownsMountedOwner = useCallback(
    () => mountedRef.current && ownerTabExists(),
    [ownerTabExists],
  );
  const ownsUiEpoch = useCallback(
    (generation: number) => ownsMountedOwner() && sessionGenerationRef.current === generation,
    [ownsMountedOwner],
  );
  const ownsUiSession = useCallback(
    (ownedGameId: string, ownedSession: bigint, generation: number) =>
      ownsUiEpoch(generation) &&
      liveGameIdRef.current === ownedGameId &&
      backendSessionRef.current === ownedSession &&
      atomStore.get(ownerGameIdAtom) === ownedGameId &&
      atomStore.get(ownerSessionAtom) === ownedSession,
    [atomStore, ownerGameIdAtom, ownerSessionAtom, ownsUiEpoch],
  );
  const clearOwnershipIfMatches = useCallback(
    (ownedGameId: string, ownedSession: bigint) => {
      const refsMatch =
        liveGameIdRef.current === ownedGameId && backendSessionRef.current === ownedSession;
      const atomsMatch =
        atomStore.get(ownerGameIdAtom) === ownedGameId &&
        atomStore.get(ownerSessionAtom) === ownedSession;
      if (refsMatch) {
        liveGameIdRef.current = null;
        backendSessionRef.current = null;
      }
      if (atomsMatch) {
        atomStore.set(ownerGameIdAtom, null);
        atomStore.set(ownerSessionAtom, null);
      }
      return atomsMatch;
    },
    [atomStore, ownerGameIdAtom, ownerSessionAtom],
  );
  const invalidateUiSession = useCallback(
    (preserveCommandToken?: symbol) => {
      clearQueuedGameUpdates();
      if (reconciliationTimerRef.current !== null) {
        clearTimeout(reconciliationTimerRef.current);
        reconciliationTimerRef.current = null;
      }
      reconciliationPollRef.current = null;
      reconciliationScheduleRef.current = null;
      reconciliationBackoffMsRef.current = RECONCILIATION_INITIAL_BACKOFF_MS;
      reconciliationOutageNotifiedRef.current = false;
      reconciliationValidAfterRequestIdRef.current = reconciliationRequestIdRef.current + 1;
      sessionGenerationRef.current += 1;
      if (!preserveCommandToken || commandTokenRef.current !== preserveCommandToken) {
        commandTokenRef.current = null;
        setPendingCommand(null);
      }
      setCommandError(null);
      logSequenceRef.current += 1;
    },
    [clearQueuedGameUpdates],
  );

  const cleanupExactIdentity = useCallback(
    async (
      ownedGameId: string,
      ownedSession: bigint,
      options: { finish?: true } = {},
    ): Promise<boolean> => {
      await abortExactGame(ownedGameId, ownedSession, (id, session) =>
        tauri.abortGame(id, session),
      );
      const retiredOwnedAtoms = clearOwnershipIfMatches(ownedGameId, ownedSession);
      if (options.finish && retiredOwnedAtoms && ownerTabExists()) {
        atomStore.set(ownerGameStateAtom, "gameOver");
      }
      return retiredOwnedAtoms;
    },
    [atomStore, clearOwnershipIfMatches, ownerGameStateAtom, ownerTabExists],
  );

  const [logsOpened, toggleLogsOpened] = useToggle();
  logsOpenedRef.current = logsOpened;
  const [logsColor, setLogsColor] = useState<"white" | "black">("white");
  const [engineLogs, setEngineLogs] = useState<EngineLog[]>([]);
  const [openingBookHandle, setOpeningBookHandle] = useAtom(gameOpeningBookHandleAtom);
  const [openingBookEnabled, setOpeningBookEnabled] = useAtom(gameOpeningBookEnabledAtom);
  const [openingBookMaxPly, setOpeningBookMaxPly] = useAtom(gameOpeningBookMaxPlyAtom);

  const hasEngine = players.white.type === "engine" || players.black.type === "engine";
  const selectedLogsColor =
    players.white.type === "human" && players.black.type === "engine"
      ? "black"
      : players.black.type === "human" && players.white.type === "engine"
        ? "white"
        : logsColor;
  const terminalSnapshot =
    interruption?.engineColor === selectedLogsColor ? interruption.snapshot : null;
  const terminalLogs = terminalSnapshot ? engineTerminalLogs(t, terminalSnapshot.entries) : null;

  const isPlayerVsEngine =
    (players.white.type === "human" && players.black.type === "engine") ||
    (players.black.type === "human" && players.white.type === "engine");

  const toggleOrientation = useCallback(() => {
    const tree = store.getState();
    const currentOrientation = tree.headers.orientation || "white";
    tree.setHeaders({
      ...tree.headers,
      fen: tree.root.fen,
      orientation: currentOrientation === "black" ? "white" : "black",
    });
  }, [store]);

  const fetchEngineLogs = useCallback(async () => {
    const expectedSession = backendSession;
    if (!gameId || expectedSession === null || !hasEngine || terminalSnapshot) return;
    const generation = sessionGenerationRef.current;
    if (!ownsUiSession(gameId, expectedSession, generation)) return;
    const request = ++logSequenceRef.current;
    try {
      const logs = await tauri.getGameEngineLogs(gameId, expectedSession, selectedLogsColor);
      if (
        request === logSequenceRef.current &&
        logsOpenedRef.current &&
        ownsUiSession(gameId, expectedSession, generation)
      ) {
        setEngineLogs(logs);
      }
    } catch (error) {
      if (
        request === logSequenceRef.current &&
        logsOpenedRef.current &&
        ownsUiSession(gameId, expectedSession, generation)
      ) {
        notifyUnlessCancelled(tRef.current("Common.Error"), error);
      }
    }
  }, [gameId, selectedLogsColor, terminalSnapshot, hasEngine, backendSession, ownsUiSession]);

  useEffect(() => {
    logSequenceRef.current += 1;
    if (logsOpened) void fetchEngineLogs();
  }, [logsColor, logsOpened, fetchEngineLogs]);

  const changeLogsColor = useCallback(
    (value: "white" | "black") => {
      if (value === logsColor) return;
      logSequenceRef.current += 1;
      setLogsColor(value);
    },
    [logsColor],
  );

  const syncTreeWithMoves = useCallback(
    (backendMoves: BackendMove[]) => {
      let changed = false;
      for (let i = 0; i < backendMoves.length; i++) {
        const move = backendMoves[i];
        const parentPath = Array(i).fill(0);
        const parentNode = getNodeAtPath(store.getState().root, parentPath);
        const parsed = parseUci(move.uci);
        const parentPosition = parentNode ? positionFromFen(parentNode.fen)[0] : null;
        const matchingChildIndex = parentNode?.children.findIndex(
          (child) =>
            child.move &&
            parsed &&
            parentPosition &&
            uciNormalize(parentPosition, child.move) === uciNormalize(parentPosition, parsed),
        );
        if (matchingChildIndex === 0) continue;
        if (matchingChildIndex !== undefined && matchingChildIndex > 0) {
          store.getState().promoteToMainline([...parentPath, matchingChildIndex]);
          changed = true;
          continue;
        }

        if (parsed) {
          if (parentNode && parentNode.children.length > 0) {
            store.getState().goToMove(parentPath);
            store.getState().makeMove({
              payload: parsed,
              mainline: true,
              clock: move.clock !== null ? Number(move.clock) : undefined,
            });
          } else {
            store.getState().appendMove({
              payload: parsed,
              clock: move.clock !== null ? Number(move.clock) : undefined,
            });
          }
          changed = true;
        }
      }

      const endpointPath = Array(backendMoves.length).fill(0);
      let endpoint = getNodeAtPath(store.getState().root, endpointPath);
      while (endpoint && endpoint.children.length > 0) {
        store.getState().deleteMove([...endpointPath, 0]);
        changed = true;
        endpoint = getNodeAtPath(store.getState().root, endpointPath);
      }
      return changed;
    },
    [store],
  );

  function changeToAnalysisMode() {
    setTabs((prev) =>
      prev.map((tab) => (tab.value === ownerTabId ? { ...tab, type: "analysis" } : tab)),
    );
  }

  const [pos, error] = useMemo(() => {
    let node = root;
    while (node.children.length > 0) {
      node = node.children[0];
    }
    return positionFromFen(node.fen);
  }, [root]);

  function getTreeMoves(): string[] {
    return getMainlineUcis(root);
  }

  const syncTreeWithMovesRef = useRef(syncTreeWithMoves);
  syncTreeWithMovesRef.current = syncTreeWithMoves;

  const applyTerminalResult = useCallback(
    (
      result: GameResult,
      moves: BackendMove[],
      ownedGameId: string,
      ownedSession: bigint,
      generation: number,
      revision: bigint,
    ): boolean => {
      if (
        !ownsUiSession(ownedGameId, ownedSession, generation) ||
        revision < moveRevisionRef.current
      )
        return false;
      moveRevisionRef.current = revision;
      syncTreeWithMovesRef.current(moves);
      invalidateUiSession();
      clearOwnershipIfMatches(ownedGameId, ownedSession);
      atomStore.set(ownerGameStateAtom, "gameOver");
      store.getState().setResult(gameResultToOutcome(result));
      const configuredPlayers = atomStore.get(ownerPlayersAtom);
      const terminalFen = moves.at(-1)?.fenAfter ?? initialFenRef.current;
      const engineColor =
        configuredPlayers.white.type === "engine" && configuredPlayers.black.type === "human"
          ? "white"
          : configuredPlayers.black.type === "engine" && configuredPlayers.white.type === "human"
            ? "black"
            : (positionFromFen(terminalFen)[0]?.turn ?? null);
      setInterruption(result.type === "interrupted" ? { ...result, engineColor } : null);
      return true;
    },
    [
      ownsUiSession,
      invalidateUiSession,
      clearOwnershipIfMatches,
      atomStore,
      ownerGameStateAtom,
      ownerPlayersAtom,
      setInterruption,
      store,
    ],
  );

  const applyAuthoritativeState = useCallback(
    (
      state: NativeGameState,
      ownedGameId: string,
      ownedSession: bigint,
      generation: number,
      initialize = false,
    ): boolean => {
      if (
        !ownsUiSession(ownedGameId, ownedSession, generation) ||
        state.gameId !== ownedGameId ||
        state.session !== ownedSession
      ) {
        return false;
      }
      if (state.revision < moveRevisionRef.current) return false;
      if (atomStore.get(ownerGameStateAtom) === "gameOver" && state.status === "playing") {
        return false;
      }

      initialFenRef.current = state.initialFen;
      if (initialize) store.getState().setFen(state.initialFen);
      if (state.revision > clockRevisionRef.current) {
        clockRevisionRef.current = state.revision;
        setWhiteTime(state.whiteTime !== null ? Number(state.whiteTime) : null);
        setBlackTime(state.blackTime !== null ? Number(state.blackTime) : null);
      }

      if (state.status === "playing") {
        syncTreeWithMovesRef.current(mapBackendMoves(state.moves));
        moveRevisionRef.current = state.revision;
        atomStore.set(ownerGameStateAtom, "playing");
      } else {
        return applyTerminalResult(
          state.status.finished.result,
          mapBackendMoves(state.moves),
          ownedGameId,
          ownedSession,
          generation,
          state.revision,
        );
      }
      return true;
    },
    [atomStore, applyTerminalResult, ownerGameStateAtom, ownsUiSession, store],
  );

  async function startGame() {
    if (
      !ownsMountedOwner() ||
      atomStore.get(closingTabsAtom).has(ownerTabId) ||
      atomStore.get(ownerPendingStartAtom)
    )
      return;
    const generation = sessionGenerationRef.current + 1;
    const admission = Promise.withResolvers<void>();
    const startToken = Symbol("start");
    commandTokenRef.current = startToken;
    setPendingCommand("start");
    setCommandError(null);
    const run = async () => {
      try {
        const retainedGameId = liveGameIdRef.current;
        const retainedSession = backendSessionRef.current;
        if (retainedGameId && retainedSession !== null) {
          await cleanupExactIdentity(retainedGameId, retainedSession);
        }
        if (
          !ownsMountedOwner() ||
          atomStore.get(closingTabsAtom).has(ownerTabId) ||
          sessionGenerationRef.current + 1 !== generation
        )
          return;

        invalidateUiSession(startToken);
        setInterruption(null);
        setPendingCommand("start");
        moveRevisionRef.current = BigInt(-1);
        clockRevisionRef.current = BigInt(-1);
        const playerSettings = getPlayers();
        atomStore.set(ownerPlayersAtom, playerSettings);
        // The engine list is read at submission time, not at selection time: an engine removed
        // after the form was filled in has a permanently retired id (d-20260901-17).
        const availableEngines = atomStore.get(enginesAtom);

        const boardOrientation =
          playerSettings.black.type === "human" && playerSettings.white.type === "engine"
            ? "black"
            : "white";

        // Events carry gameId, session and revision. A unique gameId still permits safe
        // correlation when a malformed session counter cannot be normalized.
        const newGameId = `${ownerTabId}-game-${crypto.randomUUID()}`;

        const initialMoves = getTreeMoves();

        const config: GameConfigInput = {
          white: toPlayerConfig(playerSettings.white, availableEngines),
          black: toPlayerConfig(playerSettings.black, availableEngines),
          whiteTimeControl: playerSettings.white.timeControl
            ? {
                initialTime: playerSettings.white.timeControl.seconds,
                increment: playerSettings.white.timeControl.increment ?? 0,
              }
            : null,
          blackTimeControl: playerSettings.black.timeControl
            ? {
                initialTime: playerSettings.black.timeControl.seconds,
                increment: playerSettings.black.timeControl.increment ?? 0,
              }
            : null,
          initialFen: root.fen === INITIAL_FEN ? null : root.fen,
          initialMoves,
          openingBook:
            openingBookEnabled && openingBookHandle
              ? { book: openingBookHandle, maxPly: Math.max(1, openingBookMaxPly) }
              : null,
        };

        const state = await tauri.startGame(newGameId, config);
        liveGameIdRef.current = newGameId;
        backendSessionRef.current = state.session;
        atomStore.set(ownerGameIdAtom, newGameId);
        atomStore.set(ownerSessionAtom, state.session);

        if (
          !ownsUiSession(newGameId, state.session, generation) ||
          atomStore.get(closingTabsAtom).has(ownerTabId)
        ) {
          try {
            await cleanupExactIdentity(newGameId, state.session, { finish: true });
          } catch (error) {
            notifyUnlessCancelled(tRef.current("Common.Error"), error);
          }
          return;
        }
        applyAuthoritativeState(state, newGameId, state.session, generation, true);

        const now = new Date();
        const dateStr = now.toISOString().slice(0, 10).replace(/-/g, ".");
        const timeStr = now.toISOString().slice(11, 19);

        const whiteIsEngine = playerSettings.white.type === "engine";
        const blackIsEngine = playerSettings.black.type === "engine";
        let eventStr = "Casual Game";
        if (whiteIsEngine && blackIsEngine) {
          eventStr = "Engine Match";
        } else if (whiteIsEngine || blackIsEngine) {
          eventStr = "Player vs Engine";
        } else {
          eventStr = "Player Match";
        }

        const formatTimeControl = (settings: OpponentSettings): string => {
          if (!settings.timeControl) return "-";
          const seconds = settings.timeControl.seconds / 1000;
          const increment = (settings.timeControl.increment ?? 0) / 1000;
          return increment ? `${seconds}+${increment}` : `${seconds}`;
        };

        const whiteTimeControl = formatTimeControl(playerSettings.white);
        const blackTimeControl = formatTimeControl(playerSettings.black);
        const sameTimeControl = whiteTimeControl === blackTimeControl;

        const newHeaders: Partial<GameHeaders> = {
          white: state.whitePlayer,
          black: state.blackPlayer,
          event: eventStr,
          site: PRODUCT_NAME,
          date: dateStr,
          time: timeStr,
          time_control: undefined,
          orientation: boardOrientation,
        };

        if (sameTimeControl) {
          if (whiteTimeControl !== "-") {
            newHeaders.time_control = whiteTimeControl;
          }
        } else {
          newHeaders.white_time_control = whiteTimeControl;
          newHeaders.black_time_control = blackTimeControl;
        }

        store.getState().setHeaders({
          ...store.getState().headers,
          ...newHeaders,
          fen: state.initialFen,
        });

        setTabs((prev) =>
          prev.map((tab) =>
            tab.value === ownerTabId
              ? { ...tab, name: `${state.whitePlayer} vs. ${state.blackPlayer}` }
              : tab,
          ),
        );
      } catch (err) {
        if (ownsMountedOwner() && commandTokenRef.current === startToken) {
          setCommandError(
            recordGameCommandError("start", err, {
              tabId: ownerTabId,
              generation,
            }),
          );
        }
      } finally {
        if (atomStore.get(ownerPendingStartAtom) === admission.promise) {
          atomStore.set(ownerPendingStartAtom, null);
        }
        if (commandTokenRef.current === startToken) {
          commandTokenRef.current = null;
          if (ownsMountedOwner()) setPendingCommand(null);
        }
      }
    };
    atomStore.set(ownerPendingStartAtom, admission.promise);
    void run().then(admission.resolve, admission.reject);
    await admission.promise;
  }

  const runGameCommand = useCallback(
    async <TResult, TReturn>({
      command,
      unavailable,
      action,
      onSuccess,
      recover,
      canApplySuccess,
    }: GameCommandOptions<TResult, TReturn>): Promise<TReturn> => {
      if (!gameId || gameState !== "playing") return unavailable;
      const session = backendSessionRef.current;
      if (session === null || commandTokenRef.current !== null) return unavailable;
      const generation = sessionGenerationRef.current;
      const token = Symbol(command);
      const context = { gameId, session, generation };
      const ownsToken = () => commandTokenRef.current === token;
      if (!ownsUiSession(gameId, session, generation)) return unavailable;
      const ownsCommandSession = () => ownsToken() && ownsUiSession(gameId, session, generation);

      commandTokenRef.current = token;
      setPendingCommand(command);
      setCommandError(null);
      try {
        const result = await action(context);
        if (!ownsToken()) return unavailable;
        if (canApplySuccess ? !canApplySuccess(result, context) : !ownsCommandSession()) {
          return unavailable;
        }
        return await onSuccess(result, context);
      } catch (error) {
        if (ownsCommandSession()) {
          setCommandError(
            recordGameCommandError(command, error, {
              tabId: ownerTabId,
              generation,
              gameId,
              session,
            }),
          );
          if (recover) {
            try {
              const recovered = await recover(context);
              if (ownsCommandSession()) {
                applyAuthoritativeState(recovered, gameId, session, generation);
              }
            } catch (recoveryError) {
              if (ownsCommandSession()) {
                notifyUnlessCancelled(tRef.current("Common.Error"), recoveryError);
              }
            }
          }
        }
        return unavailable;
      } finally {
        if (commandTokenRef.current === token) {
          commandTokenRef.current = null;
          if (ownsMountedOwner()) setPendingCommand(null);
        }
      }
    },
    [applyAuthoritativeState, gameId, gameState, ownerTabId, ownsMountedOwner, ownsUiSession],
  );

  const handleHumanMove = useCallback(
    (uci: string): Promise<boolean> => {
      const { position } = store.getState();
      if (position.some((index) => index !== 0)) return Promise.resolve(false);
      return runGameCommand({
        command: "move",
        unavailable: false,
        action: ({ gameId, session }) => tauri.makeGameMove(gameId, session, uci, position.length),
        onSuccess: (state, { gameId, session, generation }) => {
          if (state.gameId !== gameId || state.session !== session) return false;
          applyAuthoritativeState(state, gameId, session, generation);
          if (!isPlayerVsEngine && autoFlipBoard) toggleOrientation();
          return true;
        },
        recover: ({ gameId, session }) => tauri.getGameState(gameId, session),
      });
    },
    [
      applyAuthoritativeState,
      autoFlipBoard,
      isPlayerVsEngine,
      runGameCommand,
      store,
      toggleOrientation,
    ],
  );

  const queueKeyboardPremove = useCallback(
    (from: Key, to: Key) => {
      const ownedGameId = liveGameIdRef.current;
      const ownedSession = backendSessionRef.current;
      if (
        !ownedGameId ||
        ownedSession === null ||
        !ownsUiSession(ownedGameId, ownedSession, sessionGenerationRef.current)
      ) {
        return false;
      }
      return cgRef.current?.queuePremove(from, to) ?? false;
    },
    [ownsUiSession],
  );

  const THROTTLE_MS = 150;

  const scheduleDeferredPremove = useCallback(
    (targetGameId: string, targetSession: bigint, targetGeneration: number) => {
      if (premoveTimerRef.current) {
        clearTimeout(premoveTimerRef.current);
        premoveTimerRef.current = null;
      }
      premoveTimerRef.current = setTimeout(() => {
        if (
          isCurrentQueuedGameUpdate(
            targetGeneration,
            sessionGenerationRef.current,
            targetSession,
            backendSessionRef.current,
          ) &&
          ownsUiSession(targetGameId, targetSession, targetGeneration)
        ) {
          cgRef.current?.playPremove();
        }
        premoveTimerRef.current = null;
      }, 0);
    },
    [ownsUiSession],
  );

  const applyPendingUpdates = useCallback(() => {
    const queuedGeneration = queuedUpdateGenerationRef.current;
    const queuedGameId = queuedUpdateGameIdRef.current;
    const queuedSession = queuedUpdateSessionRef.current;
    const isCurrent =
      isCurrentQueuedGameUpdate(
        queuedGeneration,
        sessionGenerationRef.current,
        queuedSession,
        backendSessionRef.current,
      ) &&
      queuedGeneration !== null &&
      queuedGameId !== null &&
      queuedSession !== null &&
      ownsUiSession(queuedGameId, queuedSession, queuedGeneration);
    throttleTimerRef.current = null;
    if (!isCurrent) {
      clearQueuedGameUpdates();
      return;
    }
    if (pendingMovesRef.current && pendingMovesRef.current.revision === moveRevisionRef.current) {
      syncTreeWithMovesRef.current(pendingMovesRef.current.moves);
      pendingMovesRef.current = null;
    }
    if (pendingTimesRef.current && pendingTimesRef.current.revision === clockRevisionRef.current) {
      setWhiteTime(pendingTimesRef.current.white);
      setBlackTime(pendingTimesRef.current.black);
      pendingTimesRef.current = null;
    }
    queuedUpdateGenerationRef.current = null;
    queuedUpdateGameIdRef.current = null;
    queuedUpdateSessionRef.current = null;

    if (queuedGeneration !== null && queuedGameId !== null && queuedSession !== null) {
      scheduleDeferredPremove(queuedGameId, queuedSession, queuedGeneration);
    }
  }, [clearQueuedGameUpdates, ownsUiSession, scheduleDeferredPremove]);

  const scheduleUpdate = useCallback(() => {
    if (!throttleTimerRef.current) {
      throttleTimerRef.current = setTimeout(applyPendingUpdates, THROTTLE_MS);
    }
  }, [applyPendingUpdates]);

  const onTakeBack = useCallback(
    () =>
      runGameCommand({
        command: "takeback",
        unavailable: undefined,
        action: ({ gameId, session }) => tauri.takeBackGameMove(gameId, session),
        onSuccess: (state, { gameId, session, generation }) => {
          applyAuthoritativeState(state, gameId, session, generation);
        },
      }),
    [applyAuthoritativeState, runGameCommand],
  );

  const reportGameEventError = useCallback(
    (error: unknown, event?: { payload?: unknown }) => {
      if (!event?.payload) {
        if (ownsMountedOwner()) notifyListenerError(error);
        return;
      }
      const ownedGameId = liveGameIdRef.current;
      const ownedSession = backendSessionRef.current;
      const generation = sessionGenerationRef.current;
      if (
        !ownedGameId ||
        ownedSession === null ||
        !ownsUiSession(ownedGameId, ownedSession, generation)
      ) {
        return;
      }
      const payload = event.payload as { gameId?: unknown; session?: unknown };
      if (payload.gameId !== ownedGameId) return;
      try {
        if (decodeCounter(payload.session, "session") !== ownedSession) return;
      } catch {
        // The current valid owner pair plus its unique game id correlate this error;
        // the malformed counter itself is never accepted as a session identity.
      }
      notifyListenerError(error);
    },
    [ownsMountedOwner, ownsUiSession],
  );

  useTauriListener(
    tauriSubscriptions.gameMove,
    ({ payload }) => {
      if (
        atomStore.get(ownerGameStateAtom) !== "playing" ||
        !ownsUiSession(payload.gameId, payload.session, sessionGenerationRef.current) ||
        payload.revision <= moveRevisionRef.current
      )
        return;

      moveRevisionRef.current = payload.revision;
      pendingMovesRef.current = {
        moves: mapBackendMoves(payload.moves),
        revision: payload.revision,
      };
      if (payload.revision > clockRevisionRef.current) {
        clockRevisionRef.current = payload.revision;
        pendingTimesRef.current = {
          white: payload.whiteTime !== null ? Number(payload.whiteTime) : null,
          black: payload.blackTime !== null ? Number(payload.blackTime) : null,
          revision: payload.revision,
        };
      }
      queuedUpdateGenerationRef.current = sessionGenerationRef.current;
      queuedUpdateGameIdRef.current = payload.gameId;
      queuedUpdateSessionRef.current = payload.session;
      scheduleUpdate();
    },
    { onError: reportGameEventError },
  );

  useTauriListener(
    tauriSubscriptions.clockUpdate,
    ({ payload }) => {
      if (
        atomStore.get(ownerGameStateAtom) !== "playing" ||
        !ownsUiSession(payload.gameId, payload.session, sessionGenerationRef.current) ||
        payload.revision <= clockRevisionRef.current
      )
        return;
      clockRevisionRef.current = payload.revision;
      setWhiteTime(payload.whiteTime !== null ? Number(payload.whiteTime) : null);
      setBlackTime(payload.blackTime !== null ? Number(payload.blackTime) : null);
    },
    { onError: reportGameEventError },
  );

  useTauriListener(
    tauriSubscriptions.gameOver,
    ({ payload }) => {
      if (
        atomStore.get(ownerGameStateAtom) !== "playing" ||
        !ownsUiSession(payload.gameId, payload.session, sessionGenerationRef.current) ||
        payload.revision < moveRevisionRef.current
      )
        return;

      applyTerminalResult(
        payload.result,
        mapBackendMoves(payload.moves),
        payload.gameId,
        payload.session,
        sessionGenerationRef.current,
        payload.revision,
      );
    },
    { onError: reportGameEventError },
  );

  useEffect(() => {
    return () => {
      clearQueuedGameUpdates();
    };
  }, [clearQueuedGameUpdates]);

  useEffect(() => {
    if (gameState !== "playing" || !gameId) {
      if (reconciliationTimerRef.current !== null) {
        clearTimeout(reconciliationTimerRef.current);
        reconciliationTimerRef.current = null;
      }
      reconciliationPollRef.current = null;
      reconciliationScheduleRef.current = null;
      return;
    }
    const polledGameId = gameId;
    const expectedSession = backendSessionRef.current;
    if (expectedSession === null) return;
    const generation = sessionGenerationRef.current;

    if (isTabClosing) {
      if (reconciliationTimerRef.current !== null) {
        clearTimeout(reconciliationTimerRef.current);
        reconciliationTimerRef.current = null;
      }
      reconciliationPollRef.current = null;
      reconciliationScheduleRef.current = null;
      reconciliationValidAfterRequestIdRef.current = reconciliationRequestIdRef.current + 1;
      return;
    }

    const isCurrentEpoch = () =>
      ownsMountedOwner() &&
      !atomStore.get(closingTabsAtom).has(ownerTabId) &&
      ownsUiSession(polledGameId, expectedSession, generation) &&
      atomStore.get(ownerGameStateAtom) === "playing";

    if (!isCurrentEpoch()) return;

    const scheduleNext = (delayMs: number) => {
      if (!isCurrentEpoch() || reconciliationTimerRef.current !== null) return;
      reconciliationTimerRef.current = setTimeout(() => {
        reconciliationTimerRef.current = null;
        void reconciliationPollRef.current?.();
      }, delayMs);
    };

    const poll = async () => {
      if (!isCurrentEpoch() || reconciliationInFlightRef.current) return;
      reconciliationInFlightRef.current = true;
      const requestId = ++reconciliationRequestIdRef.current;
      let nextDelay = RECONCILIATION_INTERVAL_MS;

      try {
        const state = await tauri.getGameState(polledGameId, expectedSession);
        const canApply =
          isCurrentEpoch() && requestId >= reconciliationValidAfterRequestIdRef.current;

        if (canApply) {
          reconciliationBackoffMsRef.current = RECONCILIATION_INITIAL_BACKOFF_MS;
          reconciliationOutageNotifiedRef.current = false;

          let eligibleForPremove = false;
          if (state.status === "playing" && isPlayerVsEngine) {
            const nextTurnIsHuman =
              state.turn === "white"
                ? players.white.type === "human"
                : players.black.type === "human";
            if (nextTurnIsHuman) {
              const currentLiveMoves = getMainlineUcis(store.getState().root);
              const backendUcis = state.moves.map((m) => m.uci);
              if (
                backendUcis.length > currentLiveMoves.length &&
                isPrefix(currentLiveMoves, backendUcis)
              ) {
                eligibleForPremove = true;
              }
            }
          }

          const applied = applyAuthoritativeState(state, polledGameId, expectedSession, generation);

          if (applied && eligibleForPremove) {
            scheduleDeferredPremove(polledGameId, expectedSession, generation);
          }
        }
      } catch (error) {
        const canReport =
          isCurrentEpoch() && requestId >= reconciliationValidAfterRequestIdRef.current;

        if (canReport) {
          if (!reconciliationOutageNotifiedRef.current) {
            reconciliationOutageNotifiedRef.current = true;
            notifyUnlessCancelled(tRef.current("Common.Error"), error);
          }

          nextDelay = reconciliationBackoffMsRef.current;
          reconciliationBackoffMsRef.current = Math.min(
            reconciliationBackoffMsRef.current * RECONCILIATION_BACKOFF_FACTOR,
            RECONCILIATION_MAX_BACKOFF_MS,
          );
        }
      } finally {
        reconciliationInFlightRef.current = false;
        reconciliationScheduleRef.current?.(nextDelay);
      }
    };

    reconciliationPollRef.current = poll;
    reconciliationScheduleRef.current = scheduleNext;

    if (!reconciliationInFlightRef.current && reconciliationTimerRef.current === null) {
      void poll();
    }
  }, [
    gameId,
    gameState,
    applyAuthoritativeState,
    backendSession,
    ownsMountedOwner,
    ownsUiSession,
    atomStore,
    ownerGameStateAtom,
    ownerTabId,
    players,
    isPlayerVsEngine,
    scheduleDeferredPremove,
    store,
    isTabClosing,
  ]);

  const movable = useMemo(() => {
    if (players.white.type === "human" && players.black.type === "human") {
      return "turn";
    }
    if (players.white.type === "human") {
      return "white";
    }
    if (players.black.type === "human") {
      return "black";
    }
    return "none";
  }, [players]);

  const [sameTimeControl, setSameTimeControl] = useAtom(gameSameTimeControlAtom);

  const onePlayerIsEngine = players.white.type !== players.black.type;
  const isEngineVsEngine = players.white.type === "engine" && players.black.type === "engine";

  function getResignationLosingColor(): "white" | "black" {
    if (isPlayerVsEngine) {
      return players.white.type === "human" ? "white" : "black";
    }
    return pos?.turn === "white" ? "white" : "black";
  }

  async function handleAbort() {
    await runGameCommand({
      command: "abort",
      unavailable: undefined,
      action: ({ gameId, session }) => cleanupExactIdentity(gameId, session, { finish: true }),
      canApplySuccess: (retired, { generation }) => retired && ownsUiEpoch(generation),
      onSuccess: () => {
        invalidateUiSession();
        store.getState().setResult("*");
      },
    });
  }

  async function handleResign() {
    const losingColor = getResignationLosingColor();
    await runGameCommand({
      command: "resign",
      unavailable: undefined,
      action: ({ gameId, session }) => tauri.resignGame(gameId, session, losingColor),
      onSuccess: (state, { gameId, session, generation }) => {
        applyAuthoritativeState(state, gameId, session, generation);
      },
    });
  }

  async function handleNewGame() {
    const ownedGameId = liveGameIdRef.current;
    const ownedSession = backendSessionRef.current;
    if (ownedGameId && ownedSession !== null) {
      try {
        await cleanupExactIdentity(ownedGameId, ownedSession);
      } catch (error) {
        notifyUnlessCancelled(t("Common.Error"), error);
        return;
      }
    }
    if (!ownsMountedOwner()) return;
    invalidateUiSession();
    setInterruption(null);
    atomStore.set(ownerGameStateAtom, "settingUp");
    setWhiteTime(null);
    setBlackTime(null);
    resetTree();
  }

  useEffect(() => {
    const mountLease = Symbol("board-game-mount");
    mountLeaseRef.current = mountLease;
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const ownedGameId = liveGameIdRef.current;
      const ownedSession = backendSessionRef.current;
      void Promise.resolve()
        .then(async () => {
          if (mountLeaseRef.current !== mountLease) return;
          invalidateUiSession();
          if (ownedGameId && ownedSession !== null) {
            await cleanupExactIdentity(ownedGameId, ownedSession, { finish: true });
          }
        })
        .catch((error) => {
          notifyUnlessCancelled(tRef.current("Common.Error"), error);
        });
    };
  }, [cleanupExactIdentity, invalidateUiSession]);

  async function handleSelectOpeningBook() {
    const handle = await runUnlessCancelled(t("Common.Error"), () => tauri.issueOpeningBook());
    if (handle) setOpeningBookHandle(handle);
  }

  return (
    <>
      <Portal target="#left" style={{ height: "100%" }}>
        <Board
          editingMode={gameState === "settingUp" && editingMode}
          viewOnly={gameState !== "playing" && !editingMode}
          disableVariations
          boardRef={boardRef}
          movable={gameState === "settingUp" && editingMode ? "none" : movable}
          whiteTime={gameState === "playing" ? (whiteTime ?? undefined) : undefined}
          blackTime={gameState === "playing" ? (blackTime ?? undefined) : undefined}
          onMove={handleHumanMove}
          selectedPiece={selectedPiece}
          cgRef={cgRef}
          enablePremoves={isPlayerVsEngine && gameState === "playing"}
          onKeyboardPremove={queueKeyboardPremove}
        />
      </Portal>
      <Portal target="#topRight" style={{ height: "100%", overflow: "hidden" }}>
        <Paper withBorder shadow="sm" p="md" h="100%">
          {logsOpened ? (
            <Stack h="100%">
              {terminalSnapshot && (
                <Text fw={700} role="status">
                  {t("Engines.Logs.TerminalDiagnostics")}
                </Text>
              )}
              <EngineLogsView
                logs={terminalLogs ?? engineLogs}
                onRefresh={terminalSnapshot ? undefined : fetchEngineLogs}
                additionalControls={
                  <>
                    {players.white.type === "engine" && players.black.type === "engine" ? (
                      <SegmentedControl
                        value={logsColor}
                        onChange={(value) => changeLogsColor(value as "white" | "black")}
                        data={[
                          { value: "white", label: t("Fen.White") },
                          { value: "black", label: t("Fen.Black") },
                        ]}
                      />
                    ) : (
                      <div />
                    )}
                    <IconAction
                      label={t("EngineLogs.Close", { defaultValue: "Close engine logs" })}
                      flex={0}
                      onClick={() => toggleLogsOpened()}
                    >
                      <X size="1.2rem" />
                    </IconAction>
                  </>
                }
              />
            </Stack>
          ) : (
            <>
              {commandError && (
                <Text c="danger" role="alert">
                  {translateGameCommandError(t, commandError)}
                </Text>
              )}
              {interruption && (
                <Text c="danger" role="alert">
                  {t("Board.Opponent.Interrupted", {
                    reason:
                      interruption.reason === "engineTaskFailed"
                        ? t("Board.Opponent.EngineTaskFailed")
                        : engineFailureMessage(t, interruption.snapshot ?? undefined),
                  })}
                </Text>
              )}
              {gameState === "settingUp" && (
                <Stack h="100%" gap={0}>
                  <ScrollArea style={{ flex: 1 }} offsetScrollbars>
                    <Stack>
                      <Group>
                        <Text flex={1} ta="center" fz="lg" fw="bold">
                          {match(inputColor)
                            .with("white", () => t("Fen.White"))
                            .with("random", () => t("Board.Opponent.Random"))
                            .with("black", () => t("Fen.Black"))
                            .exhaustive()}
                        </Text>
                        <IconAction
                          label={t("Board.Action.SwapColors", { defaultValue: "Swap colors" })}
                          onClick={cycleColor}
                        >
                          <ArrowRightLeft />
                        </IconAction>
                        <Text flex={1} ta="center" fz="lg" fw="bold">
                          {match(inputColor)
                            .with("white", () => t("Fen.Black"))
                            .with("random", () => t("Board.Opponent.Random"))
                            .with("black", () => t("Fen.White"))
                            .exhaustive()}
                        </Text>
                      </Group>
                      <Box flex={1}>
                        <Group style={{ alignItems: "start" }}>
                          <OpponentForm
                            sameTimeControl={sameTimeControl}
                            opponent={player1Settings}
                            setOpponent={setPlayer1Settings}
                            setOtherOpponent={setPlayer2Settings}
                          />
                          <Divider orientation="vertical" />
                          <OpponentForm
                            sameTimeControl={sameTimeControl}
                            opponent={player2Settings}
                            setOpponent={setPlayer2Settings}
                            setOtherOpponent={setPlayer1Settings}
                          />
                        </Group>
                      </Box>

                      <Paper withBorder p="sm">
                        <Stack>
                          <Checkbox
                            label={t("Board.Opponent.SameTimeControl")}
                            checked={sameTimeControl}
                            onChange={(e) => {
                              const checked = e.target.checked;
                              setSameTimeControl(checked);
                              if (checked) {
                                setPlayer2Settings((prev) => ({
                                  ...prev,
                                  timeControl: player1Settings.timeControl,
                                  timeUnit: player1Settings.timeUnit,
                                  incrementUnit: player1Settings.incrementUnit,
                                }));
                              }
                            }}
                          />

                          <Divider variant="dashed" />

                          <Checkbox
                            label={t("Board.Opponent.EnableOpeningBook")}
                            checked={openingBookEnabled}
                            onChange={(e) => setOpeningBookEnabled(e.currentTarget.checked)}
                          />

                          {openingBookEnabled && (
                            <>
                              <FileInput
                                label={t("Board.Opponent.OpeningBookFile")}
                                description={t("Import.PGN.ClickToSelect")}
                                filename={
                                  openingBookHandle ? t("Board.Opponent.OpeningBookSelected") : null
                                }
                                onClick={handleSelectOpeningBook}
                              />
                              {openingBookHandle && (
                                <NumberInput
                                  label={t("Board.Opponent.OpeningBookMaxPlies")}
                                  description={t("Board.Opponent.OpeningBookMaxPlies.Desc")}
                                  min={1}
                                  value={openingBookMaxPly}
                                  onChange={(value) => {
                                    if (typeof value === "number" && Number.isFinite(value)) {
                                      setOpeningBookMaxPly(Math.max(1, Math.trunc(value)));
                                    }
                                  }}
                                />
                              )}
                            </>
                          )}
                        </Stack>
                      </Paper>
                    </Stack>
                  </ScrollArea>

                  <Divider pb="sm" />
                  <Button
                    onClick={startGame}
                    fullWidth
                    variant="light"
                    disabled={
                      error !== null ||
                      pendingCommand === "start" ||
                      !hasStartableTimeControl(player1Settings) ||
                      !hasStartableTimeControl(player2Settings)
                    }
                    loading={pendingCommand === "start"}
                  >
                    {t("Board.Opponent.StartGame")}
                  </Button>
                </Stack>
              )}
              {(gameState === "playing" || gameState === "gameOver") && (
                <Stack h="100%">
                  <Box flex={1}>
                    <GameInfo headers={headers} />
                  </Box>
                  <Group grow>
                    {gameState === "playing" && (
                      <Button
                        variant="default"
                        color="danger"
                        onClick={isEngineVsEngine ? handleAbort : handleResign}
                        leftSection={<X />}
                        loading={pendingCommand === "abort" || pendingCommand === "resign"}
                        disabled={pendingCommand !== null}
                      >
                        {isEngineVsEngine ? t("Board.Opponent.Abort") : t("Board.Opponent.Resign")}
                      </Button>
                    )}
                    {gameState === "gameOver" && (
                      <Button variant="default" onClick={handleNewGame} leftSection={<Plus />}>
                        {t("Home.NewGame")}
                      </Button>
                    )}
                    <Button
                      variant="default"
                      onClick={() => changeToAnalysisMode()}
                      leftSection={<ScanSearch />}
                    >
                      {t("Board.Analysis.Analyze")}
                    </Button>

                    {hasEngine && (
                      <Button
                        variant="default"
                        onClick={() => toggleLogsOpened()}
                        leftSection={<FileText size="1rem" />}
                      >
                        {t("Board.Analysis.Logs")}
                      </Button>
                    )}
                  </Group>
                </Stack>
              )}
            </>
          )}
        </Paper>
      </Portal>
      <Portal target="#bottomRight" style={{ height: "100%" }}>
        {gameState === "settingUp" && editingMode ? (
          <EditingCard
            boardRef={boardRef}
            setEditingMode={toggleEditingMode}
            selectedPiece={selectedPiece}
            setSelectedPiece={setSelectedPiece}
          />
        ) : (
          <NotationColumn>
            <GameNotation
              topBar
              controls={
                <BoardControls
                  boardRef={boardRef}
                  editingMode={gameState === "settingUp" && editingMode}
                  toggleEditingMode={toggleEditingMode}
                  dirty={false}
                  canTakeBack={onePlayerIsEngine}
                  onTakeBack={onTakeBack}
                  takeBackPending={pendingCommand === "takeback"}
                  disableVariations
                  allowEditing={gameState === "settingUp"}
                />
              }
            />
            <MoveControls />
          </NotationColumn>
        )}
      </Portal>
    </>
  );
}

export default BoardGame;
