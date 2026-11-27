import { Paper, Table, Text, UnstyledButton, VisuallyHidden } from "@mantine/core";
import cx from "clsx";
import { memo } from "react";
import { useTranslation } from "react-i18next";
import {
  ANNOTATION_INFO,
  annotationTextColor,
  type BasicAnnotation,
  isBasicAnnotation,
} from "@/utils/annotation";
import type { GameStats } from "@/utils/chess";
import type { GameHeaders } from "@/utils/treeReducer";
import classes from "./AnalysisPanel.module.css";
import { ExplainedLabel } from "./ExplainedLabel";

const NO_VALUE = "–";

function hasPlayerName(name: string): boolean {
  return name.trim().length > 0 && name !== "?";
}

function PlayerHeader({
  name,
  rating,
  fallback,
}: {
  name: string;
  rating?: number | null;
  fallback: string;
}) {
  const displayName = hasPlayerName(name) ? name : fallback;
  return (
    <span className={classes.playerHeader}>
      <span className={classes.playerName}>{displayName}</span>
      {rating ? (
        <Text component="span" fz="xs" c="dimmed" fw={400} className={classes.figure}>
          ({rating})
        </Text>
      ) : null}
    </span>
  );
}

function formatAccuracy(value: number | null): string {
  return value === null ? NO_VALUE : `${value.toFixed(1)}%`;
}

function formatCpl(value: number | null): string {
  return value === null ? NO_VALUE : value.toFixed(1);
}

interface ScoreboardProps {
  stats: GameStats;
  headers: GameHeaders;
  goToAnnotation: (annotation: BasicAnnotation, color: "white" | "black") => void;
}

