import { Button, Group, Kbd, Loader, Paper, Portal, Stack, Text, Title } from "@mantine/core";
import { makeUci, parseUci } from "chessops";
import {
  ChevronFirst,
  ChevronLast,
  ChevronLeft,
  ChevronRight,
  Keyboard,
  Settings,
} from "lucide-react";
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { useHotkeys } from "react-hotkeys-hook";
import { useTranslation } from "react-i18next";
import IconAction from "@/components/common/IconAction";
import AppModal from "@/components/common/AppModal";
import { notifyUnlessCancelled } from "@/components/files/notifyError";
import PuzzleBoardSurface from "@/components/puzzles/PuzzleBoardSurface";
import { ChessRiddleAccountCard } from "@/components/home/ChessRiddleAccountCard";
import { chessRiddleTrainingSessions as sessions } from "@/state/chessRiddleTraining";
import { trainingSettings } from "@/state/chessRiddleTrainingSettings";
import { trainingSummary } from "@/state/chessRiddleTrainingSummary";
import { tabsAtom } from "@/state/atoms";
import { keyMapAtom } from "@/state/keybinds";
import { tauri } from "@/platform/tauri";
import { ChessRiddleCommandError, requiresChessRiddleConnection } from "@/platform/chessriddle";
import type { AccountError } from "@/bindings";
import {
  canSubmitTraining,
  trainingPosition,
  trainingSan,
  trainingAnalysisTree,
} from "@/utils/chessRiddleTraining";
import { createTab, runTabCreation } from "@/utils/tabs";
import { isKeyboardOwnedElsewhere } from "@/utils/keyboardOwnership";
import { formatKeymap } from "@/utils/formatKeymap";
import TrainingSettings from "./TrainingSettings";
import TrainingTimer from "./TrainingTimer";
import { difficultyOptions, motifLabel } from "./trainingLabels";
import TrainingError, { trainingErrorMessage } from "./TrainingError";
import { useTrainingSession } from "./useTrainingSession";
import classes from "./ChessRiddleTraining.module.css";

