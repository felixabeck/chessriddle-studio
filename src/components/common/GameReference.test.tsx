import { Provider, createStore } from "jotai";
import { act, startTransition } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Token, NormalizedGame } from "@/bindings";
import { tabsAtom, recentFilesAtom, closingTabsAtom, closeWorkspaceTabAtom } from "@/state/atoms";
import { tabStorage } from "@/state/store/tabStorage";
import {
  closeTreeStore,
  createTreeStore,
  getCachedTreeStore,
  type TreeStore,
} from "@/state/store/tree";
import { EphemeralTabScope, WorkspaceTabScope } from "@/state/tabScope";
import { getTabTreeKey, replaceFileGame, type FileBackedTab } from "@/utils/tabs";
import { defaultTree } from "@/utils/treeReducer";
import {
  recognizeGameReferences,
  type ReferenceSearch,
  type lookupGameReference,
} from "@/utils/gameReferences";
import Comment from "./Comment";
import { GameReferenceProvider } from "./GameReference";
import GameNotation from "./GameNotation";
import { TreeStateContext } from "./TreeStateContext";

const mocks = vi.hoisted(() => ({
  lookup: vi.fn(),
  resolve: vi.fn(),
  lex: vi.fn(),
  getDbGame: vi.fn(),
  inferGameOrientation: vi.fn(),
  navigate: vi.fn(),
  notify: vi.fn(),
}));
vi.mock("@/utils/gameReferences", async (original) => ({
  ...(await original<typeof import("@/utils/gameReferences")>()),
  lookupGameReference: mocks.lookup,
}));
vi.mock("@/platform/tauri", () => ({
  tauri: {
    resolveLinkedGame: mocks.resolve,
    lexPgn: mocks.lex,
    getDbGame: mocks.getDbGame,
    inferGameOrientation: mocks.inferGameOrientation,
  },
  cancellationError: () => new Error("cancelled"),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mocks.navigate }));
vi.mock("@/components/files/notifyError", () => ({ notifyUnlessCancelled: mocks.notify }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("react-hotkeys-hook", () => ({ useHotkeys: vi.fn() }));
vi.mock("@/state/keybinds", async () => {
  const { atom } = await import("jotai");
  return { keyMapAtom: atom({ TOGGLE_BLUR: { keys: "ctrl+b" }, COPY_PGN: { keys: "ctrl+k" } }) };
});
vi.mock("./OpeningName", () => ({ default: () => null }));
vi.mock("./CompleteMoveCell", () => ({ default: () => null }));
vi.mock("./IconAction", () => ({ default: () => null }));
vi.mock("@tanstack/react-virtual", async (original) => ({
  ...(await original<typeof import("@tanstack/react-virtual")>()),
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 32,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ index, start: index * 32 })),
    measureElement: () => undefined,
    getOffsetForIndex: () => undefined,
    scrollToOffset: () => undefined,
    scrollOffset: 0,
  }),
}));
vi.mock("@mantine/core", () => {
  const element = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;
  return {
    Typography: element,
    Box: element,
    Divider: element,
    Group: element,
    Overlay: element,
    ScrollArea: ({ children, viewportRef }: any) => <div ref={viewportRef}>{children}</div>,
    useComputedColorScheme: () => "light",
    Alert: ({ title, children }: any) => (
      <div>
        {title}
        {children}
      </div>
    ),
    Text: element,
    Stack: element,
    Paper: element,
    Loader: () => <span>Loading</span>,
    Modal: ({ children, opened, onClose, closeButtonProps }: any) =>
      opened ? (
        <div role="dialog">
          <button {...closeButtonProps} onClick={onClose}>
            Close
          </button>
          {children}
        </div>
      ) : null,
    Button: ({ children, onClick, disabled }: any) => (
      <button disabled={disabled} onClick={onClick}>
        {children}
      </button>
    ),
  };
});

const label =
  "0-1 Beerdsen,T (2520)-Bluebaum,M (2651) Elllobregat op 3rd Sant Boi de Llobregat 2022 (3)";
