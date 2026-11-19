import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import dayjs from "dayjs";
import customParseFormat from "dayjs/plugin/customParseFormat";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { PlayerGameInfo } from "@/bindings";

dayjs.extend(customParseFormat);

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const mocks = vi.hoisted(() => ({
  getOpeningFromName: vi.fn(),
  treeProps: [] as { name: string; sources: unknown[] }[],
}));
vi.mock("@/components/databases/PlayerOpeningTree", () => ({
  AccountOpeningTree: (props: { name: string; sources: unknown[] }) => {
    mocks.treeProps.push(props);
    return <div data-testid="account-opening-tree">{props.name}</div>;
  },
}));
vi.mock("@mantine/core", () => {
  const Container = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;
  return {
    Box: Container,
    Divider: () => <hr />,
    Group: Container,
    ScrollArea: Container,
    // Both choice controls render one button per option, named after its value.
    SegmentedControl: ({
      data,
      onChange,
      "aria-label": label,
    }: {
      data: { value: string; label: string }[];
      onChange: (value: string) => void;
      "aria-label": string;
    }) => (
      <div role="radiogroup" aria-label={label}>
        {data.map((option) => (
          <button
            key={option.value}
            data-view={option.value}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    ),
    Select: ({
      data,
      onChange,
    }: {
      data: { value: string; label: string }[];
      onChange: (value: string) => void;
    }) => (
      <>
        {data.map((option) => (
          <button
            key={option.value}
            data-sort={option.value}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </>
    ),
    Stack: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
      <div {...props}>{children}</div>
    ),
    Text: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
    UnstyledButton: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
      <button type="button" {...props}>
        {children}
      </button>
    ),
  };
});
vi.mock("recharts", () => ({
  Bar: ({ dataKey, stackId }: { dataKey: string; stackId?: string }) => (
    <div data-testid="activity-bar" data-key={dataKey} data-stack={stackId} />
  ),
  BarChart: ({ data, children }: { data: MonthResults[]; children: React.ReactNode }) => (
    <>
      <div data-testid="month-data">{JSON.stringify(data)}</div>
      {children}
    </>
  ),
  Area: ({ name }: { name: string }) => <span data-testid="rating-series">{name}</span>,
  AreaChart: ({
    data,
    children,
  }: {
    data: { date: number; player_elo: number }[];
    children: React.ReactNode;
  }) => (
    <>
      <div data-testid="rating-data">{data.map((row) => row.player_elo).join("|")}</div>
      {children}
    </>
  ),
  CartesianGrid: () => null,
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Tooltip: () => null,
  XAxis: () => null,
  YAxis: () => null,
}));
vi.mock("./ResultsChart", () => ({
  default: ({
    won,
    draw,
    lost,
    playerPerspective,
  }: {
    won: number;
    draw: number;
    lost: number;
    playerPerspective?: boolean;
  }) => (
    <div data-testid="result-counts" data-perspective={playerPerspective ? "player" : "board"}>
      {won}:{draw}:{lost}
      {playerPerspective ? " Wins/Losses" : " WhiteWon/BlackWon"}
    </div>
  ),
}));
vi.mock("./LastGamesList", () => ({
  default: () => <div data-testid="last-games">last-games</div>,
}));
vi.mock("./TimeControlSelector", () => ({
  default: ({ onTimeControlChange }: { onTimeControlChange: (value: string) => void }) => (
    <>
      <button data-testid="select-rapid" onClick={() => onTimeControlChange("rapid")}>
        Rapid
      </button>
      <button data-testid="select-any" onClick={() => onTimeControlChange("any")}>
        Any
      </button>
    </>
  ),
}));
vi.mock("./WebsiteAccountSelector", () => ({
  default: ({
    onWebsiteChange,
    onAccountChange,
  }: {
    onWebsiteChange: (value: string) => void;
    onAccountChange: (value: string) => void;
  }) => (
    <>
      <button data-testid="select-all-websites" onClick={() => onWebsiteChange("All websites")}>
        All websites
      </button>
      <button data-testid="select-lichess" onClick={() => onWebsiteChange("Lichess")}>
        Lichess
      </button>
      <button data-testid="select-second-account" onClick={() => onAccountChange("Second")}>
        Second
      </button>
    </>
  ),
}));
vi.mock("./DateRangeTabs", () => ({
  DateRange: {
    SevenDays: "7d",
    ThirtyDays: "30d",
    NinetyDays: "90d",
    OneYear: "1y",
    AllTime: "all",
  },
  default: ({ onTimeRangeChange }: { onTimeRangeChange: (value: string | null) => void }) => (
    <>
      <button data-testid="select-seven-days" onClick={() => onTimeRangeChange("7d")}>
        Seven days
      </button>
      <button data-testid="select-thirty-days" onClick={() => onTimeRangeChange("30d")}>
        30d
      </button>
      <button data-testid="select-ninety-days" onClick={() => onTimeRangeChange("90d")}>
        90d
      </button>
      <button data-testid="select-one-year" onClick={() => onTimeRangeChange("1y")}>
        1y
      </button>
    </>
  ),
}));
vi.mock("./TimeRangeSlider", () => ({
  default: ({
    ratingDates,
    onDateRangeChange,
  }: {
    ratingDates: number[];
    onDateRangeChange: (range: { start: number; end: number }) => void;
  }) => (
    <>
      <div data-testid="rating-dates">{ratingDates.join("|")}</div>
      <button
        data-testid="manual-full-range"
        type="button"
        onClick={() => onDateRangeChange({ start: 0, end: ratingDates.length - 1 })}
      >
        full
      </button>
      <button
        data-testid="manual-narrow-range"
        type="button"
        onClick={() => onDateRangeChange({ start: 1, end: ratingDates.length - 1 })}
      >
        narrow
      </button>
    </>
  ),
}));
vi.mock("@/platform/tauri", () => ({ tauri: { getOpeningFromName: mocks.getOpeningFromName } }));
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
vi.mock("@/utils/tabs", () => ({
  createTab: vi.fn(),
  runTabCreation: vi.fn(async ({ create }: { create: () => Promise<unknown> }) => create()),
}));
vi.mock("@/utils/treeReducer", () => ({ countMainPly: vi.fn(), defaultTree: vi.fn() }));

import OpeningsPanel from "./OpeningsPanel";
import OverviewPanel, { fillMissingMonths } from "./OverviewPanel";
import RatingsPanel from "./RatingsPanel";
import type { MonthResults } from "./overviewStatistics";

function timezoneStubTakesEffect(): boolean {
  try {
    vi.stubEnv("TZ", "America/New_York");
    const newYorkOffset = new Date(2026, 0, 1).getTimezoneOffset();
    vi.stubEnv("TZ", "Asia/Tokyo");
    const tokyoOffset = new Date(2026, 0, 1).getTimezoneOffset();
    return newYorkOffset === 300 && tokyoOffset === -540;
  } finally {
    vi.unstubAllEnvs();
  }
}

// Stryker forces a thread pool, where TZ stubs cannot change the process timezone.
const canStubTimezone = timezoneStubTakesEffect();

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
      colors: [
        {
          time_control: "600+0",
          is_player_white: true,
          won: 2,
          drawn: 1,
          lost: 0,
          rated_won: 0,
          rated_drawn: 0,
          rated_lost: 0,
          opponent_elo_sum: 0,
        },
        {
          time_control: "600+0",
          is_player_white: false,
          won: 0,
          drawn: 0,
          lost: 1,
          rated_won: 0,
          rated_drawn: 0,
          rated_lost: 0,
          opponent_elo_sum: 0,
        },
      ],
      latest: [],
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
      colors: [
        {
          time_control: "600+0",
          is_player_white: true,
          won: 1,
          drawn: 0,
          lost: 1,
          rated_won: 0,
          rated_drawn: 0,
          rated_lost: 0,
          opponent_elo_sum: 0,
        },
      ],
      latest: [],
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
      colors: [],
      latest: [],
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
      colors: [],
      latest: [],
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

describe.runIf(canStubTimezone).each(["America/New_York", "Europe/Berlin"])(
  "fillMissingMonths in %s",
  (timezone) => {
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
        const results = (rows: { name: string; count: number }[]): MonthResults[] =>
          rows.map((row) => ({ ...row, won: row.count, drawn: 0, lost: 0 }));
        expect(fillMissingMonths(results(input))).toEqual(results(expected));
      } finally {
        vi.unstubAllEnvs();
      }
    });
  },
);

test("Overview sums duplicate daily keys into result totals and month buckets", async () => {
  await render(<OverviewPanel playerKey="Magnus" info={duplicatedDailyStatistics} isDatabase />);

  expect(container.textContent).toContain("6 Common.Games");
  expect(container.querySelector("[data-testid='result-counts']")?.textContent).toContain("3:1:2");
  expect(JSON.parse(container.querySelector("[data-testid='month-data']")!.textContent!)).toEqual([
    { name: "2026-09", count: 5, won: 3, drawn: 1, lost: 1 },
    { name: "2026-10", count: 1, won: 0, drawn: 0, lost: 1 },
  ]);
  expect(
    Array.from(container.querySelectorAll("[data-testid='activity-bar']"), (bar) => ({
      key: bar.getAttribute("data-key"),
      stack: bar.getAttribute("data-stack"),
    })),
  ).toEqual([
    { key: "won", stack: "result" },
    { key: "drawn", stack: "result" },
    { key: "lost", stack: "result" },
  ]);
});

test("Overview year aggregation beyond 36 months preserves each result sum", async () => {
  const info: PlayerGameInfo = {
    site_stats_data: [
      {
        ...duplicatedDailyStatistics.site_stats_data[0],
        daily: [
          {
            date: "2022.01.01",
            time_control: "600+0",
            won: 2,
            drawn: 1,
            lost: 3,
            max_player_elo: 1800,
          },
          {
            date: "2022.12.01",
            time_control: "600+0",
            won: 1,
            drawn: 4,
            lost: 1,
            max_player_elo: 1800,
          },
          {
            date: "2025.01.01",
            time_control: "600+0",
            won: 5,
            drawn: 2,
            lost: 1,
            max_player_elo: 1800,
          },
        ],
      },
    ],
  };
  await render(<OverviewPanel playerKey="Magnus" info={info} isDatabase />);
  expect(JSON.parse(container.querySelector("[data-testid='month-data']")!.textContent!)).toEqual([
    { name: "2022", count: 12, won: 3, drawn: 5, lost: 4 },
    { name: "2023", count: 0, won: 0, drawn: 0, lost: 0 },
    { name: "2024", count: 0, won: 0, drawn: 0, lost: 0 },
    { name: "2025", count: 8, won: 5, drawn: 2, lost: 1 },
  ]);
});

test("fillMissingMonths preserves result fields and fills every result with zero", () => {
  expect(
    fillMissingMonths([
      { name: "2026-01", count: 6, won: 1, drawn: 2, lost: 3 },
      { name: "2026-03", count: 9, won: 4, drawn: 3, lost: 2 },
    ]),
  ).toEqual([
    { name: "2026-01", count: 6, won: 1, drawn: 2, lost: 3 },
    { name: "2026-02", count: 0, won: 0, drawn: 0, lost: 0 },
    { name: "2026-03", count: 9, won: 4, drawn: 3, lost: 2 },
  ]);
});

async function renderAllWebsitesRapid(Panel: typeof RatingsPanel | typeof OpeningsPanel) {
  const info: PlayerGameInfo = {
    site_stats_data: ["Chess.com", "Lichess"].map((site, index) => ({
      site,
      player: "Magnus",
      colors: [],
      latest: [],
      daily: [
        {
          date: index === 0 ? "2026.09.01" : "2026.10.01",
          time_control: "1800+0",
          won: index === 0 ? 2 : 7,
          drawn: 0,
          lost: 0,
          max_player_elo: index === 0 ? 1800 : 2200,
        },
      ],
      openings: [
        {
          time_control: "1800+0",
          is_player_white: true,
          opening: `${site} Opening`,
          won: index === 0 ? 2 : 7,
          drawn: 0,
          lost: 0,
        },
      ],
    })),
  };
  await render(<Panel playerKey="Magnus" info={info} />);
  await act(async () => {
    container.querySelector<HTMLButtonElement>("[data-testid='select-all-websites']")!.click();
    container.querySelector<HTMLButtonElement>("[data-testid='select-rapid']")!.click();
  });
}

test("RatingsPanel filters All websites rapid by each row's site", async () => {
  await renderAllWebsitesRapid(RatingsPanel);

  expect(container.querySelector("[data-testid='result-counts']")?.textContent).toContain("2:0:0");
  expect(container.textContent).toContain("2 Common.Games");
  expect(container.querySelector("[data-testid='rating-data']")?.textContent).toBe("1800");
  expect(container.querySelector("[data-testid='rating-dates']")?.textContent).toBe(
    [
      // Daily dates are parsed in local time, like parseCompleteDailyDate does.
      dayjs("2026.09.01", "YYYY.MM.DD", true).valueOf(),
      new Date(2026, 9, 2).getTime(),
    ].join("|"),
  );
});

test("RatingsPanel counts an unrated day's games but plots no rating for it", async () => {
  const info: PlayerGameInfo = {
    site_stats_data: [
      {
        site: "Chess.com",
        player: "Magnus",
        colors: [],
        latest: [],
        openings: [],
        daily: [
          {
            date: "2026.09.01",
            time_control: "1800+0",
            won: 1,
            drawn: 0,
            lost: 0,
            max_player_elo: 2100,
          },
          {
            date: "2026.09.02",
            time_control: "1800+0",
            won: 0,
            drawn: 1,
            lost: 2,
            max_player_elo: null,
          },
        ],
      },
    ],
  };
  await render(<RatingsPanel playerKey="Magnus" info={info} />);
  await act(async () => {
    container.querySelector<HTMLButtonElement>("[data-testid='select-all-websites']")!.click();
    container.querySelector<HTMLButtonElement>("[data-testid='select-rapid']")!.click();
  });

  expect(container.querySelector("[data-testid='result-counts']")?.textContent).toContain("1:1:2");
  expect(container.textContent).toContain("4 Common.Games");
  expect(container.querySelector("[data-testid='rating-data']")?.textContent).toBe("2100");
});

test("OpeningsPanel filters All websites rapid by each row's site", async () => {
  await renderAllWebsitesRapid(OpeningsPanel);

  expect(container.querySelector("[data-testid='result-counts']")?.textContent).toContain("2:0:0");
  expect(container.textContent).toContain("Chess.com Opening");
  expect(container.textContent).not.toContain("Lichess Opening");
});

test("Ratings sums duplicate daily keys and takes the highest rating for each date", async () => {
  await render(<RatingsPanel playerKey="Magnus" info={duplicatedDailyStatistics} isDatabase />);

  expect(container.textContent).toContain("6 Common.Games");
  expect(container.querySelector("[data-testid='result-counts']")?.textContent).toContain("3:1:2");
  expect(container.querySelector("[data-testid='rating-data']")?.textContent).toBe("2820|2810");
  expect(container.querySelector("[data-testid='rating-series']")?.textContent).toBe(
    "Home.Personal.Ratings.Rating",
  );
});

function ratingStatisticsForDates(dates: string[]): PlayerGameInfo {
  return {
    site_stats_data: [
      {
        ...duplicatedDailyStatistics.site_stats_data[0],
        daily: dates.map((date, index) => ({
          date,
          time_control: "600+0",
          won: 1,
          drawn: 0,
          lost: 0,
          max_player_elo: 1800 + index * 100,
        })),
      },
    ],
  };
}

describe.runIf(canStubTimezone).each(["Europe/Berlin", "America/New_York"])(
  "Ratings timeline in %s",
  (timezone) => {
    test.each([
      { name: "deduplicates today's game and anchor", dates: ["2026.10.01", "2026.10.02"] },
      { name: "anchors today without a same-day game", dates: ["2026.10.01"] },
    ])("$name", async ({ dates }) => {
      vi.stubEnv("TZ", timezone);
      try {
        const today = new Date(2026, 9, 2);
        expect(today.getTimezoneOffset()).not.toBe(0);

        await render(
          <RatingsPanel playerKey="Magnus" info={ratingStatisticsForDates(dates)} isDatabase />,
        );

        const stops = container
          .querySelector("[data-testid='rating-dates']")!
          .textContent!.split("|");
        expect(stops).toHaveLength(2);
        expect(Number(stops[stops.length - 1])).toBe(today.getTime());
      } finally {
        vi.unstubAllEnvs();
      }
    });
  },
);

test.runIf(canStubTimezone).each([
  // Each boundary midnight is CEST while today's is CET (Berlin DST ended 2025-10-26 03:00
  // and 2026-10-25 03:00), so fixed 24-hour arithmetic would exclude the boundary day.
  {
    name: "Seven Days",
    button: "select-seven-days",
    now: "2026-10-30",
    boundaryDate: "2026.10.23",
  },
  {
    name: "Thirty Days",
    button: "select-thirty-days",
    now: "2026-10-30",
    boundaryDate: "2026.09.30",
  },
  {
    name: "Ninety Days",
    button: "select-ninety-days",
    now: "2026-10-30",
    boundaryDate: "2026.08.01",
  },
  { name: "One Year", button: "select-one-year", now: "2026-10-26", boundaryDate: "2025.10.26" },
])(
  "Ratings $name includes the boundary day across Berlin's autumn DST change",
  async ({ button, now, boundaryDate }) => {
    vi.stubEnv("TZ", "Europe/Berlin");
    try {
      vi.setSystemTime(new Date(`${now}T12:00:00Z`));
      const boundary = dayjs(boundaryDate, "YYYY.MM.DD", true).toDate();
      expect(boundary.getTimezoneOffset()).toBe(-120);
      expect(dayjs().startOf("day").toDate().getTimezoneOffset()).toBe(-60);
      const earlierDay = dayjs().subtract(1, "day").format("YYYY.MM.DD");

      await render(
        <RatingsPanel
          playerKey="Magnus"
          info={ratingStatisticsForDates([boundaryDate, earlierDay])}
          isDatabase
        />,
      );
      await act(async () => {
        container.querySelector<HTMLButtonElement>(`[data-testid='${button}']`)!.click();
      });

      expect(container.textContent).toContain("2 Common.Games");
      expect(container.querySelector("[data-testid='rating-data']")?.textContent).toBe("1800|1900");
    } finally {
      vi.unstubAllEnvs();
    }
  },
);

test("Ratings excludes out-of-range days from the summary and rating series", async () => {
  await render(<RatingsPanel playerKey="Magnus" info={duplicatedDailyStatistics} isDatabase />);

  await act(async () => {
    container.querySelector<HTMLButtonElement>("[data-testid='select-seven-days']")?.click();
  });

  expect(container.textContent).toContain("1 Common.Games");
  expect(container.querySelector("[data-testid='result-counts']")?.textContent).toContain("0:0:1");
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
        colors: [
          {
            time_control: "600+0",
            is_player_white: true,
            won: 2,
            drawn: 0,
            lost: 1,
            rated_won: 0,
            rated_drawn: 0,
            rated_lost: 0,
            opponent_elo_sum: 0,
          },
        ],
        latest: [],
        openings: [],
      },
    ],
  };

  await render(<OverviewPanel playerKey="Magnus" info={partialDateStatistics} isDatabase />);
  expect(container.textContent).toContain("3 Common.Games");

  await render(<RatingsPanel playerKey="Magnus" info={partialDateStatistics} isDatabase />);
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
        colors: [
          {
            time_control: "600+0",
            is_player_white: true,
            won: 2,
            drawn: 0,
            lost: 1,
            rated_won: 0,
            rated_drawn: 0,
            rated_lost: 0,
            opponent_elo_sum: 0,
          },
        ],
        latest: [],
        openings: [],
      },
    ],
  };

  await render(<RatingsPanel playerKey="Magnus" info={mixedDateStatistics} isDatabase />);
  expect(container.textContent).toContain("3 Common.Games");

  await act(async () => {
    container.querySelector<HTMLButtonElement>("[data-testid='select-seven-days']")?.click();
  });

  expect(container.textContent).toContain("1 Common.Games");
  expect(container.querySelector("[data-testid='rating-data']")?.textContent).toBe("2650");
});

