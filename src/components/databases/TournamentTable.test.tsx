import { act, type ChangeEventHandler, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { normalizeError } from "@/platform/errors";
import { activeDatabaseViewStore } from "@/state/store/database";
import type { SuccessDatabaseInfo } from "@/utils/db";
import { DatabaseViewStateContext } from "./DatabaseViewStateContext";
import TournamentTable from "./TournamentTable";
import { INITIAL_WINDOW_ROWS } from "./useWindowedTableRows";

const mocks = vi.hoisted(() => ({
  getTournaments: vi.fn(),
  tableProps: undefined as
    | {
        records: import("@/bindings").Event[];
        rowFactory?: unknown;
        onScrollToBottom?: () => void;
      }
    | undefined,
}));
vi.mock("@/platform/tauri", () => ({ tauri: { getTournaments: mocks.getTournaments } }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/i18n", async (original) => ({
  ...(await original<typeof import("@/i18n")>()),
  default: { t: (key: string) => key },
}));
vi.mock("@mantine/core", () => {
  const Wrapper = ({ children }: { children: ReactNode }) => <div>{children}</div>;
  const Menu = Object.assign(Wrapper, {
    Target: Wrapper,
    Dropdown: Wrapper,
    Item: ({
      children,
      disabled,
      onClick,
    }: {
      children: ReactNode;
      disabled?: boolean;
      onClick?: () => void;
    }) => (
      <button type="button" role="menuitem" disabled={disabled} onClick={onClick}>
        {children}
      </button>
    ),
  });
  return {
    Box: Wrapper,
    Button: ({
      children,
      onClick,
      disabled,
    }: {
      children: ReactNode;
      onClick?: () => void;
      disabled?: boolean;
    }) => (
      <button type="button" disabled={disabled} onClick={onClick}>
        {children}
      </button>
    ),
    Center: Wrapper,
    Flex: Wrapper,
    Group: Wrapper,
    Loader: () => null,
    Menu,
    Pagination: () => null,
    Text: Wrapper,
    TextInput: ({
      value,
      onChange,
      "aria-label": ariaLabel,
    }: {
      value: string;
      onChange: ChangeEventHandler<HTMLInputElement>;
      "aria-label"?: string;
    }) => <input aria-label={ariaLabel} value={value} onChange={onChange} />,
  };
});
vi.mock("mantine-datatable", () => ({
  DataTable: ({
    records,
    noRecordsText,
    rowFactory,
    onScrollToBottom,
  }: {
    records: import("@/bindings").Event[];
    noRecordsText: string;
    rowFactory?: unknown;
    onScrollToBottom?: () => void;
  }) => {
    mocks.tableProps = { records, rowFactory, onScrollToBottom };
    return (
      <div>
        <div role="status">{noRecordsText}</div>
        <table>
          <tbody>
            {records.map((event) => (
              <tr key={event.id}>
                <td>{event.name}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  },
}));
vi.mock("./TournamentCard", () => ({ default: () => null }));
vi.mock("./GridLayout", () => ({
  default: ({ search, table }: { search: ReactNode; table: ReactNode }) => (
    <div>
      {search}
      {table}
    </div>
  ),
}));

const file = { id: { id: "event-search-database" }, kind: "database" } as const;
let root: Root;
let container: HTMLDivElement;
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

beforeEach(() => {
  vi.useFakeTimers();
  mocks.getTournaments.mockReset().mockResolvedValue({ data: [], count: 0 });
  activeDatabaseViewStore
    .getState()
    .setDatabase({ file, title: "Event search fixture" } as SuccessDatabaseInfo);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  activeDatabaseViewStore.getState().clearDatabase();
  vi.useRealTimers();
});

test("name search debounces rapid typing until 250 ms after the final change", async () => {
  await act(async () =>
    root.render(
      <SWRConfig value={{ provider: () => new Map(), shouldRetryOnError: false }}>
        <DatabaseViewStateContext.Provider value={activeDatabaseViewStore}>
          <TournamentTable />
        </DatabaseViewStateContext.Provider>
      </SWRConfig>,
    ),
  );
  expect(mocks.getTournaments).toHaveBeenCalledOnce();
  mocks.getTournaments.mockClear();
  const input = container.querySelector<HTMLInputElement>('input[aria-label="Common.Search"]')!;
  expect(input).not.toBeNull();
  for (const name of ["c", "ca", "car"]) {
    await act(async () => vi.advanceTimersByTimeAsync(50));
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, name);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(input.value).toBe(name);
    expect(activeDatabaseViewStore.getState().tournaments.query.name).toBe(name);
    expect(mocks.getTournaments).not.toHaveBeenCalled();
  }
  await act(async () => vi.advanceTimersByTimeAsync(249));
  expect(mocks.getTournaments).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(mocks.getTournaments).toHaveBeenCalledExactlyOnceWith(
    file,
    expect.objectContaining({ name: "car" }),
    { signal: expect.any(AbortSignal) },
  );
});

test.each([
  ["C:\\secret\\path diag", "Databases.LoadError.Title"],
  ["Cancellation", "Databases.Tournament.NoneFound"],
  ["private database diagnostic", "Databases.LoadError.RootPermission", "permission"],
])(
  "query failure %s renders safe empty-state copy",
  async (message, expected, rootFailure = undefined) => {
    mocks.getTournaments.mockRejectedValue(
      rootFailure
        ? normalizeError({ tag: "backend-error", category: "io", message, rootFailure })
        : new Error(message),
    );
    await act(async () =>
      root.render(
        <SWRConfig value={{ provider: () => new Map(), shouldRetryOnError: false }}>
          <DatabaseViewStateContext.Provider value={activeDatabaseViewStore}>
            <TournamentTable />
          </DatabaseViewStateContext.Provider>
        </SWRConfig>,
      ),
    );
    expect(mocks.getTournaments).toHaveBeenCalled();
    expect(container.querySelector('[role="status"]')?.textContent).toBe(expected);
    expect(container.textContent).not.toContain(message);
  },
);

test("switching to All issues one first-chunk request and switching back returns to paged page 1", async () => {
  activeDatabaseViewStore.getState().setTournamentsQuery({
    ...activeDatabaseViewStore.getState().tournaments.query,
    options: {
      ...activeDatabaseViewStore.getState().tournaments.query.options,
      page: 2,
      pageSize: 50,
    },
  });
  await act(async () =>
    root.render(
      <SWRConfig value={{ provider: () => new Map(), shouldRetryOnError: false }}>
        <DatabaseViewStateContext.Provider value={activeDatabaseViewStore}>
          <TournamentTable />
        </DatabaseViewStateContext.Provider>
      </SWRConfig>,
    ),
  );
  mocks.getTournaments.mockClear();

  const allItem = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
    (item) => item.textContent === "Common.All",
  )!;
  await act(async () => allItem.click());
  expect(mocks.getTournaments).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTimeAsync(250));

  expect(activeDatabaseViewStore.getState().tournaments.listMode).toBe("all");
  expect(mocks.getTournaments).toHaveBeenCalledTimes(1);
  expect(mocks.getTournaments).toHaveBeenLastCalledWith(
    file,
    expect.objectContaining({
      options: expect.objectContaining({ page: 1, pageSize: 100, skipCount: false }),
    }),
    { signal: expect.any(AbortSignal) },
  );

  mocks.getTournaments.mockClear();
  const size25 = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
    (item) => item.textContent === "25",
  )!;
  await act(async () => size25.click());
  expect(mocks.getTournaments).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTimeAsync(250));
  expect(activeDatabaseViewStore.getState().tournaments.listMode).toBe("paged");
  expect(activeDatabaseViewStore.getState().tournaments.query.options.page).toBe(1);
  expect(activeDatabaseViewStore.getState().tournaments.query.options.pageSize).toBe(25);
  expect(mocks.getTournaments).toHaveBeenCalledTimes(1);
  expect(mocks.getTournaments).toHaveBeenLastCalledWith(
    file,
    expect.objectContaining({
      options: expect.objectContaining({ page: 1, pageSize: 25, skipCount: false }),
    }),
    { signal: expect.any(AbortSignal) },
  );
});

