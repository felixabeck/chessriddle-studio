import { WorkspaceTabScope } from "@/state/tabScope";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { getDefaultStore, useAtomValue } from "jotai";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { BestMovesPayload } from "@/bindings";
import { INITIAL_FEN } from "chessops/fen";

const fixtures = vi.hoisted(() => ({
  engine: {
    type: "local" as const,
    id: "engine-1",
    name: "Stockfish",
    version: "17",
    filename: "stockfish",
    handle: { id: { id: "handle-1" }, kind: "engine" as const },
    loaded: true,
  },
  chessdbEngine: {
    type: "chessdb" as const,
    id: "chessdb-1",
    name: "ChessDB",
    url: "https://chessdb.cn",
    loaded: true,
  },
  fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
  moves: [] as string[],
  chessdbGetBestMoves: vi.fn(),
  lichessGetBestMoves: vi.fn(),
  getBestMoves: vi.fn(),
  prepareEngineSearch: vi.fn(),
  listeners: [] as Array<(event: any) => void>,
  notifyUnlessCancelled: vi.fn(),
  setEngineScore: vi.fn(),
  stopEngine: vi.fn(),
  releaseEngineSearch: vi.fn(),
  nodeScore: undefined as unknown,
  // The tree store's position when it has moved on since the listener last rendered.
  storeFen: null as string | null,
  t: (key: string) => key,
}));

const positionB = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
const positionC = "rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq - 0 1";
const positionD = "rnbqkbnr/pppppppp/8/8/8/5N2/PPPPPPPP/RNBQKB1R b KQkq - 1 1";

const engine = fixtures.engine;
const chessdbEngine = fixtures.chessdbEngine;

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: fixtures.t }) }));
vi.mock("@/components/files/notifyError", () => ({
  notifyListenerError: vi.fn(),
  notifyUnlessCancelled: fixtures.notifyUnlessCancelled,
}));
vi.mock("@/utils/engines", () => ({
  getBestMoves: fixtures.getBestMoves,
  prepareEngineSearch: fixtures.prepareEngineSearch,
  stopEngine: fixtures.stopEngine,
  releaseEngineSearch: fixtures.releaseEngineSearch,
}));
vi.mock("@/utils/chess", () => ({ getVariationLine: () => fixtures.moves }));
vi.mock("@/utils/chessdb/api", () => ({ getBestMoves: fixtures.chessdbGetBestMoves }));
vi.mock("@/utils/lichess/api", () => ({ getBestMoves: fixtures.lichessGetBestMoves }));
vi.mock("@/platform/tauri", () => ({
  tauriSubscriptions: {
    bestMoves: vi.fn(async (listener: (event: any) => void) => {
      fixtures.listeners.push(listener);
      return () => {
        const index = fixtures.listeners.indexOf(listener);
        if (index >= 0) fixtures.listeners.splice(index, 1);
      };
    }),
  },
}));
vi.mock("@/state/atoms", async () => {
  const { atom } = await vi.importActual<typeof import("jotai")>("jotai");
  const { atomFamily } = await vi.importActual<typeof import("jotai/utils")>("jotai/utils");
  return {
    activeTabAtom: atom<string | null>("tab-1"),
    closingTabsAtom: atom<Set<string>>(new Set<string>()),
    threatFamily: atomFamily((_tab: string) => atom(false)),
    enginesAtom: atom<any[]>([fixtures.engine]),
    engineMovesFamily: atomFamily(
      ({ tab: _tab, engine: _engine }: { tab: string; engine: string }) =>
        atom<Map<string, any[]>>(new Map()),
      (a, b) => a.tab === b.tab && a.engine === b.engine,
    ),
    engineProgressFamily: atomFamily(
      ({ tab: _tab, engine: _engine }: { tab: string; engine: string }) => atom(0),
      (a, b) => a.tab === b.tab && a.engine === b.engine,
    ),
    engineRetryFamily: atomFamily(
      ({ tab: _tab, engine: _engine }: { tab: string; engine: string }) => atom(0),
      (a, b) => a.tab === b.tab && a.engine === b.engine,
    ),
    // Retain the BASE seam so red-on-revert fails on behaviour, not a missing mock export.
    engineNoLinesFamily: atomFamily(
      ({ tab: _tab, engine: _engine }: { tab: string; engine: string }) =>
        atom<string | null>(null),
      (a, b) => a.tab === b.tab && a.engine === b.engine,
    ),
    engineTerminalFamily: atomFamily(
      ({ tab: _tab, engine: _engine }: { tab: string; engine: string }) => atom<any>(null),
      (a, b) => a.tab === b.tab && a.engine === b.engine,
    ),
    tabEngineSettingsFamily: atomFamily(
      ({ defaultSettings, defaultGo }: { defaultSettings?: any[]; defaultGo?: any }) =>
        atom({
          enabled: true,
          synced: true,
          go: defaultGo ?? { t: "Infinite" },
          settings: defaultSettings ?? [],
        }),
      (a: any, b: any) => a.tab === b.tab && a.engineId === b.engineId,
    ),
    tabsAtom: atom<any[]>([{ value: "tab-1" }, { value: "tab-2" }]),
  };
});
const treeState = () => ({
  root: { fen: fixtures.fen },
  position: [],
  currentNode: () => ({ engineScore: fixtures.nodeScore }),
  setEngineScore: fixtures.setEngineScore,
});
vi.mock("zustand", () => ({
  useStore: (_store: unknown, selector: (state: any) => unknown) => selector(treeState()),
}));
vi.mock("zustand/react/shallow", () => ({ useShallow: (selector: unknown) => selector }));
vi.mock("@/components/common/TreeStateContext", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  return {
    TreeStateContext: React.createContext({
      getState: () => ({ ...treeState(), root: { fen: fixtures.storeFen ?? fixtures.fen } }),
    }),
  };
});

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
import EvalListener from "./EvalListener";
import { useDisplayedEngineLines } from "../panels/analysis/useDisplayedEngineLines";
import { analysisSearch } from "../panels/analysis/analysisSearch";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let host: HTMLDivElement;
let root: Root;
let mounted: boolean;
const store = getDefaultStore();
const settingsAtom = (tab = store.get(activeTabAtom)!, engineId = engine.id) =>
  tabEngineSettingsFamily({
    engineId,
    tab,
    defaultSettings: [],
    defaultGo: { t: "Infinite" },
  });
const movesAtom = (tab = store.get(activeTabAtom)!, engineId = engine.id) =>
  engineMovesFamily({ tab, engine: engineId });
const progressAtom = (tab = store.get(activeTabAtom)!, engineId = engine.id) =>
  engineProgressFamily({ tab, engine: engineId });
const noLinesAtom = (tab = store.get(activeTabAtom)!, engineId = engine.id) =>
  engineTerminalFamily({ tab, engine: engineId });

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function settleTransition() {
  await act(async () => {
    await flush();
    await flush();
  });
}

function ActiveWorkspace({ children }: { children: React.ReactNode }) {
  const tabId = useAtomValue(activeTabAtom);
  return tabId === null ? null : <WorkspaceTabScope tabId={tabId}>{children}</WorkspaceTabScope>;
}

async function rerender() {
  await act(async () =>
    root.render(
      <ActiveWorkspace>
        <EvalListener />
      </ActiveWorkspace>,
    ),
  );
}

async function unmount() {
  if (!mounted) return;
  await act(async () => root.unmount());
  mounted = false;
}

