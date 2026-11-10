import { getDefaultZIndex } from "@mantine/core";
import { useEffect, useState, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { notifyUnlessCancelled } from "@/components/files/notifyError";
import { getCurrentWebviewWindow, type WebviewWindow } from "@/platform/native";
import { watchMaximized } from "@/routes/-appMenu";
import classes from "./WindowResizeHandles.module.css";

type ResizeDirection = Parameters<WebviewWindow["startResizeDragging"]>[0];

const DIRECTIONS: readonly ResizeDirection[] = [
  "North",
  "East",
  "South",
  "West",
  "NorthEast",
  "SouthEast",
  "SouthWest",
  "NorthWest",
];
const PRIMARY_BUTTON = 0;

/**
 * Resize zones for the undecorated Linux window. The window library sets its resize cursor on the
 * GTK window beneath the webview, where it never shows, so these zones let WebKit show it instead.
 */
export function WindowResizeHandles() {
  const { t } = useTranslation();
  const [fillsScreen, setFillsScreen] = useState(false);

  useEffect(() => {
    const appWindow = getCurrentWebviewWindow();
    return watchMaximized({
      isMaximized: async () => (await appWindow.isMaximized()) || (await appWindow.isFullscreen()),
      onResized: (handler) => appWindow.onResized(handler),
      setMaximized: setFillsScreen,
      notify: (error) => {
        // The watcher has stopped, so remove the zones instead of trusting a stale state.
        setFillsScreen(true);
        notifyUnlessCancelled(t("Common.Error"), error);
      },
    });
  }, [t]);

  if (fillsScreen) return null;

  const startResize = (event: MouseEvent, direction: ResizeDirection) => {
    if (event.button !== PRIMARY_BUTTON) return;
    event.preventDefault();
    void getCurrentWebviewWindow()
      .startResizeDragging(direction)
      .catch((error: unknown) => notifyUnlessCancelled(t("Common.Error"), error));
  };

  return (
    <div className={classes.root} style={{ zIndex: getDefaultZIndex("max") }} aria-hidden>
      {DIRECTIONS.map((direction) => (
        <div
          key={direction}
          className={classes[`handle${direction}`]}
          data-resize-direction={direction}
          onMouseDown={(event) => startResize(event, direction)}
        />
      ))}
    </div>
  );
}
