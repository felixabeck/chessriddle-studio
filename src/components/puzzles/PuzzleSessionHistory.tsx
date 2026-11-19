import { Paper, ScrollArea, Stack } from "@mantine/core";
import type { Puzzle } from "@/utils/puzzles";
import ChallengeHistory from "../common/ChallengeHistory";
import GameNotation from "../common/GameNotation";
import MoveControls from "../common/MoveControls";
import { unavailableValue } from "./PuzzleSessionStats";

function PuzzleSessionHistory({
  puzzles,
  currentPuzzle,
  onSelect,
}: {
  puzzles: Puzzle[];
  currentPuzzle: number;
  onSelect: (index: number) => void;
}) {
  return (
    <Stack h="100%" gap="xs">
      <Paper withBorder p="md" mih="5rem">
        <ScrollArea h="100%" offsetScrollbars>
          <ChallengeHistory
            challenges={puzzles.map((p) => ({
              ...p,
              label: p.rating?.toString() ?? unavailableValue,
            }))}
            current={currentPuzzle}
            select={(i) => {
              if (i === currentPuzzle) return;
              onSelect(i);
            }}
          />
        </ScrollArea>
      </Paper>
      <Stack flex={1} gap="xs">
        <GameNotation />
        <MoveControls readOnly />
      </Stack>
    </Stack>
  );
}

export default PuzzleSessionHistory;