async function broadcast(payloadValue: BestMovesPayload) {
  await act(async () => {
    for (const listener of [...fixtures.listeners]) listener({ payload: payloadValue });
    await flush();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  for (const mock of [
    fixtures.prepareEngineSearch,
    fixtures.getBestMoves,
    fixtures.chessdbGetBestMoves,
    fixtures.lichessGetBestMoves,
    fixtures.stopEngine,
    fixtures.releaseEngineSearch,
  ])
    mock.mockReset();
  fixtures.fen = INITIAL_FEN;
  fixtures.moves = [];
  fixtures.nodeScore = undefined;
  fixtures.storeFen = null;
  fixtures.setEngineScore.mockImplementation((score: unknown) => {
    fixtures.nodeScore = score;
  });
  fixtures.listeners = [];
  fixtures.prepareEngineSearch.mockResolvedValue("generation-1");
  fixtures.stopEngine.mockResolvedValue(true);
  fixtures.releaseEngineSearch.mockResolvedValue(undefined);
  fixtures.getBestMoves.mockImplementation(() => new Promise(() => undefined));
  fixtures.chessdbGetBestMoves.mockImplementation(() => new Promise(() => undefined));
  fixtures.lichessGetBestMoves.mockImplementation(() => new Promise(() => undefined));
  store.set(activeTabAtom, "tab-1");
  store.set(tabsAtom, [{ value: "tab-1" }, { value: "tab-2" }] as any);
  store.set(closingTabsAtom, new Set());
  store.set(threatFamily("tab-1"), false);
  store.set(enginesAtom, [engine] as any);
  store.set(settingsAtom("tab-1"), {
    enabled: true,
    synced: true,
    go: { t: "Infinite" },
    settings: [],
  });
  store.set(settingsAtom("tab-1", chessdbEngine.id), {
    enabled: true,
    synced: true,
    go: { t: "Infinite" },
    settings: [],
  });
  store.set(movesAtom("tab-1"), new Map([["old", payload("cached").bestLines]]));
  store.set(progressAtom("tab-1"), 73);
  store.set(noLinesAtom("tab-1"), null);
  store.set(engineRetryFamily({ tab: "tab-1", engine: engine.id }), 0);
  store.set(movesAtom("tab-1", chessdbEngine.id), new Map());
  store.set(progressAtom("tab-1", chessdbEngine.id), 0);
  store.set(noLinesAtom("tab-1", chessdbEngine.id), null);
  store.set(engineRetryFamily({ tab: "tab-1", engine: chessdbEngine.id }), 0);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  mounted = true;
});

afterEach(async () => {
  await unmount();
  host.remove();
  vi.useRealTimers();
});

test("first change starts immediately without advancing timers", async () => {
  await rerender();

  expect(store.get(movesAtom()).size).toBe(0);
  expect(store.get(progressAtom())).toBe(0);
  expect(fixtures.prepareEngineSearch).toHaveBeenCalledWith(engine, "tab-1");
  expect(fixtures.getBestMoves).toHaveBeenCalledWith(
    engine,
    "tab-1",
    { t: "Infinite" },
    {
      fen: INITIAL_FEN,
      moves: [],
      extraOptions: [],
    },
    "generation-1",
  );
});

test("a current ChessDB promise result populates its cache and progress", async () => {
  const result = deferred<ReturnType<typeof remoteResult>>();
  fixtures.chessdbGetBestMoves.mockReturnValueOnce(result.promise);
  store.set(enginesAtom, [chessdbEngine] as any);
  await rerender();
  await settleTransition();

  expect(fixtures.chessdbGetBestMoves).toHaveBeenCalledWith(
    "tab-1",
    { t: "Infinite" },
    {
      fen: INITIAL_FEN,
      moves: [],
      extraOptions: [],
    },
  );
  await act(async () => {
    result.resolve(remoteResult(81));
    await flush();
  });

  expect(store.get(movesAtom("tab-1", chessdbEngine.id)).get(`${INITIAL_FEN}:`)).toEqual(
    remoteResult(81)[1],
  );
  expect(store.get(progressAtom("tab-1", chessdbEngine.id))).toBe(81);
});

test("a typed ChessDB absence reaches its exact display key and navigation clears it", async () => {
  fixtures.chessdbGetBestMoves.mockResolvedValueOnce({ type: "not-in-database" });
  store.set(enginesAtom, [chessdbEngine] as any);
  let display: ReturnType<typeof useDisplayedEngineLines> | undefined;
  function Display() {
    display = useDisplayedEngineLines(chessdbEngine, fixtures.fen, fixtures.moves);
    return null;
  }
  const render = () =>
    act(async () =>
      root.render(
        <WorkspaceTabScope tabId="tab-1">
          <EvalListener />
          <Display />
        </WorkspaceTabScope>,
      ),
    );
  await render();
  expect(store.get(noLinesAtom("tab-1", chessdbEngine.id))).toMatchObject({
    type: "not-in-database",
    searchedKey: `${INITIAL_FEN}:`,
    generation: null,
    retry: 0,
  });
  expect(display?.terminal?.type).toBe("not-in-database");
  expect(display?.lines).toEqual([]);
  await act(async () => vi.advanceTimersByTime(5000));
  expect(display?.loading).toBe(false);
  fixtures.fen = positionB;
  await render();
  expect(store.get(noLinesAtom("tab-1", chessdbEngine.id))).toBeNull();
  expect(display?.terminal).toBeNull();
  await act(async () => vi.advanceTimersByTime(1000));
  expect(display?.loading).toBe(true);
});

test.each(["chessdb", "lichess"] as const)(
  "a rejected %s lookup reaches the failed display and Retry requests again",
  async (type) => {
    const remote = { ...chessdbEngine, type };
    const lookup = type === "chessdb" ? fixtures.chessdbGetBestMoves : fixtures.lichessGetBestMoves;
    lookup.mockRejectedValueOnce(new Error("Remote request failed"));
    store.set(enginesAtom, [remote] as any);
    let display: ReturnType<typeof useDisplayedEngineLines> | undefined;
    function Display() {
      display = useDisplayedEngineLines(remote, fixtures.fen, fixtures.moves);
      return null;
    }
    await act(async () =>
      root.render(
        <WorkspaceTabScope tabId="tab-1">
          <EvalListener />
          <Display />
        </WorkspaceTabScope>,
      ),
    );
    expect(display?.failure).toMatchObject({
      type: "failed",
      message: "Remote request failed",
      searchedKey: `${INITIAL_FEN}:`,
      retry: 0,
    });
    await act(async () => vi.advanceTimersByTime(5000));
    expect(display?.loading).toBe(false);
    expect(lookup).toHaveBeenCalledTimes(1);
    await act(async () =>
      store.set(engineRetryFamily({ tab: "tab-1", engine: remote.id }), (n) => n + 1),
    );
    expect(display?.failure).toBeNull();
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(fixtures.prepareEngineSearch).not.toHaveBeenCalled();
  },
);

test("an empty Lichess result completes with the generic no-analysis display", async () => {
  const remote = { ...chessdbEngine, type: "lichess" as const };
  fixtures.lichessGetBestMoves.mockResolvedValueOnce([100, []]);
  store.set(enginesAtom, [remote] as any);
  let display: ReturnType<typeof useDisplayedEngineLines> | undefined;
  function Display() {
    display = useDisplayedEngineLines(remote, fixtures.fen, fixtures.moves);
    return null;
  }
  await act(async () =>
    root.render(
      <WorkspaceTabScope tabId="tab-1">
        <EvalListener />
        <Display />
      </WorkspaceTabScope>,
    ),
  );
  expect(display?.terminal?.type).toBe("completed-without-lines");
  expect(display?.lines).toEqual([]);
  await act(async () => vi.advanceTimersByTime(5000));
  expect(display?.loading).toBe(false);
});

test.each(["absent", "failed"])(
  "a stale remote %s outcome cannot mark a newer search",
  async (outcome) => {
    const result = deferred<{ type: "not-in-database" }>();
    fixtures.chessdbGetBestMoves.mockReturnValueOnce(result.promise);
    store.set(enginesAtom, [chessdbEngine] as any);
    await rerender();
    fixtures.fen = positionB;
    await rerender();
    await act(async () => {
      if (outcome === "absent") result.resolve({ type: "not-in-database" });
      else result.reject(new Error("obsolete remote failure"));
      await flush();
    });
    expect(store.get(noLinesAtom("tab-1", chessdbEngine.id))).toBeNull();
    expect(fixtures.notifyUnlessCancelled).not.toHaveBeenCalled();
  },
);

test("A to B to A does not let a generation-equivalent remote attempt complete", async () => {
  const results = [
    deferred<ReturnType<typeof remoteResult>>(),
    deferred<ReturnType<typeof remoteResult>>(),
    deferred<ReturnType<typeof remoteResult>>(),
  ];
  fixtures.chessdbGetBestMoves
    .mockReturnValueOnce(results[0].promise)
    .mockReturnValueOnce(results[1].promise)
    .mockReturnValueOnce(results[2].promise);
  store.set(enginesAtom, [chessdbEngine] as any);
  await rerender();
  await settleTransition();

  fixtures.fen = positionB;
  await rerender();
  await settleTransition();
  fixtures.fen = INITIAL_FEN;
  await rerender();
  await settleTransition();

  await act(async () => {
    results[0].resolve(remoteResult(41));
    await flush();
  });
  expect(store.get(movesAtom("tab-1", chessdbEngine.id)).size).toBe(0);
  expect(store.get(progressAtom("tab-1", chessdbEngine.id))).toBe(0);

  await act(async () => {
    results[2].resolve(remoteResult(82));
    await flush();
  });
  expect(store.get(movesAtom("tab-1", chessdbEngine.id)).get(`${INITIAL_FEN}:`)).toBeDefined();
  expect(store.get(progressAtom("tab-1", chessdbEngine.id))).toBe(82);
});

test("position, settings, and tab changes reject stale ChessDB promise results", async () => {
  const results = Array.from({ length: 4 }, () => deferred<ReturnType<typeof remoteResult>>());
  for (const result of results) {
    fixtures.chessdbGetBestMoves.mockReturnValueOnce(result.promise);
  }
  store.set(enginesAtom, [chessdbEngine] as any);
  await rerender();
  await settleTransition();

  fixtures.fen = positionB;
  await rerender();
  await settleTransition();
  await act(async () => {
    results[0].resolve(remoteResult(31));
    await flush();
  });
  expect(store.get(movesAtom("tab-1", chessdbEngine.id)).size).toBe(0);
  expect(store.get(progressAtom("tab-1", chessdbEngine.id))).toBe(0);

  await act(async () => {
    store.set(settingsAtom("tab-1", chessdbEngine.id), {
      enabled: true,
      synced: true,
      go: { t: "Depth", c: 14 },
      settings: [],
    });
    await flush();
  });
  await settleTransition();
  await act(async () => {
    results[1].resolve(remoteResult(32));
    await flush();
  });
  expect(store.get(movesAtom("tab-1", chessdbEngine.id)).size).toBe(0);
  expect(store.get(progressAtom("tab-1", chessdbEngine.id))).toBe(0);

  await act(async () => {
    store.set(activeTabAtom, "tab-2");
    await flush();
  });
  await settleTransition();
  await act(async () => {
    results[2].resolve(remoteResult(33));
    await flush();
  });
  expect(store.get(movesAtom("tab-1", chessdbEngine.id)).size).toBe(0);
  expect(store.get(progressAtom("tab-1", chessdbEngine.id))).toBe(0);
  expect(store.get(movesAtom("tab-2", chessdbEngine.id)).size).toBe(0);
  expect(store.get(progressAtom("tab-2", chessdbEngine.id))).toBe(0);
});

test("close intent preserves remote line memory through refusal and a stale result cannot replace it", async () => {
  fixtures.chessdbGetBestMoves.mockResolvedValueOnce(remoteResult(65));
  store.set(enginesAtom, [chessdbEngine] as any);
  await rerender();
  await settleTransition();
  const remembered = store.get(movesAtom("tab-1", chessdbEngine.id)).get(`${INITIAL_FEN}:`);
  expect(remembered).toEqual(remoteResult(65)[1]);
  const result = deferred<ReturnType<typeof remoteResult>>();
  fixtures.chessdbGetBestMoves.mockReturnValueOnce(result.promise);
  fixtures.fen = positionB;
  await rerender();
  await settleTransition();

  await act(async () => {
    store.set(closingTabsAtom, new Set(["tab-1"]));
    expect(store.get(movesAtom("tab-1", chessdbEngine.id)).get(`${INITIAL_FEN}:`)).toEqual(
      remembered,
    );
    expect(store.get(progressAtom("tab-1", chessdbEngine.id))).toBe(0);
    store.set(closingTabsAtom, new Set());
    await flush();
  });
  await act(async () => {
    result.resolve(remoteResult(66));
    await flush();
  });

  expect(store.get(movesAtom("tab-1", chessdbEngine.id)).size).toBe(1);
  expect(store.get(movesAtom("tab-1", chessdbEngine.id)).get(`${INITIAL_FEN}:`)).toEqual(
    remembered,
  );
  expect(store.get(movesAtom("tab-1", chessdbEngine.id)).has(`${positionB}:`)).toBe(false);
  expect(store.get(progressAtom("tab-1", chessdbEngine.id))).toBe(0);
});

test("a ChessDB promise completing after unmount cannot write state", async () => {
  const result = deferred<ReturnType<typeof remoteResult>>();
  fixtures.chessdbGetBestMoves.mockReturnValueOnce(result.promise);
  store.set(enginesAtom, [chessdbEngine] as any);
  await rerender();
  await settleTransition();
  await unmount();

  await act(async () => {
    result.resolve(remoteResult(67));
    await flush();
  });

  expect(store.get(movesAtom("tab-1", chessdbEngine.id)).size).toBe(0);
  expect(store.get(progressAtom("tab-1", chessdbEngine.id))).toBe(0);
});

test("a result pending while its engine is unloaded is dropped before React unmounts it", async () => {
  const result = deferred<ReturnType<typeof remoteResult>>();
  fixtures.chessdbGetBestMoves.mockReturnValueOnce(result.promise);
  store.set(enginesAtom, [chessdbEngine] as any);
  await rerender();
  await settleTransition();

  // Outside act: the store holds the unloaded engine while the listener is
  // still mounted, which is the window between the store write and React's
  // passive unmount cleanup.
  store.set(enginesAtom, [{ ...chessdbEngine, loaded: false }] as any);
  result.resolve(remoteResult(68));
  await flush();

  expect(store.get(movesAtom("tab-1", chessdbEngine.id)).size).toBe(0);
  expect(store.get(progressAtom("tab-1", chessdbEngine.id))).toBe(0);
});

test("a result pending while its engine's executable is replaced under the same id is dropped", async () => {
  const result = deferred<ReturnType<typeof remoteResult>>();
  fixtures.chessdbGetBestMoves.mockReturnValueOnce(result.promise);
  store.set(enginesAtom, [chessdbEngine] as any);
  await rerender();
  await settleTransition();

  // Outside act, as above: still loaded, same id, different endpoint.
  store.set(enginesAtom, [{ ...chessdbEngine, url: "https://other.example" }] as any);
  result.resolve(remoteResult(69));
  await flush();

  expect(store.get(movesAtom("tab-1", chessdbEngine.id)).size).toBe(0);
  expect(store.get(progressAtom("tab-1", chessdbEngine.id))).toBe(0);
});

test("a native broadcast for an engine unloaded before React unmounts it is dropped", async () => {
  fixtures.prepareEngineSearch.mockResolvedValue("generation-unloaded");
  await rerender();
  await settleTransition();

  store.set(enginesAtom, [{ ...engine, loaded: false }] as any);
  // Not via `broadcast`: its `act` would re-render, unmount the listener and
  // unregister it, so the loop would fire nothing and the test would pass vacuously.
  for (const listener of [...fixtures.listeners]) {
    listener({ payload: payload("generation-unloaded") });
  }
  await flush();

  expect(store.get(movesAtom()).size).toBe(0);
  expect(store.get(progressAtom())).toBe(0);
});

test("settings and go changes reject old events during transition and clear cached state", async () => {
  fixtures.prepareEngineSearch
    .mockResolvedValueOnce("generation-old")
    .mockResolvedValueOnce("generation-new");
  await rerender();
  await settleTransition();
  store.set(movesAtom(), new Map([[`${INITIAL_FEN}:`, payload("old").bestLines]]));
  store.set(progressAtom(), 61);

  await act(async () => {
    store.set(settingsAtom(), {
      enabled: true,
      synced: true,
      go: { t: "Depth", c: 18 },
      settings: [{ type: "string", name: "MultiPV", value: "3" }],
    });
    await flush();
  });

  expect(store.get(movesAtom()).size).toBe(0);
  expect(store.get(progressAtom())).toBe(0);
  await broadcast(payload("generation-old", { progress: 88 }));
  expect(store.get(movesAtom()).size).toBe(0);
  expect(store.get(progressAtom())).toBe(0);
  expect(fixtures.prepareEngineSearch).toHaveBeenCalledTimes(2);

  await settleTransition();
  expect(fixtures.stopEngine).toHaveBeenCalledWith(engine, "tab-1", "generation-old");
  expect(fixtures.getBestMoves).toHaveBeenLastCalledWith(
    engine,
    "tab-1",
    { t: "Depth", c: 18 },
    {
      fen: INITIAL_FEN,
      moves: [],
      extraOptions: [{ type: "string", name: "MultiPV", value: "3" }],
    },
    "generation-new",
  );
});

test.each([
  ["Threads option", [{ type: "string" as const, name: "Threads", value: "4" }]],
  ["MultiPV option", [{ type: "string" as const, name: "MultiPV", value: "3" }]],
])(
  "a same-position %s change alone rejects old events during transition",
  async (_name, settings) => {
    fixtures.prepareEngineSearch
      .mockResolvedValueOnce("before-option")
      .mockResolvedValueOnce("after-option");
    await rerender();
    await settleTransition();

    await act(async () => {
      store.set(settingsAtom(), {
        enabled: true,
        synced: true,
        go: { t: "Infinite" },
        settings,
      });
      await flush();
    });
    await broadcast(payload("before-option", { progress: 82 }));
    expect(store.get(movesAtom()).size).toBe(0);
    expect(store.get(progressAtom())).toBe(0);
    expect(fixtures.prepareEngineSearch).toHaveBeenCalledTimes(2);

    await settleTransition();
    expect(fixtures.prepareEngineSearch).toHaveBeenCalledTimes(2);
  },
);

test("a same-position go-only change rejects old events during transition", async () => {
  fixtures.prepareEngineSearch.mockResolvedValueOnce("before-go").mockResolvedValueOnce("after-go");
  await rerender();
  await settleTransition();

  await act(async () => {
    store.set(settingsAtom(), {
      enabled: true,
      synced: true,
      go: { t: "Depth", c: 20 },
      settings: [],
    });
    await flush();
  });
  await broadcast(payload("before-go", { progress: 82 }));
  expect(store.get(movesAtom()).size).toBe(0);
  expect(store.get(progressAtom())).toBe(0);
  expect(fixtures.prepareEngineSearch).toHaveBeenCalledTimes(2);

  await settleTransition();
  expect(fixtures.prepareEngineSearch).toHaveBeenCalledTimes(2);
});

test("an executable change rejects the old owner during transition", async () => {
  fixtures.prepareEngineSearch
    .mockResolvedValueOnce("old-binary-owner")
    .mockResolvedValueOnce("new-binary-owner");
  await rerender();
  await settleTransition();
  store.set(movesAtom(), new Map([[`${INITIAL_FEN}:`, payload("old").bestLines]]));
  store.set(progressAtom(), 64);
  const replacement = {
    ...engine,
    handle: { id: { id: "handle-2" }, kind: "engine" as const },
  };

  await act(async () => {
    store.set(enginesAtom, [replacement] as any);
    await flush();
  });
  expect(store.get(movesAtom()).size).toBe(0);
  expect(store.get(progressAtom())).toBe(0);
  await broadcast(payload("old-binary-owner", { progress: 90 }));
  expect(store.get(progressAtom())).toBe(0);
  expect(fixtures.prepareEngineSearch).toHaveBeenCalledTimes(2);

  await settleTransition();
  expect(fixtures.releaseEngineSearch).toHaveBeenCalledWith(engine, "tab-1", "old-binary-owner");
  expect(fixtures.prepareEngineSearch).toHaveBeenLastCalledWith(replacement, "tab-1");
});

test("accepts current info and terminal results but rejects an old generation", async () => {
  fixtures.prepareEngineSearch.mockResolvedValue("generation-current");
  await rerender();
  await settleTransition();

  await broadcast(payload("generation-old"));
  expect(store.get(movesAtom()).size).toBe(0);
  expect(store.get(progressAtom())).toBe(0);

  await broadcast(payload("generation-current"));
  expect(store.get(movesAtom()).get(`${INITIAL_FEN}:`)).toEqual(
    payload("generation-current").bestLines,
  );
  expect(store.get(progressAtom())).toBe(50);

  await broadcast(payload("generation-current", { progress: 100 }));
  expect(store.get(progressAtom())).toBe(100);
});

test("A to B to A and unmount/remount never reuse an attempt identity", async () => {
  fixtures.prepareEngineSearch
    .mockResolvedValueOnce("generation-a1")
    .mockResolvedValueOnce("generation-b")
    .mockResolvedValueOnce("generation-a2")
    .mockResolvedValueOnce("generation-a3");
  await rerender();
  await settleTransition();

  fixtures.fen = positionB;
  await rerender();
  await settleTransition();
  fixtures.fen = INITIAL_FEN;
  await rerender();
  await settleTransition();

  await broadcast(payload("generation-a1"));
  expect(store.get(movesAtom()).size).toBe(0);
  await broadcast(payload("generation-a2"));
  expect(store.get(progressAtom())).toBe(50);

  await unmount();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  mounted = true;
  await rerender();
  await settleTransition();
  store.set(movesAtom(), new Map());
  await broadcast(payload("generation-a2"));
  expect(store.get(movesAtom()).size).toBe(0);
  await broadcast(payload("generation-a3"));
  expect(store.get(progressAtom())).toBe(50);
});

test("stale and unmounted preparations release exactly their returned owners", async () => {
  const prepares = [deferred<string>(), deferred<string>(), deferred<string>()];
  fixtures.prepareEngineSearch
    .mockReturnValueOnce(prepares[0].promise)
    .mockReturnValueOnce(prepares[1].promise)
    .mockReturnValueOnce(prepares[2].promise);
  await rerender();
  await settleTransition();

  fixtures.fen = positionB;
  await rerender();
  await settleTransition();
  await act(async () => {
    prepares[0].resolve("stale-owner");
    await flush();
  });
  expect(fixtures.prepareEngineSearch).toHaveBeenCalledTimes(2);
  await act(async () => {
    prepares[1].resolve("new-owner");
    await flush();
  });
  expect(fixtures.getBestMoves).toHaveBeenCalledWith(
    engine,
    "tab-1",
    { t: "Infinite" },
    expect.anything(),
    "new-owner",
  );
  expect(fixtures.stopEngine).toHaveBeenCalledWith(engine, "tab-1", "stale-owner");
  expect(fixtures.stopEngine).not.toHaveBeenCalledWith(engine, "tab-1", "new-owner");

  await unmount();
  expect(fixtures.releaseEngineSearch).toHaveBeenCalledWith(engine, "tab-1", "new-owner");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  mounted = true;
  await rerender();
  await settleTransition();
  await unmount();
  await act(async () => {
    prepares[2].resolve("unmounted-owner");
    await flush();
  });
  expect(fixtures.releaseEngineSearch).toHaveBeenCalledWith(engine, "tab-1", "unmounted-owner");
});

test("tab switch and unmount during transition release the captured predecessor", async () => {
  fixtures.prepareEngineSearch
    .mockResolvedValueOnce("tab-1-owner")
    .mockResolvedValueOnce("tab-2-owner");
  await rerender();
  await settleTransition();

  await act(async () => {
    store.set(activeTabAtom, "tab-2");
    await flush();
  });
  expect(fixtures.stopEngine).not.toHaveBeenCalled();
  expect(fixtures.releaseEngineSearch).toHaveBeenCalledWith(engine, "tab-1", "tab-1-owner");
  await settleTransition();
  expect(fixtures.stopEngine).not.toHaveBeenCalled();

  fixtures.fen = positionD;
  await rerender();
  await unmount();
  expect(fixtures.releaseEngineSearch).toHaveBeenCalledWith(engine, "tab-2", "tab-2-owner");
});

test("position changes stop the search and keep its actor warm", async () => {
  fixtures.prepareEngineSearch
    .mockResolvedValueOnce("position-a")
    .mockResolvedValueOnce("position-b");
  await rerender();
  await settleTransition();
  fixtures.fen = positionB;
  await rerender();
  await settleTransition();
  expect(fixtures.stopEngine).toHaveBeenCalledWith(engine, "tab-1", "position-a");
  expect(fixtures.releaseEngineSearch).not.toHaveBeenCalled();
});

test("pause and resume retain remembered lines while releasing the owner and rejecting paused output", async () => {
  fixtures.prepareEngineSearch
    .mockResolvedValueOnce("generation-1")
    .mockResolvedValueOnce("resumed");
  await rerender();
  await settleTransition();
  const remembered = payload("generation-1");
  await broadcast(remembered);
  await act(async () => {
    store.set(settingsAtom(), { ...store.get(settingsAtom()), enabled: false });
    await flush();
  });
  expect(fixtures.releaseEngineSearch).toHaveBeenCalledWith(engine, "tab-1", "generation-1");
  await settleTransition();
  expect(fixtures.prepareEngineSearch).toHaveBeenCalledTimes(1);
  expect(fixtures.stopEngine).not.toHaveBeenCalled();
  expect(store.get(movesAtom()).get(`${INITIAL_FEN}:`)).toEqual(remembered.bestLines);
  const stale = payload("generation-1", { progress: 91 });
  stale.bestLines[0].score.value.value = 999;
  await broadcast(stale);
  expect(store.get(progressAtom())).toBe(0);
  await act(async () => {
    store.set(settingsAtom(), { ...store.get(settingsAtom()), enabled: true });
    await flush();
  });
  await settleTransition();
  expect(fixtures.prepareEngineSearch).toHaveBeenCalledTimes(2);
  expect(store.get(movesAtom()).get(`${INITIAL_FEN}:`)).toEqual(remembered.bestLines);
  await broadcast(stale);
  expect(store.get(movesAtom()).get(`${INITIAL_FEN}:`)).toEqual(remembered.bestLines);
  expect(store.get(progressAtom())).toBe(0);
});

test.each(["settings", "go", "synced"])(
  "line memory invalidates only computation settings: %s",
  async (field) => {
    await rerender();
    const remembered = payload("generation-1");
    await broadcast(remembered);
    await act(async () => {
      store.set(settingsAtom(), (settings) => ({
        ...settings,
        ...(field === "settings"
          ? { settings: [{ type: "string" as const, name: "Hash", value: "256" }] }
          : {}),
        ...(field === "go" ? { go: { t: "Depth" as const, c: 18 } } : {}),
        ...(field === "synced" ? { synced: false } : {}),
      }));
      await flush();
    });
    expect(store.get(movesAtom()).size).toBe(field === "synced" ? 1 : 0);
    expect(store.get(movesAtom()).get(`${INITIAL_FEN}:`)).toEqual(
      field === "synced" ? remembered.bestLines : undefined,
    );
  },
);

test("unmount during preparation releases the retained warm actor and the late reservation", async () => {
  await rerender();
  await settleTransition();
  const prepare = deferred<string>();
  fixtures.prepareEngineSearch.mockReturnValueOnce(prepare.promise);
  fixtures.fen = positionB;
  await rerender();
  await settleTransition();
  await unmount();
  expect(fixtures.releaseEngineSearch).toHaveBeenCalledWith(engine, "tab-1", "generation-1");
  await act(async () => {
    prepare.resolve("pending-owner");
    await flush();
  });
  expect(fixtures.releaseEngineSearch).toHaveBeenCalledWith(engine, "tab-1", "pending-owner");
});

test("a cancelled pending successor preserves the actual warm owner for cleanup", async () => {
  await rerender();
  await settleTransition();
  fixtures.prepareEngineSearch
    .mockResolvedValueOnce("pending-b")
    .mockResolvedValueOnce("pending-c");
  fixtures.fen = positionB;
  await rerender();
  await settleTransition();
  fixtures.stopEngine.mockResolvedValueOnce(false);
  fixtures.fen = positionC;
  await rerender();
  await settleTransition();
  await unmount();
  expect(fixtures.releaseEngineSearch).toHaveBeenCalledWith(engine, "tab-1", "generation-1");
  expect(fixtures.releaseEngineSearch).toHaveBeenCalledWith(engine, "tab-1", "pending-c");
});

test("a rejected predecessor stop is notified once, retired, and the newest request searches", async () => {
  await rerender();
  await settleTransition();
  const failure = new Error("stop failed");
  fixtures.stopEngine.mockRejectedValueOnce(failure);

  fixtures.fen = positionB;
  await rerender();
  await settleTransition();

  expect(fixtures.prepareEngineSearch).toHaveBeenCalledTimes(2);
  expect(fixtures.notifyUnlessCancelled).toHaveBeenCalledWith("Common.Error", failure);
  fixtures.fen = positionC;
  await rerender();
  expect(fixtures.prepareEngineSearch).toHaveBeenCalledTimes(3);
  expect(fixtures.notifyUnlessCancelled).toHaveBeenCalledTimes(1);
});

test("a superseded preparation rejection does not mark while the current rejection marks and notifies once", async () => {
  const first = deferred<string>();
  const conflict = new Error("Conflict: invalid or expired reservation");
  const second = deferred<string>();
  fixtures.prepareEngineSearch
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise);
  await rerender();
  await settleTransition();

  fixtures.fen = positionB;
  await rerender();
  await act(async () => {
    first.reject(conflict);
    await flush();
  });
  expect(fixtures.notifyUnlessCancelled).not.toHaveBeenCalled();
  expect(store.get(noLinesAtom())).toBeNull();
  await act(async () => {
    second.reject(conflict);
    await flush();
  });
  expect(fixtures.notifyUnlessCancelled).toHaveBeenCalledExactlyOnceWith("Common.Error", conflict);
  expect(store.get(noLinesAtom())?.searchedKey).toBe(`${positionB}:`);
  expect(fixtures.getBestMoves).not.toHaveBeenCalled();
});

