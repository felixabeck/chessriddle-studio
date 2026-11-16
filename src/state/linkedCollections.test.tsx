import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import useSWR, { SWRConfig } from "swr";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { CollectionDescriptor, DatabaseHandle } from "@/bindings";
import { recordDatabaseWrite } from "@/platform/databaseWrites";
import { registerCollectionCheck, startFileRevisionPoll } from "./fileFreshness";
import {
  isCollectionConsumer,
  useCollectionCurrencies,
  useCollectionCurrency,
  useDatabaseContentRevision,
} from "./linkedCollections";

const mocks = vi.hoisted(() => ({ read: vi.fn(), rebuild: vi.fn() }));
vi.mock("@/platform/tauri", () => ({
  tauri: { collectionForDatabase: mocks.read, rebuildLinkedCollection: mocks.rebuild },
}));
const handle: DatabaseHandle = { id: { id: "linked-cache" }, kind: "database" };
const collection: CollectionDescriptor = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "Games",
  file: { id: { id: "source" }, kind: "fileWorkspace" },
  database: handle,
  account: null,
  status: "ready",
  generation: "first",
  omitted: 0,
  retiredDatabase: null,
  fetchSinceMs: null,
};
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let stop: () => void;
let focus: () => void;

function Consumer({ file = handle }: { file?: DatabaseHandle | null }) {
  const state = useCollectionCurrency(file);
  return (
    <output>
      {state.pending
        ? "pending"
        : state.error
          ? "error"
          : (state.collection?.generation ?? "standalone")}
    </output>
  );
}

const dataKeys = [
  "databases",
  ["file-workspace", collection.file],
  ["games", handle, {}],
  ["players", handle, {}],
  ["tournaments", handle, {}],
  ["personalDatabases", []],
  ["personalInfo", "Player", []],
] as const;

function DataConsumer({
  dataKey,
  fetcher,
}: {
  dataKey: (typeof dataKeys)[number];
  fetcher: () => Promise<string>;
}) {
  const { data } = useSWR(dataKey, fetcher);
  return <output data-collection-data>{data ?? "loading"}</output>;
}

function CollectionList({ values }: { values: CollectionDescriptor[] }) {
  useCollectionCurrencies(values);
  return null;
}

function CurrencyObserver({
  file,
  changed,
}: {
  file: DatabaseHandle;
  changed: (error: unknown) => void;
}) {
  const state = useCollectionCurrency(file);
  // Matches the existing repertoire effect's error dependency.
  useEffect(() => changed(state.error), [state.error, changed]);
  return <output>{state.error ? "error" : state.collection?.generation}</output>;
}

