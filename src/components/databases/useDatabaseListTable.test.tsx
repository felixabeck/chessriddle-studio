import { act, type RefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { QueryOptions } from "@/bindings";
import classes from "./styles.module.css";
import { useDatabaseListTable } from "./useDatabaseListTable";
import { DEFAULT_ROW_HEIGHT_ESTIMATE, INITIAL_WINDOW_ROWS } from "./useWindowedTableRows";

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
  identity?: string;
  isActive?: boolean;
  records?: Row[];
  scrollViewportRef?: RefObject<HTMLDivElement | null>;
}) {
  result = useDatabaseListTable({
    list: {
      records: props.records ?? records,
      recordsMode: props.mode ?? "paged",
      identity: props.identity ?? "test-list",
      count: 30,
      error: props.error,
      isLoading: true,
      isLoadingMore: false,
      boundReachedWithMore: false,
      scrollViewportRef: props.scrollViewportRef ?? { current: null },
      loadMore: onLoadMore,
      retry: onRetry,
    },
    isActive: props.isActive,
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

test("document arrow keys move the selection, typing in a field does not, and hidden tabs ignore them", async () => {
  await mount({ selectedId: 2 });
  press("ArrowDown");
  expect(setSelectedId).toHaveBeenLastCalledWith(3);
  press("ArrowUp");
  expect(setSelectedId).toHaveBeenLastCalledWith(1);
  setSelectedId.mockClear();
  press("ArrowDown", host.querySelector("input")!);
  expect(setSelectedId).not.toHaveBeenCalled();

  // Hidden tab (isActive=false) ignores arrow keys.
  await mount({ selectedId: 2, isActive: false });
  press("ArrowDown");
  press("ArrowUp");
  expect(setSelectedId).not.toHaveBeenCalled();
});

test("in All mode records are windowed with rowFactory while footer shownCount reflects all loaded rows", async () => {
  const many = Array.from({ length: 120 }, (_, index) => ({ id: index + 1 }));
  await mount({ mode: "all", records: many });
  expect(result.tableProps.rowFactory).toBeTypeOf("function");
  expect(result.tableProps.records).toHaveLength(INITIAL_WINDOW_ROWS);
  expect(result.footerProps.shownCount).toBe(120);

  await mount({ mode: "paged", records: many });
  expect(result.tableProps.rowFactory).toBeUndefined();
  expect(result.tableProps.records).toBe(many);
});

test("ArrowDown and ArrowUp in All mode scroll the newly selected row into view", async () => {
  const many = Array.from({ length: 120 }, (_, index) => ({ id: index + 1 }));
  const viewport = document.createElement("div");
  let scrollTop = 0;
  const scrollTo = vi.fn((optionsOrX?: ScrollToOptions | number, y?: number) => {
    scrollTop = typeof optionsOrX === "number" ? (y ?? 0) : (optionsOrX?.top ?? 0);
    viewport.dispatchEvent(new Event("scroll"));
  });
  Object.defineProperty(viewport, "clientHeight", { configurable: true, value: 300 });
  Object.defineProperty(viewport, "offsetHeight", { configurable: true, value: 300 });
  Object.defineProperty(viewport, "scrollHeight", {
    configurable: true,
    value: many.length * DEFAULT_ROW_HEIGHT_ESTIMATE,
  });
  Object.defineProperty(viewport, "scrollTop", {
    configurable: true,
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = value;
    },
  });
  viewport.getBoundingClientRect = () =>
    ({
      width: 600,
      height: 300,
      top: 0,
      left: 0,
      bottom: 300,
      right: 600,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
  viewport.scrollTo = scrollTo as typeof viewport.scrollTo;
  const scrollViewportRef = { current: viewport };

  // Selected row 50 (index 49): ArrowDown selects row 51 (index 50, well below the 300px viewport).
  await mount({ mode: "all", records: many, selectedId: 50, scrollViewportRef });
  press("ArrowDown");
  expect(setSelectedId).toHaveBeenLastCalledWith(51);
  expect(scrollTo).toHaveBeenCalled();
  expect(scrollTop).toBe(51 * DEFAULT_ROW_HEIGHT_ESTIMATE - 300);

  // Selected row 5 (index 4) while scrolled down: ArrowUp selects row 4 (index 3) and scrolls up.
  scrollTo.mockClear();
  await mount({ mode: "all", records: many, selectedId: 5, scrollViewportRef });
  press("ArrowUp");
  expect(setSelectedId).toHaveBeenLastCalledWith(4);
  expect(scrollTo).toHaveBeenCalled();
  expect(scrollTop).toBe(3 * DEFAULT_ROW_HEIGHT_ESTIMATE);
});

test("changing list.identity in All mode forwards the reset to the windowing owner", async () => {
  const many = Array.from({ length: 120 }, (_, index) => ({ id: index + 1 }));
  const viewport = document.createElement("div");
  let scrollTop = 0;
  const scrollTo = vi.fn((optionsOrX?: ScrollToOptions | number, y?: number) => {
    scrollTop = typeof optionsOrX === "number" ? (y ?? 0) : (optionsOrX?.top ?? 0);
    viewport.dispatchEvent(new Event("scroll"));
  });
  Object.defineProperty(viewport, "clientHeight", { configurable: true, value: 300 });
  Object.defineProperty(viewport, "offsetHeight", { configurable: true, value: 300 });
  Object.defineProperty(viewport, "scrollHeight", {
    configurable: true,
    value: many.length * DEFAULT_ROW_HEIGHT_ESTIMATE,
  });
  Object.defineProperty(viewport, "scrollTop", {
    configurable: true,
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = value;
    },
  });
  viewport.getBoundingClientRect = () =>
    ({
      width: 600,
      height: 300,
      top: 0,
      left: 0,
      bottom: 300,
      right: 600,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
  viewport.scrollTo = scrollTo as typeof viewport.scrollTo;
  const scrollViewportRef = { current: viewport };

  await mount({ mode: "all", records: many, identity: "initial", scrollViewportRef });
  await act(async () => {
    scrollTop = 1000;
    viewport.dispatchEvent(new Event("scroll"));
  });
  expect(scrollTop).toBe(1000);
  scrollTo.mockClear();

  await mount({ mode: "all", records: many, identity: "sorted", scrollViewportRef });
  expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 0 }));
  expect(scrollTop).toBe(0);
});
