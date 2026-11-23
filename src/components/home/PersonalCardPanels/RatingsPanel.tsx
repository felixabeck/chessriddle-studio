import { Stack, Text } from "@mantine/core";
import dayjs from "dayjs";
import { useMemo, useState } from "react";
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
import type { AccountSite } from "@/utils/session";
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
  playerKey,
  info,
  isDatabase,
  onlineFilters,
}: {
  playerKey: string;
  info: PlayerGameInfo;
  isDatabase?: boolean;
  /**
   * A database player's online games: ratings of different sites and time controls are different
   * scales, so the curve shows one site's one category, starting with the one with the most
   * rated games.
   */
  onlineFilters?: {
    sites: AccountSite[];
    initial: { website: string; timeControl: string } | null;
  };
}) {
  const { t, i18n } = useTranslation();
  const [dateRange, setDateRange] = useState<string | null>(DateRange.AllTime);
  // The online line's category from the first render: the selector reports it only after mount.
  const [timeControl, setTimeControl] = useState<string | null>(
    onlineFilters?.initial?.timeControl ?? null,
  );
  const [website, setWebsite] = useState<string | null>(onlineFilters?.initial?.website ?? null);
  const [account, setAccount] = useState<string | null>("All accounts");
  // A manual slider range is only meaningful against the dates it was picked on.
  const [manualRange, setManualRange] = useState<{
    start: number;
    end: number;
    dates: number[];
  } | null>(null);

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

  const timeRange = useMemo(() => {
    if (dateRange) {
      const earliestDate = calculateEarliestDate(dateRange as DateRange, dates);
      const earliestIndex = dates.findIndex((date) => date >= earliestDate);
      return { start: earliestIndex, end: dates.length - 1 };
    }
    if (manualRange?.dates === dates) {
      return { start: manualRange.start, end: manualRange.end };
    }
    return { start: 0, end: dates.length > 0 ? dates.length - 1 : 0 };
  }, [dateRange, dates, manualRange]);

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
        const playerElo = day.max_player_elo;
        // A day with only unrated games has no rating point.
        if (date === null || playerElo === null) continue;
        if (!map.has(date) || map.get(date)!.player_elo < playerElo) {
          map.set(date, { date, player_elo: playerElo });
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
      {(!isDatabase || onlineFilters) && (
        <div className={filterClasses.filters}>
          {(!onlineFilters || onlineFilters.sites.length > 1) && (
            <WebsiteAccountSelector
              playerKey={playerKey}
              onWebsiteChange={setWebsite}
              onAccountChange={setAccount}
              allowAll={false}
              sites={onlineFilters?.sites}
              initialWebsite={onlineFilters?.initial?.website}
            />
          )}
          <TimeControlSelector
            onTimeControlChange={setTimeControl}
            website={website}
            allowAll={false}
            initialTimeControl={onlineFilters?.initial?.timeControl}
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
              setManualRange({ ...range, dates });
            }}
          />
        </>
      )}
    </Stack>
  );
}

export default RatingsPanel;