test("currency error identities belong to each subscription and reset after recovery or reference replacement", async () => {
  const other: DatabaseHandle = { id: { id: "other-reference" }, kind: "database" };
  const first = vi.fn();
  const second = vi.fn();
  const independent = vi.fn();
  const errors: Error[] = [];
  let failing = true;
  mocks.read.mockImplementation(async (file: DatabaseHandle) => {
    if (failing) {
      const error = new Error("metadata unavailable");
      errors.push(error);
      throw error;
    }
    return { ...collection, database: file };
  });
  const renderObservers = async (file = handle, showFirst = true) => {
    await act(async () =>
      root.render(
        <>
          <CollectionList values={[collection]} />
          {showFirst && <CurrencyObserver file={file} changed={first} />}
          <CurrencyObserver file={handle} changed={second} />
          <CurrencyObserver file={other} changed={independent} />
        </>,
      ),
    );
    await flush();
  };
  await renderObservers();
  expect(mocks.read).toHaveBeenCalledTimes(2);
  const firstError = first.mock.lastCall![0];
  const otherError = independent.mock.lastCall![0];
  expect(firstError).toBeInstanceOf(Error);
  expect(second.mock.lastCall![0]).toBe(firstError);
  expect(otherError).not.toBe(firstError);
  const counts = [first.mock.calls.length, second.mock.calls.length, independent.mock.calls.length];
  await act(async () => vi.advanceTimersByTimeAsync(4_000));
  await flush();
  expect(errors).toHaveLength(6);
  expect(new Set(errors).size).toBe(6);
  expect([
    first.mock.calls.length,
    second.mock.calls.length,
    independent.mock.calls.length,
  ]).toEqual(counts);
  expect(first.mock.lastCall![0]).toBe(firstError);
  expect(second.mock.lastCall![0]).toBe(firstError);
  expect(independent.mock.lastCall![0]).toBe(otherError);

  // Replacing one subscriber's identity cannot reset another's ongoing outage.
  await renderObservers(other);
  expect(first.mock.lastCall![0]).not.toBe(firstError);
  expect(first.mock.lastCall![0]).not.toBe(otherError);
  expect(second.mock.lastCall![0]).toBe(firstError);
  expect(independent.mock.lastCall![0]).toBe(otherError);
  await renderObservers(other, false);
  failing = false;
  await act(async () => focus());
  await flush();
  expect(second.mock.lastCall![0]).toBeUndefined();
  expect(independent.mock.lastCall![0]).toBeUndefined();
  failing = true;
  await act(async () => focus());
  await flush();
  const secondOutage = second.mock.lastCall![0];
  expect(secondOutage).toBeInstanceOf(Error);
  expect(secondOutage).not.toBe(firstError);
  expect(independent.mock.lastCall![0]).not.toBe(otherError);
  const settled = [second.mock.calls.length, independent.mock.calls.length];
  await act(async () => focus());
  await flush();
  expect([second.mock.calls.length, independent.mock.calls.length]).toEqual(settled);
  await act(async () => root.render(null));
  const reads = mocks.read.mock.calls.length;
  await act(async () => focus());
  await flush();
  expect(mocks.read).toHaveBeenCalledTimes(reads);
});

test("list summaries and individual references share currency checks and all composed data keys", async () => {
  await act(async () =>
    root.render(
      <>
        <CollectionList values={[collection]} />
        <Consumer />
      </>,
    ),
  );
  await flush();
  expect(mocks.read).toHaveBeenCalledOnce();
  await act(async () =>
    root.render(
      <>
        <CollectionList values={[]} />
        <Consumer />
      </>,
    ),
  );
  for (const key of [
    "databases",
    ["file-workspace"],
    ["games"],
    ["players"],
    ["tournaments"],
    ["personalDatabases"],
    ["personalInfo"],
  ])
    expect(isCollectionConsumer(key)).toBe(true);
  expect(isCollectionConsumer(["unrelated"])).toBe(false);
  expect(isCollectionConsumer(null)).toBe(false);
});

