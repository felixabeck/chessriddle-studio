import { MantineProvider } from "@mantine/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { SWRConfig } from "swr";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { installResizeObserverStub } from "@/tests/resizeObserver";
import HashSlider from "./HashSlider";

vi.mock("@/platform/tauri", () => ({
  tauri: {
    memorySize: () => Promise.resolve(16384),
  },
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
installMatchMediaStub();
installResizeObserverStub();

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

test("exposes the provided ariaLabel on the slider thumb", async () => {
  await act(async () => {
    root.render(
      <SWRConfig value={{ provider: () => new Map() }}>
        <MantineProvider env="test">
          <HashSlider value={16} setValue={() => undefined} ariaLabel="Hash size" />
        </MantineProvider>
      </SWRConfig>,
    );
  });

  expect(host.querySelector('[role="slider"]')?.getAttribute("aria-label")).toBe("Hash size");
});
