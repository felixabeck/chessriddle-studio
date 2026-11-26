import type { Key } from "@lichess-org/chessground/types";
import { Box, getDefaultZIndex, Portal } from "@mantine/core";
import type { Color } from "chessops";
import { chessgroundMove } from "chessops/compat";
import { makeFen } from "chessops/fen";
import { parseSan } from "chessops/san";
import { useAtomValue } from "jotai";
import { type ReactNode, type RefObject, useEffect, useLayoutEffect, useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { MINI_BOARD_SIZE, MiniBoard } from "@/components/common/MiniBoard";
import { moveHighlightAtom, previewBoardOnHoverAtom } from "@/state/atoms";
import { keyMapAtom } from "@/state/keybinds";
import { positionFromFen } from "@/utils/chessops";
import { backgroundHotkeyOptions, ENGINE_LINE_PREVIEW_ATTRIBUTE } from "@/utils/keyboardOwnership";
import { ANALYSIS_PANEL_SCROLL_EVENT } from "./analysisPanelScroll";
import EngineLineMove from "./EngineLineMove";

/** The preview index of the line's start position, before its first move; only keys reach it. */
const LINE_START = -1;

type PreviewPosition = { fen: string; lastMove?: Key[]; isCheck: boolean; turn: Color };
type PreviewMoveInfo = PreviewPosition & { san: string; lastMove: Key[] };

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
      turn: pos.turn,
    });
  }
  return positions;
}

function startPosition(fen: string): PreviewPosition | null {
  const [pos] = positionFromFen(fen);
  return pos && { fen, isCheck: pos.isCheck(), turn: pos.turn };
}

/**
 * Where the preview board goes for an anchor occupying `top`..`bottom`: below it, else
 * above it, else (an anchor taller than the space on both sides, such as an expanded
 * line) pinned to the bottom of the window, so the board is never cut off.
 */
export function previewTop(top: number, bottom: number, viewportHeight: number) {
  if (bottom + MINI_BOARD_SIZE <= viewportHeight) return bottom;
  if (top - MINI_BOARD_SIZE >= 0) return top - MINI_BOARD_SIZE;
  return Math.max(0, viewportHeight - MINI_BOARD_SIZE);
}

function previewPlacement(anchor: HTMLElement | null) {
  const rect = anchor?.getBoundingClientRect();
  if (!rect) return { left: 0, top: 0 };
  return { left: rect.left, top: previewTop(rect.top, rect.bottom, window.innerHeight) };
}

/**
 * `index` is the previewed move (or LINE_START). `frozen` holds the line's moves from the first
 * key step on, so an engine update cannot change the line being stepped through. A `pinned`
 * preview was opened by a click on a preview-only line: it stays until it is dismissed.
 */
type PreviewState = { fen: string; index: number; frozen: string[] | null; pinned?: boolean };

/**
 * The hover preview board of one engine line searched from `fen`. Hovering a move opens the
 * board on the position after it; while it is open the next/previous move keys step through
 * the line on the preview board only. The board stays where it opened while stepping.
 *
 * A `previewOnly` line never plays its moves into the game: a click pins the board on that move
 * instead, also when hover previews are switched off. A pinned board ignores hovering and stays
 * until the same move is clicked again, Escape is pressed or something else is clicked.
 */
