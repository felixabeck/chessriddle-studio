import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SWRConfig, useSWRConfig } from "swr";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { DatabaseHandle, NormalizedGame, Event as Tournament } from "@/bindings";
import { DatabaseViewStateContext } from "./DatabaseViewStateContext";

const mocks = vi.hoisted(() => ({
  getTournamentGames: vi.fn(),
  notify: vi.fn(),
  createTab: vi.fn(async (_args: { gameOrigin?: { linked?: unknown } }) => "opened"),
  addRecentFile: vi.fn(),
  navigate: vi.fn(),
}));
vi.mock("@/utils/db", () => ({ getTournamentGames: mocks.getTournamentGames }));
vi.mock("@/components/files/notifyError", () => ({ notifyUnlessCancelled: mocks.notify }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("zustand", () => ({
  useStore: (_store: unknown, selector: (state: unknown) => unknown) =>
    selector({
      database: { title: "Candidates database" },
      tournaments: { activeTab: "games" },
      setTournamentsActiveTab: vi.fn(),
    }),
}));
vi.mock("jotai", () => ({
  useAtom: () => [[], vi.fn()],
  useSetAtom: () => mocks.addRecentFile,
  useStore: () => ({ get: vi.fn() }),
}));
vi.mock("@/state/atoms", () => ({
  activeTabAtom: {},
  tabsAtom: {},
  addRecentFileAtom: {},
  closingTabsAtom: {},
  initializeWorkspace: vi.fn(),
  reclaimTabLocalState: vi.fn(),
  updateTabById: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mocks.navigate }));
vi.mock("lucide-react", () => ({ Eye: () => null }));
// Keep the table boundary interactive and render the records supplied by TournamentCard.
vi.mock("mantine-datatable", () => ({
  DataTable: ({
    records,
    columns,
    page,
    totalRecords,
    recordsPerPage,
    recordsPerPageOptions,
    onRecordsPerPageChange,
    onPageChange,
    onSortStatusChange,
  }: {
    records: NormalizedGame[];
    columns?: { accessor: string; render?: (game: NormalizedGame) => ReactNode }[];
    page?: number;
    totalRecords: number;
    recordsPerPage: number;
    recordsPerPageOptions: number[];
    onRecordsPerPageChange: (size: number) => void;
    onPageChange: (page: number) => void;
    onSortStatusChange: (sort: { columnAccessor: string; direction: "desc" }) => void;
  }) =>
    page === undefined ? null : (
      <div>
        <table>
          <tbody>
            {records.map((game) => (
              <tr key={game.id}>
                <td>{columns?.find((column) => column.accessor === "actions")?.render?.(game)}</td>
                <td>{game.white}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <output>{`Page ${page} of ${Math.max(1, Math.ceil(totalRecords / recordsPerPage))}, size ${recordsPerPage}, total ${totalRecords}`}</output>
        {recordsPerPageOptions.map((size) => (
          <button key={size} type="button" onClick={() => onRecordsPerPageChange(size)}>
            {`Size ${size}`}
          </button>
        ))}
        <button
          type="button"
          disabled={page >= Math.ceil(totalRecords / recordsPerPage)}
          onClick={() => onPageChange(page + 1)}
        >
          Next page
        </button>
        <button
          type="button"
          onClick={() => onSortStatusChange({ columnAccessor: "ply_count", direction: "desc" })}
        >
          Sort plies descending
        </button>
      </div>
    ),
}));
vi.mock("@/components/common/IconAction", () => ({
  IconAction: ({ label, onClick }: { label: string; onClick?: () => void }) => (
    <button type="button" aria-label={label} onClick={onClick} />
  ),
}));
vi.mock("@/utils/tabs", async (original) => ({
  ...(await original<typeof import("@/utils/tabs")>()),
  createTab: mocks.createTab,
}));
vi.mock("@mantine/core", () => ({
  Paper: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Stack: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  useMantineTheme: () => ({ primaryColor: "blue" }),
  Tabs: Object.assign(({ children }: { children: ReactNode }) => <div>{children}</div>, {
    List: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    Tab: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    Panel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  }),
}));

import TournamentCard from "./TournamentCard";

const tournament = { id: 7, name: "Candidates" } as Tournament;
const file = (id: string): DatabaseHandle => ({ id: { id }, kind: "database" });
let root: Root;
let container: HTMLDivElement;
const cache = new Map();
let refreshGames: () => Promise<unknown>;

function TestCard({ database }: { database: DatabaseHandle }) {
  const { mutate } = useSWRConfig();
  refreshGames = () => mutate((key) => Array.isArray(key) && key[0] === "tournament-games");
  return <TournamentCard tournament={tournament} file={database} />;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  cache.clear();
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render(database: DatabaseHandle) {
  await act(async () =>
    root.render(
      <SWRConfig value={{ provider: () => cache }}>
        <DatabaseViewStateContext.Provider value={{} as never}>
          <TestCard database={database} />
        </DatabaseViewStateContext.Provider>
      </SWRConfig>,
    ),
  );
}

test("file replacement and unmount cancel the exact TournamentCard native request", async () => {
  const signals: AbortSignal[] = [];
  mocks.getTournamentGames.mockImplementation(
    (_file: unknown, _id: unknown, signal: AbortSignal) =>
      new Promise((_resolve, reject) => {
        signals.push(signal);
        signal.addEventListener(
          "abort",
          () => reject(new DOMException("Cancellation", "AbortError")),
          { once: true },
        );
      }),
  );
  await render(file("first"));
  await vi.waitFor(() => expect(signals).toHaveLength(1));
  await render(file("second"));
  await vi.waitFor(() => expect(signals).toHaveLength(2));
  expect(signals[0].aborted).toBe(true);
  expect(signals[1].aborted).toBe(false);
  await act(async () => root.render(null));
  await vi.waitFor(() => expect(signals[1].aborted).toBe(true));
  expect(mocks.notify).not.toHaveBeenCalled();
});

test("TournamentCard surfaces a genuine lookup failure", async () => {
  const failure = new Error("tournament lookup failed");
  mocks.getTournamentGames.mockRejectedValue(failure);
  await render(file("failed"));
  await vi.waitFor(() => expect(mocks.notify).toHaveBeenCalledWith("Common.Error", failure));
});

function games(count = 60): NormalizedGame[] {
  return Array.from({ length: count }, (_, index): NormalizedGame => {
    const id = index + 1;
    return {
      id,
      white: `White ${id}`,
      white_id: id,
      black: `Black ${id}`,
      black_id: id + 100,
      date: new Date(Date.UTC(2026, 0, id)).toISOString().slice(0, 10),
      ply_count: id,
      result: "1-0",
      event: "Candidates",
      event_id: tournament.id,
      site: "Test",
      site_id: 1,
      fen: "",
      moves: "",
    };
  }).reverse();
}

async function click(label: string) {
  const button = Array.from(container.querySelectorAll("button")).find(
    (element) => element.textContent === label,
  );
  expect(button).toBeDefined();
  await act(async () => button!.click());
}

function expectPage(page: number, size: number, ids: number[], total = 60) {
  expect(Array.from(container.querySelectorAll("tbody tr"), (row) => row.textContent)).toEqual(
    ids.map((id) => `White ${id}`),
  );
  expect(container.querySelector("output")?.textContent).toBe(
    `Page ${page} of ${Math.max(1, Math.ceil(total / size))}, size ${size}, total ${total}`,
  );
}

const ids = (start: number, end: number) =>
  Array.from({ length: end - start + 1 }, (_, index) => start + index);

async function renderGames() {
  mocks.getTournamentGames.mockResolvedValue({ data: games() });
  await render(file("pagination"));
  await vi.waitFor(() => expectPage(1, 25, ids(1, 25)));
}

test("page size 10 displays games 11–20 on the second page", async () => {
  await renderGames();
  await click("Size 10");
  await click("Next page");
  expectPage(2, 10, ids(11, 20));
});

test("page size 50 displays 50 games and the remaining games on page two", async () => {
  await renderGames();
  await click("Size 50");
  expectPage(1, 50, ids(1, 50));
  await click("Next page");
  expectPage(2, 50, ids(51, 60));
});

test("changing page size on a later page resets the paginator and displayed records", async () => {
  await renderGames();
  await click("Next page");
  await click("Next page");
  expectPage(3, 25, ids(51, 60));
  await click("Size 50");
  expectPage(1, 50, ids(1, 50));
  await click("Next page");
  await click("Size 10");
  expectPage(1, 10, ids(1, 10));
});

test("sorting orders the games before selecting the displayed page", async () => {
  await renderGames();
  await click("Size 10");
  await click("Next page");
  await click("Sort plies descending");
  expectPage(2, 10, ids(41, 50).reverse());
});

test.each([
  { count: 40, page: 2, displayed: ids(26, 40) },
  { count: 0, page: 1, displayed: [] },
])(
  "a result count of $count clamps the page and displayed records",
  async ({ count, page, displayed }) => {
    await renderGames();
    await click("Next page");
    await click("Next page");
    expectPage(3, 25, ids(51, 60));
    mocks.getTournamentGames.mockResolvedValue({ data: games(count) });
    await act(async () => {
      await refreshGames();
    });
    await vi.waitFor(() => expectPage(page, 25, displayed, count));
  },
);

const locator = {
  collection: "22222222-2222-4222-8222-222222222222",
  generation: "source-generation",
  ordinal: 4,
  stamp: "a".repeat(64),
};

function tournamentGame(linked?: NormalizedGame["linked"]): NormalizedGame {
  return {
    stamp: "b".repeat(64),
    id: 11,
    white: "White 11",
    white_id: 11,
    black: "Black 111",
    black_id: 111,
    date: "2026-01-11",
    ply_count: 11,
    result: "1-0",
    event: "Candidates",
    event_id: tournament.id,
    site: "Test",
    site_id: 1,
    fen: "",
    moves: "1. e4 e5 1-0",
    ...(linked ? { linked } : {}),
  };
}

async function openTournamentGame(game: NormalizedGame) {
  const database = file("tournament-open");
  mocks.getTournamentGames.mockResolvedValue({ data: [game] });
  await render(database);
  await vi.waitFor(() =>
    expect(container.querySelector('[aria-label="Common.Open"]')).not.toBeNull(),
  );
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Common.Open"]')!.click(),
  );
  await vi.waitFor(() => expect(mocks.createTab).toHaveBeenCalled());
  return database;
}

test("opening a linked tournament game carries the qualified locator through the shared seed", async () => {
  const game = tournamentGame(locator);
  const database = await openTournamentGame(game);
  expect(mocks.addRecentFile).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      kind: "database",
      database,
      gameId: game.id,
      databaseTitle: "Candidates database",
      linked: expect.objectContaining({ locator }),
    }),
  );
  expect(mocks.createTab).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      tab: { name: "White 11 - Black 111", type: "analysis" },
      pgn: game.moves,
      headers: game,
      gameOrigin: {
        kind: "database",
        database,
        gameId: game.id,
        linked: locator,
      },
    }),
  );
  expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith({ to: "/" });
});

test("opening a standalone tournament game keeps an ordinary database origin", async () => {
  const game = tournamentGame();
  const database = await openTournamentGame(game);
  expect(mocks.createTab).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      tab: { name: "White 11 - Black 111", type: "analysis" },
      pgn: game.moves,
      headers: game,
      gameOrigin: expect.objectContaining({
        kind: "database",
        database,
        gameId: game.id,
      }),
    }),
  );
  expect(mocks.createTab.mock.calls[0]?.[0].gameOrigin?.linked ?? null).toBeNull();
  expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith({ to: "/" });
});
