import { Group, Stack, Text } from "@mantine/core";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  type TooltipContentProps,
  XAxis,
  YAxis,
} from "recharts";
import type { NameType, ValueType } from "recharts/types/component/DefaultTooltipContent";
import type { DatabaseHandle, Player, PlayerGameInfo } from "@/bindings";
import LastGamesList from "./LastGamesList";
import ResultsChart from "./ResultsChart";
import filterClasses from "./StatisticsFilters.module.css";
import TimeControlSelector from "./TimeControlSelector";
import WebsiteAccountSelector from "./WebsiteAccountSelector";
import {
  type ColorOverview,
  type MonthResults,
  deriveOverviewStatistics,
  filterPlayerStats,
  formatResultCounts,
  formatScorePercent,
} from "./overviewStatistics";

export function fillMissingMonths(data: MonthResults[]): MonthResults[] {
  const validData = data.filter(({ name }) => /^\d{4}-(0[1-9]|1[0-2])$/.test(name));
  if (validData.length === 0) return [];

  validData.sort((a, b) => a.name.localeCompare(b.name));

  const monthStrings: string[] = [];
  const [startYear, startMonth] = validData[0].name.split("-").map(Number);
  const [endYear, endMonth] = validData[validData.length - 1].name.split("-").map(Number);
  const lastMonth = endYear * 12 + endMonth - 1;

  for (let month = startYear * 12 + startMonth - 1; month <= lastMonth; month++) {
    const year = Math.floor(month / 12);
    const monthOfYear = (month % 12) + 1;
    monthStrings.push(
      `${year.toString().padStart(4, "0")}-${monthOfYear.toString().padStart(2, "0")}`,
    );
  }

  const dataMap = new Map(validData.map((item) => [item.name, item]));
  return monthStrings.map(
    (month) => dataMap.get(month) ?? { name: month, count: 0, won: 0, drawn: 0, lost: 0 },
  );
}

function mergeYears(data: MonthResults[]): MonthResults[] {
  const yearCounts = new Map<string, MonthResults>();

  for (const item of data) {
    const year = item.name.slice(0, 4);
    const previous = yearCounts.get(year);
    if (!previous) {
      yearCounts.set(year, { ...item, name: year });
      continue;
    }
    yearCounts.set(year, {
      name: year,
      count: previous.count + item.count,
      won: previous.won + item.won,
      drawn: previous.drawn + item.drawn,
      lost: previous.lost + item.lost,
    });
  }

  return Array.from(yearCounts.values());
}

