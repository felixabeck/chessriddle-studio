import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useSingleFlight } from "./useSingleFlight";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let container: HTMLDivElement;
let root: Root;
let current: ReturnType<typeof useSingleFlight>;

function Consumer() {
  current = useSingleFlight();
  return <span>{String(current.pending)}</span>;
}

beforeEach(async () => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <StrictMode>
        <Consumer />
      </StrictMode>,
    );
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("a second run during a flight skips its operation, including before a rerender", async () => {
  const held = deferred();
  const first = vi.fn(() => held.promise);
  const second = vi.fn(async () => {});
  const { run, isMounted } = current;
  let completion!: Promise<void>;

  await act(async () => {
    completion = run(first);
    await run(second);
  });

  expect(first).toHaveBeenCalledOnce();
  expect(second).not.toHaveBeenCalled();
  expect(current.pending).toBe(true);
  expect(current.run).toBe(run);
  expect(current.isMounted).toBe(isMounted);
  expect(isMounted()).toBe(true);

  await act(async () => {
    held.resolve();
    await completion;
  });
  await act(async () => run(second));
  expect(second).toHaveBeenCalledOnce();
  expect(current.pending).toBe(false);
});

test.each(["resolve", "reject"])(
  "pending covers the operation until %s and rejection propagates unchanged",
  async (outcome) => {
    const held = deferred();
    const failure = new Error("operation failed");
    let completion!: Promise<void>;
    await act(async () => {
      completion = current.run(() => held.promise);
    });
    expect(current.pending).toBe(true);
    expect(container.textContent).toBe("true");

    const settled = completion.catch((error: unknown) => error);
    await act(async () => {
      if (outcome === "reject") held.reject(failure);
      else held.resolve();
      expect(await settled).toBe(outcome === "reject" ? failure : undefined);
    });

    expect(current.pending).toBe(false);
    expect(container.textContent).toBe("false");
    const retry = vi.fn(async () => {});
    await act(async () => current.run(retry));
    expect(retry).toHaveBeenCalledOnce();
  },
);

test.each(["resolve", "reject"])(
  "settling with %s after unmount leaves isMounted false without state-update warnings",
  async (outcome) => {
    const held = deferred();
    const failure = new Error("late failure");
    let completion!: Promise<void>;
    await act(async () => {
      completion = current.run(() => held.promise);
    });
    const { isMounted } = current;
    await act(async () => root.unmount());
    expect(isMounted()).toBe(false);
    const consoleError = vi.spyOn(console, "error");
    const consoleWarn = vi.spyOn(console, "warn");
    const settled = completion.catch((error: unknown) => error);

    if (outcome === "reject") held.reject(failure);
    else held.resolve();
    expect(await settled).toBe(outcome === "reject" ? failure : undefined);

    expect(isMounted()).toBe(false);
    expect(consoleError).not.toHaveBeenCalled();
    expect(consoleWarn).not.toHaveBeenCalled();
  },
);