export const Scoreboard = memo(function Scoreboard({
  stats,
  headers,
  goToAnnotation,
}: ScoreboardProps) {
  const { t } = useTranslation();
  const hasAccuracy = stats.white.accuracy !== null || stats.black.accuracy !== null;
  const { phases, phaseAccuracy } = stats;

  const hasOpening =
    phases.middlegamePly === null ||
    phases.middlegamePly > 1 ||
    phaseAccuracy.white.opening !== null ||
    phaseAccuracy.black.opening !== null;
  const hasMiddlegame =
    phases.middlegamePly !== null &&
    (phases.endgamePly === null ||
      phases.endgamePly > phases.middlegamePly ||
      phaseAccuracy.white.middlegame !== null ||
      phaseAccuracy.black.middlegame !== null);
  const hasEndgame =
    phases.endgamePly !== null ||
    phaseAccuracy.white.endgame !== null ||
    phaseAccuracy.black.endgame !== null;

  const phaseRows: { key: "opening" | "middlegame" | "endgame"; label: string }[] = [
    ...(hasOpening ? [{ key: "opening" as const, label: t("Board.Analysis.Opening") }] : []),
    ...(hasMiddlegame
      ? [{ key: "middlegame" as const, label: t("Board.Analysis.Middlegame") }]
      : []),
    ...(hasEndgame ? [{ key: "endgame" as const, label: t("Board.Analysis.Endgame") }] : []),
  ];

  return (
    <Paper withBorder p="md" className={classes.scoreboardCard}>
      <Table layout="fixed" verticalSpacing={6} className={classes.scoreboardTable}>
        <colgroup>
          <col className={classes.sideColumn} />
          <col className={classes.labelColumn} />
          <col className={classes.sideColumn} />
        </colgroup>
        <Table.Thead>
          <Table.Tr>
            <Table.Th ta="center" scope="col">
              <PlayerHeader
                name={headers.white}
                rating={headers.white_elo}
                fallback={t("Common.WHITE")}
              />
            </Table.Th>
            <Table.Th scope="col">
              <VisuallyHidden>{t("Board.Analysis.Report.Metric")}</VisuallyHidden>
            </Table.Th>
            <Table.Th ta="center" scope="col">
              <PlayerHeader
                name={headers.black}
                rating={headers.black_elo}
                fallback={t("Common.BLACK")}
              />
            </Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {hasAccuracy && (
            <>
              <Table.Tr className={classes.heroRow}>
                <Table.Td
                  ta="center"
                  data-testid="report-accuracy"
                  className={cx(classes.heroAccuracy, classes.figure)}
                >
                  {formatAccuracy(stats.white.accuracy)}
                </Table.Td>
                <Table.Th scope="row" fw={600} className={classes.metricCell}>
                  <ExplainedLabel
                    label={t("Board.Analysis.Accuracy")}
                    explanation={t("Board.Analysis.Report.AccuracyDesc")}
                  />
                </Table.Th>
                <Table.Td
                  ta="center"
                  data-testid="report-accuracy"
                  className={cx(classes.heroAccuracy, classes.figure)}
                >
                  {formatAccuracy(stats.black.accuracy)}
                </Table.Td>
              </Table.Tr>

              <Table.Tr>
                <Table.Td ta="center" className={classes.figure}>
                  {formatCpl(stats.white.acpl)}
                </Table.Td>
                <Table.Th scope="row" fw="normal" className={classes.metricCell}>
                  <ExplainedLabel
                    label={t("Board.Analysis.Report.AverageLoss")}
                    explanation={t("Board.Analysis.Report.AverageLossDesc")}
                  />
                </Table.Th>
                <Table.Td ta="center" className={classes.figure}>
                  {formatCpl(stats.black.acpl)}
                </Table.Td>
              </Table.Tr>

              {phaseRows.map(({ key, label }, index) => (
                <Table.Tr
                  key={key}
                  className={index === phaseRows.length - 1 ? classes.sectionEndRow : undefined}
                >
                  <Table.Td ta="center" className={classes.figure} fz="sm">
                    {formatAccuracy(phaseAccuracy.white[key])}
                  </Table.Td>
                  <Table.Th scope="row" fw="normal" fz="sm" className={classes.metricCell}>
                    {label}
                  </Table.Th>
                  <Table.Td ta="center" className={classes.figure} fz="sm">
                    {formatAccuracy(phaseAccuracy.black[key])}
                  </Table.Td>
                </Table.Tr>
              ))}
            </>
          )}

          {Object.keys(ANNOTATION_INFO)
            .filter((a) => isBasicAnnotation(a))
            .map((annotation) => {
              const mark = annotation as BasicAnnotation;
              const { name, color, translationKey } = ANNOTATION_INFO[mark];
              const w = stats.white.annotations[mark];
              const b = stats.black.annotations[mark];
              const annotationName = translationKey ? t(`Annotate.${translationKey}`) : name;
              return (
                <Table.Tr key={annotation}>
                  <AnnotationCount
                    annotation={mark}
                    side="white"
                    total={w}
                    annotationName={annotationName}
                    goToAnnotation={goToAnnotation}
                  />
                  <Table.Th
                    scope="row"
                    fw="normal"
                    c={w + b > 0 ? annotationTextColor(color) : undefined}
                  >
                    <span className={classes.qualityLabel}>
                      <span className={classes.markCell}>{annotation}</span>
                      <span className={classes.qualityName}>{annotationName}</span>
                    </span>
                  </Table.Th>
                  <AnnotationCount
                    annotation={mark}
                    side="black"
                    total={b}
                    annotationName={annotationName}
                    goToAnnotation={goToAnnotation}
                  />
                </Table.Tr>
              );
            })}
        </Table.Tbody>
      </Table>
    </Paper>
  );
});

function AnnotationCount({
  annotation,
  side,
  total,
  annotationName,
  goToAnnotation,
}: {
  annotation: BasicAnnotation;
  side: "white" | "black";
  total: number;
  annotationName: string;
  goToAnnotation: (annotation: BasicAnnotation, color: "white" | "black") => void;
}) {
  const { t } = useTranslation();
  const { color } = ANNOTATION_INFO[annotation];

  if (total === 0) {
    return (
      <Table.Td ta="center" c="dimmed" className={classes.figure}>
        {total}
      </Table.Td>
    );
  }

  return (
    <Table.Td ta="center" className={classes.figure}>
      <UnstyledButton
        className={cx(classes.label, classes.figure)}
        c={annotationTextColor(color)}
        aria-label={
          side === "white"
            ? t("Board.Analysis.NextAnnotationByWhite", { annotation: annotationName, total })
            : t("Board.Analysis.NextAnnotationByBlack", { annotation: annotationName, total })
        }
        onClick={() => goToAnnotation(annotation, side)}
      >
        {total}
      </UnstyledButton>
    </Table.Td>
  );
}
