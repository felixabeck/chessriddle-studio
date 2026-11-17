import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import useSWR, { SWRConfig, unstable_serialize } from "swr";
import { afterEach, expect, test, vi } from "vitest";
import type { DatabaseContentFailure } from "@/bindings";

const mocks = vi.hoisted(() => ({ listen: vi.fn(), notify: vi.fn() }));
vi.mock("@/platform/tauri", () => ({
  tauriSubscriptions: { databaseContentFailure: mocks.listen },
}));
vi.mock("@/components/files/notifyError", () => ({ notifyListenerError: mocks.notify }));

import { DATABASE_LIST_KEY } from "./useDatabaseList";
import { useDatabaseContentValidation } from "./useDatabaseContentValidation";
import { useNativeRequestOwner } from "./useNativeRequestOwner";

let root: Root;
let container: HTMLDivElement;
let listener: ((event: { payload: DatabaseContentFailure }) => void) | undefined;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function shown() {
  return container.querySelector("output[data-databases]")?.getAttribute("data-databases");
}

async function mount({
  pendingFirstRead = false,
  dedupingInterval = 0,
  observeUnmountedRevalidation = false,
} = {}) {
  const cache = new Map();
  const gate = deferred();
  let failedStamp = false;
  const reads = { count: 0 };
  const fetch = async () => {
    const failedAtRead = failedStamp;
    reads.count += 1;
    if (pendingFirstRead && reads.count === 1) await gate.promise;
    if (observeUnmountedRevalidation && reads.count === 2) await gate.promise;
    return failedAtRead ? "SQLite integrity_check failed" : "stored title";
  };
  function Consumer() {
    const owner = useNativeRequestOwner(DATABASE_LIST_KEY);
    const databases = useSWR(DATABASE_LIST_KEY, () => owner!.run(fetch));
    return <output data-databases={databases.data} />;
  }
  // Keep SWR's fetcher mounted without a native request owner so public mutate
  // can be paused while Consumer has no committed subscriber.
  function CacheRevalidator() {
    useSWR(DATABASE_LIST_KEY, fetch);
    return null;
  }
  function ValidationListener() {
    useDatabaseContentValidation();
    return null;
  }
  let setConsumerMounted: (mounted: boolean) => void;
  let setListenerMounted: (mounted: boolean) => void;
  function Probe() {
    const [consumerMounted, setMounted] = useState(true);
    const [listenerMounted, setListening] = useState(true);
    setConsumerMounted = setMounted;
    setListenerMounted = setListening;
    return (
      <>
        {listenerMounted && <ValidationListener />}
        {consumerMounted && <Consumer />}
        {observeUnmountedRevalidation && <CacheRevalidator />}
      </>
    );
  }
  mocks.listen.mockImplementation((handler: typeof listener) => {
    listener = handler;
    return Promise.resolve(() => {});
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      <SWRConfig value={{ provider: () => cache, dedupingInterval }}>
        <Probe />
      </SWRConfig>,
    ),
  );
  return {
    reads,
    gate,
    cache,
    showConsumer: async (mounted: boolean) => {
      await act(async () => setConsumerMounted(mounted));
    },
    showListener: async (mounted: boolean) => {
      await act(async () => setListenerMounted(mounted));
    },
    fail: async () => {
      failedStamp = true;
      await act(async () =>
        listener?.({
          payload: { filename: "games.db3", message: "SQLite integrity_check failed" },
        }),
      );
    },
  };
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  listener = undefined;
  mocks.listen.mockReset();
});

test("failure revalidates the shared database listing", async () => {
  const { reads, fail } = await mount();
  await fail();
  expect(reads.count).toBe(2);
  expect(shown()).toBe("SQLite integrity_check failed");
});

test("failure during the in-flight listing fetch starts one follow-up read of the failed stamp", async () => {
  const { reads, gate, fail } = await mount({ pendingFirstRead: true });
  expect(reads.count).toBe(1);
  await fail();
  expect(reads.count).toBe(1);
  await act(async () => gate.resolve());
  expect(reads.count).toBe(2);
  expect(shown()).toBe("SQLite integrity_check failed");
});

test("a passed scan emits no failure and does not revalidate", async () => {
  const { reads } = await mount();
  await act(async () => Promise.resolve());
  expect(reads.count).toBe(1);
  expect(mocks.listen).toHaveBeenCalledTimes(1);
});

test("failure while no consumer is mounted evicts the listing so remount reads the failed stamp", async () => {
  const { reads, fail, showConsumer, cache } = await mount({ dedupingInterval: 60000 });
  expect(reads.count).toBe(1);
  await showConsumer(false);
  await fail();
  expect(cache.has(unstable_serialize(DATABASE_LIST_KEY))).toBe(false);
  await showConsumer(true);
  expect(shown()).toBe("SQLite integrity_check failed");
});

test("a consumer subscribing during unmounted revalidation preserves the listing", async () => {
  const { reads, fail, showConsumer, gate, cache } = await mount({
    dedupingInterval: 60000,
    observeUnmountedRevalidation: true,
  });
  await showConsumer(false);
  await fail();
  expect(reads.count).toBe(2);
  await showConsumer(true);
  await act(async () => gate.resolve());
  expect(reads.count).toBe(2);
  expect(cache.has(unstable_serialize(DATABASE_LIST_KEY))).toBe(true);
  expect(shown()).toBe("SQLite integrity_check failed");
});

test("aborting the failure listener during unmounted revalidation preserves the listing", async () => {
  const { reads, fail, showConsumer, showListener, gate, cache } = await mount({
    dedupingInterval: 60000,
    observeUnmountedRevalidation: true,
  });
  await showConsumer(false);
  await fail();
  expect(reads.count).toBe(2);
  await showListener(false);
  await act(async () => gate.resolve());
  expect(reads.count).toBe(2);
  expect(cache.has(unstable_serialize(DATABASE_LIST_KEY))).toBe(true);
});