test("Ratings manual slider counts incomplete dates only on the full timeline", async () => {
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
        colors: [],
        latest: [],
        openings: [],
      },
    ],
  };

  await render(<RatingsPanel playerKey="Magnus" info={mixedDateStatistics} isDatabase />);
  expect(container.textContent).toContain("3 Common.Games");

  await act(async () => {
    container.querySelector<HTMLButtonElement>("[data-testid='manual-full-range']")?.click();
  });
  expect(container.textContent).toContain("3 Common.Games");

  await act(async () => {
    container.querySelector<HTMLButtonElement>("[data-testid='manual-narrow-range']")?.click();
  });
  // Dates always include today, so start: 1 also drops yesterday's dated game.
  // The assertion is that incomplete-date games are not counted.
  expect(container.textContent).toContain("0 Common.Games");
});

test("opening names are single-flight buttons", async () => {
  mocks.getOpeningFromName.mockReturnValueOnce(new Promise(() => {}));
  await render(<OpeningsPanel playerKey="Magnus" info={duplicatedOpeningStatistics} isDatabase />);
  const sicilian = [...container.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("Sicilian Defense"),
  )!;
  const french = [...container.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("French Defense"),
  )!;
  expect(sicilian.tagName).toBe("BUTTON");
  await act(async () => {
    sicilian.click();
    sicilian.click();
    french.click();
  });
  expect(mocks.getOpeningFromName).toHaveBeenCalledTimes(1);
});

