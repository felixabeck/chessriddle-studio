import { act, StrictMode, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { getDefaultStore } from "jotai";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const fixtures = vi.hoisted(() => ({
  abortGame: vi.fn(),
  appendMove: vi.fn(),
  getGameEngineLogs: vi.fn(),
  getGameState: vi.fn(),
  logError: vi.fn(),
  listeners: new Map<string, (event: any) => void>(),
  listenerErrors: new Map<string, (error: unknown, event: any) => void>(),
  makeGameMove: vi.fn(),
  notify: vi.fn(),
  logRefresh: null as null | (() => Promise<void>),
  logColorChange: null as null | ((value: string) => void),
  onMove: null as null | ((uci: string) => Promise<boolean>),
  onTakeBack: null as null | (() => Promise<void>),
  positionTurn: undefined as "white" | "black" | undefined,
  boardProps: null as any,
  playPremove: vi.fn(),
  queuePremove: vi.fn(),
  resignGame: vi.fn(),
  resetTree: vi.fn(),
  setEngineLogs: [] as unknown[],
  setHeaders: vi.fn(),
  setResult: vi.fn(),
  startGame: vi.fn(),
  takeBackGameMove: vi.fn(),
  tree: null as any,
  treeStore: null as any,
}));

vi.mock("@/state/atoms", async () => {
  const { atom } = await vi.importActual<typeof import("jotai")>("jotai");
  const { atomFamily } = await vi.importActual<typeof import("jotai/utils")>("jotai/utils");
  const gameIdFamily = atomFamily(() => atom<string | null>(null));
  const gameSessionFamily = atomFamily(() => atom<bigint | null>(null));
  const gameInterruptionFamily = atomFamily(() => atom<any>(null));
  const gameStateFamily = atomFamily(() => atom<"settingUp" | "playing" | "gameOver">("settingUp"));
  const pendingGameStartFamily = atomFamily(() => atom<Promise<void> | null>(null));
  const playersFamily = atomFamily(() =>
    atom({ white: { type: "human", name: "White" }, black: { type: "human", name: "Black" } }),
  );
  return {
    activeTabAtom: atom<string | null>("tab-a"),
    closingTabsAtom: atom<Set<string>>(new Set<string>()),
    enginesAtom: atom<any[] | undefined>([]),
    flipBoardAfterMoveAtom: atom(false),
    gameIdFamily,
    gameSessionFamily,
    gameInterruptionFamily,
    gameStateFamily,
    pendingGameStartFamily,
    playersFamily,
    disposeTabAtoms: (tabId: string) => {
      gameIdFamily.remove(tabId);
      gameSessionFamily.remove(tabId);
      gameInterruptionFamily.remove(tabId);
      gameStateFamily.remove(tabId);
      pendingGameStartFamily.remove(tabId);
      playersFamily.remove(tabId);
    },
    gameInputColorAtom: atom<"white" | "black" | "random">("white"),
    gamePlayer1SettingsAtom: atom<any>({ type: "human", name: "Alice" }),
    gamePlayer2SettingsAtom: atom<any>({ type: "human", name: "Bob" }),
    gameOpeningBookHandleAtom: atom<any>(null),
    gameOpeningBookEnabledAtom: atom(false),
    gameOpeningBookMaxPlyAtom: atom(20),
    gameSameTimeControlAtom: atom(true),
    tabsAtom: atom<any[]>([]),
  };
});

vi.mock("zustand", async (importOriginal) => {
  const actual = await importOriginal<typeof import("zustand")>();
  return {
    ...actual,
    useStore: (_store: unknown, selector: (state: unknown) => unknown) =>
      selector(fixtures.treeStore ? fixtures.treeStore.getState() : fixtures.tree),
  };
});
vi.mock("@/utils/chessops", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/chessops")>();
  return {
    ...actual,
    positionFromFen: (fen: string) => {
      const res = actual.positionFromFen(fen);
      if (fixtures.positionTurn !== undefined && res[0]) {
        res[0].turn = fixtures.positionTurn;
      }
      return res;
    },
  };
});
vi.mock("@/utils/sound", () => ({ playSound: vi.fn() }));
vi.mock("@/platform/tauri", async () => {
  const subscribe = (name: string) =>
    vi.fn(async (listener, onError) => {
      fixtures.listeners.set(name, listener);
      fixtures.listenerErrors.set(name, onError);
      return vi.fn();
    });
  return {
    decodeCounter: (await vi.importActual<typeof import("@/platform/tauri")>("@/platform/tauri"))
      .decodeCounter,
    tauri: {
      abortGame: fixtures.abortGame,
      getGameEngineLogs: fixtures.getGameEngineLogs,
      getGameState: fixtures.getGameState,
      makeGameMove: fixtures.makeGameMove,
      resignGame: fixtures.resignGame,
      startGame: fixtures.startGame,
      takeBackGameMove: fixtures.takeBackGameMove,
    },
    tauriSubscriptions: {
      gameMove: subscribe("gameMove"),
      clockUpdate: subscribe("clockUpdate"),
      gameOver: subscribe("gameOver"),
    },
  };
});
vi.mock("@/platform/native", () => ({ error: fixtures.logError }));
vi.mock("@/components/files/notifyError", () => ({
  notifyListenerError: fixtures.notify,
  notifyUnlessCancelled: fixtures.notify,
  runUnlessCancelled: async (_title: string, run: () => Promise<unknown>) => run(),
}));
vi.mock("@mantine/hooks", () => ({
  useToggle: () => {
    const [value, setValue] = useState(false);
    return [value, () => setValue((current) => !current)] as const;
  },
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: any) =>
      key === "Board.Opponent.Interrupted" ? `${key}: ${options.reason}` : key,
  }),
}));
vi.mock("@mantine/core", () => {
  const Box = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  return {
    Box,
    Button: ({ children, onClick, disabled, loading }: any) => (
      <button
        type="button"
        onClick={onClick}
        disabled={disabled || loading}
        data-loading={loading ? "true" : "false"}
      >
        {children}
      </button>
    ),
    Checkbox: () => null,
    Divider: () => null,
    Group: Box,
    NumberInput: () => null,
    Paper: Box,
    Portal: Box,
    ScrollArea: Box,
    SegmentedControl: ({ data, value, onChange }: any) => {
      fixtures.logColorChange = onChange;
      return (
        <div>
          {data.map((item: any) => {
            const option = typeof item === "string" ? item : item.value;
            return (
              <button
                type="button"
                key={option}
                aria-pressed={value === option}
                onClick={() => onChange(option)}
              >
                {option}
              </button>
            );
          })}
        </div>
      );
    },
    Stack: Box,
    Text: ({ children, role }: any) => <div role={role}>{children}</div>,
  };
});
vi.mock("./OpponentForm", () => ({ OpponentForm: () => null }));
vi.mock("./Board", () => ({
  default: (props: { onMove: (uci: string) => Promise<boolean> }) => {
    const { onMove } = props;
    fixtures.onMove = onMove;
    fixtures.boardProps = props;
    if ((props as any).cgRef) {
      (props as any).cgRef.current = {
        playPremove: fixtures.playPremove,
        queuePremove: fixtures.queuePremove,
      };
    }
    return null;
  },
}));
vi.mock("./BoardControls", () => ({
  default: ({ onTakeBack }: { onTakeBack: () => Promise<void> }) => {
    fixtures.onTakeBack = onTakeBack;
    return null;
  },
}));
vi.mock("./EditingCard", () => ({ default: () => null }));
vi.mock("../common/EngineLogsView", () => ({
  default: ({ logs, onRefresh, additionalControls }: any) => {
    fixtures.setEngineLogs = logs;
    fixtures.logRefresh = onRefresh;
    return <>{additionalControls}</>;
  },
}));
vi.mock("../common/FileInput", () => ({ default: () => null }));
vi.mock("../common/GameInfo", () => ({ default: () => null }));
vi.mock("../common/GameNotation", () => ({
  default: ({ controls }: { controls?: React.ReactNode }) => <>{controls}</>,
}));
vi.mock("../common/MoveControls", () => ({ default: () => null }));
vi.mock("../common/IconAction", () => ({
  default: ({ label, onClick }: any) => (
    <button type="button" onClick={onClick}>
      {label}
    </button>
  ),
}));

import {
  closingTabsAtom,
  disposeTabAtoms,
  enginesAtom,
  flipBoardAfterMoveAtom,
  gameIdFamily,
  gamePlayer1SettingsAtom,
  gamePlayer2SettingsAtom,
  gameSessionFamily,
  gameInterruptionFamily,
  gameStateFamily,
  pendingGameStartFamily,
  playersFamily,
  tabsAtom,
} from "@/state/atoms";
import BoardGame from "./BoardGame";
import { makeUci, parseUci } from "chessops";
import { INITIAL_FEN } from "chessops/fen";
import { TreeStateContext } from "../common/TreeStateContext";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const store = getDefaultStore();
let host: HTMLDivElement;
let root: Root;

function state(overrides: Record<string, unknown> = {}) {
  return {
    gameId: "game",
    session: 1n,
    revision: 0n,
    status: "playing",
    initialFen: INITIAL_FEN,
    currentFen: INITIAL_FEN,
    moves: [],
    ply: 0,
    turn: "white",
    whitePlayer: "Alice",
    blackPlayer: "Bob",
    whiteTime: null,
    blackTime: null,
    ...overrides,
  };
}

/**
 * Builds an engine fixture and registers it in the live engine list, because `startGame`
 * rejects a selection whose application id is not registered any more.
 */
function engine(id: string) {
  const created = {
    type: "local" as const,
    id,
    name: `Engine ${id}`,
    version: "1",
    filename: id,
    handle: { id: { id }, kind: "engine" as const },
    settings: [],
  };
  store.set(enginesAtom, [...(store.get(enginesAtom) ?? []), created]);
  return created;
}

function button(label: string) {
  const found = [...host.querySelectorAll("button")].find((item) => item.textContent === label);
  if (!found) throw new Error(`Missing button ${label}`);
  return found;
}

function treeMoves(rootNode = fixtures.tree.root) {
  const moves: any[] = [];
  let node = rootNode;
  while (node.children.length) {
    node = node.children[0];
    moves.push(node.move);
  }
  return moves;
}

function mainlineUcis(rootNode: any) {
  return treeMoves(rootNode).map(makeUci);
}

async function render(tabId = "tab-a") {
  await act(async () =>
    root.render(
      <TreeStateContext.Provider value={fixtures.treeStore}>
        <BoardGame tabId={tabId} />
      </TreeStateContext.Provider>,
    ),
  );
}

async function start(tabId = "tab-a") {
  await act(async () => button("Board.Opponent.StartGame").click());
  const pending = store.get(pendingGameStartFamily(tabId));
  if (pending) await act(async () => pending);
}

