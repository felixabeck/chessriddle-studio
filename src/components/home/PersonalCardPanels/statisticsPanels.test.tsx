import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import dayjs from "dayjs";
import customParseFormat from "dayjs/plugin/customParseFormat";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { PlayerGameInfo } from "@/bindings";

dayjs.extend(customParseFormat);

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@mantine/core", () => {
  const Container = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;
  return {
    Box: Container,
    Divider: () => <hr />,
    Group: Container,
    ScrollArea: Container,
    Stack: Container,
    Text: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  };
});
vi.mock("recharts", () => ({
  Bar: () => null,
  BarChart: ({ data }: { data: { name: string; count: number }[] }) => (
    <div data-testid="month-data">{data.map((row) => `${row.name}:${row.count}`).join("|")}</div>
  ),
  Area: () => null,
  AreaChart: ({ data }: { data: { date: number; player_elo: number }[] }) => (
    <div data-testid="rating-data">{data.map((row) => row.player_elo).join("|")}</div>
  ),
  CartesianGrid: () => null,
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Tooltip: () => null,
  XAxis: () => null,
  YAxis: () => null,
}));
vi.mock("./ResultsChart", () => ({
  default: ({ won, draw, lost }: { won: number; draw: number; lost: number }) => (
    <div data-testid="result-counts">
      {won}:{draw}:{lost}
    </div>
  ),
}));
vi.mock("./TimeControlSelector", () => ({ default: () => null }));
vi.mock("./WebsiteAccountSelector", () => ({ default: () => null }));
vi.mock("./DateRangeTabs", () => ({
  DateRange: {
    SevenDays: "7d",
    ThirtyDays: "30d",
    NinetyDays: "90d",
    OneYear: "1y",
    AllTime: "all",
  },
  default: ({ onTimeRangeChange }: { onTimeRangeChange: (value: string | null) => void }) => (
    <button data-testid="select-seven-days" onClick={() => onTimeRangeChange("7d")}>
      Seven days
    </button>
  ),
}));
vi.mock("./TimeRangeSlider", () => ({
  default: ({ ratingDates }: { ratingDates: number[] }) => (
    <div data-testid="rating-dates">{ratingDates.join("|")}</div>
  ),
}));
vi.mock("@/platform/tauri", () => ({ tauri: { getOpeningFromName: vi.fn() } }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 120,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ index, size: 120, start: index * 120 })),
  }),
}));
vi.mock("jotai", () => ({ useAtom: () => [[], vi.fn()], useAtomValue: () => 100 }));
vi.mock("@/state/atoms", () => ({ fontSizeAtom: {}, tabsAtom: {} }));
vi.mock("@/components/files/notifyError", () => ({ notifyUnlessCancelled: vi.fn() }));
vi.mock("@/utils/chess", () => ({ parsePGN: vi.fn() }));
vi.mock("@/utils/tabs", () => ({ createTab: vi.fn(), runTabCreation: vi.fn() }));
vi.mock("@/utils/treeReducer", () => ({ countMainPly: vi.fn(), defaultTree: vi.fn() }));

import OpeningsPanel from "./OpeningsPanel";
import OverviewPanel, { fillMissingMonths } from "./OverviewPanel";
import RatingsPanel from "./RatingsPanel";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const duplicatedDailyStatistics: PlayerGameInfo = {
  site_stats_data: [
    {
      site: "Lichess",
      player: "Magnus",
      daily: [
        {
          date: "2026.09.02",
          time_control: "600+0",
          won: 2,
          drawn: 1,
          lost: 0,
          max_player_elo: 2_800,
        },
        {
          date: "2026.10.01",
          time_control: "600+0",
          won: 0,
          drawn: 0,
          lost: 1,
          max_player_elo: 2_810,
        },
      ],
      openings: [],
    },
    {
      site: "Lichess",
      player: "Magnus",
      daily: [
        {
          date: "2026.09.02",
          time_control: "600+0",
          won: 1,
          drawn: 0,
          lost: 1,
          max_player_elo: 2_820,
        },
      ],
      openings: [],
    },
  ],
};

