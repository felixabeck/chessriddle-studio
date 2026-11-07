import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { activeDatabaseViewStore } from "@/state/store/database";
import { ELO_FILTER_MAX, query_players, type SuccessDatabaseInfo } from "@/utils/db";
import { DatabaseViewStateContext } from "./DatabaseViewStateContext";
import PlayerTable from "./PlayerTable";

const mocks = vi.hoisted(() => ({
  getPlayers: vi.fn(),
  inputs: new Map<string, (value: number | string) => void>(),
}));
vi.mock("@/platform/tauri", () => ({ tauri: { getPlayers: mocks.getPlayers } }));
vi.mock("@/utils/db", async (original) => {
  const actual = await original<typeof import("@/utils/db")>();
  return { ...actual, query_players: vi.fn(actual.query_players) };
});
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("react-hotkeys-hook", () => ({ useHotkeys: () => undefined }));
vi.mock("@mantine/core", () => {
  const Wrapper = ({ children }: { children: ReactNode }) => <div>{children}</div>;
  return {
    Center: Wrapper,
    Collapse: Wrapper,
    Flex: Wrapper,
    Group: Wrapper,
    Text: Wrapper,
    TextInput: () => null,
    NumberInput: ({
      label,
      onChange,
    }: {
      label: string;
      onChange: (value: string | number) => void;
    }) => {
      mocks.inputs.set(label, onChange);
      return <input aria-label={label} />;
    },
  };
});
vi.mock("mantine-datatable", () => ({
  DataTable: ({
    records,
    columns,
    sortStatus,
    onSortStatusChange,
  }: {
    records: import("@/bindings").Player[];
    columns: { accessor: string; title: string; sortable?: boolean }[];
    sortStatus: { columnAccessor: string; direction: "asc" | "desc" };
    onSortStatusChange: (value: { columnAccessor: string; direction: "asc" | "desc" }) => void;
  }) => (
    <table>
      <thead>
        <tr>
          {columns.map((column) => (
            <th
              key={column.accessor}
              data-sortable={column.sortable || undefined}
              aria-sort={
                sortStatus.columnAccessor === column.accessor
                  ? sortStatus.direction === "asc"
                    ? "ascending"
                    : "descending"
                  : undefined
              }
              onClick={
                column.sortable
                  ? () =>
                      onSortStatusChange({
                        columnAccessor: column.accessor,
                        direction:
                          sortStatus.columnAccessor === column.accessor &&
                          sortStatus.direction === "asc"
                            ? "desc"
                            : "asc",
                      })
                  : undefined
              }
            >
              {column.title}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {records.map((record) => (
          <tr key={record.id}>
            <td>{record.game_count}</td>
          </tr>
        ))}
      </tbody>
    </table>
  ),
}));
vi.mock("@/components/common/IconAction", () => ({ IconAction: () => null }));
vi.mock("./PlayerCard", () => ({ default: () => null }));
vi.mock("./GridLayout", () => ({
  default: ({ search, table }: { search: ReactNode; table: ReactNode }) => (
    <div>
      {search}
      {table}
    </div>
  ),
}));

const file = { id: { id: "elo-database" }, kind: "database" } as const;
let root: Root;
let container: HTMLDivElement;
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.inputs.clear();
  mocks.getPlayers.mockResolvedValue({ data: [], count: 0 });
  activeDatabaseViewStore
    .getState()
    .setDatabase({ file, title: "Elo fixture" } as SuccessDatabaseInfo);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  activeDatabaseViewStore.getState().clearDatabase();
});

test("max Elo preserves numeric zero and an empty max restores the omitted full band", async () => {
  await act(async () =>
    root.render(
      <SWRConfig value={{ provider: () => new Map(), shouldRetryOnError: false }}>
        <DatabaseViewStateContext.Provider value={activeDatabaseViewStore}>
          <PlayerTable />
        </DatabaseViewStateContext.Provider>
      </SWRConfig>,
    ),
  );
  await act(async () => mocks.inputs.get("Databases.Player.MaxELO")!(0));

  expect(query_players).toHaveBeenLastCalledWith(file, expect.objectContaining({ range: [0, 0] }), {
    signal: expect.any(AbortSignal),
  });
  expect(mocks.getPlayers).toHaveBeenLastCalledWith(
    file,
    expect.objectContaining({ range: [0, 0] }),
    { signal: expect.any(AbortSignal) },
  );

  await act(async () => mocks.inputs.get("Databases.Player.MaxELO")!(""));

  expect(query_players).toHaveBeenLastCalledWith(
    file,
    expect.objectContaining({ range: [0, ELO_FILTER_MAX] }),
    { signal: expect.any(AbortSignal) },
  );
  expect(mocks.getPlayers).toHaveBeenLastCalledWith(
    file,
    expect.objectContaining({ range: undefined }),
    { signal: expect.any(AbortSignal) },
  );
});

test("sortable Games header requests both games sort directions and renders the native player counts", async () => {
  mocks.getPlayers.mockResolvedValue({
    data: [{ id: 1, name: "Player", elo: 2200, game_count: 1234 }],
    count: 1,
  });
  await act(async () =>
    root.render(
      <SWRConfig value={{ provider: () => new Map(), shouldRetryOnError: false }}>
        <DatabaseViewStateContext.Provider value={activeDatabaseViewStore}>
          <PlayerTable />
        </DatabaseViewStateContext.Provider>
      </SWRConfig>,
    ),
  );
  expect(container.querySelector("tbody")?.textContent).toBe("1234");
  const gamesHeader = Array.from(container.querySelectorAll("th")).find(
    (header) => header.textContent === "Board.Database.Games",
  )!;
  expect(gamesHeader.dataset.sortable).toBe("true");
  for (const direction of ["asc", "desc"] as const) {
    await act(async () => gamesHeader.click());
    expect(query_players).toHaveBeenLastCalledWith(
      file,
      expect.objectContaining({
        options: expect.objectContaining({ sort: "games", direction, page: 1 }),
      }),
      { signal: expect.any(AbortSignal) },
    );
    expect(mocks.getPlayers).toHaveBeenLastCalledWith(
      file,
      expect.objectContaining({
        options: expect.objectContaining({ sort: "games", direction, page: 1 }),
      }),
      { signal: expect.any(AbortSignal) },
    );
    expect(gamesHeader.getAttribute("aria-sort")).toBe(
      direction === "asc" ? "ascending" : "descending",
    );
  }
});
