import { Group, Text, Tooltip } from "@mantine/core";
import cx from "clsx";
import { useAtom } from "jotai";
import { ChevronUp, ChevronsUpDown } from "lucide-react";
import { DataTable, type DataTableColumn } from "mantine-datatable";
import { memo, useContext } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { gameRowActivation } from "@/components/common/gameOpen";
import { ResultBar } from "@/components/common/ResultBar";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import { type ExplorerColumnId, moveNotationTypeAtom } from "@/state/atoms";
import { addPieceSymbol } from "@/utils/annotation";
import type { Opening } from "@/utils/db";
import { formatNumber } from "@/utils/format";
import {
  combineOpenings,
  effectiveOpeningsSort,
  type OpeningRow,
  type OpeningsSort,
  openingGames,
  openingScore,
  openingTotals,
} from "./openingRows";
import classes from "./OpeningsTable.module.css";

export type OpeningsTableSource = {
  column: ExplorerColumnId;
  openings: Opening[];
  loading: boolean;
  /** The source's position total when it reports one apart from its move rows. */
  total?: Opening;
  /** The source cannot answer: its cells stay empty, with no dash. */
  unavailable?: boolean;
};

type StatsRow = OpeningRow & { isTotal?: true };

const NO_GAMES = "–";
const SOURCE_LOADING = "…";
const DEFAULT_SORT: OpeningsSort = { source: "primary", direction: "desc" };
const totalAccessor = (column: ExplorerColumnId) => `${column}Total`;
const scoreAccessor = (column: ExplorerColumnId) => `${column}Score`;
const resultsAccessor = (column: ExplorerColumnId) => `${column}Results`;
const columnFromAccessor = (
  accessor: string,
  shown: readonly ExplorerColumnId[],
): ExplorerColumnId => {
  for (const id of shown) {
    if (accessor === totalAccessor(id)) return id;
  }
  return "primary";
};

/** Move column width for one or two sources; lines up with `.sources[data-sources="2"]` in `DatabasePanel.module.css`. */
const MOVE_COLUMN_WIDTH = 100;
/** Compact Move column width for three sources; lines up with `.sources[data-sources="3"]` in `DatabasePanel.module.css`. */
const COMPACT_MOVE_COLUMN_WIDTH = 72;
/** Total column widths for one and two sources; they fit a share beside a seven-digit count. */
const TOTAL_COLUMN_WIDTH = 140;
const MULTI_TOTAL_COLUMN_WIDTH = 130;
/** White-score column widths for one, two and three sources. */
const SCORE_COLUMN_WIDTH = 76;
const MULTI_SCORE_COLUMN_WIDTH = 64;
const COMPACT_SCORE_COLUMN_WIDTH = 56;

/**
 * The explorer's move statistics. One source renders the four plain columns; with `sources`
 * (two or three) the rows are the union of all sources' moves and each source has its own three
 * columns.
 */
