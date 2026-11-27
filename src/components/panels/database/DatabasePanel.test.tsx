import { WorkspaceTabScope } from "@/state/tabScope";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cancellationError } from "@/platform/tauri";
import { MantineProvider } from "@mantine/core";
import { Provider as JotaiProvider, createStore as createJotaiStore } from "jotai";
import { SWRConfig, useSWRConfig, type ScopedMutator, type SWRConfiguration } from "swr";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import { createTreeStore, type TreeStore } from "@/state/store/tree";
import {
  comparisonDbAtom,
  dbTypeFamily,
  DEFAULT_EXPLORER_STATS_HEIGHT_REM,
  DEFAULT_LICHESS_OPTIONS,
  DEFAULT_MASTER_OPTIONS,
  EXPLORER_DIVIDER_HEIGHT_PX,
  EXPLORER_GAMES_COLLAPSED_KEY,
  EXPLORER_STATS_HEIGHT_KEY,
  explorerGamesSourceFamily,
  explorerSortFamily,
  explorerStatsSplitRange,
  MIN_EXPLORER_GAMES_HEIGHT_REM,
  MIN_EXPLORER_STATS_HEIGHT_REM,
  sessionsAtom,
  tabsAtom,
  activeTabAtom,
  explorerDatabaseFiltersAtom,
  lichessOptionsAtom,
  localOptionsFamily,
  masterOptionsAtom,
  pinnedExplorerComparisonFamily,
  pinnedExplorerDatabaseFamily,
  pinnedExplorerFurtherColumnsFamily,
  referenceDbAtom,
} from "@/state/atoms";
import { explorerFiltersFor } from "@/state/explorerFilters";
import type { DatabaseHandle } from "@/bindings";
import { databaseHandleKey, type DatabaseList, type ManagedDatabaseInfo } from "@/utils/db";
import { DATABASE_LIST_KEY } from "@/hooks/useDatabaseList";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { installInlineComputedStyleStub } from "@/tests/computedStyle";
import { catalogueI18n, shippedCatalogues } from "@/tests/catalogues";
import type { SupportedLocale } from "@/i18n";
import { formatNumber } from "@/utils/format";
import { getLichessGames, getMasterGames, type PositionData } from "@/utils/lichess/api";
import { savePublicSessions } from "@/utils/session";

const mocks = vi.hoisted(() => ({
  logError: vi.fn(),
  getLichessGames: vi.fn(),
  getMasterGames: vi.fn(),
  getPublicLichessJson: vi.fn(),
  lexPgn: vi.fn(),
  getDatabases: vi.fn(),
  searchPosition: vi.fn(),
  collectionForDatabase: vi.fn(),
  clearGames: vi.fn(),
  getPlayer: vi.fn(),
  openDatabaseGame: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      [
        key,
        ...Object.entries(options ?? {})
          .filter(([name]) => name !== "defaultValue")
          .map(([, value]) => value),
      ].join(" "),
  }),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a {...props}>{children}</a>
  ),
  useRouter: () => ({}),
  useNavigate: () => vi.fn(),
}));

vi.mock("@/platform/native", () => ({
  error: mocks.logError,
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
}));

vi.mock("@/utils/lichess/api", async () => {
  const actual = await vi.importActual<typeof import("@/utils/lichess/api")>("@/utils/lichess/api");
  return {
    ...actual,
    getLichessGames: mocks.getLichessGames,
    getMasterGames: mocks.getMasterGames,
  };
});

vi.mock("@/utils/db", async () => {
  const actual = await vi.importActual<typeof import("@/utils/db")>("@/utils/db");
  return { ...actual, getDatabases: mocks.getDatabases };
});

vi.mock("@/platform/tauri", async () => {
  const actual = await vi.importActual<typeof import("@/platform/tauri")>("@/platform/tauri");
  return {
    ...actual,
    tauri: {
      ...actual.tauri,
      getPublicLichessJson: mocks.getPublicLichessJson,
      lexPgn: mocks.lexPgn,
      searchPosition: mocks.searchPosition,
      collectionForDatabase: mocks.collectionForDatabase,
      clearGames: mocks.clearGames,
      getPlayer: mocks.getPlayer,
    },
  };
});

vi.mock("@/utils/databaseGame", () => ({ openDatabaseGame: mocks.openDatabaseGame }));
vi.mock("@/chessground/Chessground", () => ({ Chessground: () => null }));
vi.mock("@/components/boards/PiecesGrid", () => ({ default: () => null }));
vi.mock("@/utils/sound", () => ({ playSound: vi.fn() }));

import PanelArea, { PanelAreaChromeContext } from "@/components/boards/PanelArea";
import DatabasePanel from "./DatabasePanel";
import { fetchOnlineOpening } from "./useOnlineExplorer";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = MockResizeObserver;

// DataTable checks an empty media query for columns without a visibility restriction.
installMatchMediaStub({ matches: (query) => query === "" });
installInlineComputedStyleStub();

describe("explorer game failure catalogues", () => {
  const templates = {
    "Board.Database.GamesIncomplete": "Could not load these games: {{games}}",
    "Board.Database.GamesFailed": "Could not load games: {{games}}",
  };

  test.each(shippedCatalogues())(
    "$locale translates both messages without fallback",
    async ({ locale, translation }) => {
      const instance = await catalogueI18n(locale as SupportedLocale);
      const games = "W0 - B0, W1 - B1";
      const keys = Object.keys(templates) as (keyof typeof templates)[];
      for (const key of keys) {
        const template = translation[key];
        expect(typeof template).toBe("string");
        expect(template.trim()).not.toBe("");
        expect(template).toContain("{{games}}");
        expect(instance.t(key, { games })).toBe(template.replace("{{games}}", games));
        expect(template === templates[key]).toBe(locale.startsWith("en-"));
      }
      expect(translation[keys[0]]).not.toBe(translation[keys[1]]);
      const explorerKey = "Board.Database.ExplorerLoadError";
      expect(translation[explorerKey].trim()).not.toBe("");
      expect(instance.t(explorerKey)).toBe(translation[explorerKey]);
      expect(
        translation[explorerKey] === "Could not load the opening explorer. Please try again.",
      ).toBe(locale.startsWith("en-"));
    },
  );
});

const HEADER_COLLAPSED_KEY = "explorer-header-collapsed";

const afterE4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";

