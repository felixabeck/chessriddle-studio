import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { installResizeObserverStub } from "@/tests/resizeObserver";
import { useElementWidth } from "./useElementWidth";

let root: Root;
let host: HTMLDivElement;

function Probe() {
  const { ref, width } = useElementWidth();
  return (
    <div ref={ref}>
      <output>{width}</output>
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

test("measures width before first paint while ResizeObserver has published nothing", async () => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 320, 100),
  );

  await act(async () => root.render(<Probe />));

  expect(host.querySelector("output")?.textContent).toBe("320");
});
