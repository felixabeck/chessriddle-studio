import { Stack, Text } from "@mantine/core";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { PlayerGameInfo } from "@/bindings";
import { getTimeControl } from "@/utils/timeControl";
import DateRangeTabs, { DateRange } from "./DateRangeTabs";
import { completeDailyDate, summarizeDailyStats } from "./dailyStatsSummary";
import {
  gradientStops,
  linearGradientProps,
  tooltipContentStyle,
  tooltipCursorStyle,
} from "./RatingsPanel.styles";
import ResultsChart from "./ResultsChart";
import filterClasses from "./StatisticsFilters.module.css";
import TimeControlSelector from "./TimeControlSelector";
import TimeRangeSlider from "./TimeRangeSlider";
import WebsiteAccountSelector from "./WebsiteAccountSelector";

function calculateEarliestDate(dateRange: DateRange, ratingDates: number[]): number {
  const lastDate = ratingDates[ratingDates.length - 1];
  switch (dateRange) {
    case DateRange.SevenDays:
      return lastDate - 7 * 24 * 60 * 60 * 1000;
    case DateRange.ThirtyDays:
      return lastDate - 30 * 24 * 60 * 60 * 1000;
    case DateRange.NinetyDays:
      return lastDate - 90 * 24 * 60 * 60 * 1000;
    case DateRange.OneYear:
      return lastDate - 365 * 24 * 60 * 60 * 1000;
    default:
      return Math.min(...ratingDates);
  }
}

function RatingsPanel({
  playerName,
  info,
  isDatabase,
}: {
  playerName: string;
  info: PlayerGameInfo;
  isDatabase?: boolean;
}) {
  const { t } = useTranslation();
  const [dateRange, setDateRange] = useState<string | null>(DateRange.AllTime);
  const [timeControl, setTimeControl] = useState<string | null>(null);
  const [website, setWebsite] = useState<string | null>(null);
  const [account, setAccount] = useState<string | null>("All accounts");
  const [timeRange, setTimeRange] = useState({ start: 0, end: 0 });

  const dates = useMemo(() => {
    const timezoneOffset = new Date().getTimezoneOffset() * 60 * 1000; // milliseconds
    const localDate = new Date(Date.now() - timezoneOffset);
    const todayString = localDate.toISOString().slice(0, 10);
    const today = new Date(todayString).getTime();
    return Array.from(
      new Set([
        today,
        ...info.site_stats_data
          .filter((games) => !website || games.site === website)
          .filter((games) => account === "All accounts" || games.player === account)
          .flatMap((games) => games.daily)
          .filter(
            (day) => !timeControl || getTimeControl(website, day.time_control) === timeControl,
          )
          .map((day) => completeDailyDate(day.date))
          .filter((date): date is number => date !== null),
      ]),
    ).sort((a, b) => a - b);
  }, [info.site_stats_data, website, account, timeControl]);

  useEffect(() => {
    if (dateRange) {
      const earliestDate = calculateEarliestDate(dateRange as DateRange, dates);
      const earliestIndex = dates.findIndex((date) => date >= earliestDate);
      setTimeRange({ start: earliestIndex, end: dates.length - 1 });
    } else {
      setTimeRange({ start: 0, end: dates.length > 0 ? dates.length - 1 : 0 });
    }
  }, [dateRange, dates]);

  const [summary, ratingData] = useMemo(() => {
    const filteredDailyStats =
      info.site_stats_data
        .filter((games) => !website || games.site === website)
        .filter((games) => account === "All accounts" || games.player === account)
        .flatMap((games) => games.daily)
        .filter((day) => !timeControl || getTimeControl(website!, day.time_control) === timeControl)
        .filter((day) => {
          const gameDate = completeDailyDate(day.date);
          // Incomplete dates cannot be placed on the slider; include them only
          // when the selected range is the whole domain.
          if (gameDate === null) {
            return timeRange.start === 0 && timeRange.end === dates.length - 1;
          }
          return (
            gameDate >= (dates[timeRange.start] || 0) && gameDate <= (dates[timeRange.end] || 0)
          );
        }) ?? [];

    const summary = summarizeDailyStats(filteredDailyStats);

    const ratingData = (() => {
      const map = new Map<number, { date: number; player_elo: number }>();
      for (const day of filteredDailyStats) {
        const date = completeDailyDate(day.date);
        if (date === null) continue;
        if (!map.has(date) || map.get(date)!.player_elo < day.max_player_elo) {
          map.set(date, { date, player_elo: day.max_player_elo });
        }
      }
      return Array.from(map.values()).sort((a, b) => a.date - b.date);
    })();

    return [
      { games: summary.total, won: summary.won, draw: summary.draw, lost: summary.lost },
      ratingData,
    ];
  }, [info.site_stats_data, website, account, timeControl, timeRange, dates]);

  const playerEloDomain =
    ratingData.length === 0
      ? null
      : ratingData.reduce(
          ([min, max], { player_elo }) => [
            Math.floor(Math.min(min, player_elo) / 50) * 50,
            Math.ceil(Math.max(max, player_elo) / 50) * 50,
          ],
          [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY],
        );

  return (
    <Stack>
      {!isDatabase && (
        <div className={filterClasses.filters}>
          <WebsiteAccountSelector
            playerName={playerName}
            onWebsiteChange={setWebsite}
            onAccountChange={setAccount}
            allowAll={false}
          />
          <TimeControlSelector
            onTimeControlChange={setTimeControl}
            website={website}
            allowAll={false}
          />
        </div>
      )}
      <DateRangeTabs timeRange={dateRange} onTimeRangeChange={setDateRange} />

      <Text pt="md" fw="bold" fz="lg" ta="center">
        {summary.games} {t("Common.Games")}
      </Text>
      {dates.length > 1 && (
        <>
          {summary.games > 0 && (
            <ResultsChart won={summary.won} draw={summary.draw} lost={summary.lost} size="2rem" />
          )}
          <ResponsiveContainer width="100%" height={300}>
            <AreaChart data={ratingData}>
              <defs>
                <linearGradient {...linearGradientProps}>
                  {gradientStops.map((stopProps, index) => (
                    <stop key={index} {...stopProps} />
                  ))}
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3" vertical={false} />
              <XAxis
                dataKey="date"
                domain={[dates[timeRange.start], dates[timeRange.end]]}
                tickFormatter={(date) => new Date(date).toLocaleDateString()}
                type="number"
              />
              {playerEloDomain == null && <YAxis />}
              {playerEloDomain != null && <YAxis domain={playerEloDomain} />}
              <Tooltip
                contentStyle={tooltipContentStyle}
                cursor={tooltipCursorStyle}
                labelFormatter={(label) => new Date(label).toLocaleDateString()}
              />
              <Area
                name="Rating"
                dataKey="player_elo"
                type="monotone"
                stroke="var(--cf-primary)"
                strokeWidth={2}
                strokeOpacity={1}
                fillOpacity={0.25}
                fill={`url(#${linearGradientProps.id})`}
              />
            </AreaChart>
          </ResponsiveContainer>
          <TimeRangeSlider
            ratingDates={dates}
            dateRange={timeRange}
            onDateRangeChange={(range) => {
              setDateRange(null);
              setTimeRange(range);
            }}
          />
        </>
      )}
    </Stack>
  );
}

export default RatingsPanel;
