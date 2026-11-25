import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SWRConfig, useSWRConfig } from "swr";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { DatabaseHandle, QueryOptions, QueryResponse } from "@/bindings";
import type { ListDisplayMode } from "@/state/store/database";
import { refreshDatabaseGameQueries } from "./databaseMutation";
import {
  ALL_RECORDS_CHUNK_SIZE,
  ALL_RECORDS_MAX_ROWS,
  type DatabaseListQueryResult,
  useDatabaseListQuery,
} from "./useDatabaseListQuery";

type Row = { id: number; label: string };
type Sort = "date" | "name";
type TestQuery = { filter?: string; options: QueryOptions<Sort> };

const fileA: DatabaseHandle = { id: { id: "db-a" }, kind: "database" };
const fileB: DatabaseHandle = { id: { id: "db-b" }, kind: "database" };

function makeRows(startId: number, length: number, prefix = "row"): Row[] {
  return Array.from({ length }, (_, index) => ({
    id: startId + index,
    label: `${prefix}-${startId + index}`,
  }));
}

function makeQuery(
  overrides: Omit<Partial<TestQuery>, "options"> & { options?: Partial<QueryOptions<Sort>> } = {},
): TestQuery {
  return {
    filter: overrides.filter ?? "",
    options: {
      skipCount: false,
      page: 1,
      pageSize: 25,
      sort: "date",
      direction: "desc",
      ...overrides.options,
    },
  };
}

let host: HTMLDivElement;
let root: Root;
let latest: DatabaseListQueryResult<Row>;
let refreshAll: () => Promise<unknown>;
let revalidateGames: () => Promise<unknown>;
let cache: Map<string, any>;

type ProbeProps = {
  file?: DatabaseHandle;
  query?: TestQuery;
  mode?: ListDisplayMode;
  generation?: string;
  debounceMs?: number;
  fetchPage: (
    file: DatabaseHandle,
    query: TestQuery,
    options: { signal: AbortSignal },
  ) => Promise<QueryResponse<Row[]>>;
  viewport?: { clientHeight: number; scrollHeight: number; scrollTop: number };
  onScrollTo?: ReturnType<typeof vi.fn>;
};

function Probe(props: ProbeProps) {
  const { cache: swrCache, mutate } = useSWRConfig();
  refreshAll = () => refreshDatabaseGameQueries(props.file ?? fileA, swrCache, mutate);
  revalidateGames = () => mutate((key) => Array.isArray(key) && key[0] === "games");
  const result = useDatabaseListQuery<Row, TestQuery>({
    kind: "games",
    file: props.file ?? fileA,
    query: props.query ?? makeQuery(),
    mode: props.mode ?? "all",
    generation: props.generation,
    debounceMs: props.debounceMs,
    fetchPage: props.fetchPage,
  });
  latest = result;
  return (
    <div
      ref={(node) => {
        result.scrollViewportRef.current = node;
        if (node && props.onScrollTo) {
          node.scrollTo = props.onScrollTo as typeof node.scrollTo;
        }
        if (node && props.viewport) {
          Object.defineProperty(node, "clientHeight", {
            configurable: true,
            value: props.viewport.clientHeight,
          });
          Object.defineProperty(node, "scrollHeight", {
            configurable: true,
            value: props.viewport.scrollHeight,
          });
          Object.defineProperty(node, "scrollTop", {
            configurable: true,
            value: props.viewport.scrollTop,
          });
        }
      }}
    />
  );
}