const database = { id: { id: "source" }, kind: "database" as const };
const game: NormalizedGame = {
  stamp: "b".repeat(64),
  id: 8,
  white: "Beerdsen, Thomas",
  black: "Bluebaum, Matthias",
  white_id: 1,
  black_id: 2,
  white_elo: 2520,
  black_elo: 2651,
  event: "Elllobregat op 3rd",
  event_id: 1,
  site: "Sant Boi de Llobregat",
  site_id: 1,
  result: "0-1",
  date: "2022.12.01",
  round: "3",
  time: "12:00:00",
  time_control: "600",
  eco: "B12",
  fen: "8/8/8/8/8/8/6k1/K7 b - - 12 23",
  moves: "23... Kf3 0-1",
};
const found = (): ReferenceSearch => ({
  complete: true,
  failures: [],
  candidates: [{ source: "Local games", database, game, verification: "verified" }],
});
let root: Root;
let host: HTMLDivElement;
let workspace: ReturnType<typeof createStore>;
let owner: TreeStore;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  sessionStorage.clear();
  localStorage.clear();
  workspace = createStore();
  workspace.set(tabsAtom, []);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  owner = createTreeStore();
  mocks.lookup.mockResolvedValue(found());
  mocks.getDbGame.mockReset().mockImplementation(async (_database, gameId: number) => {
    const result: ReferenceSearch = await mocks.lookup.mock.results.at(-1)?.value;
    const current = result.candidates.find((candidate) => candidate.game.id === gameId)?.game;
    return current ? { kind: "found", game: current } : { kind: "missing" };
  });
  mocks.inferGameOrientation.mockReset().mockResolvedValue(null);
  mocks.resolve.mockResolvedValue(null);
  mocks.lex.mockResolvedValue([
    { type: "San", value: "Kf3" },
    { type: "Outcome", value: "0-1" },
  ] satisfies Token[]);
});
afterEach(async () => {
  await act(async () => root.unmount());
  for (const tab of workspace.get(tabsAtom)) closeTreeStore(tab.value);
  owner.dispose();
  host.remove();
  vi.unstubAllGlobals();
});
async function render(nextOwner = owner, comment = label) {
  await act(async () =>
    root.render(
      <Provider store={workspace}>
        <TreeStateContext.Provider value={nextOwner}>
          <EphemeralTabScope>
            <GameReferenceProvider>
              <Comment comment={comment} />
              <Comment comment="0-1 Srinath,R-Deac,B" />
            </GameReferenceProvider>
          </EphemeralTabScope>
        </TreeStateContext.Provider>
      </Provider>,
    ),
  );
}
async function click(selector = "[data-game-reference]") {
  await act(async () => host.querySelector<HTMLButtonElement>(selector)!.click());
}
async function button(text: string) {
  await act(async () =>
    [...host.querySelectorAll("button")].find((node) => node.textContent === text)!.click(),
  );
}
function tree() {
  return tabStorage.read<any>(workspace.get(tabsAtom)[0].value)!.state;
}

async function useRealLookup(candidate: NormalizedGame) {
  const api: NonNullable<Parameters<typeof lookupGameReference>[2]> = {
    getDatabases: async () => ({
      root: { id: { id: "root" }, kind: "databaseRoot" },
      unread: [],
      databases: [
        {
          type: "success",
          file: database,
          filename: "local.db3",
          title: "Local games",
          description: "",
          indexed: false,
          game_count: 1,
          player_count: 2,
          event_count: 1,
          storage_size: "4096",
        },
      ],
    }),
    query_players: async () => ({
      data: [
        {
          id: candidate.white_id,
          name: candidate.white,
          elo: candidate.white_elo ?? null,
          game_count: 1,
        },
        {
          id: candidate.black_id,
          name: candidate.black,
          elo: candidate.black_elo ?? null,
          game_count: 1,
        },
      ],
      count: 2,
    }),
    query_games: async (_database, query) => {
      const inBounds =
        (!query.start_date || (candidate.date != null && candidate.date >= query.start_date)) &&
        (!query.end_date || (candidate.date != null && candidate.date <= query.end_date));
      return { data: inBounds ? [candidate] : [], count: inBounds ? 1 : 0 };
    },
  };
  const actual =
    await vi.importActual<typeof import("@/utils/gameReferences")>("@/utils/gameReferences");
  mocks.lookup.mockImplementation((reference, signal) =>
    actual.lookupGameReference(reference, signal, api),
  );
}

test.each(["????.??.??", "2023.01.01"])(
  "actual lookup and admission retain an event-year game with Date %s",
  async (date) => {
    const candidate = { ...game, event: "BEL-NED 2017", site: "ICCF", date };
    await useRealLookup(candidate);
    await render(owner, "0-1 Beerdsen,T (2520)-Bluebaum,M (2651) BEL-NED 2017 ICCF");
    await click();
    expect(workspace.get(tabsAtom)).toHaveLength(1);
    expect(tree().headers).toMatchObject({ event: "BEL-NED 2017", site: "ICCF", date });
    expect(tree().root.children[0].san).toBe("Kf3");
  },
);