beforeEach(() => {
  vi.clearAllMocks();
  fixtures.listeners.clear();
  fixtures.listenerErrors.clear();
  fixtures.onMove = null;
  fixtures.onTakeBack = null;
  fixtures.logRefresh = null;
  fixtures.logColorChange = null;
  fixtures.boardProps = null;
  fixtures.positionTurn = undefined;
  fixtures.queuePremove.mockReturnValue(true);
  fixtures.setEngineLogs = [];
  const rootNode = () => ({ fen: INITIAL_FEN, children: [] as any[] });
  fixtures.tree = {
    position: [] as number[],
    root: rootNode(),
    headers: {} as Record<string, unknown>,
    setFen: vi.fn((fen: string) => {
      fixtures.tree.root = { fen, children: [] };
    }),
    setHeaders: vi.fn((headers: Record<string, unknown>) => {
      fixtures.tree.headers = headers;
      fixtures.setHeaders(headers);
    }),
    setResult: vi.fn((result: string) => {
      fixtures.tree.headers = { ...fixtures.tree.headers, result };
      fixtures.setResult(result);
    }),
    appendMove: vi.fn(({ payload, clock }: any) => {
      let node = fixtures.tree.root;
      while (node.children.length) node = node.children[0];
      const child = { fen: node.fen, move: payload, clock, children: [] };
      node.children.push(child);
      fixtures.appendMove({ payload, clock });
    }),
    deleteMove: vi.fn((path?: number[]) => {
      if (!path || path.length === 0) {
        fixtures.tree.root.children = [];
        return;
      }
      let node = fixtures.tree.root;
      for (let i = 0; i < path.length - 1; i++) {
        const childIndex = path[i] ?? 0;
        if (!node.children || !node.children[childIndex]) return;
        node = node.children[childIndex];
      }
      const deleteIndex = path[path.length - 1] ?? 0;
      if (node && node.children) {
        node.children.splice(deleteIndex, 1);
      }
    }),
    goToMove: vi.fn(),
    promoteToMainline: vi.fn(),
    makeMove: vi.fn(({ payload, mainline, clock }: any) => {
      let node = fixtures.tree.root;
      while (node.children.length) node = node.children[0];
      const child = { fen: node.fen, move: payload, clock, children: [] };
      if (mainline) {
        node.children.unshift(child);
      } else {
        node.children.push(child);
      }
    }),
    reset: vi.fn(() => {
      fixtures.tree.root = rootNode();
      fixtures.tree.headers = {};
      fixtures.resetTree();
    }),
  };
  fixtures.treeStore = {
    getState: () => fixtures.tree,
    setState: vi.fn(),
    subscribe: vi.fn(() => vi.fn()),
  };
  store.set(closingTabsAtom, new Set());
  store.set(enginesAtom, []);
  store.set(flipBoardAfterMoveAtom, false);
  store.set(tabsAtom, [
    { name: "A", value: "tab-a", type: "play", gameOrigin: { kind: "none" } },
    { name: "B", value: "tab-b", type: "play", gameOrigin: { kind: "none" } },
  ]);
  for (const tabId of ["tab-a", "tab-b"]) {
    store.set(gameIdFamily(tabId), null);
    store.set(gameSessionFamily(tabId), null);
    store.set(gameInterruptionFamily(tabId), null);
    store.set(gameStateFamily(tabId), "settingUp");
    store.set(pendingGameStartFamily(tabId), null);
  }
  store.set(gamePlayer1SettingsAtom, { type: "human", name: "Alice" });
  store.set(gamePlayer2SettingsAtom, { type: "human", name: "Bob" });
  fixtures.abortGame.mockResolvedValue(undefined);
  fixtures.getGameEngineLogs.mockResolvedValue([]);
  fixtures.logError.mockResolvedValue(undefined);
  fixtures.getGameState.mockImplementation(async (gameId, session) => state({ gameId, session }));
  fixtures.startGame.mockImplementation(async (gameId) => state({ gameId }));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

test.each(["event", "snapshot"])(
  "engine interruption via %s preserves moves and result without duplicate notice",
  async (delivery) => {
    vi.useFakeTimers();
    const query = Promise.withResolvers<any>();
    await render();
    await start();
    const gameId = store.get(gameIdFamily("tab-a"));
    const result = {
      type: "interrupted",
      reason: "engineFailure",
      snapshot: {
        kind: "protocol-failure",
        exitStatus: null,
        reason: "Invalid engine command",
        entries: [],
      },
    };
    const moves = [
      {
        uci: "e2e4",
        san: "e4",
        clock: null,
        fenAfter: INITIAL_FEN,
        whiteTime: null,
        blackTime: null,
      },
    ];
    const terminal = state({ gameId, revision: 3n, moves, status: { finished: { result } } });
    if (delivery === "event") {
      fixtures.getGameState.mockReturnValue(query.promise);
      await act(async () => vi.advanceTimersByTimeAsync(1000));
      await act(async () =>
        fixtures.listeners.get("gameOver")?.({
          payload: {
            gameId,
            session: 1n,
            revision: 3n,
            result,
            moves,
          },
        }),
      );
      await act(async () => query.resolve(terminal));
    } else {
      // A real mounted owner recovers a lost GameOver through its existing query timer.
      fixtures.getGameState.mockResolvedValue(terminal);
      await act(async () => vi.advanceTimersByTimeAsync(1000));
    }
    vi.useRealTimers();
    await act(async () =>
      fixtures.listeners.get("gameOver")?.({
        payload: {
          gameId,
          session: 1n,
          revision: 3n,
          result,
          moves,
        },
      }),
    );
    expect(store.get(gameStateFamily("tab-a"))).toBe("gameOver");
    expect(store.get(gameIdFamily("tab-a"))).toBeNull();
    expect(store.get(gameSessionFamily("tab-a"))).toBeNull();
    expect(fixtures.setResult).toHaveBeenCalledTimes(1);
    expect(fixtures.tree.headers.result).toBe("*");
    expect(mainlineUcis(fixtures.tree.root)).toEqual(["e2e4"]);
    expect(host.querySelectorAll('[role="alert"]')).toHaveLength(1);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Invalid engine command");
    expect(fixtures.notify).not.toHaveBeenCalled();
    await act(async () => button("Home.NewGame").click());
    expect(host.querySelector('[role="alert"]')).toBeNull();
    await start();
    expect(store.get(gameStateFamily("tab-a"))).toBe("playing");
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(fixtures.abortGame).not.toHaveBeenCalled();
  },
);

test("engine join interruption localizes the generic reason", async () => {
  await render();
  await start();
  await act(async () =>
    fixtures.listeners.get("gameOver")?.({
      payload: {
        gameId: store.get(gameIdFamily("tab-a")),
        session: 1n,
        revision: 3n,
        result: { type: "interrupted", reason: "engineTaskFailed", snapshot: null },
        moves: [],
      },
    }),
  );
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    "Board.Opponent.EngineTaskFailed",
  );
  expect(fixtures.tree.headers.result).toBe("*");
});

test.each(["event", "snapshot"])(
  "interrupted %s diagnostics remain in Logs until the next game",
  async (delivery) => {
    vi.useFakeTimers();
    store.set(gamePlayer2SettingsAtom, {
      type: "engine",
      engine: engine("logs-engine"),
      go: { t: "Infinite" },
    });
    await render();
    await start();
    const gameId = store.get(gameIdFamily("tab-a"));
    const result = {
      type: "interrupted",
      reason: "engineFailure",
      snapshot: {
        kind: "protocol-failure",
        exitStatus: null,
        reason: "Safe reason",
        entries: [
          { type: "infoString", value: "Safe final reason" },
          { type: "stderr", value: "<script>safe diagnostic</script>" },
          { type: "truncated" },
        ],
      },
    };
    if (delivery === "event") {
      await act(async () =>
        fixtures.listeners.get("gameOver")?.({
          payload: {
            gameId,
            session: 1n,
            revision: 3n,
            result,
            moves: [],
          },
        }),
      );
    } else {
      fixtures.getGameState.mockResolvedValue(
        state({ gameId, revision: 3n, status: { finished: { result } } }),
      );
      await act(async () => vi.advanceTimersByTimeAsync(1000));
    }
    vi.useRealTimers();
    await act(async () => root.unmount());
    root = createRoot(host);
    await render();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Safe reason");
    await act(async () => button("Board.Analysis.Logs").click());
    expect(host.textContent).toContain("Engines.Logs.TerminalDiagnostics");
    expect(fixtures.setEngineLogs).toEqual([
      { type: "engine", value: "Safe final reason" },
      { type: "engine", value: "<script>safe diagnostic</script>" },
      { type: "engine", value: "Engines.Logs.TerminalTruncated" },
    ]);
    expect(fixtures.getGameEngineLogs).not.toHaveBeenCalled();
    expect(fixtures.logRefresh).toBeUndefined();
    await act(async () => button("EngineLogs.Close").click());
    await act(async () => button("Home.NewGame").click());
    fixtures.getGameState.mockImplementation(async (id, session) => state({ gameId: id, session }));
    fixtures.getGameEngineLogs.mockResolvedValue([{ type: "gui", value: "go infinite" }]);
    await start();
    await act(async () => button("Board.Analysis.Logs").click());
    expect(host.textContent).not.toContain("Engines.Logs.TerminalDiagnostics");
    expect(fixtures.setEngineLogs).toEqual([{ type: "gui", value: "go infinite" }]);
    expect(fixtures.getGameEngineLogs).toHaveBeenCalledWith(expect.any(String), 1n, "black");
  },
);

test("settingUp reset clears a retained interruption after remount", async () => {
  store.set(gameInterruptionFamily("tab-a"), {
    type: "interrupted",
    reason: "engineTaskFailed",
    snapshot: null,
    engineColor: null,
  });
  await render();
  expect(store.get(gameInterruptionFamily("tab-a"))).toBeNull();
  expect(host.querySelector('[role="alert"]')).toBeNull();
});

test("native castling promotes an existing O-O variation and preserves its endpoint", async () => {
  const { createTreeStore } =
    await vi.importActual<typeof import("@/state/store/tree")>("@/state/store/tree");
  const realStore = createTreeStore();
  fixtures.treeStore = realStore;
  const initialFen = "4k3/8/8/8/8/8/8/4K2R w K - 0 1";
  realStore.getState().setFen(initialFen);
  realStore.getState().makeMove({ payload: parseUci("e1f1")!, mainline: true });
  realStore.getState().goToMove([]);
  realStore.getState().makeMove({ payload: parseUci("e1h1")!, mainline: false });
  const castled = realStore.getState().root.children[1];
  expect(castled.san).toBe("O-O");
  store.set(gameIdFamily("tab-a"), "castling-game");
  store.set(gameSessionFamily("tab-a"), 1n);
  store.set(gameStateFamily("tab-a"), "playing");
  fixtures.getGameState.mockResolvedValue(
    state({
      gameId: "castling-game",
      initialFen,
      revision: 1n,
      moves: [{ uci: "e1g1", clock: null, fenAfter: castled.fen }],
    }),
  );
  await render();
  const endpoint = realStore.getState().root.children[0];
  expect(endpoint.san).toBe("O-O");
  expect(endpoint.fen).toBe("4k3/8/8/8/8/8/8/5RK1 b - - 1 1");
  expect(realStore.getState().root.children[1].san).toBe("Kf1");
});

test("odd native moves select terminal Logs independently of a divergent real tree", async () => {
  const { createTreeStore } =
    await vi.importActual<typeof import("@/state/store/tree")>("@/state/store/tree");
  const realStore = createTreeStore();
  fixtures.treeStore = realStore;
  for (const [settings, id] of [
    [gamePlayer1SettingsAtom, "white-odd"],
    [gamePlayer2SettingsAtom, "black-odd"],
  ] as const) {
    store.set(settings, { type: "engine", engine: engine(id), go: { t: "Infinite" } });
  }
  await render();
  await start();
  // The native terminal owner remains authoritative even if the renderer tree diverges.
  realStore.getState().setFen("4k3/8/8/8/8/8/8/4K2R w - - 0 1");
  await act(async () =>
    fixtures.listeners.get("gameOver")?.({
      payload: {
        gameId: store.get(gameIdFamily("tab-a")),
        session: 1n,
        revision: 3n,
        moves: [
          {
            uci: "e2e4",
            clock: null,
            fenAfter: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
          },
        ],
        result: {
          type: "interrupted",
          reason: "engineFailure",
          snapshot: {
            kind: "process-exit",
            exitStatus: null,
            reason: "Black failed",
            entries: [{ type: "stderr", value: "Black final line" }],
          },
        },
      },
    }),
  );
  expect(realStore.getState().root.children).toHaveLength(0);
  await act(async () => button("Board.Analysis.Logs").click());
  expect(host.textContent).not.toContain("Engines.Logs.TerminalDiagnostics");
  await act(async () => fixtures.logColorChange!("black"));
  expect(host.textContent).toContain("Engines.Logs.TerminalDiagnostics");
  expect(fixtures.setEngineLogs).toEqual([{ type: "engine", value: "Black final line" }]);
  await act(async () => fixtures.logColorChange!("white"));
  expect(host.textContent).not.toContain("Engines.Logs.TerminalDiagnostics");
});

test("two-engine terminal diagnostics follow only the failed side's selected color", async () => {
  store.set(gamePlayer1SettingsAtom, {
    type: "engine",
    engine: engine("white-logs"),
    go: { t: "Infinite" },
  });
  store.set(gamePlayer2SettingsAtom, {
    type: "engine",
    engine: engine("black-logs"),
    go: { t: "Infinite" },
  });
  fixtures.startGame.mockImplementation(async (id) =>
    state({ gameId: id, initialFen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1" }),
  );
  fixtures.getGameState.mockImplementation(async (id) =>
    state({ gameId: id, initialFen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1" }),
  );
  await render();
  await start();
  await act(async () =>
    fixtures.listeners.get("gameOver")?.({
      payload: {
        gameId: store.get(gameIdFamily("tab-a")),
        session: 1n,
        revision: 3n,
        moves: [],
        result: {
          type: "interrupted",
          reason: "engineFailure",
          snapshot: {
            kind: "process-exit",
            exitStatus: null,
            reason: "Black engine failed",
            entries: [{ type: "stderr", value: "Black terminal diagnostic" }],
          },
        },
      },
    }),
  );
  await act(async () => button("Board.Analysis.Logs").click());
  expect(host.textContent).not.toContain("Engines.Logs.TerminalDiagnostics");
  expect(fixtures.setEngineLogs).toEqual([]);
  await act(async () => fixtures.logColorChange!("black"));
  expect(host.textContent).toContain("Engines.Logs.TerminalDiagnostics");
  expect(fixtures.setEngineLogs).toEqual([{ type: "engine", value: "Black terminal diagnostic" }]);
  await act(async () => fixtures.logColorChange!("white"));
  expect(host.textContent).not.toContain("Engines.Logs.TerminalDiagnostics");
  expect(fixtures.setEngineLogs).toEqual([]);
  expect(fixtures.getGameEngineLogs).not.toHaveBeenCalled();
});

test("starting a human game sends numeric configuration and records ChessRiddle Studio as the PGN Site", async () => {
  await render();
  await start();
  expect(fixtures.startGame).toHaveBeenCalledOnce();
  expect(fixtures.startGame.mock.calls[0][1]).toMatchObject({
    white: { type: "human", name: "Alice" },
    whiteTimeControl: null,
    openingBook: null,
  });
  expect(() => JSON.stringify(fixtures.startGame.mock.calls[0][1])).not.toThrow();
  expect(fixtures.setHeaders).toHaveBeenCalledWith(
    expect.objectContaining({ site: "ChessRiddle Studio" }),
  );
});

test("a deferred start keeps real loading and disabled semantics until admission settles", async () => {
  const reply = Promise.withResolvers<any>();
  fixtures.startGame.mockReturnValue(reply.promise);
  await render();
  await act(async () => button("Board.Opponent.StartGame").click());
  const startButton = button("Board.Opponent.StartGame") as HTMLButtonElement;
  expect(startButton.disabled).toBe(true);
  expect(startButton.dataset.loading).toBe("true");
  expect(store.get(pendingGameStartFamily("tab-a"))).not.toBeNull();
  const gameId = fixtures.startGame.mock.calls[0][0];
  await act(async () => reply.resolve(state({ gameId })));
  expect(store.get(pendingGameStartFamily("tab-a"))).toBeNull();
  expect(store.get(gameStateFamily("tab-a"))).toBe("playing");
});

test("human moves pass the displayed mainline ply to native at call time", async () => {
  const moves = ["e2e4", "e7e5", "g1f3", "b8c6"].map((uci) => ({ uci, clock: null }));
  fixtures.startGame.mockImplementationOnce(async (gameId) =>
    state({ gameId, moves, ply: 4, revision: 4n }),
  );
  await render();
  await start();
  expect(mainlineUcis(fixtures.tree.root)).toEqual(moves.map(({ uci }) => uci));
  fixtures.tree.position = [0, 0];
  fixtures.makeGameMove.mockImplementationOnce(async (gameId, session) =>
    state({ gameId, session, moves, ply: 4, revision: 4n }),
  );

  await act(async () => fixtures.onMove!("f1c4"));

  expect(fixtures.makeGameMove).toHaveBeenCalledWith(
    fixtures.startGame.mock.calls[0][0],
    1n,
    "f1c4",
    2,
  );
});

test("human moves from a variation do not call native", async () => {
  await render();
  await start();
  fixtures.tree.position = [0, 1];

  await act(async () => expect(fixtures.onMove!("f1c4")).resolves.toBe(false));

  expect(fixtures.makeGameMove).not.toHaveBeenCalled();
});

test("auto-flip after a terminal human move preserves live result and headers", async () => {
  const mateFen = "7k/8/5KQ1/8/8/8/8/8 w - - 0 1";
  fixtures.tree.root = { fen: mateFen, children: [] };
  store.set(flipBoardAfterMoveAtom, true);
  fixtures.startGame.mockImplementationOnce(async (gameId) =>
    state({ gameId, initialFen: mateFen, currentFen: mateFen }),
  );
  fixtures.makeGameMove.mockImplementationOnce(async (gameId, session) =>
    state({
      gameId,
      session,
      initialFen: mateFen,
      currentFen: "7k/6Q1/5K2/8/8/8/8/8 b - - 1 1",
      revision: 1n,
      status: {
        finished: { result: { type: "whiteWins", reason: "checkmate" } },
      },
      moves: [{ uci: "g6g7", clock: null }],
    }),
  );
  await render();
  await start();
  fixtures.tree.setHeaders({ ...fixtures.tree.headers, event: "Concurrent header edit" });
  await act(async () => fixtures.onMove!("g6g7"));
  expect(fixtures.tree.headers).toEqual(
    expect.objectContaining({
      result: "1-0",
      orientation: "black",
      site: "ChessRiddle Studio",
      event: "Concurrent header edit",
    }),
  );
});

test("an accepted move remains successful and flips once after a newer periodic snapshot", async () => {
  vi.useFakeTimers();
  store.set(flipBoardAfterMoveAtom, true);
  const moveReply = Promise.withResolvers<any>();
  fixtures.makeGameMove.mockReturnValueOnce(moveReply.promise);
  await render();
  await start();
  const gameId = store.get(gameIdFamily("tab-a"))!;
  fixtures.setHeaders.mockClear();
  fixtures.getGameState.mockResolvedValueOnce(
    state({
      gameId,
      revision: 2n,
      moves: [{ uci: "e2e4", clock: 299000n }],
      whiteTime: 299000n,
      blackTime: 298000n,
      turn: "black",
    }),
  );

  let moveResult!: Promise<boolean>;
  act(() => {
    moveResult = fixtures.onMove!("e2e4");
  });
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(treeMoves()).toEqual([expect.objectContaining({ from: 12, to: 28 })]);
  expect(fixtures.boardProps.whiteTime).toBe(299000);
  expect(fixtures.boardProps.blackTime).toBe(298000);

  await act(async () =>
    moveReply.resolve(
      state({
        gameId,
        revision: 1n,
        moves: [{ uci: "e2e4", clock: 299000n }],
        whiteTime: 300000n,
        blackTime: 300000n,
        turn: "black",
      }),
    ),
  );

  await expect(moveResult).resolves.toBe(true);
  expect(treeMoves()).toEqual([expect.objectContaining({ from: 12, to: 28 })]);
  expect(fixtures.boardProps.whiteTime).toBe(299000);
  expect(fixtures.boardProps.blackTime).toBe(298000);
  expect(fixtures.setHeaders).toHaveBeenCalledOnce();
  expect(fixtures.setHeaders).toHaveBeenCalledWith(
    expect.objectContaining({ orientation: "black" }),
  );
  vi.useRealTimers();
});

test.each([
  { name: "game id", identity: { gameId: "wrong-game" } },
  { name: "session", identity: { session: 2n } },
])("a move response with the wrong $name is not accepted", async ({ identity }) => {
  store.set(flipBoardAfterMoveAtom, true);
  const moveReply = Promise.withResolvers<any>();
  fixtures.makeGameMove.mockReturnValueOnce(moveReply.promise);
  await render();
  await start();
  const gameId = store.get(gameIdFamily("tab-a"))!;
  fixtures.setHeaders.mockClear();
  fixtures.notify.mockClear();

  let moveResult!: Promise<boolean>;
  act(() => {
    moveResult = fixtures.onMove!("e2e4");
  });
  await act(async () =>
    moveReply.resolve(
      state({
        gameId,
        revision: 1n,
        moves: [{ uci: "e2e4", clock: null }],
        ...identity,
      }),
    ),
  );

  await expect(moveResult).resolves.toBe(false);
  expect(treeMoves()).toEqual([]);
  expect(fixtures.setHeaders).not.toHaveBeenCalled();
  expect(fixtures.notify).not.toHaveBeenCalled();
});

test("an exact accepted move response is silent after its owner retires", async () => {
  store.set(flipBoardAfterMoveAtom, true);
  const moveReply = Promise.withResolvers<any>();
  fixtures.makeGameMove.mockReturnValueOnce(moveReply.promise);
  await render();
  await start();
  const gameId = store.get(gameIdFamily("tab-a"))!;
  let moveResult!: Promise<boolean>;
  act(() => {
    moveResult = fixtures.onMove!("e2e4");
  });
  await act(async () =>
    fixtures.listeners.get("gameOver")?.({
      payload: {
        gameId,
        session: 1n,
        revision: 2n,
        result: { type: "draw", reason: "stalemate" },
        moves: [],
      },
    }),
  );
  fixtures.setHeaders.mockClear();
  fixtures.notify.mockClear();

  await act(async () =>
    moveReply.resolve(state({ gameId, revision: 1n, moves: [{ uci: "e2e4", clock: null }] })),
  );

  await expect(moveResult).resolves.toBe(false);
  expect(store.get(gameStateFamily("tab-a"))).toBe("gameOver");
  expect(treeMoves()).toEqual([]);
  expect(fixtures.setHeaders).not.toHaveBeenCalled();
  expect(fixtures.notify).not.toHaveBeenCalled();
});

test("start remains loading through prior cleanup and native admission", async () => {
  const cleanup = Promise.withResolvers<void>();
  const reply = Promise.withResolvers<any>();
  await render();
  store.set(gameIdFamily("tab-a"), "retained");
  store.set(gameSessionFamily("tab-a"), 7n);
  await act(async () => Promise.resolve());
  fixtures.abortGame.mockReturnValueOnce(cleanup.promise);
  fixtures.startGame.mockReturnValueOnce(reply.promise);
  await act(async () => button("Board.Opponent.StartGame").click());
  expect((button("Board.Opponent.StartGame") as HTMLButtonElement).dataset.loading).toBe("true");
  expect(fixtures.startGame).not.toHaveBeenCalled();
  await act(async () => cleanup.resolve());
  expect(fixtures.startGame).toHaveBeenCalledOnce();
  expect((button("Board.Opponent.StartGame") as HTMLButtonElement).dataset.loading).toBe("true");
  const gameId = fixtures.startGame.mock.calls[0][0];
  await act(async () => reply.resolve(state({ gameId })));
  expect(store.get(pendingGameStartFamily("tab-a"))).toBeNull();
});

test("a retained setup handler cannot start after its owner tab was removed", async () => {
  await render();
  const retainedStart = button("Board.Opponent.StartGame");
  const initialPlayers = store.get(playersFamily("tab-a"));
  await act(async () =>
    store.set(tabsAtom, [
      { name: "B", value: "tab-b", type: "play", gameOrigin: { kind: "none" } },
    ]),
  );
  fixtures.setHeaders.mockClear();
  fixtures.appendMove.mockClear();

  await act(async () => retainedStart.click());

  expect(fixtures.startGame).not.toHaveBeenCalled();
  expect(store.get(pendingGameStartFamily("tab-a"))).toBeNull();
  expect(store.get(gameStateFamily("tab-a"))).toBe("settingUp");
  expect(store.get(gameIdFamily("tab-a"))).toBeNull();
  expect(store.get(gameSessionFamily("tab-a"))).toBeNull();
  expect(store.get(playersFamily("tab-a"))).toEqual(initialPlayers);
  expect(fixtures.setHeaders).not.toHaveBeenCalled();
  expect(fixtures.appendMove).not.toHaveBeenCalled();
});

test("a retained rerender does not recreate disposed owner atom-family entries", async () => {
  await render();
  const capturedAtoms = [
    gameStateFamily("tab-a"),
    playersFamily("tab-a"),
    gameIdFamily("tab-a"),
    gameSessionFamily("tab-a"),
    pendingGameStartFamily("tab-a"),
  ];
  const ownerFamilies = [
    gameStateFamily,
    playersFamily,
    gameIdFamily,
    gameSessionFamily,
    pendingGameStartFamily,
  ];
  expect(new Set(capturedAtoms).size).toBe(5);

  disposeTabAtoms("tab-a");
  for (const family of ownerFamilies) {
    expect([...family.getParams()]).not.toContain("tab-a");
  }

  await act(async () => {
    store.set(tabsAtom, [
      { name: "B", value: "tab-b", type: "play", gameOrigin: { kind: "none" } },
    ]);
    store.set(flipBoardAfterMoveAtom, true);
  });

  for (const family of ownerFamilies) {
    expect([...family.getParams()]).not.toContain("tab-a");
  }
});

test("tab removal during prior cleanup prevents replacement native admission", async () => {
  const cleanup = Promise.withResolvers<void>();
  await render();
  store.set(gameIdFamily("tab-a"), "retained");
  store.set(gameSessionFamily("tab-a"), 7n);
  await act(async () => Promise.resolve());
  fixtures.abortGame.mockReturnValueOnce(cleanup.promise);

  act(() => button("Board.Opponent.StartGame").click());
  expect(store.get(pendingGameStartFamily("tab-a"))).not.toBeNull();
  await act(async () =>
    store.set(tabsAtom, [
      { name: "B", value: "tab-b", type: "play", gameOrigin: { kind: "none" } },
    ]),
  );
  await act(async () => cleanup.resolve());

  expect(fixtures.startGame).not.toHaveBeenCalled();
  expect(store.get(pendingGameStartFamily("tab-a"))).toBeNull();
  expect(store.get(gameStateFamily("tab-a"))).toBe("settingUp");
  expect(fixtures.setHeaders).not.toHaveBeenCalled();
  expect(fixtures.appendMove).not.toHaveBeenCalled();
});

test("automatic initial log open applies its successful response", async () => {
  const logs = Promise.withResolvers<any>();
  fixtures.getGameEngineLogs.mockReturnValue(logs.promise);
  store.set(gamePlayer1SettingsAtom, {
    type: "engine",
    engine: engine("automatic-logs"),
    go: { t: "Infinite" },
  });
  await render();
  await start();
  await act(async () => button("Board.Analysis.Logs").click());
  await act(async () => logs.resolve([{ type: "gui", value: "automatic" }]));
  expect(fixtures.setEngineLogs).toEqual([{ type: "gui", value: "automatic" }]);
});

test("automatic initial log open reports its current failure", async () => {
  const logs = Promise.withResolvers<any>();
  fixtures.getGameEngineLogs.mockReturnValue(logs.promise);
  store.set(gamePlayer1SettingsAtom, {
    type: "engine",
    engine: engine("automatic-log-error"),
    go: { t: "Infinite" },
  });
  await render();
  await start();
  await act(async () => button("Board.Analysis.Logs").click());
  await act(async () => logs.reject(new Error("initial logs failed")));
  expect(fixtures.notify).toHaveBeenCalledWith("Common.Error", expect.any(Error));
});

test.each(["success", "failure"] as const)(
  "an effective log colour switch applies its current %s",
  async (outcome) => {
    const initial = Promise.withResolvers<any>();
    const switched = Promise.withResolvers<any>();
    fixtures.getGameEngineLogs
      .mockReset()
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(switched.promise);
    store.set(gamePlayer1SettingsAtom, {
      type: "engine",
      engine: engine("white-logs"),
      go: { t: "Infinite" },
    });
    store.set(gamePlayer2SettingsAtom, {
      type: "engine",
      engine: engine("black-logs"),
      go: { t: "Infinite" },
    });
    await render();
    await start();
    await act(async () => button("Board.Analysis.Logs").click());
    await act(async () => initial.resolve([{ type: "gui", value: "white" }]));
    expect(fixtures.getGameEngineLogs).toHaveBeenLastCalledWith(expect.any(String), 1n, "white");
    await act(async () => fixtures.logColorChange!("black"));
    expect(fixtures.getGameEngineLogs).toHaveBeenCalledTimes(2);
    expect(fixtures.getGameEngineLogs).toHaveBeenLastCalledWith(expect.any(String), 1n, "black");
    fixtures.notify.mockClear();
    const failure = new Error("black logs failed");
    if (outcome === "success") {
      await act(async () => switched.resolve([{ type: "gui", value: "black" }]));
    } else {
      await act(async () => switched.reject(failure));
    }
    expect(fixtures.setEngineLogs).toEqual([
      { type: "gui", value: outcome === "success" ? "black" : "white" },
    ]);
    expect(fixtures.notify.mock.calls).toEqual(
      outcome === "success" ? [] : [["Common.Error", failure]],
    );
  },
);

test.each(["resolve", "reject"] as const)(
  "colour intent synchronously invalidates an old log request that will %s",
  async (outcome) => {
    const oldWhite = Promise.withResolvers<any>();
    const currentBlack = Promise.withResolvers<any>();
    fixtures.getGameEngineLogs
      .mockReset()
      .mockReturnValueOnce(oldWhite.promise)
      .mockReturnValueOnce(currentBlack.promise);
    store.set(gamePlayer1SettingsAtom, {
      type: "engine",
      engine: engine("intent-white"),
      go: { t: "Infinite" },
    });
    store.set(gamePlayer2SettingsAtom, {
      type: "engine",
      engine: engine("intent-black"),
      go: { t: "Infinite" },
    });
    await render();
    await start();
    await act(async () => button("Board.Analysis.Logs").click());
    fixtures.notify.mockClear();
    await act(async () => {
      fixtures.logColorChange!("black");
      if (outcome === "resolve") {
        oldWhite.resolve([{ type: "gui", value: "stale white" }]);
      } else {
        oldWhite.reject(new Error("stale white failure"));
      }
      await Promise.resolve();
    });
    expect(fixtures.setEngineLogs).toEqual([]);
    expect(fixtures.notify).not.toHaveBeenCalled();
    await act(async () => currentBlack.resolve([{ type: "gui", value: "current black" }]));
    expect(fixtures.setEngineLogs).toEqual([{ type: "gui", value: "current black" }]);
  },
);

test.each(["resolve", "reject"] as const)(
  "close intent synchronously invalidates an old log request that will %s",
  async (outcome) => {
    const oldRefresh = Promise.withResolvers<any>();
    fixtures.getGameEngineLogs
      .mockReset()
      .mockResolvedValueOnce([{ type: "gui", value: "initial" }])
      .mockReturnValueOnce(oldRefresh.promise);
    store.set(gamePlayer1SettingsAtom, {
      type: "engine",
      engine: engine("close-intent"),
      go: { t: "Infinite" },
    });
    await render();
    await start();
    await act(async () => button("Board.Analysis.Logs").click());
    expect(fixtures.setEngineLogs).toEqual([{ type: "gui", value: "initial" }]);
    act(() => void fixtures.logRefresh!());
    fixtures.notify.mockClear();
    await act(async () => {
      button("EngineLogs.Close").click();
      if (outcome === "resolve") {
        oldRefresh.resolve([{ type: "gui", value: "stale closed" }]);
      } else {
        oldRefresh.reject(new Error("stale closed failure"));
      }
      await Promise.resolve();
    });
    expect(fixtures.setEngineLogs).toEqual([{ type: "gui", value: "initial" }]);
    expect(fixtures.notify).not.toHaveBeenCalled();
  },
);

const terminalStarts = [
  {
    name: "checkmate",
    result: { type: "whiteWins", reason: "checkmate" },
    outcome: "1-0",
    initialFen: "7k/8/5KQ1/8/8/8/8/8 w - - 0 1",
    moves: [{ uci: "g6g7", clock: null }],
    expectedMoves: [expect.objectContaining({ from: 46, to: 54 })],
  },
  {
    name: "stalemate",
    result: { type: "draw", reason: "stalemate" },
    outcome: "1/2-1/2",
    initialFen: "7k/5K2/6Q1/8/8/8/8/8 b - - 0 1",
    moves: [],
    expectedMoves: [],
  },
] as const;

test.each(terminalStarts)(
  "a terminal $name start completes without any event and relinquishes ownership",
  async ({ result, outcome, initialFen, moves, expectedMoves }) => {
    fixtures.startGame.mockImplementation(async (gameId) =>
      state({ gameId, initialFen, status: { finished: { result } }, moves }),
    );
    await render();
    await start();
    expect(store.get(gameStateFamily("tab-a"))).toBe("gameOver");
    expect(store.get(gameIdFamily("tab-a"))).toBeNull();
    expect(store.get(gameSessionFamily("tab-a"))).toBeNull();
    expect(fixtures.tree.headers.result).toBe(outcome);
    expect(treeMoves()).toEqual(expectedMoves);
    await act(async () => button("Home.NewGame").click());
    expect(fixtures.abortGame).not.toHaveBeenCalled();
  },
);

test.each(terminalStarts)(
  "GameOver before $name start adoption converges on the terminal response",
  async ({ result, outcome, initialFen, moves, expectedMoves }) => {
    const startReply = Promise.withResolvers<any>();
    fixtures.startGame.mockReturnValue(startReply.promise);
    await render();
    act(() => button("Board.Opponent.StartGame").click());
    const gameId = fixtures.startGame.mock.calls[0][0];
    fixtures.listeners.get("gameOver")?.({
      payload: { gameId, session: 1n, revision: 1n, result, moves },
    });
    await act(async () =>
      startReply.resolve(
        state({ gameId, initialFen, revision: 1n, status: { finished: { result } }, moves }),
      ),
    );
    expect(store.get(gameStateFamily("tab-a"))).toBe("gameOver");
    expect(store.get(gameIdFamily("tab-a"))).toBeNull();
    expect(store.get(gameSessionFamily("tab-a"))).toBeNull();
    expect(fixtures.tree.headers.result).toBe(outcome);
    expect(treeMoves()).toEqual(expectedMoves);
    expect(fixtures.abortGame).not.toHaveBeenCalled();
  },
);

test("a post-adoption query reconciles a terminal event that raced a live start", async () => {
  const poll = Promise.withResolvers<any>();
  fixtures.getGameState.mockReturnValueOnce(poll.promise);
  await render();
  await start();
  const gameId = store.get(gameIdFamily("tab-a"));
  await act(async () =>
    poll.resolve(
      state({
        gameId,
        revision: 2n,
        status: { finished: { result: { type: "whiteWins", reason: "checkmate" } } },
      }),
    ),
  );
  expect(store.get(gameStateFamily("tab-a"))).toBe("gameOver");
  expect(store.get(gameIdFamily("tab-a"))).toBeNull();
});

test("an authoritative reply with the current game id but another session is ignored", async () => {
  const poll = Promise.withResolvers<any>();
  fixtures.getGameState.mockReturnValueOnce(poll.promise);
  await render();
  await start();
  fixtures.appendMove.mockClear();
  fixtures.setResult.mockClear();
  const gameId = store.get(gameIdFamily("tab-a"));
  await act(async () =>
    poll.resolve(
      state({
        gameId,
        session: 2n,
        revision: 9n,
        whiteTime: 1n,
        blackTime: 2n,
        moves: [{ uci: "e2e4", clock: 1n }],
        status: { finished: { result: { type: "whiteWins", reason: "checkmate" } } },
      }),
    ),
  );
  expect(fixtures.appendMove).not.toHaveBeenCalled();
  expect(fixtures.setResult).not.toHaveBeenCalled();
  expect(store.get(gameStateFamily("tab-a"))).toBe("playing");
  expect(fixtures.boardProps.whiteTime).toBeUndefined();
  expect(fixtures.boardProps.blackTime).toBeUndefined();
});

test("natural GameOver is terminal against later clock and command rejection", async () => {
  const move = Promise.withResolvers<any>();
  fixtures.makeGameMove.mockReturnValue(move.promise);
  await render();
  await start();
  const gameId = store.get(gameIdFamily("tab-a"));
  let movePromise!: Promise<boolean>;
  act(() => {
    movePromise = fixtures.onMove!("e2e4");
  });
  await act(async () =>
    fixtures.listeners.get("gameOver")?.({
      payload: {
        gameId,
        session: 1n,
        revision: 3n,
        result: { type: "draw", reason: "stalemate" },
        moves: [],
      },
    }),
  );
  await act(async () =>
    fixtures.listeners.get("clockUpdate")?.({
      payload: { gameId, session: 1n, revision: 4n, whiteTime: 1n, blackTime: 1n },
    }),
  );
  await act(async () => move.reject(new Error("late move failure")));
  await movePromise;
  expect(store.get(gameStateFamily("tab-a"))).toBe("gameOver");
  expect(host.querySelector('[role="alert"]')).toBeNull();
  await act(async () => root.unmount());
  expect(fixtures.abortGame).not.toHaveBeenCalled();
  root = createRoot(host);
});

test.each(["reply", "event"] as const)(
  "a late controlled %s cannot mutate a retained panel after workspace removal",
  async (delivery) => {
    const move = Promise.withResolvers<any>();
    if (delivery === "reply") fixtures.makeGameMove.mockReturnValueOnce(move.promise);
    await render();
    await start();
    const gameId = store.get(gameIdFamily("tab-a"))!;
    let moveResult: Promise<boolean> | undefined;
    if (delivery === "reply") {
      act(() => {
        moveResult = fixtures.onMove!("e2e4");
      });
    }
    store.set(tabsAtom, [
      { name: "B", value: "tab-b", type: "play", gameOrigin: { kind: "none" } },
    ]);
    fixtures.appendMove.mockClear();
    fixtures.setResult.mockClear();

    if (delivery === "reply") {
      await act(async () =>
        move.resolve(state({ gameId, revision: 1n, moves: [{ uci: "e2e4", clock: null }] })),
      );
    } else {
      act(() =>
        fixtures.listeners.get("gameOver")?.({
          payload: {
            gameId,
            session: 1n,
            revision: 1n,
            result: { type: "whiteWins", reason: "checkmate" },
            moves: [{ uci: "e2e4", clock: null }],
          },
        }),
      );
    }

    expect(await moveResult).toBe(delivery === "reply" ? false : undefined);
    expect(fixtures.appendMove).not.toHaveBeenCalled();
    expect(fixtures.setResult).not.toHaveBeenCalled();
    expect(store.get(gameStateFamily("tab-a"))).toBe("playing");
  },
);

test.each(["reply", "event"] as const)(
  "a late controlled %s cannot mutate a replaced captured owner pair before rerender",
  async (delivery) => {
    const move = Promise.withResolvers<any>();
    if (delivery === "reply") fixtures.makeGameMove.mockReturnValueOnce(move.promise);
    await render();
    await start();
    const oldGameId = store.get(gameIdFamily("tab-a"))!;
    let moveResult: Promise<boolean> | undefined;
    if (delivery === "reply") {
      act(() => {
        moveResult = fixtures.onMove!("e2e4");
      });
    }
    store.set(gameIdFamily("tab-a"), "replacement");
    store.set(gameSessionFamily("tab-a"), 2n);
    store.set(gameStateFamily("tab-a"), "playing");
    fixtures.appendMove.mockClear();
    fixtures.setResult.mockClear();

    if (delivery === "reply") {
      await act(async () =>
        move.resolve(
          state({ gameId: oldGameId, revision: 1n, moves: [{ uci: "e2e4", clock: null }] }),
        ),
      );
    } else {
      act(() =>
        fixtures.listeners.get("gameOver")?.({
          payload: {
            gameId: oldGameId,
            session: 1n,
            revision: 1n,
            result: { type: "whiteWins", reason: "checkmate" },
            moves: [{ uci: "e2e4", clock: null }],
          },
        }),
      );
    }

    expect(await moveResult).toBe(delivery === "reply" ? false : undefined);
    expect(store.get(gameIdFamily("tab-a"))).toBe("replacement");
    expect(store.get(gameSessionFamily("tab-a"))).toBe(2n);
    expect(store.get(gameStateFamily("tab-a"))).toBe("playing");
    expect(fixtures.appendMove).not.toHaveBeenCalled();
    expect(fixtures.setResult).not.toHaveBeenCalled();
  },
);

test.each(["removed", "replaced"] as const)(
  "a retained move handler cannot admit native work after owner %s",
  async (ownership) => {
    await render();
    await start();
    if (ownership === "removed") {
      store.set(tabsAtom, [
        { name: "B", value: "tab-b", type: "play", gameOrigin: { kind: "none" } },
      ]);
    } else {
      store.set(gameIdFamily("tab-a"), "replacement");
      store.set(gameSessionFamily("tab-a"), 2n);
    }

    await expect(fixtures.onMove!("e2e4")).resolves.toBe(false);
    expect(fixtures.boardProps.onKeyboardPremove("e2", "e4")).toBe(false);
    expect(fixtures.makeGameMove).not.toHaveBeenCalled();
    expect(fixtures.queuePremove).not.toHaveBeenCalled();
  },
);

test("queued move and premove work is discarded after workspace removal", async () => {
  vi.useFakeTimers();
  await render();
  await start();
  const gameId = store.get(gameIdFamily("tab-a"));
  expect(fixtures.boardProps.onKeyboardPremove("e2", "e4")).toBe(true);
  act(() =>
    fixtures.listeners.get("gameMove")?.({
      payload: {
        gameId,
        session: 1n,
        revision: 1n,
        moves: [{ uci: "e2e4", clock: null }],
        whiteTime: null,
        blackTime: null,
      },
    }),
  );
  fixtures.appendMove.mockClear();
  store.set(tabsAtom, [{ name: "B", value: "tab-b", type: "play", gameOrigin: { kind: "none" } }]);

  await act(async () => vi.runAllTimersAsync());

  expect(fixtures.appendMove).not.toHaveBeenCalled();
  expect(fixtures.playPremove).not.toHaveBeenCalled();
  vi.useRealTimers();
});

test("a resignation response applies terminal moves and clears abortable ownership", async () => {
  fixtures.resignGame.mockImplementation(async (gameId, session) =>
    state({
      gameId,
      session,
      revision: 1n,
      status: { finished: { result: { type: "blackWins", reason: "resignation" } } },
    }),
  );
  await render();
  await start();
  await act(async () => button("Board.Opponent.Resign").click());
  expect(store.get(gameStateFamily("tab-a"))).toBe("gameOver");
  expect(store.get(gameIdFamily("tab-a"))).toBeNull();
  expect(store.get(gameSessionFamily("tab-a"))).toBeNull();
});

test("abort success clears ownership and reset or unmount cannot abort it twice", async () => {
  store.set(gamePlayer1SettingsAtom, {
    type: "engine",
    engine: engine("white"),
    go: { t: "Infinite" },
  });
  store.set(gamePlayer2SettingsAtom, {
    type: "engine",
    engine: engine("black"),
    go: { t: "Infinite" },
  });
  await render();
  await start();
  fixtures.abortGame.mockClear();
  await act(async () => button("Board.Opponent.Abort").click());
  expect(fixtures.abortGame).toHaveBeenCalledOnce();
  expect(store.get(gameStateFamily("tab-a"))).toBe("gameOver");
  expect(store.get(gameIdFamily("tab-a"))).toBeNull();
  await act(async () => button("Home.NewGame").click());
  await act(async () => root.unmount());
  expect(fixtures.abortGame).toHaveBeenCalledOnce();
  root = createRoot(host);
});

test("abort still retires native ownership after removal without applying a UI result", async () => {
  const abort = Promise.withResolvers<void>();
  store.set(gamePlayer1SettingsAtom, {
    type: "engine",
    engine: engine("removed-white"),
    go: { t: "Infinite" },
  });
  store.set(gamePlayer2SettingsAtom, {
    type: "engine",
    engine: engine("removed-black"),
    go: { t: "Infinite" },
  });
  await render();
  await start();
  fixtures.abortGame.mockReturnValueOnce(abort.promise);
  fixtures.setResult.mockClear();
  act(() => button("Board.Opponent.Abort").click());
  store.set(tabsAtom, [{ name: "B", value: "tab-b", type: "play", gameOrigin: { kind: "none" } }]);

  await act(async () => abort.resolve());

  expect(fixtures.abortGame).toHaveBeenCalledOnce();
  expect(store.get(gameIdFamily("tab-a"))).toBeNull();
  expect(store.get(gameSessionFamily("tab-a"))).toBeNull();
  expect(store.get(gameStateFamily("tab-a"))).toBe("playing");
  expect(fixtures.setResult).not.toHaveBeenCalled();
});

test("terminal handoff makes a late takeback catch and finally silent", async () => {
  const takeback = Promise.withResolvers<any>();
  fixtures.takeBackGameMove.mockReturnValue(takeback.promise);
  await render();
  await start();
  const gameId = store.get(gameIdFamily("tab-a"));
  act(() => void fixtures.onTakeBack!());
  await act(async () =>
    fixtures.listeners.get("gameOver")?.({
      payload: {
        gameId,
        session: 1n,
        revision: 2n,
        result: { type: "draw", reason: "stalemate" },
        moves: [],
      },
    }),
  );
  await act(async () => takeback.reject(new Error("late takeback")));
  expect(store.get(gameStateFamily("tab-a"))).toBe("gameOver");
  expect(host.querySelector('[role="alert"]')).toBeNull();
});

test.each(["move", "takeback", "abort", "resign"] as const)(
  "stale %s catch and finally cannot clear a replacement start token",
  async (command) => {
    if (command === "abort") {
      store.set(gamePlayer1SettingsAtom, {
        type: "engine",
        engine: engine("abort-white"),
        go: { t: "Infinite" },
      });
      store.set(gamePlayer2SettingsAtom, {
        type: "engine",
        engine: engine("abort-black"),
        go: { t: "Infinite" },
      });
    }
    const oldCommand = Promise.withResolvers<any>();
    if (command === "move") fixtures.makeGameMove.mockReturnValueOnce(oldCommand.promise);
    if (command === "takeback") fixtures.takeBackGameMove.mockReturnValueOnce(oldCommand.promise);
    if (command === "abort") fixtures.abortGame.mockReturnValueOnce(oldCommand.promise);
    if (command === "resign") fixtures.resignGame.mockReturnValueOnce(oldCommand.promise);
    await render();
    await start();
    const oldGameId = store.get(gameIdFamily("tab-a"));
    if (command === "move") act(() => void fixtures.onMove!("e2e4"));
    if (command === "takeback") act(() => void fixtures.onTakeBack!());
    if (command === "abort") act(() => button("Board.Opponent.Abort").click());
    if (command === "resign") act(() => button("Board.Opponent.Resign").click());
    await act(async () => Promise.resolve());
    await act(async () =>
      fixtures.listeners.get("gameOver")?.({
        payload: {
          gameId: oldGameId,
          session: 1n,
          revision: 2n,
          result: { type: "draw", reason: "stalemate" },
          moves: [],
        },
      }),
    );
    await act(async () => button("Home.NewGame").click());
    const replacement = Promise.withResolvers<any>();
    fixtures.startGame.mockReturnValueOnce(replacement.promise);
    await act(async () => button("Board.Opponent.StartGame").click());
    expect((button("Board.Opponent.StartGame") as HTMLButtonElement).dataset.loading).toBe("true");
    fixtures.notify.mockClear();
    await act(async () => oldCommand.reject(new Error(`late ${command}`)));
    const replacementButton = button("Board.Opponent.StartGame") as HTMLButtonElement;
    expect(replacementButton.disabled).toBe(true);
    expect(replacementButton.dataset.loading).toBe("true");
    expect(store.get(pendingGameStartFamily("tab-a"))).not.toBeNull();
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(fixtures.notify).not.toHaveBeenCalled();
    const replacementGameId = fixtures.startGame.mock.calls[1][0];
    await act(async () => replacement.resolve(state({ gameId: replacementGameId, session: 2n })));
  },
);

test.each(["takeback", "abort", "resign"] as const)(
  "current %s rejection remains visible and retains ownership",
  async (command) => {
    if (command === "abort") {
      store.set(gamePlayer1SettingsAtom, {
        type: "engine",
        engine: engine("current-abort-white"),
        go: { t: "Infinite" },
      });
      store.set(gamePlayer2SettingsAtom, {
        type: "engine",
        engine: engine("current-abort-black"),
        go: { t: "Infinite" },
      });
    }
    await render();
    await start();
    const gameId = store.get(gameIdFamily("tab-a"));
    const failure = new Error(`${command} rejected`);
    if (command === "takeback") {
      fixtures.takeBackGameMove.mockRejectedValueOnce(failure);
      await act(async () => fixtures.onTakeBack!());
    }
    if (command === "abort") {
      fixtures.abortGame.mockRejectedValueOnce(failure);
      await act(async () => button("Board.Opponent.Abort").click());
    }
    if (command === "resign") {
      fixtures.resignGame.mockRejectedValueOnce(failure);
      await act(async () => button("Board.Opponent.Resign").click());
    }
    const expectedKeys = {
      takeback: "Board.Opponent.Error.Takeback",
      abort: "Board.Opponent.Error.Abort",
      resign: "Board.Opponent.Error.Resign",
    } as const;
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(expectedKeys[command]);
    expect(host.querySelector('[role="alert"]')?.textContent).not.toContain(`${command} rejected`);
    expect(store.get(gameIdFamily("tab-a"))).toBe(gameId);
    expect(store.get(gameSessionFamily("tab-a"))).toBe(1n);
  },
);

test("current move and recovery rejections are visible and fully handled", async () => {
  fixtures.makeGameMove.mockRejectedValueOnce(new Error("move rejected at /private/game.pgn"));
  fixtures.getGameState
    .mockResolvedValueOnce(state())
    .mockRejectedValueOnce(new Error("poll failed"));
  await render();
  await start();
  const gameId = store.get(gameIdFamily("tab-a"))!;
  await act(async () => fixtures.onMove!("e2e4"));
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("Board.Opponent.Error.Move");
  expect(host.querySelector('[role="alert"]')?.textContent).not.toContain("move rejected");
  expect(fixtures.logError).toHaveBeenCalledWith(
    expect.stringContaining(
      `game command move failed [tab=tab-a generation=1 game=${gameId} session=1]:`,
    ),
  );
  expect(fixtures.notify).toHaveBeenCalledWith("Common.Error", expect.any(Error));
});

test("current move recovery success applies the authoritative board", async () => {
  fixtures.makeGameMove.mockRejectedValueOnce(new Error("move rejected"));
  await render();
  await start();
  fixtures.getGameState.mockClear();
  const gameId = store.get(gameIdFamily("tab-a"));
  fixtures.getGameState.mockResolvedValueOnce(
    state({ gameId, revision: 2n, moves: [{ uci: "e2e4", clock: null }] }),
  );
  await act(async () => fixtures.onMove!("e2e4"));
  expect(fixtures.appendMove).toHaveBeenCalledWith(
    expect.objectContaining({ payload: expect.objectContaining({ from: 12, to: 28 }) }),
  );
});

test("one local command token admits only the first synchronous handler", async () => {
  const move = Promise.withResolvers<any>();
  fixtures.makeGameMove.mockReturnValueOnce(move.promise);
  await render();
  await start();
  const gameId = store.get(gameIdFamily("tab-a"));

  let moveResult!: Promise<boolean>;
  act(() => {
    moveResult = fixtures.onMove!("e2e4");
    void fixtures.onTakeBack!();
  });
  expect(fixtures.makeGameMove).toHaveBeenCalledOnce();
  expect(fixtures.takeBackGameMove).not.toHaveBeenCalled();

  await act(async () => move.resolve(state({ gameId, revision: 1n })));
  await expect(moveResult).resolves.toBe(true);
});

test.each(["current", "stale"] as const)(
  "%s playing-state poll rejection is handled with ownership guards",
  async (mode) => {
    const poll = Promise.withResolvers<any>();
    fixtures.getGameState.mockReset().mockReturnValueOnce(poll.promise);
    await render();
    await start();
    expect(fixtures.getGameState).toHaveBeenCalledOnce();
    if (mode === "stale") {
      const gameId = store.get(gameIdFamily("tab-a"));
      await act(async () =>
        fixtures.listeners.get("gameOver")?.({
          payload: {
            gameId,
            session: 1n,
            revision: 2n,
            result: { type: "draw", reason: "stalemate" },
            moves: [],
          },
        }),
      );
    }
    fixtures.notify.mockClear();
    await act(async () => {
      poll.reject(new Error("playing poll failed"));
      await Promise.resolve();
    });
    expect(fixtures.notify).toHaveBeenCalledTimes(mode === "current" ? 1 : 0);
  },
);

test.each(["resolve", "reject"] as const)(
  "a stale move recovery that %s is silent and fully handled",
  async (outcome) => {
    const recovery = Promise.withResolvers<any>();
    fixtures.makeGameMove.mockRejectedValueOnce(new Error("move rejected"));
    fixtures.getGameState
      .mockReset()
      .mockResolvedValueOnce(state())
      .mockReturnValueOnce(recovery.promise);
    await render();
    await start();
    const gameId = store.get(gameIdFamily("tab-a"));
    let movePromise!: Promise<boolean>;
    act(() => {
      movePromise = fixtures.onMove!("e2e4");
    });
    await act(async () => Promise.resolve());
    expect(fixtures.getGameState).toHaveBeenCalledTimes(2);
    await act(async () =>
      fixtures.listeners.get("gameOver")?.({
        payload: {
          gameId,
          session: 1n,
          revision: 2n,
          result: { type: "draw", reason: "stalemate" },
          moves: [],
        },
      }),
    );
    fixtures.notify.mockClear();
    fixtures.appendMove.mockClear();
    if (outcome === "resolve") {
      await act(async () =>
        recovery.resolve(state({ gameId, revision: 3n, moves: [{ uci: "e2e4", clock: null }] })),
      );
    } else {
      await act(async () => recovery.reject(new Error("stale recovery")));
    }
    await movePromise;
    expect(fixtures.notify).not.toHaveBeenCalled();
    expect(fixtures.appendMove).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')).toBeNull();
  },
);

test.each(["clock-before-move", "move-before-clock"] as const)(
  "%s preserves the actual move and newest clocks",
  async (order) => {
    vi.useFakeTimers();
    await render();
    await start();
    const gameId = store.get(gameIdFamily("tab-a"));
    const moveEvent = () =>
      fixtures.listeners.get("gameMove")?.({
        payload: {
          gameId,
          session: 1n,
          revision: 1n,
          moves: [{ uci: "e2e4", clock: 111n }],
          whiteTime: 100n,
          blackTime: 200n,
        },
      });
    const clockEvent = () =>
      fixtures.listeners.get("clockUpdate")?.({
        payload: { gameId, session: 1n, revision: 2n, whiteTime: 300n, blackTime: 400n },
      });
    await act(async () => {
      if (order === "clock-before-move") {
        clockEvent();
        moveEvent();
      } else {
        moveEvent();
        clockEvent();
      }
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(treeMoves()).toEqual([expect.objectContaining({ from: 12, to: 28 })]);
    expect(fixtures.boardProps.whiteTime).toBe(300);
    expect(fixtures.boardProps.blackTime).toBe(400);
    vi.useRealTimers();
  },
);

test.each(["clock-before-terminal", "terminal-before-clock"] as const)(
  "%s cannot reopen or overwrite terminal moves and result",
  async (order) => {
    await render();
    await start();
    const gameId = store.get(gameIdFamily("tab-a"));
    const terminal = () =>
      fixtures.listeners.get("gameOver")?.({
        payload: {
          gameId,
          session: 1n,
          revision: 2n,
          result: { type: "whiteWins", reason: "checkmate" },
          moves: [{ uci: "e2e4", clock: 111n }],
        },
      });
    const clock = () =>
      fixtures.listeners.get("clockUpdate")?.({
        payload: { gameId, session: 1n, revision: 3n, whiteTime: 1n, blackTime: 2n },
      });
    await act(async () => {
      if (order === "clock-before-terminal") {
        clock();
        terminal();
      } else {
        terminal();
        clock();
      }
    });
    expect(store.get(gameStateFamily("tab-a"))).toBe("gameOver");
    expect(fixtures.tree.headers.result).toBe("1-0");
    expect(treeMoves()).toEqual([expect.objectContaining({ from: 12, to: 28 })]);
  },
);

test("terminal completion cancels the queued premove callback", async () => {
  vi.useFakeTimers();
  await render();
  await start();
  const gameId = store.get(gameIdFamily("tab-a"));
  expect(fixtures.boardProps.onKeyboardPremove("e2", "e4")).toBe(true);
  act(() =>
    fixtures.listeners.get("gameMove")?.({
      payload: {
        gameId,
        session: 1n,
        revision: 1n,
        moves: [{ uci: "e2e4", clock: null }],
        whiteTime: null,
        blackTime: null,
      },
    }),
  );
  await act(async () => vi.advanceTimersByTimeAsync(150));
  await act(async () =>
    fixtures.listeners.get("gameOver")?.({
      payload: {
        gameId,
        session: 1n,
        revision: 2n,
        result: { type: "draw", reason: "stalemate" },
        moves: [{ uci: "e2e4", clock: null }],
      },
    }),
  );
  await act(async () => vi.runAllTimersAsync());
  expect(fixtures.playPremove).not.toHaveBeenCalled();
  vi.useRealTimers();
});

test("queued older move data cannot overwrite a newer command snapshot", async () => {
  vi.useFakeTimers();
  fixtures.makeGameMove.mockImplementation(async (gameId, session) =>
    state({
      gameId,
      session,
      revision: 2n,
      moves: [{ uci: "e2e4", clock: null }],
      whiteTime: 300n,
      blackTime: 400n,
    }),
  );
  await render();
  await start();
  const gameId = store.get(gameIdFamily("tab-a"));
  act(() =>
    fixtures.listeners.get("gameMove")?.({
      payload: {
        gameId,
        session: 1n,
        revision: 1n,
        moves: [{ uci: "d2d4", clock: null }],
        whiteTime: 100n,
        blackTime: 200n,
      },
    }),
  );
  await act(async () => fixtures.onMove!("e2e4"));
  await act(async () => vi.advanceTimersByTimeAsync(200));
  expect(fixtures.appendMove).toHaveBeenCalledWith(
    expect.objectContaining({ payload: expect.objectContaining({ from: 12, to: 28 }) }),
  );
  expect(fixtures.appendMove).not.toHaveBeenCalledWith(
    expect.objectContaining({ payload: expect.objectContaining({ from: 11, to: 27 }) }),
  );
  expect(fixtures.boardProps.whiteTime).toBe(300);
  expect(fixtures.boardProps.blackTime).toBe(400);
  vi.useRealTimers();
});

test.each(["resolve", "reject"] as const)(
  "a log request that %s after terminal completion is silent",
  async (outcome) => {
    const logs = Promise.withResolvers<any>();
    fixtures.getGameEngineLogs.mockReturnValue(logs.promise);
    store.set(gamePlayer1SettingsAtom, {
      type: "engine",
      engine: engine("engine-id"),
      go: { t: "Infinite" },
    });
    await render();
    await start();
    const gameId = store.get(gameIdFamily("tab-a"));
    await act(async () => button("Board.Analysis.Logs").click());
    await act(async () =>
      fixtures.listeners.get("gameOver")?.({
        payload: {
          gameId,
          session: 1n,
          revision: 2n,
          result: { type: "draw", reason: "stalemate" },
          moves: [],
        },
      }),
    );
    fixtures.notify.mockClear();
    if (outcome === "resolve")
      await act(async () => logs.resolve([{ type: "gui", value: "late" }]));
    else await act(async () => logs.reject(new Error("late logs")));
    expect(fixtures.setEngineLogs).toEqual([]);
    expect(fixtures.notify).not.toHaveBeenCalled();
  },
);

test("overlapping log refreshes keep the latest result and panel close silences failure", async () => {
  const first = Promise.withResolvers<any>();
  const second = Promise.withResolvers<any>();
  const afterClose = Promise.withResolvers<any>();
  fixtures.getGameEngineLogs
    .mockReset()
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise)
    .mockReturnValueOnce(afterClose.promise);
  store.set(gamePlayer1SettingsAtom, {
    type: "engine",
    engine: engine("logs"),
    go: { t: "Infinite" },
  });
  await render();
  await start();
  await act(async () => button("Board.Analysis.Logs").click());
  act(() => void fixtures.logRefresh!());
  await act(async () => second.resolve([{ type: "gui", value: "new" }]));
  await act(async () => first.resolve([{ type: "gui", value: "old" }]));
  expect(fixtures.setEngineLogs).toEqual([{ type: "gui", value: "new" }]);
  act(() => void fixtures.logRefresh!());
  await act(async () => button("EngineLogs.Close").click());
  fixtures.notify.mockClear();
  await act(async () => afterClose.reject(new Error("closed logs")));
  expect(fixtures.notify).not.toHaveBeenCalled();
});

test("malformed event errors report only for the current unique game", async () => {
  await render();
  await start();
  const gameId = store.get(gameIdFamily("tab-a"));
  const report = fixtures.listenerErrors.get("gameMove")!;
  report(new Error("bad"), { payload: { gameId: "other", session: "bad" } });
  report(new Error("bad"), { payload: { gameId, session: 2 } });
  expect(fixtures.notify).not.toHaveBeenCalled();
  report(new Error("bad"), { payload: { gameId, session: "bad" } });
  expect(fixtures.notify).toHaveBeenCalledOnce();
  await act(async () =>
    fixtures.listeners.get("gameOver")?.({
      payload: {
        gameId,
        session: 1n,
        revision: 2n,
        result: { type: "draw", reason: "stalemate" },
        moves: [],
      },
    }),
  );
  report(new Error("completed"), { payload: { gameId, session: "bad" } });
  expect(fixtures.notify).toHaveBeenCalledOnce();
});

test("listener registration failure reports only while mounted without an event", async () => {
  await render();
  const report = fixtures.listenerErrors.get("gameMove")!;
  report(new Error("registration failed"), undefined);
  expect(fixtures.notify).toHaveBeenCalledOnce();
  store.set(tabsAtom, [{ name: "B", value: "tab-b", type: "play", gameOrigin: { kind: "none" } }]);
  report(new Error("registration after removal"), undefined);
  expect(fixtures.notify).toHaveBeenCalledOnce();
  await act(async () => root.unmount());
  report(new Error("registration after unmount"), undefined);
  expect(fixtures.notify).toHaveBeenCalledOnce();
  root = createRoot(host);
});

test.each(["resolve", "reject"] as const)(
  "a log request that %s after owner handoff cannot write to the replacement",
  async (outcome) => {
    const logs = Promise.withResolvers<any>();
    fixtures.getGameEngineLogs.mockReturnValue(logs.promise);
    store.set(gamePlayer1SettingsAtom, {
      type: "engine",
      engine: engine("handoff-logs"),
      go: { t: "Infinite" },
    });
    await render("tab-a");
    await start();
    await act(async () => button("Board.Analysis.Logs").click());
    await act(async () => root.unmount());
    root = createRoot(host);
    store.set(gamePlayer1SettingsAtom, { type: "human", name: "Alice" });
    await render("tab-b");
    fixtures.notify.mockClear();
    if (outcome === "resolve") {
      await act(async () => logs.resolve([{ type: "gui", value: "old owner" }]));
    } else {
      await act(async () => logs.reject(new Error("old owner logs")));
    }
    expect(fixtures.setEngineLogs).toEqual([]);
    expect(fixtures.notify).not.toHaveBeenCalled();
  },
);

test("retained ownership blocks replacement after teardown failure and permits retry", async () => {
  await render();
  store.set(gameIdFamily("tab-a"), "retained");
  store.set(gameSessionFamily("tab-a"), 7n);
  await act(async () => Promise.resolve());
  fixtures.abortGame.mockRejectedValueOnce(new Error("cleanup failed"));
  await start();
  expect(fixtures.startGame).not.toHaveBeenCalled();
  expect(store.get(gameIdFamily("tab-a"))).toBe("retained");
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("Board.Opponent.Error.Start");
  await start();
  expect(fixtures.abortGame).toHaveBeenCalledWith("retained", 7n);
  expect(fixtures.startGame).toHaveBeenCalledOnce();
});

test("unmount and remount cannot admit a second unresolved start", async () => {
  const reply = Promise.withResolvers<any>();
  fixtures.startGame.mockReturnValue(reply.promise);
  await render();
  act(() => button("Board.Opponent.StartGame").click());
  await act(async () => root.unmount());
  root = createRoot(host);
  await render();
  await act(async () => button("Board.Opponent.StartGame").click());
  expect(fixtures.startGame).toHaveBeenCalledOnce();
  const admittedGameId = fixtures.startGame.mock.calls[0][0];
  await act(async () => reply.resolve(state({ gameId: admittedGameId })));
  expect(fixtures.abortGame).toHaveBeenCalledWith(admittedGameId, 1n);
  expect(store.get(gameStateFamily("tab-a"))).toBe("gameOver");
});

test("stale-start cleanup failure retains exact identity and a remount retries it", async () => {
  const staleStart = Promise.withResolvers<any>();
  fixtures.startGame.mockReturnValueOnce(staleStart.promise);
  await render();
  act(() => button("Board.Opponent.StartGame").click());
  const staleGameId = fixtures.startGame.mock.calls[0][0];
  await act(async () => root.unmount());
  fixtures.abortGame.mockRejectedValueOnce(new Error("stale cleanup failed"));
  await act(async () => staleStart.resolve(state({ gameId: staleGameId })));
  expect(store.get(gameIdFamily("tab-a"))).toBe(staleGameId);
  expect(store.get(gameSessionFamily("tab-a"))).toBe(1n);
  expect(fixtures.notify).toHaveBeenCalledWith("Common.Error", expect.any(Error));

  root = createRoot(host);
  await render();
  fixtures.startGame.mockImplementationOnce(async (gameId) => state({ gameId, session: 2n }));
  await start();
  expect(fixtures.abortGame).toHaveBeenLastCalledWith(staleGameId, 1n);
  expect(fixtures.startGame).toHaveBeenCalledTimes(2);
  expect(store.get(gameSessionFamily("tab-a"))).toBe(2n);
});

test("old deferred cleanup cannot clear a newer same-tab native identity", async () => {
  await render();
  await start();
  const oldAbort = Promise.withResolvers<void>();
  fixtures.abortGame.mockReturnValueOnce(oldAbort.promise);
  await act(async () => root.unmount());
  store.set(gameIdFamily("tab-a"), "replacement");
  store.set(gameSessionFamily("tab-a"), 2n);
  store.set(gameStateFamily("tab-a"), "playing");
  await act(async () => oldAbort.resolve());
  expect(store.get(gameIdFamily("tab-a"))).toBe("replacement");
  expect(store.get(gameSessionFamily("tab-a"))).toBe(2n);
  expect(store.get(gameStateFamily("tab-a"))).toBe("playing");
  root = createRoot(host);
});

test("successful unmount retires ownership as gameOver and remount can reset", async () => {
  await render();
  await start();
  await act(async () => root.unmount());
  expect(store.get(gameIdFamily("tab-a"))).toBeNull();
  expect(store.get(gameSessionFamily("tab-a"))).toBeNull();
  expect(store.get(gameStateFamily("tab-a"))).toBe("gameOver");
  root = createRoot(host);
  await render();
  await act(async () => button("Home.NewGame").click());
  expect(store.get(gameStateFamily("tab-a"))).toBe("settingUp");
});

test("StrictMode setup replay restores the mounted owner", async () => {
  await act(async () =>
    root.render(
      <StrictMode>
        <TreeStateContext.Provider value={fixtures.treeStore}>
          <BoardGame tabId="tab-a" />
        </TreeStateContext.Provider>
      </StrictMode>,
    ),
  );
  await start();
  expect(fixtures.startGame).toHaveBeenCalledOnce();
  expect(store.get(gameStateFamily("tab-a"))).toBe("playing");
  expect(store.get(gameIdFamily("tab-a"))).not.toBeNull();
});

test("initialization restores setup moves into the reset live tree and keeps metadata", async () => {
  fixtures.tree.root.children.push({
    fen: INITIAL_FEN,
    move: { from: 12, to: 28 },
    children: [],
  });
  fixtures.startGame.mockImplementationOnce(async (gameId) =>
    state({ gameId, revision: 1n, moves: [{ uci: "e2e4", clock: null }] }),
  );
  await render();
  await start();
  expect(treeMoves()).toEqual([expect.objectContaining({ from: 12, to: 28 })]);
  expect(fixtures.tree.headers).toEqual(expect.objectContaining({ site: "ChessRiddle Studio" }));
});

test("consecutive authoritative snapshots extend the live tree before React rerenders", async () => {
  const poll = Promise.withResolvers<any>();
  const move = Promise.withResolvers<any>();
  fixtures.getGameState.mockReturnValueOnce(poll.promise);
  fixtures.makeGameMove.mockReturnValueOnce(move.promise);
  await render();
  await start();
  const gameId = store.get(gameIdFamily("tab-a"));
  let movePromise!: Promise<boolean>;
  act(() => {
    movePromise = fixtures.onMove!("e2e4");
  });
  await act(async () => {
    move.resolve(state({ gameId, revision: 1n, moves: [{ uci: "e2e4", clock: null }] }));
    await Promise.resolve();
    poll.resolve(
      state({
        gameId,
        revision: 2n,
        moves: [
          { uci: "e2e4", clock: null },
          { uci: "e7e5", clock: null },
        ],
      }),
    );
  });
  await movePromise;
  expect(treeMoves()).toEqual([
    expect.objectContaining({ from: 12, to: 28 }),
    expect.objectContaining({ from: 52, to: 36 }),
  ]);
});

test("delayed tab A command writes cannot mutate tab B after handoff", async () => {
  const move = Promise.withResolvers<any>();
  fixtures.makeGameMove.mockReturnValue(move.promise);
  await render("tab-a");
  await start();
  let moveResult!: Promise<boolean>;
  act(() => {
    moveResult = fixtures.onMove!("e2e4");
  });
  await act(async () => root.unmount());
  fixtures.startGame.mockImplementationOnce(async (gameId) => state({ gameId, session: 2n }));
  fixtures.getGameState.mockImplementation(async (gameId, session) => state({ gameId, session }));
  root = createRoot(host);
  await render("tab-b");
  await start();
  const gameB = store.get(gameIdFamily("tab-b"));
  fixtures.notify.mockClear();
  await act(async () => move.reject(new Error("late A move")));
  await moveResult;
  expect(store.get(gameIdFamily("tab-b"))).toBe(gameB);
  expect(store.get(gameSessionFamily("tab-b"))).toBe(2n);
  expect(fixtures.notify).not.toHaveBeenCalled();
});

test("synchronous player conversion failure clears pending start and permits retry", async () => {
  store.set(gamePlayer1SettingsAtom, { type: "engine", engine: null, go: { t: "Infinite" } });
  await render();
  await start();
  expect(fixtures.startGame).not.toHaveBeenCalled();
  expect(store.get(pendingGameStartFamily("tab-a"))).toBeNull();
  expect(host.querySelector('[role="alert"]')?.textContent).toBe(
    "Board.Opponent.Error.MissingEngine",
  );
  expect(host.querySelector('[role="alert"]')?.textContent).not.toContain(
    "A local engine must be selected",
  );
  expect(fixtures.logError).toHaveBeenCalledWith(
    "game command start failed [tab=tab-a generation=1]: A local engine must be selected for an engine player",
  );
  store.set(gamePlayer1SettingsAtom, { type: "human", name: "Alice" });
  await act(async () => Promise.resolve());
  await start();
  expect(fixtures.startGame).toHaveBeenCalledOnce();
});

test("a player selection whose engine was removed never reaches the backend", async () => {
  // Removal permanently retires the application id, so the start is refused here rather than
  // by the supervisor, whatever the picker last wrote into the saved selection.
  store.set(gamePlayer1SettingsAtom, {
    type: "engine",
    engine: engine("retired-before-start"),
    go: { t: "Infinite" },
  });
  store.set(enginesAtom, []);
  await render();
  await start();
  expect(fixtures.startGame).not.toHaveBeenCalled();
  expect(host.querySelector('[role="alert"]')?.textContent).toBe(
    "Board.Opponent.Error.MissingEngine",
  );
  expect(fixtures.logError).toHaveBeenCalledWith(
    "game command start failed [tab=tab-a generation=1]: The selected local engine is not in the current engine list",
  );
});

test("a start before the engine list has hydrated is refused instead of guessed", async () => {
  store.set(gamePlayer1SettingsAtom, {
    type: "engine",
    engine: engine("unhydrated-start"),
    go: { t: "Infinite" },
  });
  store.set(enginesAtom, undefined as never);
  await render();
  await start();
  expect(fixtures.startGame).not.toHaveBeenCalled();
  expect(host.querySelector('[role="alert"]')?.textContent).toBe(
    "Board.Opponent.Error.MissingEngine",
  );
});

test("close intent refuses start without pending work and release permits retry", async () => {
  store.set(closingTabsAtom, new Set(["tab-a"]));
  await render();
  await start();
  expect(fixtures.startGame).not.toHaveBeenCalled();
  expect(store.get(pendingGameStartFamily("tab-a"))).toBeNull();
  store.set(closingTabsAtom, new Set());
  await act(async () => Promise.resolve());
  await start();
  expect(fixtures.startGame).toHaveBeenCalledOnce();
});

describe("cleanup ownership", () => {
  test("unmount retains exact ownership and reports cleanup failure", async () => {
    await render();
    await start();
    const gameId = store.get(gameIdFamily("tab-a"));
    fixtures.abortGame.mockRejectedValueOnce(new Error("unmount cleanup failed"));
    await act(async () => root.unmount());
    expect(store.get(gameIdFamily("tab-a"))).toBe(gameId);
    expect(store.get(gameSessionFamily("tab-a"))).toBe(1n);
    expect(fixtures.notify).toHaveBeenCalledWith("Common.Error", expect.any(Error));
    root = createRoot(host);
    await render();
    fixtures.notify.mockClear();
    await act(async () => root.unmount());
    expect(fixtures.abortGame).toHaveBeenLastCalledWith(gameId, 1n);
    expect(store.get(gameIdFamily("tab-a"))).toBeNull();
    expect(store.get(gameSessionFamily("tab-a"))).toBeNull();
    expect(store.get(gameStateFamily("tab-a"))).toBe("gameOver");
    expect(fixtures.notify).not.toHaveBeenCalled();
    root = createRoot(host);
  });
});
describe("native game delivery reconciliation", () => {
  test("dropped renderer events are recovered through periodic authoritative snapshots, including terminal completion after query failure", async () => {
    vi.useFakeTimers();
    const gameMoves: any[] = [];
    fixtures.getGameState.mockImplementation(async (gameId, session) =>
      state({
        gameId,
        session,
        revision: BigInt(gameMoves.length),
        moves: [...gameMoves],
        whiteTime: gameMoves.length > 0 ? 299000n : 300000n,
        blackTime: 300000n,
        status:
          gameMoves.length >= 2
            ? { finished: { result: { type: "whiteWins", reason: "checkmate" } } }
            : "playing",
      }),
    );

    await render();
    await start();
    const gameId = store.get(gameIdFamily("tab-a"));
    const session = store.get(gameSessionFamily("tab-a"));
    expect(gameId).not.toBeNull();
    expect(session).toBe(1n);
    expect(fixtures.getGameState).toHaveBeenCalledTimes(1);

    // Engine plays e2e4 on backend, but all renderer events are dropped
    gameMoves.push({ uci: "e2e4", clock: 299000 });

    // Periodic query at 1000ms cadence recovers move and clocks
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(treeMoves()).toEqual([expect.objectContaining({ from: 12, to: 28 })]);
    expect(fixtures.boardProps.whiteTime).toBe(299000);
    expect(fixtures.getGameState).toHaveBeenCalledTimes(2);

    // Next query encounters a transient transport failure
    fixtures.getGameState.mockRejectedValueOnce(new Error("transport failure"));
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(fixtures.getGameState).toHaveBeenCalledTimes(3);
    expect(fixtures.notify).toHaveBeenCalledWith("Common.Error", expect.any(Error));

    // Game reaches checkmate on backend; still no events emitted
    gameMoves.push({ uci: "e7e5", clock: 298000 });

    // Backoff retry after 1 failure is 1000ms
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(fixtures.getGameState).toHaveBeenCalledTimes(4);

    // Terminal state applied: final moves present, result set, exact ownership cleared
    expect(treeMoves()).toEqual([
      expect.objectContaining({ from: 12, to: 28 }),
      expect.objectContaining({ from: 52, to: 36 }),
    ]);
    expect(fixtures.tree.headers.result).toBe("1-0");
    expect(store.get(gameStateFamily("tab-a"))).toBe("gameOver");
    expect(store.get(gameIdFamily("tab-a"))).toBeNull();
    expect(store.get(gameSessionFamily("tab-a"))).toBeNull();

    // Polling is stopped once game is over
    fixtures.getGameState.mockClear();
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(fixtures.getGameState).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  test("pending reconciliation query prevents overlapping requests across multiple timer windows", async () => {
    vi.useFakeTimers();
    await render();
    await start();
    expect(fixtures.getGameState).toHaveBeenCalledTimes(1);

    // At 1000ms, the next poll starts and remains pending
    const pending = Promise.withResolvers<any>();
    fixtures.getGameState.mockReturnValueOnce(pending.promise);
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(fixtures.getGameState).toHaveBeenCalledTimes(2);

    // Advance multiple timer windows while the query is in flight
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(fixtures.getGameState).toHaveBeenCalledTimes(2);

    // Resolve pending query
    const gameId = store.get(gameIdFamily("tab-a"));
    await act(async () => pending.resolve(state({ gameId, session: 1n })));

    // Next query is only scheduled 1000ms after settlement
    await act(async () => vi.advanceTimersByTimeAsync(999));
    expect(fixtures.getGameState).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(fixtures.getGameState).toHaveBeenCalledTimes(3);

    vi.useRealTimers();
  });

  test("reconciliation retries with capped exponential backoff and bounded outage notifications, resetting upon recovery", async () => {
    vi.useFakeTimers();
    await render();
    await start();
    const gameId = store.get(gameIdFamily("tab-a"));
    expect(fixtures.getGameState).toHaveBeenCalledTimes(1);
    fixtures.notify.mockClear();

    // 1st periodic poll at +1000ms fails
    fixtures.getGameState.mockRejectedValueOnce(new Error("err 1"));
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(fixtures.getGameState).toHaveBeenCalledTimes(2);
    expect(fixtures.notify).toHaveBeenCalledTimes(1);
    expect(fixtures.notify).toHaveBeenCalledWith("Common.Error", expect.any(Error));

    // Next retry in 1000ms
    await act(async () => vi.advanceTimersByTimeAsync(999));
    expect(fixtures.getGameState).toHaveBeenCalledTimes(2);
    fixtures.getGameState.mockRejectedValueOnce(new Error("err 2"));
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(fixtures.getGameState).toHaveBeenCalledTimes(3);
    expect(fixtures.notify).toHaveBeenCalledTimes(1); // Latched, no duplicate notification

    // Next retry in 2000ms
    await act(async () => vi.advanceTimersByTimeAsync(1999));
    expect(fixtures.getGameState).toHaveBeenCalledTimes(3);
    fixtures.getGameState.mockRejectedValueOnce(new Error("err 3"));
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(fixtures.getGameState).toHaveBeenCalledTimes(4);
    expect(fixtures.notify).toHaveBeenCalledTimes(1);

    // Next retry in 4000ms
    await act(async () => vi.advanceTimersByTimeAsync(3999));
    expect(fixtures.getGameState).toHaveBeenCalledTimes(4);
    fixtures.getGameState.mockRejectedValueOnce(new Error("err 4"));
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(fixtures.getGameState).toHaveBeenCalledTimes(5);
    expect(fixtures.notify).toHaveBeenCalledTimes(1);

    // Next retry in 8000ms (capped)
    await act(async () => vi.advanceTimersByTimeAsync(7999));
    expect(fixtures.getGameState).toHaveBeenCalledTimes(5);
    fixtures.getGameState.mockRejectedValueOnce(new Error("err 5"));
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(fixtures.getGameState).toHaveBeenCalledTimes(6);
    expect(fixtures.notify).toHaveBeenCalledTimes(1);

    // Stays capped at 8000ms
    await act(async () => vi.advanceTimersByTimeAsync(7999));
    expect(fixtures.getGameState).toHaveBeenCalledTimes(6);
    // Success on 6th poll resets backoff and notification latch
    fixtures.getGameState.mockResolvedValueOnce(state({ gameId, session: 1n, revision: 1n }));
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(fixtures.getGameState).toHaveBeenCalledTimes(7);
    expect(fixtures.notify).toHaveBeenCalledTimes(1);

    // After recovery, cadence is reset to 1000ms
    // Next poll at +1000ms encounters a second outage
    fixtures.getGameState.mockRejectedValueOnce(new Error("err 6"));
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(fixtures.getGameState).toHaveBeenCalledTimes(8);
    // Second outage notifies again
    expect(fixtures.notify).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  test("a replacement game starts with fresh reconciliation notification and backoff state", async () => {
    vi.useFakeTimers();
    await render();
    await start();
    const gameA = store.get(gameIdFamily("tab-a"))!;
    fixtures.notify.mockClear();
    fixtures.getGameState.mockClear();

    fixtures.getGameState.mockRejectedValueOnce(new Error("game A outage"));
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(fixtures.notify).toHaveBeenCalledTimes(1);

    await act(async () =>
      fixtures.listeners.get("gameOver")?.({
        payload: {
          gameId: gameA,
          session: 1n,
          revision: 1n,
          result: { type: "draw", reason: "stalemate" },
          moves: [],
        },
      }),
    );
    await act(async () => button("Home.NewGame").click());

    fixtures.getGameState.mockClear();
    fixtures.getGameState.mockRejectedValueOnce(new Error("game B outage"));
    await start();
    const gameB = store.get(gameIdFamily("tab-a"))!;
    expect(gameB).not.toBe(gameA);
    expect(fixtures.getGameState).toHaveBeenCalledTimes(1);
    expect(fixtures.getGameState).toHaveBeenCalledWith(gameB, 1n);
    expect(fixtures.notify).toHaveBeenCalledTimes(2);

    await act(async () => vi.advanceTimersByTimeAsync(999));
    expect(fixtures.getGameState).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(fixtures.getGameState).toHaveBeenCalledTimes(2);
  });

  const latePriorOwnerSettlements = [
    {
      name: "resolved",
      settle: async (pending: ReturnType<typeof Promise.withResolvers<any>>, gameId: string) =>
        pending.resolve(
          state({
            gameId,
            session: 1n,
            revision: 2n,
            moves: [{ uci: "a2a3", clock: null }],
          }),
        ),
    },
    {
      name: "rejected",
      settle: async (pending: ReturnType<typeof Promise.withResolvers<any>>) =>
        pending.reject(new Error("late game A outage")),
    },
  ];

  test.each(latePriorOwnerSettlements)(
    "a late $name game A query wakes game B without overlap or stale application",
    async ({ settle }) => {
      vi.useFakeTimers();
      await render();
      await start();
      const gameA = store.get(gameIdFamily("tab-a"))!;
      fixtures.getGameState.mockClear();
      fixtures.notify.mockClear();
      const pending = Promise.withResolvers<any>();
      fixtures.getGameState.mockImplementationOnce(() => pending.promise);
      await act(async () => vi.advanceTimersByTimeAsync(1000));
      expect(fixtures.getGameState).toHaveBeenCalledTimes(1);

      await act(async () =>
        fixtures.listeners.get("gameOver")?.({
          payload: {
            gameId: gameA,
            session: 1n,
            revision: 1n,
            result: { type: "draw", reason: "stalemate" },
            moves: [],
          },
        }),
      );
      await act(async () => button("Home.NewGame").click());
      await start();
      const gameB = store.get(gameIdFamily("tab-a"))!;
      expect(gameB).not.toBe(gameA);
      expect(fixtures.getGameState).toHaveBeenCalledTimes(1);

      await act(async () => settle(pending, gameA));
      expect(treeMoves()).toEqual([]);
      expect(fixtures.notify).not.toHaveBeenCalled();
      await act(async () => vi.advanceTimersByTimeAsync(999));
      expect(fixtures.getGameState).toHaveBeenCalledTimes(1);
      await act(async () => vi.advanceTimersByTimeAsync(1));
      expect(fixtures.getGameState).toHaveBeenCalledTimes(2);
      expect(fixtures.getGameState).toHaveBeenLastCalledWith(gameB, 1n);
      expect(treeMoves()).toEqual([]);
      expect(fixtures.notify).not.toHaveBeenCalled();
    },
  );

  type RetirementContext = { gameId: string; session: bigint };
  type RetirementCase = {
    name: string;
    retire: (context: RetirementContext) => Promise<unknown>;
    expectedOutcome: unknown;
  };

  const retirementCases: RetirementCase[] = [
    {
      name: "unmount",
      retire: async () => {
        await act(async () => root.unmount());
        root = createRoot(host);
      },
      expectedOutcome: undefined,
    },
    {
      name: "close intent",
      retire: async () => {
        await act(async () => store.set(closingTabsAtom, new Set(["tab-a"])));
      },
      expectedOutcome: undefined,
    },
    {
      name: "reset",
      retire: async ({ gameId, session }) => {
        fixtures.resignGame.mockResolvedValueOnce(
          state({
            gameId,
            session,
            revision: 1n,
            status: { finished: { result: { type: "blackWins", reason: "resignation" } } },
          }),
        );
        await act(async () => button("Board.Opponent.Resign").click());
        const afterResign = store.get(gameStateFamily("tab-a"));
        await act(async () => button("Home.NewGame").click());
        return [afterResign, store.get(gameStateFamily("tab-a"))];
      },
      expectedOutcome: ["gameOver", "settingUp"],
    },
    {
      name: "replacement",
      retire: async () => {
        await act(async () => root.unmount());
        root = createRoot(host);
        await render("tab-b");
        await start("tab-b");
        const gameB = store.get(gameIdFamily("tab-b"));
        return {
          gameExists: gameB !== null,
          queried: fixtures.getGameState.mock.calls.some(
            ([gameId, session]) => gameId === gameB && session === 1n,
          ),
        };
      },
      expectedOutcome: { gameExists: true, queried: true },
    },
    {
      name: "GameOver receipt",
      retire: async ({ gameId, session }) => {
        await act(async () =>
          fixtures.listeners.get("gameOver")?.({
            payload: {
              gameId,
              session,
              revision: 1n,
              result: { type: "draw", reason: "stalemate" },
              moves: [],
            },
          }),
        );
        return store.get(gameStateFamily("tab-a"));
      },
      expectedOutcome: "gameOver",
    },
  ];

  describe.each(retirementCases)(
    "$name reconciliation retirement",
    ({ retire, expectedOutcome }) => {
      test("stops periodic polling normally", async () => {
        vi.useFakeTimers();
        await render();
        await start();
        const context = {
          gameId: store.get(gameIdFamily("tab-a"))!,
          session: store.get(gameSessionFamily("tab-a"))!,
        };
        fixtures.getGameState.mockClear();

        const outcome = await retire(context);
        await act(async () => vi.advanceTimersByTimeAsync(5000));

        expect(outcome).toEqual(expectedOutcome);
        expect(fixtures.getGameState).not.toHaveBeenCalledWith(context.gameId, context.session);
      });

      test("silences a late resolved periodic query", async () => {
        vi.useFakeTimers();
        await render();
        await start();
        const context = {
          gameId: store.get(gameIdFamily("tab-a"))!,
          session: store.get(gameSessionFamily("tab-a"))!,
        };
        fixtures.getGameState.mockClear();
        const pending = Promise.withResolvers<any>();
        fixtures.getGameState.mockImplementationOnce(() => pending.promise);
        await act(async () => vi.advanceTimersByTimeAsync(1000));
        expect(fixtures.getGameState).toHaveBeenCalledTimes(1);

        const outcome = await retire(context);
        await act(async () => {
          pending.resolve(
            state({
              ...context,
              revision: 2n,
              moves: [{ uci: "e2e4", clock: null }],
            }),
          );
        });
        await act(async () => vi.advanceTimersByTimeAsync(5000));

        expect(outcome).toEqual(expectedOutcome);
        expect(treeMoves()).toEqual([]);
        expect(fixtures.notify).not.toHaveBeenCalled();
        expect(
          fixtures.getGameState.mock.calls.filter(
            ([gameId, session]) => gameId === context.gameId && session === context.session,
          ),
        ).toHaveLength(1);
      });

      test("silences a late rejected periodic query", async () => {
        vi.useFakeTimers();
        await render();
        await start();
        const context = {
          gameId: store.get(gameIdFamily("tab-a"))!,
          session: store.get(gameSessionFamily("tab-a"))!,
        };
        fixtures.getGameState.mockClear();
        const pending = Promise.withResolvers<any>();
        fixtures.getGameState.mockImplementationOnce(() => pending.promise);
        await act(async () => vi.advanceTimersByTimeAsync(1000));
        expect(fixtures.getGameState).toHaveBeenCalledTimes(1);

        const outcome = await retire(context);
        await act(async () => pending.reject(new Error("late retired query")));
        await act(async () => vi.advanceTimersByTimeAsync(5000));

        expect(outcome).toEqual(expectedOutcome);
        expect(treeMoves()).toEqual([]);
        expect(fixtures.notify).not.toHaveBeenCalled();
        expect(
          fixtures.getGameState.mock.calls.filter(
            ([gameId, session]) => gameId === context.gameId && session === context.session,
          ),
        ).toHaveLength(1);
      });
    },
  );

  test("a native move receipt does not stop reconciliation", async () => {
    vi.useFakeTimers();
    await render();
    await start();
    const liveGame = store.get(gameIdFamily("tab-a"));
    const liveSession = store.get(gameSessionFamily("tab-a"))!;
    fixtures.getGameState.mockClear();
    act(() =>
      fixtures.listeners.get("gameMove")?.({
        payload: {
          gameId: liveGame,
          session: liveSession,
          revision: 1n,
          moves: [{ uci: "e2e4", clock: null }],
          whiteTime: 300n,
          blackTime: 300n,
        },
      }),
    );
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(fixtures.getGameState).toHaveBeenCalledWith(liveGame, liveSession);

    vi.useRealTimers();
  });

  test("failed close resumption recovers dropped move and terminal snapshot when timer fires during close", async () => {
    vi.useFakeTimers();
    await render();
    await start();
    const gameId = store.get(gameIdFamily("tab-a"))!;
    expect(fixtures.getGameState).toHaveBeenCalledTimes(1);
    fixtures.getGameState.mockClear();

    // Enter close intent
    store.set(closingTabsAtom, new Set(["tab-a"]));

    // Timer fires during close window - reconciliation should NOT poll while closing
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(fixtures.getGameState).not.toHaveBeenCalled();

    // Backend drops a move and finishes while close was attempted
    const terminalState = state({
      gameId,
      session: 1n,
      revision: 2n,
      status: { finished: { result: { type: "whiteWins", reason: "checkmate" } } },
      moves: [{ uci: "e2e4", clock: null }],
    });
    fixtures.getGameState.mockResolvedValueOnce(terminalState);

    // Failed close: clear marker while preserving identity
    await act(async () => {
      store.set(closingTabsAtom, new Set());
    });

    // Reconciliation resumes and recovers dropped move + terminal snapshot without events
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(fixtures.getGameState).toHaveBeenCalledWith(gameId, 1n);
    expect(treeMoves()).toEqual([expect.objectContaining({ from: 12, to: 28 })]);
    expect(store.get(gameStateFamily("tab-a"))).toBe("gameOver");
    expect(fixtures.notify).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  test("failed close resumption recovers dropped move and terminal snapshot when query settles during close", async () => {
    vi.useFakeTimers();
    await render();
    await start();
    const gameId = store.get(gameIdFamily("tab-a"))!;
    expect(fixtures.getGameState).toHaveBeenCalledTimes(1);
    fixtures.getGameState.mockClear();

    const pendingQuery = Promise.withResolvers<any>();
    fixtures.getGameState.mockImplementationOnce(() => pendingQuery.promise);

    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(fixtures.getGameState).toHaveBeenCalledTimes(1);

    // Enter close intent while query is pending
    store.set(closingTabsAtom, new Set(["tab-a"]));

    // Query settles during close with stale move
    await act(async () => {
      pendingQuery.resolve(
        state({
          gameId,
          session: 1n,
          revision: 2n,
          moves: [{ uci: "d2d4", clock: null }],
        }),
      );
    });

    // Settled during close: must not apply or notify
    expect(treeMoves()).toEqual([]);
    expect(fixtures.notify).not.toHaveBeenCalled();

    // Backend dropped a move and finished
    const terminalState = state({
      gameId,
      session: 1n,
      revision: 3n,
      status: { finished: { result: { type: "blackWins", reason: "resignation" } } },
      moves: [{ uci: "e2e4", clock: null }],
    });
    fixtures.getGameState.mockResolvedValueOnce(terminalState);

    // Failed close: clear marker while preserving identity
    await act(async () => {
      store.set(closingTabsAtom, new Set());
    });

    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(fixtures.getGameState).toHaveBeenCalledTimes(2);
    expect(treeMoves()).toEqual([expect.objectContaining({ from: 12, to: 28 })]);
    expect(store.get(gameStateFamily("tab-a"))).toBe("gameOver");
    expect(fixtures.notify).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  test("releasing close while query is pending prevents overlapping requests and discards stale pending result", async () => {
    vi.useFakeTimers();
    await render();
    await start();
    const gameId = store.get(gameIdFamily("tab-a"))!;
    expect(fixtures.getGameState).toHaveBeenCalledTimes(1);
    fixtures.getGameState.mockClear();

    const pendingQuery = Promise.withResolvers<any>();
    fixtures.getGameState.mockImplementationOnce(() => pendingQuery.promise);
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(fixtures.getGameState).toHaveBeenCalledTimes(1);

    // Enter close intent while query is pending
    await act(async () => {
      store.set(closingTabsAtom, new Set(["tab-a"]));
    });

    // Release close intent while query is STILL pending
    await act(async () => {
      store.set(closingTabsAtom, new Set());
    });

    // No overlapping request issued
    expect(fixtures.getGameState).toHaveBeenCalledTimes(1);

    // Stale pending result resolves
    await act(async () => {
      pendingQuery.resolve(
        state({
          gameId,
          session: 1n,
          revision: 2n,
          moves: [{ uci: "a2a3", clock: null }],
        }),
      );
    });

    // Stale result discarded; must not mutate tree
    expect(treeMoves()).toEqual([]);

    // Next periodic poll fetches fresh authoritative state
    fixtures.getGameState.mockResolvedValueOnce(
      state({
        gameId,
        session: 1n,
        revision: 3n,
        moves: [{ uci: "e2e4", clock: null }],
      }),
    );
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(fixtures.getGameState).toHaveBeenCalledTimes(2);
    expect(treeMoves()).toEqual([expect.objectContaining({ from: 12, to: 28 })]);

    vi.useRealTimers();
  });

  test("reconciliation under StrictMode replay maintains single active polling loop", async () => {
    vi.useFakeTimers();
    const strictGameId = "tab-a-strict-game";
    const strictSession = 1n;
    store.set(gameIdFamily("tab-a"), strictGameId);
    store.set(gameSessionFamily("tab-a"), strictSession);
    store.set(gameStateFamily("tab-a"), "playing");
    const replayedQuery = Promise.withResolvers<any>();
    fixtures.getGameState.mockImplementationOnce(() => replayedQuery.promise);

    await act(async () =>
      root.render(
        <StrictMode>
          <TreeStateContext.Provider value={fixtures.treeStore}>
            <BoardGame tabId="tab-a" />
          </TreeStateContext.Provider>
        </StrictMode>,
      ),
    );
    expect(fixtures.getGameState).toHaveBeenCalledTimes(1);
    expect(fixtures.getGameState).toHaveBeenCalledWith(strictGameId, strictSession);

    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(fixtures.getGameState).toHaveBeenCalledTimes(1);

    await act(async () => {
      replayedQuery.resolve(state({ gameId: strictGameId, session: strictSession }));
    });
    await act(async () => vi.advanceTimersByTimeAsync(999));
    expect(fixtures.getGameState).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(fixtures.getGameState).toHaveBeenCalledTimes(2);
    expect(fixtures.getGameState).toHaveBeenLastCalledWith(strictGameId, strictSession);

    vi.useRealTimers();
  });

  test("syncTreeWithMoves preserves metadata and side variations on retained prefix across takeback and rewrite", async () => {
    vi.useFakeTimers();
    const { createTreeStore } =
      await vi.importActual<typeof import("@/state/store/tree")>("@/state/store/tree");
    const realStore = createTreeStore();
    fixtures.treeStore = realStore;

    // 1. e2e4 {book} (!)
    realStore.getState().makeMove({ payload: parseUci("e2e4")!, mainline: true });
    realStore.getState().setComment("book");
    realStore.getState().setAnnotation("!");
    realStore.getState().setShapes([{ brush: "green", orig: "e4", dest: "e5" }]);

    // 1... e7e5 (mainline)
    realStore.getState().makeMove({ payload: parseUci("e7e5")!, mainline: true });
    realStore.getState().setComment("mainline reply");
    realStore.getState().setScore({ value: { type: "cp", value: 24 }, wdl: null });

    // 1... c7c5 (variation on e4)
    realStore.getState().goToMove([0]);
    realStore.getState().makeMove({ payload: parseUci("c7c5")!, mainline: false });

    // Continue mainline: 2. Nf3 Nc6
    realStore.getState().goToMove([0, 0]);
    realStore.getState().makeMove({ payload: parseUci("g1f3")!, mainline: true });
    realStore.getState().makeMove({ payload: parseUci("b8c6")!, mainline: true });
    realStore.getState().goToMove([0, 0]);
    realStore.getState().makeMove({ payload: parseUci("d2d4")!, mainline: false });
    realStore.getState().setHeaders({
      ...realStore.getState().headers,
      event: "Annotated game",
      other: { Source: "fixture" },
    });

    // Verify initial tree state
    expect(realStore.getState().root.children[0].comment).toBe("book");
    expect(realStore.getState().root.children[0].nags).toEqual([1]);
    expect(realStore.getState().root.children[0].shapes).toEqual([
      { brush: "green", orig: "e4", dest: "e5" },
    ]);
    expect(realStore.getState().root.children[0].children.length).toBe(2);
    expect(realStore.getState().root.children[0].children[0].san).toBe("e5");
    expect(realStore.getState().root.children[0].children[1].san).toBe("c5");

    const gameId = "real-store-game";
    store.set(gameIdFamily("tab-a"), gameId);
    store.set(gameSessionFamily("tab-a"), 1n);
    store.set(gameStateFamily("tab-a"), "playing");
    fixtures.getGameState.mockResolvedValueOnce(
      state({
        gameId,
        session: 1n,
        revision: 1n,
        moves: [
          { uci: "e2e4", clock: null },
          { uci: "e7e5", clock: null },
          { uci: "g1f3", clock: null },
          { uci: "b8c6", clock: null },
        ],
      }),
    );

    await render();
    expect(fixtures.getGameState).toHaveBeenCalledTimes(1);

    // A. Takeback to e4 e5
    fixtures.getGameState.mockResolvedValueOnce(
      state({
        gameId,
        session: 1n,
        revision: 2n,
        moves: [
          { uci: "e2e4", clock: null },
          { uci: "e7e5", clock: null },
        ],
      }),
    );
    await act(async () => vi.advanceTimersByTimeAsync(1000));

    // Retained prefix e4 e5 has retained metadata and variation on e4
    const stateAfterTakeback = realStore.getState();
    const e4AfterTakeback = stateAfterTakeback.root.children[0];
    expect(e4AfterTakeback.comment).toBe("book");
    expect(e4AfterTakeback.nags).toEqual([1]);
    expect(e4AfterTakeback.shapes).toEqual([{ brush: "green", orig: "e4", dest: "e5" }]);
    expect(e4AfterTakeback.children.length).toBe(2);
    expect(e4AfterTakeback.children[0].san).toBe("e5");
    expect(e4AfterTakeback.children[0].comment).toBe("mainline reply");
    expect(e4AfterTakeback.children[0].score).toEqual({
      value: { type: "cp", value: 24 },
      wdl: null,
    });
    expect(e4AfterTakeback.children[1].san).toBe("c5");
    expect(mainlineUcis(stateAfterTakeback.root)).toEqual(["e2e4", "e7e5"]);
    // Nf3 Nc6 beyond e5 have been deleted
    expect(e4AfterTakeback.children[0].children).toHaveLength(0);
    expect(stateAfterTakeback.headers).toEqual(
      expect.objectContaining({ event: "Annotated game", other: { Source: "fixture" } }),
    );

    // Recreate the old continuation so the next snapshot is a rewrite, not a strict extension.
    realStore.getState().goToMove([0, 0]);
    realStore.getState().makeMove({ payload: parseUci("g1f3")!, mainline: true });
    realStore.getState().makeMove({ payload: parseUci("b8c6")!, mainline: true });
    realStore.getState().goToMove([0, 0]);
    realStore.getState().makeMove({ payload: parseUci("d2d4")!, mainline: false });
    realStore.getState().makeMove({ payload: parseUci("d7d5")!, mainline: true });

    // B. Rewritten non-prefix continuation: e4 e5 Nf3 Nc6 -> e4 e5 d4
    fixtures.getGameState.mockResolvedValueOnce(
      state({
        gameId,
        session: 1n,
        revision: 3n,
        moves: [
          { uci: "e2e4", clock: null },
          { uci: "e7e5", clock: null },
          { uci: "d2d4", clock: null },
        ],
      }),
    );
    await act(async () => vi.advanceTimersByTimeAsync(1000));

    const stateAfterRewrite = realStore.getState();
    const e4AfterRewrite = stateAfterRewrite.root.children[0];
    expect(e4AfterRewrite.comment).toBe("book");
    expect(e4AfterRewrite.nags).toEqual([1]);
    expect(e4AfterRewrite.shapes).toEqual([{ brush: "green", orig: "e4", dest: "e5" }]);
    expect(e4AfterRewrite.children.length).toBe(2);
    expect(e4AfterRewrite.children[0].san).toBe("e5");
    expect(e4AfterRewrite.children[0].comment).toBe("mainline reply");
    expect(e4AfterRewrite.children[0].score).toEqual({
      value: { type: "cp", value: 24 },
      wdl: null,
    });
    expect(e4AfterRewrite.children[1].san).toBe("c5");
    expect(e4AfterRewrite.children[0].children).toHaveLength(2);
    expect(e4AfterRewrite.children[0].children[0].san).toBe("d4");
    expect(e4AfterRewrite.children[0].children[0].children).toHaveLength(0);
    expect(e4AfterRewrite.children[0].children[1].san).toBe("Nf3");

    // Exact backend mainline: e4 e5 d4
    expect(mainlineUcis(stateAfterRewrite.root)).toEqual(["e2e4", "e7e5", "d2d4"]);
    expect(stateAfterRewrite.headers).toEqual(
      expect.objectContaining({ event: "Annotated game", other: { Source: "fixture" } }),
    );

    vi.useRealTimers();
  });

  test("stale-session and stale-revision snapshots cannot mutate current game state", async () => {
    vi.useFakeTimers();
    await render();
    await start();
    const gameId = store.get(gameIdFamily("tab-a"));
    expect(gameId).not.toBeNull();

    // Wrong session (0n instead of 1n)
    fixtures.getGameState.mockResolvedValueOnce(
      state({
        gameId,
        session: 0n,
        revision: 5n,
        moves: [{ uci: "e2e4", clock: null }],
      }),
    );
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(treeMoves()).toEqual([]);

    // Wrong gameId
    fixtures.getGameState.mockResolvedValueOnce(
      state({
        gameId: "other-game",
        session: 1n,
        revision: 5n,
        moves: [{ uci: "e2e4", clock: null }],
      }),
    );
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(treeMoves()).toEqual([]);

    // Advance live revision to 5n
    act(() =>
      fixtures.listeners.get("gameMove")?.({
        payload: {
          gameId,
          session: 1n,
          revision: 5n,
          moves: [{ uci: "d2d4", clock: null }],
          whiteTime: null,
          blackTime: null,
        },
      }),
    );
    await act(async () => vi.advanceTimersByTimeAsync(200));
    expect(treeMoves()).toEqual([expect.objectContaining({ from: 11, to: 27 })]);

    // Snapshot with older revision (3n < 5n)
    fixtures.getGameState.mockResolvedValueOnce(
      state({
        gameId,
        session: 1n,
        revision: 3n,
        moves: [{ uci: "e2e4", clock: null }],
      }),
    );
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    // Live tree remains d2d4
    expect(treeMoves()).toEqual([expect.objectContaining({ from: 11, to: 27 })]);

    vi.useRealTimers();
  });

  test("newer clock with older move snapshot restores missing move without clock regression", async () => {
    vi.useFakeTimers();
    await render();
    await start();
    const gameId = store.get(gameIdFamily("tab-a"));

    // Clock update arrives at revision 5n with whiteTime 290000
    act(() =>
      fixtures.listeners.get("clockUpdate")?.({
        payload: {
          gameId,
          session: 1n,
          revision: 5n,
          whiteTime: 290000n,
          blackTime: 300000n,
        },
      }),
    );
    expect(fixtures.boardProps.whiteTime).toBe(290000);

    // Authoritative snapshot arrives at revision 4n (older than clock 5n, newer than move 0n)
    fixtures.getGameState.mockResolvedValueOnce(
      state({
        gameId,
        session: 1n,
        revision: 4n,
        moves: [{ uci: "e2e4", clock: 295000 }],
        whiteTime: 295000n,
        blackTime: 300000n,
      }),
    );
    await act(async () => vi.advanceTimersByTimeAsync(1000));

    // The missing move is restored
    expect(treeMoves()).toEqual([expect.objectContaining({ from: 12, to: 28 })]);
    // The clock does not regress to 295000
    expect(fixtures.boardProps.whiteTime).toBe(290000);

    vi.useRealTimers();
  });

  test("queued old moves cannot overwrite newer polled authoritative state", async () => {
    vi.useFakeTimers();
    await render();
    await start();
    const gameId = store.get(gameIdFamily("tab-a"));

    // Polled state arrives at revision 10n with two moves
    fixtures.getGameState.mockResolvedValueOnce(
      state({
        gameId,
        session: 1n,
        revision: 10n,
        moves: [
          { uci: "e2e4", clock: null },
          { uci: "e7e5", clock: null },
        ],
        whiteTime: 295000n,
        blackTime: 295000n,
      }),
    );
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(treeMoves()).toHaveLength(2);

    // Delayed gameMove event from revision 8n arrives with only 1 move
    act(() =>
      fixtures.listeners.get("gameMove")?.({
        payload: {
          gameId,
          session: 1n,
          revision: 8n,
          moves: [{ uci: "e2e4", clock: null }],
          whiteTime: 298000n,
          blackTime: 300000n,
        },
      }),
    );
    await act(async () => vi.advanceTimersByTimeAsync(200));

    // Polled state is preserved
    expect(treeMoves()).toHaveLength(2);
    expect(fixtures.boardProps.whiteTime).toBe(295000);

    vi.useRealTimers();
  });

  test("missing or expired authoritative query is surfaced and does not fabricate result or adopt another session", async () => {
    vi.useFakeTimers();
    await render();
    await start();
    const gameId = store.get(gameIdFamily("tab-a"));
    expect(gameId).not.toBeNull();
    fixtures.notify.mockClear();

    fixtures.getGameState.mockRejectedValueOnce(new Error("Game session expired"));
    await act(async () => vi.advanceTimersByTimeAsync(1000));

    expect(fixtures.notify).toHaveBeenCalledWith(
      "Common.Error",
      expect.objectContaining({ message: "Game session expired" }),
    );
    expect(store.get(gameStateFamily("tab-a"))).toBe("playing");
    expect(store.get(gameIdFamily("tab-a"))).toBe(gameId);
    expect(store.get(gameSessionFamily("tab-a"))).toBe(1n);

    vi.useRealTimers();
  });

  test("recovered engine move executes queued premove once, while clock-only or terminal snapshots do not, and stale callbacks are cancelled", async () => {
    vi.useFakeTimers();
    store.set(gamePlayer1SettingsAtom, { type: "human", name: "Alice" });
    store.set(gamePlayer2SettingsAtom, {
      type: "engine",
      engine: engine("engine-black"),
      go: { t: "Infinite" },
    });

    await render();
    await start();
    const gameId = store.get(gameIdFamily("tab-a"));

    // White human queues a premove
    expect(fixtures.boardProps.onKeyboardPremove("g1", "f3")).toBe(true);

    // 1. Clock-only snapshot (moves unchanged): does not trigger premove
    fixtures.getGameState.mockResolvedValueOnce(
      state({
        gameId,
        session: 1n,
        revision: 1n,
        moves: [],
        whiteTime: 299000n,
        blackTime: 300000n,
        turn: "white",
      }),
    );
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    await act(async () => vi.advanceTimersByTimeAsync(50));
    expect(fixtures.playPremove).not.toHaveBeenCalled();

    // 2. Recovered engine move (e7e5): next turn is human -> executes premove
    fixtures.getGameState.mockResolvedValueOnce(
      state({
        gameId,
        session: 1n,
        revision: 2n,
        moves: [{ uci: "e7e5", clock: null }],
        turn: "white",
      }),
    );
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    await act(async () => vi.advanceTimersByTimeAsync(10));
    expect(fixtures.playPremove).toHaveBeenCalledTimes(1);

    // 3. Stale deferred callbacks are cancelled upon terminal snapshot
    fixtures.playPremove.mockClear();
    expect(fixtures.boardProps.onKeyboardPremove("d2", "d4")).toBe(true);

    const pendingPoll = Promise.withResolvers<any>();
    fixtures.getGameState.mockReturnValueOnce(pendingPoll.promise);

    // Advance 1000ms to trigger the poll query
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(fixtures.getGameState).toHaveBeenCalledTimes(4);

    // Resolve poll with an engine move to schedule deferred premove callback
    await act(async () => {
      pendingPoll.resolve(
        state({
          gameId,
          session: 1n,
          revision: 3n,
          moves: [
            { uci: "e7e5", clock: null },
            { uci: "f7f5", clock: null },
          ],
          turn: "white",
        }),
      );
    });

    // BEFORE timer 0ms fires, gameOver event arrives to end game
    await act(async () =>
      fixtures.listeners.get("gameOver")?.({
        payload: {
          gameId,
          session: 1n,
          revision: 4n,
          result: { type: "draw", reason: "stalemate" },
          moves: [
            { uci: "e7e5", clock: null },
            { uci: "f7f5", clock: null },
          ],
        },
      }),
    );

    // Advance time past deferred timer
    await act(async () => vi.advanceTimersByTimeAsync(50));
    // Premove was cancelled by terminal transition!
    expect(fixtures.playPremove).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  test("premove execution with Black-to-move initial FEN respects authoritative state turn over stale renderer position turn", async () => {
    vi.useFakeTimers();
    const blackToMoveFen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1";
    store.set(gamePlayer1SettingsAtom, { type: "human", name: "Alice" });
    store.set(gamePlayer2SettingsAtom, {
      type: "engine",
      engine: engine("engine-black"),
      go: { t: "Infinite" },
    });

    // Deliberately stale renderer position turn: "black"
    // If the component used pos.turn instead of state.turn, it would see "black"
    // (the engine), and would refuse to execute White human's premove.
    fixtures.positionTurn = "black";

    fixtures.startGame.mockImplementationOnce(async (gameId) =>
      state({
        gameId,
        initialFen: blackToMoveFen,
        currentFen: blackToMoveFen,
        turn: "black",
      }),
    );

    await render();
    await start();
    const gameId = store.get(gameIdFamily("tab-a"));

    // White human queues a premove
    expect(fixtures.boardProps.onKeyboardPremove("e2", "e4")).toBe(true);

    // Engine plays e7e5; snapshot turn is "white" (human's turn next)
    fixtures.getGameState.mockResolvedValueOnce(
      state({
        gameId,
        session: 1n,
        revision: 1n,
        initialFen: blackToMoveFen,
        currentFen: "rnbqkbnr/pppp1ppp/8/4p3/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
        moves: [{ uci: "e7e5", clock: null }],
        turn: "white",
      }),
    );

    await act(async () => vi.advanceTimersByTimeAsync(1000));
    await act(async () => vi.advanceTimersByTimeAsync(10));

    // Premove executed because authoritative state.turn === "white", not pos.turn === "black"!
    expect(fixtures.playPremove).toHaveBeenCalledOnce();

    vi.useRealTimers();
  });

  test("recovered takeback to empty moves and rewritten non-prefix line do not execute premove", async () => {
    vi.useFakeTimers();
    store.set(gamePlayer1SettingsAtom, { type: "human", name: "Alice" });
    store.set(gamePlayer2SettingsAtom, {
      type: "engine",
      engine: engine("engine-black"),
      go: { t: "Infinite" },
    });

    await render();
    await start();
    const gameId = store.get(gameIdFamily("tab-a"));

    // Live tree has e2e4 and e7e5
    act(() =>
      fixtures.listeners.get("gameMove")?.({
        payload: {
          gameId,
          session: 1n,
          revision: 2n,
          moves: [
            { uci: "e2e4", clock: null },
            { uci: "e7e5", clock: null },
          ],
          whiteTime: 300n,
          blackTime: 300n,
        },
      }),
    );
    await act(async () => vi.advanceTimersByTimeAsync(200));
    expect(treeMoves()).toHaveLength(2);

    fixtures.playPremove.mockClear();

    // Human queues a premove
    expect(fixtures.boardProps.onKeyboardPremove("g1", "f3")).toBe(true);

    // Case 1: Recovered takeback from [e2e4, e7e5] to [] with turn: "white" (human)
    fixtures.getGameState.mockResolvedValueOnce(
      state({
        gameId,
        session: 1n,
        revision: 3n,
        moves: [],
        turn: "white",
      }),
    );
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    await act(async () => vi.advanceTimersByTimeAsync(50));
    expect(fixtures.playPremove).not.toHaveBeenCalled();
    expect(treeMoves()).toHaveLength(0);

    // Populate live tree with d2d4
    act(() =>
      fixtures.listeners.get("gameMove")?.({
        payload: {
          gameId,
          session: 1n,
          revision: 4n,
          moves: [{ uci: "d2d4", clock: null }],
          whiteTime: 300n,
          blackTime: 300n,
        },
      }),
    );
    await act(async () => vi.advanceTimersByTimeAsync(200));
    expect(treeMoves()).toHaveLength(1);

    fixtures.playPremove.mockClear();

    // Case 2: Rewritten non-prefix line [c2c4, c7c5] with turn: "white" (human)
    fixtures.getGameState.mockResolvedValueOnce(
      state({
        gameId,
        session: 1n,
        revision: 5n,
        moves: [
          { uci: "c2c4", clock: null },
          { uci: "c7c5", clock: null },
        ],
        turn: "white",
      }),
    );
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    await act(async () => vi.advanceTimersByTimeAsync(50));

    // Premove was not executed because [c2c4, c7c5] does not extend [d2d4] as prefix
    expect(fixtures.playPremove).not.toHaveBeenCalled();
    // But the authoritative state was still applied to the tree
    expect(treeMoves()).toHaveLength(2);

    vi.useRealTimers();
  });
});
