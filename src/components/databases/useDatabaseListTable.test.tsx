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
let result: ReturnType<typeof useDatabaseListTable<Row, Query>>;
const setQuery = vi.fn();
const setRecordsPerPage = vi.fn();
const setSelectedId = vi.fn();
const activate = vi.fn();
const onLoadMore = vi.fn();
const onRetry = vi.fn();

function Probe(props: {
  selectedId?: number;
  error?: unknown;
  query?: Query;
  mode?: "paged" | "all";
}) {
  result = useDatabaseListTable({
    list: {
      records,
      count: 30,
      error: props.error,
      isLoading: true,
      isLoadingMore: false,
      boundReachedWithMore: false,
      scrollViewportRef: { current: null },
      loadMore: onLoadMore,
      retry: onRetry,
    },
    mode: props.mode ?? "paged",
    query: props.query ?? query,
    setQuery,
    setRecordsPerPage,
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

test("paging and page size come from the query and write back through setQuery / setRecordsPerPage", async () => {
  await mount();
  expect(result.tableProps).toMatchObject({
    records,
    fetching: true,
    height: undefined,
    onScrollToBottom: undefined,
  });
  expect(result.footerProps).toMatchObject({
    mode: "paged",
    page: 2,
    recordsPerPage: 10,
    shownCount: 3,
    totalRecords: 30,
  });
  result.footerProps.onPageChange(3);
  expect(setQuery).toHaveBeenLastCalledWith({ ...query, options: { ...query.options, page: 3 } });
  result.footerProps.onRecordsPerPageChange(50);
  expect(setRecordsPerPage).toHaveBeenLastCalledWith(50);
  result.footerProps.onRecordsPerPageChange("all");
  expect(setRecordsPerPage).toHaveBeenLastCalledWith("all");
});

test("in All mode onScrollToBottom forwards to onLoadMore and height is bounded", async () => {
  await mount({ mode: "all" });
  expect(result.tableProps.onScrollToBottom).toBe(onLoadMore);
  expect(result.tableProps.height).toBe("100%");
});

test("a query without page or size starts on page one with 25 rows", async () => {
  await mount({
    query: { name: "", options: { skipCount: false, sort: "name", direction: "desc" } },
  });
  expect(result.footerProps).toMatchObject({ page: 1, recordsPerPage: 25 });
});

test("sort status round-trips through the table's mapping and ignores unsortable columns", async () => {
  await mount();
  expect(result.tableProps.sortStatus).toEqual({ columnAccessor: "game_count", direction: "asc" });
  result.tableProps.onSortStatusChange({ columnAccessor: "name", direction: "desc" });
  expect(setQuery).toHaveBeenLastCalledWith({
    ...query,
    options: { ...query.options, sort: "name", direction: "desc" },
  });
  setQuery.mockClear();
  result.tableProps.onSortStatusChange({ columnAccessor: "site", direction: "desc" });
  expect(setQuery).not.toHaveBeenCalled();
});

test("the selected row is marked and a row click selects its record", async () => {
  await mount({ selectedId: 2 });
  expect(result.tableProps.rowClassName(records[1])).toBe(classes.selected);
  expect(result.tableProps.rowClassName(records[0])).toBe("");
  expect(result.tableProps.customRowAttributes(records[1])["aria-selected"]).toBe(true);
  expect(result.tableProps.customRowAttributes(records[0])["aria-selected"]).toBe(false);
  result.tableProps.onRowClick({ record: records[2] });
  expect(setSelectedId).toHaveBeenLastCalledWith(3);
});

test("Enter on a row activates that record", async () => {
  await mount();
  const row = document.createElement("tr");
  const { onKeyDown } = result.tableProps.customRowAttributes(records[0]);
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
  expect(result.tableProps.noRecordsText).toBe("Nothing here");
  await mount({ error: { category: "unexpected", message: "boom" } });
  expect(result.tableProps.noRecordsText).not.toBe("Nothing here");
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
