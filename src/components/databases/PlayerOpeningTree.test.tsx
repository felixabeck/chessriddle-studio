import { MantineProvider, type SelectProps } from "@mantine/core";
import { INITIAL_FEN } from "chessops/fen";
import { createStore, Provider } from "jotai";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SWRConfig } from "swr";
import { afterAll, afterEach, beforeEach, expect, test, vi } from "vitest";
import { analysisTabsHiddenAtom } from "@/state/layoutStorage";
import type {
  DatabaseHandle,
  PositionSearchQuery,
  NormalizedGame,
  Player,
  PositionStats,
} from "@/bindings";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import DatabasePanel from "@/components/panels/database/DatabasePanel";
import {
  dbTabFamily,
  dbTypeFamily,
  localOptionsFamily,
  opponentLinksAtom,
  pinnedExplorerComparisonFamily,
  pinnedExplorerDatabaseFamily,
  pinnedExplorerFurtherColumnsFamily,
  referenceDbAtom,
  tabFamily,
  tabsAtom,
} from "@/state/atoms";
import { createTreeStore, type TreeStore } from "@/state/store/tree";
import { WorkspaceTabScope } from "@/state/tabScope";
import { installInlineComputedStyleStub } from "@/tests/computedStyle";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { chooseSelectOption } from "@/tests/select";
import { stubScrollIntoView } from "@/tests/scrollIntoView";
import { catalogueI18n, shippedCatalogues } from "@/tests/catalogues";
import { expectHoverTooltip } from "@/tests/tooltip";
import type { SupportedLocale } from "@/i18n";
import { getNodeAtPath } from "@/utils/treeReducer";
import { databaseHandleKey } from "@/utils/db";
import PlayerOpeningTree, {
  AccountOpeningTree,
  formatOpponentRating,
  type OpeningTreeSource,
} from "./PlayerOpeningTree";
import classes from "./PlayerOpeningTree.module.css";

const mocks = vi.hoisted(() => ({
  searchPosition: vi.fn(),
  selectOnChange: vi.fn(),
  navigate: vi.fn(),
  notify: vi.fn(),
  createTab: vi.fn(),
  openGame: vi.fn(),
  getPlayer: vi.fn(),
  unavailable: new Set<string>(),
  /** Databases listed beside the two fixtures, as the listing reports them. */
  listedToo: [] as unknown[],
  onlinePlayers: vi.fn(),
  showNotification: vi.fn(),
}));
vi.mock("@mantine/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mantine/core")>();
  function Select(props: SelectProps) {
    return (
      <actual.Select
        {...props}
        onChange={(value, option) => {
          mocks.selectOnChange(value, option);
          props.onChange?.(value, option);
        }}
      />
    );
  }
  return { ...actual, Select };
});
vi.mock("./opponentLookup", () => ({ opponentPlayers: mocks.onlinePlayers }));
vi.mock("@mantine/notifications", async (original) => {
  const actual = await original<typeof import("@mantine/notifications")>();
  return { ...actual, notifications: { ...actual.notifications, show: mocks.showNotification } };
});
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mocks.navigate, Link: () => null }));
vi.mock("@/components/files/notifyError", async (original) => ({
  ...(await original<typeof import("@/components/files/notifyError")>()),
  notifyUnlessCancelled: mocks.notify,
}));
vi.mock("@/utils/tabs", async (original) => {
  const actual = await original<typeof import("@/utils/tabs")>();
  mocks.createTab.mockImplementation(actual.createTab);
  return { ...actual, createTab: mocks.createTab };
});
vi.mock("@/utils/databaseGame", () => ({ openDatabaseGame: mocks.openGame }));
vi.mock("@/platform/tauri", async (original) => {
  const actual = await original<typeof import("@/platform/tauri")>();
  return {
    ...actual,
    tauri: { ...actual.tauri, searchPosition: mocks.searchPosition, getPlayer: mocks.getPlayer },
  };
});
vi.mock("@/state/linkedCollections", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/state/linkedCollections")>();
  const { useDatabaseWriteRevision } = await import("@/platform/databaseWrites");
  return {
    ...actual,
    useCollectionCurrency: () => ({ collection: null, pending: false }),
    useDatabaseContentRevision: (file: DatabaseHandle | null | undefined) => {
      const writes = useDatabaseWriteRevision(file);
      return {
        revision: [null, writes] as const,
        unavailable: !!file && mocks.unavailable.has(file.id.id),
      };
    },
  };
});
vi.mock("@/hooks/useDatabaseList", () => ({
  DATABASE_LIST_KEY: "databases",
  useDatabaseList: () => ({
    data: {
      databases: [
        ...[file, reference].map((handle) => ({
          type: "success",
          file: handle,
          title: handle.id.id,
          filename: "test.db3",
        })),
        ...mocks.listedToo,
      ],
    },
  }),
}));
vi.mock("@/chessground/Chessground", () => ({
  Chessground: (props: { fen: string; orientation: string; viewOnly: boolean }) => (
    <div
      data-board-fen={props.fen}
      data-orientation={props.orientation}
      data-readonly={props.viewOnly}
    />
  ),
}));
vi.mock("./GamePreview", () => ({
  default: ({ pgn }: { pgn: string }) => <div data-game-preview>{pgn}</div>,
}));
vi.mock("@/components/panels/database/DatabaseLoader", () => ({
  default: ({ progressId, label }: { progressId: string; label: string }) => (
    <div data-progress={progressId}>{label}</div>
  ),
}));

// Use real catalogue interpolation and <Trans> rendering for totals, scores and accessible controls.
let i18nInstance: Awaited<ReturnType<typeof catalogueI18n>>;
const translate = (key: string, options?: Record<string, unknown>) => i18nInstance.t(key, options);
vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();
  return {
    ...actual,
    useTranslation: () => ({ t: translate, i18n: i18nInstance }),
    Trans: (props: Parameters<typeof actual.Trans>[0]) => (
      <actual.Trans {...props} t={props.t ?? i18nInstance.t} i18n={props.i18n ?? i18nInstance} />
    ),
  };
});

const file: DatabaseHandle = { kind: "database", id: { id: "card-A" } };
const reference: DatabaseHandle = { kind: "database", id: { id: "global-B" } };
const player: Player = { id: 42, name: "Selected player", elo: 2100, game_count: 7 };
const first: NormalizedGame = {
  id: 1,
  fen: INITIAL_FEN,
  white: player.name!,
  white_id: 42,
  black: "First opponent",
  black_id: 2,
  black_elo: 1800,
  date: "2026.11.01",
  result: "*",
  event: "First event",
  event_id: 1,
  site: "?",
  site_id: 1,
  moves: "1. e4 e5 *",
};
const next: NormalizedGame = { ...first, id: 2, black: "Next opponent", date: "2026.11.02" };
const startRows: PositionStats[] = [
  {
    move: "e4",
    white: 3,
    draw: 1,
    black: 1,
    unknown: 1,
    last_played: null,
    year_counts: [],
    recent: [],
  },
  {
    move: "d4",
    white: 0,
    draw: 0,
    black: 0,
    unknown: 2,
    last_played: null,
    year_counts: [],
    recent: [],
  },
  {
    move: "*",
    white: 0,
    draw: 1,
    black: 0,
    unknown: 0,
    last_played: null,
    year_counts: [],
    recent: [],
  },
];
const e4Fen = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
const endFen = "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2";
let root: Root;
let container: HTMLDivElement;
let store: ReturnType<typeof createStore>;
let cache: Map<any, any>;
let treeStore: TreeStore | undefined;
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
installMatchMediaStub({ matches: () => false });
installInlineComputedStyleStub();
const restoreScrollIntoView = stubScrollIntoView();
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.navigate.mockReset();
  const actual = await vi.importActual<typeof import("@/utils/tabs")>("@/utils/tabs");
  mocks.createTab.mockImplementation(actual.createTab);
  mocks.openGame.mockResolvedValue("opened-game");
  mocks.getPlayer.mockReset().mockResolvedValue(player);
  mocks.unavailable.clear();
  mocks.listedToo = [];
  mocks.onlinePlayers.mockReset().mockResolvedValue([]);
  i18nInstance = await catalogueI18n("en-US");
  localStorage.clear();
  // The explorer's filter button is reached below; its header is collapsed by default.
  localStorage.setItem("explorer-header-collapsed", "false");
  sessionStorage.clear();
  // Hydrate the existing preference without writing it through the application atom.
  localStorage.setItem("reference-database", JSON.stringify(reference));
  store = createStore();
  cache = new Map();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  mocks.searchPosition.mockImplementation(
    async (_path: DatabaseHandle, query: PositionSearchQuery) =>
      query.position?.fen === INITIAL_FEN
        ? [startRows, [first]]
        : [
            [
              {
                move: "e5",
                white: 3,
                draw: 1,
                black: 1,
                unknown: 1,
                last_played: null,
                year_counts: [],
                recent: [],
              },
            ],
            [next],
          ],
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  treeStore = undefined;
  container.remove();
  vi.useRealTimers();
});
afterAll(() => restoreScrollIntoView());

