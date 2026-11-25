import { Tooltip } from "@mantine/core";
import {
  type KeyboardEventHandler,
  type MouseEventHandler,
  useEffect,
  useRef,
  useState,
} from "react";
import type { DraggableProvidedDragHandleProps } from "@hello-pangea/dnd";
import { X } from "lucide-react";
import { AnalysisIcon, PuzzlesIcon, GameIcon, DatabaseIcon } from "@/components/common/iconCatalog";
import cx from "clsx";
import { getTabFile, tabLabelWithFile, type Tab } from "@/utils/tabs";
import classes from "./BoardTab.module.css";
import { FileIcon } from "../files/FileIcon";
import { useTranslation } from "react-i18next";
import { boardTabId, boardTabPanelId } from "./boardTabDom";

export function BoardTab({
  tab,
  onSelect,
  selected,
  tabStop,
  panelMounted,
  overflowing,
  dragHandleProps,
  onContextMenu,
  onKeyDown,
  onClose,
}: {
  tab: Tab;
  onSelect: (v: string) => void;
  selected: boolean;
  tabStop: boolean;
  panelMounted: boolean;
  overflowing: boolean;
  dragHandleProps: DraggableProvidedDragHandleProps | null | undefined;
  onContextMenu: MouseEventHandler<HTMLButtonElement>;
  onKeyDown?: KeyboardEventHandler<HTMLButtonElement>;
  onClose: (tabId: string) => void;
}) {
  const { t } = useTranslation();
  const { role: _dragRole, tabIndex: _dragTabIndex, ...tabDragHandleProps } = dragHandleProps ?? {};
  const labelRef = useRef<HTMLSpanElement>(null);
  const [truncated, setTruncated] = useState(false);
  const name = t(tab.name, { defaultValue: tab.name });
  const file = getTabFile(tab);
  const tooltip = tabLabelWithFile(tab, name);

  // Non-file tabs show the full-name tooltip only while the ellipsis cuts the label.
  useEffect(() => {
    const label = labelRef.current;
    if (!label) return;
    const measure = () => setTruncated(label.scrollWidth > label.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(label);
    return () => observer.disconnect();
  }, [name]);

  return (
    <div
      className={cx(classes.tabItem, {
        [classes.selected]: selected,
        [classes.overflowing]: overflowing,
      })}
      role="presentation"
    >
      <Tooltip
        label={tooltip}
        disabled={!file && !truncated}
        openDelay={400}
        position="bottom"
        withinPortal
      >
        <button
          type="button"
          {...tabDragHandleProps}
          role="tab"
          id={boardTabId(tab.value)}
          data-tab-id={tab.value}
          className={cx(classes.tab, { [classes.selectedTab]: selected })}
          aria-selected={selected}
          aria-controls={panelMounted ? boardTabPanelId(tab.value) : undefined}
          tabIndex={tabStop ? 0 : -1}
          onClick={(event) => {
            // The drag sensor prevents the mousedown default, which would otherwise focus the
            // tab; focus it here so the arrow keys continue from the clicked tab.
            event.currentTarget.focus();
            onSelect(tab.value);
          }}
          onContextMenu={onContextMenu}
          onKeyDown={onKeyDown}
        >
          <BoardTabIcon tab={tab} />
          <span ref={labelRef} className={classes.tabLabel}>
            {name}
          </span>
        </button>
      </Tooltip>
      <button
        type="button"
        tabIndex={-1}
        className={classes.close}
        // Sibling of the tab, not nested in it. aria-hidden keeps this labelled close out of the
        // tab list; it is not a tab stop. Keyboard users close via the tab menu or CLOSE_TAB.
        aria-hidden
        aria-label={t("Tab.CloseNamed", { name })}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          onClose(tab.value);
        }}
      >
        <X size="0.875rem" aria-hidden />
      </button>
    </div>
  );
}

export function BoardTabIcon({ tab }: { tab: Tab }) {
  if (tab.type === "puzzles") {
    return <PuzzlesIcon size="0.875rem" />;
  }
  if (tab.type === "play") {
    return <GameIcon size="0.875rem" />;
  }
  if (tab.gameOrigin.kind === "database" || tab.gameOrigin.kind === "databaseDraft") {
    return <DatabaseIcon size="0.875rem" />;
  }
  if (
    tab.gameOrigin.kind === "file" ||
    tab.gameOrigin.kind === "temp_file" ||
    tab.gameOrigin.kind === "fileDraft"
  ) {
    return <FileIcon type={tab.gameOrigin.file.metadata.type} size="0.875rem" />;
  }
  if (tab.type === "analysis") {
    return <AnalysisIcon size="0.875rem" />;
  }
  return null;
}
