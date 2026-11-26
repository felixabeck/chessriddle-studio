import { useTabAtom, useOwnerTabId } from "@/state/tabScope";
import { tauri } from "@/platform/tauri";
import {
  Button,
  Group,
  Paper,
  ScrollArea,
  Stack,
  Table,
  Text,
  UnstyledButton,
} from "@mantine/core";
import type { TFunction } from "i18next";
import { ScanSearch } from "lucide-react";
import equal from "fast-deep-equal";
import { useAtom } from "jotai";
import React, { memo, useCallback, useContext, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import EvalChart from "@/components/common/EvalChart";
import ProgressButton from "@/components/common/ProgressButton";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import { useProgress } from "@/hooks/useProgress";
import { reportModalOpenFamily } from "@/state/atoms";
import {
  ANNOTATION_INFO,
  annotationTextColor,
  type BasicAnnotation,
  isBasicAnnotation,
} from "@/utils/annotation";
import {
  type AnnotationCounts,
  getGameStats,
  getMainLine,
  type KeyMoment,
  reportRootFingerprint,
} from "@/utils/chess";
import { formatScore } from "@/utils/score";
import { formatMoveNumber } from "@/utils/format";
import type { ReportSummary } from "@/utils/treeReducer";
import classes from "./AnalysisPanel.module.css";
import ReportModal from "./ReportModal";
import { notifyUnlessCancelled } from "@/components/files/notifyError";
import { reportEngineFailure } from "./engineFailure";

function ReportPanel() {
  const { t } = useTranslation();

  const ownerTabId = useOwnerTabId();

  const store = useContext(TreeStateContext)!;
  const root = useStore(store, (s) => s.root);
  const [reportingMode, setReportingMode] = useAtom(useTabAtom(reportModalOpenFamily));

  const inProgress = useStore(store, (s) => s.report.inProgress);
  const operationId = useStore(store, (s) => s.report.operationId);
  const setInProgress = useStore(store, (s) => s.setReportInProgress);
  const setReportOperationId = useStore(store, (s) => s.setReportOperationId);

  // Inert placeholder that never matches an emitted event; useProgress requires a string.
  const IDLE_REPORT_PROGRESS_ID = `report_${ownerTabId}`;
  const progressId = operationId ?? IDLE_REPORT_PROGRESS_ID;
  const { finished } = useProgress(progressId);

  const isCurrentOperation = useCallback(
    (id: string, fingerprint: string) => {
      const current = store.getState();
      const currentFingerprint = reportRootFingerprint(current.root.fen, getMainLine(current.root));
      return current.report.operationId === id && currentFingerprint === fingerprint;
    },
    [store],
  );

  useEffect(() => {
    if (finished) {
      setInProgress(false);
    }
  }, [finished, setInProgress]);

  useEffect(() => {
    if (!inProgress) return;

    if (!operationId) {
      setInProgress(false);
      return;
    }

    let active = true;
    const queriedId = operationId;
    const queriedRoot = store.getState().root;
    const queriedFingerprint = reportRootFingerprint(queriedRoot.fen, getMainLine(queriedRoot));
    tauri
      .getProgress(queriedId)
      .then((item) => {
        if (!active) return;
        if (store.getState().report.operationId !== queriedId) return;
        if (item?.finished) {
          setInProgress(false);
        }
      })
      .catch((error) => {
        if (active && isCurrentOperation(queriedId, queriedFingerprint))
          notifyUnlessCancelled(t("Common.Error"), reportEngineFailure(t, error));
      });

    return () => {
      active = false;
    };
  }, [inProgress, operationId, setInProgress, store, t, isCurrentOperation]);

  const stats = useMemo(() => getGameStats(root), [root]);

  const handleCancel = useCallback(async () => {
    const id = store.getState().report.operationId;
    if (!id) return;
    const queriedRoot = store.getState().root;
    const queriedFingerprint = reportRootFingerprint(queriedRoot.fen, getMainLine(queriedRoot));
    try {
      await tauri.cancelAnalysis(id);
    } catch (error) {
      if (isCurrentOperation(id, queriedFingerprint))
        notifyUnlessCancelled(t("Common.Error"), reportEngineFailure(t, error));
      throw error;
    }
    // An acknowledgement for an older operation cannot clear its replacement.
    if (store.getState().report.operationId === id) {
      setReportOperationId(null);
      setInProgress(false);
    }
  }, [setInProgress, setReportOperationId, store, t, isCurrentOperation]);

  const openReportingMode = useCallback(() => {
    setReportingMode(true);
  }, [setReportingMode]);

  const closeReportingMode = useCallback(() => {
    setReportingMode(false);
  }, [setReportingMode]);

  const summary = useStore(store, (s) => s.report.summary ?? null);
  const goToMove = useStore(store, (s) => s.goToMove);
  const moves = useMemo(() => getMainLine(root), [root]);
  const summaryCurrent =
    !!summary && summary.fingerprint === reportRootFingerprint(root.fen, moves);
  const hasMoves = root.children.length > 0;

  const modal = (
    <ReportModal
      tab={ownerTabId}
      initialFen={root.fen}
      moves={moves}
      reportingMode={reportingMode}
      closeReportingMode={closeReportingMode}
      setInProgress={setInProgress}
      registerOperation={setReportOperationId}
    />
  );

  if (!hasMoves) {
    return (
      <ScrollArea h="100%" pt="xs" pl="xs" offsetScrollbars>
        {modal}
        <Paper withBorder p="md" mr="xs" data-testid="report-needs-moves">
          <Text c="dimmed">{t("Board.Analysis.Report.NeedsMoves")}</Text>
        </Paper>
      </ScrollArea>
    );
  }

  return (
    <ScrollArea h="100%" pt="xs" pl="xs" offsetScrollbars>
      {modal}
      <Stack mb="lg" gap="0.4rem" mr="xs">
        <ProgressButton
          id={progressId}
          redoable
          leftIcon={<ScanSearch size="0.875rem" />}
          onClick={openReportingMode}
          onCancel={handleCancel}
          completeOnProgressSuccess={false}
          labels={{
            action: summaryCurrent
              ? t("Board.Analysis.RegenerateReport")
              : t("Board.Analysis.GenerateReport"),
            inProgress: t("Board.Analysis.GeneratingReport"),
          }}
          inProgress={inProgress}
          setInProgress={setInProgress}
        />

        {summary &&
          (summaryCurrent ? (
            <ReportProvenance summary={summary} />
          ) : (
            <Text fz="sm" c="dimmed" data-testid="report-outdated">
              {t("Board.Analysis.Report.Outdated")}
            </Text>
          ))}

        {(stats.white.accuracy !== null || stats.black.accuracy !== null) && (
          <Group grow>
            <AccuracyCard
              color={t("Common.WHITE")}
              accuracy={stats.white.accuracy}
              cpl={stats.white.acpl}
            />
            <AccuracyCard
              color={t("Common.BLACK")}
              accuracy={stats.black.accuracy}
              cpl={stats.black.acpl}
            />
          </Group>
        )}

        <Paper withBorder p="md">
          {stats.scoredPositions === 0 && !inProgress ? (
            <Stack gap="xs" align="flex-start" data-testid="report-not-analysed">
              <Text c="dimmed">{t("Board.Analysis.Report.NotAnalysed")}</Text>
              <Button variant="default" size="xs" onClick={openReportingMode}>
                {t("Board.Analysis.GenerateReport")}
              </Button>
            </Stack>
          ) : (
            <EvalChart isAnalysing={inProgress} />
          )}
        </Paper>

        {stats.keyMoments.length > 0 && (
          <KeyMoments moments={stats.keyMoments} goToMove={goToMove} />
        )}

        <GameStats
          whiteAnnotations={stats.white.annotations}
          blackAnnotations={stats.black.annotations}
        />
      </Stack>
    </ScrollArea>
  );
}

function formatLimit(t: TFunction, goMode: ReportSummary["goMode"]): string {
  if (goMode.t === "Depth") return t("Board.Analysis.Report.Limit.Depth", { value: goMode.c });
  if (goMode.t === "Time")
    return t("Board.Analysis.Report.Limit.Time", { value: goMode.c / MS_PER_SECOND });
  return t("Board.Analysis.Report.Limit.Nodes", { value: goMode.c.toLocaleString() });
}

const MS_PER_SECOND = 1000;

/** Which engine and limit produced the report on the board, and when. */
function ReportProvenance({ summary }: { summary: ReportSummary }) {
  const { t, i18n } = useTranslation();
  const date = new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium" }).format(
    summary.createdAt,
  );
  return (
    <Text fz="sm" c="dimmed" data-testid="report-provenance">
      {t("Board.Analysis.Report.Provenance", {
        engine: summary.engine,
        limit: formatLimit(t, summary.goMode),
        date,
      })}
      {summary.missingEvaluations > 0 &&
        ` ${t("Board.Analysis.Report.MissingEvaluations", { positions: summary.missingEvaluations })}`}
    </Text>
  );
}