async function render(playerOverride = player, fileOverride = file, panelId?: string) {
  await act(async () =>
    root.render(
      <MantineProvider>
        <Provider store={store}>
          <SWRConfig
            key={panelId ?? "tree"}
            value={{ provider: () => cache, dedupingInterval: 0, shouldRetryOnError: false }}
          >
            {panelId ? (
              <TreeStateContext.Provider value={treeStore!}>
                <WorkspaceTabScope tabId={panelId}>
                  <DatabasePanel />
                </WorkspaceTabScope>
              </TreeStateContext.Provider>
            ) : (
              <PlayerOpeningTree player={playerOverride} file={fileOverride} />
            )}
          </SWRConfig>
        </Provider>
      </MantineProvider>,
    ),
  );
}
function row(move: string) {
  return [...container.querySelectorAll<HTMLTableRowElement>("[data-opening-moves] tbody tr")].find(
    (item) => item.cells[0].lastChild?.textContent === move,
  )!;
}
async function click(element: Element) {
  expect(element).toBeTruthy();
  await act(async () => (element as HTMLElement).click());
}
function button(label: string) {
  return [...container.querySelectorAll("button")].find(
    (item) => item.textContent === label || item.getAttribute("aria-label") === label,
  )!;
}
async function black() {
  await click(container.querySelector('input[value="black"]')!);
}

function sinceInput() {
  const input = container.querySelector<HTMLInputElement>(
    "[data-opening-toolbar] input.mantine-Select-input",
  );
  if (!input) throw new Error("Since select is not rendered");
  return input;
}

async function since(value: string) {
  await chooseSelectOption(sinceInput(), value);
}

test.each([
  ["Imnadze, Giorgi", "Imnadze"],
  ["Selected player", "Selected player"],
  ["", "Player"],
])("the colour switch names %s and explains both preparation sides", async (fullName, name) => {
  await render({ ...player, name: fullName });
  const switchControl = container.querySelector('[role="radiogroup"]');
  expect(switchControl?.getAttribute("aria-label")).toBe(`${name} plays:`);
  expect(container.textContent).toContain(`${name} plays:`);
  expect(container.textContent).toContain(
    `Showing games where ${name} has White. You prepare with Black.`,
  );
  expect(mocks.searchPosition.mock.lastCall?.[1]).toMatchObject({
    player1: 42,
    player2: undefined,
  });
  await black();
  expect(container.textContent).toContain(
    `Showing games where ${name} has Black. You prepare with White.`,
  );
  expect(mocks.searchPosition.mock.lastCall?.[1]).toMatchObject({
    player1: undefined,
    player2: 42,
  });
});

test("an opponent rating of 0 or none reads as unrated", () => {
  expect(formatOpponentRating(1800)).toBe(1800);
  expect(formatOpponentRating(0)).toBe("–");
  expect(formatOpponentRating(null)).toBe("–");
  expect(formatOpponentRating(undefined)).toBe("–");
});

test("the tree enlarges W/D/L labels, shows 25% and hides 15%", async () => {
  mocks.searchPosition.mockResolvedValueOnce([
    [{ ...startRows[0], white: 12, draw: 5, black: 3 }],
    [first],
  ]);
  await render();
  const chart = row("e4").cells[4].querySelector<HTMLElement>(".mantine-Progress-root")!;
  expect(chart.style.getPropertyValue("--progress-size")).toBe("1.125rem");
  expect(
    [...chart.querySelectorAll(".mantine-Progress-label")].map((label) => label.textContent),
  ).toEqual(["60.0%", "25.0%", ""]);
});

test("moves and the terminal row show their own last played date and year strip", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 10, 8, 12));
  mocks.searchPosition.mockResolvedValueOnce([
    startRows.map((row, index) => ({
      ...row,
      last_played: index === 0 ? "2026.11.01" : index === 2 ? "2024.??.??" : null,
      year_counts:
        index === 0 ? [{ year: 2026, count: 6 }] : index === 2 ? [{ year: 2024, count: 1 }] : [],
    })),
    [first],
  ]);
  await render();
  expect(container.querySelector("[data-opening-moves] thead")?.textContent).toContain(
    "Last played",
  );
  expect(row("e4").querySelector("[data-opening-last-played]")?.textContent).toContain("2026-11");
  expect(row("d4").querySelector("[data-opening-last-played]")?.textContent).toContain("–");
  const terminal = row("Game ended here");
  expect(terminal.querySelector("[data-opening-last-played]")?.textContent).toContain("2024");
  expect(terminal.querySelectorAll("[data-count]")).toHaveLength(9);
  expect(terminal.querySelector('[role="img"]')?.getAttribute("aria-label")).toContain(
    "2024: 1 of 1 game (100%)",
  );
});

test("clicking the selected Since keeps All games and does not search again", async () => {
  await render();
  const searches = mocks.searchPosition.mock.calls.length;
  expect(sinceInput().value).toBe("All games");
  mocks.selectOnChange.mockClear();
  await chooseSelectOption(sinceInput(), "all");
  expect(sinceInput().value).toBe("All games");
  expect(mocks.selectOnChange).not.toHaveBeenCalled();
  expect(mocks.selectOnChange).not.toHaveBeenCalledWith(null);
  expect(mocks.searchPosition).toHaveBeenCalledTimes(searches);
});

test("Since keeps one rolling cutoff for the search and Prepare, retains moves and clears selection", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 10, 8, 12));
  await render();
  expect(sinceInput().closest(".mantine-Select-root")).not.toBeNull();
  expect(container.querySelector("select")).toBeNull();
  expect(sinceInput().value).toBe("All games");
  expect(mocks.searchPosition.mock.lastCall?.[1].startDate).toBeUndefined();
  await click(row("e4"));
  await click(container.querySelector("[data-opening-games] tbody tr")!);
  expect(container.querySelector("[data-opening-preview]")).not.toBeNull();
  await since("1");
  expect(mocks.searchPosition.mock.lastCall?.[1]).toMatchObject({
    startDate: "2025.11.08",
    position: { fen: e4Fen },
  });
  expect(container.querySelector("[data-opening-games]")?.textContent).toContain("Next opponent");
  expect(container.querySelector("[data-opening-preview]")).toBeNull();
  expect(container.querySelector("[data-opening-sequence]")?.textContent).toBe("1. e4");
  vi.setSystemTime(new Date(2026, 10, 9, 12));
  await black();
  expect(mocks.searchPosition.mock.lastCall?.[1].startDate).toBe("2025.11.08");
  await click(button("Prepare on board"));
  const id = store.get(tabsAtom).at(-1)!.value;
  expect(store.get(localOptionsFamily(id))).toMatchObject({
    start_date: "2025.11.08",
    color: "black",
    fen: e4Fen,
  });
  await since("5");
  expect(mocks.searchPosition.mock.lastCall?.[1].startDate).toBe("2021.11.09");
  await since("2");
  expect(mocks.searchPosition.mock.lastCall?.[1].startDate).toBe("2024.11.09");
  mocks.searchPosition.mockResolvedValueOnce([[], []]);
  await since("all");
  expect(mocks.searchPosition.mock.lastCall?.[1].startDate).toBeUndefined();
  expect(container.textContent).toContain("No games in this position");
  await click(button("Prepare on board"));
  const allId = store.get(tabsAtom).at(-1)!.value;
  expect(store.get(localOptionsFamily(allId))).not.toHaveProperty("start_date");
});

