import dayjs from "dayjs";
import customParseFormat from "dayjs/plugin/customParseFormat";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { PlayerGameInfo } from "@/bindings";

dayjs.extend(customParseFormat);

const locale = vi.hoisted(() => ({ language: "de-DE" }));
const slider = vi.hoisted(() => ({ nextValue: [0, 0] as [number, number] }));
const date = new Date("2024-06-22T12:00:00Z").getTime();

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: locale.language } }),
}));
vi.mock("@mantine/core", () => ({
  Stack: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  RangeSlider: ({
    label,
    value,
    onChange,
  }: {
    label: (value: number) => ReactNode;
    value: [number, number];
    onChange: (value: [number, number]) => void;
  }) => (
    <span
      data-testid="slider-label"
      data-value={value.join(",")}
      onClick={() => onChange(slider.nextValue)}
    >
      {label(0)}
    </span>
  ),
}));
vi.mock("recharts", () => ({
  Area: () => null,
  AreaChart: ({ children }: { children: ReactNode }) => <svg>{children}</svg>,
  CartesianGrid: () => null,
  ResponsiveContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  XAxis: ({ tickFormatter }: { tickFormatter: (value: number) => string }) => (
    <text data-testid="rating-tick">{tickFormatter(date)}</text>
  ),
  Tooltip: ({ labelFormatter }: { labelFormatter: (value: number) => string }) => (
    <text data-testid="rating-tooltip">{labelFormatter(date)}</text>
  ),
  YAxis: () => null,
}));
vi.mock("./DateRangeTabs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./DateRangeTabs")>()),
  default: () => null,
}));
vi.mock("./ResultsChart", () => ({ default: () => null }));
vi.mock("./TimeControlSelector", () => ({ default: () => null }));
vi.mock("./WebsiteAccountSelector", () => ({ default: () => null }));

import RatingsPanel from "./RatingsPanel";
import TimeRangeSlider from "./TimeRangeSlider";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const info: PlayerGameInfo = {
  site_stats_data: [
    {
      site: "Lichess",
      player: "Ada",
      daily: [
        {
          date: "2024.06.22",
          time_control: "600+0",
          won: 1,
          drawn: 0,
          lost: 0,
          max_player_elo: 1500,
        },
      ],
      colors: [],
      latest: [],
      openings: [],
    },
  ],
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  locale.language = "de-DE";
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

function expectLocalizedDate(testId: string, language: string, otherLanguage: string) {
  const text = container.querySelector(`[data-testid="${testId}"]`)?.textContent;
  expect(text).toBe(new Date(date).toLocaleDateString(language));
  expect(text).not.toBe(new Date(date).toLocaleDateString(otherLanguage));
}

test("slider label uses the interface language", async () => {
  const props = {
    ratingDates: [date],
    dateRange: { start: 0, end: 0 },
    onDateRangeChange: vi.fn(),
  };
  await act(async () => {
    root.render(<TimeRangeSlider {...props} />);
  });
  expectLocalizedDate("slider-label", "de-DE", "en-US");

  locale.language = "en-US";
  await act(async () => {
    root.render(<TimeRangeSlider {...props} />);
  });
  expectLocalizedDate("slider-label", "en-US", "de-DE");
});

test("slider renders the parent's range and only reports changes", async () => {
  const onDateRangeChange = vi.fn();
  const ratingDates = Array.from({ length: 10 }, (_, i) => date + i);
  const renderSlider = (dateRange: { start: number; end: number }) =>
    act(async () => {
      root.render(
        <TimeRangeSlider
          ratingDates={ratingDates}
          dateRange={dateRange}
          onDateRangeChange={onDateRangeChange}
        />,
      );
    });
  const sliderValue = () =>
    (container.querySelector('[data-testid="slider-label"]') as HTMLElement).dataset.value;

  await renderSlider({ start: 2, end: 3 });
  expect(sliderValue()).toBe("2,3");

  slider.nextValue = [1, 4];
  await act(async () =>
    (container.querySelector('[data-testid="slider-label"]') as HTMLElement).click(),
  );
  expect(onDateRangeChange).toHaveBeenCalledWith({ start: 1, end: 4 });
  // The parent has not accepted the change, so the slider keeps showing its range.
  expect(sliderValue()).toBe("2,3");

  await renderSlider({ start: 5, end: 8 });
  expect(sliderValue()).toBe("5,8");
});

test("rating ticks and tooltip labels use the interface language", async () => {
  await act(async () => {
    root.render(<RatingsPanel playerKey="Ada" info={info} isDatabase />);
  });
  expectLocalizedDate("rating-tick", "de-DE", "en-US");
  expectLocalizedDate("rating-tooltip", "de-DE", "en-US");

  locale.language = "en-US";
  await act(async () => {
    root.render(<RatingsPanel playerKey="Ada" info={info} isDatabase />);
  });
  expectLocalizedDate("rating-tick", "en-US", "de-DE");
  expectLocalizedDate("rating-tooltip", "en-US", "de-DE");
});