/** The marked mainline moves in game order; a row goes to its move. */
function KeyMoments({
  moments,
  goToMove,
}: {
  moments: KeyMoment[];
  goToMove: (path: number[]) => void;
}) {
  const { t } = useTranslation();
  const formatEval = (score: KeyMoment["before"]) => (score ? formatScore(score.value) : NO_VALUE);
  return (
    <Paper withBorder p="md">
      <Text fw={600} mb="xs" id="report-key-moments">
        {t("Board.Analysis.Report.KeyMoments")}
      </Text>
      <Stack
        gap={2}
        component="ul"
        aria-labelledby="report-key-moments"
        className={classes.keyMoments}
      >
        {moments.map((moment) => {
          return (
            <li key={moment.halfMoves}>
              <UnstyledButton
                className={classes.keyMoment}
                // The mark's colour is a bar, not text: NAG hues on the card miss text contrast.
                style={{
                  "--key-moment-color": `var(--mantine-color-${ANNOTATION_INFO[moment.annotation].color}-6)`,
                }}
                onClick={() => goToMove(moment.path)}
                data-testid="report-key-moment"
              >
                <Text component="span" fw={600}>
                  {formatMoveNumber(moment.halfMoves)} {moment.san}
                  {moment.annotation}
                </Text>
                <Text component="span" fz="sm" className={classes.evalChange}>
                  {formatEval(moment.before)} → {formatEval(moment.after)}
                </Text>
                {moment.betterMove && (
                  <Text component="span" fz="sm" c="dimmed" className={classes.betterMove}>
                    {t("Board.Analysis.Report.BetterMove", { move: moment.betterMove })}
                  </Text>
                )}
              </UnstyledButton>
            </li>
          );
        })}
      </Stack>
    </Paper>
  );
}

