import { Paper } from "@mantine/core";
import { useElementSize } from "@mantine/hooks";
import { useAtom, useAtomValue } from "jotai";
import {
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import {
  EXPLORER_STRIP_FRACTION_RANGE,
  explorerDetachedAtom,
  explorerPlacementAtom,
  explorerStripHeightsAtom,
  type PinnedPlacement,
} from "@/state/atoms";
import DatabasePanel from "../panels/database/DatabasePanel";
import classes from "./PinnedExplorer.module.css";

/** The strip never gets shorter than its caption line, the table head and a couple of rows. */
export const STRIP_MIN_PX = 120;
/** What the strip always leaves its pane for the neighbour it shares the pane with. */
export const NEIGHBOUR_MIN_PX = 160;
/** Without a dragged height the strip follows its rows up to this share of the pane. */
export const AUTO_MAX_SHARE = 0.5;
/** How far one arrow key press moves the divider. */
const KEY_STEP_PX = 24;

/**
 * The pinned explorer in one of its places. The analysis board mounts one per place; only the one
 * matching the stored place renders, so the explorer exists once.
 */
export default function PinnedExplorer({ placement }: { placement: PinnedPlacement }) {
  const detached = useAtomValue(explorerDetachedAtom);
  const stored = useAtomValue(explorerPlacementAtom);
  if (!detached || stored !== placement) return null;
  return <ExplorerStrip placement={placement} />;
}

/**
 * The height the strip's share is taken of: the pane it sits in, marked `data-pinned-pane`. Below
 * the board in the stacked layout that pane grows with its content, so the window stands in.
 */
function useReferenceHeight(strip: RefObject<HTMLDivElement | null>) {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const element = strip.current;
    const pane = element?.closest<HTMLElement>("[data-pinned-pane]");
    if (!element || !pane) return;
    if (
      pane.hasAttribute("data-pinned-pane-grows") &&
      element.closest("[data-board-layout='stacked']")
    ) {
      const measure = () => setHeight(window.innerHeight);
      measure();
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(() => setHeight(pane.clientHeight));
    observer.observe(pane);
    setHeight(pane.clientHeight);
    return () => observer.disconnect();
  }, [strip]);
  return height;
}

function ExplorerStrip({ placement }: { placement: PinnedPlacement }) {
  const { t } = useTranslation();
  const [heights, setHeights] = useAtom(explorerStripHeightsAtom);
  const { ref: strip, height: measuredHeight } = useElementSize<HTMLDivElement>();
  const reference = useReferenceHeight(strip);
  // Above its neighbour the strip's lower edge is the divider; below it, the upper edge.
  const edge = placement === "tabs" || placement === "notation" ? "end" : "start";
  const max = Math.max(STRIP_MIN_PX, reference - NEIGHBOUR_MIN_PX);
  const clamp = (px: number) => Math.min(max, Math.max(STRIP_MIN_PX, px));
  const share = heights[placement];
  /** The dragged height while a drag runs, so storage is written once at its end. */
  const [dragHeight, setDragHeight] = useState<number | null>(null);
  const drag = useRef<{ pointer: number; startY: number; startHeight: number } | null>(null);
  const height =
    dragHeight ?? (share !== undefined && reference > 0 ? clamp(share * reference) : undefined);
  const autoMax = clamp(reference * AUTO_MAX_SHARE);

  const store = (px: number) => {
    if (reference <= 0) return;
    const [low, high] = EXPLORER_STRIP_FRACTION_RANGE;
    const next = Math.min(high, Math.max(low, clamp(px) / reference));
    setHeights((previous) => ({ ...previous, [placement]: next }));
  };
  const reset = () => {
    setHeights((previous) => {
      const { [placement]: _dropped, ...rest } = previous;
      return rest;
    });
  };
  const renderedHeight = () => strip.current?.getBoundingClientRect().height ?? STRIP_MIN_PX;
  const moved = (startHeight: number, delta: number) =>
    clamp(startHeight + (edge === "end" ? delta : -delta));

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      pointer: event.pointerId,
      startY: event.clientY,
      startHeight: renderedHeight(),
    };
    setDragHeight(drag.current.startHeight);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.pointer !== event.pointerId) return;
    setDragHeight(moved(current.startHeight, event.clientY - current.startY));
  };
  // Every way a drag ends (release, cancel, lost capture) stores the height it reached.
  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.pointer !== event.pointerId) return;
    drag.current = null;
    store(moved(current.startHeight, event.clientY - current.startY));
    setDragHeight(null);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const direction = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (direction === 0) return;
    event.preventDefault();
    store(moved(renderedHeight(), direction * KEY_STEP_PX));
  };

  const shownHeight = height ?? (measuredHeight > 0 ? measuredHeight : undefined);
  return (
    <div
      ref={strip}
      className={classes.strip}
      data-edge={edge}
      data-testid="pinned-explorer-strip"
      style={{
        // The strip yields when its neighbour needs its minimum room (the notation column keeps
        // every other child at full size), so the pane never scrolls past it.
        flexShrink: 1,
        ...(height !== undefined
          ? { height, minHeight: STRIP_MIN_PX }
          : { maxHeight: reference > 0 ? autoMax : undefined }),
      }}
    >
      <Paper withBorder className={classes.panel} data-testid="pinned-explorer">
        <DatabasePanel />
      </Paper>
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label={t("Board.Database.Resize")}
        aria-valuemin={reference > 0 ? Math.round((STRIP_MIN_PX / reference) * 100) : undefined}
        aria-valuemax={reference > 0 ? Math.round((max / reference) * 100) : undefined}
        aria-valuenow={
          shownHeight !== undefined && reference > 0
            ? Math.round((shownHeight / reference) * 100)
            : undefined
        }
        title={t("Board.Database.ResizeHint")}
        tabIndex={0}
        className={classes.handle}
        data-edge={edge}
        data-dragging={dragHeight !== null || undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
        onDoubleClick={reset}
        onKeyDown={onKeyDown}
      />
    </div>
  );
}