test("Openings sums duplicate opening keys and retains each colour's results", async () => {
  await render(<OpeningsPanel playerKey="Magnus" info={duplicatedOpeningStatistics} isDatabase />);

  expect(container.textContent).toContain("Sicilian Defense");
  expect(container.textContent).toContain("French Defense");
  expect(container.textContent).toContain("Caro-Kann Defense");
  // Each row names its absolute count, its score and its labelled share of that colour's games.
  expect(
    Array.from(container.querySelectorAll("[data-opening-figures]"), (node) => node.textContent),
  ).toEqual([
    "5 Common.Games · Databases.OpeningTree.Score 70%Home.Personal.Openings.Share",
    "4 Common.Games · Databases.OpeningTree.Score 37.5%Home.Personal.Openings.Share",
    "1 Common.Games · Databases.OpeningTree.Score 50%Home.Personal.Openings.Share",
  ]);
  expect(
    Array.from(
      container.querySelectorAll("[data-testid='result-counts']"),
      (node) => node.textContent,
    ),
  ).toEqual(["3:1:1 Wins/Losses", "1:1:2 Wins/Losses", "0:1:0 Wins/Losses"]);
});

const mixedResultOverview: PlayerGameInfo = {
  site_stats_data: [
    {
      site: "Lichess",
      player: "Magnus",
      daily: [
        {
          date: "2026.01.01",
          time_control: "600+0",
          won: 2,
          drawn: 2,
          lost: 2,
          max_player_elo: 1800,
        },
      ],
      colors: [
        {
          time_control: "600+0",
          is_player_white: true,
          won: 2,
          drawn: 1,
          lost: 1,
          rated_won: 2,
          rated_drawn: 1,
          rated_lost: 1,
          opponent_elo_sum: 7200,
        },
        {
          time_control: "600+0",
          is_player_white: false,
          won: 0,
          drawn: 1,
          lost: 1,
          rated_won: 0,
          rated_drawn: 1,
          rated_lost: 1,
          opponent_elo_sum: 3400,
        },
      ],
      latest: [
        {
          time_control: "600+0",
          date: "2026.01.01",
          time: "18:00:00",
          game_id: 2,
          player_elo: 1750,
        },
      ],
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
          is_player_white: false,
          opening: "Caro-Kann Defense",
          won: 0,
          drawn: 1,
          lost: 1,
        },
      ],
    },
  ],
};

