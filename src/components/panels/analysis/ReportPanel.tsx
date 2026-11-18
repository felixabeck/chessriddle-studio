import { useTabAtom, useOwnerTabId } from "@/state/tabScope";
import { tauri } from "@/platform/tauri";
import { Grid, Group, Paper, ScrollArea, Stack, Text, UnstyledButton } from "@mantine/core";
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
import { ANNOTATION_INFO, isBasicAnnotation } from "@/utils/annotation";
import { getGameStats, getMainLine } from "@/utils/chess";
import classes from "./AnalysisPanel.module.css";
import ReportModal, { reportRootFingerprint } from "./ReportModal";
import { notifyUnlessCancelled } from "@/components/files/notifyError";
import { reportEngineFailure } from "./useDisplayedEngineLines";

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

  return (
    <ScrollArea offsetScrollbars>
      <ReportModal
        tab={ownerTabId}
        initialFen={root.fen}
        moves={getMainLine(root)}
        reportingMode={reportingMode}
        closeReportingMode={closeReportingMode}
        setInProgress={setInProgress}
        registerOperation={setReportOperationId}
        isCurrentOperation={isCurrentOperation}
      />
      <Stack mb="lg" gap="0.4rem" mr="xs">
        <ProgressButton
          id={progressId}
          redoable
          disabled={root.children.length === 0}
          leftIcon={<ScanSearch size="0.875rem" />}
          onClick={openReportingMode}
          onCancel={handleCancel}
          initInstalled={false}
          completeOnProgressSuccess={false}
          labels={{
            action: t("Board.Analysis.GenerateReport"),
            completed: t("Board.Analysis.ReportGenerated"),
            inProgress: t("Board.Analysis.GeneratingReport"),
          }}
          inProgress={inProgress}
          setInProgress={setInProgress}
        />

        {stats.whiteAccuracy > 0 && stats.blackAccuracy > 0 && (
          <Group grow>
            <AccuracyCard
              color={t("Common.WHITE")}
              accuracy={stats.whiteAccuracy}
              cpl={stats.whiteCPL}
            />
            <AccuracyCard
              color={t("Common.BLACK")}
              accuracy={stats.blackAccuracy}
              cpl={stats.blackCPL}
            />
          </Group>
        )}

        <Paper withBorder p="md">
          <EvalChart isAnalysing={inProgress} startAnalysis={openReportingMode} />
        </Paper>

        <GameStats {...stats} />
      </Stack>
    </ScrollArea>
  );
}

type Stats = ReturnType<typeof getGameStats>;

const GameStats = memo(
  function GameStats({ whiteAnnotations, blackAnnotations }: Stats) {
    const { t } = useTranslation();

    const store = useContext(TreeStateContext)!;
    const goToAnnotation = useStore(store, (s) => s.goToAnnotation);

    return (
      <Paper withBorder>
        <Grid columns={12} align="center" p="md">
          {Object.keys(ANNOTATION_INFO)
            .filter((a) => isBasicAnnotation(a))
            .map((annotation) => {
              const s = annotation as BasicAnnotation;
              const { name, color, translationKey } = ANNOTATION_INFO[s];
              const w = whiteAnnotations[s];
              const b = blackAnnotations[s];
              const annotationName = translationKey ? t(`Annotate.${translationKey}`) : name;
              return (
                <React.Fragment key={annotation}>
                  <AnnotationCount
                    annotation={s}
                    side="white"
                    total={w}
                    annotationName={annotationName}
                    goToAnnotation={goToAnnotation}
                  />
                  <Grid.Col
                    span={2}
                    style={{ textAlign: "center", fontWeight: "bold" }}
                    c={w + b > 0 ? color : undefined}
                  >
                    {annotation}
                  </Grid.Col>
                  <Grid.Col span={4} c={w + b > 0 ? color : undefined}>
                    {annotationName}
                  </Grid.Col>
                  <AnnotationCount
                    annotation={s}
                    side="black"
                    total={b}
                    annotationName={annotationName}
                    goToAnnotation={goToAnnotation}
                  />
                </React.Fragment>
              );
            })}
        </Grid>
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

type BasicAnnotation = "??" | "?" | "?!" | "!!" | "!" | "!?";

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
      <Grid.Col span={3} style={{ textAlign: "center" }}>
        {total}
      </Grid.Col>
    );
  }

  return (
    <Grid.Col span={3} style={{ textAlign: "center" }}>
      <UnstyledButton
        className={classes.label}
        c={color}
        aria-label={
          side === "white"
            ? t("Board.Analysis.NextAnnotationByWhite", { annotation: annotationName, total })
            : t("Board.Analysis.NextAnnotationByBlack", { annotation: annotationName, total })
        }
        onClick={() => goToAnnotation(annotation, side)}
      >
        {total}
      </UnstyledButton>
    </Grid.Col>
  );
}

function AccuracyCard({ color, cpl, accuracy }: { color: string; cpl: number; accuracy: number }) {
  const { t } = useTranslation();

  return (
    <Paper withBorder p="xs">
      <Group justify="space-between">
        <Stack gap={0} align="start">
          <Text c="dimmed">{color}</Text>
          <Text fz="sm">{cpl.toFixed(1)} ACPL</Text>
        </Stack>
        <Stack gap={0} align="center">
          <Text fz="xl" lh="normal">
            {accuracy.toFixed(1)}%
          </Text>
          <Text fz="sm" c="dimmed" lh="normal">
            {t("Board.Analysis.Accuracy")}
          </Text>
        </Stack>
      </Group>
    </Paper>
  );
}
export default ReportPanel;