async function flush() {
  await act(async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve();
  });
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  mocks.read.mockReset().mockResolvedValue(collection);
  mocks.rebuild.mockReset().mockResolvedValue(collection);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  stop = startFileRevisionPoll({
    getTabs: () => [],
    fileRevision: vi.fn(),
    subscribeFocus: (callback) => {
      focus = callback;
      return () => undefined;
    },
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  stop();
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test.each(["list", "reference"])(
  "mounted %s currency revalidates displayed SWR data on the root clock and focus",
  async (owner) => {
    let nativeData = "first data";
    const fetcher = vi.fn(async () => nativeData);
    await act(async () =>
      root.render(
        <SWRConfig
          value={{
            provider: () => new Map(),
            shouldRetryOnError: false,
            dedupingInterval: 0,
            revalidateOnFocus: false,
            revalidateOnReconnect: false,
          }}
        >
          {owner === "list" ? (
            <CollectionList values={[collection]} />
          ) : (
            <>
              <Consumer />
              <Consumer />
            </>
          )}
          {dataKeys.map((dataKey, index) => (
            <DataConsumer key={index} dataKey={dataKey} fetcher={fetcher} />
          ))}
        </SWRConfig>,
      ),
    );
    await flush();
    expect(mocks.read).toHaveBeenCalledTimes(1);
    const displayed = () =>
      Array.from(host.querySelectorAll("[data-collection-data]"), (node) => node.textContent);
    expect(displayed()).toEqual(dataKeys.map(() => "first data"));
    nativeData = "second data";
    mocks.read.mockResolvedValue({ ...collection, generation: "second" });
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    await flush();
    expect(displayed()).toEqual(dataKeys.map(() => "second data"));
    expect(mocks.read).toHaveBeenCalledTimes(2);
    nativeData = "unavailable data";
    mocks.read.mockResolvedValue({ ...collection, status: "unavailable" });
    await act(async () => focus());
    await flush();
    expect(mocks.read).toHaveBeenCalledTimes(3);
    expect(displayed()).toEqual(dataKeys.map(() => "unavailable data"));
    nativeData = "failed check data";
    mocks.read.mockImplementation(async () => {
      throw new Error("fresh error each poll");
    });
    await act(async () => focus());
    await flush();
    expect(displayed()).toEqual(dataKeys.map(() => "failed check data"));
    const failedFetches = fetcher.mock.calls.length;
    nativeData = "must wait for a transition";
    await act(async () => focus());
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(failedFetches);
    expect(displayed()).toEqual(dataKeys.map(() => "failed check data"));
    nativeData = "missing collection data";
    mocks.read.mockResolvedValue(null);
    await act(async () => focus());
    await flush();
    expect(displayed()).toEqual(dataKeys.map(() => "missing collection data"));
    nativeData = "recovered data";
    mocks.read.mockResolvedValue(collection);
    await act(async () => focus());
    await flush();
    expect(displayed()).toEqual(dataKeys.map(() => "recovered data"));
    nativeData = "second outage data";
    mocks.read.mockRejectedValue(new Error("new outage"));
    await act(async () => focus());
    await flush();
    expect(displayed()).toEqual(dataKeys.map(() => "second outage data"));
  },
);

test("ordinary unlinked databases keep composed consumers current until linked metadata appears", async () => {
  mocks.read.mockResolvedValue(null);
  let nativeData = "initial data";
  const fetchers = dataKeys.map(() => vi.fn(async () => nativeData));
  await act(async () =>
    root.render(
      <SWRConfig
        value={{
          provider: () => new Map(),
          dedupingInterval: 0,
          revalidateOnFocus: false,
          revalidateOnReconnect: false,
        }}
      >
        <Consumer />
        {dataKeys.map((dataKey, index) => (
          <DataConsumer key={index} dataKey={dataKey} fetcher={fetchers[index]} />
        ))}
      </SWRConfig>,
    ),
  );
  await flush();
  const currency = () => host.querySelector("output:not([data-collection-data])")?.textContent;
  const displayed = () =>
    Array.from(host.querySelectorAll("[data-collection-data]"), (node) => node.textContent);
  const fetchCounts = () => fetchers.map((fetcher) => fetcher.mock.calls.length);
  expect(mocks.read).toHaveBeenCalledOnce();
  expect(currency()).toBe("standalone");
  expect(displayed()).toEqual(dataKeys.map(() => "initial data"));
  expect(fetchCounts()).toEqual(dataKeys.map(() => 1));

  for (const readCount of [2, 3]) {
    await act(async () => focus());
    await flush();
    expect(mocks.read).toHaveBeenCalledTimes(readCount);
    expect(currency()).toBe("standalone");
    expect(fetchCounts()).toEqual(dataKeys.map(() => 1));
    expect(displayed()).toEqual(dataKeys.map(() => "initial data"));
  }

  nativeData = "linked data";
  mocks.read.mockResolvedValue({ ...collection, generation: "second" });
  await act(async () => focus());
  await flush();
  expect(mocks.read).toHaveBeenCalledTimes(4);
  expect(currency()).toBe("second");
  expect(displayed()).toEqual(dataKeys.map(() => "linked data"));
  expect(fetchCounts()).toEqual(dataKeys.map(() => 2));

  const reads = mocks.read.mock.calls.length;
  await act(async () => root.render(null));
  await act(async () => focus());
  await flush();
  expect(mocks.read).toHaveBeenCalledTimes(reads);
  expect(fetchCounts()).toEqual(dataKeys.map(() => 2));
});

test.each(["list", "reference"])(
  "%s currency shares native rebuild and invalidates every consumer after its ready transition",
  async (owner) => {
    const build = Promise.withResolvers<CollectionDescriptor>();
    mocks.read.mockResolvedValue({ ...collection, status: "stale" });
    mocks.rebuild.mockReturnValue(build.promise);
    let nativeData = "stale data";
    const fetcher = vi.fn(async () => nativeData);
    await act(async () =>
      root.render(
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
          {owner === "list" ? <CollectionList values={[collection]} /> : <Consumer />}
          {dataKeys.map((dataKey, index) => (
            <DataConsumer key={index} dataKey={dataKey} fetcher={fetcher} />
          ))}
        </SWRConfig>,
      ),
    );
    await flush();
    expect(mocks.rebuild).toHaveBeenCalledExactlyOnceWith(collection.id, false);
    expect(
      Array.from(host.querySelectorAll("[data-collection-data]"), (node) => node.textContent),
    ).toEqual(dataKeys.map(() => "stale data"));
    nativeData = "rebuilt data";
    await act(async () => build.resolve({ ...collection, generation: "rebuilt" }));
    await flush();
    expect(
      Array.from(host.querySelectorAll("[data-collection-data]"), (node) => node.textContent),
    ).toEqual(dataKeys.map(() => "rebuilt data"));
  },
);

test("a held read is aborted at the metadata deadline without starting an overlapping read or accepting a late result", async () => {
  let resolve!: (value: CollectionDescriptor) => void;
  mocks.read.mockReturnValueOnce(
    new Promise<CollectionDescriptor>((done) => {
      resolve = done;
    }),
  );
  mocks.read.mockResolvedValue({ ...collection, generation: "recovered" });
  await act(async () => root.render(<Consumer />));
  await flush();
  const signal = mocks.read.mock.calls[0][1].signal as AbortSignal;
  await act(async () => vi.advanceTimersByTimeAsync(6_000));
  expect(signal.aborted).toBe(true);
  expect(mocks.read).toHaveBeenCalledTimes(1);
  expect(host.textContent).toBe("error");
  await act(async () => resolve(collection));
  await flush();
  expect(host.textContent).toBe("recovered");
  expect(mocks.read).toHaveBeenCalledTimes(2);
});

test("ordinary references stay ordinary and rejected collection checks withhold old linked metadata", async () => {
  mocks.read.mockResolvedValue(null);
  await act(async () => root.render(<Consumer />));
  await flush();
  expect(host.textContent).toBe("standalone");
  mocks.read.mockRejectedValue(new Error("metadata unavailable"));
  await act(async () => focus());
  await flush();
  expect(host.textContent).toBe("error");
  await act(async () => root.render(<Consumer file={null} />));
  await flush();
  expect(host.textContent).toBe("standalone");
});

test("the last subscriber aborts a check and observer failures do not strand its owner", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const bad = registerCollectionCheck("observer", {
    read: async () => collection,
    receive: () => {
      throw new Error("observer refused");
    },
  });
  const received = vi.fn();
  const good = registerCollectionCheck("observer", {
    read: async () => collection,
    receive: received,
  });
  await flush();
  expect(received).toHaveBeenCalledWith(collection, undefined);
  expect(error).toHaveBeenCalledOnce();
  bad();
  good();
  const read = vi.fn(
    (signal: AbortSignal) =>
      new Promise<CollectionDescriptor | null>((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }),
      ),
  );
  const release = registerCollectionCheck("retired", { read, receive: vi.fn() });
  await flush();
  release();
  expect(read.mock.calls[0][0].aborted).toBe(true);
  error.mockRestore();
});