test("live close and tab removal block transitions, preparation, and later starts", async () => {
  store.set(closingTabsAtom, new Set(["tab-1"]));
  await rerender();
  await act(async () => flush());
  await settleTransition();
  expect(fixtures.prepareEngineSearch).not.toHaveBeenCalled();

  const prepare = deferred<string>();
  fixtures.prepareEngineSearch.mockReturnValueOnce(prepare.promise);
  store.set(closingTabsAtom, new Set());
  await act(async () => flush());
  await settleTransition();
  store.set(closingTabsAtom, new Set(["tab-1"]));
  store.set(tabsAtom, [{ value: "tab-2" }] as any);
  await act(async () => {
    prepare.resolve("closing-owner");
    await flush();
  });
  expect(fixtures.stopEngine).toHaveBeenCalledWith(engine, "tab-1", "closing-owner");
  expect(fixtures.getBestMoves).not.toHaveBeenCalled();

  store.set(closingTabsAtom, new Set());
  await act(async () => flush());
  await settleTransition();
  expect(fixtures.prepareEngineSearch).toHaveBeenCalledTimes(1);
});

test("close intent arriving during predecessor stop blocks preparation", async () => {
  await rerender();
  await settleTransition();
  const stop = deferred<void>();
  fixtures.stopEngine.mockReturnValueOnce(stop.promise);

  fixtures.fen = positionB;
  await rerender();
  await act(async () => {
    await flush();
    await flush();
  });
  expect(fixtures.stopEngine).toHaveBeenCalledWith(engine, "tab-1", "generation-1");
  store.set(closingTabsAtom, new Set(["tab-1"]));
  await act(async () => {
    stop.resolve();
    await flush();
  });

  expect(fixtures.prepareEngineSearch).toHaveBeenCalledTimes(1);
  expect(fixtures.getBestMoves).toHaveBeenCalledTimes(1);
});

