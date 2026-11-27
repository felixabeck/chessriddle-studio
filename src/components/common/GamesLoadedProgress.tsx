import { Progress, Stack, Text, type MantineSpacing } from "@mantine/core";
import { useTranslation } from "react-i18next";
import type { ProgressState } from "@/bindings";

export interface GamesLoadedProgressProps {
  /** Number of games loaded so far, or null/undefined before the first count arrives. */
  count: number | null | undefined;
  /** Reliable expected total, if known. Shown only while running when > 0 and count <= total. */
  total?: number | null;
  /** Whole-run lifecycle phase, not an individual lease's completion state. */
  phase: ProgressState;
  mt?: MantineSpacing;
}

/**
 * Shared live game-count line and progress bar for online game downloads.
 */
export function GamesLoadedProgress({ count, total, phase, mt }: GamesLoadedProgressProps) {
  const { t, i18n } = useTranslation();
  const format = new Intl.NumberFormat(i18n?.language);

  const isRunning = phase === "running";
  const hasCount = count !== null && count !== undefined;
  const showTotal =
    isRunning && hasCount && total !== null && total !== undefined && total > 0 && count <= total;

  let line: string;
  if (isRunning && !hasCount) {
    line = t("Common.LoadingGames", { defaultValue: "Loading games…" });
  } else if (showTotal) {
    line = t("Common.GamesLoadedOf", {
      count: total,
      loaded: format.format(count),
      total: format.format(total),
      defaultValue: "{{loaded}} of {{total}} games loaded",
    });
  } else {
    const effectiveCount = count ?? 0;
    line = t("Common.GamesLoaded", {
      count: effectiveCount,
      loaded: format.format(effectiveCount),
      defaultValue: "{{loaded}} games loaded",
    });
  }

  const barValue = showTotal
    ? Math.min(100, Math.max(0, (count / total) * 100))
    : isRunning || phase === "succeeded"
      ? 100
      : 0;

  return (
    <Stack gap={4} mt={mt}>
      <Text
        size="xs"
        c="dimmed"
        style={{ fontVariantNumeric: "tabular-nums" }}
        role="status"
        aria-live="polite"
      >
        {line}
      </Text>
      <Progress
        value={barValue}
        size="sm"
        striped={isRunning}
        animated={isRunning}
        aria-label={line}
      />
    </Stack>
  );
}