test("a slow native rebuild outlives metadata deadlines and stays shared until it settles", async () => {
  let complete!: (value: CollectionDescriptor) => void;
  mocks.read.mockResolvedValue({ ...collection, status: "stale", generation: "second" });
  mocks.rebuild.mockReturnValue(
    new Promise<CollectionDescriptor>((resolve) => {
      complete = resolve;
    }),
  );
  await act(async () =>
    root.render(
      <>
        <Consumer />
        <Consumer />
      </>,
    ),
  );
  await flush();
  expect(mocks.rebuild).toHaveBeenCalledExactlyOnceWith(collection.id, false);
  await act(async () => vi.advanceTimersByTimeAsync(10_000));
  expect(mocks.read).toHaveBeenCalledTimes(6);
  expect(mocks.rebuild).toHaveBeenCalledOnce();
  await act(async () => complete({ ...collection, generation: "second" }));
  await flush();
  expect(host.textContent).toBe("secondsecond");
  expect(mocks.rebuild).toHaveBeenCalledOnce();
});

test("the metadata queue visits every displayed collection and bounds both kinds of native work", async () => {
  const releases: (() => void)[] = [];
  const reads: (() => void)[] = [];
  const builds: (() => void)[] = [];
  let activeReads = 0;
  let activeBuilds = 0;
  let peakReads = 0;
  let peakBuilds = 0;
  const seen = new Set<number>();
  for (let index = 0; index < 150; index++) {
    releases.push(
      registerCollectionCheck(`queue-${index}`, {
        read: () => {
          activeReads++;
          peakReads = Math.max(peakReads, activeReads);
          return new Promise((resolve) =>
            reads.push(() => {
              activeReads--;
              seen.add(index);
              resolve({ ...collection, id: String(index), status: "stale" });
            }),
          );
        },
        rebuild: () => {
          activeBuilds++;
          peakBuilds = Math.max(peakBuilds, activeBuilds);
          return new Promise((resolve) =>
            builds.push(() => {
              activeBuilds--;
              resolve(collection);
            }),
          );
        },
        receive: vi.fn(),
      }),
    );
  }
  try {
    await flush();
    for (let turn = 0; turn < 150; turn++) {
      reads.splice(0).forEach((complete) => complete());
      builds.splice(0).forEach((complete) => complete());
      await flush();
    }
    expect(seen.size).toBe(150);
    expect(peakReads).toBe(8);
    expect(peakBuilds).toBe(4);
    expect(activeBuilds).toBe(0);
    expect(activeReads).toBe(0);
  } finally {
    releases.forEach((release) => release());
  }
});

