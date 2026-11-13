import { Provider, createStore } from "jotai";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { NormalizedGame } from "@/bindings";
import { tabsAtom, recentFilesAtom } from "@/state/atoms";
import { tabStorage } from "@/state/store/tabStorage";
import { closeTreeStore } from "@/state/store/tree";
import { defaultTree } from "@/utils/treeReducer";
import GamesTable from "./GamesTable";

const mocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  parse: vi.fn(),
  navigate: vi.fn(),
  notify: vi.fn(),
}));
vi.mock("@/platform/tauri", () => ({
  tauri: {
    resolveLinkedGame: mocks.resolve,
    getDbGame: vi.fn(async (_database, gameId: number) =>
      game.id === gameId ? { kind: "found", game } : { kind: "missing" },
    ),
    inferGameOrientation: vi.fn(async () => null),
  },
}));
vi.mock("@/utils/chess", async (original) => ({
  ...(await original<typeof import("@/utils/chess")>()),
  parsePGN: mocks.parse,
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mocks.navigate }));
vi.mock("@/components/files/notifyError", () => ({ notifyUnlessCancelled: mocks.notify }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("mantine-datatable", () => ({
  DataTable: ({
    records,
    onRowClick,
    customRowAttributes,
  }: {
    records: NormalizedGame[];
    onRowClick: (event: { record: NormalizedGame }) => void;
    customRowAttributes?: (record: NormalizedGame) => Record<string, unknown>;
  }) => (
    <>
      {records.map((record) => (
        <div
          key={record.id}
          role="row"
          {...customRowAttributes?.(record)}
          onClick={() => onRowClick({ record })}
        >
          {record.white}
        </div>
      ))}
    </>
  ),
}));

const database = { id: { id: "linked-cache" }, kind: "database" as const };
const file = { id: { id: "source-pgn" }, kind: "fileWorkspace" as const };
const locator = {
  collection: "22222222-2222-4222-8222-222222222222",
  generation: "source-generation",
  ordinal: 4,
  stamp: "a".repeat(64),
};
const game: NormalizedGame = {
  stamp: "b".repeat(64),
  id: 7,
  white: "White",
  black: "Black",
  white_id: 1,
  black_id: 2,
  event: "Event",
  event_id: 1,
  site: "Site",
  site_id: 1,
  result: "*",
  moves: "1. e4 *",
  fen: defaultTree().root.fen,
  linked: locator,
};
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
let workspace: ReturnType<typeof createStore>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  workspace = createStore();
  workspace.set(tabsAtom, []);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  for (const tab of workspace.get(tabsAtom)) closeTreeStore(tab.value);
  host.remove();
  vi.unstubAllGlobals();
});
async function renderTable() {
  await act(async () =>
    root.render(
      <Provider store={workspace}>
        <GamesTable games={[game]} loading={false} databasePath={database} />
      </Provider>,
    ),
  );
}
function row() {
  return host.querySelector<HTMLElement>('[role="row"]')!;
}
async function open() {
  await renderTable();
  await act(async () => row().click());
}

function linkedSource() {
  return {
    locator,
    file,
    name: "Source",
    ordinal: 4,
    numGames: 5,
    purpose: "game",
    game: {
      pgn: '[Event "Original"]\n[Custom "preserved"]\n\n1. e4 $1 (1. d4 d5) e5 *',
      stamp: locator.stamp,
      revision: locator.generation,
      present: true,
    },
  };
}

test("board-panel linked results open original PGN bytes and persist the qualified source occurrence", async () => {
  const pgn = '[Event "Original"]\n[Custom "preserved"]\n\n1. e4 $1 (1. d4 d5) e5 *';
  mocks.resolve.mockResolvedValueOnce({
    locator,
    file,
    name: "Source",
    ordinal: 4,
    numGames: 5,
    purpose: "game",
    game: { pgn, stamp: locator.stamp, revision: locator.generation, present: true },
  });
  const tree = defaultTree();
  tree.headers.other = { Custom: "preserved" };
  mocks.parse.mockResolvedValueOnce(tree);
  await open();
  expect(workspace.get(recentFilesAtom)).toEqual([
    expect.objectContaining({
      kind: "database",
      database,
      gameId: 7,
      linked: expect.objectContaining({ locator }),
    }),
  ]);
  expect(mocks.resolve).toHaveBeenCalledExactlyOnceWith(database, 7, locator);
  expect(mocks.parse).toHaveBeenCalledExactlyOnceWith(pgn);
  const tab = workspace.get(tabsAtom)[0];
  expect(tab.gameOrigin).toMatchObject({
    kind: "file",
    gameNumber: 4,
    file: { handle: file, numGames: 5 },
  });
  expect(tabStorage.read(tab.treeKey ?? tab.value)?.state).toMatchObject({
    linkedSource: locator,
    sourceStamp: locator.stamp,
    headers: { other: { Custom: "preserved" } },
  });
  expect(mocks.navigate).toHaveBeenCalledWith({ to: "/" });
});

test("an obsolete board-panel result is refused before tab admission", async () => {
  mocks.resolve.mockRejectedValueOnce({
    tag: "backend-error",
    category: "stale-game",
    message: "The game changed on disk",
  });
  await open();
  expect(workspace.get(tabsAtom)).toEqual([]);
  expect(mocks.parse).not.toHaveBeenCalled();
  expect(mocks.notify).toHaveBeenCalledOnce();
});

test("rows are focusable and Enter opens the linked game", async () => {
  mocks.resolve.mockResolvedValueOnce(linkedSource());
  mocks.parse.mockResolvedValueOnce(defaultTree());
  await renderTable();
  expect(row().tabIndex).toBe(0);
  await act(async () =>
    row().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
  );
  expect(mocks.resolve).toHaveBeenCalledExactlyOnceWith(database, 7, locator);
  expect(workspace.get(tabsAtom)).toHaveLength(1);
});

test("a pending open ignores a second click", async () => {
  mocks.resolve.mockReturnValueOnce(new Promise(() => {}));
  await renderTable();
  await act(async () => {
    row().click();
    row().click();
  });
  expect(mocks.resolve).toHaveBeenCalledTimes(1);
});
