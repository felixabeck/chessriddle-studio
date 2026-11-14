import { MantineProvider } from "@mantine/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { dragRangeSlider, rangeSliderThumbs } from "@/tests/rangeSliderDrag";
import { installResizeObserverStub } from "@/tests/resizeObserver";
import { ELO_FILTER_MAX } from "@/utils/db";
import { EloRangeSlider } from "./EloRangeSlider";

installMatchMediaStub();
installResizeObserverStub();
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

test("updates the dragged thumb live during drag, commits once on release, and clears draft for new parent values", async () => {
  const onCommit = vi.fn<(value: [number, number]) => void>();

  await renderSlider([0, ELO_FILTER_MAX], onCommit);
  expect(rangeSliderThumbs(host)[1].getAttribute("aria-valuenow")).toBe(String(ELO_FILTER_MAX));

  const slider = host.querySelector<HTMLElement>(".mantine-RangeSlider-root")!;
  await dragRangeSlider(
    slider,
    { from: 290, to: 200 },
    {
      beforeRelease: () => {
        expect(rangeSliderThumbs(slider)[1].getAttribute("aria-valuenow")).toBe("2000");
        expect(onCommit).not.toHaveBeenCalled();
      },
    },
  );

  expect(onCommit).toHaveBeenCalledExactlyOnceWith([0, 2000]);

  await renderSlider([1000, 2500], onCommit);
  const [minThumb, maxThumb] = rangeSliderThumbs(slider);
  expect(minThumb.getAttribute("aria-valuenow")).toBe("1000");
  expect(maxThumb.getAttribute("aria-valuenow")).toBe("2500");
});

test("defaults thumbs to [0, ELO_FILTER_MAX] when value is null", async () => {
  await renderSlider(null, vi.fn());
  const [minThumb, maxThumb] = rangeSliderThumbs(host);
  expect(minThumb.getAttribute("aria-valuenow")).toBe("0");
  expect(maxThumb.getAttribute("aria-valuenow")).toBe(String(ELO_FILTER_MAX));
});
