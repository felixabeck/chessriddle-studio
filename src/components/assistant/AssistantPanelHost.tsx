import cx from "clsx";
import { useAtom } from "jotai";
import { X } from "lucide-react";
import { type ComponentType, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { IconAction } from "@/components/common/IconAction";
import { RetryableLazyPanel } from "@/components/common/PanelErrorBoundary";
import { useDragResize } from "@/hooks/useDragResize";
import { useRootFontPx } from "@/hooks/useRootFontPx";
import { useScaledMaxWidth } from "@/hooks/useScaledMaxWidth";
import {
  assistantDockWidthAtom,
  clampAssistantDockWidthRem,
  DEFAULT_ASSISTANT_DOCK_WIDTH_REM,
  maxAssistantDockWidthRem,
  MIN_ASSISTANT_DOCK_WIDTH_REM,
} from "@/state/assistantWidth";
import { roundRem } from "@/state/remPreference";
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
  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window === "undefined" ? 0 : window.innerWidth,
  );
  const dockRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const maxWidthRem = maxAssistantDockWidthRem(viewportWidth, rootFont);
  const normalize = (widthRem: number) =>
    roundRem(clampAssistantDockWidthRem(widthRem, viewportWidth, rootFont));
  const resize = useDragResize({
    measuredSizePx: () => {
      const measured = dockRef.current?.getBoundingClientRect().width ?? 0;
      return measured > 0 ? measured : effectiveWidthRem * rootFont;
    },
    rootFont,
    normalize,
    growDirection: -1,
    keyStepRem: KEY_STEP_REM,
    setStoredRem: setStoredWidthRem,
    defaultRem: DEFAULT_ASSISTANT_DOCK_WIDTH_REM,
  });
  const dragWidthRem = resize.dragRem;
  const effectiveWidthRem = clampAssistantDockWidthRem(
    dragWidthRem ?? storedWidthRem,
    viewportWidth,
    rootFont,
  );

  const { cancel: cancelDrag } = resize;
  useEffect(() => {
    if (narrow) cancelDrag();
  }, [narrow, cancelDrag]);

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
          aria-valuemax={roundRem(maxWidthRem)}
          aria-valuenow={roundRem(effectiveWidthRem)}
          tabIndex={0}
          className={classes.handle}
          data-testid="assistant-resize-handle"
          data-dragging={dragWidthRem !== null ? "true" : undefined}
          {...resize.handleProps}
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