const duplicatedOpeningStatistics: PlayerGameInfo = {
  site_stats_data: [
    {
      site: "Lichess",
      player: "Magnus",
      daily: [],
      openings: [
        {
          time_control: "600+0",
          is_player_white: true,
          opening: "Sicilian Defense",
          won: 2,
          drawn: 1,
          lost: 0,
        },
        {
          time_control: "600+0",
          is_player_white: true,
          opening: "French Defense",
          won: 0,
          drawn: 1,
          lost: 0,
        },
        {
          time_control: "600+0",
          is_player_white: false,
          opening: "Caro-Kann Defense",
          won: 0,
          drawn: 0,
          lost: 2,
        },
      ],
    },
    {
      site: "Lichess",
      player: "Magnus",
      daily: [],
      openings: [
        {
          time_control: "600+0",
          is_player_white: true,
          opening: "Sicilian Defense",
          won: 1,
          drawn: 0,
          lost: 1,
        },
        {
          time_control: "600+0",
          is_player_white: false,
          opening: "Caro-Kann Defense",
          won: 1,
          drawn: 1,
          lost: 0,
        },
      ],
    },
  ],
};

let container: HTMLDivElement;
let root: Root;

async function render(component: React.ReactNode) {
  await act(async () => root.render(component));
}

// The panels read today's date; pin it so the fixture's seven-day window does not expire.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-02T12:00:00Z"));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe.each(["America/New_York", "Europe/Berlin"])("fillMissingMonths in %s", (timezone) => {
  test.each([
    {
      name: "2026-09 through 2026-10",
      input: [
        { name: "2026-09", count: 5 },
        { name: "2026-10", count: 1 },
      ],
      expected: [
        { name: "2026-09", count: 5 },
        { name: "2026-10", count: 1 },
      ],
    },
    {
      name: "2026-10 through 2026-11 across autumn DST",
      input: [
        { name: "2026-10", count: 2 },
        { name: "2026-11", count: 3 },
      ],
      expected: [
        { name: "2026-10", count: 2 },
        { name: "2026-11", count: 3 },
      ],
    },
    {
      name: "2025-12 through 2026-02 across a year boundary with unsorted input",
      input: [
        { name: "2026-02", count: 4 },
        { name: "2025-12", count: 2 },
      ],
      expected: [
        { name: "2025-12", count: 2 },
        { name: "2026-01", count: 0 },
        { name: "2026-02", count: 4 },
      ],
    },
    {
      name: "2026-07 through 2026-09 with a missing month filled with zero",
      input: [
        { name: "2026-07", count: 3 },
        { name: "2026-09", count: 5 },
      ],
      expected: [
        { name: "2026-07", count: 3 },
        { name: "2026-08", count: 0 },
        { name: "2026-09", count: 5 },
      ],
    },
    {
      name: "2026-09 as a single month",
      input: [{ name: "2026-09", count: 7 }],
      expected: [{ name: "2026-09", count: 7 }],
    },
    { name: "empty input", input: [], expected: [] },
    {
      name: "2026-?? alongside 2026-09 keeps the valid month",
      input: [
        { name: "2026-??", count: 1 },
        { name: "2026-09", count: 5 },
      ],
      expected: [{ name: "2026-09", count: 5 }],
    },
    {
      name: "only invalid month keys returns no buckets",
      input: [
        { name: "2026-??", count: 1 },
        { name: "2026-00", count: 2 },
        { name: "2026-13", count: 3 },
        { name: "2026-9", count: 4 },
        { name: "2026-09suffix", count: 5 },
      ],
      expected: [],
    },
  ])("$name", ({ input, expected }) => {
    vi.stubEnv("TZ", timezone);
    try {
      expect(fillMissingMonths(input)).toEqual(expected);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

test("Overview sums duplicate daily keys into result totals and month buckets", async () => {
  await render(<OverviewPanel playerName="Magnus" info={duplicatedDailyStatistics} isDatabase />);

  expect(container.textContent).toContain("6 Common.Games");
  expect(container.querySelector("[data-testid='result-counts']")?.textContent).toBe("3:1:2");
  expect(container.querySelector("[data-testid='month-data']")?.textContent).toBe(
    "2026-09:5|2026-10:1",
  );
});

test("Ratings sums duplicate daily keys and takes the highest rating for each date", async () => {
  await render(<RatingsPanel playerName="Magnus" info={duplicatedDailyStatistics} isDatabase />);

  expect(container.textContent).toContain("6 Common.Games");
  expect(container.querySelector("[data-testid='result-counts']")?.textContent).toBe("3:1:2");
  expect(container.querySelector("[data-testid='rating-data']")?.textContent).toBe("2820|2810");
});

test("Ratings excludes out-of-range days from the summary and rating series", async () => {
  await render(<RatingsPanel playerName="Magnus" info={duplicatedDailyStatistics} isDatabase />);

  await act(async () => {
    container.querySelector<HTMLButtonElement>("[data-testid='select-seven-days']")?.click();
  });

  expect(container.textContent).toContain("1 Common.Games");
  expect(container.querySelector("[data-testid='result-counts']")?.textContent).toBe("0:0:1");
  expect(container.querySelector("[data-testid='rating-data']")?.textContent).toBe("2810");
});

test("Overview and Ratings All-time both count games on incomplete daily dates", async () => {
  const partialDateStatistics: PlayerGameInfo = {
    site_stats_data: [
      {
        site: "Lichess",
        player: "Magnus",
        daily: [
          {
            date: "2024.??.??",
            time_control: "600+0",
            won: 2,
            drawn: 0,
            lost: 0,
            max_player_elo: 2_700,
          },
          {
            date: "2026.10.01",
            time_control: "600+0",
            won: 0,
            drawn: 0,
            lost: 1,
            max_player_elo: 2_710,
          },
        ],
        openings: [],
      },
    ],
  };

  await render(<OverviewPanel playerName="Magnus" info={partialDateStatistics} isDatabase />);
  expect(container.textContent).toContain("3 Common.Games");

  await render(<RatingsPanel playerName="Magnus" info={partialDateStatistics} isDatabase />);
  expect(container.textContent).toContain("3 Common.Games");
  const dates = container.querySelector("[data-testid='rating-dates']")?.textContent ?? "";
  expect(dates.split("|").some((value) => value === "NaN" || Number.isNaN(Number(value)))).toBe(
    false,
  );
});

test("Ratings Seven Days excludes incomplete dates that All time includes", async () => {
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const yesterdayDate = [
    yesterday.getFullYear(),
    String(yesterday.getMonth() + 1).padStart(2, "0"),
    String(yesterday.getDate()).padStart(2, "0"),
  ].join(".");
  const mixedDateStatistics: PlayerGameInfo = {
    site_stats_data: [
      {
        site: "Lichess",
        player: "Magnus",
        daily: [
          {
            date: "2024.??.??",
            time_control: "600+0",
            won: 2,
            drawn: 0,
            lost: 0,
            max_player_elo: 2_700,
          },
          {
            date: yesterdayDate,
            time_control: "600+0",
            won: 0,
            drawn: 0,
            lost: 1,
            max_player_elo: 2_650,
          },
        ],
        openings: [],
      },
    ],
  };

  await render(<RatingsPanel playerName="Magnus" info={mixedDateStatistics} isDatabase />);
  expect(container.textContent).toContain("3 Common.Games");

  await act(async () => {
    container.querySelector<HTMLButtonElement>("[data-testid='select-seven-days']")?.click();
  });

  expect(container.textContent).toContain("1 Common.Games");
  expect(container.querySelector("[data-testid='rating-data']")?.textContent).toBe("2650");
});

test("Openings sums duplicate opening keys and retains each colour's results", async () => {
  await render(<OpeningsPanel playerName="Magnus" info={duplicatedOpeningStatistics} isDatabase />);

  expect(container.textContent).toContain("Sicilian Defense");
  expect(container.textContent).toContain("83.33%");
  expect(container.textContent).toContain("French Defense");
  expect(container.textContent).toContain("16.67%");
  expect(container.textContent).toContain("Caro-Kann Defense");
  expect(container.textContent).toContain("100.00%");
  expect(
    Array.from(
      container.querySelectorAll("[data-testid='result-counts']"),
      (node) => node.textContent,
    ),
  ).toEqual(["3:1:1", "1:1:2", "0:1:0"]);
});
