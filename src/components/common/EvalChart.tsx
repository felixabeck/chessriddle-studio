import { AreaChart, type ChartReferenceLineProps } from "@mantine/charts";
import { Alert, Box, LoadingOverlay, Paper, SegmentedControl, Stack, Text } from "@mantine/core";
import equal from "fast-deep-equal";
import { useAtom } from "jotai";
import { useCallback, useContext, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { CategoricalChartFunc } from "recharts/types/chart/types";
import { useStore } from "zustand";
import { isTreeViewDeferred, useTreeView } from "@/state/deferredTreeView";
import { reportTypeAtom } from "@/state/atoms";
import { ANNOTATION_INFO, formatNagGlyphs, isBasicAnnotation, nagGlyphs } from "@/utils/annotation";
import { positionFromFen } from "@/utils/chessops";
import { skipWhile, takeWhile } from "@/utils/misc";
import { getGamePhases } from "@/utils/phase";
import { formatScore } from "@/utils/score";
import { type ListNode, type TreeNode, treeIteratorMainLine } from "@/utils/treeReducer";
import classes from "./EvalChart.module.css";
import { TreeStateContext } from "./TreeStateContext";

interface EvalChartProps {
  isAnalysing: boolean;
  startAnalysis: () => void;
}

type DataPoint = {
  name: string;
  cpText: string;
  wdlText: string;
  yValue: number | "none";
  movePath: number[];
  color: string;
  annotation?: string;
  White: number;
  Draw: number;
  Black: number;
};

const annotationAreaProps = { isAnimationActive: false, dot: <CustomDot /> };

function getYValue(node: TreeNode): number | undefined {
  if (node.score) {
    let cp: number = node.score.value.value;
    if (node.score.value.type === "mate") {
      cp = node.score.value.value > 0 ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
    }
    return 2 / (1 + Math.exp(-0.004 * cp)) - 1;
  }
  if (node.children.length === 0) {
    const [pos] = positionFromFen(node.fen);
    if (pos) {
      if (pos.isCheckmate()) {
        return pos.turn === "white" ? -1 : 1;
      }
      if (pos.isStalemate()) {
        return 0;
      }
    }
  }
}

function EvalChart(props: EvalChartProps) {
  const { t } = useTranslation();

  const store = useContext(TreeStateContext)!;
  const { root } = useTreeView(store);
  const position = useStore(store, (s) => s.position);
  const goToMove = useStore(store, (s) => s.goToMove);

  function gradientOffset(data: DataPoint[]) {
    const dataMax = Math.max(...data.map((i) => (i.yValue !== "none" ? i.yValue : 0)));
    const dataMin = Math.min(...data.map((i) => (i.yValue !== "none" ? i.yValue : 0)));

    if (dataMax <= 0) return 0;
    if (dataMin >= 0) return 1;

    return dataMax / (dataMax - dataMin);
  }

  const nodes = useMemo(() => {
    if (isTreeViewDeferred(store)) return [];
    const allNodes = treeIteratorMainLine(root);
    const withoutRoot = skipWhile(allNodes, (node: ListNode) => node.position.length === 0);
    return [...takeWhile(withoutRoot, (node: ListNode) => node.node.move !== undefined)];
  }, [root, store]);

  const data = useMemo<DataPoint[]>(
    () =>
      nodes.map((currentNode) => {
        const node = currentNode.node;
        const annotations = nagGlyphs(node.nags);
        const [pos] = positionFromFen(node.fen);
        const wdl = node.score?.wdl;
        const terminalText = () => {
          if (node.children.length === 0 && pos) {
            if (pos.isCheckmate()) return t("Common.Checkmate");
            if (pos.isStalemate()) return t("Common.Stalemate");
          }
          return t("Board.Analysis.NotAnalysed");
        };
        return {
          name: `${Math.ceil(node.halfMoves / 2)}.${pos?.turn === "black" ? "" : ".."} ${node.san}${formatNagGlyphs(annotations)}`,
          cpText: node.score
            ? `${t("Board.Analysis.Advantage")}: ${formatScore(node.score.value)}`
            : terminalText(),
          wdlText: node.score?.wdl
            ? `\n         White: ${node.score.wdl[0] / 10}%\n         Draw: ${node.score.wdl[1] / 10}%\n         Black: ${node.score.wdl[2] / 10}%`
            : terminalText(),
          yValue: getYValue(node) ?? "none",
          movePath: currentNode.position,
          color: ANNOTATION_INFO[annotations[0]]?.color || "gray",
          annotation: annotations[0],
          White: wdl ? wdl[0] : 0,
          Draw: wdl ? wdl[1] : 0,
          Black: wdl ? wdl[2] : 0,
        };
      }),
    [nodes, t],
  );

  const onChartClick = useCallback<CategoricalChartFunc>(
    (e) => {
      if (store.getState().root !== root) return;
      const match = data.find((point) => point.name === e.activeLabel);
      if (match) {
        goToMove(match.movePath);
      }
    },
    [data, goToMove, root, store],
  );

  const phases = useMemo(() => {
    const validBoards = nodes.map((n) => positionFromFen(n.node.fen)[0]).filter((b) => b !== null);
    return getGamePhases(validBoards);
  }, [nodes]);

  const currentPositionName = data.find((point) => equal(point.movePath, position))?.name;

  const middlegamePositionName =
    phases.middlegamePly !== null ? data[phases.middlegamePly]?.name : null;
  const endgamePositionName = phases.endgamePly !== null ? data[phases.endgamePly]?.name : null;

  const referenceLines: ChartReferenceLineProps[] = [
    {
      x: currentPositionName,
      color: "var(--cf-primary)",
    },
    ...(middlegamePositionName
      ? [
          {
            x: middlegamePositionName,
            color: "var(--cf-border-strong)",
            strokeDasharray: "5 5",
            label: t("Board.Analysis.Middlegame"),
            labelPosition: "insideTopLeft" as const,
          },
        ]
      : []),
    ...(endgamePositionName
      ? [
          {
            x: endgamePositionName,
            color: "var(--cf-border-strong)",
            strokeDasharray: "5 5",
            label: t("Board.Analysis.Endgame"),
            labelPosition: "insideTopLeft" as const,
          },
        ]
      : []),
  ];

  const colouroffset = gradientOffset(data);

  const [chartType, setChartType] = useAtom(reportTypeAtom);

  const isWDLDisabled = useMemo(() => {
    return !data.some((point) => point.White !== 0 || point.Black !== 0 || point.Draw !== 0);
  }, [data]);

  return (
    <Stack>
      <Box pos="relative">
        <LoadingOverlay visible={props.isAnalysing === true} />
        <SegmentedControl
          data={["CP", "WDL"]}
          size="xs"
          value={chartType}
          onChange={(v) => setChartType(v as "CP" | "WDL")}
        />
        {chartType === "CP" && (
          <AreaChart
            h={150}
            curveType="monotone"
            data={data}
            dataKey={"name"}
            series={[{ name: "yValue", color: "var(--cf-border-strong)" }]}
            connectNulls={false}
            withXAxis={false}
            withYAxis={false}
            yAxisProps={{ domain: [-1, 1] }}
            type="split"
            fillOpacity={0.8}
            splitColors={["var(--cf-eval-bar-light)", "var(--cf-eval-bar-dark)"]}
            splitOffset={colouroffset}
            activeDotProps={{ r: 3, strokeWidth: 1 }}
            dotProps={{ r: 0 }}
            referenceLines={referenceLines}
            areaChartProps={{
              onClick: onChartClick,
              style: { cursor: "pointer" },
            }}
            areaProps={annotationAreaProps}
            gridAxis="none"
            tooltipProps={{
              content: ({ payload, active }) => (
                <CustomTooltip active={active} payload={payload} type="cp" />
              ),
            }}
          />
        )}
        {chartType === "WDL" &&
          (isWDLDisabled ? (
            <Alert variant="outline" title={t("Board.Analysis.EnableWDLTitle")} mt="sm">
              {t("Board.Analysis.EnableWDL")}
            </Alert>
          ) : (
            <AreaChart
              h={150}
              curveType="monotone"
              data={data}
              dataKey={"name"}
              series={[
                { name: "White", color: "var(--cf-eval-bar-light)" },
                { name: "Draw", color: "var(--cf-chart-4)" },
                { name: "Black", color: "var(--cf-eval-bar-dark)" },
              ]}
              connectNulls={false}
              withXAxis={false}
              withYAxis={false}
              type="percent"
              fillOpacity={0.8}
              activeDotProps={{ r: 3, strokeWidth: 1 }}
              dotProps={{ r: 0 }}
              referenceLines={referenceLines}
              areaProps={(series) =>
                series.name === "White" ? annotationAreaProps : { isAnimationActive: false }
              }
              areaChartProps={{
                onClick: onChartClick,
                style: { cursor: "pointer" },
              }}
              gridAxis="none"
              tooltipProps={{
                content: ({ payload, active }) => (
                  <CustomTooltip active={active} payload={payload} type="wdl" />
                ),
              }}
            />
          ))}
      </Box>
    </Stack>
  );
}

function CustomTooltip({
  active,
  payload,
  type,
}: {
  active?: boolean;
  payload: readonly { payload: DataPoint }[];
  type: "cp" | "wdl";
}) {
  if (active && payload && payload.length && payload[0].payload) {
    const dataPoint = payload[0].payload;
    return (
      <Paper px="md" py="sm" withBorder shadow="md" radius="md">
        <Text
          className={classes.tooltipTitle}
          c={dataPoint.color === "gray" ? undefined : dataPoint.color}
        >
          {dataPoint.name}
        </Text>
        <Text>{type === "cp" ? dataPoint.cpText : dataPoint.wdlText}</Text>
      </Paper>
    );
  }
  return null;
}

function CustomDot(props: { cx?: number; cy?: number; payload?: DataPoint }) {
  const { cx, cy, payload } = props;
  if (!payload || !payload.annotation || !isBasicAnnotation(payload.annotation)) return null;
  return (
    <circle
      cx={cx}
      cy={cy}
      r={4}
      fill={`var(--mantine-color-${payload.color}-7)`}
      stroke="var(--mantine-color-body)"
      strokeWidth={1}
      style={{ pointerEvents: "none" }}
    />
  );
}

export default EvalChart;