test("a fast failed close preserves remembered lines, cancels the old attempt and starts a fresh one", async () => {
  fixtures.prepareEngineSearch
    .mockResolvedValueOnce("before-close")
    .mockResolvedValueOnce("after-failed-close");
  await rerender();
  await settleTransition();
  const remembered = payload("before-close");
  await broadcast(remembered);

  await act(async () => {
    store.set(closingTabsAtom, new Set(["tab-1"]));
    store.set(closingTabsAtom, new Set());
    await flush();
  });
  await broadcast(payload("before-close", { progress: 91 }));
  expect(store.get(movesAtom()).get(`${INITIAL_FEN}:`)).toEqual(remembered.bestLines);
  expect(store.get(progressAtom())).toBe(0);

  await settleTransition();
  expect(fixtures.stopEngine).toHaveBeenCalledWith(engine, "tab-1", "before-close");
  expect(fixtures.prepareEngineSearch).toHaveBeenCalledTimes(2);
  expect(fixtures.getBestMoves).toHaveBeenLastCalledWith(
    engine,
    "tab-1",
    { t: "Infinite" },
    expect.anything(),
    "after-failed-close",
  );
});

test("same-name engines retain independent cache, progress, and native owners", async () => {
  const twin = { ...engine, id: "engine-2" };
  fixtures.prepareEngineSearch.mockImplementation(async (candidate: typeof engine) =>
    candidate.id === "engine-1" ? "owner-1" : "owner-2",
  );
  await act(async () => {
    store.set(enginesAtom, [engine, twin] as any);
    await flush();
  });
  await rerender();
  await settleTransition();

  expect(fixtures.listeners).toHaveLength(2);
  expect(fixtures.getBestMoves).toHaveBeenCalledWith(
    engine,
    "tab-1",
    expect.anything(),
    expect.anything(),
    "owner-1",
  );
  expect(fixtures.getBestMoves).toHaveBeenCalledWith(
    twin,
    "tab-1",
    expect.anything(),
    expect.anything(),
    "owner-2",
  );
  await broadcast(payload("owner-1"));
  await broadcast(payload("owner-2", { engine: "engine-2", progress: 75 }));
  expect(store.get(movesAtom("tab-1", "engine-1")).get(`${INITIAL_FEN}:`)).toBeDefined();
  expect(store.get(movesAtom("tab-1", "engine-2")).get(`${INITIAL_FEN}:`)).toBeDefined();
  expect(store.get(progressAtom("tab-1", "engine-1"))).toBe(50);
  expect(store.get(progressAtom("tab-1", "engine-2"))).toBe(75);
});

