import { AreaChart, type ChartReferenceLineProps } from "@mantine/charts";
import { Alert, Box, LoadingOverlay, Paper, SegmentedControl, Stack, Text } from "@mantine/core";
import equal from "fast-deep-equal";
import { useAtom } from "jotai";
import { useCallback, useContext, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { CategoricalChartFunc } from "recharts/types/chart/types";
import { useStore } from "zustand";
import {
  type ExplanationOpenState,
  ExplanationTooltip,
  useExplanationOpen,
} from "@/components/common/ExplanationTooltip";
import { isTreeViewDeferred, useTreeView } from "@/state/deferredTreeView";
import { reportTypeAtom } from "@/state/atoms";
import {
  ANNOTATION_INFO,
  annotationTextColor,
  formatNagGlyphs,
  isBasicAnnotation,
  nagGlyphs,
} from "@/utils/annotation";
import type { AnnotationHue } from "@/styles/theme";
import { positionFromFen } from "@/utils/chessops";
import { skipWhile, takeWhile } from "@/utils/misc";
import { getGamePhases } from "@/utils/phase";
import { formatScore } from "@/utils/score";
import {
  displayedScore,
  type ListNode,
  type TreeNode,
  treeIteratorMainLine,
} from "@/utils/treeReducer";
import classes from "./EvalChart.module.css";
import { TreeStateContext } from "./TreeStateContext";

interface EvalChartProps {
  isAnalysing: boolean;
  highlightedMovePath?: number[] | null;
  onHoverMove?: (movePath: number[] | null) => void;
}

type ChartType = "CP" | "WDL";

type DataPoint = {
  name: string;
  cpText: string;
  /** One tooltip line per outcome, or the single terminal/not-analysed line. */
  wdlLines: string[];
  yValue: number | "none";
  movePath: number[];
  color: AnnotationHue | "gray";
  annotation?: string;
  White: number;
  Draw: number;
  Black: number;
};

/** Engine WDL values are per mille. */
const WDL_SCALE = 1000;
const WDL_FRACTION_DIGITS = 1;

function getYValue(node: TreeNode): number | undefined {
  const score = displayedScore(node);
  if (score) {
    let cp: number = score.value.value;
    if (score.value.type === "mate" || (score.value.type === "dtz" && score.value.value !== 0)) {
      cp = score.value.value > 0 ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
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
  return undefined;
}

function EvalChart({ isAnalysing, highlightedMovePath = null, onHoverMove }: EvalChartProps) {
  const { t, i18n } = useTranslation();

  const store = useContext(TreeStateContext)!;
  const { root } = useTreeView(store);
  const position = useStore(store, (s) => s.position);
  const goToMove = useStore(store, (s) => s.goToMove);

  const cpExplanation = useExplanationOpen();
  const wdlExplanation = useExplanationOpen();
  const explanationByType: Record<ChartType, ExplanationOpenState> = {
    CP: cpExplanation,
    WDL: wdlExplanation,
  };
  const lastHoveredPathRef = useRef<number[] | null>(null);

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

  const data = useMemo<DataPoint[]>(() => {
    // Percent shaping is locale-dependent (fr-FR writes "45 %", de-DE "45,3 %").
    const percent = new Intl.NumberFormat(i18n.language, {
      style: "percent",
      maximumFractionDigits: WDL_FRACTION_DIGITS,
    });
    const formatPercent = (value: number) => percent.format(value / WDL_SCALE);
    return nodes.map((currentNode) => {
      const node = currentNode.node;
      const annotations = nagGlyphs(node.nags);
      const [pos] = positionFromFen(node.fen);
      const score = displayedScore(node);
      const wdl = score?.wdl;
      const terminalText = () => {
        if (node.children.length === 0 && pos) {
          if (pos.isCheckmate()) return t("Common.Checkmate");
          if (pos.isStalemate()) return t("Common.Stalemate");
        }
        return t("Board.Analysis.NotAnalysed");
      };
      return {
        name: `${Math.ceil(node.halfMoves / 2)}.${pos?.turn === "black" ? "" : ".."} ${node.san}${formatNagGlyphs(annotations)}`,
        cpText: score
          ? `${t("Board.Analysis.Advantage")}: ${formatScore(score.value)}`
          : terminalText(),
        wdlLines: wdl
          ? [
              t("Board.Analysis.WDL.White", { percent: formatPercent(wdl[0]) }),
              t("Board.Analysis.WDL.Draw", { percent: formatPercent(wdl[1]) }),
              t("Board.Analysis.WDL.Black", { percent: formatPercent(wdl[2]) }),
            ]
          : [terminalText()],
        yValue: getYValue(node) ?? "none",
        movePath: currentNode.position,
        color: ANNOTATION_INFO[annotations[0]]?.color || "gray",
        annotation: annotations[0],
        White: wdl ? wdl[0] : 0,
        Draw: wdl ? wdl[1] : 0,
        Black: wdl ? wdl[2] : 0,
      };
    });
  }, [nodes, t, i18n.language]);

  const reportHoveredMove = useCallback(
    (nextPath: number[] | null) => {
      if (!onHoverMove) return;
      if (equal(lastHoveredPathRef.current, nextPath)) return;
      lastHoveredPathRef.current = nextPath;
      onHoverMove(nextPath);
    },
    [onHoverMove],
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

  const onChartMouseMove = useCallback<CategoricalChartFunc>(
    (e) => {
      if (!onHoverMove) return;
      const match = e?.activeLabel ? data.find((point) => point.name === e.activeLabel) : undefined;
      reportHoveredMove(match ? match.movePath : null);
    },
    [data, onHoverMove, reportHoveredMove],
  );

  const onChartMouseLeave = useCallback(() => {
    reportHoveredMove(null);
  }, [reportHoveredMove]);

  const phases = useMemo(() => {
    const validBoards = nodes.map((n) => positionFromFen(n.node.fen)[0]).filter((b) => b !== null);
    return getGamePhases(validBoards);
  }, [nodes]);

  const currentPositionName = data.find((point) => equal(point.movePath, position))?.name;
  const highlightedPositionName = highlightedMovePath
    ? data.find((point) => equal(point.movePath, highlightedMovePath))?.name
    : undefined;

  const middlegamePositionName =
    phases.middlegamePly !== null ? data[phases.middlegamePly]?.name : null;
  const endgamePositionName = phases.endgamePly !== null ? data[phases.endgamePly]?.name : null;

  const sharedReferenceLines: ChartReferenceLineProps[] = [
    {
      x: currentPositionName,
      color: "var(--cf-primary)",
    },
    ...(highlightedPositionName
      ? [
          {
            x: highlightedPositionName,
            color: "var(--cf-primary)",
            strokeDasharray: "2 2",
          },
        ]
      : []),
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

  const cpReferenceLines: ChartReferenceLineProps[] = [
    {
      y: 0,
      color: "var(--cf-border-strong)",
    },
    ...sharedReferenceLines,
  ];

  const colouroffset = gradientOffset(data);

  const [chartType, setChartType] = useAtom(reportTypeAtom);

  const isWDLDisabled = useMemo(() => {
    return !data.some((point) => point.White !== 0 || point.Black !== 0 || point.Draw !== 0);
  }, [data]);

  const areaProps = useMemo(
    () => ({
      isAnimationActive: false,
      dot: <CustomDot highlightedName={highlightedPositionName} />,
    }),
    [highlightedPositionName],
  );

  const renderToggleOption = (value: ChartType, label: string, explanation: string) => {
    const hook = explanationByType[value];
    return {
      value,
      label: (
        <ExplanationTooltip label={explanation} opened={hook.opened}>
          <span
            className={classes.toggleLabel}
            data-chart-toggle={value}
            onMouseEnter={hook.onMouseEnter}
            onMouseLeave={hook.onMouseLeave}
          >
            {label}
          </span>
        </ExplanationTooltip>
      ),
    };
  };

  return (
    <Stack>
      <Box pos="relative">
        <LoadingOverlay visible={isAnalysing === true} />
        <SegmentedControl
          aria-label={t("Board.Analysis.Report.ChartType")}
          data={[
            renderToggleOption(
              "CP",
              t("Board.Analysis.Report.Evaluation"),
              t("Board.Analysis.Report.EvaluationDesc"),
            ),
            renderToggleOption(
              "WDL",
              t("Board.Analysis.Report.WinChance"),
              t("Board.Analysis.Report.WinChanceDesc"),
            ),
          ]}
          size="xs"
          value={chartType}
          onChange={(v) => setChartType(v as ChartType)}
          onFocusCapture={(event) => {
            const val = (event.target as HTMLInputElement).value;
            if (val === "CP") {
              wdlExplanation.onBlur();
              cpExplanation.onFocus();
            } else if (val === "WDL") {
              cpExplanation.onBlur();
              wdlExplanation.onFocus();
            }
          }}
          onBlurCapture={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
              cpExplanation.onBlur();
              wdlExplanation.onBlur();
            }
          }}
          onKeyDownCapture={(event) => {
            cpExplanation.onKeyDown(event);
            wdlExplanation.onKeyDown(event);
          }}
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
            referenceLines={cpReferenceLines}
            areaChartProps={{
              onClick: onChartClick,
              onMouseMove: onChartMouseMove,
              onMouseLeave: onChartMouseLeave,
              style: { cursor: "pointer" },
            }}
            areaProps={areaProps}
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
              referenceLines={sharedReferenceLines}
              areaProps={(series) =>
                series.name === "White" ? areaProps : { isAnimationActive: false }
              }
              areaChartProps={{
                onClick: onChartClick,
                onMouseMove: onChartMouseMove,
                onMouseLeave: onChartMouseLeave,
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
      <Paper px="md" py="sm" withBorder radius="md" className={classes.chartTooltip}>
        <Text className={classes.tooltipTitle} c={annotationTextColor(dataPoint.color)}>
          {dataPoint.name}
        </Text>
        {type === "cp" ? (
          <Text>{dataPoint.cpText}</Text>
        ) : (
          dataPoint.wdlLines.map((line) => <Text key={line}>{line}</Text>)
        )}
      </Paper>
    );
  }
  return null;
}

function CustomDot(props: {
  cx?: number;
  cy?: number;
  payload?: DataPoint;
  highlightedName?: string;
}) {
  const { cx, cy, payload, highlightedName } = props;
  if (!payload) return null;
  const isHighlighted = highlightedName !== undefined && payload.name === highlightedName;
  const hasBasicMark = payload.annotation && isBasicAnnotation(payload.annotation);
  if (!hasBasicMark && !isHighlighted) return null;
  const fill = hasBasicMark ? `var(--mantine-color-${payload.color}-7)` : "var(--cf-primary)";
  return (
    <circle
      cx={cx}
      cy={cy}
      r={isHighlighted ? 6 : 4}
      fill={fill}
      stroke={isHighlighted ? "var(--cf-primary)" : "var(--mantine-color-body)"}
      strokeWidth={isHighlighted ? 2 : 1}
      data-highlighted={isHighlighted || undefined}
      style={{ pointerEvents: "none" }}
    />
  );
}

export default EvalChart;
