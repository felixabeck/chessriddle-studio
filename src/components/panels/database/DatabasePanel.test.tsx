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
  dbTypeFamily,
  dbTabFamily,
  sessionsAtom,
  tabsAtom,
  activeTabAtom,
  localOptionsFamily,
  pinnedExplorerDatabaseFamily,
  referenceDbAtom,
} from "@/state/atoms";
import type { DatabaseHandle } from "@/bindings";
import { databaseHandleKey, type DatabaseList, type ManagedDatabaseInfo } from "@/utils/db";
import { DATABASE_LIST_KEY } from "@/hooks/useDatabaseList";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { catalogueI18n, shippedCatalogues } from "@/tests/catalogues";
import type { SupportedLocale } from "@/i18n";
import { formatNumber } from "@/utils/format";

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
    },
  };
});

import DatabasePanel, { fetchOpening } from "./DatabasePanel";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = MockResizeObserver;

// DataTable checks an empty media query for columns without a visibility restriction.
installMatchMediaStub({ matches: (query) => query === "" });

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
    },
  );
});

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
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    treeStore = createTreeStore();
    mocks.logError.mockReset().mockResolvedValue(undefined);
    mocks.getLichessGames.mockReset();
    mocks.getMasterGames.mockReset();
    mocks.getPublicLichessJson.mockReset();
    mocks.lexPgn.mockReset();
    mocks.getDatabases.mockReset();
    mocks.searchPosition.mockReset().mockResolvedValue([[], []]);
    mocks.collectionForDatabase.mockReset().mockResolvedValue(null);
    mocks.clearGames.mockReset().mockResolvedValue(undefined);
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

  test("lch_all: checkpoint 1 stops after explorer fetch before normalization when signal is aborted", async () => {
    const controller = new AbortController();
    mocks.getLichessGames.mockImplementation(async () => {
      controller.abort();
      return mockExplorerData;
    });

    const promise = fetchOpening(
      { type: "lch_all", fen: "startpos", options: {} as any, handle: "token-1" },
      "tab-1",
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

    const promise = fetchOpening(
      { type: "lch_all", fen: "startpos", options: {} as any, handle: "token-1" },
      "tab-1",
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

    const promise = fetchOpening(
      { type: "lch_master", fen: "startpos", options: {} as any, handle: "token-1" },
      "tab-1",
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

    const promise = fetchOpening(
      { type: "lch_master", fen: "startpos", options: {} as any, handle: "token-1" },
      "tab-1",
      controller.signal,
    );

    await expect(promise).rejects.toThrow("Cancellation");
    expect(mocks.logError).not.toHaveBeenCalled();
  });

  test.each(["lch_all", "lch_master"] as const)(
    "%s: ordinary failure retains siblings, openings and failure metadata",
    async (type) => {
      const fetcher = type === "lch_all" ? mocks.getLichessGames : mocks.getMasterGames;
      fetcher.mockResolvedValue(mockExplorerData);
      mocks.getPublicLichessJson.mockImplementation(async ({ game_id }: { game_id: string }) => {
        if (game_id === "g0") throw new Error("Connection failed");
        return `[White "W1"]\n[Black "B1"]\n\n1. d4 d5 *`;
      });
      mocks.lexPgn.mockResolvedValue([]);

      const result = await fetchOpening(
        { type, fen: "startpos", options: {} as any, handle: "token-1" },
        "tab-1",
      );

      expect(result.openings).toEqual([{ move: "e4", white: 50, black: 40, draw: 10 }]);
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

  async function renderPanel(
    store: ReturnType<typeof createJotaiStore>,
    swrConfig: SWRConfiguration,
    children?: ReactNode,
    panelTabId = tabId,
  ) {
    await act(async () => {
      root.render(
        <MantineProvider>
          <JotaiProvider store={store}>
            <TreeStateContext.Provider value={treeStore}>
              <WorkspaceTabScope tabId={panelTabId}>
                <SWRConfig value={swrConfig}>
                  {children}
                  <DatabasePanel />
                </SWRConfig>
              </WorkspaceTabScope>
            </TreeStateContext.Provider>
          </JotaiProvider>
        </MantineProvider>,
      );
    });
  }

  function selectedPanel(value: "games" | "stats" | "options") {
    const labels = { stats: "Stats", games: "Games", options: "Options" };
    const tab = Array.from(container.querySelectorAll('[role="tab"]')).find(
      (element) => element.textContent === `Board.Database.${labels[value]}`,
    );
    expect(tab).toBeDefined();
    expect(tab!.getAttribute("aria-selected")).toBe("true");
    const panel = document.getElementById(tab!.getAttribute("aria-controls")!);
    expect(container.contains(panel)).toBe(true);
    expect(panel?.getAttribute("role")).toBe("tabpanel");
    return panel!;
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
    store.set(dbTabFamily(tabId), "games");
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

  function expectMatches(panel: HTMLElement, count: number) {
    const nodes = Array.from(panel.querySelectorAll("p")).filter((node) =>
      node.textContent?.startsWith("Board.Database.Matches"),
    );
    expect(nodes).toHaveLength(1);
    expect(nodes[0].textContent).toBe(`Board.Database.Matches ${formatNumber(count)}`);
  }

  test.each([
    { label: "opening totals", moves: mockExplorerData.moves, count: 100 },
    { label: "no moves", moves: [], count: 2 },
  ])(
    "mounted partial failure: $label retains the survivor and counts returned games",
    async ({ moves, count }) => {
      const diagnostic = "partial-fetch-private-diagnostic";
      const store = await mountExplorer({ ...mockExplorerData, moves }, ["g0"], diagnostic);
      const panel = selectedPanel("games");
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
      expectMatches(panel, count);

      await act(async () => {
        store.set(dbTabFamily(tabId), "stats");
      });
      const stats = selectedPanel("stats");
      expect(stats.textContent).not.toContain("Board.Database.GamesIncomplete");
      expect(stats.textContent).not.toContain("Board.Database.GamesFailed");
      expect(stats.textContent?.includes("e4") ?? false).toBe(moves.length > 0);
    },
  );

  test("mounted all failed: names every game without an empty games table or raw diagnostic", async () => {
    const diagnostic = "all-fetch-private-diagnostic";
    await mountExplorer(mockExplorerData, ["g0", "g1"], diagnostic);
    const panel = selectedPanel("games");
    expect(panel.textContent).toContain("Board.Database.GamesFailed W0 - B0, W1 - B1");
    expect(panel.textContent).not.toContain("Board.Database.GamesIncomplete");
    expect(panel.textContent).not.toContain("Databases.Game.NoGamesFound");
    expect(panel.querySelector("table")).toBeNull();
    expect(panel.textContent).not.toContain(diagnostic);
    expectMatches(panel, 100);
  });

  test("mounted empty explorer list: keeps the genuine empty state and opening Matches total", async () => {
    await mountExplorer({ ...mockExplorerData, topGames: [] }, []);
    const panel = selectedPanel("games");
    expect(panel.textContent).toContain("Databases.Game.NoGamesFound");
    expect(panel.querySelector(".mantine-datatable-empty-state[data-active]")).not.toBeNull();
    expect(panel.textContent).not.toContain("Board.Database.GamesIncomplete");
    expect(panel.textContent).not.toContain("Board.Database.GamesFailed");
    expectMatches(panel, 100);
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
      const panel = selectedPanel("games");
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
    store.set(dbTabFamily(tabId), "stats");
    // Hydrate the real persisted atom and seed an unrelated old per-tab search path.
    localStorage.setItem("reference-database", JSON.stringify(reference));
    store.set(localOptionsFamily(tabId), {
      ...store.get(localOptionsFamily(tabId)),
      path: stalePath,
      player,
      player_database: player !== null ? databaseHandleKey(pin ?? reference) : undefined,
      fen: treeStore.getState().currentNode().fen,
      result: "draw",
      elo: [1800, 2400],
      exclude_fast_events: true,
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

  function expectSavedChoice(store: ReturnType<typeof createJotaiStore>) {
    expect(store.get(referenceDbAtom)).toEqual(reference);
    expect(JSON.parse(localStorage.getItem("reference-database")!)).toEqual(reference);
  }

  function expectNoReference(value: "stats" | "games" | "options" = "stats") {
    const panel = selectedPanel(value);
    const tab = container.querySelector(`[role="tab"][aria-controls="${panel.id}"]`);
    expect(panel.getAttribute("aria-labelledby")).toBe(tab?.id);
    expect({ [value]: panel.textContent }).toEqual({
      [value]: expect.stringContaining("Board.Database.NoReference1"),
    });
    expect({
      [value]: panel.querySelector<HTMLInputElement>(".mantine-Select-input")?.value,
    }).toEqual({ [value]: "" });
  }

  test("local: readable persisted handle searches with preserved filters and overrides stale tab path", async () => {
    mocks.getDatabases.mockResolvedValue(databaseList([readable]));
    const { store } = await mountLocal();

    expect(mocks.searchPosition).toHaveBeenCalled();
    for (const call of mocks.searchPosition.mock.calls) {
      expect(call).toEqual([
        reference,
        expect.objectContaining({
          wanted_result: "draw",
          range1: [1800, 2400],
          range2: [1800, 2400],
          exclude_fast_events: true,
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
      mocks.searchPosition.mockClear();

      const selector =
        selectedPanel("stats").querySelector<HTMLInputElement>(".mantine-Select-input")!;
      await act(async () => selector.click());
      const option = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(
        (item) => item.textContent === (pinned ? "Saved reference" : "Other database"),
      );
      expect(option).toBeDefined();
      await act(async () => option!.click());

      expect(mocks.clearGames).toHaveBeenCalledOnce();
      expect(store.get(localOptionsFamily(tabId)).player).toBe(42);
      expect(store.get(localOptionsFamily(tabId)).player_database).toBe(
        databaseHandleKey(initialDatabase),
      );
      expect(mocks.searchPosition).toHaveBeenCalled();
      for (const [database, query] of mocks.searchPosition.mock.calls) {
        expect(database).toEqual(nextDatabase);
        expect(query.player1 ?? null).toBeNull();
        expect(query.player2 ?? null).toBeNull();
      }
      expect(store.get(pinnedExplorerDatabaseFamily(tabId))).toEqual(pinned ? nextDatabase : null);
      expect(store.get(referenceDbAtom)).toEqual(pinned ? reference : nextDatabase);
      expect(JSON.parse(localStorage.getItem("reference-database")!)).toEqual(
        pinned ? reference : nextDatabase,
      );
    },
  );

  test("local: a second unpinned tab changes the global reference without sending the first tab's player to it", async () => {
    mocks.getDatabases.mockResolvedValue(
      databaseList([readable, { ...readable, file: stalePath, title: "Other database" }]),
    );
    const { store, swrConfig } = await mountLocal(undefined, 42);
    expect(mocks.searchPosition.mock.lastCall?.[0]).toEqual(reference);
    expect(mocks.searchPosition.mock.lastCall?.[1].player1).toBe(42);

    const secondTabId = "22222222-2222-4222-8222-222222222222";
    await act(async () => {
      store.set(tabsAtom, [validTab, { ...validTab, value: secondTabId, name: "Tab 2" }]);
      store.set(dbTypeFamily(secondTabId), "local");
      store.set(dbTabFamily(secondTabId), "stats");
      store.set(activeTabAtom, secondTabId);
    });
    await renderPanel(store, swrConfig, undefined, secondTabId);
    const selector =
      selectedPanel("stats").querySelector<HTMLInputElement>(".mantine-Select-input")!;
    await act(async () => selector.click());
    const option = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(
      (item) => item.textContent === "Other database",
    );
    expect(option).toBeDefined();
    await act(async () => option!.click());
    expect(store.get(referenceDbAtom)).toEqual(stalePath);
    expect(store.get(localOptionsFamily(tabId)).player).toBe(42);
    mocks.searchPosition.mockClear();

    await act(async () => store.set(activeTabAtom, tabId));
    await renderPanel(store, swrConfig);
    expect(mocks.searchPosition).toHaveBeenCalled();
    for (const [database, query, owner] of mocks.searchPosition.mock.calls) {
      expect(owner).toBe(tabId);
      expect(database).toEqual(stalePath);
      expect(query.player1 ?? null).toBeNull();
      expect(query.player2 ?? null).toBeNull();
    }
    expect(store.get(localOptionsFamily(tabId)).player_database).toBe(databaseHandleKey(reference));
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

  test("local: legacy player selections without an owner retain same-database behavior", async () => {
    mocks.getDatabases.mockResolvedValue(databaseList([readable]));
    const { store } = await mountLocal(undefined, 42);
    await act(async () =>
      store.set(localOptionsFamily(tabId), (options) => ({
        ...options,
        player_database: undefined,
      })),
    );
    expect(mocks.searchPosition.mock.lastCall?.[0]).toEqual(reference);
    expect(mocks.searchPosition.mock.lastCall?.[1].player1).toBe(42);
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
      for (const value of ["stats", "games", "options"] as const) {
        await act(async () => {
          store.set(dbTabFamily(tabId), value);
        });
        expectNoReference(value);
      }
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

  test("local: admitted search failures retain their native error presentation", async () => {
    mocks.getDatabases.mockResolvedValue(databaseList([readable]));
    mocks.searchPosition.mockRejectedValue(new Error("Native position search failed"));
    await mountLocal();
    expect(container.textContent).toContain("Native position search failed");
    expect(container.textContent).not.toContain("Board.Database.NoReference1");
  });

  test("local: collection-unavailable presentation yields to the missing effective reference warning", async () => {
    mocks.getDatabases.mockResolvedValue(databaseList([readable]));
    mocks.collectionForDatabase.mockRejectedValue(new Error("Collection unavailable"));
    const { store, revalidate } = await mountLocal();
    expect(container.textContent).toContain("Collections.Unavailable");
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
    jotaiStore.set(dbTabFamily(tabId), "moves");
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
    jotaiStore.set(dbTabFamily(tabId), "moves");
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
    jotaiStore.set(dbTabFamily(tabId), "moves");
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
});
