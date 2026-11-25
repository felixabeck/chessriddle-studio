import { Group, Paper, Text } from "@mantine/core";
import { StreakIcon } from "@/components/common/iconCatalog";
import { useTranslation } from "react-i18next";
import { formatDecimal, formatTime } from "@/utils/format";
import type { Puzzle } from "@/utils/puzzles";

export const unavailableValue = "-";

function PuzzleSessionStats({
  puzzles,
  currentPuzzle,
  isPuzzleIncomplete,
  hideRating,
  trackTime,
  elapsedTime,
}: {
  puzzles: Puzzle[];
  currentPuzzle: number;
  isPuzzleIncomplete: boolean;
  hideRating: boolean;
  trackTime: boolean;
  elapsedTime: number;
}) {
  const { t, i18n } = useTranslation();

  const wonPuzzles = puzzles.filter((p) => p.completion === "correct");
  const lostPuzzles = puzzles.filter((p) => p.completion === "incorrect");

  const totalCompleted = wonPuzzles.length + lostPuzzles.length;
  const accuracy =
    totalCompleted > 0 ? Math.round((wonPuzzles.length / totalCompleted) * 100) : null;

  let currentStreak = 0;
  for (let i = puzzles.length - 1; i >= 0; i--) {
    if (puzzles[i].completion === "correct") currentStreak++;
    else if (puzzles[i].completion === "incorrect") break;
  }

  const timedWonPuzzles = wonPuzzles.filter((p) => p.timeSpent !== undefined);
  const avgTimeSeconds =
    timedWonPuzzles.length > 0
      ? timedWonPuzzles.reduce((acc, p) => acc + (p.timeSpent ?? 0), 0) /
        timedWonPuzzles.length /
        1000
      : 0;

  return (
    <Group grow>
      <Paper withBorder p="xs">
        <Text size="xs" c="dimmed">
          {t("Puzzle.Rating")}
        </Text>
        <Text fw={700} size="lg">
          {isPuzzleIncomplete && hideRating && puzzles[currentPuzzle]?.rating
            ? "?"
            : puzzles[currentPuzzle]?.rating || unavailableValue}
        </Text>
      </Paper>

      {trackTime && (
        <Paper withBorder p="xs">
          <Text size="xs" c="dimmed">
            {t("Puzzle.Time")}
          </Text>
          <Text fw={700} size="lg" ff="monospace">
            {formatTime(elapsedTime, i18n.language)}
          </Text>
        </Paper>
      )}

      <Paper withBorder p="xs">
        <Text size="xs" c="dimmed">
          {t("Puzzle.Accuracy")}
        </Text>
        <Text
          fw={700}
          size="lg"
          c={accuracy === null ? "dimmed" : accuracy >= 50 ? "success" : "warning"}
        >
          {accuracy !== null ? `${accuracy}%` : unavailableValue}
        </Text>
      </Paper>

      <Paper withBorder p="xs">
        <Text size="xs" c="dimmed">
          {t("Puzzle.Streak")}
        </Text>
        <Group gap={2}>
          <Text fw={700} size="lg">
            {currentStreak}
          </Text>
          <StreakIcon size={20} color="var(--cf-warning)" />
        </Group>
      </Paper>

      {trackTime && avgTimeSeconds > 0 && (
        <Paper withBorder p="xs">
          <Text size="xs" c="dimmed">
            {t("Puzzle.AvgTime")}
          </Text>
          <Text fw={700} size="lg">
            {t("Common.SecondsShort", {
              value: formatDecimal(avgTimeSeconds, i18n.language),
            })}
          </Text>
        </Paper>
      )}
    </Group>
  );
}

export default PuzzleSessionStats;
