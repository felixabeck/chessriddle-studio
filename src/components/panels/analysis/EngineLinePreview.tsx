import type { Key } from "@lichess-org/chessground/types";
import { Box, Portal } from "@mantine/core";
import { useForceUpdate } from "@mantine/hooks";
import { chessgroundMove } from "chessops/compat";
import { makeFen } from "chessops/fen";
import { parseSan } from "chessops/san";
import { useAtomValue } from "jotai";
import { type RefObject, useLayoutEffect, useState } from "react";
import { Chessground } from "@/chessground/Chessground";
import { moveHighlightAtom, previewBoardOnHoverAtom } from "@/state/atoms";
import { positionFromFen } from "@/utils/chessops";
import EngineLineMove, { engineLineMoveNumber } from "./EngineLineMove";

/** Edge length of the hover preview board, in pixels. */
const PREVIEW_SIZE = 200;

type PreviewMoveInfo = { san: string; fen: string; lastMove: Key[]; isCheck: boolean };

/** Replays `sanMoves` from `fen`, stopping at the first move that is not legal there. */
export function engineLinePositions(fen: string, sanMoves: string[]): PreviewMoveInfo[] {
  const [pos] = positionFromFen(fen);
  const positions: PreviewMoveInfo[] = [];
  if (!pos) return positions;
  for (const san of sanMoves) {
    const move = parseSan(pos, san);
    if (!move) break;
    pos.play(move);
    positions.push({
      san,
      fen: makeFen(pos.toSetup()),
      lastMove: chessgroundMove(move),
      isCheck: pos.isCheck(),
    });
  }
  return positions;
}

/**
 * Where the preview board goes for an anchor occupying `top`..`bottom`: below it, else
 * above it, else (an anchor taller than the space on both sides, such as an expanded
 * line) pinned to the bottom of the window, so the board is never cut off.
 */
export function previewTop(top: number, bottom: number, viewportHeight: number) {
  if (bottom + PREVIEW_SIZE <= viewportHeight) return bottom;
  if (top - PREVIEW_SIZE >= 0) return top - PREVIEW_SIZE;
  return Math.max(0, viewportHeight - PREVIEW_SIZE);
}

/** Read at render time, so the caller re-renders it when the anchor moves. */
function previewPosition(anchor: HTMLElement | null) {
  const rect = anchor?.getBoundingClientRect();
  if (!rect) return { left: 0, top: 0 };
  return { left: rect.left, top: previewTop(rect.top, rect.bottom, window.innerHeight) };
}

/**
 * One engine-line move that shows the position after it on a small board while hovered,
 * placed against `anchor` (the line it belongs to).
 */
export function PreviewEngineLineMove({
  move: { san, fen, lastMove, isCheck },
  index,
  moves,
  halfMoves,
  threat,
  orientation,
  anchor,
  inert,
}: {
  move: PreviewMoveInfo;
  index: number;
  moves: string[];
  halfMoves: number;
  threat: boolean;
  orientation: "white" | "black";
  anchor: RefObject<HTMLElement | null>;
  inert: boolean;
}) {
  const { isWhite } = engineLineMoveNumber(halfMoves, index, threat);
  const preview = useAtomValue(previewBoardOnHoverAtom);
  const moveHighlight = useAtomValue(moveHighlightAtom);
  const [hovering, setHovering] = useState(false);
  const shown = !inert && preview && hovering;

  const reposition = useForceUpdate();
  useLayoutEffect(() => {
    if (!shown) return;
    document.addEventListener("analysis-panel-scroll", reposition);
    return () => document.removeEventListener("analysis-panel-scroll", reposition);
  }, [shown, reposition]);

  return (
    <>
      <Box
        onMouseEnter={() => {
          if (!inert) setHovering(true);
        }}
        onMouseLeave={() => setHovering(false)}
      >
        <EngineLineMove
          san={san}
          index={index}
          moves={moves}
          halfMoves={halfMoves}
          threat={threat}
          inert={inert}
        />
      </Box>
      {shown && (
        <Portal>
          <Box
            data-testid="engine-line-preview"
            w={PREVIEW_SIZE}
            // The board may overlap the hovered move (a clamped placement); it must not take
            // the pointer from it, or the move's mouse-leave would dismiss the board.
            style={{ ...previewPosition(anchor.current), pointerEvents: "none" }}
            pos="fixed"
          >
            <Chessground
              fen={fen}
              coordinates={false}
              viewOnly
              orientation={orientation}
              lastMove={moveHighlight ? lastMove : undefined}
              turnColor={isWhite ? "black" : "white"}
              check={moveHighlight && isCheck}
              drawable={{
                enabled: true,
                visible: true,
                defaultSnapToValidMove: true,
                eraseOnMovablePieceClick: true,
              }}
            />
          </Box>
        </Portal>
      )}
    </>
  );
}
