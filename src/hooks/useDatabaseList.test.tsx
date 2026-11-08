import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import useSWR, { SWRConfig, useSWRConfig, type ScopedMutator } from "swr";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { listingFailure } from "@/components/files/listingFailure";
import { type NativeRequestOwner, useNativeRequestOwner } from "@/hooks/useNativeRequestOwner";
import { getDatabases, type DatabaseList } from "@/utils/db";
import {
  DATABASE_LIST_KEY,
  DATABASE_LIST_MAX_RETRIES,
  fetchDatabaseList,
  refreshDatabaseList,
  revalidateDatabaseList,
  useDatabaseList,
} from "./useDatabaseList";

vi.mock("@/utils/db", () => ({ getDatabases: vi.fn() }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const ERROR_RETRY_INTERVAL_MS = 5000;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  vi.mocked(getDatabases).mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function render(ui: ReactNode) {
  await act(async () => {
    root.render(
      <SWRConfig
        value={{
          provider: () => new Map(),
          dedupingInterval: 0,
          errorRetryInterval: ERROR_RETRY_INTERVAL_MS,
          revalidateOnFocus: false,
          revalidateOnReconnect: false,
        }}
      >
        {ui}
      </SWRConfig>,
    );
  });
}

async function advance(ms: number) {
  await act(async () => vi.advanceTimersByTimeAsync(ms));
}

function Consumer({ enabled = true }: { enabled?: boolean }) {
  const { data, error } = useDatabaseList(enabled);
  return <output>{error ? "failed" : data ? "loaded" : "pending"}</output>;
}

test.each([
  { random: 0, multipliers: [1, 2, 4] },
  { random: 0.5, multipliers: [2, 4, 8] },
  { random: 0.999, multipliers: [2, 5, 11] },
])(
  "transient failures keep SWR's backoff and stop after three retries ($random)",
  async ({ random, multipliers }) => {
    vi.mocked(Math.random).mockReturnValue(random);
    const failure = new Error("Temporary database failure");
    expect(listingFailure(failure)).toBe("retry");
    vi.mocked(getDatabases).mockRejectedValue(failure);
    await render(<Consumer />);
    expect(getDatabases).toHaveBeenCalledTimes(1);
    await advance(2000);
    expect(getDatabases).toHaveBeenCalledTimes(1);

    for (let retryCount = 1; retryCount <= DATABASE_LIST_MAX_RETRIES; retryCount += 1) {
      const elapsed = retryCount === 1 ? 2000 : 0;
      await advance(ERROR_RETRY_INTERVAL_MS * multipliers[retryCount - 1] - elapsed - 1);
      expect(getDatabases).toHaveBeenCalledTimes(retryCount);
      await advance(1);
      expect(getDatabases).toHaveBeenCalledTimes(1 + retryCount);
    }

    await advance(600_000);
    expect(getDatabases).toHaveBeenCalledTimes(1 + DATABASE_LIST_MAX_RETRIES);
    expect(container.textContent).toBe("failed");
  },
);

test.each(["changed", "missing", "unusable", "permission", "too-large"] as const)(
  "a %s root failure is never retried",
  async (rootFailure) => {
    const failure = {
      tag: "backend-error",
      category: "io",
      message: "Database root unavailable",
      rootFailure,
    };
    expect(listingFailure(failure)).toBe(rootFailure === "too-large" ? "tooLarge" : rootFailure);
    vi.mocked(getDatabases).mockRejectedValue(failure);
    await render(<Consumer />);
    expect(getDatabases).toHaveBeenCalledTimes(1);
    await advance(60_000);
    expect(getDatabases).toHaveBeenCalledTimes(1);
  },
);

test.each([
  new DOMException("Cancellation", "AbortError"),
  { tag: "backend-error", category: "cancellation", message: "Cancellation" },
])("cancellation is never retried (%#)", async (failure) => {
  expect(listingFailure(failure)).toBe("silent");
  vi.mocked(getDatabases).mockRejectedValue(failure);
  await render(<Consumer />);
  expect(getDatabases).toHaveBeenCalledTimes(1);
  await advance(60_000);
  expect(getDatabases).toHaveBeenCalledTimes(1);
});

test("superseding a pending listing never retries its cancellation", async () => {
  let owner: NativeRequestOwner | null = null;
  function OwnedConsumer() {
    const swr = useDatabaseList();
    owner = swr.owner;
    return <output>{swr.error ? "superseded" : "pending"}</output>;
  }
  vi.mocked(getDatabases).mockImplementation(() => new Promise(() => {}));
  await render(<OwnedConsumer />);
  expect(getDatabases).toHaveBeenCalledTimes(1);
  const signal = vi.mocked(getDatabases).mock.calls[0][0]?.signal;
  await act(async () => owner!.supersede());
  expect(signal?.aborted).toBe(true);
  expect(container.textContent).toBe("superseded");
  await advance(60_000);
  expect(getDatabases).toHaveBeenCalledTimes(1);
});

test("a disabled subscription makes no request", async () => {
  vi.mocked(getDatabases).mockResolvedValue({
    databases: [],
    unread: [],
    root: { id: { id: "listing-test-root" }, kind: "databaseRoot" as const },
  });
  await render(<Consumer enabled={false} />);
  await advance(60_000);
  expect(getDatabases).not.toHaveBeenCalled();
  expect(container.textContent).toBe("pending");
});

test("a consumer reading only isLoading observes completion", async () => {
  let resolve!: (value: Awaited<ReturnType<typeof getDatabases>>) => void;
  vi.mocked(getDatabases).mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  function LoadingConsumer() {
    const { isLoading } = useDatabaseList();
    return <output>{isLoading ? "loading" : "settled"}</output>;
  }
  await render(<LoadingConsumer />);
  expect(container.textContent).toBe("loading");
  await act(async () =>
    resolve({
      databases: [],
      unread: [],
      root: { id: { id: "listing-test-root" }, kind: "databaseRoot" },
    }),
  );
  expect(container.textContent).toBe("settled");
});

test("a consumer reading only error observes failure", async () => {
  let reject!: (reason: unknown) => void;
  vi.mocked(getDatabases).mockImplementation(
    () =>
      new Promise((_done, fail) => {
        reject = fail;
      }),
  );
  function ErrorConsumer() {
    const { error } = useDatabaseList();
    return <output>{error ? "failed" : "pending"}</output>;
  }
  await render(<ErrorConsumer />);
  expect(container.textContent).toBe("pending");
  await act(async () => reject(new Error("Database failure")));
  expect(container.textContent).toBe("failed");
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function list(rootId: string): DatabaseList {
  return {
    databases: [],
    unread: [],
    root: { id: { id: rootId }, kind: "databaseRoot" },
  };
}

test.each(["ready", "upgradeFailed", "empty"] as const)(
  "revalidates transient rows every 3 seconds across subscribers and stops at %s",
  async (terminal) => {
    const row = {
      type: "error" as const,
      file: { id: { id: "held" }, kind: "database" as const },
      filename: "held.db3",
      indexed: false,
      error: "Transient explanation",
    };
    const upgrading: DatabaseList = {
      ...list("root"),
      databases: [{ ...row, transient: "upgrading" }],
    };
    const busy: DatabaseList = { ...upgrading, databases: [{ ...row, transient: "busy" }] };
    const settled: DatabaseList = {
      ...upgrading,
      databases:
        terminal === "empty"
          ? []
          : terminal === "upgradeFailed"
            ? [{ ...row, upgradeFailed: true }]
            : [
                {
                  type: "success",
                  file: row.file,
                  filename: row.filename,
                  title: "Ready",
                  description: "",
                  indexed: false,
                  game_count: 1,
                  player_count: 2,
                  event_count: 1,
                  storage_size: "1",
                },
              ],
    };
    vi.mocked(getDatabases)
      .mockResolvedValueOnce(upgrading)
      .mockResolvedValueOnce(busy)
      .mockResolvedValue(settled);
    await render(
      <>
        <Consumer />
        <Consumer />
      </>,
    );
    expect(getDatabases).toHaveBeenCalledTimes(1);
    await advance(2999);
    expect(getDatabases).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(getDatabases).toHaveBeenCalledTimes(2);
    await advance(2999);
    expect(getDatabases).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(getDatabases).toHaveBeenCalledTimes(3);
    await advance(60_000);
    expect(getDatabases).toHaveBeenCalledTimes(3);
  },
);

test("transient polling never overlaps a slow read and stops after final unsubscribe", async () => {
  const held = deferred<DatabaseList>();
  const upgrading: DatabaseList = {
    ...list("root"),
    databases: [
      {
        type: "error",
        file: { id: { id: "held" }, kind: "database" },
        filename: "held.db3",
        error: "Upgrading",
        indexed: false,
        transient: "upgrading",
      },
    ],
  };
  vi.mocked(getDatabases).mockResolvedValueOnce(upgrading).mockReturnValue(held.promise);
  await render(<Consumer />);
  await advance(3000);
  expect(getDatabases).toHaveBeenCalledTimes(2);
  const signal = vi.mocked(getDatabases).mock.calls[1][0]?.signal;
  await advance(30_000);
  expect(getDatabases).toHaveBeenCalledTimes(2);
  expect(signal?.aborted).toBe(false);
  await act(async () => root.render(null));
  expect(signal?.aborted).toBe(true);
  await act(async () => held.resolve(upgrading));
  await advance(30_000);
  expect(getDatabases).toHaveBeenCalledTimes(2);
});

test("polling restarts when a later cache update introduces a transient row", async () => {
  let publish!: (value: DatabaseList) => Promise<unknown>;
  function UpdatingConsumer() {
    const { mutate } = useSWRConfig();
    publish = (value) => mutate(DATABASE_LIST_KEY, value, { revalidate: false });
    return <Consumer />;
  }
  vi.mocked(getDatabases).mockResolvedValue(list("root"));
  await render(<UpdatingConsumer />);
  await advance(30_000);
  expect(getDatabases).toHaveBeenCalledTimes(1);
  const transient: DatabaseList = {
    ...list("root"),
    databases: [
      {
        type: "error",
        file: { id: { id: "held" }, kind: "database" },
        filename: "held.db3",
        indexed: false,
        transient: "upgrading",
        error: "Upgrading",
      },
    ],
  };
  await act(async () => publish(transient));
  await advance(2999);
  expect(getDatabases).toHaveBeenCalledTimes(1);
  await advance(1);
  expect(getDatabases).toHaveBeenCalledTimes(2);
  await advance(30_000);
  expect(getDatabases).toHaveBeenCalledTimes(2);
});

async function writeRefreshHarness() {
  const cache = new Map();
  let owner!: NativeRequestOwner;
  let mutate!: ScopedMutator;
  const entryErrors: unknown[] = [];
  function OwnedList() {
    const nativeOwner = useNativeRequestOwner(DATABASE_LIST_KEY)!;
    mutate = useSWRConfig().mutate;
    owner = {
      ...nativeOwner,
      run: (request) => {
        // Observe synchronous entry, before run schedules the request body in a microtask.
        entryErrors.push(cache.get(DATABASE_LIST_KEY)?.error);
        return nativeOwner.run(request);
      },
    };
    const { data, error } = useSWR(DATABASE_LIST_KEY, () => fetchDatabaseList(owner));
    return <output>{error ? "failed" : data ? "loaded" : "pending"}</output>;
  }
  await act(async () => {
    root.render(
      <SWRConfig
        value={{
          provider: () => cache,
          dedupingInterval: 0,
          shouldRetryOnError: false,
          revalidateOnFocus: false,
          revalidateOnReconnect: false,
        }}
      >
        <OwnedList />
      </SWRConfig>,
    );
  });
  return {
    cache,
    entryErrors,
    refresh: (helper: typeof refreshDatabaseList) => helper(owner, mutate),
  };
}

test.each([
  { name: "refreshDatabaseList", helper: refreshDatabaseList },
  { name: "revalidateDatabaseList", helper: revalidateDatabaseList },
])("$name retires a pending listing before entering the new owned read", async ({ helper }) => {
  const old = deferred<DatabaseList>();
  const freshRead = deferred<DatabaseList>();
  const revalidation = deferred<DatabaseList>();
  const fresh = list("fresh");
  vi.mocked(getDatabases)
    .mockReturnValueOnce(old.promise)
    .mockReturnValueOnce(freshRead.promise)
    .mockReturnValueOnce(revalidation.promise);
  const { cache, entryErrors, refresh } = await writeRefreshHarness();
  expect(getDatabases).toHaveBeenCalledOnce();

  let refreshed!: Promise<unknown>;
  await act(async () => {
    refreshed = refresh(helper);
    await Promise.resolve();
  });
  // These assertions precede awaiting the helper so a rejoin fails without deadlocking.
  expect(getDatabases).toHaveBeenCalledTimes(2);
  expect(entryErrors[1]).toMatchObject({ name: "AbortError", message: "Cancellation" });
  const cancellation = entryErrors[1];

  await act(async () => freshRead.resolve(fresh));
  expect(getDatabases).toHaveBeenCalledTimes(helper === refreshDatabaseList ? 3 : 2);
  if (helper === refreshDatabaseList) {
    await act(async () => revalidation.resolve(fresh));
  }
  await expect(refreshed).resolves.toEqual(fresh);
  await act(async () => old.resolve(list("stale")));
  expect(cache.get(DATABASE_LIST_KEY)?.data).toEqual(fresh);
  expect(cache.get(DATABASE_LIST_KEY)?.error).toBeUndefined();
  expect(cache.get(DATABASE_LIST_KEY)?.error).not.toBe(cancellation);
});

test("revalidateDatabaseList fulfills with its fetcher failure recorded in cache", async () => {
  const failure = new Error("post-write listing failed");
  vi.mocked(getDatabases).mockResolvedValueOnce(list("initial")).mockRejectedValue(failure);
  const { cache, refresh } = await writeRefreshHarness();
  await act(async () => {
    await expect(refresh(revalidateDatabaseList)).resolves.toEqual(list("initial"));
  });
  expect(cache.get(DATABASE_LIST_KEY)?.error).toBe(failure);
});

test("refreshDatabaseList propagates a rejected owned read", async () => {
  const failure = new Error("owned listing failed");
  vi.mocked(getDatabases).mockResolvedValueOnce(list("initial")).mockRejectedValue(failure);
  const { refresh } = await writeRefreshHarness();
  await act(async () => {
    await expect(refresh(refreshDatabaseList)).rejects.toBe(failure);
  });
});
