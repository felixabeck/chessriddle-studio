import { MantineProvider } from "@mantine/core";
import { INITIAL_FEN } from "chessops/fen";
import { Provider, createStore } from "jotai";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { NormalizedGame } from "@/bindings";
import { tabsAtom } from "@/state/atoms";
import { activeDatabaseViewStore } from "@/state/store/database";
import { tabStorage } from "@/state/store/tabStorage";
import { defaultTree } from "@/utils/treeReducer";
import type { SuccessDatabaseInfo } from "@/utils/db";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { DatabaseViewStateContext } from "./DatabaseViewStateContext";
import GameTable from "./GameTable";
import { resolveDatabaseRoute } from "./databaseRoute";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  parsePGN: vi.fn(),
  notify: vi.fn(),
  queryError: undefined as Error | undefined,
}));
vi.mock("@/platform/tauri", async (original) => {
  const actual = await original<typeof import("@/platform/tauri")>();
  return { ...actual, tauri: { ...actual.tauri, resolveLinkedGame: vi.fn(async () => null) } };
});
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mocks.navigate }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string, options?: any) => options?.defaultValue ?? key }),
}));
vi.mock("@mantine/notifications", () => ({ notifications: { show: mocks.notify } }));
vi.mock("@/utils/chess", async (original) => ({
  ...(await original<typeof import("@/utils/chess")>()),
  parsePGN: mocks.parsePGN,
}));
vi.mock("swr", async (original) => ({
  ...(await original<typeof import("swr")>()),
  default: () => ({
    data: { data: games, count: games.length },
    error: mocks.queryError,
    mutate: vi.fn(),
  }),
}));
vi.mock("./PlayerSearchInput", () => ({
  PlayerSearchInput: ({ label }: { label: string }) => <input placeholder={label} />,
}));
vi.mock("./SideInput", () => ({ SideInput: () => null }));
vi.mock("./GamePreview", () => ({ default: ({ pgn }: { pgn: string }) => <div>{pgn}</div> }));
vi.mock("../common/GameInfo", () => ({ default: () => null }));
vi.mock("mantine-datatable", () => ({
  DataTable: ({ records, customRowAttributes, onRowClick, onRowDoubleClick }: any) => (
    <table>
      <tbody>
        {records.map((record: NormalizedGame, index: number) => (
          <tr
            key={record.id}
            onClick={() => onRowClick({ record, index })}
            onDoubleClick={() => onRowDoubleClick?.({ record, index })}
            {...customRowAttributes?.(record, index)}
          >
            <td>
              {record.white}
              <input aria-label="nested filter" />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  ),
}));

const file = { id: { id: "captured-database" }, kind: "database" } as const;
const games: NormalizedGame[] = [
  {
    id: 11,
    white: "First",
    white_id: 1,
    black: "A",
    black_id: 2,
    event: "First event",
    event_id: 1,
    site: "?",
    site_id: 1,
    result: "*",
    moves: "1. e4 *",
    fen: INITIAL_FEN,
  },
  {
    id: 22,
    white: "Second",
    white_id: 3,
    black: "B",
    black_id: 4,
    event: "Second event",
    event_id: 2,
    site: "?",
    site_id: 1,
    result: "*",
    moves: "7... d5 *",
    fen: "rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq d3 0 7",
  },
];
installMatchMediaStub();
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let host: HTMLDivElement;
let root: Root;
let jotai: ReturnType<typeof createStore>;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.queryError = undefined;
  sessionStorage.clear();
  localStorage.clear();
  mocks.parsePGN
    .mockReset()
    .mockImplementation(async (_pgn: string, fen?: string) => defaultTree(fen));
  activeDatabaseViewStore.getState().setDatabase({ file, title: "Fixture" } as SuccessDatabaseInfo);
  jotai = createStore();
  jotai.set(tabsAtom, []);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  activeDatabaseViewStore.getState().clearDatabase();
});
async function render() {
  await act(async () =>
    root.render(
      <MantineProvider>
        <Provider store={jotai}>
          <DatabaseViewStateContext.Provider value={activeDatabaseViewStore}>
            <GameTable />
          </DatabaseViewStateContext.Provider>
        </Provider>
      </MantineProvider>,
    ),
  );
}
function openButton() {
  return [...host.querySelectorAll("button")].find((button) => button.textContent === "Open game")!;
}
function row(index: number) {
  return host.querySelectorAll("tr")[index];
}

test("the Games searches distinguish the player and opponent", async () => {
  await render();
  expect(host.querySelector('input[placeholder="Board.Database.Local.Player"]')).not.toBeNull();
  expect(host.querySelector('input[placeholder="Board.Database.Local.Opponent"]')).not.toBeNull();
});
async function doubleClick(index: number) {
  await act(async () => {
    row(index).dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  });
}

test.each([
  {},
  { isFilterExpanded: false },
  { isFilterExpanded: false, query: null },
  { isFilterExpanded: false, query: "query" },
  { isFilterExpanded: false, query: { sides: "Any", options: null } },
])("renders a ready hydrated database with malformed games %j", async (storedGames) => {
  const freshDatabase: SuccessDatabaseInfo = {
    type: "success",
    file,
    title: "Fresh listing metadata",
    description: "",
    filename: "fixture.db3",
    player_count: 4,
    event_count: 2,
    game_count: 2,
    storage_size: "0",
    indexed: true,
  };
  // Exercise the actual store's sessionStorage boundary. A matching active identity
  // makes the route ready, so route synchronization cannot hide unsafe panel hydration.
  sessionStorage.setItem(
    "database-view",
    JSON.stringify({
      version: 0,
      state: {
        database: { ...freshDatabase, title: "Stored metadata", storage_size: 0 },
        games: storedGames,
      },
    }),
  );
  await activeDatabaseViewStore.persist.rehydrate();
  expect(
    resolveDatabaseRoute(
      [freshDatabase],
      "captured-database",
      activeDatabaseViewStore.getState().database,
    ),
  ).toEqual({
    status: "ready",
    database: freshDatabase,
  });
  await render();
  expect(host.querySelectorAll("tr")).toHaveLength(games.length);
  expect(activeDatabaseViewStore.getState().games).toEqual(
    activeDatabaseViewStore.getInitialState().games,
  );
  expect(openButton().disabled).toBe(true);
});

test("single click previews, labelled button admits the selected content and database identity", async () => {
  const seed = vi.spyOn(tabStorage, "seed");
  await render();
  expect(openButton().disabled).toBe(true);
  await act(async () => row(1).click());
  expect(jotai.get(tabsAtom)).toHaveLength(0);
  expect(row(1).getAttribute("aria-selected")).toBe("true");
  expect(host.textContent).toContain(games[1].moves);
  await act(async () => openButton().click());
  expect(mocks.parsePGN).toHaveBeenCalledWith(games[1].moves, games[1].fen);
  expect(seed).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({ headers: games[1] }),
  );
  expect(jotai.get(tabsAtom)).toEqual([
    expect.objectContaining({
      name: "Second - B",
      gameOrigin: { kind: "database", database: file, gameId: 22 },
    }),
  ]);
  const stored = tabStorage.read<ReturnType<typeof defaultTree>>(jotai.get(tabsAtom)[0].value);
  expect(stored?.state.headers).toMatchObject({
    id: games[1].id,
    fen: games[1].fen,
    event: games[1].event,
    site: games[1].site,
    white: games[1].white,
    black: games[1].black,
    result: games[1].result,
  });
  expect(stored?.state.root.fen).toBe(games[1].fen);
  expect(stored?.state.root.halfMoves).toBe(13);
  expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith({ to: "/" });
});

