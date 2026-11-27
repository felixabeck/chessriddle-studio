import { Stack, Text, Tooltip, UnstyledButton } from "@mantine/core";
import cx from "clsx";
import equal from "fast-deep-equal";
import { useTranslation } from "react-i18next";
import { formatClock } from "@/components/boards/Clock";
import { formatMoveNumber, formatTime } from "@/utils/format";
import type { GameTimeUsage, MoveTimeEntry } from "@/utils/gameReview";
import classes from "./AnalysisPanel.module.css";

const MIN_BAR_HEIGHT_PERCENT = 10;

interface TimeStripProps {
  usage: GameTimeUsage;
  paths: readonly number[][];
  currentPosition: number[];
  onSelectMove: (path: number[]) => void;
}

/**
 * Per-move time-usage strip rendered beneath the evaluation chart when at least half of the
 * mainline moves carry a clock. Moves without a valid time-spent reading keep an empty slot.
 */
export function TimeStrip({ usage, paths, currentPosition, onSelectMove }: TimeStripProps) {
  const { t, i18n } = useTranslation();

  if (!usage.showTimeStrip) {
    return null;
  }

  const maxSpent = usage.moves.reduce(
    (max, entry) => (entry.spent !== null && entry.spent > max ? entry.spent : max),
    0,
  );

  return (
    <div
      className={classes.timeStripWrap}
      role="group"
      aria-label={t("Board.Analysis.Report.TimeUsage")}
      data-testid="report-time-strip"
    >
      <div className={classes.timeStripTrack}>
        {usage.moves.map((entry, index) => {
          if (entry.spent === null) {
            return (
              <div key={entry.mainlineIndex} className={classes.timeSlot} aria-hidden="true" />
            );
          }

          const path = paths[index] ?? [];
          const isCurrent = equal(path, currentPosition);
          const heightPercent =
            maxSpent > 0
              ? Math.max(MIN_BAR_HEIGHT_PERCENT, Math.round((entry.spent / maxSpent) * 100))
              : MIN_BAR_HEIGHT_PERCENT;

          return (
            <TimeBar
              key={entry.mainlineIndex}
              entry={entry}
              path={path}
              isCurrent={isCurrent}
              heightPercent={heightPercent}
              locale={i18n.language}
              onSelectMove={onSelectMove}
            />
          );
        })}
      </div>
    </div>
  );
}

function TimeBar({
  entry,
  path,
  isCurrent,
  heightPercent,
  locale,
  onSelectMove,
}: {
  entry: MoveTimeEntry;
  path: number[];
  isCurrent: boolean;
  heightPercent: number;
  locale: string;
  onSelectMove: (path: number[]) => void;
}) {
  const { t } = useTranslation();
  const moveText = `${formatMoveNumber(entry.halfMoves)} ${entry.san}`;
  const spentText = formatTime((entry.spent ?? 0) * 1000, locale);
  const leftText = entry.clock !== null ? formatClock(entry.clock) : "";

  const ariaLabel = t("Board.Analysis.Report.TimeBarLabel", {
    move: moveText,
    spent: spentText,
    left: leftText,
  });

  const tooltipContent = (
    <Stack gap={2}>
      <Text fz="xs" fw={600}>
        {moveText}
      </Text>
      <Text fz="xs" className={classes.figure}>
        {t("Board.Analysis.Report.TimeSpent", { time: spentText })}
      </Text>
      {entry.clock !== null && (
        <Text fz="xs" className={classes.figure}>
          {t("Board.Analysis.Report.TimeLeft", { time: leftText })}
        </Text>
      )}
      {entry.inTimeTrouble && (
        <Text fz="xs" fw={600} c="var(--cf-annotation-red-text)">
          {t("Annotate.TimeTrouble")}
        </Text>
      )}
    </Stack>
  );

  return (
    <div className={classes.timeSlot}>
      <Tooltip
        label={tooltipContent}
        withinPortal
        floatingStrategy="fixed"
        middlewares={{ flip: true, shift: true, inline: false }}
        events={{ hover: true, focus: true, touch: true }}
      >
        <UnstyledButton
          type="button"
          className={classes.timeBarButton}
          data-testid="report-time-bar"
          data-side={entry.color}
          data-current={isCurrent || undefined}
          data-time-trouble={entry.inTimeTrouble || undefined}
          aria-label={ariaLabel}
          onClick={() => onSelectMove(path)}
        >
          <span
            className={cx(
              classes.timeBarFill,
              entry.color === "white" ? classes.timeBarWhite : classes.timeBarBlack,
              entry.inTimeTrouble && classes.timeBarTrouble,
              isCurrent && classes.timeBarCurrent,
            )}
            style={{ height: `${heightPercent}%` }}
          />
        </UnstyledButton>
      </Tooltip>
    </div>
  );
}
