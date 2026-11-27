import { useOwnerTabId, useTabAtom } from "@/state/tabScope";
import { tauri } from "@/platform/tauri";
import { Button, Group, Paper, Stack, Text, UnstyledButton } from "@mantine/core";
import type { TFunction } from "i18next";
import { RotateCcw, ScanSearch } from "lucide-react";
import { useAtom } from "jotai";
import { useCallback, useContext, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import EvalChart from "@/components/common/EvalChart";
import ProgressButton from "@/components/common/ProgressButton";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import { notifyUnlessCancelled } from "@/components/files/notifyError";
import { useProgress } from "@/hooks/useProgress";
import { reportModalOpenFamily } from "@/state/atoms";
import { ANNOTATION_INFO } from "@/utils/annotation";
import { getGameStats, getMainLine, type KeyMoment, reportRootFingerprint } from "@/utils/chess";
import { formatMoveNumber } from "@/utils/format";
import {
  type GameSummary,
  getMoveTimeUsage,
  type SummaryMoveRef,
  summarizeGame,
} from "@/utils/gameReview";
import { formatScore } from "@/utils/score";
import type { ReportSummary } from "@/utils/treeReducer";
import classes from "./AnalysisPanel.module.css";
import { reportEngineFailure } from "./engineFailure";
import { ExplainedLabel } from "./ExplainedLabel";
import ReportModal from "./ReportModal";
import { Scoreboard } from "./Scoreboard";
import { TimeStrip } from "./TimeStrip";

const MS_PER_SECOND = 1000;
const NO_VALUE = "–";

function ReportPanel() {
  const { t } = useTranslation();

  const ownerTabId = useOwnerTabId();

  const store = useContext(TreeStateContext)!;
  const root = useStore(store, (s) => s.root);
  const headers = useStore(store, (s) => s.headers);
  const position = useStore(store, (s) => s.position);
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
  const gameSummary = useMemo(() => summarizeGame(root), [root]);
  const timeUsage = useMemo(() => getMoveTimeUsage(root, headers), [root, headers]);
  const mainlinePaths = useMemo(() => {
    const paths: number[][] = [];
    let node = root;
    const path: number[] = [];
    while (node.children.length > 0) {
      node = node.children[0];
      path.push(0);
      paths.push([...path]);
    }
    return paths;
  }, [root]);

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
  const goToAnnotation = useStore(store, (s) => s.goToAnnotation);
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
      <div className={classes.panelContainer}>
        <div className={classes.panelScroll} data-testid="report-scroll">
          {modal}
          <Paper withBorder p="md" data-testid="report-needs-moves">
            <Text c="dimmed">{t("Board.Analysis.Report.NeedsMoves")}</Text>
          </Paper>
        </div>
      </div>
    );
  }

  return (
    <div className={classes.panelContainer}>
      <div className={classes.panelScroll} data-testid="report-scroll">
        {modal}
        <div className={classes.sections}>
          {summaryCurrent && !inProgress ? (
            <div className={classes.headerBar}>
              <ReportProvenance summary={summary} />
              <Button
                variant="default"
                size="xs"
                leftSection={<RotateCcw size="0.875rem" />}
                onClick={openReportingMode}
                style={{ flexShrink: 0 }}
              >
                {t("Board.Analysis.Report.Regenerate")}
              </Button>
            </div>
          ) : (
            <Stack gap="xs">
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
              {summary && !summaryCurrent && (
                <Text fz="sm" c="dimmed" data-testid="report-outdated">
                  {t("Board.Analysis.Report.Outdated")}
                </Text>
              )}
            </Stack>
          )}

          {gameSummary && (
            <Text fz="sm" fw={500} className={classes.summaryText} data-testid="report-summary">
              {formatGameSummary(t, gameSummary)}
            </Text>
          )}

          <div className={classes.overviewGrid}>
            <Scoreboard stats={stats} headers={headers} goToAnnotation={goToAnnotation} />

            <Paper withBorder p="md">
              {stats.scoredPositions === 0 && !inProgress ? (
                <Stack gap="xs" align="flex-start" data-testid="report-not-analysed">
                  <Text c="dimmed">{t("Board.Analysis.Report.NotAnalysed")}</Text>
                  <Button variant="default" size="xs" onClick={openReportingMode}>
                    {t("Board.Analysis.GenerateReport")}
                  </Button>
                </Stack>
              ) : (
                <Stack gap="xs">
                  <EvalChart isAnalysing={inProgress} />
                  <TimeStrip
                    usage={timeUsage}
                    paths={mainlinePaths}
                    currentPosition={position}
                    onSelectMove={goToMove}
                  />
                </Stack>
              )}
            </Paper>
          </div>

          {stats.keyMoments.length > 0 && (
            <KeyMoments moments={stats.keyMoments} goToMove={goToMove} />
          )}
        </div>
      </div>
    </div>
  );
}

function formatSummaryMove(move: SummaryMoveRef): string {
  return `${formatMoveNumber(move.halfMoves)} ${move.san}`;
}

function formatGameSummary(t: TFunction, summary: GameSummary): string {
  switch (summary.kind) {
    case "stayedBalanced":
      return t("Board.Analysis.Report.Summary.StayedBalanced");
    case "tookLead": {
      const move = formatSummaryMove(summary.move);
      return summary.side === "white"
        ? t("Board.Analysis.Report.Summary.TookLeadWhite", { move })
        : t("Board.Analysis.Report.Summary.TookLeadBlack", { move });
    }
    case "turnedGame": {
      const move = formatSummaryMove(summary.move);
      return summary.side === "white"
        ? t("Board.Analysis.Report.Summary.TurnedGameWhite", { move })
        : t("Board.Analysis.Report.Summary.TurnedGameBlack", { move });
    }
    case "balancedAgain": {
      const aheadMove = formatSummaryMove(summary.aheadMove);
      const balancedMove = formatSummaryMove(summary.balancedMove);
      return summary.side === "white"
        ? t("Board.Analysis.Report.Summary.BalancedAgainWhite", { aheadMove, balancedMove })
        : t("Board.Analysis.Report.Summary.BalancedAgainBlack", { aheadMove, balancedMove });
    }
  }
}

function formatLimit(t: TFunction, goMode: ReportSummary["goMode"]): string {
  if (goMode.t === "Depth") return t("Board.Analysis.Report.Limit.Depth", { value: goMode.c });
  if (goMode.t === "Time")
    return t("Board.Analysis.Report.Limit.Time", { value: goMode.c / MS_PER_SECOND });
  return t("Board.Analysis.Report.Limit.Nodes", { value: goMode.c.toLocaleString() });
}

/** Which engine and limit produced the report on the board, and when. */
function ReportProvenance({ summary }: { summary: ReportSummary }) {
  const { t, i18n } = useTranslation();
  const date = new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium" }).format(
    summary.createdAt,
  );
  return (
    <Text fz="sm" c="dimmed" className={classes.provenanceText} data-testid="report-provenance">
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
      <Group justify="space-between" align="baseline" gap="xs" mb="xs" wrap="wrap">
        <Text fw={600} id="report-key-moments">
          {t("Board.Analysis.Report.KeyMoments")}
        </Text>
        <ExplainedLabel
          label={t("Board.Analysis.Report.EvalDirectionLabel")}
          explanation={t("Board.Analysis.Report.EvalDirectionDesc")}
          size="xs"
          dimmed
        />
      </Group>
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

export default ReportPanel;
