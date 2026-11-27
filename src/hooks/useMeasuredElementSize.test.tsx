import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { installResizeObserverStub } from "@/tests/resizeObserver";
import { useMeasuredElementSize } from "./useMeasuredElementSize";

let root: Root;
let host: HTMLDivElement;

function Probe() {
  const { ref, width, height } = useMeasuredElementSize();
  return (
    <div ref={ref}>
      <output data-width>{width}</output>
      <output data-height>{height}</output>
    </div>
  );
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  installResizeObserverStub();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("measures width and height before first paint while ResizeObserver has published nothing", async () => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 320, 240),
  );

  await act(async () => root.render(<Probe />));

  expect(host.querySelector("[data-width]")?.textContent).toBe("320");
  expect(host.querySelector("[data-height]")?.textContent).toBe("240");
});

test("updates width and height when ResizeObserver publishes a resize", async () => {
  vi.useFakeTimers();
  try {
    let observedTarget: Element | null = null;
    let observerCallback: ResizeObserverCallback | null = null;

    class ControllableResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        observerCallback = callback;
      }
      observe(target: Element) {
        observedTarget = target;
      }
      unobserve() {}
      disconnect() {}
    }

    window.ResizeObserver = ControllableResizeObserver as unknown as typeof window.ResizeObserver;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 320, 240),
    );

    await act(async () => root.render(<Probe />));
    expect(observedTarget).not.toBeNull();

    await act(async () => {
      observerCallback?.(
        [
          {
            target: observedTarget!,
            contentRect: new DOMRect(0, 0, 512, 384),
          } as unknown as ResizeObserverEntry,
        ],
        {} as ResizeObserver,
      );
      await vi.runAllTimersAsync();
    });

    expect(host.querySelector("[data-width]")?.textContent).toBe("512");
    expect(host.querySelector("[data-height]")?.textContent).toBe("384");
  } finally {
    vi.useRealTimers();
  }
});