test("held-records mode: switching from All to 25 keeps accumulated rows windowed during the debounce window", async () => {
  const makeEvents = (startId: number, length: number) =>
    Array.from({ length }, (_, index) => ({
      id: startId + index,
      name: `Event ${startId + index}`,
      start_date: "2026.01.01",
      end_date: "2026.01.10",
      site: "Berlin",
      player_count: 10,
      game_count: 50,
      avg_elo: 2500,
    }));
  mocks.getTournaments.mockImplementation(async (_file, query) => {
    const page = query.options?.page ?? 1;
    const size = query.options?.pageSize ?? 25;
    return {
      data: makeEvents((page - 1) * size + 1, size),
      count: query.options?.skipCount ? null : 300,
    };
  });

  activeDatabaseViewStore.getState().setTournamentsRecordsPerPage("all");
  await act(async () =>
    root.render(
      <SWRConfig value={{ provider: () => new Map(), shouldRetryOnError: false }}>
        <DatabaseViewStateContext.Provider value={activeDatabaseViewStore}>
          <TournamentTable />
        </DatabaseViewStateContext.Provider>
      </SWRConfig>,
    ),
  );

  await act(async () => {
    mocks.tableProps?.onScrollToBottom?.();
  });
  expect(mocks.tableProps?.rowFactory).toBeTypeOf("function");
  expect(container.querySelectorAll("tbody tr")).toHaveLength(INITIAL_WINDOW_ROWS);

  const size25 = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
    (item) => item.textContent === "25",
  )!;
  await act(async () => size25.click());
  expect(activeDatabaseViewStore.getState().tournaments.listMode).toBe("paged");
  expect(mocks.tableProps?.rowFactory).toBeTypeOf("function");
  expect(container.querySelectorAll("tbody tr")).toHaveLength(INITIAL_WINDOW_ROWS);

  await act(async () => vi.advanceTimersByTimeAsync(250));
  expect(mocks.tableProps?.rowFactory).toBeUndefined();
  expect(container.querySelectorAll("tbody tr")).toHaveLength(25);
});

test("ignores arrow keys when Tournaments tab is hidden", async () => {
  mocks.getTournaments.mockResolvedValue({
    data: [
      {
        id: 1,
        name: "Event 1",
        start_date: null,
        end_date: null,
        site: null,
        player_count: 4,
        game_count: 6,
        avg_elo: null,
      },
    ],
    count: 1,
  });
  activeDatabaseViewStore.getState().setActiveTab("games");
  await act(async () =>
    root.render(
      <SWRConfig value={{ provider: () => new Map(), shouldRetryOnError: false }}>
        <DatabaseViewStateContext.Provider value={activeDatabaseViewStore}>
          <TournamentTable />
        </DatabaseViewStateContext.Provider>
      </SWRConfig>,
    ),
  );
  await act(async () => {
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  });
  expect(activeDatabaseViewStore.getState().tournaments.selectedTournament).toBeUndefined();
});