test("linked explorer opening admits the original file tree and persists its native locator", async () => {
  const { tauri } = await import("@/platform/tauri");
  const locator = {
    collection: "22222222-2222-4222-8222-222222222222",
    generation: "live-source",
    ordinal: 3,
    stamp: "a".repeat(64),
  };
  const original = '[Event "Original PGN"]\n[Custom "preserved"]\n\n1. e4 $1 (1. d4 d5) e5 *';
  games[0].linked = locator;
  const source = { id: { id: "source-pgn" }, kind: "fileWorkspace" as const };
  vi.mocked(tauri.resolveLinkedGame).mockResolvedValueOnce({
    locator,
    file: source,
    name: "Source PGN",
    ordinal: 3,
    numGames: 8,
    purpose: "game",
    game: { pgn: original, stamp: locator.stamp, revision: locator.generation, present: true },
  });
  const parsed = defaultTree();
  parsed.headers.event = "Original PGN";
  parsed.headers.other = { Custom: "preserved" };
  mocks.parsePGN.mockResolvedValueOnce(parsed);
  await render();
  await doubleClick(0);
  expect(mocks.parsePGN).toHaveBeenCalledExactlyOnceWith(original);
  expect(tauri.resolveLinkedGame).toHaveBeenCalledExactlyOnceWith(file, games[0].id, locator);
  const admitted = jotai.get(tabsAtom)[0];
  expect(admitted.gameOrigin).toMatchObject({
    kind: "file",
    gameNumber: 3,
    file: { handle: source, numGames: 8 },
  });
  expect(tabStorage.read(admitted.treeKey ?? admitted.value)?.state).toMatchObject({
    sourceStamp: locator.stamp,
    linkedSource: locator,
    headers: { event: "Original PGN", other: { Custom: "preserved" } },
  });
  delete games[0].linked;
});