export default function ChessRiddleTraining({
  id,
  sourceControl,
  onOffline,
}: {
  id: string;
  sourceControl: ReactNode;
  onOffline: () => void;
}) {
  const { t } = useTranslation();
  const state = useTrainingSession(id);
  const settings = useSyncExternalStore(trainingSettings.subscribe, trainingSettings.get);
  const summary = useSyncExternalStore(trainingSummary.subscribe, trainingSummary.get);
  const effective = trainingSettings.effective(settings);
  const activeFilters = `${difficultyOptions(t).find((option) => option.value === String(effective.difficulty))?.label ?? ""} · ${effective.motif ? motifLabel(effective.motif, t) : t("Training.Settings.AllMotifs")}`;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [websiteError, setWebsiteError] = useState<AccountError | null>(null);
  const [websitePending, setWebsitePending] = useState(false);
  const setTabs = useSetAtom(tabsAtom);
  const keys = useAtomValue(keyMapAtom);
  const { puzzle, phase, verdict, line, cursor } = state;
  useEffect(() => {
    if (state.available && state.phase === "idle") {
      void sessions.next(id);
      void sessions.refreshMistakeCount(id);
    }
  }, [id, state.available, state.phase]);
  useEffect(() => {
    if (phase === "verdict") void sessions.refreshMistakeCount(id);
  }, [id, phase]);
  const solution = phase === "verdict";
  const displayedLine = solution ? (verdict?.correctVariation ?? []) : line;
  const position = puzzle ? trainingPosition(puzzle, displayedLine, cursor) : null;
  const sans = puzzle ? trainingSan(puzzle, displayedLine) : [];
  const lastMove = puzzle
    ? parseUci(cursor === 0 ? puzzle.entranceMove : displayedLine[cursor - 1])
    : undefined;
  const solving = phase === "solving";
  const canPlay = solving && cursor === line.length && line.length < state.inputCap;
  const waiting = phase === "idle" || phase === "loading" || phase === "submitting";
  const actions = sessions.actions(id, state);
  const needsAccount =
    state.failedOperation !== "availability" && requiresChessRiddleConnection(state.error);
  const resume = () => {
    void trainingSettings.load(true).then(() => {
      void sessions.next(id);
      void sessions.refreshMistakeCount(id);
    });
  };
  const shortcutOptions = {
    preventDefault: true,
    ignoreEventWhen: (event: KeyboardEvent) =>
      event.repeat ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      settingsOpen ||
      shortcutsOpen ||
      document.querySelector('[aria-modal="true"]') !== null ||
      isKeyboardOwnedElsewhere(event, null),
  };
  useHotkeys(
    "enter,a",
    () => {
      if (actions.includes("next")) void sessions.next(id);
      else if (solving && puzzle && canSubmitTraining(puzzle, line, state.submitThreshold))
        void sessions.submit(id);
    },
    shortcutOptions,
  );
  useHotkeys(keys.PREVIOUS_MOVE.keys, () => sessions.step(id, cursor - 1), shortcutOptions);
  useHotkeys(keys.NEXT_MOVE.keys, () => sessions.step(id, cursor + 1), shortcutOptions);
  useHotkeys("?", () => setShortcutsOpen(true), { ...shortcutOptions, ignoreModifiers: true });
  useEffect(() => {
    let current = true;
    if (websitePending)
      void tauri
        .chessriddleOpenWebsite()
        .then(() => {
          if (current) setWebsiteError(null);
        })
        .catch((cause: unknown) => {
          if (current) setWebsiteError(new ChessRiddleCommandError(cause).code);
        })
        .finally(() => {
          if (current) setWebsitePending(false);
        });
    return () => {
      current = false;
    };
  }, [websitePending]);
  const offlineAction = (
    <Button variant="subtle" className={classes.offlineAction} onClick={onOffline}>
      {t("Puzzle.Source.UseOffline")}
    </Button>
  );
  return (
    <>
      <Portal target="#left" style={{ height: "100%" }}>
        {position && puzzle && (
          <PuzzleBoardSurface
            position={position}
            orientation={puzzle.sideToMove}
            lastMove={lastMove}
            canPlay={canPlay}
            onMove={(move) => sessions.append(id, makeUci(move))}
          />
        )}
      </Portal>
      <Portal target="#topRight" className={classes.panelContainer}>
        <Paper withBorder className={classes.panel} data-training-panel>
          <Stack gap="xs" className={needsAccount ? undefined : classes.compactStack}>
            {sourceControl}
            {needsAccount ? (
              <Stack gap="sm" data-training-connect>
                <Text className={classes.connectPrompt}>
                  <span>{t("Training.ConnectPrompt")}</span> {t("Training.ConnectBenefits")}
                </Text>
                <ChessRiddleAccountCard onConnected={resume} />
                <div className={classes.secondaryActions} data-training-secondary-actions>
                  <Button variant="default" onClick={resume}>
                    {t("Training.TryAgain")}
                  </Button>
                  {offlineAction}
                </div>
              </Stack>
            ) : (
              <>
                <div className={classes.headingRow}>
                  <Title order={3} className={classes.heading}>
                    {t("Training.Title")}
                  </Title>
                  <div className={classes.headingControls}>
                    {settings.status === "ready" && (
                      <>
                        <Text
                          size="xs"
                          c="dimmed"
                          className={classes.activeFilters}
                          data-training-filters
                          id={`training-filters-${id}`}
                        >
                          {activeFilters}
                        </Text>
                        <IconAction
                          variant="subtle"
                          label={t("Training.Settings.Title")}
                          title={activeFilters}
                          aria-describedby={`training-filters-${id}`}
                          onClick={() => setSettingsOpen(true)}
                        >
                          <Settings size={18} />
                        </IconAction>
                      </>
                    )}
                    <IconAction
                      variant="subtle"
                      label={t("Training.Shortcuts.Title")}
                      onClick={() => setShortcutsOpen(true)}
                    >
                      <Keyboard size={18} />
                    </IconAction>
                  </div>
                </div>
                <Group gap="xs" className={classes.summary} data-training-summary>
                  <Text c="dimmed">{t("Training.Session.Title")}</Text>
                  <Text data-training-rating>
                    {t("Training.Session.Rating")} {summary.rating ?? "—"}
                    {summary.ratedAttempts > 0 &&
                      ` (${summary.change >= 0 ? "+" : ""}${summary.change})`}
                  </Text>
                  {summary.error && (
                    <Group gap={4} className={classes.summaryError}>
                      <Text size="sm" c="warning" role="alert">
                        {trainingErrorMessage(summary.error, t)}
                      </Text>
                      <Button
                        variant="subtle"
                        size="compact-xs"
                        disabled={summary.loading}
                        onClick={() => void trainingSummary.load()}
                      >
                        {t("Training.Retry")}
                      </Button>
                    </Group>
                  )}
                  {summary.attempts > 0 && (
                    <>
                      <Text data-training-solved>
                        {t("Training.Session.Solved")} {summary.correct} / {summary.attempts}
                      </Text>
                      <Text data-training-success>
                        {t("Training.Session.Success")}{" "}
                        {Math.round((summary.correct / summary.attempts) * 100)}%
                      </Text>
                    </>
                  )}
                </Group>
                {settings.error && (
                  <Group gap={4}>
                    <TrainingError id={id} error={settings.error} />
                    <Button variant="subtle" onClick={() => void trainingSettings.load(true)}>
                      {t("Training.Retry")}
                    </Button>
                  </Group>
                )}
                <div className={classes.sources}>
                  <Button
                    variant={state.source === "tactics" ? "filled" : "default"}
                    disabled={phase === "submitting" || !state.available}
                    onClick={() => void sessions.next(id, "tactics")}
                  >
                    {t("Training.Tactics")}
                  </Button>
                  <Button
                    variant={state.source === "mistakes" ? "filled" : "default"}
                    disabled={phase === "submitting" || !state.available}
                    onClick={() => void sessions.next(id, "mistakes")}
                  >
                    {state.mistakeCount === null
                      ? t("Training.Mistakes")
                      : t("Training.MistakesCount", { mistakes: state.mistakeCount })}
                  </Button>
                </div>
                {state.mistakeCountError && state.mistakeCountError !== state.error && (
                  <>
                    <TrainingError id={id} error={state.mistakeCountError} />
                    <Button variant="default" onClick={() => void sessions.refreshMistakeCount(id)}>
                      {t("Training.Retry")}
                    </Button>
                  </>
                )}
                {waiting && state.available !== false && (
                  <Group role="status">
                    <Loader size="sm" />
                    <Text>
                      {phase === "submitting" ? t("Training.Submitting") : t("Training.Loading")}
                    </Text>
                  </Group>
                )}
                {state.available === false && <TrainingError id={id} error="unavailable" />}
                {state.error && <TrainingError id={id} error={state.error} />}
                {state.error === "noMatch" && settings.status === "ready" && (
                  <Button onClick={() => setSettingsOpen(true)}>
                    {t("Training.Settings.Title")}
                  </Button>
                )}
                {state.failedOperation === "availability" && offlineAction}
                {state.upgradeError && <TrainingError id={id} error={state.upgradeError} />}
                {phase === "empty" && <Text role="status">{t("Training.NoMistakes")}</Text>}
                {puzzle && phase !== "error" && (
                  <>
                    <Text fw={600}>
                      {puzzle.sideToMove === "white"
                        ? t("Training.WhiteToMove")
                        : t("Training.BlackToMove")}
                    </Text>
                    {solving && (
                      <Text size="sm" c="dimmed">
                        {t("Training.EnterBothSides")}
                      </Text>
                    )}
                    <Group justify="space-between">
                      <Text>
                        {t("Training.MoveCount", { entered: line.length, total: state.inputCap })}
                      </Text>
                      <Text>{t("Training.PuzzleRating", { rating: puzzle.puzzleRating })}</Text>
                    </Group>
                  </>
                )}
                {solving && effective.showTimer && state.elapsedStart !== null && (
                  <TrainingTimer start={state.elapsedStart} settings={effective} />
                )}
                {solving && verdict?.tooShort && (
                  <Text role="status" c="warning">
                    {t("Training.TooShort")}
                  </Text>
                )}
                {solution && verdict && (
                  <Stack gap={4} role="status">
                    <Text fw={600} c={verdict.isCorrect ? "success" : "danger"}>
                      {verdict.isCorrect ? t("Training.Correct") : t("Training.Incorrect")}
                    </Text>
                    <Text size="sm">
                      {t("Training.RatingChange", {
                        change:
                          verdict.ratingChange > 0
                            ? `+${verdict.ratingChange}`
                            : verdict.ratingChange,
                      })}
                    </Text>
                    {!verdict.rated && <Text c="dimmed">{t("Training.Unrated")}</Text>}
                    {verdict.ratingPending && <Text c="dimmed">{t("Training.RatingPending")}</Text>}
                  </Stack>
                )}
                {solving && puzzle && (
                  <div className={classes.actions}>
                    <Button
                      variant="default"
                      disabled={line.length === 0}
                      onClick={() => sessions.undo(id)}
                    >
                      {t("Training.Undo")}
                    </Button>
                    <Button
                      disabled={!canSubmitTraining(puzzle, line, state.submitThreshold)}
                      onClick={() => void sessions.submit(id)}
                    >
                      {t("Training.Submit")}
                    </Button>
                    <Button variant="default" onClick={() => void sessions.submit(id, true)}>
                      {t("Training.ShowSolution")}
                    </Button>
                  </div>
                )}
                {actions.includes("retry") && (
                  <Button onClick={() => void sessions.retry(id)}>{t("Training.Retry")}</Button>
                )}
                <Group grow gap="xs">
                  {actions.includes("next") && (
                    <Button onClick={() => void sessions.next(id)}>{t("Training.Next")}</Button>
                  )}
                  {solution && puzzle && verdict && (
                    <Button
                      variant="default"
                      onClick={() =>
                        void runTabCreation({
                          create: () =>
                            createTab({
                              tab: { name: t("Puzzle.AnalysisTitle"), type: "analysis" },
                              setTabs,
                              initialTree: trainingAnalysisTree(puzzle, verdict.correctVariation),
                            }),
                          onError: (error) => notifyUnlessCancelled(t("Common.Error"), error),
                        })
                      }
                    >
                      {t("Training.Analyse")}
                    </Button>
                  )}
                </Group>
              </>
            )}
            <Button
              variant="subtle"
              size="compact-xs"
              disabled={websitePending}
              onClick={() => setWebsitePending(true)}
            >
              {t("Training.Website")}
            </Button>
            {websiteError && <TrainingError id={id} error={websiteError} />}
          </Stack>
        </Paper>
      </Portal>
      <TrainingSettings id={id} opened={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <AppModal
        opened={shortcutsOpen}
        onClose={() => setShortcutsOpen(false)}
        title={t("Training.Shortcuts.Title")}
      >
        <dl className={classes.shortcuts}>
          <dt>
            <Group gap={4}>
              <Kbd>{formatKeymap("Enter")}</Kbd>
              <Kbd>{formatKeymap("A")}</Kbd>
            </Group>
          </dt>
          <dd>{t("Training.Shortcuts.SubmitAction")}</dd>
          <dt>
            <Kbd>{formatKeymap(keys.PREVIOUS_MOVE.keys)}</Kbd>
          </dt>
          <dd>{t("Training.PreviousPosition")}</dd>
          <dt>
            <Kbd>{formatKeymap(keys.NEXT_MOVE.keys)}</Kbd>
          </dt>
          <dd>{t("Training.NextPosition")}</dd>
          <dt>
            <Kbd>{formatKeymap("?")}</Kbd>
          </dt>
          <dd>{t("Training.Shortcuts.HelpAction")}</dd>
        </dl>
      </AppModal>
      <Portal target="#bottomRight" style={{ height: "100%" }}>
        <Paper withBorder p="md" h="100%" style={{ overflowY: "auto", overflowWrap: "anywhere" }}>
          <Stack>
            <Title order={3}>{solution ? t("Training.Solution") : t("Training.EnteredLine")}</Title>
            {puzzle && (
              <>
                <Group gap="xs">
                  {sans.map((san, index) => (
                    <Button
                      key={`${index}:${san}`}
                      size="compact-sm"
                      variant={cursor === index + 1 ? "filled" : "subtle"}
                      onClick={() => sessions.step(id, index + 1)}
                    >
                      {san}
                    </Button>
                  ))}
                </Group>
                <Group gap="xs" wrap="wrap">
                  <IconAction
                    label={t("Training.FirstPosition")}
                    disabled={cursor === 0}
                    onClick={() => sessions.step(id, 0)}
                  >
                    <ChevronFirst />
                  </IconAction>
                  <IconAction
                    label={t("Training.PreviousPosition")}
                    disabled={cursor === 0}
                    onClick={() => sessions.step(id, cursor - 1)}
                  >
                    <ChevronLeft />
                  </IconAction>
                  <Text size="sm">
                    {t("Training.PositionCount", { current: cursor, total: displayedLine.length })}
                  </Text>
                  <IconAction
                    label={t("Training.NextPosition")}
                    disabled={cursor === displayedLine.length}
                    onClick={() => sessions.step(id, cursor + 1)}
                  >
                    <ChevronRight />
                  </IconAction>
                  <IconAction
                    label={t("Training.LastPosition")}
                    disabled={cursor === displayedLine.length}
                    onClick={() => sessions.step(id, displayedLine.length)}
                  >
                    <ChevronLast />
                  </IconAction>
                </Group>
              </>
            )}
          </Stack>
        </Paper>
      </Portal>
    </>
  );
}