test("a navigation burst during stop runs only the newest request next", async () => {
  await rerender();
  const stop = deferred<boolean>();
  fixtures.stopEngine.mockReturnValueOnce(stop.promise);
  fixtures.fen = positionB;
  await rerender();
  fixtures.fen = positionC;
  await rerender();
  fixtures.fen = positionD;
  await rerender();
  expect(fixtures.prepareEngineSearch).toHaveBeenCalledTimes(1);
  await broadcast(payload("generation-1"));
  expect(store.get(movesAtom()).size).toBe(0);
  await act(async () => {
    stop.resolve(true);
    await flush();
  });
  expect(fixtures.stopEngine).toHaveBeenCalledTimes(1);
  expect(fixtures.prepareEngineSearch).toHaveBeenCalledTimes(2);
  expect(fixtures.getBestMoves).toHaveBeenCalledTimes(2);
  expect(fixtures.getBestMoves.mock.calls.map((call) => call[3].fen)).toEqual([
    INITIAL_FEN,
    positionD,
  ]);
});

test("a navigation burst during preparation retires the stale reservation then prepares only the newest", async () => {
  const prepare = deferred<string>();
  fixtures.prepareEngineSearch.mockReturnValueOnce(prepare.promise).mockResolvedValueOnce("newest");
  await rerender();
  fixtures.fen = positionB;
  await rerender();
  fixtures.fen = positionC;
  await rerender();
  expect(fixtures.prepareEngineSearch).toHaveBeenCalledTimes(1);
  expect(fixtures.getBestMoves).not.toHaveBeenCalled();
  await act(async () => {
    prepare.resolve("stale");
    await flush();
  });
  expect(fixtures.stopEngine).toHaveBeenCalledWith(engine, "tab-1", "stale");
  expect(fixtures.prepareEngineSearch).toHaveBeenCalledTimes(2);
  expect(fixtures.getBestMoves).toHaveBeenCalledTimes(1);
  expect(fixtures.getBestMoves.mock.calls[0][3].fen).toBe(positionC);
});

test("a stop rejected after navigation is notified once and cannot poison the coalescing slot", async () => {
  await rerender();
  const stop = deferred<boolean>();
  const failure = new Error("stop failed while superseded");
  fixtures.stopEngine.mockReturnValueOnce(stop.promise);
  fixtures.fen = positionB;
  await rerender();
  fixtures.fen = positionC;
  await rerender();
  await act(async () => {
    stop.reject(failure);
    await flush();
  });
  expect(fixtures.notifyUnlessCancelled).toHaveBeenCalledExactlyOnceWith("Common.Error", failure);
  expect(fixtures.stopEngine).toHaveBeenCalledTimes(1);
  expect(fixtures.prepareEngineSearch).toHaveBeenCalledTimes(2);
  expect(fixtures.getBestMoves.mock.calls[1][3].fen).toBe(positionC);
  await unmount();
  expect(fixtures.notifyUnlessCancelled).toHaveBeenCalledTimes(1);
});

test("a rejected predecessor release is notified once and the new tab prepares and searches", async () => {
  await rerender();
  const release = deferred<void>();
  const failure = new Error("release failed");
  fixtures.releaseEngineSearch.mockReturnValueOnce(release.promise);
  await act(async () => {
    store.set(activeTabAtom, "tab-2");
    await flush();
  });
  fixtures.fen = positionC;
  await rerender();
  expect(fixtures.prepareEngineSearch).toHaveBeenCalledTimes(1);
  await act(async () => {
    release.reject(failure);
    await flush();
  });
  expect(fixtures.notifyUnlessCancelled).toHaveBeenCalledExactlyOnceWith("Common.Error", failure);
  expect(fixtures.releaseEngineSearch).toHaveBeenCalledTimes(1);
  expect(fixtures.prepareEngineSearch).toHaveBeenLastCalledWith(engine, "tab-2");
  expect(fixtures.getBestMoves.mock.calls[1][3].fen).toBe(positionC);
  expect(fixtures.stopEngine).not.toHaveBeenCalled();
  await unmount();
  expect(fixtures.notifyUnlessCancelled).toHaveBeenCalledTimes(1);
});

test("a failed stop does not retain its actor while the successor prepares", async () => {
  await rerender();
  const prepare = deferred<string>();
  fixtures.stopEngine.mockRejectedValueOnce(new Error("stop failed"));
  fixtures.prepareEngineSearch.mockReturnValueOnce(prepare.promise);
  fixtures.fen = positionB;
  await rerender();
  await unmount();
  expect(fixtures.releaseEngineSearch).not.toHaveBeenCalled();
  await act(async () => {
    prepare.resolve("late-owner");
    await flush();
  });
  expect(fixtures.releaseEngineSearch).toHaveBeenCalledExactlyOnceWith(
    engine,
    "tab-1",
    "late-owner",
  );
  expect(fixtures.notifyUnlessCancelled).toHaveBeenCalledTimes(1);
});