test("one unverified occurrence from an exhaustive real lookup requires explicit admission", async () => {
  await useRealLookup(game);
  await render(
    owner,
    "0-1 Beerdsen,T (2520)-Bluebaum,M (2651) Elllobregat op 3rd Sant Boi de Llobregat unclear context 2022 (3)",
  );
  await click();
  const result = await mocks.lookup.mock.results[0].value;
  expect(result).toMatchObject({
    complete: true,
    failures: [],
    candidates: [{ verification: "unverified" }],
  });
  expect(workspace.get(tabsAtom)).toHaveLength(0);
  expect(mocks.resolve).not.toHaveBeenCalled();
  expect(host.textContent).toContain("GameReferences.Choose");
  await button("Common.OpenGame");
  expect(workspace.get(tabsAtom)).toHaveLength(1);
  expect(tree().root.children[0].san).toBe("Kf3");
  expect(tree().headers).toMatchObject({
    white: game.white,
    black: game.black,
    event: game.event,
    date: game.date,
  });
});

test.each([
  "White was better.",
  "Elllobregat op 3rd White was better.",
  "White was better before 2020.",
  "Elllobregat op 3rd White was better before 2020.",
  "Elllobregat op 3rd Sant Boi de Llobregat White was better before 2020.",
])("open tail requires explicit admission after real lookup: %s", async (context) => {
  await useRealLookup(game);
  const citation = `0-1 Beerdsen,T-Bluebaum,M ${context}`;
  await render(owner, citation);
  expect(host.textContent).toContain(citation);
  expect(host.querySelector("[data-game-reference]")?.textContent).toBe(
    "0-1 Beerdsen,T-Bluebaum,M",
  );
  await click();
  const result: ReferenceSearch = await mocks.lookup.mock.results[0].value;
  expect(result).toMatchObject({ complete: true, failures: [] });
  expect(result.candidates).toEqual([
    { database, source: "Local games (local.db3)", game, verification: "unverified" },
  ]);
  expect(workspace.get(tabsAtom)).toHaveLength(0);
  expect(host.textContent).toContain("GameReferences.Choose");
  await button("Common.OpenGame");
  expect(workspace.get(tabsAtom)).toHaveLength(1);
  expect(workspace.get(tabsAtom)[0].gameOrigin).toEqual({
    kind: "database",
    database,
    gameId: 8,
  });
  expect(tree().root.fen).toBe(game.fen);
  expect(tree().root.children[0]).toMatchObject({ san: "Kf3", halfMoves: 46 });
  expect(tree().headers).toMatchObject({
    white: game.white,
    black: game.black,
    event: game.event,
    site: game.site,
    date: game.date,
    result: game.result,
  });
});

test("a complete names-only citation retains automatic admission", async () => {
  await useRealLookup(game);
  await render(owner, "0-1 Beerdsen,T-Bluebaum,M");
  await click();
  expect(workspace.get(tabsAtom)).toHaveLength(1);
  expect(tree().root.children[0].san).toBe("Kf3");
});

test("a complete unique lookup opens replayable moves, the real FEN, every header and database origin", async () => {
  await render();
  await click();
  expect(workspace.get(recentFilesAtom)).toEqual([
    expect.objectContaining({ kind: "database", database, gameId: 8 }),
  ]);
  expect(workspace.get(recentFilesAtom)[0]).not.toHaveProperty("databaseTitle");
  expect(mocks.lookup).toHaveBeenCalledWith(
    recognizeGameReferences(label)[0],
    expect.any(AbortSignal),
  );
  expect(workspace.get(tabsAtom)).toHaveLength(1);
  expect(workspace.get(tabsAtom)[0].gameOrigin).toEqual({ kind: "database", database, gameId: 8 });
  expect(tree().root.fen).toBe(game.fen);
  expect(tree().root.children[0]).toMatchObject({ san: "Kf3", halfMoves: 46 });
  expect(tree().headers).toEqual({
    id: game.id,
    white: game.white,
    black: game.black,
    white_elo: game.white_elo,
    black_elo: game.black_elo,
    event: game.event,
    site: game.site,
    result: game.result,
    date: game.date,
    round: game.round,
    time: "12:00:00",
    time_control: "600",
    eco: "B12",
    fen: game.fen,
  });
  expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith({ to: "/" });
});

