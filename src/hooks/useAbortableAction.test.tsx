import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useAbortableAction } from "./useAbortableAction";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

type HookApi = ReturnType<typeof useAbortableAction>;

let latest: HookApi;
let host: HTMLDivElement;
let root: Root;

function Harness({ opened }: { opened: boolean }) {
  const api = useAbortableAction(opened);
  useEffect(() => {
    latest = api;
  });
  return null;
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

async function renderHarness(opened = true) {
  await act(async () => {
    root.render(<Harness opened={opened} />);
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("canCancel tracks active runAbortable and resets after completion or abort", async () => {
  await renderHarness(true);
  expect(latest.canCancel).toBe(false);
  expect(latest.isMounted()).toBe(true);

  const first = deferred<string>();
  let promise!: Promise<string>;
  await act(async () => {
    promise = latest.runAbortable(async (signal) => {
      expect(signal.aborted).toBe(false);
      return first.promise;
    });
  });
  expect(latest.canCancel).toBe(true);

  await act(async () => {
    first.resolve("ok");
    await promise;
  });
  expect(latest.canCancel).toBe(false);

  const second = deferred<void>();
  let abortedPromise!: Promise<void>;
  let secondSignal!: AbortSignal;
  await act(async () => {
    abortedPromise = latest.runAbortable(async (signal) => {
      secondSignal = signal;
      await second.promise;
    });
  });
  expect(latest.canCancel).toBe(true);
  expect(secondSignal.aborted).toBe(false);

  await act(async () => {
    latest.abort();
  });
  expect(secondSignal.aborted).toBe(true);
  await act(async () => {
    second.resolve();
    await abortedPromise;
  });
  expect(latest.canCancel).toBe(false);
});

test("second runAbortable aborts the first and stale finally does not clear newer controller", async () => {
  await renderHarness(true);

  const first = deferred<void>();
  const second = deferred<void>();
  let signal1!: AbortSignal;
  let signal2!: AbortSignal;
  let p1!: Promise<void>;
  let p2!: Promise<void>;

  await act(async () => {
    p1 = latest.runAbortable((signal) => {
      signal1 = signal;
      return first.promise;
    });
  });
  expect(signal1.aborted).toBe(false);

  await act(async () => {
    p2 = latest.runAbortable((signal) => {
      signal2 = signal;
      return second.promise;
    });
  });
  expect(signal1.aborted).toBe(true);
  expect(signal2.aborted).toBe(false);
  expect(latest.canCancel).toBe(true);

  // Settle the superseded first promise after the second controller took ownership.
  await act(async () => {
    first.reject(new Error("aborted"));
    await p1.catch(() => undefined);
  });

  // Newer controller remains active and abortable.
  expect(latest.canCancel).toBe(true);
  expect(signal2.aborted).toBe(false);

  await act(async () => {
    latest.abort();
  });
  expect(signal2.aborted).toBe(true);

  await act(async () => {
    second.resolve();
    await p2;
  });
  expect(latest.canCancel).toBe(false);
});

test("opened=false and unmount abort active operations and clear isMounted", async () => {
  await renderHarness(true);

  let signal1!: AbortSignal;
  const d1 = deferred<void>();
  await act(async () => {
    void latest.runAbortable((signal) => {
      signal1 = signal;
      return d1.promise;
    });
  });
  expect(signal1.aborted).toBe(false);

  await renderHarness(false);
  expect(signal1.aborted).toBe(true);

  await act(async () => {
    d1.resolve();
  });

  await renderHarness(true);
  let signal2!: AbortSignal;
  const d2 = deferred<void>();
  await act(async () => {
    void latest.runAbortable((signal) => {
      signal2 = signal;
      return d2.promise;
    });
  });
  expect(signal2.aborted).toBe(false);

  await act(async () => root.unmount());
  expect(signal2.aborted).toBe(true);
  expect(latest.isMounted()).toBe(false);

  // Re-attach fresh root for afterEach unmount.
  root = createRoot(host);
  vi.clearAllMocks();
});