test("remembered lines survive A to B to A and restarted shallow output cannot downgrade lines or score", async () => {
  fixtures.prepareEngineSearch
    .mockResolvedValueOnce("a1")
    .mockResolvedValueOnce("b")
    .mockResolvedValueOnce("a2");
  await rerender();
  const deep = payload("a1");
  deep.bestLines[0].depth = 20;
  await broadcast(deep);
  expect(fixtures.setEngineScore).toHaveBeenCalledExactlyOnceWith(deep.bestLines[0].score);
  fixtures.fen = positionB;
  await rerender();
  expect(store.get(movesAtom()).get(`${INITIAL_FEN}:`)).toEqual(deep.bestLines);
  fixtures.fen = INITIAL_FEN;
  await rerender();
  expect(store.get(movesAtom()).get(`${INITIAL_FEN}:`)).toEqual(deep.bestLines);
  const shallow = payload("a2");
  shallow.bestLines[0].depth = 19;
  shallow.bestLines[0].score.value.value = 2;
  await broadcast(shallow);
  expect(store.get(movesAtom()).get(`${INITIAL_FEN}:`)).toEqual(deep.bestLines);
  expect(fixtures.setEngineScore).toHaveBeenCalledTimes(1);
  const equalDepth = payload("a2");
  equalDepth.bestLines[0].depth = 20;
  equalDepth.bestLines[0].score.value.value = 33;
  await broadcast(equalDepth);
  expect(store.get(movesAtom()).get(`${INITIAL_FEN}:`)).toEqual(equalDepth.bestLines);
  expect(fixtures.setEngineScore).toHaveBeenLastCalledWith(equalDepth.bestLines[0].score);
  expect(fixtures.setEngineScore).toHaveBeenCalledTimes(2);
  // Once this search has written the entry, its own revisions may be shallower.
  await broadcast(shallow);
  expect(store.get(movesAtom()).get(`${INITIAL_FEN}:`)).toEqual(shallow.bestLines);
  expect(fixtures.setEngineScore).toHaveBeenCalledTimes(3);
  expect(fixtures.setEngineScore).toHaveBeenLastCalledWith(shallow.bestLines[0].score);
});

test("normal and threat entries coexist and threat toggles restore lines without writing the engine score", async () => {
  fixtures.prepareEngineSearch
    .mockResolvedValueOnce("normal")
    .mockResolvedValueOnce("threat")
    .mockResolvedValueOnce("normal-again")
    .mockResolvedValueOnce("threat-again");
  await rerender();
  const normal = payload("normal");
  await broadcast(normal);
  await act(async () => {
    store.set(threatFamily("tab-1"), true);
    await flush();
  });
  const threat = payload("threat", {
    fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1",
  });
  threat.bestLines[0].depth = 30;
  threat.bestLines[0].score.value.value = -50;
  await broadcast(threat);
  expect(store.get(movesAtom()).size).toBe(2);
  expect(store.get(movesAtom()).get(`${INITIAL_FEN}:`)).toEqual(normal.bestLines);
  expect(fixtures.setEngineScore).toHaveBeenCalledExactlyOnceWith(normal.bestLines[0].score);
  await act(async () => {
    store.set(threatFamily("tab-1"), false);
    await flush();
  });
  expect(store.get(movesAtom()).get(`${INITIAL_FEN}:`)).toEqual(normal.bestLines);
  expect(fixtures.setEngineScore).toHaveBeenCalledTimes(1);
  await act(async () => {
    store.set(threatFamily("tab-1"), true);
    await flush();
  });
  expect(
    store.get(movesAtom()).get("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1:"),
  ).toEqual(threat.bestLines);
  expect(fixtures.setEngineScore).toHaveBeenCalledTimes(1);
});

test("the first engine in list order with lines owns the node score, whatever its type", async () => {
  const cloudLines = remoteResult(100)[1];
  cloudLines[0].score.value.value = 94;
  const cloud = deferred<ReturnType<typeof remoteResult>>();
  fixtures.chessdbGetBestMoves.mockReturnValueOnce(cloud.promise);
  store.set(enginesAtom, [chessdbEngine, engine] as any);
  await rerender();
  await settleTransition();
  // The later local engine fills in while the cloud engine above it has no lines.
  const local = payload("generation-1");
  await broadcast(local);
  expect(fixtures.setEngineScore).toHaveBeenCalledExactlyOnceWith(local.bestLines[0].score);
  await act(async () => {
    cloud.resolve([100, cloudLines]);
    await flush();
  });
  expect(fixtures.setEngineScore).toHaveBeenLastCalledWith(cloudLines[0].score);
  expect(fixtures.setEngineScore).toHaveBeenCalledTimes(2);
  // Once the top engine has lines, the lower engine's later output no longer takes the score.
  const later = payload("generation-1");
  later.bestLines[0].score.value.value = 7;
  await broadcast(later);
  expect(fixtures.setEngineScore).toHaveBeenCalledTimes(2);
  // Reordering hands the score to the new top engine without waiting for another payload.
  await act(async () => store.set(enginesAtom, [engine, chessdbEngine] as any));
  expect(fixtures.setEngineScore).toHaveBeenLastCalledWith(later.bestLines[0].score);
  // Disabling it hands the score back to the next engine with lines.
  await act(async () =>
    store.set(settingsAtom("tab-1"), { ...store.get(settingsAtom("tab-1")), enabled: false }),
  );
  expect(fixtures.setEngineScore).toHaveBeenLastCalledWith(cloudLines[0].score);
  expect(fixtures.setEngineScore).toHaveBeenCalledTimes(4);
});

test("a cloud engine running alone writes the node score", async () => {
  const lines = remoteResult(100)[1];
  fixtures.chessdbGetBestMoves.mockResolvedValueOnce([100, lines]);
  store.set(enginesAtom, [chessdbEngine] as any);
  await rerender();
  await settleTransition();
  expect(fixtures.setEngineScore).toHaveBeenCalledExactlyOnceWith(lines[0].score);
});

test("a live score is not written to a position the tree has already left", async () => {
  await rerender();
  fixtures.storeFen = positionB;
  await broadcast(payload("generation-1"));
  expect(store.get(movesAtom()).get(`${INITIAL_FEN}:`)).toBeDefined();
  expect(fixtures.setEngineScore).not.toHaveBeenCalled();
});

test("a synchronous launch failure marks its key, notifies once and retires the transition slot", async () => {
  const failure = new Error("launch rejected synchronously");
  fixtures.getBestMoves.mockImplementationOnce(() => {
    throw failure;
  });
  await rerender();
  expect(fixtures.notifyUnlessCancelled).toHaveBeenCalledExactlyOnceWith("Common.Error", failure);
  expect(store.get(noLinesAtom())?.searchedKey).toBe(`${INITIAL_FEN}:`);
  fixtures.fen = positionB;
  await rerender();
  expect(fixtures.prepareEngineSearch).toHaveBeenCalledTimes(2);
  expect(fixtures.getBestMoves).toHaveBeenCalledTimes(2);
  expect(store.get(noLinesAtom())).toBeNull();
});

test.each(["preparation", "launch"])(
  "cancelled %s failures never mark the current attempt",
  async (phase) => {
    const cancellation = new Error("Cancellation");
    if (phase === "preparation") fixtures.prepareEngineSearch.mockRejectedValueOnce(cancellation);
    else
      fixtures.getBestMoves.mockImplementationOnce(() => {
        throw cancellation;
      });
    await rerender();
    expect(store.get(noLinesAtom())).toBeNull();
    expect(store.get(movesAtom()).size).toBe(0);
  },
);

test("line context survives listener remount and changes only for settings or executable identity", async () => {
  await rerender();
  const result = payload("generation-1");
  await broadcast(result);
  await unmount();
  root = createRoot(host);
  mounted = true;
  await rerender();
  expect(store.get(movesAtom()).get(`${INITIAL_FEN}:`)).toEqual(result.bestLines);
  fixtures.fen = positionB;
  await rerender();
  expect(store.get(movesAtom()).get(`${INITIAL_FEN}:`)).toEqual(result.bestLines);
  await act(async () => {
    store.set(settingsAtom(), {
      ...store.get(settingsAtom()),
      settings: [{ type: "string", name: "Hash", value: "256" }],
    });
    await flush();
  });
  expect(store.get(movesAtom()).size).toBe(0);
  await broadcast(payload("generation-1", { fen: positionB }));
  expect(store.get(movesAtom()).size).toBe(1);
  const replacement = {
    ...engine,
    handle: { id: { id: "replaced-handle" }, kind: "engine" as const },
  };
  await act(async () => {
    store.set(enginesAtom, [replacement] as any);
    await flush();
  });
  expect(store.get(movesAtom()).size).toBe(0);
});

test("a payload move list must match by deep equality even when joined strings match", async () => {
  fixtures.moves = ["e2e4", "e7e5"];
  await rerender();
  await broadcast(payload("generation-1", { moves: ["e2e4,e7e5"] }));
  expect(store.get(movesAtom()).size).toBe(0);
  await broadcast(payload("generation-1", { moves: ["e2e4", "e7e5"] }));
  expect(store.get(movesAtom()).get(`${INITIAL_FEN}:e2e4,e7e5`)).toBeDefined();
});

test("a current local rejection without lines marks its key, notifies once and navigation clears the mark", async () => {
  const result = deferred<null>();
  const failure = new Error("Illegal UCI move: all PVs unusable");
  fixtures.getBestMoves.mockReturnValueOnce(result.promise);
  await rerender();
  await act(async () => {
    result.reject(failure);
    await flush();
  });
  expect(store.get(noLinesAtom())?.searchedKey).toBe(`${INITIAL_FEN}:`);
  expect(store.get(movesAtom()).size).toBe(0);
  expect(fixtures.notifyUnlessCancelled).toHaveBeenCalledExactlyOnceWith("Common.Error", failure);
  fixtures.fen = positionB;
  await rerender();
  expect(store.get(noLinesAtom())).toBeNull();
  fixtures.fen = INITIAL_FEN;
  await rerender();
  expect(store.get(noLinesAtom())).toBeNull();
});