test("Overview mixed results keep per-colour games, score and W/D/L distinct", async () => {
  await render(<OverviewPanel playerKey="Magnus" info={mixedResultOverview} isDatabase />);

  const headline = container.querySelector("[data-testid='overview-headline']")?.textContent ?? "";
  expect(headline).toContain("6 Common.Games");
  expect(headline).toContain("50%");
  expect(headline).toContain("+2 =2 −2");
  expect(headline).toContain("Wins/Losses");
  expect(headline).not.toContain("WhiteWon");
  expect(headline).not.toContain("BlackWon");

  const white = container.querySelector("[data-testid='overview-white']")?.textContent ?? "";
  expect(white).toContain("4 Common.Games");
  expect(white).toContain("62.5%");
  expect(white).toContain("+2 =1 −1");

  const black = container.querySelector("[data-testid='overview-black']")?.textContent ?? "";
  expect(black).toContain("2 Common.Games");
  expect(black).toContain("25%");
  expect(black).toContain("+0 =1 −1");

  expect(
    Array.from(container.querySelectorAll("[data-testid='result-counts']"), (node) =>
      node.getAttribute("data-perspective"),
    ),
  ).toEqual(["player", "player", "player"]);
});

test("Overview last games appear only when a database player is passed", async () => {
  await render(<OverviewPanel playerKey="Magnus" info={mixedResultOverview} isDatabase />);
  expect(container.querySelector("[data-testid='last-games']")).toBeNull();

  await render(
    <OverviewPanel
      playerKey="Magnus"
      info={mixedResultOverview}
      isDatabase
      databasePlayer={{
        player: { id: 1, name: "Magnus", elo: null, game_count: 6 },
        file: { id: { id: "db-1" }, kind: "database" },
      }}
    />,
  );
  expect(container.querySelector("[data-testid='last-games']")?.textContent).toBe("last-games");
});

