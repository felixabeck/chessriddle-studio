import type { Config } from "@lichess-org/chessground/config";
import { Box } from "@mantine/core";
import { useElementSize, useForceUpdate } from "@mantine/hooks";
import { type Chess, type Color, type Move, type NormalMove, parseSquare } from "chessops";
import { chessgroundDests, chessgroundMove } from "chessops/compat";
import { makeFen } from "chessops/fen";
import { useAtomValue } from "jotai";
import { useState } from "react";
import { Chessground } from "@/chessground/Chessground";
import BoardFrame from "@/components/boards/BoardFrame";
import PromotionModal from "@/components/boards/PromotionModal";
import { moveHighlightAtom, showCoordinatesAtom } from "@/state/atoms";
import classes from "@/styles/Chessboard.module.css";

export default function PuzzleBoardSurface({
  position,
  fen,
  orientation,
  lastMove,
  canPlay,
  onMove,
  drawable,
  withVariationChooser = false,
}: {
  position: Chess | null;
  fen?: string;
  orientation: Color;
  lastMove?: Move;
  canPlay: boolean;
  onMove: (move: Move) => void | Promise<void>;
  drawable?: Config["drawable"];
  withVariationChooser?: boolean;
}) {
  const { ref, height } = useElementSize();
  const reset = useForceUpdate();
  const [pending, setPending] = useState<{ move: NormalMove; position: Chess } | null>(null);
  const moveHighlight = useAtomValue(moveHighlightAtom);
  const coordinates = useAtomValue(showCoordinatesAtom);
  const turn = position?.turn ?? "white";
  async function accept(move: Move) {
    try {
      if (canPlay && position?.isLegal(move)) await onMove(move);
    } finally {
      setPending(null);
      reset();
    }
  }
  // A rejected move must restore Chessground and never escape its event handler.
  function play(move: Move) {
    void accept(move).catch(() => undefined);
  }
  return (
    <Box w="100%" h="100%" ref={ref}>
      <BoardFrame style={{ maxWidth: height }} withVariationChooser={withVariationChooser}>
        <Box className={classes.chessboard}>
          <PromotionModal
            pendingMove={pending?.position === position && canPlay ? pending.move : null}
            cancelMove={() => {
              setPending(null);
              reset();
            }}
            confirmMove={(promotion) => {
              if (pending?.position === position) play({ ...pending.move, promotion });
            }}
            turn={turn}
            orientation={orientation}
          />
          <Chessground
            animation={{ enabled: true }}
            coordinates={coordinates !== "no"}
            coordinatesOnSquares={coordinates === "all"}
            orientation={orientation}
            drawable={{ enabled: true, visible: true, ...drawable }}
            movable={{
              free: false,
              color: canPlay ? turn : undefined,
              dests: position ? chessgroundDests(position) : new Map(),
              events: {
                after: (orig, dest) => {
                  const from = parseSquare(orig);
                  const to = parseSquare(dest);
                  if (from === undefined || to === undefined || !canPlay || !position) {
                    reset();
                    return;
                  }
                  const move: NormalMove = { from, to };
                  if (
                    position.board.get(from)?.role === "pawn" &&
                    ((dest[1] === "8" && turn === "white") || (dest[1] === "1" && turn === "black"))
                  )
                    setPending({ move, position });
                  else play(move);
                },
              },
            }}
            lastMove={moveHighlight && lastMove ? chessgroundMove(lastMove) : undefined}
            turnColor={turn}
            fen={fen ?? (position ? makeFen(position.toSetup()) : undefined)}
            check={moveHighlight && position?.isCheck()}
          />
        </Box>
      </BoardFrame>
    </Box>
  );
}
