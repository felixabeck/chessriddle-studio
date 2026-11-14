import { Paper, Progress, Text } from "@mantine/core";
import { useContext } from "react";
import { match } from "ts-pattern";
import { useStore } from "zustand";
import { positionFromFen } from "@/utils/chessops";
import { getClockInfo } from "@/utils/clock";
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

  const clock = match(color)
    .with("white", () => white.value)
    .with("black", () => black.value)
    .otherwise(() => undefined);
  const progress = match(color)
    .with("white", () => white.progress)
    .with("black", () => black.progress)
    .otherwise(() => 0);

  return (
    <Paper
      className={color === "black" ? classes.blackClock : classes.whiteClock}
      styles={{
        root: {
          opacity: turn !== color ? 0.5 : 1,
          visibility: clock === undefined ? "hidden" : "visible",
          transition: "opacity 0.15s",
        },
      }}
    >
      <Text fz="lg" fw="bold" px="xs">
        {clock === undefined ? "0:00" : formatClock(clock)}
      </Text>
      <Progress
        size="xs"
        w="100%"
        value={progress * 100}
        animated={turn === color}
        styles={{
          section: {
            animationDirection: "reverse",
          },
        }}
      />
    </Paper>
  );
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