test.each(["success", "failure"])(
  "a superseded native rebuild %s cannot replace a newer admitted generation",
  async (outcome) => {
    let complete!: (value: CollectionDescriptor) => void;
    let reject!: (error: Error) => void;
    mocks.read.mockResolvedValue({ ...collection, status: "stale" });
    mocks.rebuild.mockReturnValue(
      new Promise<CollectionDescriptor>((resolve, fail) => {
        complete = resolve;
        reject = fail;
      }),
    );
    await act(async () => root.render(<Consumer />));
    await flush();
    expect(mocks.rebuild).toHaveBeenCalledOnce();
    mocks.read.mockResolvedValue({ ...collection, generation: "newer" });
    await act(async () => focus());
    await flush();
    expect(host.textContent).toBe("newer");
    await act(async () => {
      if (outcome === "success") complete(collection);
      else reject(new Error("obsolete index failure"));
    });
    await flush();
    expect(host.textContent).toBe("newer");
  },
);

test("a current rebuild failure is recoverable and a retired observer cannot poison its successor", async () => {
  mocks.read.mockResolvedValue({ ...collection, status: "stale" });
  mocks.rebuild.mockRejectedValueOnce(new Error("index storage refused"));
  await act(async () => root.render(<Consumer />));
  await flush();
  expect(host.textContent).toBe("error");
  mocks.read.mockResolvedValue(collection);
  await act(async () => focus());
  await flush();
  expect(host.textContent).toBe("first");
  let fail!: (error: Error) => void;
  const old = registerCollectionCheck("retired-build", {
    read: async () => ({ ...collection, status: "stale" }),
    rebuild: () =>
      new Promise<CollectionDescriptor>((_resolve, reject) => {
        fail = reject;
      }),
    receive: vi.fn(),
  });
  await flush();
  old();
  const receive = vi.fn();
  const release = registerCollectionCheck("retired-build", {
    read: async () => ({ ...collection, generation: "successor" }),
    receive,
  });
  try {
    await flush();
    expect(receive).toHaveBeenLastCalledWith(
      expect.objectContaining({ generation: "successor" }),
      undefined,
    );
    await act(async () => fail(new Error("retired native failure")));
    await flush();
    expect(receive).toHaveBeenCalledOnce();
  } finally {
    release();
  }
});