const openingRow = (opening: string, white: boolean, won: number, drawn: number, lost: number) => ({
  time_control: "600+0",
  is_player_white: white,
  opening,
  won,
  drawn,
  lost,
});
const sortableOpenings: PlayerGameInfo = {
  site_stats_data: [
    {
      site: "Lichess",
      player: "Magnus",
      daily: [],
      colors: [],
      latest: [],
      openings: [
        openingRow("W ten at 20%", true, 2, 0, 8),
        openingRow("W six at 50%", true, 3, 0, 3),
        openingRow("W five at 100%", true, 5, 0, 0),
        openingRow("W four at 0%", true, 0, 0, 4),
        openingRow("W two at 100%", true, 2, 0, 0),
        openingRow("B seven at 100%", false, 7, 0, 0),
        openingRow("B five at 0%", false, 0, 0, 5),
      ],
    },
  ],
};
function openingNames(prefix: string) {
  return Array.from(container.querySelectorAll("button"), (button) => button.textContent ?? "")
    .filter((name) => name.startsWith(`${prefix} `))
    .map((name) => name.slice(2));
}
async function press(selector: string) {
  await act(async () => container.querySelector<HTMLButtonElement>(selector)!.click());
}

test("Openings orders each colour by score with rarely played openings last", async () => {
  await render(<OpeningsPanel playerKey="Magnus" info={sortableOpenings} isDatabase />);
  expect(openingNames("W")).toEqual([
    "ten at 20%",
    "six at 50%",
    "five at 100%",
    "four at 0%",
    "two at 100%",
  ]);
  expect(openingNames("B")).toEqual(["seven at 100%", "five at 0%"]);

  await press("[data-sort='best']");
  expect(openingNames("W")).toEqual([
    "five at 100%",
    "six at 50%",
    "ten at 20%",
    "four at 0%",
    "two at 100%",
  ]);
  expect(openingNames("B")).toEqual(["seven at 100%", "five at 0%"]);

  await press("[data-sort='worst']");
  expect(openingNames("W")).toEqual([
    "ten at 20%",
    "six at 50%",
    "five at 100%",
    "four at 0%",
    "two at 100%",
  ]);
  expect(openingNames("B")).toEqual(["five at 0%", "seven at 100%"]);
});

