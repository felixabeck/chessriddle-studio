import { Group, Progress, Text } from "@mantine/core";
import { useAtom } from "jotai";
import { DataTable } from "mantine-datatable";
import { memo, useContext } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { gameRowActivation } from "@/components/common/gameOpen";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import { moveNotationTypeAtom } from "@/state/atoms";
import { addPieceSymbol } from "@/utils/annotation";
import type { Opening } from "@/utils/db";
import { formatNumber } from "@/utils/format";
import classes from "./OpeningsTable.module.css";

type StatsRow = Opening & { isTotal?: true };

function OpeningsTable({ openings, loading }: { openings: Opening[]; loading: boolean }) {
  const { t } = useTranslation();
  const store = useContext(TreeStateContext)!;
  const makeMove = useStore(store, (s) => s.makeMove);
  const [moveNotationType] = useAtom(moveNotationTypeAtom);
  const playMove = (move: string) => makeMove({ payload: move });

  const whiteTotal = openings?.reduce((acc, curr) => acc + curr.white, 0);
  const blackTotal = openings?.reduce((acc, curr) => acc + curr.black, 0);
  const drawTotal = openings?.reduce((acc, curr) => acc + curr.draw, 0);
  const grandTotal = whiteTotal + blackTotal + drawTotal;

  const rows: StatsRow[] =
    openings.length > 0
      ? [
          ...openings,
          {
            move: "",
            white: whiteTotal,
            black: blackTotal,
            draw: drawTotal,
            isTotal: true,
          },
        ]
      : [];

  return (
    <DataTable
      withTableBorder
      highlightOnHover
      records={rows}
      fetching={loading || openings === null}
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
      columns={[
        {
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
            return (
              <Text fz="sm">{moveNotationType === "symbols" ? addPieceSymbol(move) : move}</Text>
            );
          },
        },
        {
          accessor: "total",
          title: t("Board.Database.StatsTable.Total"),
          width: 180,
          render: ({ isTotal, white, draw, black }) => {
            const total = white + draw + black;
            const percentage = (total / grandTotal) * 100;
            return (
              <Group>
                {!isTotal && <Text fz="sm">{percentage.toFixed(0)}%</Text>}
                <Text fz="sm" flex={1} ta="right">
                  {formatNumber(total)}
                </Text>
              </Group>
            );
          },
        },
        {
          accessor: "results",
          title: t("Board.Database.StatsTable.Results"),
          render: ({ black, white, draw }) => {
            const total = white + draw + black;
            const whitePercent = (white / total) * 100;
            const drawPercent = (draw / total) * 100;
            const blackPercent = (black / total) * 100;
            return (
              <Progress.Root size="xl" className={classes.result}>
                <Progress.Section value={whitePercent} className={classes.whiteResultsSection}>
                  <Progress.Label c="var(--cf-eval-bar-dark)">
                    {whitePercent > 10 ? `${whitePercent.toFixed(1)}%` : ""}
                  </Progress.Label>
                </Progress.Section>
                <Progress.Section value={drawPercent} color="var(--cf-chart-4)">
                  <Progress.Label>
                    {drawPercent > 10 ? `${drawPercent.toFixed(1)}%` : ""}
                  </Progress.Label>
                </Progress.Section>
                <Progress.Section value={blackPercent} color="var(--cf-eval-bar-dark)">
                  <Progress.Label>
                    {blackPercent > 10 ? `${blackPercent.toFixed(1)}%` : ""}
                  </Progress.Label>
                </Progress.Section>
              </Progress.Root>
            );
          },
        },
      ]}
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