test("ambiguity offers actual source metadata and requires explicit selection", async () => {
  const result = found();
  result.candidates.push({
    ...result.candidates[0],
    source: "Second source",
    game: { ...game, id: 9 },
  });
  mocks.lookup.mockResolvedValue(result);
  await render();
  await click();
  expect(workspace.get(tabsAtom)).toHaveLength(0);
  expect(host.textContent).toContain("2022.12.01");
  expect(host.textContent).toContain("Second source");
  const opens = [...host.querySelectorAll("button")].filter((node) =>
    node.textContent?.includes("Common.OpenGame"),
  );
  await act(async () => opens[1].click());
  expect(workspace.get(tabsAtom)[0].gameOrigin).toEqual({ kind: "database", database, gameId: 9 });
});

test("incomplete search keeps candidates and source-qualified safe permission guidance", async () => {
  mocks.lookup.mockResolvedValue({
    ...found(),
    complete: false,
    failures: [{ source: "Restricted database", category: "permission" }],
  });
  await render();
  await click();
  expect(workspace.get(tabsAtom)).toHaveLength(0);
  expect(host.textContent).toContain("GameReferences.Incomplete");
  expect(host.textContent).toContain("Restricted database: Databases.LoadError.Permission");
  expect(host.querySelector('[role="dialog"] button')?.getAttribute("aria-label")).toBe(
    "Common.Close",
  );
});

test("zero results distinguish missing games from failed sources and explicit retry is a fresh read", async () => {
  mocks.lookup
    .mockResolvedValueOnce({
      complete: false,
      candidates: [],
      failures: [{ source: "Missing source", category: "not-found" }],
    })
    .mockResolvedValueOnce({ complete: true, candidates: [], failures: [] });
  await render();
  await click();
  expect(host.textContent).toContain("Missing source: Databases.LoadError.Missing");
  expect(host.textContent).toContain("GameReferences.Prerequisite");
  await button("GameReferences.Retry");
  expect(mocks.lookup).toHaveBeenCalledTimes(2);
  expect(mocks.lookup.mock.calls[0][1].aborted).toBe(true);
  expect(mocks.lookup.mock.calls[1][1]).not.toBe(mocks.lookup.mock.calls[0][1]);
  expect(host.textContent).toContain("GameReferences.Missing");
});

test("typed stale-source failures retain actionable unavailable-index guidance", async () => {
  mocks.lookup.mockResolvedValue({
    complete: false,
    candidates: [],
    failures: [
      { source: "Linked collection", category: "validation", backendCategory: "stale-game" },
    ],
  });
  await render();
  await click();
  expect(host.textContent).toContain("Linked collection: Collections.Unavailable");
  expect(host.textContent).toContain("GameReferences.Prerequisite");
  expect(workspace.get(tabsAtom)).toHaveLength(0);
});

test.each(["close", "replace", "retire", "unmount"])(
  "%s cancels owned lookup and suppresses late automatic opening",
  async (action) => {
    let settle!: (value: ReferenceSearch) => void;
    mocks.lookup
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            settle = resolve;
          }),
      )
      .mockResolvedValue({ complete: true, candidates: [], failures: [] });
    await render();
    await click();
    const signal = mocks.lookup.mock.calls[0][1];
    expect(host.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    if (action === "close") await button("Close");
    if (action === "replace") await click("[data-game-reference]:nth-child(1)");
    if (action === "retire") await render(createTreeStore());
    if (action === "unmount") await act(async () => root.render(null));
    expect(signal.aborted).toBe(true);
    await act(async () => settle(found()));
    expect(workspace.get(tabsAtom)).toHaveLength(0);
    expect(mocks.resolve).not.toHaveBeenCalled();
  },
);

async function pendingNotation() {
  const source: FileBackedTab = {
    value: crypto.randomUUID(),
    name: "Preparation",
    type: "analysis",
    gameOrigin: {
      kind: "file",
      gameNumber: 0,
      file: {
        type: "file",
        handle: { kind: "fileWorkspace", id: { id: "preparation" } },
        name: "preparation.pgn",
        numGames: 2,
        metadata: { type: "game", tags: [] },
        lastModified: 1,
      },
    },
  };
  const initial = defaultTree();
  initial.root.comment = label;
  tabStorage.seed(source.value, initial);
  workspace.set(tabsAtom, [source]);
  const sourceStore = createTreeStore(source.value);
  let settle!: (result: ReferenceSearch) => void;
  mocks.lookup.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        settle = resolve;
      }),
  );
  await act(async () =>
    root.render(
      <Provider store={workspace}>
        <WorkspaceTabScope tabId={source.value}>
          <TreeStateContext.Provider value={sourceStore}>
            <GameNotation />
          </TreeStateContext.Provider>
        </WorkspaceTabScope>
      </Provider>,
    ),
  );
  await click();
  const signal: AbortSignal = mocks.lookup.mock.calls[0][1];
  expect(host.querySelector('[role="dialog"]')).not.toBeNull();
  return { source, sourceStore, settle, signal };
}