test("an empty local terminal payload followed by a null result marks completion without storing empty lines", async () => {
  const result = deferred<null>();
  fixtures.getBestMoves.mockReturnValueOnce(result.promise);
  await rerender();
  const terminal = payload("generation-1", { progress: 100 });
  terminal.bestLines = [];
  await broadcast(terminal);
  expect(store.get(noLinesAtom())).toBeNull();
  await act(async () => {
    result.resolve(null);
    await flush();
  });
  expect(store.get(noLinesAtom())?.searchedKey).toBe(`${INITIAL_FEN}:`);
  expect(store.get(movesAtom()).size).toBe(0);
  expect(fixtures.notifyUnlessCancelled).not.toHaveBeenCalled();
  // The same searched key gets a new attempt when its go mode changes.
  await act(async () => store.set(settingsAtom(), (s) => ({ ...s, go: { t: "Depth", c: 12 } })));
  expect(store.get(noLinesAtom())).toBeNull();
});

test.each(["reject", "resolve"])(
  "a superseded local attempt cannot mark the current key on %s",
  async (outcome) => {
    const result = deferred<null>();
    fixtures.getBestMoves.mockReturnValueOnce(result.promise);
    await rerender();
    fixtures.fen = positionB;
    await rerender();
    await act(async () => {
      if (outcome === "reject") result.reject(new Error("obsolete failure"));
      else result.resolve(null);
      await flush();
    });
    expect(store.get(noLinesAtom())).toBeNull();
    expect(fixtures.notifyUnlessCancelled).not.toHaveBeenCalled();
  },
);

test("a cancelled local search does not mark its key", async () => {
  fixtures.getBestMoves.mockRejectedValueOnce(new Error("Cancellation"));
  await rerender();
  expect(store.get(noLinesAtom())).toBeNull();
  expect(store.get(movesAtom()).size).toBe(0);
});

test.each(["reject", "resolve"])(
  "usable streamed lines prevent a no-lines mark when the local search later settles with %s",
  async (outcome) => {
    const result = deferred<null>();
    fixtures.getBestMoves.mockReturnValueOnce(result.promise);
    await rerender();
    const lines = payload("generation-1");
    await broadcast(lines);
    await act(async () => {
      if (outcome === "reject") result.reject(new Error("failed after usable output"));
      else result.resolve(null);
      await flush();
    });
    expect(store.get(noLinesAtom())?.type).toBe(outcome === "reject" ? "failed" : undefined);
    expect(store.get(movesAtom()).get(`${INITIAL_FEN}:`)).toEqual(lines.bestLines);
  },
);

test("usable terminal results and normal payloads clear a no-lines mark", async () => {
  const result = deferred<ReturnType<typeof remoteResult>>();
  fixtures.getBestMoves.mockReturnValueOnce(result.promise);
  await rerender();
  store.set(noLinesAtom(), {
    type: "completed-without-lines",
    searchedKey: `${INITIAL_FEN}:`,
  } as any);
  await act(async () => {
    result.resolve(remoteResult(100));
    await flush();
  });
  expect(store.get(noLinesAtom())).toBeNull();
  expect(store.get(movesAtom()).get(`${INITIAL_FEN}:`)).toEqual(remoteResult(100)[1]);
  store.set(noLinesAtom(), {
    type: "completed-without-lines",
    searchedKey: `${INITIAL_FEN}:`,
  } as any);
  await broadcast(payload("generation-1"));
  expect(store.get(noLinesAtom())).toBeNull();
});

const terminalFailure = {
  tag: "engine-failure",
  category: "engine-failure",
  message: "Engine terminated",
  engineFailure: {
    kind: "process-exit",
    exitStatus: { code: 1, signal: null },
    reason: "CRITICAL ERROR: rejected command",
    entries: [{ type: "infoString", value: "Safe final line" }],
  },
};

test("analysis failure retains the operation-and-cleanup warning flag", async () => {
  fixtures.getBestMoves.mockRejectedValueOnce({
    ...terminalFailure,
    category: "operation-and-cleanup",
    message: "Engine failed. Temporary cleanup also failed",
  });
  await rerender();
  await act(async () => flush());
  expect(store.get(noLinesAtom())).toMatchObject({
    type: "failed",
    cleanupFailed: true,
    snapshot: terminalFailure.engineFailure,
  });
});

test("P2 the mounted listener delivers failure and Retry to the actual shared display owner", async () => {
  let displayed: ReturnType<typeof useDisplayedEngineLines> | undefined;
  function DisplayOwner() {
    displayed = useDisplayedEngineLines(engine, fixtures.fen, fixtures.moves);
    return null;
  }
  const result = deferred<null>();
  fixtures.getBestMoves.mockReturnValueOnce(result.promise);
  await act(async () =>
    root.render(
      <WorkspaceTabScope tabId="tab-1">
        <EvalListener />
        <DisplayOwner />
      </WorkspaceTabScope>,
    ),
  );
  await broadcast(payload("generation-1"));
  expect(displayed?.dimmed).toBe(false);
  await act(async () => {
    result.reject(terminalFailure);
    await flush();
  });
  expect(displayed?.failure?.snapshot?.reason).toBe("CRITICAL ERROR: rejected command");
  expect(displayed?.dimmed).toBe(true);
  expect(displayed?.loading).toBe(false);
  await broadcast(payload("generation-1"));
  expect(displayed?.failure).not.toBeNull();
  await act(async () => store.set(engineRetryFamily({ tab: "tab-1", engine: engine.id }), 1));
  expect(displayed?.failure).toBeNull();
  expect(fixtures.prepareEngineSearch).toHaveBeenCalledTimes(2);
});

test.each([false, true])(
  "P2 failure is sticky and rejects late lines, partial output %s",
  async (partial) => {
    const result = deferred<null>();
    fixtures.getBestMoves.mockReturnValueOnce(result.promise);
    await rerender();
    if (partial) await broadcast(payload("generation-1"));
    await act(async () => {
      result.reject(terminalFailure);
      await flush();
    });
    const terminal = store.get(noLinesAtom());
    expect(terminal).toMatchObject({
      type: "failed",
      searchedKey: `${INITIAL_FEN}:`,
      generation: "generation-1",
      snapshot: terminalFailure.engineFailure,
      retry: 0,
    });
    expect(terminal!.fingerprint).toContain(`"fen":"${INITIAL_FEN}"`);
    expect(terminal!.context).toBe((store.get(movesAtom()) as any).context);
    await broadcast(payload("generation-1", { progress: 99 }));
    expect(store.get(progressAtom())).toBe(0);
    expect(store.get(movesAtom()).size).toBe(partial ? 1 : 0);
    await rerender();
    await act(async () => {
      await store.set(enginesAtom, [{ ...engine }] as any);
    });
    expect(store.get(noLinesAtom())).toBe(terminal);
    expect(fixtures.getBestMoves).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTime(5000));
    expect(store.get(noLinesAtom())).toBe(terminal);
  },
);

test("P2 same-position Retry reserves a fresh generation via the serialized transition", async () => {
  const result = deferred<null>();
  fixtures.getBestMoves.mockReturnValueOnce(result.promise);
  fixtures.prepareEngineSearch
    .mockResolvedValueOnce("generation-1")
    .mockResolvedValueOnce("generation-retry");
  await rerender();
  await act(async () => {
    result.reject(terminalFailure);
    await flush();
  });
  const persisted = store.get(settingsAtom());
  await act(async () =>
    store.set(engineRetryFamily({ tab: "tab-1", engine: engine.id }), (n) => n + 1),
  );
  expect(store.get(settingsAtom())).toBe(persisted);
  expect(store.get(noLinesAtom())).toBeNull();
  expect(fixtures.stopEngine).toHaveBeenCalledWith(engine, "tab-1", "generation-1");
  expect(fixtures.prepareEngineSearch).toHaveBeenCalledTimes(2);
  expect(fixtures.getBestMoves.mock.calls[1][4]).toBe("generation-retry");
  await broadcast(payload("generation-1"));
  expect(store.get(movesAtom()).size).toBe(0);
  await broadcast(payload("generation-retry"));
  expect(store.get(movesAtom()).get(`${INITIAL_FEN}:`)).toBeDefined();
});

test.each(["unload", "remove", "dispose", "context"])(
  "P2 %s retires the failed terminal state",
  async (change) => {
    fixtures.getBestMoves.mockRejectedValueOnce(terminalFailure);
    await rerender();
    expect(store.get(noLinesAtom())?.type).toBe("failed");
    if (change === "unload")
      await act(async () => store.set(enginesAtom, [{ ...engine, loaded: false }] as any));
    if (change === "remove") await act(async () => store.set(enginesAtom, []));
    if (change === "dispose") await unmount();
    if (change === "context")
      await act(async () =>
        store.set(settingsAtom(), (s) => ({ ...s, go: { t: "Depth", c: 12 } })),
      );
    expect(store.get(noLinesAtom("tab-1"))).toBeNull();
  },
);

test("P2 equal-name and equal-path engines keep failures and other-tab state separate", async () => {
  const sibling = { ...engine, id: "engine-2" };
  const first = deferred<null>();
  fixtures.getBestMoves.mockImplementation((candidate) =>
    candidate.id === engine.id ? first.promise : new Promise(() => {}),
  );
  await act(async () => store.set(enginesAtom, [engine, sibling] as any));
  const neighbour = { type: "failed", searchedKey: "neighbour:" } as any;
  store.set(noLinesAtom("tab-2"), neighbour);
  await rerender();
  await act(async () => {
    first.reject(terminalFailure);
    await flush();
  });
  expect(store.get(noLinesAtom("tab-1"))?.type).toBe("failed");
  expect(store.get(noLinesAtom("tab-1", sibling.id))).toBeNull();
  expect(store.get(noLinesAtom("tab-2"))).toBe(neighbour);
  await broadcast(payload("generation-1", { engine: sibling.id }));
  expect(store.get(movesAtom("tab-1", sibling.id)).get(`${INITIAL_FEN}:`)).toBeDefined();
});

