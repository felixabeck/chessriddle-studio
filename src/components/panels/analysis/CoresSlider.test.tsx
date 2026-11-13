import { MantineProvider } from "@mantine/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test } from "vitest";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { installResizeObserverStub } from "@/tests/resizeObserver";
import CoresSlider from "./CoresSlider";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
installMatchMediaStub();
installResizeObserverStub();

const originalHardwareConcurrency = navigator.hardwareConcurrency;

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
  Object.defineProperty(navigator, "hardwareConcurrency", {
    configurable: true,
    value: originalHardwareConcurrency,
  });
});

function stubHardwareConcurrency(value: unknown) {
  Object.defineProperty(navigator, "hardwareConcurrency", {
    configurable: true,
    value,
  });
}

async function renderSlider(hardwareConcurrency: number, value: number) {
  stubHardwareConcurrency(hardwareConcurrency);
  await act(async () => {
    root.render(
      <MantineProvider env="test">
        <CoresSlider value={value} setValue={() => undefined} />
      </MantineProvider>,
    );
  });
}

function segmentValues() {
  return [...host.querySelectorAll<HTMLInputElement>('input[type="radio"]')].map(
    (option) => option.value,
  );
}

test("hardwareConcurrency 12 offers powers of two below it, then 12", async () => {
  await renderSlider(12, 1);
  expect(segmentValues()).toEqual(["1", "2", "4", "8", "12"]);
});

test("hardwareConcurrency 8 offers powers of two through 8", async () => {
  await renderSlider(8, 1);
  expect(segmentValues()).toEqual(["1", "2", "4", "8"]);
});

test("includes the current value when it is missing from the hardware list", async () => {
  await renderSlider(6, 12);
  expect(segmentValues()).toEqual(["1", "2", "4", "6", "12"]);
  expect(host.querySelector<HTMLInputElement>('input[type="radio"][value="12"]')?.checked).toBe(
    true,
  );
});