async function mount(props: ProbeProps) {
  await act(async () => {
    root.render(
      <SWRConfig value={{ provider: () => cache }}>
        <Probe {...props} />
      </SWRConfig>,
    );
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  cache = new Map();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test("appends 100-row chunks with skipCount after the first, prevents concurrent chunks, and stops at count", async () => {
  let resolvePage2!: (value: QueryResponse<Row[]>) => void;
  const fetchPage = vi.fn(
    async (_file: DatabaseHandle, query: TestQuery): Promise<QueryResponse<Row[]>> => {
      const page = query.options.page ?? 1;
      if (page === 1) {
        return { data: makeRows(1, ALL_RECORDS_CHUNK_SIZE), count: 250 };
      }
      if (page === 2) {
        return await new Promise((resolve) => {
          resolvePage2 = resolve;
        });
      }
      return { data: makeRows(201, 50), count: null };
    },
  );

  await mount({ fetchPage });
  expect(latest.records).toHaveLength(100);
  expect(latest.count).toBe(250);
  expect(fetchPage).toHaveBeenCalledWith(
    fileA,
    expect.objectContaining({
      options: expect.objectContaining({
        page: 1,
        pageSize: ALL_RECORDS_CHUNK_SIZE,
        skipCount: false,
      }),
    }),
    { signal: expect.any(AbortSignal) },
  );

  // Trigger loadMore twice while page 2 is in flight -> only one concurrent chunk.
  await act(async () => {
    latest.loadMore();
    latest.loadMore();
  });
  expect(fetchPage).toHaveBeenCalledTimes(2);
  expect(latest.isLoadingMore).toBe(true);
  expect(fetchPage).toHaveBeenLastCalledWith(
    fileA,
    expect.objectContaining({
      options: expect.objectContaining({
        page: 2,
        pageSize: ALL_RECORDS_CHUNK_SIZE,
        skipCount: true,
      }),
    }),
    { signal: expect.any(AbortSignal) },
  );

  await act(async () => {
    resolvePage2({ data: makeRows(101, ALL_RECORDS_CHUNK_SIZE), count: null });
  });
  expect(latest.records).toHaveLength(200);
  expect(latest.isLoadingMore).toBe(false);

  // Page 3 returns 50 rows -> reaches count (250) and is a short chunk -> stops.
  await act(async () => {
    latest.loadMore();
  });
  expect(latest.records).toHaveLength(250);
  expect(latest.boundReachedWithMore).toBe(false);

  // Further loadMore calls do nothing.
  await act(async () => {
    latest.loadMore();
  });
  expect(fetchPage).toHaveBeenCalledTimes(3);
});

test("stops when a chunk is short even when count is unknown", async () => {
  const fetchPage = vi.fn(async (_file: DatabaseHandle, query: TestQuery) => {
    const page = query.options.page ?? 1;
    if (page === 1) return { data: makeRows(1, 100), count: null };
    return { data: makeRows(101, 40), count: null };
  });

  await mount({ fetchPage });
  await act(async () => latest.loadMore());
  expect(latest.records).toHaveLength(140);
  expect(latest.boundReachedWithMore).toBe(false);
  await act(async () => latest.loadMore());
  expect(fetchPage).toHaveBeenCalledTimes(2);
});

test("resets accumulated rows on query, mode, and collection generation change, and ignores page/pageSize changes in All mode", async () => {
  const fetchPage = vi.fn(async (_file: DatabaseHandle, query: TestQuery) => {
    const page = query.options.page ?? 1;
    return {
      data: makeRows((page - 1) * 100 + 1, 100, query.filter || "base"),
      count: 500,
    };
  });

  const q1 = makeQuery({ filter: "a", options: { page: 1, pageSize: 25 } });
  await mount({ fetchPage, query: q1, mode: "all", generation: "g1" });
  await act(async () => latest.loadMore());
  expect(latest.records).toHaveLength(200);
  expect(fetchPage).toHaveBeenCalledTimes(2);

  // Changing page/pageSize in All mode does not change identity or discard loaded chunks.
  await mount({
    fetchPage,
    query: makeQuery({ filter: "a", options: { page: 3, pageSize: 50 } }),
    mode: "all",
    generation: "g1",
  });
  expect(latest.records).toHaveLength(200);
  expect(fetchPage).toHaveBeenCalledTimes(2);

  // Filter change resets to first chunk.
  await mount({
    fetchPage,
    query: makeQuery({ filter: "b" }),
    mode: "all",
    generation: "g1",
  });
  expect(latest.records).toHaveLength(100);
  expect(latest.records[0].label).toBe("b-1");

  // Load page 2, then bump generation -> resets to first chunk.
  await act(async () => latest.loadMore());
  expect(latest.records).toHaveLength(200);
  await mount({
    fetchPage,
    query: makeQuery({ filter: "b" }),
    mode: "all",
    generation: "g2",
  });
  expect(latest.records).toHaveLength(100);

  // Switch to paged mode -> uses query's pageSize/page.
  await mount({
    fetchPage,
    query: makeQuery({ filter: "b", options: { page: 1, pageSize: 25 } }),
    mode: "paged",
    generation: "g2",
  });
  expect(fetchPage).toHaveBeenLastCalledWith(
    fileA,
    expect.objectContaining({
      options: expect.objectContaining({ page: 1, pageSize: 25, skipCount: false }),
    }),
    { signal: expect.any(AbortSignal) },
  );
});

test("aborts in-flight chunk on identity change and unmount, and drops superseded result and rejection", async () => {
  const signals: AbortSignal[] = [];
  let resolveStale!: (value: QueryResponse<Row[]>) => void;
  let rejectStale!: (error: unknown) => void;

  const fetchPage = vi.fn(
    async (
      _file: DatabaseHandle,
      query: TestQuery,
      { signal }: { signal: AbortSignal },
    ): Promise<QueryResponse<Row[]>> => {
      signals.push(signal);
      const page = query.options.page ?? 1;
      if (query.filter === "first" && page === 2) {
        // Intentionally ignore abort to verify the epoch/identity discriminator drops it.
        return await new Promise((resolve) => {
          resolveStale = resolve;
        });
      }
      if (query.filter === "second" && page === 2) {
        return await new Promise((_resolve, reject) => {
          rejectStale = reject;
        });
      }
      return { data: makeRows(1, 100, query.filter || "ok"), count: 300 };
    },
  );

  await mount({ fetchPage, query: makeQuery({ filter: "first" }), mode: "all" });
  await act(async () => latest.loadMore());
  expect(signals[1].aborted).toBe(false);

  // Identity change aborts chunk 2 of "first" and starts "second".
  await mount({ fetchPage, query: makeQuery({ filter: "second" }), mode: "all" });
  expect(signals[1].aborted).toBe(true);

  // Stale resolve from "first" page 2 is dropped.
  await act(async () => {
    resolveStale({ data: makeRows(101, 100, "stale"), count: null });
  });
  expect(latest.records).toHaveLength(100);
  expect(latest.records[0].label).toBe("second-1");

  // Start page 2 of "second", then switch file -> aborts and drops stale rejection.
  await act(async () => latest.loadMore());
  const secondChunkSignal = signals[signals.length - 1];
  expect(secondChunkSignal.aborted).toBe(false);

  await mount({ fetchPage, file: fileB, query: makeQuery({ filter: "second" }), mode: "all" });
  expect(secondChunkSignal.aborted).toBe(true);

  await act(async () => {
    rejectStale(new Error("stale failure"));
  });
  expect(latest.error).toBeUndefined();
  expect(latest.records).toHaveLength(100);

  // Start a chunk on fileB, then unmount -> aborts it.
  let unmountSignal!: AbortSignal;
  fetchPage.mockImplementationOnce(async (_f, _q, { signal }) => {
    unmountSignal = signal;
    return await new Promise(() => {});
  });
  await act(async () => latest.loadMore());
  expect(unmountSignal.aborted).toBe(false);
  await act(async () => root.unmount());
  expect(unmountSignal.aborted).toBe(true);
});

test("CR-1: refresh during an in-flight later chunk aborts it and drops its stale result and rejection", async () => {
  let chunk2Signal!: AbortSignal;
  let resolveChunk2!: (value: QueryResponse<Row[]>) => void;
  let rejectChunk2!: (error: unknown) => void;
  let firstChunkVersion = 1;

  const fetchPage = vi.fn(
    async (
      _file: DatabaseHandle,
      query: TestQuery,
      { signal }: { signal: AbortSignal },
    ): Promise<QueryResponse<Row[]>> => {
      const page = query.options.page ?? 1;
      if (page === 1) {
        return { data: makeRows(1, 100, `v${firstChunkVersion}`), count: 300 };
      }
      chunk2Signal = signal;
      return await new Promise((resolve, reject) => {
        resolveChunk2 = resolve;
        rejectChunk2 = reject;
      });
    },
  );

  await mount({ fetchPage, mode: "all" });
  expect(latest.records[0].label).toBe("v1-1");

  // Start chunk 2 under epoch 1.
  await act(async () => latest.loadMore());
  expect(latest.isLoadingMore).toBe(true);
  expect(chunk2Signal.aborted).toBe(false);

  // Trigger refreshDatabaseGameQueries while chunk 2 is in flight.
  firstChunkVersion = 2;
  await act(async () => {
    await refreshAll();
  });
  expect(chunk2Signal.aborted).toBe(true);
  expect(latest.records).toHaveLength(100);
  expect(latest.records[0].label).toBe("v2-1");

  // Stale chunk 2 resolves after refresh -> dropped, does not append stale rows.
  await act(async () => {
    resolveChunk2({ data: makeRows(101, 100, "v1-stale"), count: null });
  });
  expect(latest.records).toHaveLength(100);
  expect(latest.records[0].label).toBe("v2-1");

  // Repeat for a stale rejection after refresh.
  await act(async () => latest.loadMore());
  const staleRejectSignal = chunk2Signal;
  firstChunkVersion = 3;
  await act(async () => {
    await refreshAll();
  });
  expect(staleRejectSignal.aborted).toBe(true);
  await act(async () => {
    rejectChunk2(new Error("stale chunk failure"));
  });
  expect(latest.error).toBeUndefined();
  expect(latest.records).toHaveLength(100);
  expect(latest.records[0].label).toBe("v3-1");
});

test("refresh after settled later chunks discards accumulated chunks and restarts from the fresh first chunk", async () => {
  let version = 1;
  const fetchPage = vi.fn(async (_file: DatabaseHandle, query: TestQuery) => {
    const page = query.options.page ?? 1;
    return {
      data: makeRows((page - 1) * 100 + 1, 100, `v${version}`),
      count: page === 1 ? 300 : null,
    };
  });

  await mount({ fetchPage, mode: "all" });
  await act(async () => latest.loadMore());
  expect(latest.records).toHaveLength(200);
  expect(latest.records[0].label).toBe("v1-1");

  version = 2;
  await act(async () => {
    await refreshAll();
  });
  expect(latest.records).toHaveLength(100);
  expect(latest.records[0].label).toBe("v2-1");
});

test("CR-2: first-chunk failure does not retry automatically and Retry reloads it", async () => {
  vi.useFakeTimers();
  const fetchPage = vi
    .fn()
    .mockRejectedValueOnce(new Error("disk failed"))
    .mockResolvedValueOnce({ data: makeRows(1, 50), count: 50 });

  await mount({ fetchPage, mode: "all" });
  expect(fetchPage).toHaveBeenCalledTimes(1);
  expect(latest.records).toEqual([]);
  expect(latest.error).toBeInstanceOf(Error);

  // Advance timers well past SWR's default 5s error retry interval -> no automatic retry.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_000);
  });
  expect(fetchPage).toHaveBeenCalledTimes(1);

  // Explicit Retry reloads the first chunk.
  await act(async () => {
    latest.retry();
  });
  expect(fetchPage).toHaveBeenCalledTimes(2);
  expect(latest.records).toHaveLength(50);
  expect(latest.error).toBeUndefined();
});

test("later-chunk failure keeps loaded rows, does not auto-retry, and Retry loads that chunk; cancellation is not a failure", async () => {
  const fetchPage = vi
    .fn()
    .mockResolvedValueOnce({ data: makeRows(1, 100), count: 250 })
    .mockRejectedValueOnce(new DOMException("Cancellation", "AbortError"))
    .mockRejectedValueOnce(new Error("chunk failed"))
    .mockResolvedValueOnce({ data: makeRows(101, 100), count: null });

  await mount({ fetchPage, mode: "all" });
  expect(latest.records).toHaveLength(100);

  // Cancellation does not surface as a failure.
  await act(async () => latest.loadMore());
  expect(latest.error).toBeUndefined();
  expect(latest.records).toHaveLength(100);

  // Real failure keeps loaded rows and surfaces error.
  await act(async () => latest.loadMore());
  expect(latest.records).toHaveLength(100);
  expect(latest.error).toBeInstanceOf(Error);

  // Calling loadMore (e.g. from scroll) does not auto-retry while error is shown.
  await act(async () => latest.loadMore());
  expect(fetchPage).toHaveBeenCalledTimes(3);

  // Explicit Retry loads page 2.
  await act(async () => latest.retry());
  expect(fetchPage).toHaveBeenCalledTimes(4);
  expect(latest.records).toHaveLength(200);
  expect(latest.error).toBeUndefined();
});

test("automatically fills a short viewport until content exceeds it, and skips hidden viewports", async () => {
  const fetchPage = vi.fn(async (_file: DatabaseHandle, query: TestQuery) => {
    const page = query.options.page ?? 1;
    return { data: makeRows((page - 1) * 100 + 1, 100), count: 300 };
  });

  // Hidden tab (clientHeight: 0) does not auto-load page 2.
  await mount({
    fetchPage,
    mode: "all",
    viewport: { clientHeight: 0, scrollHeight: 0, scrollTop: 0 },
  });
  expect(fetchPage).toHaveBeenCalledTimes(1);

  // Visible short viewport (scrollHeight <= clientHeight) auto-loads until all 300 rows are loaded.
  fetchPage.mockClear();
  await mount({
    fetchPage,
    query: makeQuery({ filter: "visible" }),
    mode: "all",
    viewport: { clientHeight: 500, scrollHeight: 300, scrollTop: 0 },
  });
  expect(latest.records).toHaveLength(300);
  expect(fetchPage).toHaveBeenCalledTimes(3);
});

test("stops at 10,000 rows and sets boundReachedWithMore only when rows remain", async () => {
  let totalCount: number | null = ALL_RECORDS_MAX_ROWS;
  const fetchPage = vi.fn(async (_file: DatabaseHandle, query: TestQuery) => {
    const page = query.options.page ?? 1;
    return {
      data: makeRows((page - 1) * ALL_RECORDS_CHUNK_SIZE + 1, ALL_RECORDS_CHUNK_SIZE),
      count: page === 1 ? totalCount : null,
    };
  });

  // Case 1: exact 10,000 rows -> bound reached, no rows remain -> boundReachedWithMore is false.
  await mount({
    fetchPage,
    mode: "all",
    viewport: { clientHeight: 500, scrollHeight: 200, scrollTop: 0 },
  });
  expect(latest.records).toHaveLength(ALL_RECORDS_MAX_ROWS);
  expect(latest.boundReachedWithMore).toBe(false);
  const callsAtExactBound = fetchPage.mock.calls.length;
  await act(async () => latest.loadMore());
  expect(fetchPage).toHaveBeenCalledTimes(callsAtExactBound);

  // Case 2: 10,001 rows -> bound reached, rows remain -> boundReachedWithMore is true.
  totalCount = ALL_RECORDS_MAX_ROWS + 1;
  await mount({
    fetchPage,
    query: makeQuery({ filter: "more" }),
    mode: "all",
    viewport: { clientHeight: 500, scrollHeight: 200, scrollTop: 0 },
  });
  expect(latest.records).toHaveLength(ALL_RECORDS_MAX_ROWS);
  expect(latest.boundReachedWithMore).toBe(true);
  const callsOverBound = fetchPage.mock.calls.length;
  await act(async () => latest.loadMore());
  expect(fetchPage).toHaveBeenCalledTimes(callsOverBound);

  // Case 3: unknown count (null) -> boundReachedWithMore is true.
  totalCount = null;
  await mount({
    fetchPage,
    query: makeQuery({ filter: "unknown" }),
    mode: "all",
    viewport: { clientHeight: 500, scrollHeight: 200, scrollTop: 0 },
  });
  expect(latest.records).toHaveLength(ALL_RECORDS_MAX_ROWS);
  expect(latest.boundReachedWithMore).toBe(true);
});

test("same-epoch cancellation in a short viewport does not trigger another automatic load", async () => {
  const fetchPage = vi
    .fn()
    .mockResolvedValueOnce({ data: makeRows(1, ALL_RECORDS_CHUNK_SIZE), count: 300 })
    .mockRejectedValueOnce(new DOMException("Cancellation", "AbortError"))
    .mockImplementationOnce(() => new Promise(() => {}));

  await mount({
    fetchPage,
    mode: "all",
    viewport: { clientHeight: 500, scrollHeight: 300, scrollTop: 0 },
  });

  // Chunk 1 loaded, short-viewport auto-fill requested chunk 2, chunk 2 cancelled -> must stop.
  expect(fetchPage).toHaveBeenCalledTimes(2);
  expect(latest.error).toBeUndefined();
  expect(latest.isLoadingMore).toBe(false);
});

test("re-checks short-viewport auto-fill after an SWR cache hit revalidates with equal data", async () => {
  let resolveRevalidate!: (value: QueryResponse<Row[]>) => void;
  let page1Calls = 0;

  const fetchPage = vi.fn(
    async (_file: DatabaseHandle, query: TestQuery): Promise<QueryResponse<Row[]>> => {
      const page = query.options.page ?? 1;
      if (page === 1) {
        page1Calls += 1;
        if (page1Calls === 1) {
          return { data: makeRows(1, ALL_RECORDS_CHUNK_SIZE, "a"), count: 200 };
        }
        return await new Promise((resolve) => {
          resolveRevalidate = resolve;
        });
      }
      return { data: makeRows(101, ALL_RECORDS_CHUNK_SIZE, "a"), count: null };
    },
  );

  // Prime SWR cache with a tall viewport so only the first chunk (100 rows) is loaded.
  await mount({
    fetchPage,
    query: makeQuery({ filter: "a" }),
    mode: "all",
    viewport: { clientHeight: 200, scrollHeight: 1000, scrollTop: 0 },
  });
  expect(latest.records).toHaveLength(100);

  // Revalidate cached first chunk while the viewport is short (isValidating becomes true).
  fetchPage.mockClear();
  let pendingRevalidate!: Promise<unknown>;
  await act(async () => {
    pendingRevalidate = revalidateGames();
  });
  await mount({
    fetchPage,
    query: makeQuery({ filter: "a" }),
    mode: "all",
    viewport: { clientHeight: 500, scrollHeight: 300, scrollTop: 0 },
  });
  expect(fetchPage).toHaveBeenCalledTimes(1);
  expect(latest.records).toHaveLength(100);

  // Revalidation resolves with deeply equal data (SWR keeps the same `data` reference and only
  // flips `isValidating` to false): auto-fill must request page 2 once.
  await act(async () => {
    resolveRevalidate({ data: makeRows(1, ALL_RECORDS_CHUNK_SIZE, "a"), count: 200 });
    await pendingRevalidate;
  });
  expect(fetchPage).toHaveBeenCalledTimes(2);
  expect(latest.records).toHaveLength(200);
});

test("revalidation with equal data keeps loaded rows and continues loading from the next page", async () => {
  const fetchPage = vi.fn(async (_file: DatabaseHandle, query: TestQuery) => {
    const page = query.options.page ?? 1;
    return {
      data: makeRows((page - 1) * ALL_RECORDS_CHUNK_SIZE + 1, ALL_RECORDS_CHUNK_SIZE, "stable"),
      count: page === 1 ? 350 : null,
    };
  });

  await mount({ fetchPage, mode: "all" });
  await act(async () => latest.loadMore());
  expect(latest.records).toHaveLength(200);

  // Revalidate page 1 with deeply equal data: already-loaded rows must stay intact.
  await act(async () => {
    await revalidateGames();
  });
  expect(latest.records).toHaveLength(200);
  expect(latest.records[199].label).toBe("stable-200");

  // Loading more continues at page 3 (not page 2).
  await act(async () => latest.loadMore());
  expect(fetchPage).toHaveBeenLastCalledWith(
    fileA,
    expect.objectContaining({
      options: expect.objectContaining({
        page: 3,
        pageSize: ALL_RECORDS_CHUNK_SIZE,
        skipCount: true,
      }),
    }),
    { signal: expect.any(AbortSignal) },
  );
  expect(latest.records).toHaveLength(300);
});

test("revalidation with changed data discards accumulated later chunks", async () => {
  let version = 1;
  const fetchPage = vi.fn(async (_file: DatabaseHandle, query: TestQuery) => {
    const page = query.options.page ?? 1;
    return {
      data: makeRows(
        (page - 1) * ALL_RECORDS_CHUNK_SIZE + 1,
        ALL_RECORDS_CHUNK_SIZE,
        `v${version}`,
      ),
      count: page === 1 ? 300 : null,
    };
  });

  await mount({ fetchPage, mode: "all" });
  await act(async () => latest.loadMore());
  expect(latest.records).toHaveLength(200);

  version = 2;
  await act(async () => {
    await revalidateGames();
  });
  expect(latest.records).toHaveLength(100);
  expect(latest.records[0].label).toBe("v2-1");
});

test("revalidation while a later chunk is in flight aborts and drops that chunk without clearing loaded rows", async () => {
  let chunk3Signal!: AbortSignal;
  let resolveChunk3!: (value: QueryResponse<Row[]>) => void;
  let resolveRevalidate!: (value: QueryResponse<Row[]>) => void;
  let page1Calls = 0;

  const fetchPage = vi.fn(
    async (
      _file: DatabaseHandle,
      query: TestQuery,
      { signal }: { signal: AbortSignal },
    ): Promise<QueryResponse<Row[]>> => {
      const page = query.options.page ?? 1;
      if (page === 1) {
        page1Calls += 1;
        if (page1Calls === 1) {
          return { data: makeRows(1, ALL_RECORDS_CHUNK_SIZE, "keep"), count: 350 };
        }
        return await new Promise((resolve) => {
          resolveRevalidate = resolve;
        });
      }
      if (page === 2) {
        return { data: makeRows(101, ALL_RECORDS_CHUNK_SIZE, "keep"), count: null };
      }
      chunk3Signal = signal;
      return await new Promise((resolve) => {
        resolveChunk3 = resolve;
      });
    },
  );

  await mount({ fetchPage, mode: "all" });
  await act(async () => latest.loadMore());
  expect(latest.records).toHaveLength(200);

  // Start page 3 (in flight).
  await act(async () => latest.loadMore());
  expect(latest.isLoadingMore).toBe(true);
  expect(chunk3Signal.aborted).toBe(false);

  // Revalidate page 1 while page 3 is in flight: page 3 is aborted, loaded 200 rows remain.
  let pendingRevalidate!: Promise<unknown>;
  await act(async () => {
    pendingRevalidate = revalidateGames();
  });
  expect(chunk3Signal.aborted).toBe(true);
  expect(latest.isLoadingMore).toBe(false);
  expect(latest.records).toHaveLength(200);

  // Stale page 3 resolves anyway -> dropped; equal-data revalidation finishes -> 200 rows kept.
  await act(async () => {
    resolveChunk3({ data: makeRows(201, ALL_RECORDS_CHUNK_SIZE, "stale"), count: null });
    resolveRevalidate({ data: makeRows(1, ALL_RECORDS_CHUNK_SIZE, "keep"), count: 350 });
    await pendingRevalidate;
  });
  expect(latest.records).toHaveLength(200);
  expect(latest.records[199].label).toBe("keep-200");

  // Repeat for a stale non-cancellation rejection of an in-flight later chunk during equal-data
  // revalidation: error stays undefined, rows stay intact, and the next loadMore requests page 3.
  let rejectChunk3!: (cause: unknown) => void;
  let resolveRevalidate2!: (value: QueryResponse<Row[]>) => void;
  fetchPage.mockImplementation(async (_file: DatabaseHandle, query: TestQuery, { signal }) => {
    const page = query.options.page ?? 1;
    if (page === 1) {
      return await new Promise((resolve) => {
        resolveRevalidate2 = resolve;
      });
    }
    if (page === 3 && !rejectChunk3) {
      chunk3Signal = signal;
      return await new Promise((_resolve, reject) => {
        rejectChunk3 = reject;
      });
    }
    return { data: makeRows(201, ALL_RECORDS_CHUNK_SIZE, "keep"), count: null };
  });

  await act(async () => latest.loadMore());
  expect(latest.isLoadingMore).toBe(true);
  await act(async () => {
    pendingRevalidate = revalidateGames();
  });
  expect(chunk3Signal.aborted).toBe(true);
  await act(async () => {
    rejectChunk3(new Error("stale chunk 3 failed"));
    resolveRevalidate2({ data: makeRows(1, ALL_RECORDS_CHUNK_SIZE, "keep"), count: 350 });
    await pendingRevalidate;
  });
  expect(latest.error).toBeUndefined();
  expect(latest.records).toHaveLength(200);

  await act(async () => latest.loadMore());
  expect(fetchPage).toHaveBeenLastCalledWith(
    fileA,
    expect.objectContaining({
      options: expect.objectContaining({
        page: 3,
        pageSize: ALL_RECORDS_CHUNK_SIZE,
        skipCount: true,
      }),
    }),
    { signal: expect.any(AbortSignal) },
  );
  expect(latest.records).toHaveLength(300);
});

test("rejected first-chunk revalidation hides later chunks until Retry restores a consistent list", async () => {
  let page1Calls = 0;
  const fetchPage = vi.fn(async (_file: DatabaseHandle, query: TestQuery) => {
    const page = query.options.page ?? 1;
    if (page === 1) {
      page1Calls += 1;
      if (page1Calls === 1) {
        return { data: makeRows(1, ALL_RECORDS_CHUNK_SIZE, "v1"), count: 300 };
      }
      if (page1Calls === 2) {
        throw new Error("revalidation failed");
      }
      return { data: makeRows(1, ALL_RECORDS_CHUNK_SIZE, "v1"), count: 300 };
    }
    return { data: makeRows(101, ALL_RECORDS_CHUNK_SIZE, "v1"), count: null };
  });

  await mount({ fetchPage, mode: "all" });
  await act(async () => latest.loadMore());
  expect(latest.records).toHaveLength(200);

  // Revalidation rejects: must show zero rows (no orphaned 101..200) and surface the error.
  await act(async () => {
    await revalidateGames();
  });
  expect(latest.records).toEqual([]);
  expect(latest.count).toBeUndefined();
  expect(latest.error).toBeInstanceOf(Error);

  // Retry succeeds with equal data: restores consistent 200 rows without duplicates.
  await act(async () => {
    latest.retry();
  });
  expect(latest.error).toBeUndefined();
  expect(latest.records).toHaveLength(200);
  expect(latest.records[0].id).toBe(1);
  expect(latest.records[100].id).toBe(101);
  expect(new Set(latest.records.map((row) => row.id)).size).toBe(200);
});

test("debounces query and mode together as one snapshot when debounceMs is set", async () => {
  vi.useFakeTimers();
  const fetchPage = vi.fn(async (_file: DatabaseHandle, query: TestQuery) => ({
    data: makeRows(1, query.options.pageSize ?? 25),
    count: 200,
  }));

  await mount({
    fetchPage,
    query: makeQuery({ options: { page: 2, pageSize: 50 } }),
    mode: "paged",
    debounceMs: 250,
  });
  expect(fetchPage).toHaveBeenCalledTimes(1);
  fetchPage.mockClear();

  // Switch to "all" with page reset to 1: nothing fires before debounceMs, one request fires after.
  await mount({
    fetchPage,
    query: makeQuery({ options: { page: 1, pageSize: 50 } }),
    mode: "all",
    debounceMs: 250,
  });
  expect(fetchPage).not.toHaveBeenCalled();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(249);
  });
  expect(fetchPage).not.toHaveBeenCalled();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(fetchPage).toHaveBeenCalledTimes(1);

  // Switch back to paged with pageSize 10: again debounced together into one request.
  fetchPage.mockClear();
  await mount({
    fetchPage,
    query: makeQuery({ options: { page: 1, pageSize: 10 } }),
    mode: "paged",
    debounceMs: 250,
  });
  expect(fetchPage).not.toHaveBeenCalled();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250);
  });
  expect(fetchPage).toHaveBeenCalledTimes(1);
  expect(fetchPage).toHaveBeenLastCalledWith(
    fileA,
    expect.objectContaining({
      options: expect.objectContaining({ page: 1, pageSize: 10, skipCount: false }),
    }),
    { signal: expect.any(AbortSignal) },
  );
});

