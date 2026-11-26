import cx from "clsx";
import { useAtom } from "jotai";
import { X } from "lucide-react";
import {
  type ComponentType,
  type KeyboardEvent,
  type PointerEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { IconAction } from "@/components/common/IconAction";
import { RetryableLazyPanel } from "@/components/common/PanelErrorBoundary";
import { useRootFontPx } from "@/hooks/useRootFontPx";
import { useScaledMaxWidth } from "@/hooks/useScaledMaxWidth";
import {
  assistantDockWidthAtom,
  clampAssistantDockWidthRem,
  DEFAULT_ASSISTANT_DOCK_WIDTH_REM,
  maxAssistantDockWidthRem,
  MIN_ASSISTANT_DOCK_WIDTH_REM,
  roundAssistantDockWidthRem,
} from "@/state/assistantWidth";
import { capturePointer, releasePointerCaptureSafely } from "@/utils/pointerCapture";
import type { AssistantPanelProps } from "./AssistantPanel";
import classes from "./AssistantPanel.module.css";

const NARROW_OVERLAY_WIDTH_EM = 56;
/** How far one arrow key press moves the dock handle, in rem. */
const KEY_STEP_REM = 1.5;

export type AssistantPanelLoader = () => Promise<{ default: ComponentType<AssistantPanelProps> }>;

const defaultPanelLoader: AssistantPanelLoader = () => import("./AssistantPanel");

function DockedAssistantPanel({
  onClose,
  createNewTab,
  openAccounts,
  openEngines,
  openSettings,
  loadPanel,
}: AssistantPanelProps & {
  onClose: () => void;
  loadPanel: AssistantPanelLoader;
}) {
  const { t } = useTranslation();
  const narrow = useScaledMaxWidth(NARROW_OVERLAY_WIDTH_EM);
  const rootFont = useRootFontPx();
  const [storedWidthRem, setStoredWidthRem] = useAtom(assistantDockWidthAtom);
  const [dragWidthRem, setDragWidthRem] = useState<number | null>(null);
  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window === "undefined" ? 0 : window.innerWidth,
  );
  const dockRef = useRef<HTMLElement | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startWidthPx: number;
    moved: boolean;
    lastWidthRem: number;
  } | null>(null);

  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    if (narrow) {
      dragRef.current = null;
      setDragWidthRem(null);
    }
  }, [narrow]);

  const maxWidthRem = maxAssistantDockWidthRem(viewportWidth, rootFont);
  const effectiveWidthRem = clampAssistantDockWidthRem(
    dragWidthRem ?? storedWidthRem,
    viewportWidth,
    rootFont,
  );

  const renderedWidthPx = () => {
    const measured = dockRef.current?.getBoundingClientRect().width ?? 0;
    return measured > 0 ? measured : effectiveWidthRem * rootFont;
  };

  const widthFromDeltaPx = (startWidthPx: number, deltaX: number) =>
    roundAssistantDockWidthRem(
      clampAssistantDockWidthRem((startWidthPx - deltaX) / rootFont, viewportWidth, rootFont),
    );

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    if (!capturePointer(event.currentTarget, event.pointerId)) return;
    const startWidthPx = renderedWidthPx();
    const startWidthRem = roundAssistantDockWidthRem(
      clampAssistantDockWidthRem(startWidthPx / rootFont, viewportWidth, rootFont),
    );
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidthPx,
      moved: false,
      lastWidthRem: startWidthRem,
    };
    setDragWidthRem(startWidthRem);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = dragRef.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - current.startX;
    if (deltaX !== 0) current.moved = true;
    const nextWidthRem = widthFromDeltaPx(current.startWidthPx, deltaX);
    current.lastWidthRem = nextWidthRem;
    setDragWidthRem(nextWidthRem);
  };

  const finishDrag = (event: PointerEvent<HTMLDivElement>, useEventPosition: boolean) => {
    const current = dragRef.current;
    if (!current || current.pointerId !== event.pointerId) return;
    dragRef.current = null;
    releasePointerCaptureSafely(event.currentTarget, event.pointerId);
    if (useEventPosition) {
      const deltaX = event.clientX - current.startX;
      if (deltaX !== 0 || current.moved) {
        setStoredWidthRem(widthFromDeltaPx(current.startWidthPx, deltaX));
      }
    } else if (current.moved) {
      setStoredWidthRem(current.lastWidthRem);
    }
    setDragWidthRem(null);
  };

  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => finishDrag(event, true);
  const onDragInterrupted = (event: PointerEvent<HTMLDivElement>) => finishDrag(event, false);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const direction = event.key === "ArrowLeft" ? 1 : event.key === "ArrowRight" ? -1 : 0;
    if (direction === 0) return;
    event.preventDefault();
    const nextWidthRem = roundAssistantDockWidthRem(
      clampAssistantDockWidthRem(
        renderedWidthPx() / rootFont + direction * KEY_STEP_REM,
        viewportWidth,
        rootFont,
      ),
    );
    setStoredWidthRem(nextWidthRem);
  };

  const resetWidth = () => {
    dragRef.current = null;
    setDragWidthRem(null);
    setStoredWidthRem(DEFAULT_ASSISTANT_DOCK_WIDTH_REM);
  };

  return (
    <aside
      ref={dockRef}
      className={cx(classes.dock, narrow && classes.overlay)}
      style={
        narrow
          ? undefined
          : {
              width: `${effectiveWidthRem}rem`,
              flexBasis: `${effectiveWidthRem}rem`,
            }
      }
      aria-label={t("Assistant.Title")}
      data-testid="assistant-panel"
      data-overlay={narrow ? "true" : undefined}
    >
      {!narrow && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={t("Assistant.Resize")}
          aria-valuemin={MIN_ASSISTANT_DOCK_WIDTH_REM}
          aria-valuemax={roundAssistantDockWidthRem(maxWidthRem)}
          aria-valuenow={roundAssistantDockWidthRem(effectiveWidthRem)}
          tabIndex={0}
          className={classes.handle}
          data-testid="assistant-resize-handle"
          data-dragging={dragWidthRem !== null ? "true" : undefined}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onDragInterrupted}
          onLostPointerCapture={onDragInterrupted}
          onDoubleClick={resetWidth}
          onKeyDown={onKeyDown}
        />
      )}
      <div className={classes.titleBar}>
        <h2 className={classes.title}>{t("Assistant.Title")}</h2>
        <IconAction label={t("Assistant.Close")} variant="subtle" onClick={onClose}>
          <X size="1rem" />
        </IconAction>
      </div>
      <div className={classes.body}>
        <RetryableLazyPanel
          load={loadPanel}
          panelProps={{ createNewTab, openAccounts, openEngines, openSettings }}
          operation="assistant-panel-load"
          logLabel="Assistant panel failed to load"
          className={classes.fallback}
          loadFailedText={t("Assistant.LoadFailed")}
          retryLabel={t("Common.Retry")}
        />
      </div>
    </aside>
  );
}

/**
 * Lazily loads and docks the Assistant panel at the right edge of the window.
 * Below a minimum window width it covers the content area with a close control.
 * A load failure renders an in-place retry message without taking the application shell down.
 */
export function AssistantPanelHost({
  opened,
  onClose,
  createNewTab,
  openAccounts,
  openEngines,
  openSettings,
  loadPanel = defaultPanelLoader,
}: AssistantPanelProps & {
  opened: boolean;
  onClose: () => void;
  loadPanel?: AssistantPanelLoader;
}) {
  if (!opened) return null;
  return (
    <DockedAssistantPanel
      onClose={onClose}
      createNewTab={createNewTab}
      openAccounts={openAccounts}
      openEngines={openEngines}
      openSettings={openSettings}
      loadPanel={loadPanel}
    />
  );
}