describe("DatabasePanel", () => {
  let container: HTMLDivElement;
  let root: Root;
  let treeStore: TreeStore;
  const originalScroll = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");

  beforeEach(() => {
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    sessionStorage.clear();
    localStorage.clear();
    savePublicSessions([]);
    // These tests operate the header's controls; the collapsed header has its own tests.
    localStorage.setItem(HEADER_COLLAPSED_KEY, "false");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    treeStore = createTreeStore();
    mocks.logError.mockReset().mockResolvedValue(undefined);
    mocks.getLichessGames.mockReset();
    mocks.getMasterGames.mockReset();
    mocks.getPublicLichessJson.mockReset();
    mocks.lexPgn.mockReset();
    mocks.getDatabases.mockReset().mockResolvedValue({
      databases: [],
      unread: [],
      workspaceFilenames: [],
      root: { id: { id: "database-root" }, kind: "databaseRoot" },
    });
    mocks.searchPosition.mockReset().mockResolvedValue([[], []]);
    mocks.collectionForDatabase.mockReset().mockResolvedValue(null);
    mocks.clearGames.mockReset().mockResolvedValue(undefined);
    mocks.openDatabaseGame.mockReset().mockResolvedValue("opened-tab");
    mocks.getPlayer.mockReset().mockImplementation(async (file: DatabaseHandle, id: number) => ({
      id,
      name: `${file.id.id} player`,
      elo: 2000,
      game_count: 3,
    }));
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    container?.remove();
    if (originalScroll) Object.defineProperty(Element.prototype, "scrollIntoView", originalScroll);
    else Reflect.deleteProperty(Element.prototype, "scrollIntoView");
  });

  const mockExplorerData = {
    white: 100,
    black: 80,
    draws: 20,
    moves: [{ uci: "e2e4", san: "e4", averageRating: 2000, white: 50, black: 40, draws: 10 }],
    topGames: [
      {
        id: "g0",
        white: { name: "W0", rating: 2200 },
        black: { name: "B0", rating: 2200 },
        year: 2024,
        month: "01",
      },
      {
        id: "g1",
        white: { name: "W1", rating: 2300 },
        black: { name: "B1", rating: 2300 },
        year: 2024,
        month: "02",
      },
    ],
  };

  const topGame: NonNullable<PositionData["topGames"]>[number] = {
    ...mockExplorerData.topGames[0],
    uci: "e2e4",
    winner: null,
    speed: "blitz",
    mode: "rated",
  };
  const recentGame = {
    ...topGame,
    id: "r1",
    white: { name: "RecentWhite", rating: 2100 },
    black: { name: "RecentBlack", rating: 2100 },
  };

  test.each([
    {
      scenario: "top games precede recent games",
      topGames: [topGame],
      recentGames: [recentGame],
      expectedGames: [topGame, recentGame],
    },
    {
      scenario: "recent games survive an empty top games list",
      topGames: [],
      recentGames: [recentGame],
      expectedGames: [recentGame],
    },
    {
      scenario: "duplicate game ids appear once with the first occurrence retained",
      topGames: [topGame],
      recentGames: [
        recentGame,
        {
          ...topGame,
          white: { name: "DupTopWhite", rating: 1 },
          black: { name: "DupTopBlack", rating: 1 },
        },
        {
          ...recentGame,
          white: { name: "DupRecentWhite", rating: 1 },
          black: { name: "DupRecentBlack", rating: 1 },
        },
      ],
      expectedGames: [topGame, recentGame],
    },
  ])("lch_all: $scenario", async ({ topGames, recentGames, expectedGames }) => {
    const data: PositionData = { ...mockExplorerData, topGames, recentGames };
    mocks.getLichessGames.mockResolvedValue(data);
    mocks.getPublicLichessJson.mockImplementation(async ({ game_id }: { game_id: string }) => {
      const game = expectedGames.find((game) => game.id === game_id)!;
      return `[White "${game.white.name}"]\n[Black "${game.black.name}"]\n\n1. e4 e5 *`;
    });
    mocks.lexPgn.mockImplementation(async (pgn: string) =>
      [...pgn.matchAll(/\[(White|Black) "([^"]*)"\]/g)].map(([, tag, value]) => ({
        type: "Header",
        value: { tag, value },
      })),
    );

    const result = await fetchOnlineOpening(
      getLichessGames,
      "startpos",
      { color: "white" },
      "token-1",
    );

    expect(result.games.map(({ id, white, black }) => ({ id, white, black }))).toEqual(
      expectedGames.map((game, id) => ({ id, white: game.white.name, black: game.black.name })),
    );
    expect(mocks.getPublicLichessJson.mock.calls.map(([query]) => query.game_id)).toEqual(
      expectedGames.map((game) => game.id),
    );
    expect(result.gameFailures).toEqual([]);
  });

  test("lch_all: checkpoint 1 stops after explorer fetch before normalization when signal is aborted", async () => {
    const controller = new AbortController();
    mocks.getLichessGames.mockImplementation(async () => {
      controller.abort();
      return mockExplorerData;
    });

    const promise = fetchOnlineOpening(
      getLichessGames,
      "startpos",
      {} as any,
      "token-1",
      controller.signal,
    );

    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.getPublicLichessJson).not.toHaveBeenCalled();
    expect(mocks.lexPgn).not.toHaveBeenCalled();
    expect(mocks.logError).not.toHaveBeenCalled();
  });

  test("lch_all: cancellation during lexing rejects without diagnostic and publishes no partial results", async () => {
    const controller = new AbortController();
    mocks.getLichessGames.mockResolvedValue(mockExplorerData);
    mocks.getPublicLichessJson.mockResolvedValue(`[White "W"]\n[Black "B"]\n\n1. e4 e5 *`);

    mocks.lexPgn.mockImplementation(async () => {
      controller.abort();
      throw cancellationError();
    });

    const promise = fetchOnlineOpening(
      getLichessGames,
      "startpos",
      {} as any,
      "token-1",
      controller.signal,
    );

    await expect(promise).rejects.toThrow("Cancellation");
    expect(mocks.logError).not.toHaveBeenCalled();
  });

  test("lch_master: checkpoint 1 stops after explorer fetch before normalization when signal is aborted", async () => {
    const controller = new AbortController();
    mocks.getMasterGames.mockImplementation(async () => {
      controller.abort();
      return mockExplorerData;
    });

    const promise = fetchOnlineOpening(
      getMasterGames,
      "startpos",
      {} as any,
      "token-1",
      controller.signal,
    );

    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.getPublicLichessJson).not.toHaveBeenCalled();
    expect(mocks.lexPgn).not.toHaveBeenCalled();
    expect(mocks.logError).not.toHaveBeenCalled();
  });

  test("lch_master: cancellation during lexing rejects without diagnostic and publishes no partial results", async () => {
    const controller = new AbortController();
    mocks.getMasterGames.mockResolvedValue(mockExplorerData);
    mocks.getPublicLichessJson.mockResolvedValue(`[White "W"]\n[Black "B"]\n\n1. e4 e5 *`);

    mocks.lexPgn.mockImplementation(async () => {
      controller.abort();
      throw cancellationError();
    });

    const promise = fetchOnlineOpening(
      getMasterGames,
      "startpos",
      {} as any,
      "token-1",
      controller.signal,
    );

    await expect(promise).rejects.toThrow("Cancellation");
    expect(mocks.logError).not.toHaveBeenCalled();
  });

  test.each(["lch_all", "lch_master"] as const)(
    "%s: ordinary failure retains siblings, openings and failure metadata",
    async (type) => {
      (type === "lch_all" ? mocks.getLichessGames : mocks.getMasterGames).mockResolvedValue(
        mockExplorerData,
      );
      mocks.getPublicLichessJson.mockImplementation(async ({ game_id }: { game_id: string }) => {
        if (game_id === "g0") throw new Error("Connection failed");
        return `[White "W1"]\n[Black "B1"]\n\n1. d4 d5 *`;
      });
      mocks.lexPgn.mockResolvedValue([]);

      const result = await fetchOnlineOpening(
        type === "lch_all" ? getLichessGames : getMasterGames,
        "startpos",
        {} as any,
        "token-1",
      );

      expect(result.openings).toEqual([{ move: "e4", white: 50, black: 40, draw: 10 }]);
      // The position total is the response's top-level counts, not the move-row sum.
      expect(result.total).toEqual({ move: "", white: 100, black: 80, draw: 20 });
      expect(result.games).toHaveLength(1);
      expect(result.games[0].id).toBe(1);
      expect(result.gameFailures).toHaveLength(1);
      expect(result.gameFailures![0].item.id).toBe("g0");
      expect(mocks.logError).toHaveBeenCalledOnce();
      expect(mocks.logError).toHaveBeenCalledWith(expect.stringContaining("item 0 failed"));
    },
  );

  const validSession = {
    lichess: {
      handle: "token-1",
      username: "player1",
      account: { id: "p1" } as any,
    },
    updatedAt: 12345,
  };

  const tabId = "11111111-1111-4111-8111-111111111111";
  const validTab = {
    name: "Tab 1",
    value: tabId,
    type: "analysis" as const,
    gameOrigin: { kind: "none" as const },
  };

  const reference: DatabaseHandle = { id: { id: "saved-reference" }, kind: "database" };
  const stalePath: DatabaseHandle = { id: { id: "old-tab-reference" }, kind: "database" };
  const readable: ManagedDatabaseInfo = {
    type: "success",
    file: reference,
    title: "Saved reference",
    filename: "reference.db3",
    description: "",
    indexed: false,
    player_count: 2,
    event_count: 1,
    game_count: 1,
    storage_size: "4096",
  };
  const unreadable: ManagedDatabaseInfo = {
    type: "error",
    file: reference,
    filename: "reference.db3",
    indexed: false,
    error: "Database is unreadable",
  };
  const databaseList = (databases: ManagedDatabaseInfo[]): DatabaseList => ({
    databases,
    unread: [],
    workspaceFilenames: [],
    root: { id: { id: "database-root" }, kind: "databaseRoot" },
  });

  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    return { promise, resolve, reject };
  }

  async function renderNode(
    store: ReturnType<typeof createJotaiStore>,
    swrConfig: SWRConfiguration,
    node: ReactNode,
    panelTabId = tabId,
  ) {
    await act(async () => {
      root.render(
        <MantineProvider>
          <JotaiProvider store={store}>
            <TreeStateContext.Provider value={treeStore}>
              <WorkspaceTabScope tabId={panelTabId}>
                <SWRConfig value={swrConfig}>{node}</SWRConfig>
              </WorkspaceTabScope>
            </TreeStateContext.Provider>
          </JotaiProvider>
        </MantineProvider>,
      );
    });
  }

  async function renderPanel(
    store: ReturnType<typeof createJotaiStore>,
    swrConfig: SWRConfiguration,
    children?: ReactNode,
    panelTabId = tabId,
  ) {
    await renderNode(
      store,
      swrConfig,
      <>
        {children}
        <DatabasePanel />
      </>,
      panelTabId,
    );
  }

  function regionPanel(value: "games" | "stats") {
    const label = value === "stats" ? "Board.Database.Stats" : "Board.Database.Games";
    const section = container.querySelector<HTMLElement>(`section[aria-label="${label}"]`);
    expect(section).not.toBeNull();
    return section!;
  }

  async function mountExplorer(
    data = mockExplorerData,
    rejectedIds = ["g0"],
    diagnostic = "sample-fetch-diagnostic",
  ) {
    const store = createJotaiStore();
    store.set(tabsAtom, [validTab]);
    store.set(activeTabAtom, tabId);
    store.set(dbTypeFamily(tabId), "lch_all");
    store.set(sessionsAtom, [validSession]);
    mocks.getLichessGames.mockResolvedValue(data);
    mocks.getPublicLichessJson.mockImplementation(async ({ game_id }: { game_id: string }) => {
      if (rejectedIds.includes(game_id)) throw new Error(diagnostic);
      return `[White "W1"]\n[Black "B1"]\n\n1. d4 d5 *`;
    });
    mocks.lexPgn.mockResolvedValue([
      { type: "Header", value: { tag: "White", value: "W1" } },
      { type: "Header", value: { tag: "Black", value: "B1" } },
    ]);
    await renderPanel(store, {
      provider: () => new Map(),
      dedupingInterval: 0,
      shouldRetryOnError: false,
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
    });
    return store;
  }

  /** The match count lives only in the Stats table's Total row. */
  function expectTotal(count: number) {
    expect(container.textContent).not.toContain("Board.Database.Matches");
    const rows = regionPanel("stats").querySelectorAll("tbody tr");
    const total = Array.from(rows).find((row) =>
      row.querySelector("td")?.textContent?.startsWith("Board.Database.StatsTable.Total"),
    );
    expect(total?.querySelectorAll("td")[1]?.textContent).toBe(formatNumber(count));
  }

  test("both Stats and Games regions show together without tabs or tablist", async () => {
    await mountExplorer();
    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(0);
    expect(container.querySelectorAll('[role="tablist"]')).toHaveLength(0);
    expect(container.querySelectorAll('[role="tabpanel"]')).toHaveLength(0);
    expect(regionPanel("stats")).toBeDefined();
    expect(regionPanel("games")).toBeDefined();
    const divider = container.querySelector('[role="separator"]');
    expect(divider?.getAttribute("aria-orientation")).toBe("horizontal");
    expect(divider?.getAttribute("aria-label")).toBe("Board.Database.ResizeSplit");
    expect(container.textContent).not.toContain("Board.Database.Options");
    expect(container.querySelectorAll("[data-explorer-source]")).toHaveLength(1);
  });

  test.each([
    // The position total is the response's own white + draws + black, not the move-row sum.
    { label: "opening totals", moves: mockExplorerData.moves },
    // A mate position: every game ended there, so no move row, yet the total still shows.
    { label: "no moves", moves: [] },
  ])(
    "mounted partial failure: $label retains the survivor and totals the whole position",
    async ({ moves }) => {
      const diagnostic = "partial-fetch-private-diagnostic";
      await mountExplorer({ ...mockExplorerData, moves }, ["g0"], diagnostic);
      const panel = regionPanel("games");
      expect(panel.textContent).toContain("Board.Database.GamesIncomplete W0 - B0");
      const notice = panel.querySelector('[role="alert"]');
      const table = panel.querySelector("table");
      expect(notice?.textContent).toContain("Board.Database.GamesIncomplete W0 - B0");
      expect(table).not.toBeNull();
      expect(notice!.compareDocumentPosition(table!) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(
        0,
      );
      expect(
        Array.from(panel.querySelectorAll("tbody tr")).some((row) =>
          row.textContent?.includes("W1"),
        ),
      ).toBe(true);
      expect(panel.querySelector(".mantine-datatable-empty-state[data-active]")).toBeNull();
      expect(panel.textContent).not.toContain("Board.Database.GamesFailed");
      expect(panel.textContent).not.toContain(diagnostic);
      expectTotal(200);

      const stats = regionPanel("stats");
      expect(stats.textContent).not.toContain("Board.Database.GamesIncomplete");
      expect(stats.textContent).not.toContain("Board.Database.GamesFailed");
      expect(stats.textContent?.includes("e4") ?? false).toBe(moves.length > 0);
    },
  );

  test("mounted all failed: names every game without an empty games table or raw diagnostic", async () => {
    const diagnostic = "all-fetch-private-diagnostic";
    await mountExplorer(mockExplorerData, ["g0", "g1"], diagnostic);
    const panel = regionPanel("games");
    expect(panel.textContent).toContain("Board.Database.GamesFailed W0 - B0, W1 - B1");
    expect(panel.textContent).not.toContain("Board.Database.GamesIncomplete");
    expect(panel.textContent).not.toContain("Databases.Game.NoGamesFound");
    expect(panel.querySelector("table")).toBeNull();
    expect(panel.textContent).not.toContain(diagnostic);
    expectTotal(200);
  });

  test("an online game opens at the position the explorer was asked for", async () => {
    await act(async () => treeStore.getState().makeMove({ payload: "e4" }));
    await mountExplorer(mockExplorerData, []);
    await openListedGame("W1");
    expect(mocks.openDatabaseGame.mock.lastCall?.[0]).toMatchObject({ targetFens: [afterE4] });
  });

  test("mounted empty explorer list: keeps the genuine empty state and the Total row count", async () => {
    await mountExplorer({ ...mockExplorerData, topGames: [] }, []);
    const panel = regionPanel("games");
    expect(panel.textContent).toContain("Databases.Game.NoGamesFound");
    expect(panel.querySelector(".mantine-datatable-empty-state[data-active]")).not.toBeNull();
    expect(panel.textContent).not.toContain("Board.Database.GamesIncomplete");
    expect(panel.textContent).not.toContain("Board.Database.GamesFailed");
    expectTotal(200);
  });

  test.each([
    { white: "  ", black: "\t", expected: "g0" },
    { white: "  Solo White  ", black: "  ", expected: "Solo White" },
    { white: "  ", black: "  Solo Black  ", expected: "Solo Black" },
  ])(
    "mounted failed labels: trims names and falls back without separators ($expected)",
    async ({ white, black, expected }) => {
      const diagnostic = "label-fetch-private-diagnostic";
      const game = mockExplorerData.topGames[0];
      await mountExplorer(
        {
          ...mockExplorerData,
          topGames: [
            {
              ...game,
              white: { ...game.white, name: white },
              black: { ...game.black, name: black },
            },
          ],
        },
        ["g0"],
        diagnostic,
      );
      const panel = regionPanel("games");
      expect(panel.querySelector('[role="alert"]')?.textContent).toBe(
        `Board.Database.GamesFailed ${expected}`,
      );
      expect(panel.textContent).not.toContain(diagnostic);
      expect(panel.textContent).not.toContain("Databases.Game.NoGamesFound");
    },
  );

  async function mountLocal(pin?: DatabaseHandle, player: number | null = null) {
    const store = createJotaiStore();
    store.set(tabsAtom, [validTab]);
    store.set(activeTabAtom, tabId);
    if (pin) store.set(pinnedExplorerDatabaseFamily(tabId), pin);
    store.set(dbTypeFamily(tabId), "local");
    // Hydrate the real persisted atoms and seed an unrelated old per-tab search path.
    localStorage.setItem("reference-database", JSON.stringify(reference));
    const filters = {
      player,
      color: "white" as const,
      result: "draw" as const,
      elo: [1800, 2400] as [number, number],
      exclude_fast_events: true,
    };
    // A pinned tab owns its filters; every other tab reads the database's saved ones.
    if (!pin) {
      localStorage.setItem(
        "explorer-database-filters",
        JSON.stringify([{ database: databaseHandleKey(reference), filters }]),
      );
    }
    store.set(localOptionsFamily(tabId), {
      ...store.get(localOptionsFamily(tabId)),
      path: stalePath,
      fen: treeStore.getState().currentNode().fen,
      ...(pin
        ? { ...filters, player_database: player !== null ? databaseHandleKey(pin) : undefined }
        : {}),
    });
    let mutate!: ScopedMutator;
    function CacheControl() {
      mutate = useSWRConfig().mutate;
      return null;
    }
    const swrConfig: SWRConfiguration = {
      provider: () => new Map(),
      dedupingInterval: 0,
      shouldRetryOnError: false,
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
    };
    await renderPanel(store, swrConfig, <CacheControl />);
    return {
      store,
      swrConfig,
      revalidate: async () => {
        await act(async () => {
          await mutate(DATABASE_LIST_KEY);
        });
      },
    };
  }

  function savedFilters(store: ReturnType<typeof createJotaiStore>, database: DatabaseHandle) {
    return explorerFiltersFor(store.get(explorerDatabaseFiltersAtom), databaseHandleKey(database));
  }

  function expectSavedChoice(store: ReturnType<typeof createJotaiStore>) {
    expect(store.get(referenceDbAtom)).toEqual(reference);
    expect(JSON.parse(localStorage.getItem("reference-database")!)).toEqual(reference);
  }

  test.each(["partial", "exact"] as const)(
    "local: %s position survives remount and follows board moves only in exact mode",
    async (type) => {
      mocks.getDatabases.mockResolvedValue(databaseList([readable]));
      const { store, swrConfig } = await mountLocal();
      const pattern = "8/pppppppp/8/8/8/8/PPPPPPPP/8 w - - 0 1";
      await act(async () =>
        store.set(localOptionsFamily(tabId), (options) => ({ ...options, type, fen: pattern })),
      );
      const beforeMove = store.get(localOptionsFamily(tabId));
      await act(async () => treeStore.getState().makeMove({ payload: "e4" }));
      await act(async () => new Promise((resolve) => setTimeout(resolve, 80)));
      expect(store.get(localOptionsFamily(tabId)).fen).toBe(
        type === "partial" ? pattern : treeStore.getState().currentNode().fen,
      );
      expect(store.get(localOptionsFamily(tabId)) === beforeMove).toBe(type === "partial");

      await act(async () => root.render(null));
      await renderPanel(store, swrConfig);
      expect(store.get(localOptionsFamily(tabId)).fen).toBe(
        type === "partial" ? pattern : treeStore.getState().currentNode().fen,
      );
    },
  );

  function expectNoReference() {
    expect(container.querySelectorAll('[role="separator"]')).toHaveLength(0);
    expect(container.querySelectorAll("section[aria-label]")).toHaveLength(0);
    expect(container.textContent?.split("Board.Database.NoReference1")).toHaveLength(2);
    expect(container.querySelector<HTMLInputElement>(".mantine-Select-input")?.value).toBe("");
    expect(filterButton().disabled).toBe(true);
  }

  function filterButton() {
    return container.querySelector<HTMLButtonElement>(
      '[data-explorer-source] button[aria-label^="Board.Database.FilterButton"]',
    )!;
  }

  /** Opens the source's filter popover, unless it is open or the source has no database. */
  async function openFilters() {
    const button = filterButton();
    if (button.disabled) return null;
    if (button.getAttribute("aria-expanded") !== "true") await act(async () => button.click());
    // The dropdown mounts on the transition's first frame.
    await vi.waitFor(() =>
      expect(document.querySelector("[data-explorer-filters]")).not.toBeNull(),
    );
    await act(async () => {});
    return document.querySelector<HTMLElement>("[data-explorer-filters]");
  }

  async function showPlayerOptions() {
    return (
      (await openFilters())?.querySelector<HTMLInputElement>(".mantine-Autocomplete-input") ?? null
    );
  }

  test("local: readable persisted handle searches with preserved filters and overrides stale tab path", async () => {
    mocks.getDatabases.mockResolvedValue(databaseList([readable]));
    const { store } = await mountLocal();

    expect(mocks.searchPosition).toHaveBeenCalled();
    for (const call of mocks.searchPosition.mock.calls) {
      expect(call).toEqual([
        reference,
        expect.objectContaining({
          wantedResult: "draw",
          range1: [1800, 2400],
          range2: [1800, 2400],
          excludeFastEvents: true,
        }),
        tabId,
        { signal: expect.any(AbortSignal) },
      ]);
    }
    expect(container.querySelector<HTMLInputElement>(".mantine-Select-input")?.value).toBe(
      "Saved reference",
    );
    expect(container.textContent).not.toContain("Board.Database.NoReference1");
    expect(store.get(localOptionsFamily(tabId)).path).toEqual(reference);
    expectSavedChoice(store);
  });

  test("local: a per-tab pin selects and searches its database while preserving the global reference", async () => {
    mocks.getDatabases.mockResolvedValue(
      databaseList([readable, { ...readable, file: stalePath, title: "Pinned database" }]),
    );
    const { store } = await mountLocal(stalePath);
    expect(mocks.searchPosition).toHaveBeenCalled();
    for (const call of mocks.searchPosition.mock.calls) expect(call[0]).toEqual(stalePath);
    expect(container.querySelector<HTMLInputElement>(".mantine-Select-input")?.value).toBe(
      "Pinned database",
    );
    expect(store.get(localOptionsFamily(tabId)).path).toEqual(stalePath);
    expectSavedChoice(store);
    await act(async () => store.set(pinnedExplorerDatabaseFamily(tabId), null));
    expect(mocks.searchPosition.mock.lastCall?.[0]).toEqual(reference);
    expectSavedChoice(store);
  });

  test("local: an unavailable pin never falls back to the global reference", async () => {
    mocks.getDatabases.mockResolvedValue(databaseList([readable]));
    const { store } = await mountLocal(stalePath);
    expect(mocks.searchPosition).not.toHaveBeenCalled();
    expectNoReference();
    expect(store.get(pinnedExplorerDatabaseFamily(tabId))).toEqual(stalePath);
    expectSavedChoice(store);
  });

  test.each(["pinned", "global"] as const)(
    "local: %s database selector suppresses a player owned by another database",
    async (selection) => {
      mocks.getDatabases.mockResolvedValue(
        databaseList([readable, { ...readable, file: stalePath, title: "Other database" }]),
      );
      const pinned = selection === "pinned";
      const { store } = await mountLocal(pinned ? stalePath : undefined, 42);
      const initialDatabase = pinned ? stalePath : reference;
      const nextDatabase = pinned ? reference : stalePath;
      expect(mocks.searchPosition.mock.lastCall?.[0]).toEqual(initialDatabase);
      expect(mocks.searchPosition.mock.lastCall?.[1].player1).toBe(42);
      expect((await showPlayerOptions())?.value).toBe(`${initialDatabase.id.id} player`);
      mocks.searchPosition.mockClear();

      const selector = container.querySelector<HTMLInputElement>(".mantine-Select-input")!;
      await act(async () => selector.click());
      const option = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(
        (item) => item.textContent === (pinned ? "Saved reference" : "Other database"),
      );
      expect(option).toBeDefined();
      await act(async () => option!.click());

      expect(mocks.clearGames).toHaveBeenCalledOnce();
      // The player stays with the database that owns it: in the pinned tab's own options, or
      // in that database's saved filters.
      const owned = pinned
        ? store.get(localOptionsFamily(tabId))
        : {
            player: savedFilters(store, initialDatabase).player,
            player_database: databaseHandleKey(initialDatabase),
          };
      expect(owned).toMatchObject({
        player: 42,
        player_database: databaseHandleKey(initialDatabase),
      });
      expect(savedFilters(store, nextDatabase).player).toBeNull();
      expect(mocks.searchPosition).toHaveBeenCalled();
      for (const [database, query] of mocks.searchPosition.mock.calls) {
        expect(database).toEqual(nextDatabase);
        expect(query.player1 ?? null).toBeNull();
        expect(query.player2 ?? null).toBeNull();
      }
      expect((await showPlayerOptions())?.value).toBe("");
      for (const [database, id] of mocks.getPlayer.mock.calls) {
        expect(database).toEqual(initialDatabase);
        expect(id).toBe(42);
      }
      expect(store.get(pinnedExplorerDatabaseFamily(tabId))).toEqual(pinned ? nextDatabase : null);
      expect(store.get(referenceDbAtom)).toEqual(pinned ? reference : nextDatabase);
      expect(JSON.parse(localStorage.getItem("reference-database")!)).toEqual(
        pinned ? reference : nextDatabase,
      );
      await act(async () =>
        store.set(pinned ? pinnedExplorerDatabaseFamily(tabId) : referenceDbAtom, initialDatabase),
      );
      expect((await showPlayerOptions())?.value).toBe(`${initialDatabase.id.id} player`);
      for (const [database, query] of mocks.searchPosition.mock.calls) {
        const expectedPlayer =
          databaseHandleKey(database) === databaseHandleKey(initialDatabase) ? 42 : null;
        expect(query.player1 ?? null).toBe(expectedPlayer);
        expect(query.player2 ?? null).toBeNull();
      }
    },
  );

  test("local: a second unpinned tab changes the global reference without sending the first tab's player to it", async () => {
    mocks.getDatabases.mockResolvedValue(
      databaseList([readable, { ...readable, file: stalePath, title: "Other database" }]),
    );
    const { store, swrConfig } = await mountLocal(undefined, 42);
    expect(mocks.searchPosition.mock.lastCall?.[0]).toEqual(reference);
    expect(mocks.searchPosition.mock.lastCall?.[1].player1).toBe(42);
    expect((await showPlayerOptions())?.value).toBe(`${reference.id.id} player`);
    await act(async () => root.render(null));

    const secondTabId = "22222222-2222-4222-8222-222222222222";
    await act(async () => {
      store.set(tabsAtom, [validTab, { ...validTab, value: secondTabId, name: "Tab 2" }]);
      store.set(dbTypeFamily(secondTabId), "local");
      store.set(activeTabAtom, secondTabId);
    });
    await renderPanel(store, swrConfig, undefined, secondTabId);
    const selector = container.querySelector<HTMLInputElement>(".mantine-Select-input")!;
    await act(async () => selector.click());
    const option = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(
      (item) => item.textContent === "Other database",
    );
    expect(option).toBeDefined();
    await act(async () => option!.click());
    expect(store.get(referenceDbAtom)).toEqual(stalePath);
    expect(savedFilters(store, reference).player).toBe(42);
    mocks.searchPosition.mockClear();
    await act(async () => root.render(null));

    await act(async () => {
      store.set(activeTabAtom, tabId);
    });
    await renderPanel(store, swrConfig);
    expect(mocks.searchPosition).toHaveBeenCalled();
    for (const [database, query, owner] of mocks.searchPosition.mock.calls) {
      expect(owner).toBe(tabId);
      expect(database).toEqual(stalePath);
      expect(query.player1 ?? null).toBeNull();
      expect(query.player2 ?? null).toBeNull();
    }
    expect((await showPlayerOptions())?.value).toBe("");
    for (const [database, id] of mocks.getPlayer.mock.calls) {
      expect(database).toEqual(reference);
      expect(id).toBe(42);
    }
    expect(savedFilters(store, reference).player).toBe(42);
    expect(savedFilters(store, stalePath).player).toBeNull();
  });

  test("local: a filter edit follows the database into another tab and a fresh store", async () => {
    mocks.getDatabases.mockResolvedValue(databaseList([readable]));
    localStorage.removeItem("explorer-database-filters");
    const first = await mountLocal();
    localStorage.removeItem("explorer-database-filters");
    await act(async () => first.store.set(explorerDatabaseFiltersAtom, []));
    const toggle = (await openFilters())!.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    )!;
    expect(toggle.checked).toBe(false);
    await act(async () => toggle.click());
    expect(savedFilters(first.store, reference).exclude_fast_events).toBe(true);
    // The tab's own options carry no filter: they are the database's, not the tab's.
    expect(first.store.get(localOptionsFamily(tabId)).exclude_fast_events).toBeUndefined();
    await act(async () => root.render(null));

    // Nothing but localStorage connects the two mounts.
    mocks.searchPosition.mockClear();
    const store = createJotaiStore();
    const secondTabId = "22222222-2222-4222-8222-222222222222";
    store.set(tabsAtom, [{ ...validTab, value: secondTabId, name: "Tab 2" }]);
    store.set(activeTabAtom, secondTabId);
    store.set(dbTypeFamily(secondTabId), "local");
    store.set(localOptionsFamily(secondTabId), (options) => ({
      ...options,
      fen: treeStore.getState().currentNode().fen,
    }));
    await renderPanel(store, first.swrConfig, undefined, secondTabId);
    await vi.waitFor(() =>
      expect(mocks.searchPosition).toHaveBeenLastCalledWith(
        reference,
        expect.objectContaining({ excludeFastEvents: true }),
        secondTabId,
        { signal: expect.any(AbortSignal) },
      ),
    );
    expect(mocks.searchPosition.mock.lastCall?.[1]).not.toHaveProperty("wantedResult");
  });

  test("local: a pinned tab neither reads nor writes the database's saved filters", async () => {
    mocks.getDatabases.mockResolvedValue(databaseList([readable]));
    const saved = [
      {
        database: databaseHandleKey(reference),
        filters: { player: null, color: "white", result: "whitewon", elo: [2600, 3000] },
      },
    ];
    localStorage.setItem("explorer-database-filters", JSON.stringify(saved));
    const { store } = await mountLocal(reference);
    expect(mocks.searchPosition.mock.lastCall?.[1]).toMatchObject({
      wantedResult: "draw",
      range1: [1800, 2400],
    });
    const toggle = (await openFilters())!.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    )!;
    expect(toggle.checked).toBe(true);
    await act(async () => toggle.click());
    expect(store.get(localOptionsFamily(tabId)).exclude_fast_events).toBe(false);
    expect(store.get(explorerDatabaseFiltersAtom)).toEqual(saved);
    expect(JSON.parse(localStorage.getItem("explorer-database-filters")!)).toEqual(saved);
  });

  test("local: a collection that publishes a new database moves the reference and its filters", async () => {
    const current: DatabaseHandle = { id: { id: "regenerated-reference" }, kind: "database" };
    mocks.getDatabases.mockResolvedValue(
      databaseList([readable, { ...readable, file: current, title: "Regenerated" }]),
    );
    mocks.collectionForDatabase.mockImplementation(async (file: DatabaseHandle) =>
      databaseHandleKey(file) === databaseHandleKey(reference)
        ? {
            id: "55555555-5555-4555-8555-555555555555",
            name: "Games",
            file: { id: { id: "library" }, kind: "fileWorkspace" },
            database: current,
            account: null,
            status: "ready",
            generation: "g2",
            omitted: 0,
            retiredDatabase: reference,
            fetchSinceMs: null,
          }
        : null,
    );
    const { store } = await mountLocal(undefined, 42);
    await vi.waitFor(() => expect(store.get(referenceDbAtom)).toEqual(current));
    expect(store.get(explorerDatabaseFiltersAtom)).toEqual([
      {
        database: databaseHandleKey(current),
        filters: {
          player: null,
          color: "white",
          result: "draw",
          elo: [1800, 2400],
          exclude_fast_events: true,
        },
      },
    ]);
    await vi.waitFor(() =>
      expect(mocks.searchPosition).toHaveBeenLastCalledWith(
        current,
        expect.objectContaining({ wantedResult: "draw", range1: [1800, 2400] }),
        tabId,
        { signal: expect.any(AbortSignal) },
      ),
    );
    expect(mocks.searchPosition.mock.lastCall?.[1].player1 ?? null).toBeNull();
  });

  test("local: a pinned collection that publishes a new database moves only the pin", async () => {
    const current: DatabaseHandle = { id: { id: "regenerated-pin" }, kind: "database" };
    mocks.getDatabases.mockResolvedValue(
      databaseList([readable, { ...readable, file: stalePath }, { ...readable, file: current }]),
    );
    mocks.collectionForDatabase.mockImplementation(async (file: DatabaseHandle) =>
      databaseHandleKey(file) === databaseHandleKey(stalePath)
        ? {
            id: "55555555-5555-4555-8555-555555555555",
            name: "Games",
            file: { id: { id: "library" }, kind: "fileWorkspace" },
            database: current,
            account: null,
            status: "ready",
            generation: "g2",
            omitted: 0,
            retiredDatabase: stalePath,
            fetchSinceMs: null,
          }
        : null,
    );
    const { store } = await mountLocal(stalePath);
    await vi.waitFor(() => expect(store.get(pinnedExplorerDatabaseFamily(tabId))).toEqual(current));
    expect(store.get(referenceDbAtom)).toEqual(reference);
  });

  test("local: the filter button names the database's active filters", async () => {
    mocks.getDatabases.mockResolvedValue(databaseList([readable]));
    await mountLocal();
    expect(filterButton().textContent).toBe(
      [
        "Board.Database.Local.Elo 1800–2400",
        "Board.Analysis.Tablebase.Draw",
        "Board.Database.FilterSummary.NoFastEvents",
      ].join(" · "),
    );
    expect(filterButton().getAttribute("aria-label")).toBe(
      `Board.Database.FilterButton ${filterButton().textContent}`,
    );
  });

  async function openListedGame(name = "Listed player") {
    const panel = regionPanel("games");
    const calls = mocks.openDatabaseGame.mock.calls.length;
    const row = await vi.waitFor(() => {
      const found = Array.from(panel.querySelectorAll<HTMLElement>("tbody tr")).find((item) =>
        item.textContent?.includes(name),
      );
      expect(found).toBeDefined();
      return found!;
    });
    await act(async () => row.click());
    await vi.waitFor(() => expect(mocks.openDatabaseGame.mock.calls.length).toBe(calls + 1));
  }

  test("local: a partial position hides Stats and separator, showing Games full height", async () => {
    mocks.getDatabases.mockResolvedValue(databaseList([readable]));
    mocks.searchPosition.mockResolvedValue([
      [],
      [{ id: 3, white: "Listed player", black: "Opponent", result: "*", ply_count: 20 }],
    ]);
    const { store } = await mountLocal();
    regionPanel("stats");
    expect(container.querySelector('[role="separator"]')).not.toBeNull();
    await act(async () =>
      store.set(localOptionsFamily(tabId), (options) => ({ ...options, type: "partial" })),
    );
    regionPanel("games");
    expect(container.querySelector('section[aria-label="Board.Database.Stats"]')).toBeNull();
    expect(container.querySelector('[role="separator"]')).toBeNull();
    await vi.waitFor(() =>
      expect(mocks.searchPosition.mock.lastCall?.[1].position.type_).toBe("partial"),
    );
    // A pattern is not one position, so its games open at their start.
    await openListedGame();
    expect(mocks.openDatabaseGame.mock.lastCall?.[0]).toMatchObject({ targetFens: undefined });
    // Exact mode brings the statistics section and separator back.
    await act(async () =>
      store.set(localOptionsFamily(tabId), (options) => ({ ...options, type: "exact" })),
    );
    regionPanel("stats");
    expect(container.querySelector('[role="separator"]')).not.toBeNull();
    // An exact search opens each game at the searched position, not at the start.
    await act(async () => treeStore.getState().makeMove({ payload: "e4" }));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 80)));
    await openListedGame();
    expect(mocks.openDatabaseGame.mock.lastCall?.[0]).toMatchObject({ targetFens: [afterE4] });
  });

  test("local: the position dialog switches the tab's match mode for the search", async () => {
    mocks.getDatabases.mockResolvedValue(databaseList([readable]));
    const { store } = await mountLocal();
    const control = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.startsWith("Board.Database.PositionMode"),
    )!;
    expect(control.textContent).toBe("Board.Database.PositionMode Board.Database.Local.Exact");
    await act(async () => control.click());
    const dialog = await vi.waitFor(() => {
      const found = document.querySelector<HTMLElement>('[role="dialog"]');
      expect(found).not.toBeNull();
      return found!;
    });
    expect(dialog.textContent).toContain("Board.Database.Local.Exact.Hint");
    const partial = dialog.querySelector<HTMLInputElement>('input[value="partial"]')!;
    await act(async () => partial.click());
    expect(store.get(localOptionsFamily(tabId)).type).toBe("partial");
    expect(control.textContent).toBe("Board.Database.PositionMode Board.Database.Local.Partial");
    await vi.waitFor(() =>
      expect(mocks.searchPosition.mock.lastCall?.[1].position.type_).toBe("partial"),
    );
    // The saved filters still apply: the mode is the tab's, the filters are the database's.
    expect(mocks.searchPosition.mock.lastCall?.[1]).toMatchObject({ wantedResult: "draw" });
  });

  test("local: a database choice is stored although clearing the search cache fails", async () => {
    mocks.getDatabases.mockResolvedValue(
      databaseList([readable, { ...readable, file: stalePath, title: "Other database" }]),
    );
    mocks.clearGames.mockRejectedValue(new Error("cache unavailable"));
    const { store } = await mountLocal();
    const selector = container.querySelector<HTMLInputElement>(".mantine-Select-input")!;
    await act(async () => selector.click());
    const option = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(
      (item) => item.textContent === "Other database",
    )!;
    await act(async () => option.click());
    expect(mocks.clearGames).toHaveBeenCalledOnce();
    expect(store.get(referenceDbAtom)).toEqual(stalePath);
    await vi.waitFor(() => expect(mocks.searchPosition.mock.lastCall?.[0]).toEqual(stalePath));
  });

  describe("with a comparison database", () => {
    const corr: DatabaseHandle = { id: { id: "correspondence" }, kind: "database" };
    const corrInfo: ManagedDatabaseInfo = { ...readable, file: corr, title: "Correspondence" };
    const third: ManagedDatabaseInfo = {
      ...readable,
      file: { id: { id: "third" }, kind: "database" },
      title: "Third database",
    };
    const stats = (move: string, white: number, draw: number, black: number) => ({
      move,
      white,
      draw,
      black,
      unknown: 0,
      last_played: null,
      year_counts: [],
      recent: [],
    });
    const game = (id: number, white: string) => ({
      id,
      white,
      black: "Opponent",
      white_elo: 2400,
      black_elo: 2400,
      date: "2024.01.01",
      result: "1/2-1/2",
      ply_count: 40,
    });
    const answers = {
      [databaseHandleKey(reference)]: [
        [stats("e4", 50, 10, 40), stats("d4", 30, 5, 5)],
        [game(1, "Mega player")],
      ],
      [databaseHandleKey(corr)]: [
        [stats("d4", 2, 9, 1), stats("h4", 1, 6, 1)],
        [game(7, "Corr player")],
      ],
    };

    async function mountCompared({
      pin,
      list = [readable, corrInfo, third],
      failing,
    }: { pin?: DatabaseHandle; list?: ManagedDatabaseInfo[]; failing?: DatabaseHandle } = {}) {
      mocks.getDatabases.mockResolvedValue(databaseList(list));
      mocks.searchPosition.mockImplementation(async (file: DatabaseHandle) => {
        if (failing && databaseHandleKey(file) === databaseHandleKey(failing)) {
          throw new Error("search failed");
        }
        return answers[databaseHandleKey(file)] ?? [[], []];
      });
      localStorage.setItem("comparison-database", JSON.stringify(corr));
      const mounted = await mountLocal(pin);
      await act(async () => {});
      return mounted;
    }

    const sources = () =>
      Array.from(container.querySelectorAll<HTMLElement>("[data-explorer-source]"));
    // The table shows a search itself, so no source header carries a progress bar.
    const sourceProgressBars = () =>
      container.querySelectorAll('[data-explorer-source] [role="progressbar"]');
    const searchesOf = (database: DatabaseHandle) =>
      mocks.searchPosition.mock.calls.filter(
        ([file]) => databaseHandleKey(file) === databaseHandleKey(database),
      );
    const moveRows = () =>
      Array.from(regionPanel("stats").querySelectorAll("tbody tr"), (row) =>
        Array.from(row.querySelectorAll("td"), (cell) => cell.textContent),
      );
    const compareButton = () =>
      Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent === "Board.Database.Compare",
      );
    const addColumnButton = () =>
      Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent === "Board.Database.AddColumn",
      );
    const positionControl = () =>
      Array.from(container.querySelectorAll("button")).find((button) =>
        button.textContent?.startsWith("Board.Database.PositionMode"),
      );
    const listedOptions = (select: HTMLInputElement) =>
      Array.from(select.ownerDocument.querySelectorAll<HTMLElement>('[role="option"]')).filter(
        (option) => option.closest('[role="listbox"]')?.id === select.getAttribute("aria-controls"),
      );
    const listedGroups = (select: HTMLInputElement) =>
      Array.from(select.ownerDocument.querySelectorAll<HTMLElement>(".mantine-Select-groupLabel"))
        .filter(
          (label) => label.closest('[role="listbox"]')?.id === select.getAttribute("aria-controls"),
        )
        .map((label) => label.textContent);
    const menuChoices = () =>
      Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).map(
        (item) => item.textContent,
      );

    const settingsButton = () =>
      container.querySelector<HTMLButtonElement>(
        '[aria-label="Board.Database.ShowSettings"], [aria-label="Board.Database.HideSettings"]',
      )!;
    const headerControls = () =>
      Array.from(container.querySelectorAll('.mantine-Select-input, [role="tab"]')).filter(
        (el) => !el.closest("section[aria-label]"),
      );

    test("collapsed by default: captions name both databases and their active filters, and the settings button opens the controls", async () => {
      localStorage.removeItem(HEADER_COLLAPSED_KEY);
      await mountCompared();
      await vi.waitFor(() => expect(sources()).toHaveLength(2));

      expect(headerControls()).toHaveLength(0);
      expect(compareButton()).toBeUndefined();
      // The saved reference carries filters, the comparison none.
      expect(sources()[0].firstElementChild?.textContent).toBe("Saved reference");
      expect(sources()[0].querySelector("[data-explorer-source-detail]")?.textContent).toBe(
        "Board.Database.Local.Elo 1800–2400 · Board.Analysis.Tablebase.Draw · Board.Database.FilterSummary.NoFastEvents",
      );
      expect(sources()[1].textContent).toBe("Correspondence");
      expect(sources()[1].querySelector("[data-explorer-source-detail]")).toBeNull();
      expect(sourceProgressBars()).toHaveLength(0);
      // Both sources render in plain regions with no tab panel semantics.
      expect(container.querySelector('[role="tabpanel"]')).toBeNull();
      expect(
        Array.from(
          container.querySelectorAll("tbody tr"),
          (row) => row.querySelector("td")?.textContent,
        ),
      ).toContain("d4");
      expect(settingsButton().getAttribute("aria-label")).toBe("Board.Database.ShowSettings");
      expect(settingsButton().getAttribute("aria-pressed")).toBe("false");

      await act(async () => settingsButton().click());
      expect(localStorage.getItem(HEADER_COLLAPSED_KEY)).toBe("false");
      expect(settingsButton().getAttribute("aria-label")).toBe("Board.Database.HideSettings");
      expect(settingsButton().getAttribute("aria-pressed")).toBe("true");
      expect(
        sources().map(
          (source) => source.querySelector<HTMLInputElement>(".mantine-Select-input")?.value,
        ),
      ).toEqual(["Saved reference", "Correspondence"]);
      expect(sourceProgressBars()).toHaveLength(0);
      regionPanel("stats");

      await act(async () => settingsButton().click());
      expect(localStorage.getItem(HEADER_COLLAPSED_KEY)).toBe("true");
      expect(headerControls()).toHaveLength(0);
    });

    test.each([
      [null, true],
      ["true", true],
      ["false", false],
      ["not json", true],
      ['"yes"', true],
    ])("the header preference %s hydrates as collapsed=%s", async (stored, collapsed) => {
      if (stored === null) localStorage.removeItem(HEADER_COLLAPSED_KEY);
      else localStorage.setItem(HEADER_COLLAPSED_KEY, stored);
      await mountCompared();
      await vi.waitFor(() => expect(sources()).toHaveLength(2));
      expect(headerControls().length === 0).toBe(collapsed);
    });

    test("a collapsed caption names a partial position", async () => {
      localStorage.setItem(HEADER_COLLAPSED_KEY, "true");
      const { store } = await mountCompared();
      await vi.waitFor(() => expect(sources()).toHaveLength(2));
      await act(async () =>
        store.set(localOptionsFamily(tabId), (options) => ({ ...options, type: "partial" })),
      );
      for (const source of sources()) {
        expect(source.textContent).toContain(
          "Board.Database.PositionMode Board.Database.Local.Partial",
        );
      }
    });

    test("without a database the controls stay open and the stored preference is kept", async () => {
      localStorage.setItem(HEADER_COLLAPSED_KEY, "true");
      await mountCompared({ list: [] });
      await vi.waitFor(() => expect(settingsButton().disabled).toBe(true));
      expect(container.querySelector(".mantine-Select-input")).not.toBeNull();
      expect(settingsButton().getAttribute("aria-label")).toBe("Board.Database.HideSettings");
      expect(localStorage.getItem(HEADER_COLLAPSED_KEY)).toBe("true");
    });

    test("a collapsed online source marks its filters only when they narrow the numbers, and still shows its games", async () => {
      localStorage.setItem(HEADER_COLLAPSED_KEY, "true");
      mocks.getMasterGames.mockResolvedValue(mockExplorerData);
      const store = await mountExplorer();
      await vi.waitFor(() => expect(sources()).toHaveLength(1));
      expect(headerControls()).toHaveLength(0);
      expect(sources()[0].textContent).toBe("Board.Database.LichessAll");
      expect(sourceProgressBars()).toHaveLength(0);
      // The stored Games view renders as a plain region below the caption.
      expect(container.querySelector('[role="tabpanel"]')).toBeNull();
      await vi.waitFor(() => expect(container.textContent).toContain("W1"));
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        "Board.Database.GamesIncomplete",
      );

      await act(async () => {
        await store.set(lichessOptionsAtom, { ...DEFAULT_LICHESS_OPTIONS, speeds: ["blitz"] });
      });
      expect(sources()[0].firstElementChild?.textContent).toBe("Board.Database.LichessAll");
      expect(sources()[0].querySelector("[data-explorer-source-detail]")?.textContent).toBe(
        "Board.Database.Filters",
      );

      await act(async () => store.set(dbTypeFamily(tabId), "lch_master"));
      await vi.waitFor(() => expect(sources()[0].textContent).toBe("Board.Database.LichessMaster"));
      expect(sourceProgressBars()).toHaveLength(0);
      await act(async () => {
        await store.set(masterOptionsAtom, { since: new Date("2020-01-01T00:00:00Z") });
      });
      expect(sources()[0].firstElementChild?.textContent).toBe("Board.Database.LichessMaster");
      expect(sources()[0].querySelector("[data-explorer-source-detail]")?.textContent).toBe(
        "Board.Database.Filters",
      );
      // A cleared date leaves its key behind; that is no filter.
      await act(async () => {
        await store.set(masterOptionsAtom, { since: undefined });
      });
      expect(sources()[0].textContent).toBe("Board.Database.LichessMaster");
    });

    test("a cancellation on the database list keeps the comparison database", async () => {
      const { revalidate } = await mountCompared();
      await vi.waitFor(() => expect(sources()).toHaveLength(2));

      mocks.getDatabases.mockRejectedValue(new DOMException("Cancellation", "AbortError"));
      await revalidate();

      expect(
        sources().map(
          (source) => source.querySelector<HTMLInputElement>(".mantine-Select-input")?.value,
        ),
      ).toEqual(["Saved reference", "Correspondence"]);
    });

    test("both databases are searched with their own filters and progress ids, side by side", async () => {
      await mountCompared();
      await vi.waitFor(() => expect(searchesOf(corr)).not.toHaveLength(0));
      for (const [file, query, progress] of searchesOf(reference)) {
        expect(file).toEqual(reference);
        expect(query).toMatchObject({ wantedResult: "draw", range1: [1800, 2400] });
        expect(progress).toBe(tabId);
      }
      for (const [, query, progress] of searchesOf(corr)) {
        expect(query).not.toHaveProperty("wantedResult");
        expect(query).not.toHaveProperty("range1");
        expect(query).not.toHaveProperty("excludeFastEvents");
        expect(query.position).toEqual(searchesOf(reference)[0][1].position);
        expect(progress).toBe(`${tabId}:comparison`);
      }
      expect(sources()).toHaveLength(2);
      expect(
        sources().map(
          (source) => source.querySelector<HTMLInputElement>(".mantine-Select-input")?.value,
        ),
      ).toEqual(["Saved reference", "Correspondence"]);
      expect(
        sources().map(
          (source) => source.querySelector("button[aria-haspopup='dialog']")?.textContent,
        ),
      ).toEqual([
        [
          "Board.Database.Local.Elo 1800–2400",
          "Board.Analysis.Tablebase.Draw",
          "Board.Database.FilterSummary.NoFastEvents",
        ].join(" · "),
        "Board.Database.NoFilter",
      ]);
      await vi.waitFor(() =>
        expect(
          moveRows().map(([move, primary, , , comparison]) => [move, primary, comparison]),
        ).toEqual([
          ["e4", "71%100", "–"],
          ["d4", "29%40", "60%12"],
          ["h4", "–", "40%8"],
          ["Board.Database.StatsTable.Total", "140", "20"],
        ]),
      );
      expect(compareButton()).toBeUndefined();
    });

    test("a filter set on the comparison source is saved for that database only", async () => {
      const { store } = await mountCompared();
      const button = sources()[1].querySelector<HTMLButtonElement>(
        "button[aria-haspopup='dialog']",
      )!;
      await act(async () => button.click());
      const toggle = await vi.waitFor(() => {
        const found = document.querySelector<HTMLInputElement>(
          '[data-explorer-filters] input[type="checkbox"]',
        );
        expect(found).not.toBeNull();
        return found!;
      });
      mocks.searchPosition.mockClear();
      await act(async () => toggle.click());
      expect(savedFilters(store, corr)).toMatchObject({ exclude_fast_events: true, result: "any" });
      expect(savedFilters(store, reference)).toMatchObject({ result: "draw", elo: [1800, 2400] });
      await vi.waitFor(() =>
        expect(searchesOf(corr).at(-1)?.[1]).toMatchObject({ excludeFastEvents: true }),
      );
      expect(searchesOf(reference)).toHaveLength(0);
    });

    test("the sort choice is the tab's and orders the rows by the comparison source", async () => {
      const { store } = await mountCompared();
      await vi.waitFor(() => expect(moveRows()).toHaveLength(4));
      const totals = Array.from(
        regionPanel("stats").querySelectorAll<HTMLElement>("thead th"),
      ).filter((th) => th.textContent === "Board.Database.StatsTable.Total");
      expect(totals).toHaveLength(2);
      await act(async () => totals[1].click());
      expect(store.get(explorerSortFamily(tabId))).toEqual({
        source: "comparison",
        direction: "desc",
      });
      expect(moveRows().map(([move]) => move)).toEqual([
        "d4",
        "h4",
        "e4",
        "Board.Database.StatsTable.Total",
      ]);
    });

    test("the Games switch lists the chosen source's games and opens them from its database", async () => {
      await act(async () => treeStore.getState().makeMove({ payload: "e4" }));
      const { store } = await mountCompared();
      const panel = regionPanel("games");
      await vi.waitFor(() => expect(panel.textContent).toContain("Mega player"));
      expect(panel.textContent).not.toContain("Corr player");
      const choices = Array.from(panel.querySelectorAll<HTMLInputElement>('input[type="radio"]'));
      expect(choices.map((choice) => choice.value)).toEqual(["primary", "comparison"]);
      expect(
        Array.from(
          panel.querySelectorAll(".mantine-SegmentedControl-label"),
          (label) => label.textContent,
        ),
      ).toEqual(["Saved reference", "Correspondence"]);
      await act(async () => choices[1].click());
      expect(store.get(explorerGamesSourceFamily(tabId))).toBe("comparison");
      await vi.waitFor(() => expect(panel.textContent).toContain("Corr player"));
      expect(panel.textContent).not.toContain("Mega player");
      const row = Array.from(panel.querySelectorAll<HTMLElement>("tbody tr")).find((item) =>
        item.textContent?.includes("Corr player"),
      )!;
      await act(async () => row.click());
      await vi.waitFor(() => expect(mocks.openDatabaseGame).toHaveBeenCalledOnce());
      expect(mocks.openDatabaseGame.mock.calls[0][0]).toMatchObject({
        database: corr,
        game: { id: 7 },
        targetFens: [afterE4],
      });
    });

    test("removing the comparison returns to one source and falls back to the primary's games", async () => {
      const { store } = await mountCompared();
      await act(async () => store.set(explorerGamesSourceFamily(tabId), "comparison"));
      const remove = sources()[1].querySelector<HTMLButtonElement>(
        'button[aria-label="Board.Database.RemoveComparison"]',
      )!;
      await act(async () => remove.click());
      expect(store.get(comparisonDbAtom)).toBeNull();
      expect(localStorage.getItem("comparison-database")).toBe("null");
      expect(sources()).toHaveLength(1);
      expect(compareButton()).toBeDefined();
      const panel = regionPanel("games");
      expect(panel.querySelector('input[type="radio"]')).toBeNull();
      await vi.waitFor(() => expect(panel.textContent).toContain("Mega player"));
      // The stored games choice stays the tab's; only the shown source is derived.
      expect(store.get(explorerGamesSourceFamily(tabId))).toBe("comparison");
    });

    test.each([
      ["the primary", reference, "Saved reference", "Correspondence"],
      ["the comparison", corr, "Correspondence", "Saved reference"],
    ] as const)(
      "a failed search of %s is named and leaves the other source and every control",
      async (_name, failing, failedName, _otherName) => {
        await mountCompared({ failing });
        const panel = regionPanel("stats");
        await vi.waitFor(() => expect(panel.querySelector('[role="alert"]')).not.toBeNull());
        const alerts = Array.from(
          panel.querySelectorAll('[role="alert"]'),
          (alert) => alert.textContent,
        );
        expect(alerts).toHaveLength(1);
        expect(alerts[0]).toMatch(new RegExp(`^${failedName}: `));
        expect(panel.querySelector("table")).not.toBeNull();
        const failedIsPrimary = failing === reference;
        await vi.waitFor(() =>
          expect(
            moveRows().map(([move, primary, , , comparison]) => [move, primary, comparison]),
          ).toEqual(
            failedIsPrimary
              ? [
                  ["d4", "", "60%12"],
                  ["h4", "", "40%8"],
                  ["Board.Database.StatsTable.Total", "", "20"],
                ]
              : [
                  ["e4", "71%100", ""],
                  ["d4", "29%40", ""],
                  ["Board.Database.StatsTable.Total", "140", ""],
                ],
          ),
        );
        expect(sources()).toHaveLength(2);

        const games = regionPanel("games");
        const choices = Array.from(games.querySelectorAll<HTMLInputElement>('input[type="radio"]'));
        expect(choices).toHaveLength(2);
        // The primary is listed first: its failure replaces only its own games.
        expect(!!games.querySelector('[role="alert"]')).toBe(failedIsPrimary);
        expect(!!games.querySelector("table")).toBe(!failedIsPrimary);
        await act(async () => choices[1].click());
        expect(!!games.querySelector('[role="alert"]')).toBe(!failedIsPrimary);
        expect(!!games.querySelector("table")).toBe(failedIsPrimary);
        expect(games.querySelectorAll('input[type="radio"]')).toHaveLength(2);
      },
    );

    test("when both searches fail, each source is named and no table is shown", async () => {
      mocks.getDatabases.mockResolvedValue(databaseList([readable, corrInfo]));
      mocks.searchPosition.mockRejectedValue(new Error("search failed"));
      localStorage.setItem("comparison-database", JSON.stringify(corr));
      await mountLocal();
      const panel = regionPanel("stats");
      await vi.waitFor(() => expect(panel.querySelectorAll('[role="alert"]')).toHaveLength(2));
      expect(
        Array.from(
          panel.querySelectorAll('[role="alert"]'),
          (alert) => alert.textContent?.split(":")[0],
        ),
      ).toEqual(["Saved reference", "Correspondence"]);
      expect(panel.querySelector("table")).toBeNull();
      expect(sources()).toHaveLength(2);
    });

    test("a pinned tab shows one source and searches no comparison although one is stored", async () => {
      const { store } = await mountCompared({ pin: reference });
      expect(sources()).toHaveLength(1);
      expect(searchesOf(corr)).toHaveLength(0);
      expect(compareButton()).toBeUndefined();
      expect(container.textContent).not.toContain("Board.Database.ComparisonUnreadable");
      expect(store.get(comparisonDbAtom)).toEqual(corr);
    });

    describe("a pinned tab with a second database of its own", () => {
      /** Pinned to the reference with player 42; the app-wide comparison is the third database. */
      async function mountPinnedPair(list: ManagedDatabaseInfo[] = [readable, corrInfo, third]) {
        mocks.getDatabases.mockResolvedValue(databaseList(list));
        mocks.searchPosition.mockImplementation(
          async (file: DatabaseHandle) => answers[databaseHandleKey(file)] ?? [[], []],
        );
        localStorage.setItem("comparison-database", JSON.stringify(third.file));
        const mounted = await mountLocal(reference, 42);
        await act(async () =>
          mounted.store.set(pinnedExplorerComparisonFamily(tabId), { database: corr, player: 7 }),
        );
        await act(async () => {});
        return mounted;
      }
      const sourceFilters = async (index: number) => {
        const button = sources()[index].querySelector<HTMLButtonElement>(
          "button[aria-haspopup='dialog']",
        )!;
        await act(async () => button.click());
        return vi.waitFor(() => {
          const found = document.querySelector<HTMLElement>("[data-explorer-filters]");
          expect(found).not.toBeNull();
          return found!;
        });
      };
      const expectGlobalChoiceUntouched = (store: ReturnType<typeof createJotaiStore>) => {
        expect(store.get(comparisonDbAtom)).toEqual(third.file);
        expect(JSON.parse(localStorage.getItem("comparison-database")!)).toEqual(third.file);
      };

      test("the second column searches its database for its own player with the tab's filters", async () => {
        const { store } = await mountPinnedPair();
        await vi.waitFor(() => expect(sources()).toHaveLength(2));

        await vi.waitFor(() => expect(searchesOf(corr)).not.toHaveLength(0));
        const [, query, progress] = searchesOf(corr).at(-1)!;
        expect(query).toMatchObject({
          player1: 7,
          wantedResult: "draw",
          range1: [1800, 2400],
          excludeFastEvents: true,
        });
        expect(progress).toBe(`${tabId}:comparison`);
        expect(searchesOf(reference).at(-1)![1].player1).toBe(42);
        // The app-wide comparison is another database: it is neither searched nor changed.
        expect(searchesOf(third.file)).toHaveLength(0);
        expectGlobalChoiceUntouched(store);
        // The tab's own options keep the primary's player.
        expect(store.get(localOptionsFamily(tabId))).toMatchObject({
          player: 42,
          player_database: databaseHandleKey(reference),
        });
      });

      test("the second column is named by its database and offers no other one", async () => {
        await mountPinnedPair();
        await vi.waitFor(() => expect(sources()).toHaveLength(2));

        expect(sources()[0].querySelector(".mantine-Select-input")).not.toBeNull();
        expect(sources()[1].querySelector(".mantine-Select-input")).toBeNull();
        expect(sources()[1].textContent).toContain("Correspondence");
        expect(compareButton()).toBeUndefined();
      });

      test("its remove button clears the tab's second database and nothing app-wide", async () => {
        const { store } = await mountPinnedPair();
        await vi.waitFor(() => expect(sources()).toHaveLength(2));
        const remove = sources()[1].querySelector<HTMLButtonElement>(
          'button[aria-label="Board.Database.RemoveComparison"]',
        )!;
        await act(async () => remove.click());

        expect(store.get(pinnedExplorerComparisonFamily(tabId))).toBeNull();
        expectGlobalChoiceUntouched(store);
        expect(sources()).toHaveLength(1);
        expect(store.get(pinnedExplorerDatabaseFamily(tabId))).toEqual(reference);
      });

      test("the second column's filters have no player input, the first column's keep theirs", async () => {
        await mountPinnedPair();
        await vi.waitFor(() => expect(sources()).toHaveLength(2));

        const second = await sourceFilters(1);
        expect(second.querySelector(".mantine-Autocomplete-input")).toBeNull();
        expect(second.querySelector('input[type="radio"]')).not.toBeNull();
        await act(async () =>
          sources()[1].querySelector<HTMLButtonElement>("button[aria-haspopup='dialog']")!.click(),
        );
        await vi.waitFor(() =>
          expect(document.querySelector("[data-explorer-filters]")).toBeNull(),
        );
        const first = await sourceFilters(0);
        expect(first.querySelector(".mantine-Autocomplete-input")).not.toBeNull();
      });

      test("a colour chosen in the second column reaches both searches and keeps the first column's player", async () => {
        const { store } = await mountPinnedPair();
        await vi.waitFor(() => expect(sources()).toHaveLength(2));
        const filters = await sourceFilters(1);
        const black = Array.from(
          filters.querySelectorAll<HTMLInputElement>('input[type="radio"]'),
        ).find((radio) => radio.value === "black")!;
        expect(black.disabled).toBe(false);
        mocks.searchPosition.mockClear();
        await act(async () => black.click());

        expect(store.get(localOptionsFamily(tabId))).toMatchObject({
          color: "black",
          player: 42,
          player_database: databaseHandleKey(reference),
        });
        await vi.waitFor(() => expect(searchesOf(corr).at(-1)?.[1]).toMatchObject({ player2: 7 }));
        expect(searchesOf(corr).at(-1)![1].player1 ?? null).toBeNull();
        await vi.waitFor(() =>
          expect(searchesOf(reference).at(-1)?.[1]).toMatchObject({ player2: 42 }),
        );
        expect(store.get(pinnedExplorerComparisonFamily(tabId))).toEqual({
          database: corr,
          player: 7,
        });
      });

      test("an unreadable second database is named, and removing it clears the tab's choice only", async () => {
        const { store } = await mountPinnedPair([readable, { ...unreadable, file: corr }]);
        const alert = await vi.waitFor(() => {
          const found = Array.from(container.querySelectorAll<HTMLElement>('[role="alert"]')).find(
            (item) => item.textContent?.startsWith("Board.Database.ComparisonUnreadable"),
          );
          expect(found).toBeDefined();
          return found!;
        });
        expect(sources()).toHaveLength(1);
        expect(searchesOf(corr)).toHaveLength(0);
        await act(async () =>
          alert
            .querySelector<HTMLButtonElement>(
              'button[aria-label="Board.Database.RemoveComparison"]',
            )!
            .click(),
        );

        expect(store.get(pinnedExplorerComparisonFamily(tabId))).toBeNull();
        expectGlobalChoiceUntouched(store);
        expect(container.textContent).not.toContain("Board.Database.ComparisonUnreadable");
      });

      test("a second database that is no longer listed shows one column and no warning", async () => {
        const { store } = await mountPinnedPair([readable, third]);
        await vi.waitFor(() => expect(searchesOf(reference)).not.toHaveLength(0));

        expect(sources()).toHaveLength(1);
        expect(searchesOf(corr)).toHaveLength(0);
        expect(searchesOf(third.file)).toHaveLength(0);
        expect(container.textContent).not.toContain("Board.Database.ComparisonUnreadable");
        expect(store.get(pinnedExplorerComparisonFamily(tabId))).toEqual({
          database: corr,
          player: 7,
        });
      });

      describe("with the reference database enabled", () => {
        const refOpenings = [
          { move: "c4", white: 400, draw: 100, black: 100 },
          { move: "e4", white: 200, draw: 50, black: 50 },
        ];
        const mountPrepBoard = async ({
          withOnline = true,
          refHandle = third.file as DatabaseHandle | null,
          list = [readable, corrInfo, third] as ManagedDatabaseInfo[],
          savedRefFilters,
        }: {
          withOnline?: boolean;
          refHandle?: DatabaseHandle | null;
          list?: ManagedDatabaseInfo[];
          savedRefFilters?: Record<string, unknown>;
        } = {}) => {
          mocks.getDatabases.mockResolvedValue(databaseList(list));
          mocks.searchPosition.mockImplementation(async (file: DatabaseHandle, query) => {
            const key = databaseHandleKey(file);
            if (refHandle && key === databaseHandleKey(refHandle) && query.player1 !== 42) {
              return [refOpenings, []];
            }
            return answers[key] ?? [[], []];
          });
          const mounted = await mountLocal(reference, 42);
          await act(async () => {
            mounted.store.set(referenceDbAtom, refHandle);
            if (savedRefFilters && refHandle) {
              mounted.store.set(explorerDatabaseFiltersAtom, [
                {
                  database: databaseHandleKey(refHandle),
                  filters: savedRefFilters as ReturnType<typeof explorerFiltersFor>,
                },
              ]);
            }
            if (withOnline) {
              mounted.store.set(pinnedExplorerComparisonFamily(tabId), {
                database: corr,
                player: 7,
              });
            }
            mounted.store.set(pinnedExplorerFurtherColumnsFamily(tabId), ["reference"]);
          });
          await act(async () => {});
          return mounted;
        };

        test("appears with online games (3 columns) and without online games (2 columns)", async () => {
          await mountPrepBoard({ withOnline: true });
          await vi.waitFor(() => expect(sources()).toHaveLength(3));
          expect(sources()[2].textContent).toContain("Third");
          expect(container.textContent).toContain("c4");
          expect(searchesOf(third.file).at(-1)?.[2]).toBe(`${tabId}:reference`);

          // Games view keeps only primary and comparison — no third entry for the reference source.
          const gamesSwitch = Array.from(
            regionPanel("games").querySelectorAll<HTMLInputElement>('input[type="radio"]'),
          ).map((r) => r.value);
          expect(gamesSwitch).toContain("primary");
          expect(gamesSwitch).toContain("comparison");
          expect(gamesSwitch).not.toContain("reference");

          // Without online games: 2 columns (pinned + reference).
          await mountPrepBoard({ withOnline: false });
          await vi.waitFor(() => expect(sources()).toHaveLength(2));
          expect(sources()[1].textContent).toContain("Third");
          expect(container.textContent).toContain("c4");
        });

        test("sorts by reference, removes and brings back, and falls back sort when removed", async () => {
          const { store } = await mountPrepBoard({ withOnline: true });
          await vi.waitFor(() => expect(sources()).toHaveLength(3));

          const headers = () => Array.from(container.querySelectorAll<HTMLElement>("thead th"));
          // Click the reference source's Total header (column index 7).
          await act(async () => headers()[7].click());
          expect(store.get(explorerSortFamily(tabId)).source).toBe("reference");
          const rowsSortedByRef = () =>
            Array.from(container.querySelectorAll<HTMLTableRowElement>("tbody tr")).map(
              (tr) => tr.querySelector("td")?.textContent,
            );
          expect(rowsSortedByRef()[0]).toBe("c4");

          // Remove reference source: sort falls back to primary while stored sort is kept.
          const removeRef = sources()[2].querySelector<HTMLButtonElement>(
            'button[aria-label="Board.Database.RemoveReference"]',
          )!;
          await act(async () => removeRef.click());
          expect(store.get(pinnedExplorerFurtherColumnsFamily(tabId))).toEqual([]);
          expect(sources()).toHaveLength(2);
          expect(store.get(explorerSortFamily(tabId)).source).toBe("reference");
          expect(rowsSortedByRef()[0]).not.toBe("c4");

          // Restore the reference source from the further-column control: stored sort applies again.
          const add = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
            (b) => b.textContent === "Board.Database.AddColumn",
          )!;
          expect(add.getAttribute("aria-label")).toBe("Board.Database.AddColumn");
          await act(async () => add.click());
          const restore = await vi.waitFor(() => {
            const item = Array.from(
              document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
            ).find((entry) => entry.textContent === "Third database");
            expect(item).toBeDefined();
            return item!;
          });
          await act(async () => restore.click());
          await vi.waitFor(() => expect(sources()).toHaveLength(3));
          expect(rowsSortedByRef()[0]).toBe("c4");
        });

        test("is absent without a reference database", async () => {
          await mountPrepBoard({ withOnline: false, refHandle: null });
          await vi.waitFor(() => expect(searchesOf(reference)).not.toHaveLength(0));
          expect(sources()).toHaveLength(1);
          expect(container.querySelector('[role="alert"]')).toBeNull();
        });

        test("is absent without error when the reference database is unreadable", async () => {
          await mountPrepBoard({
            withOnline: false,
            refHandle: third.file,
            list: [readable, { ...unreadable, file: third.file }],
          });
          await vi.waitFor(() => expect(searchesOf(reference)).not.toHaveLength(0));
          expect(sources()).toHaveLength(1);
          expect(container.querySelector('[role="alert"]')).toBeNull();
        });

        test("accepts the same database as the pinned one", async () => {
          await mountPrepBoard({ withOnline: false, refHandle: reference });
          await vi.waitFor(() => expect(sources()).toHaveLength(2));
          expect(sources()[1].textContent).toContain("Saved reference");
          // Both the pinned search (player 42) and the reference search (no player) ran.
          const refSearches = searchesOf(reference);
          expect(refSearches.some(([, q]) => q.player1 === 42)).toBe(true);
          expect(
            refSearches.some(([, q, p]) => q.player1 == null && p === `${tabId}:reference`),
          ).toBe(true);
        });

        test("keeps a saved player filter and writes filter edits to saved filters only", async () => {
          const { store } = await mountPrepBoard({
            withOnline: false,
            refHandle: third.file,
            savedRefFilters: {
              player: 99,
              color: "white",
              result: "any",
            },
          });
          await vi.waitFor(() => expect(sources()).toHaveLength(2));
          await vi.waitFor(() =>
            expect(searchesOf(third.file).at(-1)?.[1]).toMatchObject({ player1: 99 }),
          );
          expect(store.get(localOptionsFamily(tabId)).color).toBe("white");

          // Edit color in the reference source's filter popover away from the tab's colour:
          // updates saved filters only.
          const filters = await sourceFilters(1);
          const black = Array.from(
            filters.querySelectorAll<HTMLInputElement>('input[type="radio"]'),
          ).find((radio) => radio.value === "black")!;
          await act(async () => black.click());

          expect(
            explorerFiltersFor(
              store.get(explorerDatabaseFiltersAtom),
              databaseHandleKey(third.file),
            ),
          ).toMatchObject({ player: 99, color: "black" });
          // Tab's own options, colour and opponent player are untouched.
          expect(store.get(localOptionsFamily(tabId))).toMatchObject({
            color: "white",
            player: 42,
            player_database: databaseHandleKey(reference),
          });
        });

        test("adds, removes, and limits further Lichess columns through one control", async () => {
          mocks.getLichessGames.mockResolvedValue(mockExplorerData);
          mocks.getPublicLichessJson.mockResolvedValue(`[White "W1"]\n[Black "B1"]\n\n1. d4 d5 *`);
          mocks.lexPgn.mockResolvedValue([
            { type: "Header", value: { tag: "White", value: "W1" } },
            { type: "Header", value: { tag: "Black", value: "B1" } },
          ]);
          const { store } = await mountPrepBoard({ withOnline: true });
          await act(async () => store.set(sessionsAtom, [validSession]));
          await vi.waitFor(() => expect(sources()).toHaveLength(3));
          expect(addColumnButton()).toBeUndefined();

          const removeRef = sources()[2].querySelector<HTMLButtonElement>(
            'button[aria-label="Board.Database.RemoveReference"]',
          )!;
          await act(async () => removeRef.click());
          expect(sources()).toHaveLength(2);
          const add = addColumnButton()!;
          expect(add.getAttribute("aria-label")).toBe("Board.Database.AddColumn");
          await act(async () => add.click());
          const furtherItems = await vi.waitFor(() => {
            const found = menuChoices();
            expect(found).not.toHaveLength(0);
            return found;
          });
          expect(furtherItems).toEqual([
            "Third database",
            "Board.Database.LichessAll",
            "Board.Database.LichessMaster",
          ]);
          await act(async () =>
            Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'))
              .find((item) => item.textContent === "Board.Database.LichessAll")!
              .click(),
          );
          await vi.waitFor(() => expect(sources()).toHaveLength(3));
          expect(sources()[2].textContent).toContain("Board.Database.LichessAll");
          expect(
            sources()[2].querySelector('button[aria-label="Board.Database.RemoveColumn"]'),
          ).not.toBeNull();
          expect(
            sources()[2].querySelector('button[aria-label="Board.Database.RemoveComparison"]'),
          ).toBeNull();
          expect(container.querySelector('[data-sources="3"]')).not.toBeNull();
          expect(addColumnButton()).toBeUndefined();
          expect(store.get(pinnedExplorerFurtherColumnsFamily(tabId))).toEqual(["lch_all"]);

          const games = regionPanel("games");
          const gamesSwitch = Array.from(
            games.querySelectorAll<HTMLInputElement>('input[type="radio"]'),
          ).map((radio) => radio.value);
          expect(gamesSwitch).toEqual(["primary", "comparison"]);
        });

        test("collapsing the header shows a caption for the reference source", async () => {
          await mountPrepBoard({ withOnline: true });
          await vi.waitFor(() => expect(sources()).toHaveLength(3));

          const hide = container.querySelector<HTMLButtonElement>(
            'button[aria-label="Board.Database.HideSettings"]',
          )!;
          await act(async () => hide.click());

          const captions = sources().map((el) => el.textContent);
          expect(captions).toHaveLength(3);
          expect(captions[2]).toContain("Third");
        });

        const mockReferenceReplacement = () => {
          const successor: DatabaseHandle = { id: { id: "third-successor" }, kind: "database" };
          const successorInfo: ManagedDatabaseInfo = {
            ...third,
            file: successor,
            title: "Third v2",
          };
          mocks.collectionForDatabase.mockImplementation(async (file: DatabaseHandle) =>
            databaseHandleKey(file) === databaseHandleKey(third.file)
              ? {
                  id: "66666666-6666-4666-8666-666666666666",
                  name: "Reference collection",
                  file: { id: { id: "library" }, kind: "fileWorkspace" },
                  database: successor,
                  account: null,
                  status: "ready",
                  generation: "g2",
                  omitted: 0,
                  retiredDatabase: third.file,
                  fetchSinceMs: null,
                }
              : null,
          );
          return { successor, successorInfo };
        };

        test("follows a linked-collection replacement of the reference database while shown", async () => {
          const { successor, successorInfo } = mockReferenceReplacement();
          const { store } = await mountPrepBoard({
            withOnline: false,
            refHandle: third.file,
            list: [readable, successorInfo],
          });
          await vi.waitFor(() => expect(store.get(referenceDbAtom)).toEqual(successor));
          await vi.waitFor(() => expect(sources()).toHaveLength(2));
          expect(sources()[1].textContent).toContain("Third v2");
        });

        test("follows a linked-collection replacement of the reference database while the column is removed so restore stays available", async () => {
          const { successor, successorInfo } = mockReferenceReplacement();
          mocks.getDatabases.mockResolvedValue(databaseList([readable, successorInfo]));
          mocks.searchPosition.mockImplementation(
            async (file: DatabaseHandle) => answers[databaseHandleKey(file)] ?? [[], []],
          );
          const { store } = await mountLocal(reference, 42);
          await act(async () => {
            store.set(referenceDbAtom, third.file);
            store.set(pinnedExplorerFurtherColumnsFamily(tabId), []);
          });
          await vi.waitFor(() => expect(store.get(referenceDbAtom)).toEqual(successor));
          const restore = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
            (b) => b.textContent === "Board.Database.AddColumn",
          );
          expect(restore).toBeDefined();
        });
      });
    });

    test("without a primary database no comparison is searched or shown", async () => {
      await mountCompared({ list: [corrInfo] });
      expectNoReference();
      expect(sources()).toHaveLength(1);
      expect(searchesOf(corr)).toHaveLength(0);
      expect(compareButton()).toBeUndefined();
    });

    test.each([
      ["the primary database itself", reference, [readable, corrInfo]],
      ["missing from the list", corr, [readable, third]],
    ] as const)(
      "a stored comparison that is %s is not shown, and the compare control replaces it",
      async (_name, stored, list) => {
        mocks.getDatabases.mockResolvedValue(databaseList([...list]));
        localStorage.setItem("comparison-database", JSON.stringify(stored));
        const { store } = await mountLocal();
        await act(async () => {});
        expect(sources()).toHaveLength(1);
        expect(store.get(comparisonDbAtom)).toEqual(stored);
        const compare = compareButton()!;
        expect(compare.getAttribute("aria-label")).toBe("Board.Database.CompareWith");
        await act(async () => compare.click());
        const items = await vi.waitFor(() => {
          const found = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'));
          expect(found).not.toHaveLength(0);
          return found;
        });
        // Every other readable database is offered, never the primary one, plus both Lichess sources.
        expect(items.map((item) => item.textContent)).toEqual([
          list[1].title,
          "Board.Database.LichessAll",
          "Board.Database.LichessMaster",
        ]);
        mocks.clearGames.mockRejectedValue(new Error("cache unavailable"));
        await act(async () => items[0].click());
        expect(store.get(comparisonDbAtom)).toEqual(list[1].file);
        expect(sources()).toHaveLength(2);
      },
    );

    test("an unreadable comparison database is named with its remove control and keeps one source", async () => {
      const { store } = await mountCompared({ list: [readable, { ...unreadable, file: corr }] });
      const alert = Array.from(container.querySelectorAll<HTMLElement>('[role="alert"]')).find(
        (item) => item.textContent?.startsWith("Board.Database.ComparisonUnreadable"),
      )!;
      expect(alert.textContent).toBe("Board.Database.ComparisonUnreadable reference.db3");
      expect(sources()).toHaveLength(1);
      expect(searchesOf(corr)).toHaveLength(0);
      expect(compareButton()).toBeUndefined();
      await vi.waitFor(() => expect(searchesOf(reference)).not.toHaveLength(0));
      const remove = alert.querySelector<HTMLButtonElement>(
        'button[aria-label="Board.Database.RemoveComparison"]',
      )!;
      await act(async () => remove.click());
      expect(store.get(comparisonDbAtom)).toBeNull();
      expect(container.textContent).not.toContain("Board.Database.ComparisonUnreadable");
      expect(compareButton()).toBeDefined();
    });

    test("the comparison select changes the comparison alone and never offers the primary", async () => {
      const { store } = await mountCompared();
      const select = sources()[1].querySelector<HTMLInputElement>(".mantine-Select-input")!;
      expect(select.getAttribute("aria-label")).toBe("Board.Database.CompareWith");
      await act(async () => select.click());
      const options = Array.from(
        sources()[1].ownerDocument.querySelectorAll<HTMLElement>('[role="option"]'),
      ).filter(
        (option) => option.closest('[role="listbox"]')?.id === select.getAttribute("aria-controls"),
      );
      expect(options.map((option) => option.textContent)).toEqual([
        "Correspondence",
        "Third database",
        "Board.Database.LichessAll",
        "Board.Database.LichessMaster",
      ]);
      await act(async () => options[1].click());
      expect(store.get(comparisonDbAtom)).toEqual(third.file);
      expect(JSON.parse(localStorage.getItem("comparison-database")!)).toEqual(third.file);
      expect(store.get(referenceDbAtom)).toEqual(reference);
      expect(mocks.clearGames).toHaveBeenCalledOnce();
      await vi.waitFor(() => expect(searchesOf(third.file)).not.toHaveLength(0));
      expect(searchesOf(third.file).at(-1)?.[2]).toBe(`${tabId}:comparison`);
    });

    test.each([
      ["a pinned tab", { pin: reference }],
      ["no primary database", {}],
    ] as const)("an unreadable stored comparison stays silent in %s", async (_name, options) => {
      const pinned = "pin" in options;
      await mountCompared({
        ...options,
        list: pinned ? [readable, { ...unreadable, file: corr }] : [{ ...unreadable, file: corr }],
      });
      expect(container.textContent).not.toContain("Board.Database.ComparisonUnreadable");
      expect(sources()).toHaveLength(1);
      expect(searchesOf(corr)).toHaveLength(0);
      expect({
        noReference: container.textContent?.includes("Board.Database.NoReference1"),
      }).toEqual({ noReference: !pinned });
    });

    test("without a tab id each source falls back to its own progress id", async () => {
      mocks.getDatabases.mockResolvedValue(databaseList([readable, corrInfo]));
      mocks.searchPosition.mockResolvedValue([[], []]);
      localStorage.setItem("reference-database", JSON.stringify(reference));
      localStorage.setItem("comparison-database", JSON.stringify(corr));
      const store = createJotaiStore();
      // The scope names a tab the workspace does not list, so the panel has no tab id.
      store.set(tabsAtom, []);
      store.set(dbTypeFamily(tabId), "local");
      await renderPanel(store, {
        provider: () => new Map(),
        dedupingInterval: 0,
        shouldRetryOnError: false,
        revalidateOnFocus: false,
        revalidateOnReconnect: false,
      });
      await vi.waitFor(() => {
        expect(searchesOf(reference)).not.toHaveLength(0);
        expect(searchesOf(corr)).not.toHaveLength(0);
      });
      const primaryId = searchesOf(reference).at(-1)![2] as string;
      const comparisonId = searchesOf(corr).at(-1)![2] as string;
      expect(primaryId).toMatch(/^local-explorer:/);
      expect(comparisonId).toMatch(/^local-explorer:/);
      expect(comparisonId).not.toBe(primaryId);
    });

    test("a comparison its collection replaced while the panel was closed is followed on mount", async () => {
      const current: DatabaseHandle = { id: { id: "regenerated-corr" }, kind: "database" };
      mocks.collectionForDatabase.mockImplementation(async (file: DatabaseHandle) =>
        databaseHandleKey(file) === databaseHandleKey(corr)
          ? {
              id: "66666666-6666-4666-8666-666666666666",
              name: "Correspondence",
              file: { id: { id: "library" }, kind: "fileWorkspace" },
              database: current,
              account: null,
              status: "ready",
              generation: "g2",
              omitted: 0,
              retiredDatabase: corr,
              fetchSinceMs: null,
            }
          : null,
      );
      // The retired database is no longer listed; only its collection knows the successor.
      const { store } = await mountCompared({
        list: [readable, { ...corrInfo, file: current, title: "Regenerated" }],
      });
      await vi.waitFor(() => expect(store.get(comparisonDbAtom)).toEqual(current));
      await vi.waitFor(() => expect(sources()).toHaveLength(2));
      expect(sources()[1].querySelector<HTMLInputElement>(".mantine-Select-input")?.value).toBe(
        "Regenerated",
      );
      expect(store.get(referenceDbAtom)).toEqual(reference);
    });

    test("the position dialog's match mode reaches both sources", async () => {
      const { store } = await mountCompared();
      mocks.searchPosition.mockClear();
      await act(async () =>
        store.set(localOptionsFamily(tabId), (options) => ({ ...options, type: "partial" })),
      );
      await vi.waitFor(() => {
        expect(searchesOf(reference).at(-1)?.[1].position.type_).toBe("partial");
        expect(searchesOf(corr).at(-1)?.[1].position.type_).toBe("partial");
      });
      regionPanel("games");
    });

    test("a collection that publishes a new comparison database moves the choice and its filters", async () => {
      const current: DatabaseHandle = { id: { id: "regenerated-corr" }, kind: "database" };
      mocks.collectionForDatabase.mockImplementation(async (file: DatabaseHandle) =>
        databaseHandleKey(file) === databaseHandleKey(corr)
          ? {
              id: "66666666-6666-4666-8666-666666666666",
              name: "Correspondence",
              file: { id: { id: "library" }, kind: "fileWorkspace" },
              database: current,
              account: null,
              status: "ready",
              generation: "g2",
              omitted: 0,
              retiredDatabase: corr,
              fetchSinceMs: null,
            }
          : null,
      );
      localStorage.setItem(
        "explorer-database-filters",
        JSON.stringify([
          {
            database: databaseHandleKey(corr),
            filters: { player: 4, color: "black", result: "whitewon" },
          },
        ]),
      );
      mocks.getDatabases.mockResolvedValue(
        databaseList([readable, corrInfo, { ...corrInfo, file: current, title: "Regenerated" }]),
      );
      mocks.searchPosition.mockResolvedValue([[], []]);
      localStorage.setItem("comparison-database", JSON.stringify(corr));
      // The reference keeps no saved filters here, so the comparison's entry is the only one.
      const store = createJotaiStore();
      store.set(tabsAtom, [validTab]);
      store.set(activeTabAtom, tabId);
      store.set(dbTypeFamily(tabId), "local");
      localStorage.setItem("reference-database", JSON.stringify(reference));
      await renderPanel(store, {
        provider: () => new Map(),
        dedupingInterval: 0,
        shouldRetryOnError: false,
        revalidateOnFocus: false,
        revalidateOnReconnect: false,
      });
      await vi.waitFor(() => expect(store.get(comparisonDbAtom)).toEqual(current));
      expect(store.get(referenceDbAtom)).toEqual(reference);
      expect(store.get(explorerDatabaseFiltersAtom)).toEqual([
        {
          database: databaseHandleKey(current),
          filters: { player: null, color: "white", result: "whitewon" },
        },
      ]);
      await vi.waitFor(() =>
        expect(searchesOf(current).at(-1)?.[1]).toMatchObject({ wantedResult: "whitewon" }),
      );
    });

    const mockOnlineGames = (
      data: {
        topGames?: { id: string; white: { name: string }; black: { name: string } }[];
        recentGames?: { id: string; white: { name: string }; black: { name: string } }[];
      } = mockExplorerData,
      rejectedIds: string[] = [],
    ) => {
      mocks.getLichessGames.mockResolvedValue(data);
      mocks.getMasterGames.mockResolvedValue(data);
      mocks.getPublicLichessJson.mockImplementation(async ({ game_id }: { game_id: string }) => {
        if (rejectedIds.includes(game_id)) throw new Error("sample-fetch-diagnostic");
        const game = [...(data.topGames ?? []), ...(data.recentGames ?? [])].find(
          (entry) => entry.id === game_id,
        );
        const white = game?.white.name ?? "W1";
        const black = game?.black.name ?? "B1";
        return `[White "${white}"]\n[Black "${black}"]\n\n1. d4 d5 *`;
      });
      mocks.lexPgn.mockImplementation(async (pgn: string) =>
        [...pgn.matchAll(/\[(White|Black) "([^"]*)"\]/g)].map(([, tag, value]) => ({
          type: "Header",
          value: { tag, value },
        })),
      );
    };

    async function mountMixed({
      first = "local" as "local" | "lch_all" | "lch_master",
      comparison = "lch_all" as string | DatabaseHandle | null,
      session = true,
      list = [readable, corrInfo, third] as ManagedDatabaseInfo[],
      rejectedIds = [] as string[],
      lichess = mockExplorerData,
      masters = mockExplorerData,
    } = {}) {
      mocks.getDatabases.mockResolvedValue(databaseList(list));
      mocks.searchPosition.mockImplementation(async (file: DatabaseHandle) => {
        return answers[databaseHandleKey(file)] ?? [[], []];
      });
      mockOnlineGames(lichess, rejectedIds);
      mocks.getMasterGames.mockResolvedValue(masters);
      if (comparison !== undefined) {
        localStorage.setItem("comparison-database", JSON.stringify(comparison));
      }
      const mounted = await mountLocal();
      await act(async () => {
        if (session) mounted.store.set(sessionsAtom, [validSession]);
        if (first !== "local") mounted.store.set(dbTypeFamily(tabId), first);
      });
      await act(async () => {});
      return mounted;
    }

    test.each([
      {
        name: "a populated list",
        setup: () => mocks.getDatabases.mockResolvedValue(databaseList([readable])),
        groups: ["Board.Database.Databases", "Board.Database.Online"],
        options: ["Saved reference", "Board.Database.LichessAll", "Board.Database.LichessMaster"],
      },
      {
        name: "an empty list",
        setup: () => mocks.getDatabases.mockResolvedValue(databaseList([])),
        groups: ["Board.Database.Online"],
        options: ["Board.Database.LichessAll", "Board.Database.LichessMaster"],
      },
      {
        name: "a pending list",
        setup: () => mocks.getDatabases.mockReturnValue(new Promise(() => undefined)),
        groups: ["Board.Database.Online"],
        options: ["Board.Database.LichessAll", "Board.Database.LichessMaster"],
      },
      {
        name: "a failed list",
        setup: () => mocks.getDatabases.mockRejectedValue(new Error("list failed")),
        groups: ["Board.Database.Online"],
        options: ["Board.Database.LichessAll", "Board.Database.LichessMaster"],
      },
    ])(
      "the first select groups the readable local databases and always offers the Online group with $name",
      async ({ setup, groups, options }) => {
        setup();
        await mountLocal();
        const select = container.querySelector<HTMLInputElement>(".mantine-Select-input")!;
        await act(async () => select.click());
        expect(listedGroups(select)).toEqual(groups);
        expect(listedOptions(select).map((option) => option.textContent)).toEqual(options);
      },
    );

    test("choosing Lichess in the first select leaves the reference database unchanged", async () => {
      mockOnlineGames();
      mocks.getDatabases.mockResolvedValue(databaseList([readable]));
      const { store } = await mountLocal();
      await act(async () => store.set(sessionsAtom, [validSession]));
      const select = container.querySelector<HTMLInputElement>(".mantine-Select-input")!;
      await act(async () => select.click());
      const lichess = listedOptions(select).find(
        (option) => option.textContent === "Board.Database.LichessAll",
      )!;
      await act(async () => lichess.click());
      expect(store.get(dbTypeFamily(tabId))).toBe("lch_all");
      expect(store.get(referenceDbAtom)).toEqual(reference);
      expect(JSON.parse(localStorage.getItem("reference-database")!)).toEqual(reference);
      expect(positionControl()).toBeUndefined();
    });

    test("choosing a local database after Lichess All writes the first source back to local", async () => {
      mockOnlineGames();
      mocks.getDatabases.mockResolvedValue(databaseList([readable, corrInfo]));
      const { store } = await mountLocal();
      await act(async () => store.set(sessionsAtom, [validSession]));
      const select = container.querySelector<HTMLInputElement>(".mantine-Select-input")!;
      await act(async () => select.click());
      const lichess = listedOptions(select).find(
        (option) => option.textContent === "Board.Database.LichessAll",
      )!;
      await act(async () => lichess.click());
      expect(store.get(dbTypeFamily(tabId))).toBe("lch_all");
      await act(async () => select.click());
      const local = listedOptions(select).find(
        (option) => option.textContent === "Correspondence",
      )!;
      await act(async () => local.click());
      expect(store.get(dbTypeFamily(tabId))).toBe("local");
      expect(store.get(referenceDbAtom)).toEqual(corr);
    });

    test("a pinned first select offers local databases only", async () => {
      await mountCompared({ pin: reference });
      const select = sources()[0].querySelector<HTMLInputElement>(".mantine-Select-input")!;
      await act(async () => select.click());
      expect(listedOptions(select).map((option) => option.textContent)).toEqual([
        "Saved reference",
        "Correspondence",
        "Third database",
      ]);
    });

    test("local beside Lichess shows both columns, Lichess totals, and a dash for an unlisted move", async () => {
      const { store } = await mountMixed();
      await vi.waitFor(() => expect(sources()).toHaveLength(2));
      expect(
        sources().map(
          (source) =>
            source.querySelector<HTMLInputElement>(".mantine-Select-input")?.value ??
            source.textContent,
        ),
      ).toEqual(["Saved reference", "Board.Database.LichessAll"]);
      expect(positionControl()).toBeDefined();
      await vi.waitFor(() =>
        expect(
          moveRows().map(([move, primary, , , comparison]) => [move, primary, comparison]),
        ).toEqual([
          ["e4", "71%100", "50%100"],
          ["d4", "29%40", "–"],
          ["Board.Database.StatsTable.Total", "140", "200"],
        ]),
      );
      expect(store.get(referenceDbAtom)).toEqual(reference);
      expect(mocks.getLichessGames).toHaveBeenCalled();
      expect(searchesOf(reference).at(-1)?.[1].position.fen).toBe(
        treeStore.getState().currentNode().fen,
      );
    });

    test("Lichess beside a local database searches the local column with the board position", async () => {
      await mountMixed({ first: "lch_all", comparison: reference });
      await vi.waitFor(() => expect(sources()).toHaveLength(2));
      expect(positionControl()).toBeDefined();
      await vi.waitFor(() => expect(searchesOf(reference)).not.toHaveLength(0));
      const startFen = treeStore.getState().currentNode().fen;
      expect(searchesOf(reference).at(-1)?.[1].position.fen).toBe(startFen);
      await act(async () => treeStore.getState().makeMove({ payload: "e4" }));
      await act(async () => new Promise((resolve) => setTimeout(resolve, 80)));
      await vi.waitFor(() =>
        expect(searchesOf(reference).at(-1)?.[1].position.fen).toBe(
          treeStore.getState().currentNode().fen,
        ),
      );
      expect(treeStore.getState().currentNode().fen).toBe(afterE4);
      await vi.waitFor(() =>
        expect(
          moveRows().map(([move, primary, , , comparison]) => [move, primary, comparison]),
        ).toEqual([
          ["e4", "50%100", "71%100"],
          ["d4", "–", "29%40"],
          ["Board.Database.StatsTable.Total", "200", "140"],
        ]),
      );
    });

    test("both Lichess sources sit side by side while the database list is pending", async () => {
      mocks.getDatabases.mockReturnValue(new Promise(() => undefined));
      mockOnlineGames();
      const masters = {
        ...mockExplorerData,
        white: 10,
        black: 5,
        draws: 5,
        moves: [{ uci: "d2d4", san: "d4", averageRating: 2200, white: 8, black: 1, draws: 1 }],
      };
      mocks.getMasterGames.mockResolvedValue(masters);
      localStorage.setItem("comparison-database", JSON.stringify("lch_master"));
      const store = createJotaiStore();
      store.set(tabsAtom, [validTab]);
      store.set(activeTabAtom, tabId);
      store.set(dbTypeFamily(tabId), "lch_all");
      store.set(sessionsAtom, [validSession]);
      await renderPanel(store, {
        provider: () => new Map(),
        dedupingInterval: 0,
        shouldRetryOnError: false,
        revalidateOnFocus: false,
        revalidateOnReconnect: false,
      });
      await vi.waitFor(() => expect(sources()).toHaveLength(2));
      expect(positionControl()).toBeUndefined();
      await vi.waitFor(() =>
        expect(
          moveRows().map(([move, primary, , , comparison]) => [move, primary, comparison]),
        ).toEqual([
          ["e4", "50%100", "–"],
          ["d4", "–", "50%10"],
          ["Board.Database.StatsTable.Total", "200", "20"],
        ]),
      );
      expect(mocks.getLichessGames).toHaveBeenCalled();
      expect(mocks.getMasterGames).toHaveBeenCalled();
    });

    test("a failing Lichess column is named and leaves the local column", async () => {
      mocks.getLichessGames.mockRejectedValue(new Error("lichess down"));
      mocks.getDatabases.mockResolvedValue(databaseList([readable]));
      mocks.searchPosition.mockImplementation(async (file: DatabaseHandle) => {
        return answers[databaseHandleKey(file)] ?? [[], []];
      });
      localStorage.setItem("comparison-database", JSON.stringify("lch_all"));
      const { store } = await mountLocal();
      await act(async () => store.set(sessionsAtom, [validSession]));
      const panel = regionPanel("stats");
      await vi.waitFor(() => expect(panel.querySelector('[role="alert"]')).not.toBeNull());
      expect(panel.querySelector('[role="alert"]')?.textContent).toMatch(
        /^Board.Database.LichessAll: /,
      );
      expect(panel.querySelector("table")).not.toBeNull();
      await vi.waitFor(() =>
        expect(
          moveRows().map(([move, primary, , , comparison]) => [move, primary, comparison]),
        ).toEqual([
          ["e4", "71%100", ""],
          ["d4", "29%40", ""],
          ["Board.Database.StatsTable.Total", "140", ""],
        ]),
      );
    });

    test("one sign-in notice covers both Lichess columns and no table is shown", async () => {
      localStorage.setItem("comparison-database", JSON.stringify("lch_master"));
      const store = createJotaiStore();
      store.set(tabsAtom, [validTab]);
      store.set(activeTabAtom, tabId);
      store.set(dbTypeFamily(tabId), "lch_all");
      await renderPanel(store, {
        provider: () => new Map(),
        dedupingInterval: 0,
        shouldRetryOnError: false,
      });
      await vi.waitFor(() => expect(sources()).toHaveLength(2));
      const panel = regionPanel("stats");
      expect(
        Array.from(panel.querySelectorAll('[role="alert"]'), (alert) => alert.textContent),
      ).toEqual([expect.stringContaining("Board.Database.ExplorerAuthRequired1")]);
      expect(panel.querySelector("table")).toBeNull();
      expect(mocks.getLichessGames).not.toHaveBeenCalled();
      expect(mocks.getMasterGames).not.toHaveBeenCalled();
    });

    test("collapsed captions name every mixed local and Lichess column", async () => {
      localStorage.setItem(HEADER_COLLAPSED_KEY, "true");
      await mountMixed();
      await vi.waitFor(() => expect(sources()).toHaveLength(2));
      expect(sources()[0].firstElementChild?.textContent).toBe("Saved reference");
      expect(sources()[1].firstElementChild?.textContent).toBe("Board.Database.LichessAll");
      expect(positionControl()).toBeUndefined();
    });

    test("a partial search with mixed columns hides statistics and does not ask Lichess", async () => {
      const { store } = await mountMixed();
      await vi.waitFor(() => expect(mocks.getLichessGames).toHaveBeenCalled());
      mocks.getLichessGames.mockClear();
      mocks.searchPosition.mockClear();
      await act(async () =>
        store.set(localOptionsFamily(tabId), (options) => ({ ...options, type: "partial" })),
      );
      expect(container.querySelector('section[aria-label="Board.Database.Stats"]')).toBeNull();
      expect(container.querySelector('[role="separator"]')).toBeNull();
      await vi.waitFor(() =>
        expect(searchesOf(reference).at(-1)?.[1].position.type_).toBe("partial"),
      );
      expect(mocks.getLichessGames).not.toHaveBeenCalled();
      const games = regionPanel("games");
      expect(games.querySelector('input[type="radio"]')).toBeNull();
      await vi.waitFor(() => expect(games.textContent).toContain("Mega player"));
      expect(store.get(explorerGamesSourceFamily(tabId))).toBe("primary");
    });

    test("partial local options do not hide Stats once every column is Lichess", async () => {
      const { store } = await mountMixed({ comparison: null });
      await vi.waitFor(() => expect(sources()).toHaveLength(1));
      await act(async () =>
        store.set(localOptionsFamily(tabId), (options) => ({ ...options, type: "partial" })),
      );
      expect(container.querySelector('section[aria-label="Board.Database.Stats"]')).toBeNull();
      expect(mocks.getLichessGames).not.toHaveBeenCalled();
      await act(async () => store.set(dbTypeFamily(tabId), "lch_all"));
      await vi.waitFor(() =>
        expect(
          container.querySelector('section[aria-label="Board.Database.Stats"]'),
        ).not.toBeNull(),
      );
      expect(container.querySelector('[role="separator"]')).not.toBeNull();
      await vi.waitFor(() => expect(mocks.getLichessGames).toHaveBeenCalled());
      expect(positionControl()).toBeUndefined();
    });

    test("the Games switch offers a Lichess column on an unpinned board, including its notices and a game without a database", async () => {
      await act(async () => treeStore.getState().makeMove({ payload: "e4" }));
      const { store } = await mountMixed({ rejectedIds: ["g0"] });
      const panel = regionPanel("games");
      await vi.waitFor(() => expect(panel.textContent).toContain("Mega player"));
      const choices = Array.from(panel.querySelectorAll<HTMLInputElement>('input[type="radio"]'));
      expect(choices.map((choice) => choice.value)).toEqual(["primary", "comparison"]);
      expect(
        Array.from(
          panel.querySelectorAll(".mantine-SegmentedControl-label"),
          (label) => label.textContent,
        ),
      ).toEqual(["Saved reference", "Board.Database.LichessAll"]);
      await act(async () => choices[1].click());
      expect(store.get(explorerGamesSourceFamily(tabId))).toBe("comparison");
      await vi.waitFor(() => expect(panel.textContent).toContain("Board.Database.GamesIncomplete"));
      expect(panel.querySelector("table")).not.toBeNull();
      await openListedGame("W1");
      expect(mocks.openDatabaseGame.mock.lastCall?.[0]).toMatchObject({
        database: null,
        targetFens: [afterE4],
      });
    });

    test("Games of a Lichess column without an account shows the sign-in notice and no table", async () => {
      await mountMixed({ session: false });
      await vi.waitFor(() => expect(sources()).toHaveLength(2));
      const panel = regionPanel("games");
      const choices = await vi.waitFor(() => {
        const found = Array.from(panel.querySelectorAll<HTMLInputElement>('input[type="radio"]'));
        expect(found).toHaveLength(2);
        return found;
      });
      await act(async () => choices[1].click());
      await vi.waitFor(() =>
        expect(panel.querySelector('[role="alert"]')?.textContent).toContain(
          "Board.Database.ExplorerAuthRequired1",
        ),
      );
      expect(panel.querySelector("table")).toBeNull();
    });

    test("a remembered Games choice that is not offered falls back on read without rewriting it", async () => {
      const { store } = await mountMixed();
      await act(async () => store.set(explorerGamesSourceFamily(tabId), "comparison"));
      await act(async () =>
        store.set(localOptionsFamily(tabId), (options) => ({ ...options, type: "partial" })),
      );
      const panel = regionPanel("games");
      expect(panel.querySelector('input[type="radio"]')).toBeNull();
      await vi.waitFor(() => expect(panel.textContent).toContain("Mega player"));
      expect(store.get(explorerGamesSourceFamily(tabId))).toBe("comparison");
    });

    test.each([true, false])(
      "Lichess first with a local comparison and a partial search shows the local games (session %s)",
      async (session) => {
        const { store } = await mountMixed({ first: "lch_all", comparison: reference, session });
        await vi.waitFor(() => expect(sources()).toHaveLength(2));
        await vi.waitFor(() => expect(mocks.getLichessGames.mock.calls.length > 0).toBe(session));
        mocks.getLichessGames.mockClear();
        mocks.searchPosition.mockClear();
        await act(async () =>
          store.set(localOptionsFamily(tabId), (options) => ({ ...options, type: "partial" })),
        );
        const panel = regionPanel("games");
        expect(panel.querySelector('input[type="radio"]')).toBeNull();
        await vi.waitFor(() => expect(panel.textContent).toContain("Mega player"));
        expect(panel.querySelector('[role="alert"]')).toBeNull();
        expect(store.get(explorerGamesSourceFamily(tabId))).toBe("primary");
        expect(mocks.getLichessGames).not.toHaveBeenCalled();
      },
    );

    test("Compare is offered when Lichess is the first source and no local database is chosen", async () => {
      await mountMixed({ first: "lch_all", comparison: null, list: [] });
      await vi.waitFor(() => expect(sources()).toHaveLength(1));
      const compare = compareButton()!;
      expect(compare).toBeDefined();
      await act(async () => compare.click());
      const items = await vi.waitFor(() => {
        const found = menuChoices();
        expect(found).not.toHaveLength(0);
        return found;
      });
      expect(items).toEqual(["Board.Database.LichessMaster"]);
    });

    test("a stored Lichess All comparison beside Lichess All is not shown, and Compare lists Masters and readable databases", async () => {
      const { store } = await mountMixed({ first: "lch_all", comparison: "lch_all" });
      await vi.waitFor(() => expect(sources()).toHaveLength(1));
      expect(store.get(comparisonDbAtom)).toBe("lch_all");
      const compare = compareButton()!;
      expect(compare).toBeDefined();
      await act(async () => compare.click());
      const items = await vi.waitFor(() => {
        const found = menuChoices();
        expect(found).not.toHaveLength(0);
        return found;
      });
      expect(items).toEqual([
        "Saved reference",
        "Correspondence",
        "Third database",
        "Board.Database.LichessMaster",
      ]);
    });

    test("the panel passes stored Lichess and Masters options to their fetchers", async () => {
      const { store } = await mountMixed({ first: "lch_all", comparison: "lch_master" });
      await act(async () => {
        store.set(lichessOptionsAtom, { ...DEFAULT_LICHESS_OPTIONS, speeds: ["blitz"] });
        store.set(masterOptionsAtom, {
          ...DEFAULT_MASTER_OPTIONS,
          since: new Date("2020-01-01T00:00:00Z"),
        });
      });
      await vi.waitFor(() => {
        expect(mocks.getLichessGames.mock.lastCall?.[1]).toEqual(store.get(lichessOptionsAtom));
        expect(mocks.getMasterGames.mock.lastCall?.[1]).toEqual(store.get(masterOptionsAtom));
      });
    });

    test("a panel whose first source is already Lichess on first paint still reads the database list", async () => {
      mocks.getDatabases.mockResolvedValue(databaseList([readable]));
      mockOnlineGames();
      const store = createJotaiStore();
      store.set(tabsAtom, [validTab]);
      store.set(activeTabAtom, tabId);
      store.set(dbTypeFamily(tabId), "lch_all");
      store.set(sessionsAtom, [validSession]);
      await renderPanel(store, {
        provider: () => new Map(),
        dedupingInterval: 0,
        shouldRetryOnError: false,
        revalidateOnFocus: false,
        revalidateOnReconnect: false,
      });
      await vi.waitFor(() => expect(mocks.getDatabases).toHaveBeenCalled());
    });

    test("all failed Lichess games beside a local column name every game and show no table", async () => {
      await mountMixed({ rejectedIds: ["g0", "g1"] });
      const panel = regionPanel("games");
      const choices = Array.from(panel.querySelectorAll<HTMLInputElement>('input[type="radio"]'));
      await act(async () => choices[1].click());
      await vi.waitFor(() =>
        expect(panel.textContent).toContain("Board.Database.GamesFailed W0 - B0, W1 - B1"),
      );
      expect(panel.querySelector("table")).toBeNull();
    });
  });

  test("local: a pinned player remains scoped to its database when the global reference changes", async () => {
    mocks.getDatabases.mockResolvedValue(
      databaseList([readable, { ...readable, file: stalePath }]),
    );
    const { store } = await mountLocal(reference, 42);
    await act(async () => store.set(referenceDbAtom, stalePath));
    expect(mocks.searchPosition.mock.lastCall?.[0]).toEqual(reference);
    expect(mocks.searchPosition.mock.lastCall?.[1].player1).toBe(42);
    expect(store.get(localOptionsFamily(tabId)).player_database).toBe(databaseHandleKey(reference));
  });

  test("local: ownerless player selections of a pinned tab are neither searched nor displayed", async () => {
    mocks.getDatabases.mockResolvedValue(databaseList([readable]));
    const { store } = await mountLocal(reference, 42);
    await act(async () =>
      store.set(localOptionsFamily(tabId), (options) => ({
        ...options,
        player_database: undefined,
      })),
    );
    expect(mocks.searchPosition.mock.lastCall?.[0]).toEqual(reference);
    expect(mocks.searchPosition.mock.lastCall?.[1].player1 ?? null).toBeNull();
    mocks.getPlayer.mockClear();
    expect((await showPlayerOptions())?.value).toBe("");
    expect(mocks.getPlayer).not.toHaveBeenCalled();
  });

  test("local: pending and unavailable database recovery preserves ownership and ignores a late lookup", async () => {
    const listing = deferred<DatabaseList>();
    const lookup = deferred<import("@/bindings").Player>();
    mocks.getDatabases.mockReturnValueOnce(listing.promise);
    mocks.getPlayer.mockReturnValueOnce(lookup.promise);
    const { store, revalidate } = await mountLocal(undefined, 42);
    expect(mocks.searchPosition).not.toHaveBeenCalled();
    expect(await showPlayerOptions()).toBeNull();
    expect(mocks.getPlayer).not.toHaveBeenCalled();
    await act(async () => listing.resolve(databaseList([readable])));
    // The saved player is looked up once the database's filters are opened.
    expect(await showPlayerOptions()).not.toBeNull();
    expect(mocks.getPlayer).toHaveBeenCalledWith(reference, 42);

    mocks.getDatabases.mockResolvedValue(databaseList([unreadable]));
    await revalidate();
    expect(await showPlayerOptions()).toBeNull();
    await act(async () =>
      lookup.resolve({ id: 42, name: "Late A player", elo: 2000, game_count: 3 }),
    );
    expect(document.body.textContent).not.toContain("Late A player");
    expect(savedFilters(store, reference).player).toBe(42);
    mocks.getDatabases.mockResolvedValue(databaseList([readable]));
    await revalidate();
    expect((await showPlayerOptions())?.value).toBe(`${reference.id.id} player`);
    expect(mocks.searchPosition).toHaveBeenCalled();
    for (const [database, query] of mocks.searchPosition.mock.calls) {
      expect(database).toEqual(reference);
      expect(query.player1).toBe(42);
      expect(query.player2 ?? null).toBeNull();
    }
  });

  test("local: resolving a new handle with the same database key preserves the player filter", async () => {
    mocks.getDatabases.mockResolvedValue(databaseList([readable]));
    const { store, revalidate } = await mountLocal(reference, 42);
    mocks.getDatabases.mockResolvedValue(
      databaseList([{ ...readable, file: { ...reference, id: { ...reference.id } } }]),
    );
    await revalidate();
    expect(store.get(localOptionsFamily(tabId)).player).toBe(42);
    expect(mocks.searchPosition.mock.lastCall?.[1].player1).toBe(42);
  });

  test.each([
    ["absent", []],
    ["unreadable", [unreadable]],
  ] as const)(
    "local: %s persisted handle never searches a stale tab path",
    async (_name, entries) => {
      mocks.getDatabases.mockResolvedValue(databaseList([...entries]));
      const { store } = await mountLocal();

      expect(mocks.searchPosition).not.toHaveBeenCalled();
      expect(store.get(localOptionsFamily(tabId)).path).toBeNull();
      expectSavedChoice(store);
      expectNoReference();
    },
  );

  test("local: pending list and transient failure preserve the saved choice until successful recovery", async () => {
    const pending = deferred<DatabaseList>();
    mocks.getDatabases.mockReturnValueOnce(pending.promise);
    const { store, revalidate } = await mountLocal();
    expectNoReference();
    expectSavedChoice(store);
    expect(mocks.searchPosition).not.toHaveBeenCalled();

    await act(async () => {
      pending.reject(new Error("Temporary list failure"));
    });
    expectNoReference();
    expectSavedChoice(store);
    expect(mocks.searchPosition).not.toHaveBeenCalled();

    mocks.getDatabases.mockResolvedValue(databaseList([readable]));
    await revalidate();
    expect(mocks.searchPosition).toHaveBeenCalled();
    expect(container.querySelector<HTMLInputElement>(".mantine-Select-input")?.value).toBe(
      "Saved reference",
    );
    expectSavedChoice(store);
  });

  test("local: a cancellation on the database list preserves cached readable options", async () => {
    mocks.getDatabases.mockResolvedValue(databaseList([readable]));
    const { revalidate } = await mountLocal();
    expect(container.querySelector<HTMLInputElement>(".mantine-Select-input")?.value).toBe(
      "Saved reference",
    );

    mocks.getDatabases.mockRejectedValue(new DOMException("Cancellation", "AbortError"));
    await revalidate();

    const selector = container.querySelector<HTMLInputElement>(".mantine-Select-input")!;
    expect(selector.value).toBe("Saved reference");
    expect(container.textContent).not.toContain("Board.Database.NoReference1");
    await act(async () => selector.click());
    const option = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(
      (item) => item.textContent === "Saved reference",
    );
    expect(option).toBeDefined();

    mocks.getDatabases.mockRejectedValue(new Error("Temporary list failure"));
    await revalidate();
    expectNoReference();
  });

  test.each(["absent", "unreadable", "list failure"] as const)(
    "local: becoming %s cancels the pending owner and hides a late result",
    async (unavailable) => {
      const pending = deferred<[import("@/utils/db").Opening[], []]>();
      let signal!: AbortSignal;
      mocks.searchPosition.mockImplementation((_path, _query, _tab, options) => {
        signal = options.signal;
        // Model the native facade's abort guard even when the IPC reply arrives late.
        return pending.promise.then((result) => {
          if (options.signal.aborted) throw cancellationError();
          return result;
        });
      });
      mocks.getDatabases.mockResolvedValue(databaseList([readable]));
      const { store, revalidate } = await mountLocal();
      expect(mocks.searchPosition).toHaveBeenCalledOnce();
      expect(signal.aborted).toBe(false);

      if (unavailable === "list failure")
        mocks.getDatabases.mockRejectedValue(new Error("Temporary list failure"));
      else
        mocks.getDatabases.mockResolvedValue(
          databaseList(unavailable === "absent" ? [] : [unreadable]),
        );
      await revalidate();
      expect(signal.aborted).toBe(true);
      expectNoReference();
      expectSavedChoice(store);
      expect(mocks.searchPosition).toHaveBeenCalledOnce();

      await act(async () => {
        pending.resolve([[{ move: "STALE", white: 999, black: 0, draw: 0 }], []]);
      });
      expectNoReference();
      expect(container.textContent).not.toContain("STALE");
      expect(container.textContent).not.toContain("999");

      mocks.searchPosition.mockResolvedValue([[{ move: "e4", white: 1, black: 0, draw: 0 }], []]);
      mocks.getDatabases.mockResolvedValue(databaseList([readable]));
      await revalidate();
      expect(mocks.searchPosition).toHaveBeenCalledTimes(2);
      await vi.waitFor(() => {
        expect(container.textContent).toContain("e4");
      });
      expect(container.textContent).not.toContain("STALE");
      expectSavedChoice(store);
    },
  );

  test.each(["Database is unreadable", "C:\\secret\\path diag"])(
    "local: admitted search failure %s renders translated guidance once without native diagnostics or separator",
    async (message) => {
      mocks.getDatabases.mockResolvedValue(databaseList([readable]));
      mocks.searchPosition.mockRejectedValue(new Error(message));
      await mountLocal();
      expect(container.querySelectorAll('[role="separator"]')).toHaveLength(0);
      expect(container.querySelectorAll("section[aria-label]")).toHaveLength(0);
      expect(container.textContent?.split("Databases.LoadError.Title")).toHaveLength(2);
      expect(container.textContent).not.toContain(message);
      expect(container.textContent).not.toContain("Board.Database.NoReference1");
    },
  );

  test("local: cancelled search renders the ordinary panel children", async () => {
    mocks.getDatabases.mockResolvedValue(databaseList([readable]));
    mocks.searchPosition.mockRejectedValue(new Error("Cancellation"));
    await mountLocal();
    const panel = regionPanel("stats");
    expect(panel.textContent).toContain("Databases.Game.NoGamesFound");
    expect(panel.querySelector('[role="alert"]')).toBeNull();
    expect(panel.textContent).not.toContain("Cancellation");
    expect(panel.textContent).not.toContain("Databases.LoadError.Title");
  });

  test.each(["lch_all", "lch_master"] as const)(
    "%s: query failures render explorer guidance without diagnostics",
    async (type) => {
      const store = createJotaiStore();
      store.set(tabsAtom, [validTab]);
      store.set(activeTabAtom, tabId);
      store.set(dbTypeFamily(tabId), type);
      store.set(sessionsAtom, [validSession]);
      const fetcher = type === "lch_all" ? mocks.getLichessGames : mocks.getMasterGames;
      fetcher.mockRejectedValue(new Error("C:\\secret\\path diag"));
      await renderPanel(store, { provider: () => new Map(), shouldRetryOnError: false });
      await vi.waitFor(() =>
        expect(container.textContent).toContain("Board.Database.ExplorerLoadError"),
      );
      expect(container.textContent).not.toContain("C:\\secret\\path diag");
    },
  );

  test("local: collection-unavailable presentation yields to the missing effective reference warning", async () => {
    mocks.getDatabases.mockResolvedValue(databaseList([readable]));
    mocks.collectionForDatabase.mockRejectedValue(new Error("Collection unavailable"));
    const { store, revalidate } = await mountLocal();
    expect(container.querySelectorAll('[role="separator"]')).toHaveLength(0);
    expect(container.querySelectorAll("section[aria-label]")).toHaveLength(0);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Collections.Unavailable");
    expect(container.textContent).not.toContain("Collection unavailable");
    expect(container.textContent).not.toContain("Board.Database.NoReference1");

    mocks.getDatabases.mockResolvedValue(databaseList([unreadable]));
    await revalidate();
    expectNoReference();
    expect(container.textContent).not.toContain("Collections.Unavailable");
    expectSavedChoice(store);
  });

  test("mounted lch_all: unmount during lexing aborts active lexPgn signal without diagnostic", async () => {
    sessionStorage.setItem(
      "workspace",
      JSON.stringify({ version: 1, tabs: [validTab], activeTab: tabId }),
    );
    const jotaiStore = createJotaiStore();
    jotaiStore.set(tabsAtom, [validTab]);
    jotaiStore.set(activeTabAtom, tabId);
    jotaiStore.set(dbTypeFamily(tabId), "lch_all");
    jotaiStore.set(sessionsAtom, [validSession]);

    mocks.getLichessGames.mockResolvedValue(mockExplorerData);
    mocks.getPublicLichessJson.mockResolvedValue(`[White "W"]\n[Black "B"]\n\n1. e4 e5 *`);

    let observedSignal: AbortSignal | undefined;

    mocks.lexPgn.mockImplementation(async (_pgn: string, options?: { signal?: AbortSignal }) => {
      observedSignal = options?.signal;
      return new Promise((_, reject) => {
        if (options?.signal?.aborted) {
          reject(cancellationError());
          return;
        }
        options?.signal?.addEventListener("abort", () => {
          reject(cancellationError());
        });
      });
    });

    await renderPanel(jotaiStore, { provider: () => new Map(), dedupingInterval: 0 });

    await vi.waitFor(() => {
      expect(mocks.getLichessGames).toHaveBeenCalled();
      expect(mocks.getPublicLichessJson).toHaveBeenCalled();
      expect(mocks.lexPgn).toHaveBeenCalled();
    });
    expect(observedSignal).toBeDefined();
    expect(observedSignal!.aborted).toBe(false);

    await act(async () => {
      root.unmount();
    });

    expect(observedSignal!.aborted).toBe(true);
    expect(mocks.logError).not.toHaveBeenCalled();
  });

  test("mounted lch_all: replacement to lch_master during lexing aborts active lexPgn signal without diagnostic", async () => {
    sessionStorage.setItem(
      "workspace",
      JSON.stringify({ version: 1, tabs: [validTab], activeTab: tabId }),
    );
    const jotaiStore = createJotaiStore();
    jotaiStore.set(tabsAtom, [validTab]);
    jotaiStore.set(activeTabAtom, tabId);
    jotaiStore.set(dbTypeFamily(tabId), "lch_all");
    jotaiStore.set(sessionsAtom, [validSession]);

    mocks.getLichessGames.mockResolvedValue(mockExplorerData);
    mocks.getMasterGames.mockResolvedValue(mockExplorerData);
    mocks.getPublicLichessJson.mockResolvedValue(`[White "W"]\n[Black "B"]\n\n1. e4 e5 *`);

    let initialSignal: AbortSignal | undefined;

    mocks.lexPgn.mockImplementation(async (_pgn: string, options?: { signal?: AbortSignal }) => {
      if (!initialSignal) {
        initialSignal = options?.signal;
      }
      return new Promise((_, reject) => {
        if (options?.signal?.aborted) {
          reject(cancellationError());
          return;
        }
        options?.signal?.addEventListener("abort", () => {
          reject(cancellationError());
        });
      });
    });

    await renderPanel(jotaiStore, { provider: () => new Map(), dedupingInterval: 0 });

    await vi.waitFor(() => {
      expect(mocks.lexPgn).toHaveBeenCalled();
    });
    expect(initialSignal).toBeDefined();
    expect(initialSignal!.aborted).toBe(false);

    await act(async () => {
      jotaiStore.set(dbTypeFamily(tabId), "lch_master");
    });

    await vi.waitFor(() => {
      expect(initialSignal!.aborted).toBe(true);
    });
    expect(mocks.logError).not.toHaveBeenCalled();
  });

  test("mounted lch_master: unmount during lexing aborts active lexPgn signal without diagnostic", async () => {
    sessionStorage.setItem(
      "workspace",
      JSON.stringify({ version: 1, tabs: [validTab], activeTab: tabId }),
    );
    const jotaiStore = createJotaiStore();
    jotaiStore.set(tabsAtom, [validTab]);
    jotaiStore.set(activeTabAtom, tabId);
    jotaiStore.set(dbTypeFamily(tabId), "lch_master");
    jotaiStore.set(sessionsAtom, [validSession]);

    mocks.getMasterGames.mockResolvedValue(mockExplorerData);
    mocks.getPublicLichessJson.mockResolvedValue(`[White "W"]\n[Black "B"]\n\n1. e4 e5 *`);

    let observedSignal: AbortSignal | undefined;

    mocks.lexPgn.mockImplementation(async (_pgn: string, options?: { signal?: AbortSignal }) => {
      observedSignal = options?.signal;
      return new Promise((_, reject) => {
        if (options?.signal?.aborted) {
          reject(cancellationError());
          return;
        }
        options?.signal?.addEventListener("abort", () => {
          reject(cancellationError());
        });
      });
    });

    await renderPanel(jotaiStore, { provider: () => new Map(), dedupingInterval: 0 });

    await vi.waitFor(() => {
      expect(mocks.lexPgn).toHaveBeenCalled();
    });
    expect(observedSignal).toBeDefined();
    expect(observedSignal!.aborted).toBe(false);

    await act(async () => {
      root.unmount();
    });

    expect(observedSignal!.aborted).toBe(true);
    expect(mocks.logError).not.toHaveBeenCalled();
  });

  test("single-source online auth warning renders once without separator", async () => {
    const store = createJotaiStore();
    store.set(tabsAtom, [validTab]);
    store.set(activeTabAtom, tabId);
    store.set(dbTypeFamily(tabId), "lch_all");
    await renderPanel(store, { provider: () => new Map(), shouldRetryOnError: false });
    expect(container.querySelectorAll('[role="separator"]')).toHaveLength(0);
    expect(container.querySelectorAll("section[aria-label]")).toHaveLength(0);
    expect(container.textContent?.split("Board.Database.ExplorerAuthRequired1")).toHaveLength(2);
  });

  test("unmeasured body keeps stored height unclamped and ignores divider input without writing", async () => {
    localStorage.setItem(EXPLORER_STATS_HEIGHT_KEY, "18");
    await mountExplorer();
    const stats = regionPanel("stats");
    expect(stats.style.height).toBe("18rem");
    const separator = container.querySelector<HTMLElement>('[role="separator"]')!;
    expect(separator.getAttribute("aria-valuenow")).toBe("18");
    await act(async () => {
      separator.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
      separator.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      separator.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    expect(localStorage.getItem(EXPLORER_STATS_HEIGHT_KEY)).toBe("18");
  });

  test("double-click on separator with a measured resizable body resets stored height to default", async () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 400, 480),
    );
    localStorage.setItem(EXPLORER_STATS_HEIGHT_KEY, "8");
    await mountExplorer();
    const stats = regionPanel("stats");
    expect(stats.style.height).toBe("8rem");
    const separator = container.querySelector<HTMLElement>('[role="separator"]')!;
    expect(separator.getAttribute("aria-valuenow")).toBe("8");

    await act(async () => {
      separator.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    expect(localStorage.getItem(EXPLORER_STATS_HEIGHT_KEY)).toBe(
      String(DEFAULT_EXPLORER_STATS_HEIGHT_REM),
    );
  });

  describe("games collapse and PanelArea chrome portal", () => {
    const defaultSwrConfig: SWRConfiguration = {
      provider: () => new Map(),
      dedupingInterval: 0,
      shouldRetryOnError: false,
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
    };

    const gamesToggleButton = () =>
      container.querySelector<HTMLButtonElement>(
        'button[aria-label="Board.Database.HideGames"], button[aria-label="Board.Database.ShowGames"]',
      );

    const settingsToggleButton = () =>
      container.querySelector<HTMLButtonElement>(
        'button[aria-label="Board.Database.HideSettings"], button[aria-label="Board.Database.ShowSettings"]',
      );

    function prepareOnlineStore() {
      const store = createJotaiStore();
      store.set(tabsAtom, [validTab]);
      store.set(activeTabAtom, tabId);
      store.set(dbTypeFamily(tabId), "lch_all");
      store.set(sessionsAtom, [validSession]);
      mocks.getLichessGames.mockResolvedValue(mockExplorerData);
      mocks.getPublicLichessJson.mockResolvedValue(`[White "W1"]\n[Black "B1"]\n\n1. d4 d5 *`);
      mocks.lexPgn.mockResolvedValue([
        { type: "Header", value: { tag: "White", value: "W1" } },
        { type: "Header", value: { tag: "Black", value: "B1" } },
      ]);
      return store;
    }

    function prepareLocalStore(
      databases: ManagedDatabaseInfo[] = [
        {
          type: "success",
          title: "Primary DB",
          description: "",
          player_count: 10,
          event_count: 2,
          game_count: 50,
          storage_size: "1000",
          filename: "primary.db3",
          indexed: true,
          file: { id: { id: "primary-db" }, kind: "database" },
        },
        {
          type: "success",
          title: "Secondary DB",
          description: "",
          player_count: 10,
          event_count: 2,
          game_count: 30,
          storage_size: "1000",
          filename: "secondary.db3",
          indexed: true,
          file: { id: { id: "secondary-db" }, kind: "database" },
        },
      ],
    ) {
      const store = createJotaiStore();
      store.set(tabsAtom, [validTab]);
      store.set(activeTabAtom, tabId);
      store.set(dbTypeFamily(tabId), "local");
      store.set(referenceDbAtom, databases[0]?.file ?? null);
      mocks.getDatabases.mockResolvedValue({
        databases,
        unread: [],
        workspaceFilenames: [],
        root: { id: { id: "database-root" }, kind: "databaseRoot" },
      } satisfies DatabaseList);
      mocks.searchPosition.mockResolvedValue([[], []]);
      return store;
    }

    test("hides and shows the games region via the collapse control and persists the preference", async () => {
      await mountExplorer();

      const toggle = gamesToggleButton();
      expect(toggle).not.toBeNull();
      expect(toggle!.getAttribute("aria-label")).toBe("Board.Database.HideGames");
      expect(toggle!.getAttribute("aria-pressed")).toBe("true");
      expect(container.querySelector('section[aria-label="Board.Database.Games"]')).not.toBeNull();
      expect(container.querySelector('[role="separator"]')).not.toBeNull();

      await act(async () => toggle!.click());
      expect(localStorage.getItem(EXPLORER_GAMES_COLLAPSED_KEY)).toBe("true");
      expect(container.querySelector('section[aria-label="Board.Database.Games"]')).toBeNull();
      expect(container.querySelector('[role="separator"]')).toBeNull();
      expect(gamesToggleButton()!.getAttribute("aria-label")).toBe("Board.Database.ShowGames");
      expect(gamesToggleButton()!.getAttribute("aria-pressed")).toBe("false");
      expect(regionPanel("stats").getAttribute("data-expanded")).toBe("true");

      await act(async () => gamesToggleButton()!.click());
      expect(localStorage.getItem(EXPLORER_GAMES_COLLAPSED_KEY)).toBe("false");
      expect(container.querySelector('section[aria-label="Board.Database.Games"]')).not.toBeNull();
      expect(container.querySelector('[role="separator"]')).not.toBeNull();
      expect(gamesToggleButton()!.getAttribute("aria-label")).toBe("Board.Database.HideGames");
      expect(gamesToggleButton()!.getAttribute("aria-pressed")).toBe("true");
      expect(regionPanel("stats").hasAttribute("data-expanded")).toBe(false);
    });

    test.each([
      [null, false],
      ["true", true],
      ["false", false],
      ["not json", false],
      ['"yes"', false],
    ])("the games-collapse preference %s hydrates as hidden=%s", async (stored, hidden) => {
      if (stored === null) localStorage.removeItem(EXPLORER_GAMES_COLLAPSED_KEY);
      else localStorage.setItem(EXPLORER_GAMES_COLLAPSED_KEY, stored);

      await mountExplorer();
      expect(container.querySelector('section[aria-label="Board.Database.Games"]') === null).toBe(
        hidden,
      );
      expect(container.querySelector('[role="separator"]') === null).toBe(hidden);
    });

    test("omits HideGames/ShowGames when no source is available", async () => {
      const store = prepareLocalStore([]);
      await renderPanel(store, defaultSwrConfig);
      await vi.waitFor(() => expect(settingsToggleButton()?.disabled).toBe(true));

      expect(gamesToggleButton()).toBeNull();
    });

    test("omits HideGames/ShowGames during partial search and keeps the games section visible even when explorer-games-collapsed is true", async () => {
      localStorage.setItem(EXPLORER_GAMES_COLLAPSED_KEY, "true");
      const store = prepareLocalStore();
      store.set(localOptionsFamily(tabId), (options) => ({ ...options, type: "partial" }));
      await renderPanel(store, defaultSwrConfig);
      await vi.waitFor(() =>
        expect(
          container.querySelector('section[aria-label="Board.Database.Games"]'),
        ).not.toBeNull(),
      );

      expect(gamesToggleButton()).toBeNull();
      expect(container.querySelector('section[aria-label="Board.Database.Stats"]')).toBeNull();
      expect(container.querySelector('[role="separator"]')).toBeNull();
      expect(localStorage.getItem(EXPLORER_GAMES_COLLAPSED_KEY)).toBe("true");
    });

    test("collapsing games removes stats inline height without writing explorer-stats-height and re-expanding restores it", async () => {
      localStorage.setItem(EXPLORER_STATS_HEIGHT_KEY, "12");
      await mountExplorer();

      expect(regionPanel("stats").style.height).toBe("12rem");
      expect(localStorage.getItem(EXPLORER_STATS_HEIGHT_KEY)).toBe("12");

      await act(async () => gamesToggleButton()!.click());
      expect(regionPanel("stats").style.height).toBe("");
      expect(localStorage.getItem(EXPLORER_STATS_HEIGHT_KEY)).toBe("12");

      await act(async () => gamesToggleButton()!.click());
      expect(regionPanel("stats").style.height).toBe("12rem");
      expect(localStorage.getItem(EXPLORER_STATS_HEIGHT_KEY)).toBe("12");
    });

    test("tab mount keeps settings gear and games-collapse in the panel container with collapsed overlay padding", async () => {
      localStorage.setItem(HEADER_COLLAPSED_KEY, "true");
      await mountExplorer();

      expect(container.querySelector("[data-panel-header]")).toBeNull();
      expect(settingsToggleButton()).not.toBeNull();
      expect(gamesToggleButton()).not.toBeNull();
      const collapsedSources = container.querySelector<HTMLElement>("[data-collapsed]");
      expect(collapsedSources).not.toBeNull();
      expect(collapsedSources!.getAttribute("data-overlay-actions")).toBe("true");
    });

    test("tile mount portals gear and games-collapse into [data-panel-header] before ReturnToTabs inside data-no-drag and gear pointer-down does not start drag", async () => {
      localStorage.setItem(HEADER_COLLAPSED_KEY, "true");
      const store = prepareOnlineStore();
      const beginDrag = vi.fn();

      await renderNode(
        store,
        defaultSwrConfig,
        <PanelArea
          panel="database"
          title="Database"
          icon={<span data-testid="db-icon" />}
          onReturn={vi.fn()}
          onDragStart={beginDrag}
          onSuppressClick={vi.fn()}
          onStartPlacing={vi.fn()}
        >
          <DatabasePanel />
        </PanelArea>,
      );

      const header = container.querySelector<HTMLElement>('[data-panel-header="database"]');
      expect(header).not.toBeNull();
      const gear = header!.querySelector<HTMLButtonElement>(
        'button[aria-label="Board.Database.ShowSettings"]',
      );
      const gamesToggle = header!.querySelector<HTMLButtonElement>(
        'button[aria-label="Board.Database.HideGames"]',
      );
      const returnButton = header!.querySelector<HTMLButtonElement>(
        'button[aria-label="Board.Area.ReturnToTabs"]',
      );
      expect(gear).not.toBeNull();
      expect(gamesToggle).not.toBeNull();
      expect(returnButton).not.toBeNull();

      // Only one instance of each button exists (none left in the panel body).
      expect(
        container.querySelectorAll(
          'button[aria-label="Board.Database.ShowSettings"], button[aria-label="Board.Database.HideSettings"]',
        ),
      ).toHaveLength(1);
      expect(
        container.querySelectorAll(
          'button[aria-label="Board.Database.HideGames"], button[aria-label="Board.Database.ShowGames"]',
        ),
      ).toHaveLength(1);

      // Both live inside data-no-drag and before ReturnToTabs in DOM order.
      expect(gear!.closest('[data-no-drag="true"]')).not.toBeNull();
      expect(gamesToggle!.closest('[data-no-drag="true"]')).not.toBeNull();
      const headerButtons = Array.from(header!.querySelectorAll("button"));
      expect(headerButtons.indexOf(gear!)).toBeLessThan(headerButtons.indexOf(returnButton!));
      expect(headerButtons.indexOf(gamesToggle!)).toBeLessThan(
        headerButtons.indexOf(returnButton!),
      );

      // Collapsed captions drop overlay padding when chrome is portaled out.
      const collapsedSources = container.querySelector<HTMLElement>("[data-collapsed]");
      expect(collapsedSources).not.toBeNull();
      expect(collapsedSources!.hasAttribute("data-overlay-actions")).toBe(false);

      // Pointer-down on the gear must not begin an arrange drag; pointer-down on the title does.
      await act(async () => {
        gear!.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      });
      expect(beginDrag).not.toHaveBeenCalled();

      const titleEl = Array.from(header!.querySelectorAll("*")).find(
        (el) => el.textContent === "Database" && el.children.length === 0,
      );
      expect(titleEl).toBeDefined();
      await act(async () => {
        titleEl!.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      });
      expect(beginDrag).toHaveBeenCalledTimes(1);
    });

    test("expanded Position/Compare cluster stays outside .sources and .sources contains only [data-explorer-source] cells", async () => {
      localStorage.setItem(HEADER_COLLAPSED_KEY, "false");
      const store = prepareLocalStore();

      await renderNode(
        store,
        defaultSwrConfig,
        <PanelArea
          panel="database"
          title="Database"
          icon={<span />}
          onReturn={vi.fn()}
          onDragStart={vi.fn()}
          onSuppressClick={vi.fn()}
          onStartPlacing={vi.fn()}
        >
          <DatabasePanel />
        </PanelArea>,
      );

      await vi.waitFor(() =>
        expect(container.querySelectorAll("[data-explorer-source]")).toHaveLength(1),
      );
      const sourceCell = container.querySelector<HTMLElement>("[data-explorer-source]")!;
      const sourcesGrid = sourceCell.parentElement!;
      expect(
        Array.from(sourcesGrid.children).every((child) =>
          child.hasAttribute("data-explorer-source"),
        ),
      ).toBe(true);

      const compareBtn = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
        (button) => button.getAttribute("aria-label") === "Board.Database.CompareWith",
      );
      expect(compareBtn).toBeDefined();
      expect(sourcesGrid.contains(compareBtn!)).toBe(false);
      // Position cluster precedes `.sources` in document order.
      expect(
        Boolean(
          compareBtn!.compareDocumentPosition(sourcesGrid) & Node.DOCUMENT_POSITION_FOLLOWING,
        ),
      ).toBe(true);
    });

    test("PH-16: tile context with slot=null suppresses in-body chrome and collapsed overlay padding", async () => {
      localStorage.setItem(HEADER_COLLAPSED_KEY, "true");
      const store = prepareOnlineStore();

      await renderNode(
        store,
        defaultSwrConfig,
        <PanelAreaChromeContext.Provider value={{ slot: null }}>
          <DatabasePanel />
        </PanelAreaChromeContext.Provider>,
      );

      expect(settingsToggleButton()).toBeNull();
      expect(gamesToggleButton()).toBeNull();
      const collapsedSources = container.querySelector<HTMLElement>("[data-collapsed]");
      expect(collapsedSources).not.toBeNull();
      expect(collapsedSources!.hasAttribute("data-overlay-actions")).toBe(false);
    });
  });
});

