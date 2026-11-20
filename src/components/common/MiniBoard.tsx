import type { DrawShape } from "@lichess-org/chessground/draw";
import type { Key } from "@lichess-org/chessground/types";
import { Box } from "@mantine/core";
import type { Color } from "chessops";
import { Chessground } from "@/chessground/Chessground";

/** Edge length of the small read-only board, in pixels. */
export const MINI_BOARD_SIZE = 200;

/**
 * The small read-only board: the engine line's hover preview and the notation's diagrams. It
 * takes no pointer events, so whatever holds it decides what a click or a hover means.
 */
export function MiniBoard({
  fen,
  orientation,
  lastMove,
  check,
  turnColor,
  shapes,
}: {
  fen: string;
  orientation: "white" | "black";
  lastMove?: Key[];
  /** Highlights the king of `turnColor`. */
  check?: boolean;
  turnColor: Color;
  shapes?: DrawShape[];
}) {
  return (
    <Box data-mini-board w={MINI_BOARD_SIZE} style={{ pointerEvents: "none" }}>
      <Chessground
        fen={fen}
        coordinates={false}
        viewOnly
        orientation={orientation}
        lastMove={lastMove}
        turnColor={turnColor}
        check={check}
        drawable={{
          enabled: true,
          visible: true,
          defaultSnapToValidMove: true,
          eraseOnMovablePieceClick: true,
          ...(shapes && { shapes }),
        }}
      />
    </Box>
  );
}