const sourceInfo = (site: string, timeControls: string[]): PlayerGameInfo => ({
  site_stats_data: [
    {
      site,
      player: "ignored",
      daily: [],
      colors: [],
      latest: [],
      openings: timeControls.map((time_control) => ({
        ...openingRow("Any", true, 1, 0, 0),
        time_control,
      })),
    },
  ],
});
const handle = (id: string) => ({ kind: "database" as const, id: { id } });
const accountSources = [
  {
    key: "a:1",
    label: "Magnus on Lichess",
    file: handle("a"),
    player: 1,
    provider: "lichess" as const,
    username: "Magnus",
    // 600+0 and 900+10 are rapid on Lichess, 300+0 is blitz.
    info: sourceInfo("Lichess", ["600+0", "300+0", "900+10"]),
  },
  {
    key: "b:2",
    label: "Second on Lichess",
    file: handle("b"),
    player: 2,
    provider: "lichess" as const,
    username: "Second",
    info: sourceInfo("Lichess", ["60+0"]),
  },
  {
    key: "c:3",
    label: "Magnus on Chess.com",
    file: handle("c"),
    player: 3,
    provider: "chesscom" as const,
    username: "Magnus",
    // 600+0 is rapid on Chess.com, where 300+0 is blitz.
    info: sourceInfo("Chess.com", ["600+0", "300+0"]),
  },
];
const lastTreeSources = () => mocks.treeProps.at(-1)!.sources;