function OpeningsTable({
  openings,
  total,
  loading,
  sources,
  sort = DEFAULT_SORT,
  onSortChange,
}: {
  openings: Opening[];
  /** The primary source's position total when its move rows do not add up to it. */
  total?: Opening;
  loading: boolean;
  sources?: readonly OpeningsTableSource[];
  sort?: OpeningsSort;
  onSortChange?: (sort: OpeningsSort) => void;
}) {
  const { t } = useTranslation();
  const store = useContext(TreeStateContext)!;
  const makeMove = useStore(store, (s) => s.makeMove);
  const [moveNotationType] = useAtom(moveNotationTypeAtom);
  const playMove = (move: string) => makeMove({ payload: move });

  const multiSource = !!sources && sources.length > 1;
  const threeSources = multiSource && sources.length >= 3;
  const activeSources: readonly OpeningsTableSource[] = multiSource
    ? sources
    : [{ column: "primary", openings, loading, total }];
  const sourceByColumn = Object.fromEntries(
    activeSources.map((source) => [source.column, source]),
  ) as Partial<Record<ExplorerColumnId, OpeningsTableSource>>;
  const answering = activeSources.filter((source) => !source.unavailable);
  const totals = Object.fromEntries(
    answering.map((source) => [source.column, source.total ?? openingTotals(source.openings)]),
  ) as Partial<Record<ExplorerColumnId, Opening>>;
  const activeSort = multiSource
    ? effectiveOpeningsSort(
        sort,
        activeSources.map((source) => source.column),
      )
    : sort;
  const moves: OpeningRow[] = multiSource
    ? combineOpenings(answering, activeSort)
    : openings.map((opening) => ({ move: opening.move, primary: opening }));
  // A position whose games all ended there has no move row but still has games to total.
  const hasAnyTotal = answering.some((source) => openingGames(totals[source.column]) > 0);
  const rows: StatsRow[] =
    moves.length > 0 || hasAnyTotal
      ? [
          ...moves,
          {
            move: "",
            ...totals,
            isTotal: true,
          },
        ]
      : [];
  // The whole table waits only while none of the columns that can answer has answered.
  const everyLoading = answering.length > 0 && answering.every((source) => source.loading);
  const pending = (column: ExplorerColumnId) => !everyLoading && !!sourceByColumn[column]?.loading;
  const unavailable = (column: ExplorerColumnId) => !!sourceByColumn[column]?.unavailable;
  const cellFontSize = threeSources ? "xs" : "sm";

  const totalColumn = (
    column: ExplorerColumnId,
    accessor: string,
    separator: boolean,
  ): DataTableColumn<StatsRow> => {
    const className =
      cx(separator && classes.sourceStart, threeSources && classes.compactCell) || undefined;
    return {
      accessor,
      title: t("Board.Database.StatsTable.Total"),
      width: threeSources ? undefined : multiSource ? MULTI_TOTAL_COLUMN_WIDTH : TOTAL_COLUMN_WIDTH,
      sortable: multiSource,
      cellsClassName: className,
      titleClassName: className,
      render: (row) => {
        if (unavailable(column)) return null;
        if (pending(column)) {
          return (
            <Text fz={cellFontSize} c="dimmed" ta="right">
              {SOURCE_LOADING}
            </Text>
          );
        }
        const opening = row[column];
        if (!opening) {
          return (
            <Text fz={cellFontSize} c="dimmed" ta="right" data-no-games>
              {NO_GAMES}
            </Text>
          );
        }
        const games = openingGames(opening);
        const sourceTotal = openingGames(totals[column]);
        // Games with an unknown result count for neither side: a source can total none.
        const percentage = sourceTotal > 0 ? (games / sourceTotal) * 100 : 0;
        return (
          <Group wrap="nowrap" gap={threeSources ? 4 : undefined}>
            {!row.isTotal && <Text fz={cellFontSize}>{percentage.toFixed(0)}%</Text>}
            <Text fz={cellFontSize} flex={1} ta="right">
              {formatNumber(games)}
            </Text>
          </Group>
        );
      },
    };
  };
  const scoreColumn = (column: ExplorerColumnId, accessor: string): DataTableColumn<StatsRow> => {
    const className = cx(threeSources && classes.compactCell) || undefined;
    return {
      accessor,
      title: (
        <Tooltip label={t("Board.Database.StatsTable.ScoreHint")}>
          <span>{t("Board.Database.StatsTable.Score")}</span>
        </Tooltip>
      ),
      width: threeSources
        ? COMPACT_SCORE_COLUMN_WIDTH
        : multiSource
          ? MULTI_SCORE_COLUMN_WIDTH
          : SCORE_COLUMN_WIDTH,
      textAlign: "right",
      cellsClassName: className,
      titleClassName: className,
      render: (row) => {
        if (unavailable(column) || pending(column)) return null;
        const score = openingScore(row[column]);
        if (score === null) return null;
        return (
          <Text fz={cellFontSize} ta="right">
            {score.toFixed(0)}%
          </Text>
        );
      },
    };
  };
  const resultsColumn = (column: ExplorerColumnId, accessor: string): DataTableColumn<StatsRow> => {
    const className = cx(threeSources && classes.compactCell) || undefined;
    return {
      accessor,
      title: t("Board.Database.StatsTable.Results"),
      cellsClassName: className,
      titleClassName: className,
      render: (row) => {
        const opening = row[column];
        if (unavailable(column) || !opening || pending(column)) return null;
        const games = openingGames(opening);
        if (games === 0) return null;
        const whitePercent = (opening.white / games) * 100;
        const drawPercent = (opening.draw / games) * 100;
        const blackPercent = (opening.black / games) * 100;
        // Multiple sources narrow each bar below a readable label; their Score column carries
        // the number instead.
        const label = (percent: number) =>
          !multiSource && percent > 10 ? `${percent.toFixed(1)}%` : "";
        return (
          <ResultBar
            size="xl"
            className={classes.result}
            segments={[
              {
                value: whitePercent,
                className: classes.whiteResultsSection,
                label: label(whitePercent),
                labelColor: "var(--cf-eval-bar-dark)",
              },
              {
                value: drawPercent,
                color: "var(--cf-chart-4)",
                label: label(drawPercent),
              },
              {
                value: blackPercent,
                color: "var(--cf-eval-bar-dark)",
                label: label(blackPercent),
              },
            ]}
          />
        );
      },
    };
  };

  const moveClassName = cx(threeSources && classes.compactCell) || undefined;
  const moveColumn: DataTableColumn<StatsRow> = {
    accessor: "move",
    title: t("Board.Database.StatsTable.Move"),
    width: threeSources ? COMPACT_MOVE_COLUMN_WIDTH : MOVE_COLUMN_WIDTH,
    cellsClassName: moveClassName,
    titleClassName: moveClassName,
    render: ({ move, isTotal }) => {
      if (isTotal) return <Text fz={cellFontSize}>{t("Board.Database.StatsTable.Total")}</Text>;
      if (move === "*")
        return (
          <Text fz={cellFontSize} fs="italic" truncate={threeSources}>
            {t("Board.Analysis.GameOver")}
          </Text>
        );
      return (
        <Text fz={cellFontSize} truncate={threeSources}>
          {moveNotationType === "symbols" ? addPieceSymbol(move) : move}
        </Text>
      );
    },
  };

  return (
    <DataTable
      withTableBorder
      highlightOnHover
      records={rows}
      fetching={everyLoading || openings === null}
      // Equal source groups: the sources bar above lines up with them.
      styles={multiSource ? { table: { tableLayout: "fixed" } } : undefined}
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
        multiSource
          ? [
              moveColumn,
              ...activeSources.flatMap((source, index) => [
                totalColumn(source.column, totalAccessor(source.column), index > 0),
                scoreColumn(source.column, scoreAccessor(source.column)),
                resultsColumn(source.column, resultsAccessor(source.column)),
              ]),
            ]
          : [
              moveColumn,
              totalColumn("primary", "total", false),
              scoreColumn("primary", "score"),
              resultsColumn("primary", "results"),
            ]
      }
      // Only the multi-source columns are sortable, so one source shows no sort control.
      sortStatus={{
        columnAccessor: totalAccessor(activeSort.source),
        direction: activeSort.direction,
      }}
      onSortStatusChange={({ columnAccessor, direction }) =>
        onSortChange?.({
          source: columnFromAccessor(
            columnAccessor,
            activeSources.map((source) => source.column),
          ),
          direction,
        })
      }
      sortIcons={{
        // The table turns this icon around for a descending sort.
        sorted: <ChevronUp size="0.875rem" />,
        unsorted: <ChevronsUpDown size="0.875rem" />,
      }}
      idAccessor={(row) => (row.isTotal ? "\u0000total" : row.move)}
      noRecordsText={everyLoading ? "" : t("Databases.Game.NoGamesFound")}
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
