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
  explorerDetachedAtom,
  explorerPlacementAtom,
  explorerStripHeightsAtom,
  type PinnedPlacement,
} from "@/state/atoms";
import DatabasePanel from "../panels/database/DatabasePanel";
import "react-mosaic-component/react-mosaic-component.css";
import "@/styles/react-mosaic.css";
import classes from "./PinnedExplorer.module.css";

/** The strip never gets shorter than its caption line, the table head and a couple of rows. */
export const STRIP_MIN_PX = 120;
/** What the strip always leaves its pane for the neighbour it shares the pane with. */
export const NEIGHBOUR_MIN_PX = 160;
/**
 * Without a dragged height the strip follows its rows up to this share of the window. It is taken
 * of the window, not the pane, so moving the pane divider does not resize the strip.
 */
export const AUTO_MAX_SHARE = 0.25;
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
 * The room the strip measures against. `reference` is the height it must fit in: the pane it sits
 * in, marked `data-pinned-pane`, or the window below the board in the stacked layout, where that
 * pane grows with its content. `reserved` is what pinned engine bars in the same pane take, so the
 * neighbour keeps its room beside both. `viewport` is the window height the automatic cap is a
 * share of. Measured again whenever the pane, an engine
 * bar or the window changes size (a layout switch moves the pane without remounting the strip),
 * and whenever an engine bar mounts or unmounts beside the strip.
 */
function usePaneRoom(strip: RefObject<HTMLDivElement | null>) {
  const [room, setRoom] = useState({ reference: 0, reserved: 0, viewport: 0 });
  useEffect(() => {
    const element = strip.current;
    const pane = element?.closest<HTMLElement>("[data-pinned-pane]");
    if (!element || !pane) return;
    const resizes = new ResizeObserver(() => measure());
    let engineBars: HTMLElement[] = [];
    /** Pinned engine bar slots are children of the pane or of the strip's own slot. */
    const findEngineBars = () => {
      for (const bar of engineBars) resizes.unobserve(bar);
      engineBars = [...pane.querySelectorAll<HTMLElement>('[data-testid="pinned-engine"]')];
      for (const bar of engineBars) resizes.observe(bar);
    };
    const measure = () => {
      const grows =
        pane.hasAttribute("data-pinned-pane-grows") &&
        element.closest("[data-board-layout='stacked']") !== null;
      const gap = Number.parseFloat(getComputedStyle(pane).rowGap) || 0;
      const next = {
        reference: grows ? window.innerHeight : pane.clientHeight,
        reserved: engineBars.reduce(
          (sum, bar) => sum + bar.getBoundingClientRect().height + gap,
          0,
        ),
        viewport: window.innerHeight,
      };
      setRoom((previous) =>
        previous.reference === next.reference &&
        previous.reserved === next.reserved &&
        previous.viewport === next.viewport
          ? previous
          : next,
      );
    };
    findEngineBars();
    measure();
    resizes.observe(pane);
    const slots = new MutationObserver(() => {
      findEngineBars();
      measure();
    });
    slots.observe(pane, { childList: true });
    if (element.parentElement && element.parentElement !== pane) {
      slots.observe(element.parentElement, { childList: true });
    }
    window.addEventListener("resize", measure);
    return () => {
      resizes.disconnect();
      slots.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [strip]);
  return room;
}

function ExplorerStrip({ placement }: { placement: PinnedPlacement }) {
  const { t } = useTranslation();
  const [heights, setHeights] = useAtom(explorerStripHeightsAtom);
  const { ref: strip, height: measuredHeight } = useElementSize<HTMLDivElement>();
  const { reference, reserved, viewport } = usePaneRoom(strip);
  // Above its neighbour the strip's lower edge is the divider; below it, the upper edge.
  const edge = placement === "tabs" || placement === "notation" ? "end" : "start";
  const max = Math.max(STRIP_MIN_PX, reference - reserved - NEIGHBOUR_MIN_PX);
  const clamp = (px: number) => Math.min(max, Math.max(STRIP_MIN_PX, px));
  // A dragged height stays in pixels: only the pane's least room for the neighbour shrinks it.
  const storedHeight = heights[placement];
  /** The dragged height while a drag runs, so storage is written once at its end. */
  const [dragHeight, setDragHeight] = useState<number | null>(null);
  const drag = useRef<{ pointer: number; startY: number; startHeight: number } | null>(null);
  const height =
    dragHeight ?? (storedHeight !== undefined && reference > 0 ? clamp(storedHeight) : undefined);
  const autoMax = clamp(viewport * AUTO_MAX_SHARE);

  const store = (px: number) => {
    if (reference <= 0) return;
    setHeights((previous) => ({ ...previous, [placement]: clamp(px) }));
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
  // Every way a drag ends (release, cancel, lost capture) stores the height it reached; a press
  // without movement (focusing the divider, a double-click's clicks) stores nothing.
  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.pointer !== event.pointerId) return;
    drag.current = null;
    const delta = event.clientY - current.startY;
    if (delta !== 0) store(moved(current.startHeight, delta));
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
        tabIndex={0}
        // The pane divider's own classes: the same pointer, hit area and hover line.
        className={`mosaic-split -column ${classes.handle}`}
        data-edge={edge}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
        onDoubleClick={reset}
        onKeyDown={onKeyDown}
      >
        <div className="mosaic-split-line" />
      </div>
    </div>
  );
}
