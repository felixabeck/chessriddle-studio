import { Group, Progress, Text } from "@mantine/core";
import { useAtom } from "jotai";
import { ChevronUp, ChevronsUpDown } from "lucide-react";
import { DataTable, type DataTableColumn } from "mantine-datatable";
import { memo, useContext } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { gameRowActivation } from "@/components/common/gameOpen";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import { moveNotationTypeAtom } from "@/state/atoms";
import { addPieceSymbol } from "@/utils/annotation";
import type { Opening } from "@/utils/db";
import { formatNumber } from "@/utils/format";
import {
  combineOpenings,
  type OpeningRow,
  type OpeningsSort,
  openingGames,
  openingTotals,
} from "./openingRows";
import classes from "./OpeningsTable.module.css";

type Role = "primary" | "comparison";
type StatsRow = OpeningRow & { isTotal?: true };

const NO_GAMES = "–";
const SOURCE_LOADING = "…";
const DEFAULT_SORT: OpeningsSort = { source: "primary", direction: "desc" };
const TOTAL_ACCESSOR = { primary: "primaryTotal", comparison: "comparisonTotal" } as const;

/**
 * The explorer's move statistics. One source renders the three plain columns; with `comparison`
 * the rows are the union of both sources' moves and each source has its own two columns.
 */