test("native query, scores, terminal row and navigation follow the player's exact position", async () => {
  await render();
  expect(mocks.searchPosition).toHaveBeenCalledWith(
    file,
    expect.objectContaining({
      player1: 42,
      player2: undefined,
      position: { fen: INITIAL_FEN, type_: "exact" },
      includeUnknownResults: true,
      sampleOrder: "date",
    }),
    expect.any(String),
    { signal: expect.any(AbortSignal) },
  );
  expect(container.textContent).toContain("9 games in this position");
  expect(row("e4").cells[1].lastChild?.textContent).toBe("6");
  expect(row("e4").cells[3].lastChild?.textContent).toBe("70.0%");
  expect(row("e4").querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("60");
  expect(row("d4").cells[1].lastChild?.textContent).toBe("2");
  expect(row("d4").cells[3].lastChild?.textContent).toBe("–");
  expect(row("d4").querySelectorAll('[role="progressbar"]')).toHaveLength(0);
  const terminal = row("Game ended here");
  expect(terminal.hasAttribute("tabindex")).toBe(false);
  await click(terminal);
  expect(mocks.searchPosition).toHaveBeenCalledTimes(1);
  await black();
  expect(mocks.searchPosition.mock.lastCall?.[1]).toMatchObject({
    player1: undefined,
    player2: 42,
  });
  expect(row("e4").cells[3].lastChild?.textContent).toBe("30.0%");
  expect(row("e4").querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("20");
  expect(container.querySelector("[data-board-fen]")?.getAttribute("data-orientation")).toBe(
    "black",
  );
  await act(async () =>
    row("e4").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
  );
  expect(container.querySelector("[data-board-fen]")?.getAttribute("data-board-fen")).toBe(e4Fen);
  expect(mocks.searchPosition.mock.lastCall?.[1].position.fen).toBe(e4Fen);
  expect(container.querySelector("[data-opening-games]")?.textContent).toContain("Selected player");
  await click(button("Previous move"));
  expect(container.querySelector("[data-opening-board]")?.getAttribute("data-fen")).toBe(
    INITIAL_FEN,
  );
  await click(row("e4"));
  await click(row("e5"));
  expect(container.querySelector("[data-opening-board]")?.getAttribute("data-fen")).toBe(endFen);
  expect(container.querySelector("[data-opening-sequence]")?.textContent).toBe("1. e4 e5");
  await click(button("Reset to start"));
  expect(container.querySelector("[data-opening-board]")?.getAttribute("data-fen")).toBe(
    INITIAL_FEN,
  );
  expect(
    mocks.searchPosition.mock.calls.some(
      (call) => call[1].position.fen === INITIAL_FEN && call[1].player2 === 42,
    ),
  ).toBe(true);
  expect(row("e4").cells[1].lastChild?.textContent).toBe("6");
});

test("game selection previews within the card, Open and double-click use the established opening flow", async () => {
  await render();
  expect(container.querySelector("[data-opening-preview]")).toBeNull();
  await click(container.querySelector("[data-opening-games] tbody tr")!);
  expect(container.querySelector('[aria-selected="true"]')).not.toBeNull();
  expect(container.querySelector("[data-game-preview]")?.textContent).toBe(first.moves);
  await click(button("Open on board"));
  expect(mocks.openGame).toHaveBeenCalledWith(
    expect.objectContaining({
      game: first,
      database: file,
      targetFens: [INITIAL_FEN],
      fromPreview: true,
    }),
  );
  expect(mocks.navigate).toHaveBeenCalledWith({ to: "/" });
  await act(async () =>
    container
      .querySelector("[data-opening-games] tbody tr")!
      .dispatchEvent(new MouseEvent("dblclick", { bubbles: true })),
  );
  expect(mocks.openGame).toHaveBeenCalledTimes(2);
  await click(row("e4"));
  expect(container.querySelector("[data-opening-preview]")).toBeNull();
  expect(container.querySelector("[data-opening-games]")?.textContent).toContain("Next opponent");
  await act(async () =>
    container
      .querySelector("[data-opening-games] tbody tr")!
      .dispatchEvent(new MouseEvent("dblclick", { bubbles: true })),
  );
  expect(mocks.openGame).toHaveBeenLastCalledWith(expect.objectContaining({ targetFens: [e4Fen] }));
  await click(button("Previous move"));
  expect(container.querySelector("[data-opening-games]")?.textContent).toContain("First opponent");
});

test("Open on board and double-click share one in-flight open", async () => {
  let complete!: (value: string) => void;
  mocks.openGame.mockReset();
  mocks.openGame.mockReturnValue(
    new Promise((resolve) => {
      complete = resolve;
    }),
  );
  await render();
  await click(container.querySelector("[data-opening-games] tbody tr")!);
  const openButton = container.querySelector("[data-opening-open]")!;
  await click(openButton);
  await click(openButton);
  await act(async () =>
    container
      .querySelector("[data-opening-games] tbody tr")!
      .dispatchEvent(new MouseEvent("dblclick", { bubbles: true })),
  );
  expect(mocks.openGame).toHaveBeenCalledTimes(1);
  expect(openButton.getAttribute("aria-busy")).toBe("true");
  await act(async () => complete("opened-game"));
  await click(container.querySelector("[data-opening-open]")!);
  expect(mocks.openGame).toHaveBeenCalledTimes(2);
});

test("Prepare admits the mainline and orientation, presets before navigation, then the real Database panel searches A while reference B stays unchanged", async () => {
  await render();
  await click(row("e4"));
  await click(row("e5"));
  await black();
  mocks.navigate.mockImplementation(() => {
    const id = store.get(tabsAtom).at(-1)!.value;
    expect(store.get(pinnedExplorerDatabaseFamily(id))).toEqual(file);
    expect(store.get(localOptionsFamily(id))).toEqual({
      path: file,
      player: 42,
      player_database: databaseHandleKey(file),
      color: "black",
      fen: endFen,
      type: "exact",
      result: "any",
    });
    expect(store.get(localOptionsFamily(id))).not.toHaveProperty("include_unknown_results");
    expect(store.get(localOptionsFamily(id))).not.toHaveProperty("sample_order");
    expect(store.get(tabFamily(id))).toBe("database");
    // Database lives in the tab strip in the default layout, so a hidden strip is shown.
    expect(store.get(analysisTabsHiddenAtom)).toBe(false);
    expect(store.get(dbTypeFamily(id))).toBe("local");
    expect(store.get(dbTabFamily(id))).toBe("stats");
  });
  store.set(analysisTabsHiddenAtom, true);
  await click(button("Prepare on board"));
  expect(mocks.navigate).toHaveBeenCalledOnce();
  const tab = store.get(tabsAtom).at(-1)!;
  treeStore = createTreeStore(tab.value);
  const tree = treeStore.getState();
  expect(tree.root.fen).toBe(INITIAL_FEN);
  expect(tree.root.children).toHaveLength(1);
  expect(tree.root.children[0].san).toBe("e4");
  expect(tree.root.children[0].children[0].san).toBe("e5");
  expect(tree.position).toEqual([0, 0]);
  expect(getNodeAtPath(tree.root, tree.position).fen).toBe(endFen);
  expect(tree.headers.orientation).toBe("black");
  mocks.searchPosition.mockClear();
  cache = new Map();
  await render(player, file, tab.value);
  await vi.waitFor(() =>
    expect(mocks.searchPosition).toHaveBeenCalledWith(
      file,
      expect.objectContaining({
        player2: 42,
        position: { fen: endFen, type_: "exact" },
      }),
      tab.value,
      { signal: expect.any(AbortSignal) },
    ),
  );
  expect(mocks.searchPosition.mock.lastCall?.[1]).not.toHaveProperty("includeUnknownResults");
  expect(mocks.searchPosition.mock.lastCall?.[1]).not.toHaveProperty("sampleOrder");
  // The pinned source's filters open from its filter button and show the seeded player.
  const filters = container.querySelector<HTMLButtonElement>(
    '[data-explorer-source] button[aria-haspopup="dialog"]',
  )!;
  await act(async () => filters.click());
  await vi.waitFor(() =>
    expect(
      document.querySelector<HTMLInputElement>(
        "[data-explorer-filters] .mantine-Autocomplete-input",
      )?.value,
    ).toBe(player.name),
  );
  expect(mocks.getPlayer).toHaveBeenCalledWith(file, 42);
  for (const [database, id] of mocks.getPlayer.mock.calls) {
    expect(database).toEqual(file);
    expect(id).toBe(42);
  }
  expect(store.get(referenceDbAtom)).toEqual(reference);
  expect(JSON.parse(localStorage.getItem("reference-database")!)).toEqual(reference);
});

const online: DatabaseHandle = { kind: "database", id: { id: "online-games" } };
const onlineFilename = "opponent-11111111-1111-4111-8111-111111111111-0a1b2c3d.db3";
const onlineAccounts = [
  { provider: "lichess", username: "SelectedOnline" },
  { provider: "chesscom", username: "selected_online" },
] as const;

/** Links the fixture player to online accounts; `listed` says how the listing reports the games. */
function linkOnlineGames(listed: "readable" | "unreadable" | "absent" | "none") {
  store.set(opponentLinksAtom, [
    {
      id: "11111111-1111-4111-8111-111111111111",
      playerName: player.name!,
      accounts: [...onlineAccounts],
      filter: { years: 3, timeControls: ["blitz", "rapid"] },
      ...(listed === "none" ? {} : { database: onlineFilename }),
    },
  ]);
  if (listed === "readable") {
    mocks.listedToo = [
      {
        type: "success",
        file: online,
        title: "Selected player (online)",
        filename: onlineFilename,
      },
    ];
  } else if (listed === "unreadable") {
    mocks.listedToo = [{ type: "error", file: online, filename: onlineFilename, error: "broken" }];
  }
}

test("Prepare pins the player's downloaded online games as the board's second column", async () => {
  linkOnlineGames("readable");
  mocks.onlinePlayers.mockResolvedValue([
    { id: 5, name: "selected_online" },
    { id: 9, name: "SelectedOnline" },
  ]);
  mocks.getPlayer.mockImplementation(async (database: DatabaseHandle, id: number) =>
    database === online ? { id, name: "selected_online", elo: null, game_count: 1 } : player,
  );
  await render();
  await click(button("Prepare on board"));

  expect(mocks.onlinePlayers).toHaveBeenCalledExactlyOnceWith(online, [...onlineAccounts]);
  expect(mocks.navigate).toHaveBeenCalledOnce();
  expect(mocks.showNotification).not.toHaveBeenCalled();
  const tab = store.get(tabsAtom).at(-1)!;
  expect(store.get(pinnedExplorerDatabaseFamily(tab.value))).toEqual(file);
  expect(store.get(pinnedExplorerFurtherColumnsFamily(tab.value))).toEqual(["reference"]);
  // Usernames that stayed separate players: the board follows the first one.
  expect(store.get(pinnedExplorerComparisonFamily(tab.value))).toEqual({
    database: online,
    player: 5,
  });
  expect(store.get(localOptionsFamily(tab.value))).toMatchObject({
    player: 42,
    player_database: databaseHandleKey(file),
  });

  // The real board panel then searches both databases, each for its own player.
  treeStore = createTreeStore(tab.value);
  mocks.searchPosition.mockClear();
  cache = new Map();
  await render(player, file, tab.value);
  await vi.waitFor(() =>
    expect(mocks.searchPosition).toHaveBeenCalledWith(
      online,
      expect.objectContaining({ player1: 5 }),
      `${tab.value}:comparison`,
      { signal: expect.any(AbortSignal) },
    ),
  );
  expect(mocks.searchPosition).toHaveBeenCalledWith(
    file,
    expect.objectContaining({ player1: 42 }),
    tab.value,
    { signal: expect.any(AbortSignal) },
  );
  expect(mocks.searchPosition).toHaveBeenCalledWith(
    store.get(referenceDbAtom),
    expect.objectContaining({ player1: null }),
    `${tab.value}:reference`,
    { signal: expect.any(AbortSignal) },
  );
  expect(container.querySelectorAll("[data-explorer-source]")).toHaveLength(3);
  // Each header names the player its column is filtered to, with the colour searched.
  await vi.waitFor(() => expect(container.textContent).toContain("selected_online as White"));
  expect(container.textContent).toContain("Selected player as White");
  expect(container.textContent).not.toContain("Player ·");

  // Collapsed, as the board opens by default, each caption names its player on its own line.
  await click(button("Hide database settings"));
  expect(
    [...container.querySelectorAll("[data-explorer-source-detail]")].map((d) => d.textContent),
  ).toEqual(["Selected player as White", "selected_online as White"]);
});

test("Prepare clicked while the card still looks up the online player asks once more and pins it", async () => {
  linkOnlineGames("readable");
  mocks.onlinePlayers
    .mockReturnValueOnce(new Promise(() => {}))
    .mockResolvedValue([{ id: 5, name: "selected_online" }]);
  await render();
  expect(section("online").querySelector("[data-opening-skeleton]")).toBeTruthy();
  await click(button("Prepare on board"));

  expect(mocks.onlinePlayers).toHaveBeenCalledTimes(2);
  expect(mocks.showNotification).not.toHaveBeenCalled();
  const tab = store.get(tabsAtom).at(-1)!;
  expect(store.get(pinnedExplorerComparisonFamily(tab.value))).toEqual({
    database: online,
    player: 5,
  });
});

test.each([
  ["finds no player", () => mocks.onlinePlayers.mockResolvedValue([])],
  ["fails", () => mocks.onlinePlayers.mockRejectedValue(new Error("database is locked"))],
])(
  "Prepare opens the board on one column with a warning when the online lookup %s",
  async (_name, arrange) => {
    linkOnlineGames("readable");
    arrange();
    await render();
    await click(button("Prepare on board"));

    expect(mocks.navigate).toHaveBeenCalledOnce();
    const tab = store.get(tabsAtom).at(-1)!;
    expect(store.get(pinnedExplorerDatabaseFamily(tab.value))).toEqual(file);
    expect(store.get(pinnedExplorerComparisonFamily(tab.value))).toBeNull();
    expect(mocks.showNotification).toHaveBeenCalledExactlyOnceWith({
      color: "warning",
      message: "The online games could not be added to the board.",
    });
    expect(mocks.notify).not.toHaveBeenCalled();
  },
);

test("Prepare opens the board on one column without a warning when the online lookup is cancelled", async () => {
  linkOnlineGames("readable");
  mocks.onlinePlayers.mockRejectedValue({
    tag: "backend-error",
    category: "cancellation",
    message: "Cancellation",
  });
  await render();
  await click(button("Prepare on board"));

  expect(mocks.navigate).toHaveBeenCalledOnce();
  const tab = store.get(tabsAtom).at(-1)!;
  expect(store.get(pinnedExplorerDatabaseFamily(tab.value))).toEqual(file);
  expect(store.get(pinnedExplorerComparisonFamily(tab.value))).toBeNull();
  expect(mocks.showNotification).not.toHaveBeenCalled();
});

test.each(["unreadable", "absent", "none"] as const)(
  "Prepare asks for no online player and warns of nothing while the online games are %s",
  async (listed) => {
    linkOnlineGames(listed);
    await render();
    await click(button("Prepare on board"));

    expect(mocks.onlinePlayers).not.toHaveBeenCalled();
    expect(mocks.showNotification).not.toHaveBeenCalled();
    const tab = store.get(tabsAtom).at(-1)!;
    expect(store.get(pinnedExplorerDatabaseFamily(tab.value))).toEqual(file);
    expect(store.get(pinnedExplorerComparisonFamily(tab.value))).toBeNull();
  },
);

test("the online games of the very database on the card are not its own second column", async () => {
  linkOnlineGames("none");
  store.set(opponentLinksAtom, (links) => [{ ...links[0], database: "test.db3" }]);
  await render();
  await click(button("Prepare on board"));

  expect(mocks.onlinePlayers).not.toHaveBeenCalled();
  expect(store.get(pinnedExplorerComparisonFamily(store.get(tabsAtom).at(-1)!.value))).toBeNull();
});

const onlineGame: NormalizedGame = {
  ...first,
  id: 77,
  white: "selected_online",
  white_id: 5,
  black: "Online opponent",
  event: "Rated blitz game",
  date: "2026.10.30",
};
const onlineRows: PositionStats[] = [
  {
    move: "e4",
    white: 20,
    draw: 5,
    black: 10,
    unknown: 0,
    last_played: null,
    year_counts: [],
    recent: [],
  },
  {
    move: "c4",
    white: 4,
    draw: 0,
    black: 1,
    unknown: 0,
    last_played: null,
    year_counts: [],
    recent: [],
  },
];
/** The online database answers with its own moves and games; every other database as before. */
function answerOnline() {
  const offline = mocks.searchPosition.getMockImplementation()!;
  mocks.searchPosition.mockImplementation(
    async (path: DatabaseHandle, query: PositionSearchQuery, ...rest: unknown[]) =>
      path === online ? [onlineRows, [onlineGame]] : offline(path, query, ...rest),
  );
}
function section(key: "primary" | "online") {
  return container.querySelector(`[data-opening-section="${key}"]`)!;
}
function onlineSearches() {
  return mocks.searchPosition.mock.calls.filter(([path]) => path === online).map(([, q]) => q);
}

test("the card shows the online games beside the over-the-board games, for the same colour and position", async () => {
  linkOnlineGames("readable");
  mocks.onlinePlayers.mockResolvedValue([{ id: 5, name: "selected_online" }]);
  answerOnline();
  await render();
  await vi.waitFor(() =>
    expect(section("online").querySelector("[data-opening-moves]")).toBeTruthy(),
  );

  expect(
    [...container.querySelectorAll("[data-opening-section-title]")].map((t) => t.textContent),
  ).toEqual(["Over the board", "Online", "Over the board", "Online"]);
  expect(section("primary").textContent).toContain("9 games in this position");
  expect(section("online").textContent).toContain("40 games in this position");
  expect(section("online").textContent).toContain("c4");
  expect(section("primary").textContent).not.toContain("c4");
  // The online player is searched with the card's colour and position.
  expect(onlineSearches().at(-1)).toMatchObject({
    player1: 5,
    player2: undefined,
    position: expect.objectContaining({ fen: INITIAL_FEN }),
  });
  expect(mocks.onlinePlayers).toHaveBeenCalledExactlyOnceWith(online, [...onlineAccounts]);

  // A move in the online table moves both tables to the new position.
  const onlineE4 = [...section("online").querySelectorAll<HTMLTableRowElement>("tbody tr")].find(
    (item) => item.cells[0].lastChild?.textContent === "e4",
  )!;
  await click(onlineE4);
  await vi.waitFor(() =>
    expect(onlineSearches().at(-1)).toMatchObject({
      position: expect.objectContaining({ fen: e4Fen }),
    }),
  );
  expect(container.querySelector("[data-opening-board]")?.getAttribute("data-fen")).toBe(e4Fen);
  expect(
    mocks.searchPosition.mock.calls.some(([path, q]) => path === file && q.position?.fen === e4Fen),
  ).toBe(true);

  // The other colour searches the online player as Black as well.
  await black();
  await vi.waitFor(() => expect(onlineSearches().at(-1)).toMatchObject({ player2: 5 }));
});

test("an online game previews and opens from its own database", async () => {
  linkOnlineGames("readable");
  mocks.onlinePlayers.mockResolvedValue([{ id: 5, name: "selected_online" }]);
  answerOnline();
  await render();
  const onlineGames = () =>
    container.querySelector('[data-opening-games-section="online"] [data-opening-games]');
  await vi.waitFor(() => expect(onlineGames()?.textContent).toContain("Online opponent"));

  await click(onlineGames()!.querySelector("tbody tr")!);
  expect(container.querySelector("[data-opening-preview]")).toBeTruthy();
  await click(container.querySelector("[data-opening-open]")!);
  expect(mocks.openGame).toHaveBeenCalledWith(
    expect.objectContaining({ game: onlineGame, database: online, targetFens: [INITIAL_FEN] }),
  );
});

test.each([
  ["finds no player", () => mocks.onlinePlayers.mockResolvedValue([])],
  ["fails", () => mocks.onlinePlayers.mockRejectedValue(new Error("database is locked"))],
])(
  "the online section says the games could not be read when the lookup %s",
  async (_name, arrange) => {
    linkOnlineGames("readable");
    arrange();
    await render();
    await vi.waitFor(() =>
      expect(section("online").textContent).toContain("The online games could not be read."),
    );
    expect(onlineSearches()).toEqual([]);
    expect(section("primary").querySelector("[data-opening-moves]")).toBeTruthy();
  },
);

test("a cancelled online lookup waits instead of reporting unreadable games", async () => {
  linkOnlineGames("readable");
  mocks.onlinePlayers.mockRejectedValue({
    tag: "backend-error",
    category: "cancellation",
    message: "Cancellation",
  });
  await render();
  await vi.waitFor(() =>
    expect(section("primary").querySelector("[data-opening-moves]")).toBeTruthy(),
  );
  await act(async () => {});
  expect(section("online").querySelector("[data-opening-skeleton]")).toBeTruthy();
  expect(section("online").textContent).not.toContain("could not be read");
});

test("the online section waits while its player is looked up", async () => {
  linkOnlineGames("readable");
  let resolve!: (players: { id: number; name: string }[]) => void;
  mocks.onlinePlayers.mockReturnValue(new Promise((done) => (resolve = done)));
  answerOnline();
  await render();
  await vi.waitFor(() =>
    expect(section("primary").querySelector("[data-opening-moves]")).toBeTruthy(),
  );
  expect(section("online").querySelector("[data-opening-skeleton]")).toBeTruthy();
  expect(onlineSearches()).toEqual([]);

  await act(async () => resolve([{ id: 5, name: "selected_online" }]));
  await vi.waitFor(() => expect(section("online").textContent).toContain("c4"));
});

test.each(["unreadable", "absent", "none"] as const)(
  "without readable online games the card keeps its single untitled section (%s)",
  async (listed) => {
    linkOnlineGames(listed);
    await render();
    await vi.waitFor(() => expect(container.querySelector("[data-opening-moves]")).toBeTruthy());
    expect(container.querySelector('[data-opening-section="online"]')).toBeNull();
    expect(container.querySelector("[data-opening-section-title]")).toBeNull();
  },
);

test.each(["rejection", "refusal"])(
  "Prepare %s applies no presets and does not navigate",
  async (outcome) => {
    await render();
    const failure = new Error("admission failed");
    if (outcome === "rejection") mocks.createTab.mockRejectedValueOnce(failure);
    else mocks.createTab.mockResolvedValueOnce(null);
    const writes = vi.spyOn(store, "set");
    await click(button("Prepare on board"));
    expect(writes).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(mocks.notify.mock.calls).toEqual(outcome === "rejection" ? [["Error", failure]] : []);
    writes.mockRestore();
  },
);

test("changing the player or database resets colour, moves and selected game", async () => {
  await render();
  await click(row("e4"));
  await black();
  for (const [otherPlayer, otherFile] of [
    [{ ...player, id: 43 }, file],
    [player, reference],
  ] as const) {
    await render(otherPlayer, otherFile);
    expect(container.querySelector("[data-board-fen]")?.getAttribute("data-board-fen")).toBe(
      INITIAL_FEN,
    );
    expect(container.querySelector("[data-board-fen]")?.getAttribute("data-orientation")).toBe(
      "white",
    );
    expect(container.querySelector("[data-opening-preview]")).toBeNull();
    await click(row("e4"));
    await black();
  }
});

test("loading, empty, failure and truncated samples retain in-card feedback", async () => {
  let complete!: (value: [PositionStats[], NormalizedGame[]]) => void;
  mocks.searchPosition.mockReturnValueOnce(
    new Promise((resolve) => {
      complete = resolve;
    }),
  );
  await render();
  expect(container.querySelector("[data-progress]")?.getAttribute("data-progress")).toMatch(
    /^local-explorer:/,
  );
  expect(container.querySelector("[data-progress]")?.textContent).toBe(
    "Searching Selected player's games…",
  );
  expect(container.querySelector("[data-opening-skeleton]")?.getAttribute("aria-hidden")).toBe(
    "true",
  );
  expect(container.querySelectorAll("[data-opening-skeleton] .mantine-Skeleton-root")).toHaveLength(
    5,
  );
  expect(container.querySelector("[data-opening-moves]")).toBeNull();
  await act(async () => complete([[], []]));
  expect(container.querySelector("[data-opening-skeleton]")).toBeNull();
  expect(container.textContent).toContain("No games in this position");
  mocks.searchPosition.mockRejectedValueOnce(new Error("unavailable"));
  await black();
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    translate("Databases.LoadError.Title"),
  );
  expect(container.textContent).not.toContain("unavailable");
  mocks.searchPosition.mockResolvedValueOnce([
    [
      {
        move: "e4",
        white: 501,
        draw: 0,
        black: 0,
        unknown: 0,
        last_played: null,
        year_counts: [],
        recent: [],
      },
    ],
    Array.from({ length: 500 }, (_, index) => ({ ...first, id: index })),
  ]);
  await render({ ...player, id: 45 });
  expect(container.textContent).toContain("Showing the most recent 500 of 501");
});

const lichess: OpeningTreeSource = { key: "A:42", label: "Lichess games", file, player: 42 };
const chessCom: OpeningTreeSource = {
  key: "B:7",
  label: "Chess.com games",
  file: reference,
  player: 7,
};
const otherGame: NormalizedGame = {
  ...first,
  black: "Other opponent",
  date: "2026.11.03",
  moves: "1. d4 d5 *",
};
const lichessRows: PositionStats[] = [
  {
    move: "e4",
    white: 2,
    draw: 0,
    black: 1,
    unknown: 0,
    last_played: "2026.11.01",
    year_counts: [],
    recent: [],
  },
];
const chessComRows: PositionStats[] = [
  {
    move: "e4",
    white: 1,
    draw: 1,
    black: 0,
    unknown: 0,
    last_played: "2026.11.03",
    year_counts: [],
    recent: [],
  },
  {
    move: "d4",
    white: 0,
    draw: 0,
    black: 1,
    unknown: 0,
    last_played: "2026.11.03",
    year_counts: [],
    recent: [],
  },
];
function answerPerDatabase() {
  mocks.searchPosition.mockImplementation(async (path: DatabaseHandle) =>
    path.id.id === file.id.id ? [lichessRows, [first]] : [chessComRows, [otherGame]],
  );
}
async function renderAccount(sources: OpeningTreeSource[]) {
  await act(async () =>
    root.render(
      <MantineProvider>
        <Provider store={store}>
          <SWRConfig
            value={{ provider: () => cache, dedupingInterval: 0, shouldRetryOnError: false }}
          >
            <AccountOpeningTree name="GGalileo" sources={sources} />
          </SWRConfig>
        </Provider>
      </MantineProvider>,
    ),
  );
}
function gameRows() {
  return [...container.querySelectorAll<HTMLTableRowElement>("[data-opening-games] tbody tr")];
}

test("an account tree merges its sources, speaks neutrally and opens a game from its own database", async () => {
  answerPerDatabase();
  await renderAccount([lichess, chessCom]);
  expect(container.textContent).toContain("Showing games where GGalileo has White.");
  expect(container.textContent).not.toContain("You prepare");
  expect(button("Prepare on board")).toBeUndefined();
  expect(button("Analyze on board")).toBeTruthy();
  // One native search per source, each for its own database and player id.
  const searched = mocks.searchPosition.mock.calls.map((call) => [call[0], call[1].player1]);
  expect(searched).toHaveLength(2);
  expect(searched).toEqual(
    expect.arrayContaining([
      [file, 42],
      [reference, 7],
    ]),
  );
  expect(container.textContent).toContain("6 games in this position");
  expect(row("e4").cells[1].lastChild?.textContent).toBe("5");
  expect(row("d4").cells[1].lastChild?.textContent).toBe("1");
  expect(container.querySelector("[data-opening-partial]")).toBeNull();

  // Newest first across both databases; both games carry the same database-local id.
  expect(gameRows().map((item) => item.cells[1].firstChild?.textContent)).toEqual([
    "Other opponent",
    "First opponent",
  ]);
  await click(gameRows()[0]);
  expect(container.querySelectorAll('[aria-selected="true"]')).toHaveLength(1);
  expect(gameRows()[0].getAttribute("aria-selected")).toBe("true");
  expect(container.querySelector("[data-game-preview]")?.textContent).toBe(otherGame.moves);
  await click(button("Open on board"));
  expect(mocks.openGame).toHaveBeenLastCalledWith(
    expect.objectContaining({ game: otherGame, database: reference, targetFens: [INITIAL_FEN] }),
  );
  await act(async () => gameRows()[1].dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  expect(mocks.openGame).toHaveBeenLastCalledWith(
    expect.objectContaining({ game: first, database: file }),
  );
});

test("an account tree keeps loading until every source has answered", async () => {
  let complete!: (value: [PositionStats[], NormalizedGame[]]) => void;
  mocks.searchPosition.mockImplementation((path: DatabaseHandle) =>
    path.id.id === file.id.id
      ? Promise.resolve([lichessRows, [first]])
      : new Promise((resolve) => {
          complete = resolve;
        }),
  );
  await renderAccount([lichess, chessCom]);
  expect(container.querySelector("[data-opening-skeleton]")).not.toBeNull();
  expect(container.querySelector("[data-opening-moves]")).toBeNull();
  await act(async () => complete([chessComRows, [otherGame]]));
  expect(container.querySelector("[data-opening-skeleton]")).toBeNull();
  expect(row("e4").cells[1].lastChild?.textContent).toBe("5");
});

test("a source that fails is named once while the others stay usable", async () => {
  mocks.searchPosition.mockImplementation(async (path: DatabaseHandle) => {
    if (path.id.id === file.id.id) return [lichessRows, [first]];
    throw new Error("native detail");
  });
  // Two player ids of the same database fail alike and are named once.
  await renderAccount([lichess, chessCom, { ...chessCom, key: "B:8", player: 8 }]);
  const warning = container.querySelector("[data-opening-partial]")!;
  expect(warning.textContent).toContain("Some games are missing");
  expect(warning.textContent).toContain(
    `Chess.com games: ${translate("Databases.LoadError.Title")}`,
  );
  expect(warning.textContent?.split("Chess.com games").length).toBe(2);
  expect(container.textContent).not.toContain("native detail");
  expect(row("e4").cells[1].lastChild?.textContent).toBe("3");
  expect(gameRows()).toHaveLength(1);
});

test("a source whose search index is unavailable is named while the others stay usable", async () => {
  answerPerDatabase();
  mocks.unavailable.add(file.id.id);
  await renderAccount([lichess, chessCom]);
  expect(mocks.searchPosition).toHaveBeenCalledTimes(1);
  expect(container.querySelector("[data-opening-partial]")?.textContent).toContain(
    "Lichess games: The search index is unavailable.",
  );
  expect(row("d4").cells[1].lastChild?.textContent).toBe("1");
  expect(row("e4").cells[1].lastChild?.textContent).toBe("2");
});

test("when no source can be searched the named errors replace the tree", async () => {
  mocks.searchPosition.mockRejectedValue(new Error("native detail"));
  await renderAccount([lichess, chessCom]);
  expect(container.querySelector("[data-opening-partial]")).toBeNull();
  const alert = container.querySelector('[role="alert"]')!;
  expect(alert.textContent).toContain(`Lichess games: ${translate("Databases.LoadError.Title")}`);
  expect(alert.textContent).toContain(`Chess.com games: ${translate("Databases.LoadError.Title")}`);
  expect(container.querySelector("[data-opening-moves]")).toBeNull();
  expect(container.querySelector("[data-opening-games]")).toBeNull();
  expect(container.textContent).not.toContain("No games in this position");
});

test("an account tree without sources is empty, not failed", async () => {
  await renderAccount([]);
  expect(mocks.searchPosition).not.toHaveBeenCalled();
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.textContent).toContain("No games in this position");
});

test("a time-control filter reaches the search, stays off the board and clears the selection", async () => {
  answerPerDatabase();
  await renderAccount([{ ...lichess, timeControls: ["300+0"] }]);
  expect(mocks.searchPosition.mock.lastCall?.[1]).toMatchObject({ timeControls: ["300+0"] });
  await click(gameRows()[0]);
  expect(container.querySelector("[data-opening-preview]")).not.toBeNull();

  // The same source under another filter: the previewed game may no longer match.
  await renderAccount([{ ...lichess, timeControls: ["600+5"] }]);
  expect(mocks.searchPosition.mock.lastCall?.[1]).toMatchObject({ timeControls: ["600+5"] });
  expect(container.querySelector("[data-opening-preview]")).toBeNull();
  expect(container.querySelector('[aria-selected="true"]')).toBeNull();
  // Returning to the first filter does not bring the old selection back.
  await renderAccount([{ ...lichess, timeControls: ["300+0"] }]);
  expect(container.querySelector("[data-opening-preview]")).toBeNull();
  await renderAccount([{ ...lichess, timeControls: ["600+5"] }]);

  await click(button("Analyze on board"));
  const id = store.get(tabsAtom).at(-1)!.value;
  expect(store.get(pinnedExplorerDatabaseFamily(id))).toEqual(file);
  expect(store.get(pinnedExplorerFurtherColumnsFamily(id))).toEqual([]);
  expect(store.get(localOptionsFamily(id))).toEqual({
    path: file,
    player: 42,
    player_database: databaseHandleKey(file),
    color: "white",
    fen: INITIAL_FEN,
    type: "exact",
    result: "any",
  });
  expect(store.get(tabFamily(id))).toBe("database");
  expect(store.get(tabsAtom).at(-1)!.name).toBe("GGalileo");
});

test("an account tree stays neutral with Black and drops its selection when a source leaves", async () => {
  answerPerDatabase();
  await renderAccount([lichess, chessCom]);
  await click(gameRows()[0]);
  expect(container.querySelector("[data-opening-preview]")).not.toBeNull();
  await renderAccount([lichess]);
  expect(container.querySelector("[data-opening-preview]")).toBeNull();

  await black();
  expect(container.textContent).toContain("Showing games where GGalileo has Black.");
  expect(container.textContent).not.toContain("You prepare");
  expect(mocks.searchPosition.mock.lastCall?.[1]).toMatchObject({ player2: 42 });
});

test("several merged sources open the line on the board without pinning a database", async () => {
  answerPerDatabase();
  await renderAccount([lichess, chessCom]);
  await click(row("e4"));
  await click(button("Analyze on board"));
  expect(mocks.navigate).toHaveBeenCalledWith({ to: "/" });
  const tab = store.get(tabsAtom).at(-1)!;
  expect(store.get(pinnedExplorerDatabaseFamily(tab.value))).toBeNull();
  expect(store.get(tabFamily(tab.value))).not.toBe("database");
  treeStore = createTreeStore(tab.value);
  expect(treeStore.getState().root.children[0].san).toBe("e4");
});

test.each(shippedCatalogues())(
  "$locale includes opening-tree copy without fallback",
  async ({ locale, translation }) => {
    const i18n = await catalogueI18n(locale as SupportedLocale);
    for (const key of Object.keys(translation).filter((key) =>
      key.startsWith("Databases.OpeningTree."),
    )) {
      expect(translation[key].trim()).not.toBe("");
      expect(i18n.t(key)).not.toBe(key);
    }
  },
);

function datedGames(dates: string[], startId = 1) {
  return dates.map((date, index) => ({ date, game_id: startId + index }));
}

test("Recently column shows two-line span header, counts, absent-move 0, hover percentage, empty state, and unique-leader highlight gate", async () => {
  mocks.searchPosition.mockResolvedValueOnce([
    [
      {
        ...startRows[0],
        move: "e4",
        recent: datedGames([
          "2026.11.10",
          "2026.11.09",
          "2026.11.08",
          "2026.11.07",
          "2026.11.06",
          "2026.11.05",
          "2026.11.04",
          "2026.11.03",
          "2026.11.02",
        ]),
      },
      {
        ...startRows[1],
        move: "d4",
        recent: datedGames(["2023.09.15"], 20),
      },
      {
        ...startRows[1],
        move: "c4",
        recent: [],
      },
      {
        ...startRows[2],
        move: "*",
        recent: datedGames(["2026.11.11", "2026.11.12"], 30),
      },
    ],
    [first],
  ]);
  await render();

  const headerCells = [...container.querySelectorAll("[data-opening-moves] thead th")];
  expect(headerCells[2].textContent).toBe("Last 10 games since 2023-09");
  expect(
    [...headerCells[2].querySelectorAll("span > span")].map((span) => span.textContent?.trim()),
  ).toEqual(["Last 10 games", "since 2023-09"]);
  expect(row("e4").cells[2].querySelector("[data-opening-recent-count]")?.textContent).toBe(
    "9 of 10",
  );
  expect(row("d4").cells[2].querySelector("[data-opening-recent-count]")?.textContent).toBe(
    "1 of 10",
  );
  expect(row("c4").cells[2].querySelector("[data-opening-recent-count]")?.textContent).toBe(
    "0 of 10",
  );
  expect(row("Game ended here").cells[2].textContent).toBe("");
  expect(row("e4").cells[2].getAttribute("data-recent-leader")).toBe("true");
  expect(row("d4").cells[2].getAttribute("data-recent-leader")).toBeNull();
  expect(row("c4").cells[2].getAttribute("data-recent-leader")).toBeNull();

  await expectHoverTooltip(
    row("e4").cells[2].querySelector("[data-opening-recent-count]")!,
    "90% of the last 10 games here",
  );
  await expectHoverTooltip(
    row("c4").cells[2].querySelector("[data-opening-recent-count]")!,
    "0% of the last 10 games here",
  );
});

test("Recently column shows 'Recently' header and '–' cells when n = 0", async () => {
  mocks.searchPosition.mockResolvedValueOnce([startRows, [first]]);
  await render();
  expect(container.querySelectorAll("[data-opening-moves] thead th")[2].textContent).toBe(
    "Recently",
  );
  expect(row("e4").cells[2].lastChild?.textContent).toBe("–");
  expect(row("d4").cells[2].lastChild?.textContent).toBe("–");
  expect(row("Game ended here").cells[2].textContent).toBe("");
  expect(container.querySelector("[data-opening-recent-summary]")).toBeNull();
});

test("Recently column gates highlight on ties (2 vs 2)", async () => {
  mocks.searchPosition.mockResolvedValueOnce([
    [
      { ...startRows[0], move: "e4", recent: datedGames(["2026.11.04", "2026.11.02"], 1) },
      { ...startRows[1], move: "d4", recent: datedGames(["2026.11.03", "2026.11.01"], 3) },
    ],
    [first],
  ]);
  await render();
  expect(row("e4").cells[2].querySelector("[data-opening-recent-count]")?.textContent).toBe(
    "2 of 4",
  );
  expect(row("e4").cells[2].getAttribute("data-recent-leader")).toBeNull();
  expect(row("d4").cells[2].getAttribute("data-recent-leader")).toBeNull();
  expect(container.querySelector("[data-opening-recent-summary]")?.textContent).toBe(
    "Recently: e4 / d4 (2 of 4 each)",
  );
});

test("Recently column gates highlight on n >= 3", async () => {
  mocks.searchPosition.mockResolvedValueOnce([
    [{ ...startRows[0], move: "e4", recent: datedGames(["2026.11.02", "2026.11.01"], 1) }],
    [first],
  ]);
  await render();
  expect(row("e4").cells[2].querySelector("[data-opening-recent-count]")?.textContent).toBe(
    "2 of 2",
  );
  expect(row("e4").cells[2].getAttribute("data-recent-leader")).toBeNull();
});

test("MovesPanel shades year strips by share of section games and rolls over across New Year", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 11, 31, 23, 59, 59));
  const sharedYearRows: PositionStats[] = [
    {
      ...startRows[0],
      move: "e4",
      white: 1,
      draw: 0,
      black: 0,
      unknown: 0,
      year_counts: [
        { year: 2018, count: 1 },
        { year: 2026, count: 1 },
        { year: 2027, count: 2 },
      ],
    },
    {
      ...startRows[1],
      move: "d4",
      white: 10,
      year_counts: [{ year: 2026, count: 10 }],
    },
    {
      ...startRows[2],
      move: "*",
      white: 3,
      draw: 0,
      year_counts: [{ year: 2026, count: 3 }],
    },
  ];
  mocks.searchPosition.mockResolvedValue([sharedYearRows, [first]]);
  await render();

  const e4Cells2026 = row("e4").querySelectorAll<HTMLElement>("[data-count]");
  expect(e4Cells2026[8].style.background).toContain(`var(--cf-primary) ${25 + (1 / 14) * 75}%`);
  expect(row("e4").querySelector('[role="img"]')?.getAttribute("aria-label")).toContain(
    "2026: 1 of 14 games (7%)",
  );
  expect(row("e4").querySelector('[role="img"]')?.getAttribute("aria-label")).toContain(
    "Before 2019: 1 of 1 game (100%)",
  );

  // Cross midnight on the same mounted MovesPanel with unchanged row references.
  vi.setSystemTime(new Date(2027, 0, 1, 0, 0, 0));
  await render();
  const e4Label2027 = row("e4").querySelector('[role="img"]')?.getAttribute("aria-label");
  expect(e4Label2027).toContain("Before 2020: 1 of 1 game (100%)");
  expect(e4Label2027).toContain("2026: 1 of 14 games (7%)");
  expect(e4Label2027).toContain("2027: 2 of 2 games (100%)");
});