test("real notation score updates preserve a pending citation search and its correct admission", async () => {
  const { source, sourceStore, settle, signal } = await pendingNotation();
  const previousRoot = sourceStore.getState().root;
  await act(async () =>
    sourceStore.getState().setScore({ value: { type: "cp", value: 45 }, wdl: null }),
  );
  expect(sourceStore.getState().root).not.toBe(previousRoot);
  expect(getCachedTreeStore(source.value)).toBe(sourceStore);
  expect(signal.aborted).toBe(false);
  expect(host.querySelector('[role="dialog"]')).not.toBeNull();
  expect(mocks.lookup).toHaveBeenCalledTimes(1);
  await act(async () => settle(found()));
  expect(workspace.get(tabsAtom)).toHaveLength(2);
  const target = workspace.get(tabsAtom)[1];
  expect(target.gameOrigin).toEqual({ kind: "database", database, gameId: game.id });
  expect(tabStorage.read<any>(getTabTreeKey(target))!.state.root.children[0].san).toBe("Kf3");
});

test("real same-file replacement changes the physical owner and cancels late lookup", async () => {
  const { source, sourceStore, settle, signal } = await pendingNotation();
  await act(async () => {
    const result = replaceFileGame({
      store: workspace,
      owner: source,
      treeStore: sourceStore,
      snapshot: sourceStore.getState(),
      tree: { ...defaultTree(), root: sourceStore.getState().root },
      page: 1,
      isCurrent: () => true,
    });
    expect(result.kind).toBe("committed");
  });
  expect(getCachedTreeStore(source.value)).toBe(sourceStore);
  expect(getTabTreeKey(workspace.get(tabsAtom)[0])).not.toBe(getTabTreeKey(source));
  expect(signal.aborted).toBe(true);
  expect(host.querySelector('[role="dialog"]')).toBeNull();
  await act(async () => settle(found()));
  expect(workspace.get(tabsAtom)).toHaveLength(1);
  expect(mocks.lex).not.toHaveBeenCalled();
});

test("real notation suppresses publication and automatic admission during pending close with its owner intact", async () => {
  const { source, sourceStore, settle, signal } = await pendingNotation();
  const liveOwner = workspace.get(tabsAtom)[0];
  await act(async () => {
    workspace.set(closingTabsAtom, (previous) => new Set(previous).add(source.value));
    expect(workspace.get(tabsAtom)).toEqual([liveOwner]);
    expect(getCachedTreeStore(source.value)).toBe(sourceStore);
    expect(signal.aborted).toBe(false);
    settle(found());
    for (let tick = 0; tick < 5; tick++) await Promise.resolve();
    // The pending-close marker must suppress admission before any React cleanup.
    expect(signal.aborted).toBe(false);
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.lex).not.toHaveBeenCalled();
  });
  expect(workspace.get(closingTabsAtom).has(source.value)).toBe(true);
  expect(workspace.get(tabsAtom)).toEqual([liveOwner]);
  expect(workspace.get(tabsAtom)[0]).toBe(liveOwner);
  expect(getCachedTreeStore(source.value)).toBe(sourceStore);
  expect(signal.aborted).toBe(false);
  expect(host.textContent).toContain("GameReferences.Searching");
  expect(host.textContent).not.toContain("GameReferences.Choose");
  expect(host.textContent).not.toContain(game.white);
  expect(mocks.navigate).not.toHaveBeenCalled();
});

