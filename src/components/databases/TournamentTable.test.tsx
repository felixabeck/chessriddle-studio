import { act, type ChangeEventHandler, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { activeDatabaseViewStore } from "@/state/store/database";
import type { SuccessDatabaseInfo } from "@/utils/db";
import { DatabaseViewStateContext } from "./DatabaseViewStateContext";
import TournamentTable from "./TournamentTable";

const mocks = vi.hoisted(() => ({ getTournaments: vi.fn() }));
vi.mock("@/platform/tauri", () => ({ tauri: { getTournaments: mocks.getTournaments } }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("react-hotkeys-hook", () => ({ useHotkeys: () => undefined }));
vi.mock("@mantine/core", () => {
  const Wrapper = ({ children }: { children: ReactNode }) => <div>{children}</div>;
  return {
    Center: Wrapper,
    Flex: Wrapper,
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
  DataTable: ({ noRecordsText }: { noRecordsText: string }) => (
    <div role="status">{noRecordsText}</div>
  ),
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
])("query failure %s renders safe empty-state copy", async (message, expected) => {
  mocks.getTournaments.mockRejectedValue(new Error(message));
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
});