function OpeningsTable({
  openings,
  loading,
  comparison,
  sort = DEFAULT_SORT,
  onSortChange,
}: {
  openings: Opening[];
  loading: boolean;
  comparison?: { openings: Opening[]; loading: boolean };
  sort?: OpeningsSort;
  onSortChange?: (sort: OpeningsSort) => void;
}) {
  const { t } = useTranslation();
  const store = useContext(TreeStateContext)!;
  const makeMove = useStore(store, (s) => s.makeMove);
  const [moveNotationType] = useAtom(moveNotationTypeAtom);
  const playMove = (move: string) => makeMove({ payload: move });

  const sources: Record<Role, { openings: Opening[]; loading: boolean } | undefined> = {
    primary: { openings, loading },
    comparison,
  };
  const totals: Record<Role, Opening> = {
    primary: openingTotals(openings),
    comparison: openingTotals(comparison?.openings ?? []),
  };
  const moves: OpeningRow[] = comparison
    ? combineOpenings(openings, comparison.openings, sort)
    : openings.map((opening) => ({ move: opening.move, primary: opening }));
  const rows: StatsRow[] =
    moves.length > 0
      ? [
          ...moves,
          {
            move: "",
            primary: totals.primary,
            comparison: comparison ? totals.comparison : undefined,
            isTotal: true,
          },
        ]
      : [];
  // The whole table waits only while no shown source has answered; otherwise the source that is
  // still searching marks its own cells.
  const everyLoading = loading && (comparison?.loading ?? true);
  const pending = (role: Role) => !everyLoading && !!sources[role]?.loading;

  const totalColumn = (role: Role, accessor: string): DataTableColumn<StatsRow> => ({
    accessor,
    title: t("Board.Database.StatsTable.Total"),
    width: comparison ? 150 : 180,
    sortable: !!comparison,
    cellsClassName: role === "comparison" ? classes.sourceStart : undefined,
    titleClassName: role === "comparison" ? classes.sourceStart : undefined,
    render: (row) => {
      if (pending(role)) {
        return (
          <Text fz="sm" c="dimmed" ta="right">
            {SOURCE_LOADING}
          </Text>
        );
      }
      const opening = row[role];
      if (!opening) {
        return (
          <Text fz="sm" c="dimmed" ta="right" data-no-games>
            {NO_GAMES}
          </Text>
        );
      }
      const total = openingGames(opening);
      const sourceTotal = openingGames(totals[role]);
      // Games with an unknown result count for neither side: a source can total none.
      const percentage = sourceTotal > 0 ? (total / sourceTotal) * 100 : 0;
      return (
        <Group wrap="nowrap">
          {!row.isTotal && <Text fz="sm">{percentage.toFixed(0)}%</Text>}
          <Text fz="sm" flex={1} ta="right">
            {formatNumber(total)}
          </Text>
        </Group>
      );
    },
  });
  const resultsColumn = (role: Role, accessor: string): DataTableColumn<StatsRow> => ({
    accessor,
    title: t("Board.Database.StatsTable.Results"),
    render: (row) => {
      const opening = row[role];
      if (!opening || pending(role)) return null;
      const total = openingGames(opening);
      if (total === 0) return null;
      const whitePercent = (opening.white / total) * 100;
      const drawPercent = (opening.draw / total) * 100;
      const blackPercent = (opening.black / total) * 100;
      // Two sources halve the bar: label only the wider sections, in whole percent.
      const label = (percent: number) =>
        comparison
          ? percent >= 33
            ? `${percent.toFixed(0)}%`
            : ""
          : percent > 10
            ? `${percent.toFixed(1)}%`
            : "";
      return (
        <Progress.Root size="xl" className={classes.result}>
          <Progress.Section value={whitePercent} className={classes.whiteResultsSection}>
            <Progress.Label c="var(--cf-eval-bar-dark)">{label(whitePercent)}</Progress.Label>
          </Progress.Section>
          <Progress.Section value={drawPercent} color="var(--cf-chart-4)">
            <Progress.Label>{label(drawPercent)}</Progress.Label>
          </Progress.Section>
          <Progress.Section value={blackPercent} color="var(--cf-eval-bar-dark)">
            <Progress.Label>{label(blackPercent)}</Progress.Label>
          </Progress.Section>
        </Progress.Root>
      );
    },
  });

  const moveColumn: DataTableColumn<StatsRow> = {
    accessor: "move",
    title: t("Board.Database.StatsTable.Move"),
    width: 100,
    render: ({ move, isTotal }) => {
      if (isTotal) return <Text fz="sm">{t("Board.Database.StatsTable.Total")}</Text>;
      if (move === "*")
        return (
          <Text fz="sm" fs="italic">
            {t("Board.Analysis.GameOver")}
          </Text>
        );
      return <Text fz="sm">{moveNotationType === "symbols" ? addPieceSymbol(move) : move}</Text>;
    },
  };

  return (
    <DataTable
      withTableBorder
      highlightOnHover
      records={rows}
      fetching={everyLoading || openings === null}
      // Two equal source groups: the sources bar above lines up with them.
      styles={comparison ? { table: { tableLayout: "fixed" } } : undefined}
      rowStyle={(_row, i) => {
        if (i === rows.length - 1)
          return {
            fontWeight: 700,
            position: "sticky",
            bottom: 0,
            zIndex: 10,
          };
        return {};
      }}
      columns={
        comparison
          ? [
              moveColumn,
              totalColumn("primary", TOTAL_ACCESSOR.primary),
              resultsColumn("primary", "primaryResults"),
              totalColumn("comparison", TOTAL_ACCESSOR.comparison),
              resultsColumn("comparison", "comparisonResults"),
            ]
          : [moveColumn, totalColumn("primary", "total"), resultsColumn("primary", "results")]
      }
      // Only the two-source columns are sortable, so one source shows no sort control.
      sortStatus={{ columnAccessor: TOTAL_ACCESSOR[sort.source], direction: sort.direction }}
      onSortStatusChange={({ columnAccessor, direction }) =>
        onSortChange?.({
          source: columnAccessor === TOTAL_ACCESSOR.comparison ? "comparison" : "primary",
          direction,
        })
      }
      sortIcons={{
        // The table turns this icon around for a descending sort.
        sorted: <ChevronUp size="0.875rem" />,
        unsorted: <ChevronsUpDown size="0.875rem" />,
      }}
      idAccessor={(row) => (row.isTotal ? "\u0000total" : row.move)}
      noRecordsText={t("Databases.Game.NoGamesFound")}
      customRowAttributes={(row) => {
        if (row.isTotal || row.move === "*") return {};
        // Single click already plays through onRowClick, so the row takes only focus and Enter.
        const { tabIndex, onKeyDown } = gameRowActivation(row.move, playMove);
        return { tabIndex, onKeyDown };
      }}
      onRowClick={({ record }) => {
        if (!record.isTotal && record.move !== "*") playMove(record.move);
      }}
    />
  );
}

export default memo(OpeningsTable);