function OverviewPanel({
  playerName,
  info,
  isDatabase,
  databasePlayer,
}: {
  playerName: string;
  info: PlayerGameInfo;
  isDatabase?: boolean;
  databasePlayer?: { player: Player; file: DatabaseHandle };
}) {
  const { t } = useTranslation();
  const [website, setWebsite] = useState<string | null>("All websites");
  const [account, setAccount] = useState<string | null>("All accounts");
  const [timeControl, setTimeControl] = useState<string | null>(null);

  const stats = deriveOverviewStatistics(
    filterPlayerStats(info, { website, account, timeControl }),
  );

  return (
    <Stack>
      <div className={filterClasses.filters}>
        {!isDatabase && (
          <WebsiteAccountSelector
            playerName={playerName}
            onWebsiteChange={(website) => setWebsite(website)}
            onAccountChange={setAccount}
            allowAll={true}
          />
        )}
        <TimeControlSelector
          website={website}
          onTimeControlChange={setTimeControl}
          allowAll={true}
        />
      </div>

      <Stack gap="xs" data-testid="overview-headline" pt="md">
        <Text fw="bold" fz="lg" ta="center">
          {stats.total.games} {t("Common.Games")}
        </Text>
        {stats.total.games > 0 && (
          <>
            <Group justify="center" gap="md" wrap="wrap">
              <Text fw={500}>
                {formatScorePercent(stats.total.won, stats.total.drawn, stats.total.lost)}
              </Text>
              <Text>
                {formatResultCounts(stats.total.won, stats.total.drawn, stats.total.lost)}
              </Text>
            </Group>
            <ResultsChart
              won={stats.total.won}
              draw={stats.total.drawn}
              lost={stats.total.lost}
              size="2rem"
              playerPerspective
            />
          </>
        )}
      </Stack>

      <ColorRow
        testId="overview-white"
        label={t("Home.Personal.Overview.AsWhite")}
        empty={t("Home.Personal.Overview.NoGamesAsWhite")}
        color={stats.white}
        gamesLabel={t("Common.Games")}
      />
      <ColorRow
        testId="overview-black"
        label={t("Home.Personal.Overview.AsBlack")}
        empty={t("Home.Personal.Overview.NoGamesAsBlack")}
        color={stats.black}
        gamesLabel={t("Common.Games")}
      />

      {(stats.peakRating !== null || stats.latestRating !== null) && (
        <Group justify="center" gap="lg" wrap="wrap" data-testid="overview-ratings">
          {stats.peakRating !== null && (
            <Text size="sm">
              {t("Home.Personal.Overview.PeakRating")}: {stats.peakRating}
            </Text>
          )}
          {stats.latestRating !== null && (
            <Text size="sm">
              {t("Home.Personal.Overview.LatestRating")}: {stats.latestRating}
            </Text>
          )}
        </Group>
      )}

      {stats.total.ratedGames > 0 && (
        <Stack gap={4} data-testid="overview-opponents">
          <OpponentLine color={stats.total} />
          {stats.white.ratedGames > 0 && (
            <OpponentLine color={stats.white} prefix={t("Home.Personal.Overview.AsWhite")} />
          )}
          {stats.black.ratedGames > 0 && (
            <OpponentLine color={stats.black} prefix={t("Home.Personal.Overview.AsBlack")} />
          )}
        </Stack>
      )}

      {stats.total.games > 0 && <DateChart dataPerMonth={stats.months} />}

      {(stats.whiteOpenings.length > 0 || stats.blackOpenings.length > 0) && (
        <Stack gap="xs">
          <Text fw={500} ta="center">
            {t("Home.Personal.Overview.TopOpenings")}
          </Text>
          <Group grow align="flex-start" wrap="wrap">
            <OpeningColumn
              testId="overview-openings-white"
              title={t("Fen.White")}
              openings={stats.whiteOpenings}
            />
            <OpeningColumn
              testId="overview-openings-black"
              title={t("Fen.Black")}
              openings={stats.blackOpenings}
            />
          </Group>
        </Stack>
      )}

      {databasePlayer && <LastGamesList {...databasePlayer} />}
    </Stack>
  );
}

function ColorRow({
  testId,
  label,
  empty,
  color,
  gamesLabel,
}: {
  testId: string;
  label: string;
  empty: string;
  color: ColorOverview;
  gamesLabel: string;
}) {
  return (
    <Stack gap={4} data-testid={testId}>
      <Group justify="space-between" wrap="wrap" gap="xs">
        <Text fw={500}>{label}</Text>
        {color.games === 0 ? (
          <Text size="sm" c="dimmed">
            {empty}
          </Text>
        ) : (
          <Text size="sm">
            {color.games} {gamesLabel} {formatScorePercent(color.won, color.drawn, color.lost)}{" "}
            {formatResultCounts(color.won, color.drawn, color.lost)}
          </Text>
        )}
      </Group>
      {color.games > 0 && (
        <ResultsChart
          won={color.won}
          draw={color.drawn}
          lost={color.lost}
          size="1rem"
          playerPerspective
        />
      )}
    </Stack>
  );
}

function OpponentLine({ color, prefix }: { color: ColorOverview; prefix?: string }) {
  const { t } = useTranslation();
  if (color.averageOpponent === null || color.performance === null) return null;
  const body = `${t("Home.Personal.Overview.AverageOpponent")} ${Math.round(color.averageOpponent)} · ${t("Home.Personal.Overview.Performance")} ${Math.round(color.performance)} · ${t("Home.Personal.Overview.RatedGames", { rated: color.ratedGames })}`;
  return (
    <Text size="sm" ta="center">
      {prefix ? `${prefix}: ${body}` : body}
    </Text>
  );
}

