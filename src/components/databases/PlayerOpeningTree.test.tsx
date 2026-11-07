import { MantineProvider } from "@mantine/core";
import { INITIAL_FEN } from "chessops/fen";
import { createStore, Provider } from "jotai";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { DatabaseHandle, GameQuery, NormalizedGame, Player, PositionStats } from "@/bindings";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import DatabasePanel from "@/components/panels/database/DatabasePanel";
import {
  dbTabFamily,
  dbTypeFamily,
  localOptionsFamily,
  pinnedExplorerDatabaseFamily,
  referenceDbAtom,
  tabFamily,
  tabsAtom,
} from "@/state/atoms";
import { createTreeStore, type TreeStore } from "@/state/store/tree";
import { WorkspaceTabScope } from "@/state/tabScope";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { catalogueI18n, shippedCatalogues } from "@/tests/catalogues";
import type { SupportedLocale } from "@/i18n";
import { getNodeAtPath } from "@/utils/treeReducer";
import PlayerOpeningTree from "./PlayerOpeningTree";

const mocks = vi.hoisted(() => ({
  searchPosition: vi.fn(),
  navigate: vi.fn(),
  notify: vi.fn(),
  createTab: vi.fn(),
  openGame: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mocks.navigate, Link: () => null }));
vi.mock("@/components/files/notifyError", () => ({ notifyUnlessCancelled: mocks.notify }));
vi.mock("@/utils/tabs", async (original) => {
  const actual = await original<typeof import("@/utils/tabs")>();
  mocks.createTab.mockImplementation(actual.createTab);
  return { ...actual, createTab: mocks.createTab };
});
vi.mock("@/utils/databaseGame", () => ({ openDatabaseGame: mocks.openGame }));
vi.mock("@/platform/tauri", async (original) => {
  const actual = await original<typeof import("@/platform/tauri")>();
  return { ...actual, tauri: { ...actual.tauri, searchPosition: mocks.searchPosition } };
});
vi.mock("@/state/linkedCollections", () => ({
  useCollectionCurrency: () => ({ collection: null }),
}));
vi.mock("@/hooks/useDatabaseList", () => ({
  useDatabaseList: () => ({
    data: {
      databases: [file, reference].map((handle) => ({
        type: "success",
        file: handle,
        title: handle.id.id,
        filename: "test.db3",
      })),
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
  default: ({ tab }: { tab: string }) => <div data-progress={tab} />,
}));

// Use real catalogue interpolation for totals, scores and accessible controls.
let translate: (key: string, options?: Record<string, unknown>) => string;
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => translate(key, options),
  }),
}));

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
  { move: "e4", white: 3, draw: 1, black: 1, unknown: 1 },
  { move: "d4", white: 0, draw: 0, black: 0, unknown: 2 },
  { move: "*", white: 0, draw: 1, black: 0, unknown: 0 },
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
  const i18n = await catalogueI18n("en-US");
  translate = (key, options) => i18n.t(key, options);
  localStorage.clear();
  sessionStorage.clear();
  // Hydrate the existing preference without writing it through the application atom.
  localStorage.setItem("reference-database", JSON.stringify(reference));
  store = createStore();
  cache = new Map();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  mocks.searchPosition.mockImplementation(async (_path: DatabaseHandle, query: GameQuery) =>
    query.position?.fen === INITIAL_FEN
      ? [startRows, [first]]
      : [[{ move: "e5", white: 3, draw: 1, black: 1, unknown: 1 }], [next]],
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  treeStore?.dispose();
  treeStore = undefined;
  container.remove();
});

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
    (item) => item.cells[0].textContent === move,
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

test("native query, scores, terminal row and navigation follow the player's exact position", async () => {
  await render();
  expect(mocks.searchPosition).toHaveBeenCalledWith(
    file,
    expect.objectContaining({
      player1: 42,
      player2: undefined,
      position: { fen: INITIAL_FEN, type_: "exact" },
      include_unknown_results: true,
      sample_order: "date",
    }),
    expect.any(String),
    { signal: expect.any(AbortSignal) },
  );
  expect(container.textContent).toContain("9 games in this position");
  expect(row("e4").cells[1].textContent).toBe("6");
  expect(row("e4").cells[2].textContent).toBe("70.0%");
  expect(row("e4").querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("60");
  expect(row("d4").cells[1].textContent).toBe("2");
  expect(row("d4").cells[2].textContent).toBe("–");
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
  expect(row("e4").cells[2].textContent).toBe("30.0%");
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
  expect(row("e4").cells[1].textContent).toBe("6");
});

test("game selection previews within the card, Open and double-click use the established opening flow", async () => {
  await render();
  expect(container.querySelector("[data-opening-preview]")).toBeNull();
  await click(container.querySelector("[data-opening-games] tbody tr")!);
  expect(container.querySelector('[aria-selected="true"]')).not.toBeNull();
  expect(container.querySelector("[data-game-preview]")?.textContent).toBe(first.moves);
  await click(button("Open on board"));
  expect(mocks.openGame).toHaveBeenCalledWith(
    expect.objectContaining({ game: first, database: file }),
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
  await click(button("Previous move"));
  expect(container.querySelector("[data-opening-games]")?.textContent).toContain("First opponent");
});

test("Prepare admits the mainline and orientation, presets before navigation, then the real Database panel searches A while reference B stays unchanged", async () => {
  await render();
  await click(row("e4"));
  await click(row("e5"));
  await black();
  mocks.navigate.mockImplementation(() => {
    const id = store.get(tabsAtom).at(-1)!.value;
    expect(store.get(pinnedExplorerDatabaseFamily(id))).toEqual(file);
    expect(store.get(localOptionsFamily(id))).toMatchObject({
      path: file,
      player: 42,
      color: "black",
      fen: endFen,
    });
    expect(store.get(tabFamily(id))).toBe("database");
    expect(store.get(dbTypeFamily(id))).toBe("local");
    expect(store.get(dbTabFamily(id))).toBe("stats");
  });
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
        include_unknown_results: true,
        sample_order: "date",
      }),
      tab.value,
      { signal: expect.any(AbortSignal) },
    ),
  );
  expect(store.get(referenceDbAtom)).toEqual(reference);
  expect(JSON.parse(localStorage.getItem("reference-database")!)).toEqual(reference);
});

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
  await act(async () => complete([[], []]));
  expect(container.textContent).toContain("No games in this position");
  mocks.searchPosition.mockRejectedValueOnce(new Error("unavailable"));
  await black();
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
  mocks.searchPosition.mockResolvedValueOnce([
    [{ move: "e4", white: 501, draw: 0, black: 0, unknown: 0 }],
    Array.from({ length: 500 }, (_, index) => ({ ...first, id: index })),
  ]);
  await render({ ...player, id: 45 });
  expect(container.textContent).toContain("Showing the most recent 500 of 501");
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
