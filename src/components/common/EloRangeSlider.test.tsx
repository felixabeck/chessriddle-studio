import { MantineProvider } from "@mantine/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { ELO_FILTER_MAX } from "@/utils/db";
import { EloRangeSlider } from "./EloRangeSlider";

installMatchMediaStub();
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function renderSlider(
  value: [number, number] | null | undefined,
  onCommit: (v: [number, number]) => void,
) {
  return act(async () => {
    root.render(
      <MantineProvider env="test">
        <EloRangeSlider
          value={value}
          onCommit={onCommit}
          thumbFromLabel="Minimum Elo"
          thumbToLabel="Maximum Elo"
        />
      </MantineProvider>,
    );
  });
}

function upperThumb() {
  return host.querySelectorAll<HTMLElement>('[role="slider"]')[1];
}

test("updates the dragged thumb live during drag and commits once on release", async () => {
  const onCommit = vi.fn<(value: [number, number]) => void>();
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 300,
    bottom: 20,
    width: 300,
    height: 20,
    toJSON: () => ({}),
  } as DOMRect);

  await renderSlider([0, ELO_FILTER_MAX], onCommit);
  expect(upperThumb().getAttribute("aria-valuenow")).toBe(String(ELO_FILTER_MAX));

  // Mantine RangeSlider attaches useMove + capture handlers to .mantine-RangeSlider-trackContainer.
  const track = host.querySelector<HTMLElement>(".mantine-RangeSlider-trackContainer")!;
  await act(async () => {
    track.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 290, clientY: 10 }));
    document.dispatchEvent(
      new MouseEvent("mousemove", { bubbles: true, clientX: 200, clientY: 10 }),
    );
    await vi.advanceTimersByTimeAsync(20);
  });

  expect(upperThumb().getAttribute("aria-valuenow")).toBe("2000");
  expect(onCommit).not.toHaveBeenCalled();

  await act(async () => {
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: 200, clientY: 10 }));
    await vi.runAllTimersAsync();
  });

  expect(onCommit).toHaveBeenCalledExactlyOnceWith([0, 2000]);

  await renderSlider(onCommit.mock.calls[0][0], onCommit);
  expect(upperThumb().getAttribute("aria-valuenow")).toBe("2000");
});
