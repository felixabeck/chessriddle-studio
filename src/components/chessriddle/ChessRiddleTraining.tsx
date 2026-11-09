import { Button, Group, Loader, Paper, Portal, Stack, Text, Title } from "@mantine/core";
import { makeUci, parseUci } from "chessops";
import { ChevronFirst, ChevronLast, ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import IconAction from "@/components/common/IconAction";
import PuzzleBoardSurface from "@/components/puzzles/PuzzleBoardSurface";
import { chessRiddleTrainingSessions as sessions } from "@/state/chessRiddleTraining";
import { canSubmitTraining, trainingPosition, trainingSan } from "@/utils/chessRiddleTraining";
import TrainingError from "./TrainingError";
import { useTrainingSession } from "./useTrainingSession";
import classes from "./ChessRiddleTraining.module.css";

export default function ChessRiddleTraining({ id }: { id: string }) {
  const { t } = useTranslation();
  const state = useTrainingSession(id);
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
  const actions = sessions.actions(id);
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
          <Stack gap="sm">
            <Title order={3} className={classes.heading}>
              {t("Training.Title")}
            </Title>
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
            {state.upgradeError && <TrainingError id={id} error={state.upgradeError} />}
            {phase === "empty" && <Text role="status">{t("Training.NoMistakes")}</Text>}
            {puzzle && (
              <>
                <Text fw={600}>
                  {puzzle.sideToMove === "white"
                    ? t("Training.WhiteToMove")
                    : t("Training.BlackToMove")}
                </Text>
                <Text size="sm" c="dimmed">
                  {t("Training.EnterBothSides")}
                </Text>
                <Group justify="space-between">
                  <Text>
                    {t("Training.MoveCount", { entered: line.length, total: state.inputCap })}
                  </Text>
                  <Text>{t("Training.PuzzleRating", { rating: puzzle.puzzleRating })}</Text>
                </Group>
              </>
            )}
            {solving && verdict?.tooShort && (
              <Text role="status" c="warning">
                {t("Training.TooShort")}
              </Text>
            )}
            {solution && verdict && (
              <Stack gap="xs" role="status">
                <Text fw={600} c={verdict.isCorrect ? "success" : "danger"}>
                  {verdict.isCorrect ? t("Training.Correct") : t("Training.Incorrect")}
                </Text>
                <Text>
                  {t("Training.RatingChange", {
                    change:
                      verdict.ratingChange > 0 ? `+${verdict.ratingChange}` : verdict.ratingChange,
                  })}
                </Text>
                {verdict.playerRating !== null && (
                  <Text>{t("Training.PlayerRating", { rating: verdict.playerRating })}</Text>
                )}
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
            {actions.includes("next") && (
              <Button onClick={() => void sessions.next(id)}>{t("Training.Next")}</Button>
            )}
          </Stack>
        </Paper>
      </Portal>
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