test("resets the scroll viewport to top in paged mode on identity change and defers All-mode resets to the windowing owner", async () => {
  const onScrollTo = vi.fn();
  const fetchPage = vi.fn(async (_file: DatabaseHandle, query: TestQuery) => ({
    data: makeRows(1, 25, query.filter || "a"),
    count: 200,
  }));

  await mount({
    fetchPage,
    query: makeQuery({ filter: "a" }),
    mode: "paged",
    onScrollTo,
  });
  onScrollTo.mockClear();

  await mount({
    fetchPage,
    query: makeQuery({ filter: "b" }),
    mode: "paged",
    onScrollTo,
  });
  expect(onScrollTo).toHaveBeenCalledExactlyOnceWith({ top: 0 });

  // In "All" mode useWindowedTableRows owns the reset via `identity`; useDatabaseListQuery
  // exposes a new identity without issuing a duplicate raw DOM scrollTo.
  onScrollTo.mockClear();
  await mount({
    fetchPage,
    query: makeQuery({ filter: "c" }),
    mode: "all",
    onScrollTo,
  });
  const firstAllIdentity = latest.identity;
  onScrollTo.mockClear();

  await mount({
    fetchPage,
    query: makeQuery({ filter: "d" }),
    mode: "all",
    onScrollTo,
  });
  expect(latest.identity).not.toBe(firstAllIdentity);
  expect(onScrollTo).not.toHaveBeenCalled();
});