type AnnotationStats = { whiteAnnotations: AnnotationCounts; blackAnnotations: AnnotationCounts };

const GameStats = memo(
  function GameStats({ whiteAnnotations, blackAnnotations }: AnnotationStats) {
    const { t } = useTranslation();

    const store = useContext(TreeStateContext)!;
    const goToAnnotation = useStore(store, (s) => s.goToAnnotation);

    return (
      <Paper withBorder p="xs">
        <Table layout="fixed" verticalSpacing={4} className={classes.annotationTable}>
          <Table.Thead>
            <Table.Tr>
              <Table.Th ta="center">{t("Common.WHITE")}</Table.Th>
              <Table.Th ta="center">{t("Board.Analysis.Report.MoveQuality")}</Table.Th>
              <Table.Th ta="center">{t("Common.BLACK")}</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {Object.keys(ANNOTATION_INFO)
              .filter((a) => isBasicAnnotation(a))
              .map((annotation) => {
                const s = annotation as BasicAnnotation;
                const { name, color, translationKey } = ANNOTATION_INFO[s];
                const w = whiteAnnotations[s];
                const b = blackAnnotations[s];
                const annotationName = translationKey ? t(`Annotate.${translationKey}`) : name;
                return (
                  <Table.Tr key={annotation}>
                    <AnnotationCount
                      annotation={s}
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
                      <Text component="span" fw="bold" mr="xs">
                        {annotation}
                      </Text>
                      {annotationName}
                    </Table.Th>
                    <AnnotationCount
                      annotation={s}
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
  },
  (prev, next) => {
    return (
      equal(prev.whiteAnnotations, next.whiteAnnotations) &&
      equal(prev.blackAnnotations, next.blackAnnotations)
    );
  },
);

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
    return <Table.Td ta="center">{total}</Table.Td>;
  }

  return (
    <Table.Td ta="center">
      <UnstyledButton
        className={classes.label}
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

/** Shown for a side without a scored move. */
const NO_VALUE = "–";

function AccuracyCard({
  color,
  cpl,
  accuracy,
}: {
  color: string;
  cpl: number | null;
  accuracy: number | null;
}) {
  const { t } = useTranslation();

  return (
    // One column at every width, so the two cards keep the same shape side by side.
    <Paper withBorder p="xs" data-testid="report-accuracy">
      <Stack gap={0} align="start">
        <Text c="dimmed">{color}</Text>
        <Text fz="xl" lh="normal" className={classes.figure}>
          {accuracy === null ? NO_VALUE : `${accuracy.toFixed(1)}%`}{" "}
          <Text component="span" fz="sm" c="dimmed">
            {t("Board.Analysis.Accuracy")}
          </Text>
        </Text>
        <Text fz="sm" className={classes.figure}>
          {cpl === null ? NO_VALUE : cpl.toFixed(1)} ACPL
        </Text>
      </Stack>
    </Paper>
  );
}
export default ReportPanel;
