import { MantineProvider } from "@mantine/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test } from "vitest";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { installResizeObserverStub } from "@/tests/resizeObserver";
import LinesSlider from "./LinesSlider";

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

test("exposes the provided ariaLabel on the radiogroup", async () => {
  await act(async () => {
    root.render(
      <MantineProvider env="test">
        <LinesSlider value={1} setValue={() => undefined} ariaLabel="Number of lines" />
      </MantineProvider>,
    );
  });
  expect(host.querySelector('[role="radiogroup"]')?.getAttribute("aria-label")).toBe(
    "Number of lines",
  );
});