describe("explorerStatsSplitRange and persisted height", () => {
  const h = EXPLORER_DIVIDER_HEIGHT_PX / 16;

  test("clamps stored height within [MIN_STATS, H - MIN_GAMES - h] on normal body", () => {
    expect(MIN_EXPLORER_GAMES_HEIGHT_REM).toBe(12);
    expect(explorerStatsSplitRange(14, 30, h)).toEqual({
      statsHeightRem: 14,
      minRem: MIN_EXPLORER_STATS_HEIGHT_REM,
      maxRem: 30 - MIN_EXPLORER_GAMES_HEIGHT_REM - h,
      canResize: true,
    });
    expect(explorerStatsSplitRange(2, 30, h).statsHeightRem).toBe(MIN_EXPLORER_STATS_HEIGHT_REM);
    expect(explorerStatsSplitRange(40, 30, h).statsHeightRem).toBe(
      30 - MIN_EXPLORER_GAMES_HEIGHT_REM - h,
    );
  });

  test("shares remaining height proportionally and disables resize on short body", () => {
    for (const body of [10, 16]) {
      const expected =
        (body - h) *
        (MIN_EXPLORER_STATS_HEIGHT_REM /
          (MIN_EXPLORER_STATS_HEIGHT_REM + MIN_EXPLORER_GAMES_HEIGHT_REM));
      expect(explorerStatsSplitRange(14, body, h)).toEqual({
        statsHeightRem: expected,
        minRem: expected,
        maxRem: expected,
        canResize: false,
      });
    }
    // Exact boundary H = MIN_STATS + MIN_GAMES + h also collapses the range (min === max).
    const exact = MIN_EXPLORER_STATS_HEIGHT_REM + MIN_EXPLORER_GAMES_HEIGHT_REM + h;
    expect(explorerStatsSplitRange(14, exact, h)).toEqual({
      statsHeightRem: MIN_EXPLORER_STATS_HEIGHT_REM,
      minRem: MIN_EXPLORER_STATS_HEIGHT_REM,
      maxRem: MIN_EXPLORER_STATS_HEIGHT_REM,
      canResize: false,
    });
  });

  test("leaves stored height unclamped and non-writable when body is unmeasured", () => {
    expect(explorerStatsSplitRange(22, 0, h)).toEqual({
      statsHeightRem: 22,
      minRem: 22,
      maxRem: 22,
      canResize: false,
    });
  });

  test("explorerStatsHeightAtom reads pre-seeded storage synchronously on first access without rewriting out-of-range values", async () => {
    localStorage.setItem(EXPLORER_STATS_HEIGHT_KEY, "45");
    vi.resetModules();
    const fresh = await import("@/state/atoms/explorer");
    const store = createJotaiStore();
    expect(store.get(fresh.explorerStatsHeightAtom)).toBe(45);
    expect(localStorage.getItem(EXPLORER_STATS_HEIGHT_KEY)).toBe("45");

    localStorage.setItem(EXPLORER_STATS_HEIGHT_KEY, "2");
    vi.resetModules();
    const smallFresh = await import("@/state/atoms/explorer");
    const smallStore = createJotaiStore();
    expect(smallStore.get(smallFresh.explorerStatsHeightAtom)).toBe(2);
    expect(localStorage.getItem(EXPLORER_STATS_HEIGHT_KEY)).toBe("2");

    localStorage.removeItem(EXPLORER_STATS_HEIGHT_KEY);
    vi.resetModules();
    const defaultFresh = await import("@/state/atoms/explorer");
    const defaultStore = createJotaiStore();
    expect(defaultStore.get(defaultFresh.explorerStatsHeightAtom)).toBe(
      DEFAULT_EXPLORER_STATS_HEIGHT_REM,
    );
  });

  test("PH-17: explorerGamesCollapsedAtom reads pre-seeded storage synchronously on first access", async () => {
    localStorage.setItem(EXPLORER_GAMES_COLLAPSED_KEY, "true");
    vi.resetModules();
    const collapsedFresh = await import("@/state/atoms/explorer");
    const collapsedStore = createJotaiStore();
    expect(collapsedStore.get(collapsedFresh.explorerGamesCollapsedAtom)).toBe(true);

    localStorage.setItem(EXPLORER_GAMES_COLLAPSED_KEY, "false");
    vi.resetModules();
    const expandedFresh = await import("@/state/atoms/explorer");
    const expandedStore = createJotaiStore();
    expect(expandedStore.get(expandedFresh.explorerGamesCollapsedAtom)).toBe(false);

    localStorage.setItem(EXPLORER_GAMES_COLLAPSED_KEY, "not json");
    vi.resetModules();
    const corruptFresh = await import("@/state/atoms/explorer");
    const corruptStore = createJotaiStore();
    expect(corruptStore.get(corruptFresh.explorerGamesCollapsedAtom)).toBe(false);

    localStorage.removeItem(EXPLORER_GAMES_COLLAPSED_KEY);
    vi.resetModules();
    const defaultFresh = await import("@/state/atoms/explorer");
    const defaultStore = createJotaiStore();
    expect(defaultStore.get(defaultFresh.explorerGamesCollapsedAtom)).toBe(false);
  });
});