export function useEngineLinePreview({
  fen,
  moves,
  visibleCount,
  orientation,
  anchor,
  inert,
  previewOnly = false,
}: {
  fen: string;
  /** The whole line, in SAN. */
  moves: string[];
  /** How many of its moves the line shows (Infinity for all); hover and key steps stay within them. */
  visibleCount: number;
  orientation: "white" | "black";
  /** The line the board is placed against. */
  anchor: RefObject<HTMLElement | null>;
  inert: boolean;
  previewOnly?: boolean;
}) {
  const enabled = useAtomValue(previewBoardOnHoverAtom);
  const moveHighlight = useAtomValue(moveHighlightAtom);
  const keyMap = useAtomValue(keyMapAtom);
  const [state, setState] = useState<PreviewState | null>(null);

  // A new position or a dimmed line ends the preview and its frozen line.
  useEffect(() => setState(null), [fen, inert]);

  const current = state?.fen === fen && !inert && (enabled || state.pinned) ? state : null;
  const pinned = current?.pinned === true;
  const lineMoves = current?.frozen ?? moves;
  const positions = engineLinePositions(fen, lineMoves.slice(0, visibleCount));
  const index =
    current && positions.length > 0 ? Math.min(current.index, positions.length - 1) : null;
  const shown =
    index === null ? null : index === LINE_START ? startPosition(fen) : positions[index];
  const open = shown != null;

  const hover = (moveIndex: number) => {
    if (inert) return;
    setState((previous) =>
      previous?.fen === fen && previous.pinned
        ? previous
        : previous?.fen === fen && previous.frozen
          ? { ...previous, index: moveIndex }
          : { fen, index: moveIndex, frozen: null },
    );
  };
  const close = () => setState((previous) => (previous?.pinned ? previous : null));
  const pin = (moveIndex: number) => {
    if (inert) return;
    setState((previous) =>
      previous?.fen === fen && previous.pinned && previous.index === moveIndex
        ? null
        : { fen, index: moveIndex, frozen: moves, pinned: true },
    );
  };
  const step = (direction: 1 | -1) =>
    setState((previous) => {
      if (previous?.fen !== fen) return previous;
      // Step from the move shown, which a shorter live line may have clamped.
      const last = positions.length - 1;
      const from = Math.min(previous.index, last);
      const next = Math.max(LINE_START, Math.min(last, from + direction));
      return { ...previous, index: next, frozen: previous.frozen ?? moves };
    });

  const keyOptions = { ...backgroundHotkeyOptions, enabled: open, preventDefault: true };
  useHotkeys(keyMap.NEXT_MOVE.keys, () => step(1), keyOptions);
  useHotkeys(keyMap.PREVIOUS_MOVE.keys, () => step(-1), keyOptions);
  useHotkeys("escape", () => setState(null), { ...keyOptions, enabled: pinned });
  // A pinned board is dismissed by a click anywhere but on its own line.
  useEffect(() => {
    if (!pinned) return;
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && anchor.current?.contains(event.target)) return;
      setState(null);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [pinned, anchor]);

  // Placed once when it opens, so stepping never moves it; only a panel scroll does.
  const [placement, setPlacement] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    if (!open) {
      setPlacement(null);
      return;
    }
    const place = () => setPlacement(previewPlacement(anchor.current));
    place();
    document.addEventListener(ANALYSIS_PANEL_SCROLL_EVENT, place);
    return () => document.removeEventListener(ANALYSIS_PANEL_SCROLL_EVENT, place);
  }, [open, anchor]);

  const board: ReactNode = shown && placement && (
    <Portal>
      <Box
        data-testid="engine-line-preview"
        {...{ [ENGINE_LINE_PREVIEW_ATTRIBUTE]: true }}
        w={MINI_BOARD_SIZE}
        // The board may overlap the hovered move (a clamped placement); it must not take
        // the pointer from it, or the line's mouse-leave would dismiss the board.
        // It opens above a line below the board (the pinned engine) and so over the main
        // board, whose positioned chessground layers would otherwise paint over it.
        style={{ ...placement, pointerEvents: "none", zIndex: getDefaultZIndex("popover") }}
        pos="fixed"
      >
        <MiniBoard
          fen={shown.fen}
          orientation={orientation}
          lastMove={moveHighlight ? shown.lastMove : undefined}
          turnColor={shown.turn}
          check={moveHighlight && shown.isCheck}
        />
      </Box>
    </Portal>
  );

  return {
    /** The line's moves as shown: frozen while stepping, live otherwise. */
    moves: lineMoves,
    positions,
    /** The move the board shows, highlighted in the line. */
    previewedIndex: open ? index : null,
    hover,
    close,
    /** Present on a preview-only line: pins the board on a move, or releases it. */
    pin: previewOnly ? pin : undefined,
    board,
  };
}

/** The moves of a line from `useEngineLinePreview`, each opening or moving its preview on hover. */
export function EngineLinePreviewMoves({
  preview,
  halfMoves,
  threat,
  inert,
}: {
  preview: ReturnType<typeof useEngineLinePreview>;
  halfMoves: number;
  threat: boolean;
  inert: boolean;
}) {
  return preview.positions.map(({ san }, index) => (
    <EngineLineMove
      key={index}
      san={san}
      index={index}
      moves={preview.moves}
      halfMoves={halfMoves}
      threat={threat}
      inert={inert}
      previewed={preview.previewedIndex === index}
      onHover={preview.hover}
      onPick={preview.pin}
    />
  ));
}