test.each(["replace", "close", "retire-cache"])(
  "real notation suppresses a stale result before React cleanup after %s",
  async (action) => {
    const { source, sourceStore, settle, signal } = await pendingNotation();
    let replacementResult: ReturnType<typeof replaceFileGame> | undefined;
    await act(async () => {
      if (action === "replace") {
        startTransition(() => {
          replacementResult = replaceFileGame({
            store: workspace,
            owner: source,
            treeStore: sourceStore,
            snapshot: sourceStore.getState(),
            tree: sourceStore.getState(),
            page: 1,
            isCurrent: () => true,
          });
        });
      } else if (action === "close") {
        workspace.set(closeWorkspaceTabAtom, source.value);
        closeTreeStore(source.value);
      } else {
        closeTreeStore(source.value);
      }
      expect(replacementResult?.kind).toBe(action === "replace" ? "committed" : undefined);
      // React has not committed its cleanup yet. The result guard must read live owners.
      expect(signal.aborted).toBe(false);
      settle(found());
      for (let tick = 0; tick < 5; tick++) await Promise.resolve();
      expect(signal.aborted).toBe(false);
      expect(mocks.lex).not.toHaveBeenCalled();
    });
    expect(workspace.get(tabsAtom).every((tab) => tab.gameOrigin.kind !== "database")).toBe(true);
  },
);

test("linked admission loads the original annotated PGN and qualified occurrence", async () => {
  const locator = {
    collection: "22222222-2222-4222-8222-222222222222",
    generation: "generation",
    ordinal: 4,
    stamp: "a".repeat(64),
  };
  const file = { id: { id: "original-file" }, kind: "fileWorkspace" as const };
  const result = found();
  result.candidates[0].game = { ...game, linked: locator };
  mocks.lookup.mockResolvedValue(result);
  const original =
    '[White "Beerdsen, Thomas"]\n[Black "Bluebaum, Matthias"]\n[Custom "preserved"]\n\n1. e4 $1 {original annotation} (1. d4 d5) e5 0-1';
  mocks.resolve.mockResolvedValue({
    file,
    locator,
    name: "Original",
    ordinal: 4,
    numGames: 5,
    purpose: "game",
    game: { pgn: original, stamp: locator.stamp, revision: "generation", present: true },
  });
  mocks.lex.mockResolvedValue([
    { type: "Header", value: { tag: "Custom", value: "preserved" } },
    { type: "San", value: "e4" },
    { type: "Nag", value: "$1" },
    { type: "Comment", value: "original annotation" },
    { type: "ParenOpen" },
    { type: "San", value: "d4" },
    { type: "San", value: "d5" },
    { type: "ParenClose" },
    { type: "San", value: "e5" },
    { type: "Outcome", value: "0-1" },
  ]);
  await render();
  await click();
  expect(mocks.resolve).toHaveBeenCalledExactlyOnceWith(database, 8, locator);
  expect(mocks.lex).toHaveBeenCalledWith(original, undefined);
  expect(mocks.notify).not.toHaveBeenCalled();
  expect(workspace.get(tabsAtom)[0].gameOrigin).toMatchObject({
    kind: "file",
    gameNumber: 4,
    file: { handle: file },
  });
  expect(tree()).toMatchObject({
    sourceStamp: locator.stamp,
    linkedSource: locator,
    headers: { other: { Custom: "preserved" } },
  });
  expect(tree().root.children).toHaveLength(2);
  expect(tree().root.children[0]).toMatchObject({
    san: "e4",
    comment: "original annotation",
    nags: [1],
  });
  expect(tree().root.children[1].children[0].san).toBe("d5");
});

test("stale linked source reports the existing error and never falls back to another ordinal", async () => {
  mocks.resolve.mockRejectedValueOnce(new Error("stale linked game"));
  await render();
  await click();
  expect(workspace.get(tabsAtom)).toHaveLength(0);
  expect(mocks.notify).toHaveBeenCalledWith("Common.Error", expect.any(Error));
  expect(mocks.lex).not.toHaveBeenCalled();
  expect(mocks.navigate).not.toHaveBeenCalled();
});

test("refused workspace admission retains the source and never navigates", async () => {
  const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("Quota exceeded", "QuotaExceededError");
  });
  try {
    await render();
    await click();
    expect(workspace.get(tabsAtom)).toHaveLength(0);
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(host.querySelector("[data-game-reference]")?.textContent).toBe(label);
  } finally {
    write.mockRestore();
  }
});

test("duplicate open activation is locked while admitted creation is pending and may finish after close", async () => {
  let finish!: (value: null) => void;
  mocks.resolve.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await render();
  await click();
  await button("Close");
  await click();
  expect(mocks.resolve).toHaveBeenCalledTimes(1);
  await act(async () => finish(null));
  expect(workspace.get(tabsAtom)).toHaveLength(1);
});