test("Openings offers the board only for account sources and replaces the list with it", async () => {
  await render(<OpeningsPanel playerKey="Magnus" info={sortableOpenings} isDatabase />);
  expect(container.querySelector("[data-view]")).toBeNull();

  mocks.treeProps.length = 0;
  await render(
    <OpeningsPanel
      playerKey="Magnus"
      name="GGalileo"
      info={sortableOpenings}
      sources={accountSources}
    />,
  );
  expect(container.querySelector("[data-testid='account-opening-tree']")).toBeNull();
  expect(openingNames("W")).toHaveLength(5);

  await press("[data-view='board']");
  expect(container.querySelector("[data-testid='account-opening-tree']")?.textContent).toBe(
    "GGalileo",
  );
  expect(openingNames("W")).toEqual([]);
  expect(container.querySelector("[data-sort]")).toBeNull();
  // Every account of the player is merged by default, without a time-control list.
  expect(lastTreeSources()).toEqual(
    accountSources.map(({ key, label, file, player }) => ({ key, label, file, player })),
  );

  await press("[data-view='list']");
  expect(container.querySelector("[data-testid='account-opening-tree']")).toBeNull();
  expect(openingNames("W")).toHaveLength(5);
});

test("the board's sources follow the website, account and time-control filters", async () => {
  mocks.treeProps.length = 0;
  await render(
    <OpeningsPanel
      playerKey="Magnus"
      name="GGalileo"
      info={sortableOpenings}
      sources={accountSources}
    />,
  );
  await press("[data-view='board']");

  await press("[data-testid='select-rapid']");
  // Each source gets its own matching raw values; one without any is left out.
  expect(lastTreeSources()).toEqual([
    expect.objectContaining({ key: "a:1", timeControls: ["600+0", "900+10"] }),
    expect.objectContaining({ key: "c:3", timeControls: ["600+0"] }),
  ]);

  await press("[data-testid='select-lichess']");
  expect(lastTreeSources()).toEqual([expect.objectContaining({ key: "a:1" })]);

  await press("[data-testid='select-second-account']");
  // The second account has no rapid game.
  expect(lastTreeSources()).toEqual([]);

  // "Any" is the absence of a filter, not a list of every known value.
  await press("[data-testid='select-any']");
  expect(lastTreeSources()).toEqual([
    { key: "b:2", label: "Second on Lichess", file: handle("b"), player: 2 },
  ]);
  await press("[data-testid='select-all-websites']");
  expect(lastTreeSources()).toEqual([
    { key: "b:2", label: "Second on Lichess", file: handle("b"), player: 2 },
  ]);
});
