import { MantineProvider } from "@mantine/core";
import { Provider, createStore } from "jotai";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Event, NormalizedGame, Player } from "@/bindings";
import { activeDatabaseViewStore } from "@/state/store/database";
import { installMatchMediaStub } from "@/tests/matchMedia";
import type { SuccessDatabaseInfo } from "@/utils/db";
import { DatabaseViewStateContext } from "./DatabaseViewStateContext";
import GameTable from "./GameTable";
import PlayerTable from "./PlayerTable";
import TournamentCard from "./TournamentCard";
import TournamentTable from "./TournamentTable";
import { INITIAL_WINDOW_ROWS } from "./useWindowedTableRows";

const mocks = vi.hoisted(() => ({
  getGames: vi.fn(),
  getPlayers: vi.fn(),
  getTournaments: vi.fn(),
  getTournamentGames: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock("@/platform/tauri", async (original) => {
  const actual = await original<typeof import("@/platform/tauri")>();
  return {
    ...actual,
    tauri: {
      ...actual.tauri,
      getGames: mocks.getGames,
      getPlayers: mocks.getPlayers,
      getTournaments: mocks.getTournaments,
      getTournamentGames: mocks.getTournamentGames,
    },
  };
});
vi.mock("@/utils/db", async (original) => {
  const actual = await original<typeof import("@/utils/db")>();
  return {
    ...actual,
    getTournamentGames: mocks.getTournamentGames,
  };
});
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mocks.navigate }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (key === "Databases.List.ShowingOf" && options) {
        return `Showing ${options.shown} of ${options.total}`;
      }
      return key;
    },
  }),
}));
vi.mock("@/i18n", async (original) => ({
  ...(await original<typeof import("@/i18n")>()),
  default: { t: (key: string) => key },
}));
vi.mock("@/state/linkedCollections", async (original) => {
  const actual = await original<typeof import("@/state/linkedCollections")>();
  return {
    ...actual,
    useDatabaseContentRevision: () => ({ revision: [null, 0] as const, unavailable: false }),
  };
});
vi.mock("./PlayerSearchInput", () => ({ PlayerSearchInput: () => null }));
vi.mock("./SideInput", () => ({ SideInput: () => null }));
vi.mock("./GameCard", () => ({ default: () => null }));
vi.mock("./PlayerCard", () => ({ default: () => null }));

installMatchMediaStub();
const originalResizeObserver = globalThis.ResizeObserver;

const file = { id: { id: "windowing-db" }, kind: "database" } as const;

function makePlayers(count: number): Player[] {
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    name: `Player ${index + 1}`,
    elo: 2500 - (index % 300),
    game_count: 10 + index,
  }));
}

function makeTournaments(count: number): Event[] {
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    name: `Event ${index + 1}`,
    start_date: "2026.01.01",
    end_date: "2026.01.10",
    site: "Berlin",
    player_count: 16,
    game_count: 120,
    avg_elo: 2600,
  }));
}

function makeGames(count: number): NormalizedGame[] {
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    white: `White ${index + 1}`,
    white_id: index + 1,
    black: `Black ${index + 1}`,
    black_id: index + 1000,
    date: "2026.01.01",
    ply_count: 40,
    result: "1-0",
    event: "Open",
    event_id: 1,
    site: "Berlin",
    site_id: 1,
    fen: "",
    moves: "1. e4 e5 1-0",
  }));
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  vi.clearAllMocks();
  sessionStorage.clear();
  localStorage.clear();
  activeDatabaseViewStore.getState().setDatabase({
    file,
    title: "Windowing fixture",
  } as SuccessDatabaseInfo);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  activeDatabaseViewStore.getState().clearDatabase();
  globalThis.ResizeObserver = originalResizeObserver;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test.each([
  {
    name: "PlayerTable",
    setup: () => {
      const allPlayers = makePlayers(150);
      mocks.getPlayers.mockImplementation(async (_file, query) => {
        const page = query.options?.page ?? 1;
        const pageSize = query.options?.pageSize ?? 25;
        const start = (page - 1) * pageSize;
        return {
          data: allPlayers.slice(start, start + pageSize),
          count: query.options?.skipCount ? null : allPlayers.length,
        };
      });
      activeDatabaseViewStore.getState().setPlayersRecordsPerPage("all");
      activeDatabaseViewStore.getState().setActiveTab("players");
    },
    Component: PlayerTable,
  },
  {
    name: "TournamentTable",
    setup: () => {
      const allEvents = makeTournaments(150);
      mocks.getTournaments.mockImplementation(async (_file, query) => {
        const page = query.options?.page ?? 1;
        const pageSize = query.options?.pageSize ?? 25;
        const start = (page - 1) * pageSize;
        return {
          data: allEvents.slice(start, start + pageSize),
          count: query.options?.skipCount ? null : allEvents.length,
        };
      });
      activeDatabaseViewStore.getState().setTournamentsRecordsPerPage("all");
      activeDatabaseViewStore.getState().setActiveTab("tournaments");
    },
    Component: TournamentTable,
  },
])(
  "CR-4: unmocked $name in All mode bounds rendered tbody rows while holding 100 of 150 rows",
  async ({ setup, Component }) => {
    setup();
    await act(async () => {
      root.render(
        <MantineProvider env="test">
          <SWRConfig value={{ provider: () => new Map(), shouldRetryOnError: false }}>
            <DatabaseViewStateContext.Provider value={activeDatabaseViewStore}>
              <Component />
            </DatabaseViewStateContext.Provider>
          </SWRConfig>
        </MantineProvider>,
      );
    });

    await vi.waitFor(() => {
      expect(host.textContent).toContain("Showing 100 of 150");
    });
    const rows = host.querySelectorAll("tbody tr");
    // Bounded by the window (+ at most 2 spacer rows), far fewer than the 100 loaded rows.
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThanOrEqual(INITIAL_WINDOW_ROWS + 2);
  },
);

