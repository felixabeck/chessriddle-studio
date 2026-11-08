import { MantineProvider } from "@mantine/core";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Event, Player } from "@/bindings";
import { activeDatabaseViewStore } from "@/state/store/database";
import { installMatchMediaStub } from "@/tests/matchMedia";
import type { SuccessDatabaseInfo } from "@/utils/db";
import { DatabaseViewStateContext } from "./DatabaseViewStateContext";
import PlayerTable from "./PlayerTable";
import TournamentTable from "./TournamentTable";

const mocks = vi.hoisted(() => ({
  hotkeys: new Map<string, () => void>(),
  table: null as null | {
    sortStatus: { columnAccessor: string; direction: "asc" | "desc" };
    onSortStatusChange: (value: { columnAccessor: string; direction: "asc" | "desc" }) => void;
  },
}));
vi.mock("react-hotkeys-hook", () => ({
  useHotkeys: (key: string, callback: () => void) => mocks.hotkeys.set(key, callback),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("swr", () => ({
  default: () => ({ data: { data: records, count: 100 }, isLoading: false }),
}));
vi.mock("@/hooks/useNativeRequestOwner", () => ({ useNativeRequestOwner: () => null }));
vi.mock("./GridLayout", () => ({
  default: ({ table, preview }: { table: ReactNode; preview: ReactNode }) => (
    <>
      {table}
      {preview}
    </>
  ),
}));
vi.mock("./PlayerCard", () => ({
  default: ({ player }: { player: Player }) => <output>{player.id}</output>,
}));
vi.mock("./TournamentCard", () => ({
  default: ({ tournament }: { tournament: Event }) => <output>{tournament.id}</output>,
}));
vi.mock("mantine-datatable", () => ({
  DataTable: ({
    records,
    onRowClick,
    sortStatus,
    onSortStatusChange,
  }: {
    records: Array<{ id: number }>;
    onRowClick: (row: { index: number }) => void;
    sortStatus: { columnAccessor: string; direction: "asc" | "desc" };
    onSortStatusChange: (value: { columnAccessor: string; direction: "asc" | "desc" }) => void;
  }) => {
    mocks.table = { sortStatus, onSortStatusChange };
    return (
      <div>
        {records.map((record, index) => (
          <button key={record.id} onClick={() => onRowClick({ index })}>
            {record.id}
          </button>
        ))}
      </div>
    );
  },
}));

const page = Array.from({ length: 25 }, (_, index) => ({
  id: index * 11,
  name: `Record ${index}`,
  elo: 2000,
  start_date: null,
  end_date: null,
  site: null,
  player_count: 0,
  game_count: 0,
  avg_elo: null,
}));
let records = page;
let host: HTMLDivElement;
let root: Root;
installMatchMediaStub();
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

beforeEach(() => {
  records = page;
  mocks.hotkeys.clear();
  activeDatabaseViewStore.getState().setDatabase({
    file: { id: { id: "navigation-database" }, kind: "database" },
    title: "Navigation fixture",
  } as SuccessDatabaseInfo);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  activeDatabaseViewStore.getState().clearDatabase();
});

test("TournamentTable maps summary accessors to API sorts and defaults to date descending", async () => {
  await act(async () =>
    root.render(
      <MantineProvider>
        <DatabaseViewStateContext.Provider value={activeDatabaseViewStore}>
          <TournamentTable />
        </DatabaseViewStateContext.Provider>
      </MantineProvider>,
    ),
  );
  expect(mocks.table?.sortStatus).toEqual({ columnAccessor: "start_date", direction: "desc" });
  for (const [columnAccessor, sort] of [
    ["name", "name"],
    ["start_date", "date"],
    ["player_count", "players"],
    ["game_count", "games"],
    ["avg_elo", "avgElo"],
  ]) {
    await act(async () => mocks.table!.onSortStatusChange({ columnAccessor, direction: "asc" }));
    expect(activeDatabaseViewStore.getState().tournaments.query.options).toMatchObject({
      sort,
      direction: "asc",
    });
    expect(mocks.table?.sortStatus).toEqual({ columnAccessor, direction: "asc" });
  }
});

describe.each([
  {
    name: "PlayerTable",
    Component: PlayerTable,
    select: (id?: number) => activeDatabaseViewStore.getState().setPlayersSelectedPlayer(id),
    selected: () => activeDatabaseViewStore.getState().players.selectedPlayer,
    query: () => activeDatabaseViewStore.getState().players.query,
  },
  {
    name: "TournamentTable",
    Component: TournamentTable,
    select: (id?: number) =>
      activeDatabaseViewStore.getState().setTournamentsSelectedTournament(id),
    selected: () => activeDatabaseViewStore.getState().tournaments.selectedTournament,
    query: () => activeDatabaseViewStore.getState().tournaments.query,
  },
])("$name page-local navigation", ({ Component, select, selected, query }) => {
  async function render() {
    await act(async () =>
      root.render(
        <MantineProvider>
          <DatabaseViewStateContext.Provider value={activeDatabaseViewStore}>
            <Component />
          </DatabaseViewStateContext.Provider>
        </MantineProvider>,
      ),
    );
  }

  async function press(key: "ArrowUp" | "ArrowDown") {
    await act(async () => {
      expect(() => mocks.hotkeys.get(key)!()).not.toThrow();
    });
  }

  test("ArrowDown at the last loaded row keeps selection when total count exceeds page length", async () => {
    const last = page[24].id;
    select(last);
    const initialQuery = query();
    await render();
    await press("ArrowDown");
    await press("ArrowDown");
    expect(selected()).toBe(last);
    expect(host.querySelector("output")?.textContent).toBe(String(last));
    await press("ArrowUp");
    expect(selected()).toBe(page[23].id);
    await press("ArrowDown");
    expect(selected()).toBe(last);
    expect(query()).toBe(initialQuery);
  });

  test("ArrowDown moves from the middle to the next record identity and ArrowUp returns", async () => {
    select(page[12].id);
    await render();
    await press("ArrowDown");
    expect(selected()).toBe(page[13].id);
    expect(host.querySelector("output")?.textContent).toBe(String(page[13].id));
    await press("ArrowUp");
    expect(selected()).toBe(page[12].id);
  });

  test("ArrowUp at the first row stays there and ArrowDown can leave the boundary", async () => {
    select(page[0].id);
    await render();
    await press("ArrowUp");
    expect(selected()).toBe(page[0].id);
    await press("ArrowDown");
    expect(selected()).toBe(page[1].id);
    await press("ArrowUp");
    expect(selected()).toBe(page[0].id);
  });

  test("navigation follows selection changes from row clicks", async () => {
    select(page[12].id);
    await render();
    await act(async () => host.querySelectorAll("button")[3].click());
    expect(selected()).toBe(page[3].id);
    await press("ArrowDown");
    expect(selected()).toBe(page[4].id);
    await act(async () => host.querySelectorAll("button")[8].click());
    await press("ArrowUp");
    expect(selected()).toBe(page[7].id);
  });

  test.each([undefined, 9999])("arrows preserve absent selection %s", async (id) => {
    select(id);
    await render();
    await press("ArrowDown");
    await press("ArrowUp");
    expect(selected()).toBe(id);
  });

  test("arrows preserve selection when the loaded page is empty", async () => {
    select(page[12].id);
    records = [];
    await render();
    await press("ArrowDown");
    await press("ArrowUp");
    expect(selected()).toBe(page[12].id);
  });
});