const otbSummaryRows: PositionStats[] = [
  { ...startRows[0], move: "c5", recent: datedGames(["2026.11.04", "2026.11.03", "2026.11.02"]) },
  { ...startRows[1], move: "e5", recent: datedGames(["2026.11.01"], 10) },
];

test("summary line omits 'Over the board' in single-source cards and styles only moves in monospace", async () => {
  mocks.searchPosition.mockResolvedValueOnce([otbSummaryRows, [first]]);
  await render();
  const summary = container.querySelector<HTMLElement>("[data-opening-recent-summary]")!;
  expect(summary.textContent).toBe("Recently: c5 (3 of 4)");
  expect(classes.summaryMove).toBeTruthy();
  expect(summary.classList.contains(classes.summaryMove)).toBe(false);
  const moveSpans = [...summary.querySelectorAll("span")].filter(
    (span) => span.textContent === "c5",
  );
  expect(moveSpans).toHaveLength(1);
  expect(moveSpans[0].classList.contains(classes.summaryMove)).toBe(true);
});

test("summary line shows separate per-source leaders when both sections have recent games", async () => {
  linkOnlineGames("readable");
  mocks.onlinePlayers.mockResolvedValue([{ id: 5, name: "selected_online" }]);
  const onlineRecentRows: PositionStats[] = [
    {
      ...onlineRows[0],
      move: "c5",
      recent: datedGames(
        [
          "2026.11.10",
          "2026.11.09",
          "2026.11.08",
          "2026.11.07",
          "2026.11.06",
          "2026.11.05",
          "2026.11.04",
          "2026.11.03",
          "2026.11.02",
        ],
        20,
      ),
    },
    { ...onlineRows[1], move: "e5", recent: datedGames(["2026.11.01"], 40) },
  ];
  mocks.searchPosition.mockImplementation(async (path: DatabaseHandle) =>
    path === online ? [onlineRecentRows, [onlineGame]] : [otbSummaryRows, [first]],
  );
  await render();
  await vi.waitFor(() =>
    expect(container.querySelector("[data-opening-recent-summary]")?.textContent).toBe(
      "Recently: Over the board c5 (3 of 4) · Online c5 (9 of 10)",
    ),
  );
});

