import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createTreeStore, type TreeStore } from "@/state/store/tree";
import { openingLineFens } from "@/utils/chess";
import { defaultTree } from "@/utils/treeReducer";
import { TreeStateContext } from "./TreeStateContext";

const mocks = vi.hoisted(() => ({
  getOpening: vi.fn(),
  warnSafely: vi.fn(),
}));

vi.mock("@mantine/core", () => ({
  Text: ({
    children,
    className,
    title,
    truncate,
  }: {
    children?: React.ReactNode;
    className?: string;
    title?: string;
    truncate?: string;
  }) => (
    <span className={className} title={title} data-truncate={truncate}>
      {children}
    </span>
  ),
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
});

function openingNameTree(visible = true, reserveLine = false) {
  return (
    <TreeStateContext.Provider value={store}>
      {visible && <OpeningName reserveLine={reserveLine} />}
    </TreeStateContext.Provider>
  );
}

async function renderOpeningName(visible = true, reserveLine = false) {
  await act(async () => root.render(openingNameTree(visible, reserveLine)));
}

function currentLineKey() {
  const { root, position } = store.getState();
  return openingLineFens(root, position).join("\n");
}

const lineFen = (n: number) => `8/8/8/4k3/8/8/4K3/8 w - - ${n} 1`;

async function showLine(fen?: string) {
  await act(async () => {
    store.setState(defaultTree(fen));
  });
  await flushPromises();
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

  await renderOpeningName();
  for (let n = 0; n < OPENING_NAME_CACHE_CAPACITY; n++) {
    await act(async () => {
      store.setState(defaultTree(lineFen(n)));
    });
    await flushPromises();
  }
  expect(mocks.getOpening).toHaveBeenCalledTimes(OPENING_NAME_CACHE_CAPACITY + 1);
  expect(openingNameCache.size).toBe(OPENING_NAME_CACHE_CAPACITY);

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

test("an unexpected failure is not cached, so showing the line again looks it up again", async () => {
  mocks.getOpening
    .mockRejectedValueOnce(new Error("boom"))
    .mockRejectedValueOnce(new Error("boom"));

  await renderOpeningName();
  await flushPromises();
  expect(host.textContent).toBe("");
  expect(mocks.warnSafely).toHaveBeenCalledExactlyOnceWith("boom");
  expect(openingNameCache.has(currentLineKey())).toBe(false);

  await renderOpeningName(false);
  await renderOpeningName();
  await flushPromises();
  expect(mocks.getOpening).toHaveBeenCalledTimes(2);
  expect(mocks.warnSafely).toHaveBeenCalledTimes(2);
  expect(openingNameCache.has(currentLineKey())).toBe(false);
  expect(openingNameCache.size).toBe(0);
  expect(unhandledReasons).toEqual([]);
});

test("a line with no opening is cached, so showing it again does not look it up again", async () => {
  mocks.getOpening.mockRejectedValue(NO_OPENING_PAYLOAD);

  await renderOpeningName();
  await flushPromises();
  expect(host.textContent).toBe("");
  expect(openingNameCache.get(currentLineKey())).toBe("");

  await renderOpeningName(false);
  await renderOpeningName();
  await flushPromises();
  expect(host.textContent).toBe("");
  expect(mocks.getOpening).toHaveBeenCalledTimes(1);
  expect(mocks.warnSafely).not.toHaveBeenCalled();
});

test("a line shown again before the cache overflows survives, and the next oldest is evicted", async () => {
  mocks.getOpening.mockResolvedValue("Ruy Lopez");

  // The starting line plus capacity - 1 more fill the cache exactly.
  await renderOpeningName();
  for (let n = 0; n < OPENING_NAME_CACHE_CAPACITY - 1; n++) await showLine(lineFen(n));
  expect(openingNameCache.size).toBe(OPENING_NAME_CACHE_CAPACITY);
  expect(mocks.getOpening).toHaveBeenCalledTimes(OPENING_NAME_CACHE_CAPACITY);

  // The oldest line is shown again from the cache, which makes it the most recently used.
  await showLine();
  expect(host.textContent).toBe("Ruy Lopez");
  expect(mocks.getOpening).toHaveBeenCalledTimes(OPENING_NAME_CACHE_CAPACITY);

  await showLine(lineFen(OPENING_NAME_CACHE_CAPACITY));
  expect(mocks.getOpening).toHaveBeenCalledTimes(OPENING_NAME_CACHE_CAPACITY + 1);

  await showLine();
  expect(mocks.getOpening).toHaveBeenCalledTimes(OPENING_NAME_CACHE_CAPACITY + 1);
  await showLine(lineFen(0));
  expect(mocks.getOpening).toHaveBeenCalledTimes(OPENING_NAME_CACHE_CAPACITY + 2);
});

test("a step forward keeps the line so far's name while the next lookup is pending", async () => {
  const next = deferred<string>();
  mocks.getOpening.mockResolvedValueOnce("King's Pawn").mockReturnValueOnce(next.promise);

  await renderOpeningName();
  expect(host.textContent).toBe("King's Pawn");

  // Synchronous: the first committed frame of the new position must already carry a name.
  act(() => store.getState().makeMove({ payload: "e4" }));
  expect(store.getState().position).toEqual([0]);
  expect(host.textContent).toBe("King's Pawn");

  await act(async () => {
    next.resolve("King's Pawn Game");
    await next.promise;
  });
  expect(host.textContent).toBe("King's Pawn Game");
  expect(mocks.getOpening).toHaveBeenCalledTimes(2);
});

test("a step forward uses the longest cached leading line, not an older one", async () => {
  const pending = deferred<string>();
  mocks.getOpening
    .mockResolvedValueOnce("Start")
    .mockResolvedValueOnce("King's Pawn Game")
    .mockReturnValueOnce(pending.promise);

  await renderOpeningName();
  await act(async () => store.getState().makeMove({ payload: "e4" }));
  await flushPromises();
  expect(host.textContent).toBe("King's Pawn Game");

  act(() => store.getState().makeMove({ payload: "e5" }));
  expect(host.textContent).toBe("King's Pawn Game");
});

test("an unexpected failure after a step forward clears the line so far's name", async () => {
  mocks.getOpening.mockResolvedValueOnce("King's Pawn").mockRejectedValueOnce(new Error("boom"));

  await renderOpeningName();
  await act(async () => store.getState().makeMove({ payload: "e4" }));
  await flushPromises();

  expect(host.textContent).toBe("");
  expect(mocks.warnSafely).toHaveBeenCalledExactlyOnceWith("boom");
  expect(unhandledReasons).toEqual([]);
});

test("a reserved line truncates to one line and carries the full name as its title", async () => {
  mocks.getOpening.mockResolvedValueOnce("Ruy Lopez").mockRejectedValueOnce(NO_OPENING_PAYLOAD);

  await renderOpeningName(true, true);
  const line = host.querySelector("span")!;
  expect(line.className).toMatch(/reservedLine/);
  expect(line.dataset.truncate).toBe("end");
  expect(line.title).toBe("Ruy Lopez");

  // With no name the line stays mounted and reserved, without an empty tooltip.
  await showLine(ENDGAME_FEN);
  expect(host.textContent).toBe("");
  expect(line.isConnected).toBe(true);
  expect(line.className).toMatch(/reservedLine/);
  expect(line.hasAttribute("title")).toBe(false);
});

test("without a reserved line the name is neither truncated nor titled", async () => {
  mocks.getOpening.mockResolvedValueOnce("Ruy Lopez");

  await renderOpeningName();
  const line = host.querySelector("span")!;
  expect(line.className).toBe("");
  expect(line.hasAttribute("data-truncate")).toBe(false);
  expect(line.hasAttribute("title")).toBe(false);
});

test("a jump several moves ahead walks back to the longest cached line, also one cached as no opening", async () => {
  const twoAhead = deferred<string>();
  const fourAhead = deferred<string>();
  mocks.getOpening
    .mockResolvedValueOnce("Start")
    .mockReturnValueOnce(twoAhead.promise)
    .mockReturnValueOnce(fourAhead.promise);

  await renderOpeningName();
  expect(host.textContent).toBe("Start");

  // Builds moves after `path` without showing them, so their lines stay uncached.
  const buildHidden = (path: number[], sans: string[]) =>
    act(() => {
      for (const [index, san] of sans.entries()) {
        store.getState().goToMove([...path, ...Array<number>(index).fill(0)]);
        store.getState().makeMove({ payload: san, changePosition: false });
      }
      store.getState().goToMove([]);
    });

  // Two moves ahead: the line after e4 is uncached, so the name comes from the start, two back.
  buildHidden([], ["e4", "e5"]);
  act(() => store.getState().goToMove([0, 0]));
  expect(host.textContent).toBe("Start");
  await act(async () => {
    twoAhead.reject(NO_OPENING_PAYLOAD);
    await twoAhead.promise.catch(() => undefined);
  });
  expect(host.textContent).toBe("");

  // Four moves ahead from the start: the nearest cached line (after e5) has no opening, and that
  // empty name wins over the start's, which is further back.
  buildHidden([0, 0], ["Nf3", "Nc6"]);
  act(() => store.getState().goToMove([]));
  expect(host.textContent).toBe("Start");
  act(() => store.getState().goToMove([0, 0, 0, 0]));
  expect(host.textContent).toBe("");
  expect(mocks.getOpening).toHaveBeenCalledTimes(3);
});

test("a line with no opening after a named shorter line clears the shorter line's name", async () => {
  mocks.getOpening.mockResolvedValueOnce("King's Pawn").mockRejectedValueOnce(NO_OPENING_PAYLOAD);

  await renderOpeningName();
  await act(async () => store.getState().makeMove({ payload: "e4" }));
  await flushPromises();

  expect(host.textContent).toBe("");
  expect(mocks.warnSafely).not.toHaveBeenCalled();
});

test("a line cached as no opening shows no name on a later visit, not its shorter line's", async () => {
  mocks.getOpening.mockResolvedValueOnce("King's Pawn").mockRejectedValueOnce(NO_OPENING_PAYLOAD);

  await renderOpeningName();
  await act(async () => store.getState().makeMove({ payload: "e4" }));
  await flushPromises();

  // A fresh mount has no lookup of its own, so only the cache answers for the line after e4.
  await renderOpeningName(false);
  act(() => root.render(openingNameTree()));
  expect(host.textContent).toBe("");
  expect(mocks.getOpening).toHaveBeenCalledTimes(2);
});