test("P2 an old rejection cannot replace its successor's terminal diagnostic", async () => {
  const old = deferred<null>();
  const current = deferred<null>();
  fixtures.getBestMoves.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
  await rerender();
  fixtures.fen = positionB;
  await rerender();
  await act(async () => {
    current.reject(terminalFailure);
    await flush();
  });
  const terminal = store.get(noLinesAtom());
  await act(async () => {
    old.reject({ ...terminalFailure, message: "obsolete" });
    await flush();
  });
  expect(store.get(noLinesAtom())).toBe(terminal);
  expect(fixtures.notifyUnlessCancelled).toHaveBeenCalledTimes(1);
});

test.each(["resolve", "empty", "reject"])(
  "unavailable threat stops the exact generation and suppresses late %s and events until recovery",
  async (outcome) => {
    const result = deferred<ReturnType<typeof remoteResult> | null>();
    fixtures.getBestMoves.mockReturnValueOnce(result.promise);
    store.set(threatFamily("tab-1"), true);
    await rerender();
    const search = analysisSearch(INITIAL_FEN, [], true);
    expect(fixtures.getBestMoves.mock.calls[0][3]).toMatchObject({
      fen: search.searchingFen,
      moves: [],
    });
    const oldPayload = payload("generation-1", { fen: search.searchingFen! });
    await broadcast(oldPayload);
    const remembered = store.get(movesAtom());
    expect(remembered.get(search.key!)).toEqual(oldPayload.bestLines);
    fixtures.moves = ["e2e4", "d7d5", "f1b5"];
    expect(analysisSearch(fixtures.fen, fixtures.moves, true).position?.isCheck()).toBe(true);
    await rerender();
    await settleTransition();
    expect(fixtures.stopEngine).toHaveBeenCalledExactlyOnceWith(engine, "tab-1", "generation-1");
    expect(fixtures.prepareEngineSearch).toHaveBeenCalledTimes(1);
    expect(fixtures.getBestMoves).toHaveBeenCalledTimes(1);
    await broadcast({ ...oldPayload, progress: 99 });
    await act(async () => {
      if (outcome === "resolve") result.resolve(remoteResult(99));
      else if (outcome === "empty") result.resolve(null);
      else result.reject(new Error("retired search failure"));
      await flush();
    });
    expect(store.get(movesAtom())).toEqual(remembered);
    expect(store.get(noLinesAtom())).toBeNull();
    expect(store.get(progressAtom())).toBe(0);
    expect(fixtures.setEngineScore).not.toHaveBeenCalled();
    expect(fixtures.notifyUnlessCancelled).not.toHaveBeenCalled();
    expect(store.get(settingsAtom()).enabled).toBe(true);
    expect(store.get(threatFamily("tab-1"))).toBe(true);
    await act(async () => store.set(threatFamily("tab-1"), false));
    expect(fixtures.getBestMoves).toHaveBeenCalledTimes(2);
    expect(fixtures.getBestMoves.mock.calls[1][3]).toMatchObject({
      fen: INITIAL_FEN,
      moves: fixtures.moves,
    });
    await act(async () => store.set(threatFamily("tab-1"), true));
    expect(fixtures.getBestMoves).toHaveBeenCalledTimes(2);
    fixtures.moves = [];
    fixtures.prepareEngineSearch.mockResolvedValueOnce("recovered");
    await rerender();
    expect(fixtures.getBestMoves).toHaveBeenCalledTimes(3);
    await broadcast(payload("recovered", { fen: search.searchingFen!, progress: 75 }));
    expect(store.get(progressAtom())).toBe(75);
  },
);

test.each(["local", "chessdb", "lichess"] as const)(
  "initially unavailable threat never dispatches or prepares %s analysis",
  async (type) => {
    fixtures.moves = ["e2e4", "d7d5", "f1b5"];
    store.set(threatFamily("tab-1"), true);
    store.set(enginesAtom, [type === "local" ? engine : { ...chessdbEngine, type }] as any);
    await rerender();
    await act(async () => vi.advanceTimersByTime(5000));
    expect(fixtures.prepareEngineSearch).not.toHaveBeenCalled();
    expect(fixtures.getBestMoves).not.toHaveBeenCalled();
    expect(fixtures.chessdbGetBestMoves).not.toHaveBeenCalled();
    expect(fixtures.lichessGetBestMoves).not.toHaveBeenCalled();
    expect(fixtures.setEngineScore).not.toHaveBeenCalled();
  },
);

test("unavailable threat rejects a late preparation failure without terminal publication or notification", async () => {
  store.set(threatFamily("tab-1"), true);
  const preparation = deferred<string>();
  fixtures.prepareEngineSearch.mockReturnValueOnce(preparation.promise);
  await rerender();
  fixtures.moves = ["e2e4", "d7d5", "f1b5"];
  await rerender();
  await act(async () => {
    preparation.reject(new Error("retired preparation failure"));
    await flush();
  });
  expect(fixtures.prepareEngineSearch).toHaveBeenCalledTimes(1);
  expect(fixtures.getBestMoves).not.toHaveBeenCalled();
  expect(fixtures.notifyUnlessCancelled).not.toHaveBeenCalled();
  expect(store.get(noLinesAtom())).toBeNull();
  expect(store.get(progressAtom())).toBe(0);
});

test("unavailable threat retires a late preparation and retains the actual warm owner for cleanup", async () => {
  store.set(threatFamily("tab-1"), true);
  await rerender();
  const preparation = deferred<string>();
  fixtures.prepareEngineSearch.mockReturnValueOnce(preparation.promise);
  fixtures.moves = ["e2e4"];
  await rerender();
  expect(fixtures.prepareEngineSearch).toHaveBeenCalledTimes(2);
  fixtures.moves = ["e2e4", "d7d5", "f1b5"];
  await rerender();
  await act(async () => {
    preparation.resolve("late-preparation");
    await flush();
  });
  await settleTransition();
  expect(fixtures.stopEngine).toHaveBeenCalledWith(engine, "tab-1", "generation-1");
  expect(fixtures.stopEngine).toHaveBeenCalledWith(engine, "tab-1", "late-preparation");
  expect(fixtures.prepareEngineSearch).toHaveBeenCalledTimes(2);
  expect(fixtures.getBestMoves).toHaveBeenCalledTimes(1);
  expect(store.get(noLinesAtom())).toBeNull();
  expect(store.get(progressAtom())).toBe(0);
  await unmount();
  expect(fixtures.releaseEngineSearch).toHaveBeenCalledWith(engine, "tab-1", "generation-1");
});

test.each(["chessdb", "lichess"] as const)(
  "unavailable threat starts no %s request and rejects a retired remote completion",
  async (type) => {
    const remote = { ...chessdbEngine, type };
    const getBestMoves =
      type === "chessdb" ? fixtures.chessdbGetBestMoves : fixtures.lichessGetBestMoves;
    const result = deferred<ReturnType<typeof remoteResult>>();
    getBestMoves.mockReturnValueOnce(result.promise);
    store.set(enginesAtom, [remote] as any);
    store.set(threatFamily("tab-1"), true);
    await rerender();
    fixtures.moves = ["e2e4", "d7d5", "f1b5"];
    await rerender();
    await act(async () => {
      result.resolve(remoteResult(99));
      await flush();
    });
    expect(getBestMoves).toHaveBeenCalledTimes(1);
    expect(fixtures.prepareEngineSearch).not.toHaveBeenCalled();
    expect(store.get(movesAtom("tab-1", remote.id)).size).toBe(0);
    expect(store.get(progressAtom("tab-1", remote.id))).toBe(0);
    expect(store.get(noLinesAtom("tab-1", remote.id))).toBeNull();
    expect(fixtures.setEngineScore).not.toHaveBeenCalled();
    expect(fixtures.notifyUnlessCancelled).not.toHaveBeenCalled();
    fixtures.moves = [];
    await rerender();
    expect(getBestMoves).toHaveBeenCalledTimes(2);
  },
);

test("a real stop failure on unavailable navigation still reports cleanup failure without starting another search", async () => {
  store.set(threatFamily("tab-1"), true);
  await rerender();
  const failure = new Error("native stop failed");
  fixtures.stopEngine.mockRejectedValueOnce(failure);
  fixtures.moves = ["e2e4", "d7d5", "f1b5"];
  await rerender();
  expect(fixtures.notifyUnlessCancelled).toHaveBeenCalledExactlyOnceWith("Common.Error", failure);
  expect(fixtures.prepareEngineSearch).toHaveBeenCalledTimes(1);
  expect(fixtures.getBestMoves).toHaveBeenCalledTimes(1);
  expect(store.get(noLinesAtom())).toBeNull();
});

function payload(generation: string, overrides: Partial<BestMovesPayload> = {}): BestMovesPayload {
  return {
    bestLines: [
      {
        score: { value: { type: "cp", value: 10 }, wdl: null },
        nodes: 1n,
        depth: 12,
        multipv: 1,
        nps: 1n,
        uciMoves: ["e2e4"],
        sanMoves: ["e4"],
      },
    ],
    engine: overrides.engine ?? "engine-1",
    tab: "tab-1",
    fen: overrides.fen ?? INITIAL_FEN,
    moves: overrides.moves ?? [],
    progress: overrides.progress ?? 50,
    generation,
  };
}

function remoteResult(progress: number): [number, BestMovesPayload["bestLines"]] {
  return [progress, payload("").bestLines];
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
