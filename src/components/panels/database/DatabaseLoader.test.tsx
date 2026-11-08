import { act } from "react";
import { MantineProvider } from "@mantine/core";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { installMatchMediaStub } from "@/tests/matchMedia";

const mocks = vi.hoisted(() => ({
  clearProgress: vi.fn(),
  getProgress: vi.fn(),
  listen: vi.fn(),
}));

vi.mock("@/bindings/generated", () => ({
  commands: {
    clearProgress: mocks.clearProgress,
    getProgress: mocks.getProgress,
  },
  events: {
    progressEvent: { listen: mocks.listen },
  },
}));

import DatabaseLoader from "./DatabaseLoader";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
installMatchMediaStub();

function renderLoader(isLoading: boolean, tab: string | null, label?: string) {
  return act(async () => {
    root.render(
      <MantineProvider>
        <DatabaseLoader isLoading={isLoading} tab={tab} label={label} />
      </MantineProvider>,
    );
  });
}

type Progress = {
  id: string;
  generation: string;
  progress: number;
  finished: boolean;
  state: "running" | "succeeded" | "failed" | "cancelled";
  cleared: boolean;
};

let eventHandler: ((event: { payload: Progress }) => void) | undefined;
let root: Root;
let container: HTMLDivElement;

function barValue(): number | null {
  const bar = container.querySelector<HTMLElement>("[role='progressbar']");
  const value = bar?.getAttribute("aria-valuenow");
  return value === null || value === undefined ? null : Number.parseFloat(value);
}

async function emit(payload: Partial<Progress> & { progress: number }) {
  await act(async () => {
    eventHandler?.({
      payload: {
        id: "tab-1",
        generation: "1",
        finished: false,
        state: "running",
        cleared: false,
        ...payload,
      },
    });
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  eventHandler = undefined;
  mocks.clearProgress.mockReset();
  mocks.getProgress.mockReset();
  mocks.getProgress.mockResolvedValue(null);
  mocks.listen.mockReset();
  mocks.listen.mockImplementation(async (handler: (event: { payload: Progress }) => void) => {
    eventHandler = handler;
    return vi.fn();
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("DatabaseLoader", () => {
  test("the default loader renders only the existing bar without status text", async () => {
    await renderLoader(true, "tab-1");
    const content = container.cloneNode(true) as HTMLElement;
    for (const style of content.querySelectorAll("style")) style.remove();
    expect(content.textContent?.trim()).toBe("");
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.querySelectorAll('[role="progressbar"]')).toHaveLength(1);
  });

  test("an optional live label shows a whole percentage only after reported progress", async () => {
    await renderLoader(true, "tab-1", "Searching Imnadze's games…");
    const status = () => container.querySelector('[role="status"]');
    expect(status()?.getAttribute("aria-live")).toBe("polite");
    expect(status()?.textContent).toBe("Searching Imnadze's games…");
    await emit({ progress: 24.6 });
    expect(status()?.textContent).toBe("Searching Imnadze's games… 25%");
  });

  test.each(["failed", "cancelled"] as const)(
    "the label discards stale progress when %s",
    async (state) => {
      await renderLoader(true, "tab-1", "Searching Imnadze's games…");
      await emit({ progress: 75 });
      expect(container.querySelector('[role="status"]')?.textContent).toContain("75%");
      await emit({ progress: 75, finished: true, state });
      expect(container.querySelector('[role="status"]')?.textContent).toBe(
        "Searching Imnadze's games…",
      );
      await renderLoader(false, "tab-1", "Searching Imnadze's games…");
      expect(barValue()).toBe(0);
      expect(container.querySelector('[role="status"]')?.textContent).toBe(
        "Searching Imnadze's games…",
      );
    },
  );

  test("shows the reported percentage while a search is running", async () => {
    await renderLoader(true, "tab-1");
    await emit({ progress: 75 });

    expect(barValue()).toBe(75);
  });

  test("empties the bar when a search fails partway through", async () => {
    await renderLoader(true, "tab-1");
    await emit({ progress: 75 });
    await emit({ progress: 75, finished: true, state: "failed" });
    await renderLoader(false, "tab-1");

    // Progress is monotonic in the store, so the failed run still reports 75.
    // The bar must not keep showing it.
    expect(barValue()).toBe(0);
  });

  test("empties the bar when a search is cancelled partway through", async () => {
    await renderLoader(true, "tab-1");
    await emit({ progress: 40 });
    await emit({ progress: 40, finished: true, state: "cancelled" });
    await renderLoader(false, "tab-1");

    expect(barValue()).toBe(0);
  });

  test("keeps the bar full after a successful search", async () => {
    await renderLoader(true, "tab-1");
    await emit({ progress: 100, finished: true, state: "succeeded" });
    await renderLoader(false, "tab-1");

    expect(barValue()).toBe(100);
  });
});