test("a failed generation admission withholds previously cached explorer rows", async () => {
  mocks.queryError = new Error("The collection changed on disk");
  await render();
  expect(host.querySelectorAll("tbody tr")).toHaveLength(0);
  expect(mocks.parsePGN).not.toHaveBeenCalled();
});

test("direct non-first double-click captures its target and all gestures share admission", async () => {
  let settle!: (tree: ReturnType<typeof defaultTree>) => void;
  mocks.parsePGN.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        settle = resolve;
      }),
  );
  await render();
  await doubleClick(1);
  await act(async () => {
    row(0).click();
    row(0).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    openButton().click();
    row(1).dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  });
  expect(mocks.parsePGN).toHaveBeenCalledTimes(1);
  expect(jotai.get(tabsAtom)).toHaveLength(0);
  await act(async () => settle(defaultTree(games[1].fen)));
  expect(jotai.get(tabsAtom)).toHaveLength(1);
  expect(jotai.get(tabsAtom)[0].gameOrigin).toEqual({
    kind: "database",
    database: file,
    gameId: 22,
  });
});

test("row Enter opens its own game and ignores repeated keys and nested inputs", async () => {
  await render();
  expect(row(1).tabIndex).toBe(0);
  await act(async () => {
    row(1).dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", repeat: true, bubbles: true }),
    );
    row(1)
      .querySelector("input")!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  expect(mocks.parsePGN).not.toHaveBeenCalled();
  await act(async () => {
    row(1).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  expect(jotai.get(tabsAtom)[0].gameOrigin).toEqual({
    kind: "database",
    database: file,
    gameId: 22,
  });
});

test("refused storage admission and rejected parsing stay on the source and allow retry", async () => {
  await render();
  const seed = vi.spyOn(tabStorage, "seed").mockImplementationOnce(() => {
    throw new DOMException("quota", "QuotaExceededError");
  });
  await doubleClick(1);
  expect(jotai.get(tabsAtom)).toHaveLength(0);
  expect(mocks.navigate).not.toHaveBeenCalled();
  seed.mockRestore();
  mocks.parsePGN.mockRejectedValueOnce(new Error("parse refused"));
  await doubleClick(1);
  expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({ message: "parse refused" }));
  expect(mocks.navigate).not.toHaveBeenCalled();
  await doubleClick(1);
  expect(jotai.get(tabsAtom)).toHaveLength(1);
  expect(mocks.navigate).toHaveBeenCalledOnce();
});
