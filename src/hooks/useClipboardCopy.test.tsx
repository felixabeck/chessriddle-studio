import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useClipboardCopy } from "./useClipboardCopy";

const mocks = vi.hoisted(() => ({ show: vi.fn() }));
vi.mock("@mantine/notifications", () => ({ notifications: { show: mocks.show } }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let host: HTMLDivElement;
let root: Root;
let current: ReturnType<typeof useClipboardCopy>;
let writeText: ReturnType<typeof vi.fn>;

function Consumer() {
  current = useClipboardCopy("Copy failed", 2000);
  return <span>{String(current.copied)}</span>;
}

beforeEach(async () => {
  vi.useFakeTimers();
  mocks.show.mockReset();
  writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root.render(
      <StrictMode>
        <Consumer />
      </StrictMode>,
    ),
  );
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test("success copies the exact text and resets copied after the timeout", async () => {
  await act(async () => current.copy("PGN text"));
  expect(writeText).toHaveBeenCalledExactlyOnceWith("PGN text");
  expect(current.copied).toBe(true);
  await act(async () => vi.advanceTimersByTime(1999));
  expect(current.copied).toBe(true);
  await act(async () => vi.advanceTimersByTime(1));
  expect(current.copied).toBe(false);
  expect(mocks.show).not.toHaveBeenCalled();
});

test.each(["missing", "rejected"])(
  "%s clipboard reports failure without copied feedback",
  async (failure) => {
    if (failure === "missing") vi.stubGlobal("navigator", {});
    else writeText.mockRejectedValue(new Error("denied"));
    await act(async () => current.copy("PGN text"));
    expect(current.copied).toBe(false);
    expect(mocks.show).toHaveBeenCalledExactlyOnceWith({ message: "Copy failed", color: "danger" });
    expect(vi.getTimerCount()).toBe(0);
  },
);

test("repeated copying replaces the timer and unmount clears it", async () => {
  await act(async () => current.copy("first"));
  await act(async () => vi.advanceTimersByTime(1000));
  await act(async () => current.copy("second"));
  expect(vi.getTimerCount()).toBe(1);
  await act(async () => vi.advanceTimersByTime(1000));
  expect(current.copied).toBe(true);
  await act(async () => root.unmount());
  expect(vi.getTimerCount()).toBe(0);
});

test("a failed retry clears earlier success feedback and its timer", async () => {
  await act(async () => current.copy("first"));
  writeText.mockRejectedValue(new Error("denied"));
  await act(async () => current.copy("second"));
  expect(current.copied).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
  expect(mocks.show).toHaveBeenCalledExactlyOnceWith({ message: "Copy failed", color: "danger" });
});

test.each(["success", "failure"])(
  "late %s after unmount has no timer, state update or notification",
  async (outcome) => {
    const pending = deferred();
    writeText.mockReturnValue(pending.promise);
    let completion!: Promise<void>;
    await act(async () => {
      completion = current.copy("pending");
    });
    await act(async () => root.unmount());
    const error = vi.spyOn(console, "error");
    await act(async () => {
      if (outcome === "success") pending.resolve();
      else pending.reject(new Error("late failure"));
      await completion;
    });
    expect(current.copied).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(mocks.show).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  },
);

test.each(["success", "failure"])(
  "an older %s cannot replace the newer copy result",
  async (outcome) => {
    const pending = deferred();
    writeText.mockReturnValueOnce(pending.promise);
    let completion!: Promise<void>;
    await act(async () => {
      completion = current.copy("older");
    });
    await act(async () => current.copy("newer"));
    await act(async () => {
      if (outcome === "success") pending.resolve();
      else pending.reject(new Error("old failure"));
      await completion;
    });
    expect(current.copied).toBe(true);
    expect(vi.getTimerCount()).toBe(1);
    expect(mocks.show).not.toHaveBeenCalled();
  },
);

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