test("recordsMode reflects the debounced mode that the currently held records belong to", async () => {
  vi.useFakeTimers();
  const fetchPage = vi.fn(async (_file: DatabaseHandle, query: TestQuery) => {
    const page = query.options.page ?? 1;
    const size = query.options.pageSize ?? 25;
    return {
      data: makeRows((page - 1) * size + 1, size),
      count: page === 1 ? 300 : null,
    };
  });

  await mount({ fetchPage, mode: "all", debounceMs: 250 });
  expect(latest.recordsMode).toBe("all");
  expect(latest.records).toHaveLength(100);
  await act(async () => latest.loadMore());
  expect(latest.records).toHaveLength(200);

  // Switch mode to paged: during the 250ms debounce window, records still hold the 200 "all" rows
  // so recordsMode stays "all" until the debounced snapshot settles.
  await mount({
    fetchPage,
    query: makeQuery({ options: { page: 1, pageSize: 25 } }),
    mode: "paged",
    debounceMs: 250,
  });
  expect(latest.records).toHaveLength(200);
  expect(latest.recordsMode).toBe("all");

  await act(async () => {
    await vi.advanceTimersByTimeAsync(250);
  });
  expect(latest.recordsMode).toBe("paged");
  expect(latest.records).toHaveLength(25);
});
