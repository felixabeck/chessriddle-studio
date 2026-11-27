import { Group, Paper, Text } from "@mantine/core";
import { useContext } from "react";
import { useTranslation } from "react-i18next";
import { match } from "ts-pattern";
import { useStore } from "zustand";
import { positionFromFen } from "@/utils/chessops";
import { formatTimeControl, getClockInfo, resolveTimeControl } from "@/utils/clock";
import { formatDecimal } from "@/utils/format";
import { TreeStateContext } from "../common/TreeStateContext";
import classes from "./Clock.module.css";

function Clock({
  color,
  turn,
  whiteTime,
  blackTime,
}: {
  color: "white" | "black";
  turn: "white" | "black";
  whiteTime?: number;
  blackTime?: number;
}) {
  const { t, i18n } = useTranslation();
  const store = useContext(TreeStateContext)!;
  const root = useStore(store, (s) => s.root);
  const position = useStore(store, (s) => s.position);
  const headers = useStore(store, (s) => s.headers);
  const currentNode = useStore(store, (s) => s.currentNode());
  const [pos] = positionFromFen(currentNode.fen);

  const { white, black } = getClockInfo({
    headers,
    root,
    currentClock: currentNode.clock,
    position,
    pos,
    whiteTime,
    blackTime,
  });

  const { value: clock, spent } = match(color)
    .with("white", () => white)
    .with("black", () => black)
    .exhaustive();
  const spentText =
    spent === undefined
      ? undefined
      : formatMoveTime(spent, i18n.language, (value) => t("Common.SecondsShort", { value }));
  const resolvedControl = resolveTimeControl(headers, color);
  const clockTitle = resolvedControl ? formatTimeControl(resolvedControl, t) : undefined;

  return (
    <Group gap={6} wrap="nowrap" align="center">
      {spentText !== undefined && (
        <Text
          size="sm"
          c="dimmed"
          className={classes.digits}
          title={t("Board.Clock.MoveTime")}
          aria-label={`${t("Board.Clock.MoveTime")}: ${spentText}`}
        >
          {spentText}
        </Text>
      )}
      <Paper
        className={`${classes.clock} ${color === "black" ? classes.blackClock : classes.whiteClock}`}
        title={clockTitle}
        styles={{
          root: {
            opacity: turn !== color ? 0.5 : 1,
            visibility: clock === undefined ? "hidden" : "visible",
            transition: "opacity 0.15s",
          },
        }}
      >
        <Text fz="lg" fw="bold" lh={1} className={classes.digits}>
          {clock === undefined ? "0:00" : formatClock(clock)}
        </Text>
      </Paper>
    </Group>
  );
}

/**
 * A move's duration: tenths under ten seconds, whole seconds under a minute, then the clock format.
 * `seconds` wraps a locale-formatted number in the catalogue's short seconds unit.
 */
export function formatMoveTime(
  spent: number,
  locale: string,
  seconds: (value: string) => string,
): string {
  if (spent < 10) return seconds(formatDecimal(spent, locale));
  if (spent < 60) return seconds(String(Math.floor(spent)));
  return formatClock(spent);
}

export function formatClock(seconds: number) {
  const ms = Math.round(Math.max(0, seconds) * 1000);
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);

  let timeString = `${minutes.toString().padStart(2, "0")}`;
  if (hours > 0) {
    timeString = `${hours}:${timeString}`;
  }
  if (ms < 60_000) {
    const tenths = Math.floor(ms / 100);
    timeString += `:${(tenths / 10).toFixed(1).padStart(4, "0")}`;
  } else {
    const wholeSeconds = Math.floor((ms % 60_000) / 1000);
    timeString += `:${wholeSeconds.toString().padStart(2, "0")}`;
  }
  return timeString;
}

export default Clock;
