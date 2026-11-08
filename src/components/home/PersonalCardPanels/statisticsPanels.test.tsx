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
    Stack: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
      <div {...props}>{children}</div>
    ),
    Text: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
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
    <button data-testid="select-rapid" onClick={() => onTimeControlChange("rapid")}>
      Rapid
    </button>
  ),
}));
vi.mock("./WebsiteAccountSelector", () => ({
  default: ({ onWebsiteChange }: { onWebsiteChange: (value: string) => void }) => (
    <button data-testid="select-all-websites" onClick={() => onWebsiteChange("All websites")}>
      All websites
    </button>
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
    <button data-testid="select-seven-days" onClick={() => onTimeRangeChange("7d")}>
      Seven days
    </button>
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
import type { MonthResults } from "./overviewStatistics";

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
      const results = (rows: { name: string; count: number }[]): MonthResults[] =>
        rows.map((row) => ({ ...row, won: row.count, drawn: 0, lost: 0 }));
      expect(fillMissingMonths(results(input))).toEqual(results(expected));
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

test("Overview sums duplicate daily keys into result totals and month buckets", async () => {
  await render(<OverviewPanel playerName="Magnus" info={duplicatedDailyStatistics} isDatabase />);

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
  await render(<OverviewPanel playerName="Magnus" info={info} isDatabase />);
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

test.each([RatingsPanel, OpeningsPanel])(
  "%s filters All websites rapid by each row's site",
  async (Panel) => {
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
    await render(<Panel playerName="Magnus" info={info} />);
    await act(async () => {
      container.querySelector<HTMLButtonElement>("[data-testid='select-all-websites']")!.click();
      container.querySelector<HTMLButtonElement>("[data-testid='select-rapid']")!.click();
    });
    expect(container.querySelector("[data-testid='result-counts']")?.textContent).toContain(
      "2:0:0",
    );
    if (Panel === RatingsPanel) {
      expect(container.textContent).toContain("2 Common.Games");
      expect(container.querySelector("[data-testid='rating-data']")?.textContent).toBe("1800");
      expect(container.querySelector("[data-testid='rating-dates']")?.textContent).toBe(
        [
          // Daily dates are parsed in local time, like parseCompleteDailyDate does.
          dayjs("2026.09.01", "YYYY.MM.DD", true).valueOf(),
          new Date("2026-10-02T00:00:00Z").getTime(),
        ].join("|"),
      );
    } else {
      expect(container.textContent).toContain("Chess.com Opening");
      expect(container.textContent).not.toContain("Lichess Opening");
    }
  },
);

test("Ratings sums duplicate daily keys and takes the highest rating for each date", async () => {
  await render(<RatingsPanel playerName="Magnus" info={duplicatedDailyStatistics} isDatabase />);

  expect(container.textContent).toContain("6 Common.Games");
  expect(container.querySelector("[data-testid='result-counts']")?.textContent).toContain("3:1:2");
  expect(container.querySelector("[data-testid='rating-data']")?.textContent).toBe("2820|2810");
});

test("Ratings excludes out-of-range days from the summary and rating series", async () => {
  await render(<RatingsPanel playerName="Magnus" info={duplicatedDailyStatistics} isDatabase />);

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

  await render(<RatingsPanel playerName="Magnus" info={mixedDateStatistics} isDatabase />);
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

  await render(<RatingsPanel playerName="Magnus" info={mixedDateStatistics} isDatabase />);
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
  await render(<OverviewPanel playerName="Magnus" info={mixedResultOverview} isDatabase />);

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
  await render(<OverviewPanel playerName="Magnus" info={mixedResultOverview} isDatabase />);
  expect(container.querySelector("[data-testid='last-games']")).toBeNull();

  await render(
    <OverviewPanel
      playerName="Magnus"
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
