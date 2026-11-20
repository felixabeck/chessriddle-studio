import { MantineProvider } from "@mantine/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { dragRangeSlider } from "@/tests/rangeSliderDrag";
import { installResizeObserverStub } from "@/tests/resizeObserver";
import TimeRangeSlider from "./TimeRangeSlider";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en-US" } }),
}));

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

test("a narrow preset range on a short timeline can still be widened", async () => {
  const onDateRangeChange = vi.fn();
  const day = 24 * 60 * 60 * 1000;
  // A recent preset on a two-date timeline selects only the last date.
  await act(async () => {
    root.render(
      <MantineProvider env="test">
        <TimeRangeSlider
          ratingDates={[0, day]}
          dateRange={{ start: 1, end: 1 }}
          onDateRangeChange={onDateRangeChange}
        />
      </MantineProvider>,
    );
  });

  const slider = host.querySelector<HTMLElement>(".mantine-RangeSlider-root")!;
  await dragRangeSlider(slider, { from: 300, to: 0 });

  expect(onDateRangeChange).toHaveBeenLastCalledWith({ start: 0, end: 1 });
});
