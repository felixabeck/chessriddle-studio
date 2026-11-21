import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { QueryOptions } from "@/bindings";
import classes from "./styles.module.css";
import { useDatabaseListTable } from "./useDatabaseListTable";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

type Sort = "name" | "games";
type Query = { name: string; options: QueryOptions<Sort> };
type Row = { id: number };

const records: Row[] = [{ id: 1 }, { id: 2 }, { id: 3 }];
const query: Query = {
  name: "kept",
  options: { skipCount: false, page: 2, pageSize: 10, sort: "games", direction: "asc" },
};

let host: HTMLDivElement;
let root: Root;
let table: ReturnType<typeof useDatabaseListTable<Row, Query>>;
const setQuery = vi.fn();
const setSelectedId = vi.fn();
const activate = vi.fn();

function Probe(props: { selectedId?: number; error?: unknown; query?: Query }) {
  table = useDatabaseListTable({
    records,
    count: 30,
    error: props.error,
    isLoading: true,
    query: props.query ?? query,
    setQuery,
    selectedId: props.selectedId,
    setSelectedId,
    sortAccessor: (sort) => (sort === "games" ? "game_count" : "name"),
    sortOf: (accessor) =>
      accessor === "game_count" ? "games" : accessor === "name" ? "name" : undefined,
    emptyText: "Nothing here",
    activate,
  });
  return <input aria-label="search" />;
}

async function mount(props: Parameters<typeof Probe>[0] = {}) {
  await act(async () => root.render(<Probe {...props} />));
}

function press(key: string, target: EventTarget = document.body) {
  act(() => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

test("paging and page size come from the query and write back into its options", async () => {
  await mount();
  expect(table).toMatchObject({
    records,
    fetching: true,
    totalRecords: 30,
    page: 2,
    recordsPerPage: 10,
    recordsPerPageLabel: "Common.RecordsPerPage",
    recordsPerPageOptions: [10, 25, 50],
  });
  table.onPageChange(3);
  expect(setQuery).toHaveBeenLastCalledWith({ ...query, options: { ...query.options, page: 3 } });
  table.onRecordsPerPageChange(50);
  expect(setQuery).toHaveBeenLastCalledWith({
    ...query,
    options: { ...query.options, pageSize: 50 },
  });
});

test("a query without page or size starts on page one with 25 rows", async () => {
  await mount({
    query: { name: "", options: { skipCount: false, sort: "name", direction: "desc" } },
  });
  expect(table).toMatchObject({ page: 1, recordsPerPage: 25 });
});

test("sort status round-trips through the table's mapping and ignores unsortable columns", async () => {
  await mount();
  expect(table.sortStatus).toEqual({ columnAccessor: "game_count", direction: "asc" });
  table.onSortStatusChange({ columnAccessor: "name", direction: "desc" });
  expect(setQuery).toHaveBeenLastCalledWith({
    ...query,
    options: { ...query.options, sort: "name", direction: "desc" },
  });
  setQuery.mockClear();
  table.onSortStatusChange({ columnAccessor: "site", direction: "desc" });
  expect(setQuery).not.toHaveBeenCalled();
});

test("the selected row is marked and a row click selects its record", async () => {
  await mount({ selectedId: 2 });
  expect(table.rowClassName(records[1])).toBe(classes.selected);
  expect(table.rowClassName(records[0])).toBe("");
  expect(table.customRowAttributes(records[1])["aria-selected"]).toBe(true);
  expect(table.customRowAttributes(records[0])["aria-selected"]).toBe(false);
  table.onRowClick({ record: records[2] });
  expect(setSelectedId).toHaveBeenLastCalledWith(3);
});

test("Enter on a row activates that record", async () => {
  await mount();
  const row = document.createElement("tr");
  const { onKeyDown } = table.customRowAttributes(records[0]);
  onKeyDown({
    key: "Enter",
    repeat: false,
    target: row,
    currentTarget: row,
    preventDefault: () => undefined,
  } as never);
  expect(activate).toHaveBeenCalledExactlyOnceWith(records[0]);
});

test("a load failure replaces the empty text, otherwise the table's own empty text shows", async () => {
  await mount();
  expect(table.noRecordsText).toBe("Nothing here");
  await mount({ error: { category: "unexpected", message: "boom" } });
  expect(table.noRecordsText).not.toBe("Nothing here");
});

test("document arrow keys move the selection, typing in a field does not", async () => {
  await mount({ selectedId: 2 });
  press("ArrowDown");
  expect(setSelectedId).toHaveBeenLastCalledWith(3);
  press("ArrowUp");
  expect(setSelectedId).toHaveBeenLastCalledWith(1);
  setSelectedId.mockClear();
  press("ArrowDown", host.querySelector("input")!);
  expect(setSelectedId).not.toHaveBeenCalled();
});