function OpeningColumn({
  testId,
  title,
  openings,
}: {
  testId: string;
  title: string;
  openings: { name: string; games: number; won: number; draw: number; lost: number }[];
}) {
  return (
    <Stack gap={4} data-testid={testId} style={{ minWidth: 0 }}>
      <Text ta="center" fw={500}>
        {title}
      </Text>
      {openings.map((opening) => (
        <Group key={opening.name} justify="space-between" wrap="nowrap" gap="xs">
          <Text size="sm" lineClamp={2} style={{ minWidth: 0 }}>
            {opening.name}
          </Text>
          <Text size="sm" style={{ flexShrink: 0 }}>
            {opening.games} {formatScorePercent(opening.won, opening.draw, opening.lost)}
          </Text>
        </Group>
      ))}
    </Stack>
  );
}

const DateChartTooltip = ({
  active,
  payload,
  label,
  isYearSelected,
}: TooltipContentProps<ValueType, NameType> & { isYearSelected: boolean }) => {
  const { t } = useTranslation();
  if (active && payload && payload.length) {
    return (
      <div
        style={{
          backgroundColor: "var(--mantine-color-body)",
          boxShadow: "var(--mantine-shadow-md)",
          borderRadius: "var(--mantine-radius-default)",
          border: "calc(0.0625rem* var(--mantine-scale)) solid var(--mantine-color-default-border)",
          padding: "10px",
        }}
      >
        <p style={{ margin: "0" }}>{`${label}`}</p>
        {payload.map((entry) => (
          <p
            key={String(entry.dataKey)}
            style={{
              color: typeof entry.color === "string" ? entry.color : "var(--cf-primary)",
              marginTop: "8px",
              marginBottom: "0",
            }}
          >{`${entry.name} : ${entry.value}`}</p>
        ))}
        <p style={{ fontSize: "0.75rem", margin: "0", color: "var(--mantine-color-dimmed)" }}>
          {t(isYearSelected ? "Home.Personal.Chart.OpenMonths" : "Home.Personal.Chart.OpenYears")}
        </p>
      </div>
    );
  }

  return null;
};

function DateChart({ dataPerMonth }: { dataPerMonth: MonthResults[] }) {
  const { t } = useTranslation();
  const [selectedYear, setSelectedYear] = useState<number | null>(null);

  let data = fillMissingMonths(dataPerMonth);

  if (selectedYear) {
    data = data.filter((obj) => obj.name.startsWith(selectedYear.toString()));
  } else if (data.length > 36) {
    data = mergeYears(data);
  }

  return (
    <ResponsiveContainer width="100%" height={300}>
      <BarChart
        data={data}
        onClick={(e) => {
          const year = Number.parseInt(e.activeLabel?.toString() ?? "", 10);
          if (year) {
            setSelectedYear((prev) => (prev === year ? null : year));
          }
        }}
      >
        <CartesianGrid strokeDasharray="3" vertical={false} />
        <XAxis dataKey="name" />
        <YAxis />
        <Tooltip
          content={(props) => (
            <DateChartTooltip {...props} isYearSelected={selectedYear === null} />
          )}
          cursor={{
            fill: "var(--mantine-color-default-border)",
            stroke: "1px solid var(--chart-grid-color)",
          }}
        />
        <Bar
          dataKey="won"
          stackId="result"
          fill="var(--mantine-color-success-filled)"
          name={t("Databases.OpeningTree.Wins")}
        />
        <Bar
          dataKey="drawn"
          stackId="result"
          fill="var(--mantine-color-gray-filled)"
          name={t("Board.Analysis.Tablebase.Draw")}
        />
        <Bar
          dataKey="lost"
          stackId="result"
          fill="var(--mantine-color-danger-filled)"
          name={t("Databases.OpeningTree.Losses")}
        />
      </BarChart>
    </ResponsiveContainer>
  );
}

export default OverviewPanel;
