import { Stack, Text } from "@mantine/core";
import dayjs from "dayjs";
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
import DateRangeTabs, { DateRange } from "./DateRangeTabs";
import { parseCompleteDailyDate, summarizeDailyStats } from "./dailyStatsSummary";
import { filterPlayerStats } from "./overviewStatistics";
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
      return dayjs(lastDate).subtract(7, "day").valueOf();
    case DateRange.ThirtyDays:
      return dayjs(lastDate).subtract(30, "day").valueOf();
    case DateRange.NinetyDays:
      return dayjs(lastDate).subtract(90, "day").valueOf();
    case DateRange.OneYear:
      return dayjs(lastDate).subtract(365, "day").valueOf();
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
  const { t, i18n } = useTranslation();
  const [dateRange, setDateRange] = useState<string | null>(DateRange.AllTime);
  const [timeControl, setTimeControl] = useState<string | null>(null);
  const [website, setWebsite] = useState<string | null>(null);
  const [account, setAccount] = useState<string | null>("All accounts");
  const [timeRange, setTimeRange] = useState({ start: 0, end: 0 });

  const dailyStats = useMemo(
    () =>
      filterPlayerStats(info, { website: website || "All websites", account, timeControl }).flatMap(
        (site) => site.daily,
      ),
    [info, website, account, timeControl],
  );

  const dates = useMemo(() => {
    // Match parseCompleteDailyDate's local-midnight convention.
    const today = dayjs().startOf("day").valueOf();
    return Array.from(
      new Set([
        today,
        ...dailyStats
          .map((day) => parseCompleteDailyDate(day.date))
          .filter((date): date is number => date !== null),
      ]),
    ).sort((a, b) => a - b);
  }, [dailyStats]);

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
    const filteredDailyStats = dailyStats.filter((day) => {
      const gameDate = parseCompleteDailyDate(day.date);
      // Incomplete dates cannot be placed on the slider; count them only for
      // All time, or a manual slider covering the whole timeline.
      if (gameDate === null) {
        return (
          dateRange === DateRange.AllTime ||
          (dateRange === null && timeRange.start === 0 && timeRange.end === dates.length - 1)
        );
      }
      return gameDate >= (dates[timeRange.start] || 0) && gameDate <= (dates[timeRange.end] || 0);
    });

    const summary = summarizeDailyStats(filteredDailyStats);

    const ratingData = (() => {
      const map = new Map<number, { date: number; player_elo: number }>();
      for (const day of filteredDailyStats) {
        const date = parseCompleteDailyDate(day.date);
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
  }, [dailyStats, timeRange, dates, dateRange]);

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
            <ResultsChart
              won={summary.won}
              draw={summary.draw}
              lost={summary.lost}
              size="2rem"
              playerPerspective
            />
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
                tickFormatter={(date) => new Date(date).toLocaleDateString(i18n.language)}
                type="number"
              />
              {playerEloDomain == null && <YAxis />}
              {playerEloDomain != null && <YAxis domain={playerEloDomain} />}
              <Tooltip
                contentStyle={tooltipContentStyle}
                cursor={tooltipCursorStyle}
                labelFormatter={(label) => new Date(label).toLocaleDateString(i18n.language)}
              />
              <Area
                name={t("Home.Personal.Ratings.Rating")}
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