test("remount waits for the retired metadata operation to settle and repeated release cannot remove its successor", async () => {
  let complete!: (value: CollectionDescriptor) => void;
  const first = registerCollectionCheck("remount", {
    read: () =>
      new Promise<CollectionDescriptor>((resolve) => {
        complete = resolve;
      }),
    receive: vi.fn(),
  });
  await flush();
  first();
  const read = vi.fn(async () => collection);
  const receive = vi.fn();
  const second = registerCollectionCheck("remount", { read, receive });
  try {
    first();
    await flush();
    expect(read).not.toHaveBeenCalled();
    await act(async () => complete({ ...collection, generation: "obsolete" }));
    await flush();
    expect(read).toHaveBeenCalledOnce();
    expect(receive).toHaveBeenCalledExactlyOnceWith(collection, undefined);
  } finally {
    complete(collection);
    second();
    await flush();
  }
});

test("deadline retries do not starve collections still waiting for their first check", async () => {
  const started: number[] = [];
  const complete: (() => void)[] = [];
  const release = Array.from({ length: 16 }, (_, index) =>
    registerCollectionCheck(`fair-${index}`, {
      read: () => {
        started.push(index);
        return new Promise<CollectionDescriptor>((resolve) =>
          complete.push(() => resolve(collection)),
        );
      },
      receive: vi.fn(),
    }),
  );
  try {
    await flush();
    expect(started).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    await act(async () => vi.advanceTimersByTimeAsync(4_000));
    complete.splice(0).forEach((resolve) => resolve());
    await flush();
    expect(started.slice(8, 16)).toEqual([8, 9, 10, 11, 12, 13, 14, 15]);
  } finally {
    release.forEach((dispose) => dispose());
    complete.splice(0).forEach((resolve) => resolve());
    await flush();
  }
});

test("database content revision keys on pending lookup, generation, writes, and unavailability", async () => {
  const file: DatabaseHandle = { id: { id: "content-revision" }, kind: "database" };
  const ready = (generation: string): CollectionDescriptor => ({
    ...collection,
    database: file,
    generation,
    status: "ready",
  });
  let settle!: (value: CollectionDescriptor) => void;
  mocks.read.mockReturnValueOnce(
    new Promise<CollectionDescriptor>((done) => {
      settle = done;
    }),
  );

  function View() {
    const state = useDatabaseContentRevision(file);
    return <output>{JSON.stringify(state)}</output>;
  }
  const snapshot = () =>
    JSON.parse(host.textContent ?? "null") as {
      revision: [string | null, number] | null;
      unavailable: boolean;
    };

  await act(async () => root.render(<View />));
  await flush();
  expect(snapshot()).toEqual({ revision: null, unavailable: false });

  await act(async () => settle(ready("g1")));
  await flush();
  expect(snapshot()).toEqual({ revision: ["g1", 0], unavailable: false });

  mocks.read.mockResolvedValue(ready("g2"));
  await act(async () => focus());
  await flush();
  expect(snapshot()).toEqual({ revision: ["g2", 0], unavailable: false });

  await act(async () => {
    recordDatabaseWrite([file]);
  });
  expect(snapshot()).toEqual({ revision: ["g2", 1], unavailable: false });

  mocks.read.mockResolvedValue(null);
  await act(async () => focus());
  await flush();
  expect(snapshot()).toEqual({ revision: [null, 1], unavailable: false });

  mocks.rebuild.mockReturnValue(new Promise(() => {}));
  mocks.read.mockResolvedValue({ ...ready("g2"), status: "stale" });
  await act(async () => focus());
  await flush();
  expect(snapshot().unavailable).toBe(true);

  mocks.read.mockRejectedValue(new Error("metadata unavailable"));
  await act(async () => focus());
  await flush();
  expect(snapshot().unavailable).toBe(true);
});