test("summary line formats ties with 'each'", async () => {
  linkOnlineGames("readable");
  mocks.onlinePlayers.mockResolvedValue([{ id: 5, name: "selected_online" }]);
  const tiedOnlineRows: PositionStats[] = [
    {
      ...onlineRows[0],
      move: "c5",
      recent: datedGames(["2026.11.10", "2026.11.08", "2026.11.06", "2026.11.04"], 20),
    },
    {
      ...onlineRows[1],
      move: "e4",
      recent: datedGames(["2026.11.09", "2026.11.07", "2026.11.05", "2026.11.03"], 30),
    },
    {
      ...onlineRows[1],
      move: "d4",
      recent: datedGames(["2026.11.02", "2026.11.01"], 40),
    },
  ];
  mocks.searchPosition.mockImplementation(async (path: DatabaseHandle) =>
    path === online ? [tiedOnlineRows, [onlineGame]] : [otbSummaryRows, [first]],
  );
  await render();
  await vi.waitFor(() =>
    expect(container.querySelector("[data-opening-recent-summary]")?.textContent).toBe(
      "Recently: Over the board c5 (3 of 4) · Online c5 / e4 (4 of 10 each)",
    ),
  );
});

test("summary line omits loading and empty online section", async () => {
  linkOnlineGames("readable");
  let resolveLookup!: (players: { id: number; name: string }[]) => void;
  mocks.onlinePlayers.mockReturnValue(new Promise((done) => (resolveLookup = done)));
  mocks.searchPosition.mockImplementation(async (path: DatabaseHandle) =>
    path === online ? [onlineRows, [onlineGame]] : [otbSummaryRows, [first]],
  );
  await render();
  await vi.waitFor(() =>
    expect(section("primary").querySelector("[data-opening-moves]")).toBeTruthy(),
  );
  expect(container.querySelector("[data-opening-recent-summary]")?.textContent).toBe(
    "Recently: Over the board c5 (3 of 4)",
  );

  await act(async () => resolveLookup([{ id: 5, name: "selected_online" }]));
  await vi.waitFor(() =>
    expect(section("online").querySelector("[data-opening-moves]")).toBeTruthy(),
  );
  expect(container.querySelector("[data-opening-recent-summary]")?.textContent).toBe(
    "Recently: Over the board c5 (3 of 4)",
  );
});

test("summary line omits failed online section", async () => {
  linkOnlineGames("readable");
  mocks.onlinePlayers.mockRejectedValue(new Error("boom"));
  mocks.searchPosition.mockResolvedValue([otbSummaryRows, [first]]);
  await render();
  await vi.waitFor(() =>
    expect(section("online").textContent).toContain("The online games could not be read."),
  );
  expect(container.querySelector("[data-opening-recent-summary]")?.textContent).toBe(
    "Recently: Over the board c5 (3 of 4)",
  );
});

test("summary line is absent when no section has recent games", async () => {
  linkOnlineGames("readable");
  mocks.onlinePlayers.mockResolvedValue([{ id: 5, name: "selected_online" }]);
  mocks.searchPosition.mockResolvedValue([startRows, [first]]);
  await render();
  await vi.waitFor(() =>
    expect(section("online").textContent).toContain("9 games in this position"),
  );
  expect(container.querySelector("[data-opening-recent-summary]")).toBeNull();
});
