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

import OpeningName from "./OpeningName";

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

async function renderOpeningName() {
  await act(async () =>
    root.render(
      <TreeStateContext.Provider value={store}>
        <OpeningName />
      </TreeStateContext.Provider>,
    ),
  );
}

async function flushUnhandled() {
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
  await flushUnhandled();

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
  await flushUnhandled();

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
  await flushUnhandled();

  expect(host.textContent).toBe("Sicilian Defense");
  expect(mocks.warnSafely).not.toHaveBeenCalled();
  expect(unhandledReasons).toEqual([]);
});