test("CR-4: unmocked TournamentCard in All mode bounds rendered tbody rows while holding 150 games", async () => {
  const allGames = makeGames(150);
  mocks.getTournamentGames.mockResolvedValue({ data: allGames });
  const tournament = makeTournaments(1)[0];

  await act(async () => {
    root.render(
      <MantineProvider env="test">
        <Provider store={createStore()}>
          <SWRConfig value={{ provider: () => new Map(), shouldRetryOnError: false }}>
            <DatabaseViewStateContext.Provider value={activeDatabaseViewStore}>
              <TournamentCard tournament={tournament} file={file} />
            </DatabaseViewStateContext.Provider>
          </SWRConfig>
        </Provider>
      </MantineProvider>,
    );
  });

  const gamesBody = () => host.querySelector('[role="tabpanel"] tbody')!;
  await vi.waitFor(() => {
    expect(gamesBody().querySelectorAll("tr")).toHaveLength(25);
  });

  // Switch TournamentCard to "All" via its records-per-page menu.
  const trigger = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "25",
  )!;
  await act(async () => trigger.click());
  const allItem = [...document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
    (item) => item.textContent === "Common.All",
  )!;
  await act(async () => allItem.click());

  expect(host.textContent).toContain("Showing 150 of 150");
  const rows = gamesBody().querySelectorAll("tr");
  expect(rows.length).toBeGreaterThan(0);
  expect(rows.length).toBeLessThanOrEqual(INITIAL_WINDOW_ROWS + 2);
});

test("when all three lists stay mounted, ArrowDown changes only the active tab's selection", async () => {
  mocks.getGames.mockResolvedValue({ data: makeGames(3), count: 3 });
  mocks.getPlayers.mockResolvedValue({ data: makePlayers(3), count: 3 });
  mocks.getTournaments.mockResolvedValue({ data: makeTournaments(3), count: 3 });
  activeDatabaseViewStore.getState().setActiveTab("games");

  await act(async () => {
    root.render(
      <MantineProvider env="test">
        <Provider store={createStore()}>
          <SWRConfig value={{ provider: () => new Map(), shouldRetryOnError: false }}>
            <DatabaseViewStateContext.Provider value={activeDatabaseViewStore}>
              <GameTable />
              <PlayerTable />
              <TournamentTable />
            </DatabaseViewStateContext.Provider>
          </SWRConfig>
        </Provider>
      </MantineProvider>,
    );
  });

  await vi.waitFor(() => {
    expect(mocks.getGames).toHaveBeenCalled();
    expect(mocks.getPlayers).toHaveBeenCalled();
    expect(mocks.getTournaments).toHaveBeenCalled();
  });

  // Active tab = games: ArrowDown selects game 1 only.
  await act(async () => {
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  });
  expect(activeDatabaseViewStore.getState().games.selectedGameId).toBe(1);
  expect(activeDatabaseViewStore.getState().players.selectedPlayer).toBeUndefined();
  expect(activeDatabaseViewStore.getState().tournaments.selectedTournament).toBeUndefined();

  // Switch active tab to players: ArrowDown selects player 1 only; game stays at 1.
  await act(async () => {
    activeDatabaseViewStore.getState().setActiveTab("players");
  });
  await act(async () => {
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  });
  expect(activeDatabaseViewStore.getState().games.selectedGameId).toBe(1);
  expect(activeDatabaseViewStore.getState().players.selectedPlayer).toBe(1);
  expect(activeDatabaseViewStore.getState().tournaments.selectedTournament).toBeUndefined();

  // Switch active tab to tournaments: ArrowDown selects tournament 1 only.
  await act(async () => {
    activeDatabaseViewStore.getState().setActiveTab("tournaments");
  });
  await act(async () => {
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  });
  expect(activeDatabaseViewStore.getState().games.selectedGameId).toBe(1);
  expect(activeDatabaseViewStore.getState().players.selectedPlayer).toBe(1);
  expect(activeDatabaseViewStore.getState().tournaments.selectedTournament).toBe(1);
});
