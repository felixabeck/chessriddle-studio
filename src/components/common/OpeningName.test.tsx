import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createTreeStore, type TreeStore } from "@/state/store/tree";
import { defaultTree } from "@/utils/treeReducer";
import { TreeStateContext } from "./TreeStateContext";

const mocks = vi.hoisted(() => ({
  getOpening: vi.fn(),
  warnSafely: vi.fn(),
}));

vi.mock("@mantine/core", () => ({
  Text: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
}));
vi.mock("@/utils/chess", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/chess")>()),
  getOpening: mocks.getOpening,
}));
vi.mock("@/platform/errors", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/platform/errors")>()),
  warnSafely: mocks.warnSafely,
}));

import OpeningName, { OPENING_NAME_CACHE_CAPACITY, openingNameCache } from "./OpeningName";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const ENDGAME_FEN = "8/8/8/4k3/8/8/4K3/8 w - - 0 1";
const NO_OPENING_PAYLOAD = {
  tag: "backend-error" as const,
  category: "missing-resource" as const,
  message: "No opening found",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

let host: HTMLDivElement;
let root: Root;
let store: TreeStore;
let unhandledReasons: unknown[];
function onUnhandled(event: PromiseRejectionEvent) {
  unhandledReasons.push(event.reason);
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  store = createTreeStore();
  // The cache is module-wide, as in the app; it outlives remounts inside one test.
  openingNameCache.clear();
  mocks.getOpening.mockReset();
  mocks.warnSafely.mockReset();
  unhandledReasons = [];
  window.addEventListener("unhandledrejection", onUnhandled);
});

afterEach(async () => {
  window.removeEventListener("unhandledrejection", onUnhandled);
  await act(async () => root.unmount());
  host.remove();
  store.dispose();
});

function openingNameTree(visible = true) {
  return (
    <TreeStateContext.Provider value={store}>
      {visible && <OpeningName />}
    </TreeStateContext.Provider>
  );
}

async function renderOpeningName(visible = true) {
  await act(async () => root.render(openingNameTree(visible)));
}

async function flushPromises() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

test("clears a named opening when the next position has none, without warning", async () => {
  mocks.getOpening.mockResolvedValueOnce("Ruy Lopez").mockRejectedValueOnce(NO_OPENING_PAYLOAD);

  await renderOpeningName();
  expect(host.textContent).toBe("Ruy Lopez");

  await act(async () => {
    store.setState(defaultTree(ENDGAME_FEN));
  });
  await flushPromises();

  expect(host.textContent).toBe("");
  expect(mocks.warnSafely).not.toHaveBeenCalled();
  expect(unhandledReasons).toEqual([]);
});

test("clears the name and warns once for an unexpected lookup failure", async () => {
  mocks.getOpening.mockResolvedValueOnce("Ruy Lopez").mockRejectedValueOnce(new Error("boom"));

  await renderOpeningName();
  expect(host.textContent).toBe("Ruy Lopez");

  await act(async () => {
    store.setState(defaultTree(ENDGAME_FEN));
  });
  await flushPromises();

  expect(host.textContent).toBe("");
  expect(mocks.warnSafely).toHaveBeenCalledExactlyOnceWith("boom");
  expect(unhandledReasons).toEqual([]);
});

test("ignores a stale successful opening lookup", async () => {
  const first = deferred<string>();
  mocks.getOpening.mockReturnValueOnce(first.promise).mockResolvedValueOnce("Sicilian Defense");

  await renderOpeningName();
  await act(async () => {
    store.setState(defaultTree(ENDGAME_FEN));
  });
  expect(host.textContent).toBe("Sicilian Defense");

  await act(async () => {
    first.resolve("Ruy Lopez");
    await first.promise;
  });

  expect(host.textContent).toBe("Sicilian Defense");
});

test("ignores a stale rejected opening lookup after a newer success", async () => {
  const first = deferred<string>();
  mocks.getOpening.mockReturnValueOnce(first.promise).mockResolvedValueOnce("Sicilian Defense");

  await renderOpeningName();
  await act(async () => {
    store.setState(defaultTree(ENDGAME_FEN));
  });
  expect(host.textContent).toBe("Sicilian Defense");

  await act(async () => {
    first.reject(new Error("boom"));
    await first.promise.catch(() => undefined);
  });
  await flushPromises();

  expect(host.textContent).toBe("Sicilian Defense");
  expect(mocks.warnSafely).not.toHaveBeenCalled();
  expect(unhandledReasons).toEqual([]);
});

test("a remount with the same line renders the cached name at once without a second lookup", async () => {
  mocks.getOpening.mockResolvedValue("Ruy Lopez");

  await renderOpeningName();
  expect(host.textContent).toBe("Ruy Lopez");

  await renderOpeningName(false);
  expect(host.textContent).toBe("");

  // Synchronous render, no act flush of pending promises: the first committed frame has the name.
  act(() => root.render(openingNameTree()));
  expect(host.textContent).toBe("Ruy Lopez");
  await flushPromises();
  expect(mocks.getOpening).toHaveBeenCalledTimes(1);
});

test("a different line does not show the previous line's name while its lookup is pending", async () => {
  const second = deferred<string>();
  mocks.getOpening.mockResolvedValueOnce("Ruy Lopez").mockReturnValueOnce(second.promise);

  await renderOpeningName();
  expect(host.textContent).toBe("Ruy Lopez");

  await act(async () => {
    store.setState(defaultTree(ENDGAME_FEN));
  });
  expect(host.textContent).toBe("");

  await act(async () => {
    second.resolve("Sicilian Defense");
    await second.promise;
  });
  expect(host.textContent).toBe("Sicilian Defense");
  expect(mocks.getOpening).toHaveBeenCalledTimes(2);
});

test("the cache keeps at most its capacity of lines and looks an evicted line up again", async () => {
  mocks.getOpening.mockResolvedValue("Ruy Lopez");
  const lineFen = (n: number) => `8/8/8/4k3/8/8/4K3/8 w - - ${n} 1`;

  await renderOpeningName();
  for (let n = 0; n < OPENING_NAME_CACHE_CAPACITY; n++) {
    await act(async () => {
      store.setState(defaultTree(lineFen(n)));
    });
    await flushPromises();
  }
  expect(mocks.getOpening).toHaveBeenCalledTimes(OPENING_NAME_CACHE_CAPACITY + 1);
  expect(openingNameCache.entries.size).toBe(OPENING_NAME_CACHE_CAPACITY);

  // The first line was the oldest of capacity + 1 and was dropped.
  await act(async () => {
    store.setState(defaultTree());
  });
  await flushPromises();
  expect(host.textContent).toBe("Ruy Lopez");
  expect(mocks.getOpening).toHaveBeenCalledTimes(OPENING_NAME_CACHE_CAPACITY + 2);

  // The most recent line is still cached.
  await act(async () => {
    store.setState(defaultTree(lineFen(OPENING_NAME_CACHE_CAPACITY - 1)));
  });
  expect(host.textContent).toBe("Ruy Lopez");
  expect(mocks.getOpening).toHaveBeenCalledTimes(OPENING_NAME_CACHE_CAPACITY + 2);
});
