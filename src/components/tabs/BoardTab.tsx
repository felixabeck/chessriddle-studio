import { Tabs, Tooltip } from "@mantine/core";
import { type MouseEventHandler, useEffect, useRef, useState } from "react";
import type { DraggableProvidedDragHandleProps } from "@hello-pangea/dnd";
import { ChessKnight, Database, Puzzle, ScanSearch } from "lucide-react";
import cx from "clsx";
import { getTabFile, type Tab } from "@/utils/tabs";
import classes from "./BoardTab.module.css";
import { FileIcon } from "../files/FileIcon";
import { useTranslation } from "react-i18next";

export function BoardTab({
  tab,
  tabType,
  setActiveTab,
  selected,
  dragHandleProps,
  onContextMenu,
}: {
  tab: Tab;
  tabType: string;
  setActiveTab: (v: string) => void;
  selected: boolean;
  dragHandleProps: DraggableProvidedDragHandleProps | null | undefined;
  onContextMenu: MouseEventHandler<HTMLButtonElement>;
}) {
  const { t } = useTranslation();
  const { role: _dragRole, tabIndex: _dragTabIndex, ...tabDragHandleProps } = dragHandleProps ?? {};
  const labelRef = useRef<HTMLSpanElement>(null);
  const [truncated, setTruncated] = useState(false);
  const name = t(tab.name, { defaultValue: tab.name });
  const file = getTabFile(tab);
  const tooltip = file ? `${file.name.replace(/\.pgn$/i, "")} › ${name}` : name;

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
    <div className={classes.tabItem} role="presentation">
      <Tooltip
        label={tooltip}
        disabled={!file && !truncated}
        openDelay={400}
        position="bottom"
        withinPortal
      >
        <Tabs.Tab
          {...tabDragHandleProps}
          value={tab.value}
          className={cx(classes.tab, { [classes.selected]: selected })}
          classNames={{ tabLabel: classes.tabLabelSlot }}
          leftSection={<TabIcon tab={tab} tabType={tabType} />}
          onClick={() => setActiveTab(tab.value)}
          onContextMenu={onContextMenu}
        >
          <span ref={labelRef} className={classes.tabLabel}>
            {name}
          </span>
        </Tabs.Tab>
      </Tooltip>
    </div>
  );
}

function TabIcon({ tab, tabType }: { tab: Tab; tabType: string }) {
  if (tabType === "puzzles") {
    return <Puzzle size="0.875rem" />;
  }
  if (tabType === "play") {
    return <ChessKnight size="0.875rem" />;
  }
  if (tab.gameOrigin.kind === "database" || tab.gameOrigin.kind === "databaseDraft") {
    return <Database size="0.875rem" />;
  }
  if (tab.gameOrigin.kind === "file" || tab.gameOrigin.kind === "temp_file") {
    return <FileIcon type={tab.gameOrigin.file.metadata.type} size="0.875rem" />;
  }
  if (tabType === "analysis") {
    return <ScanSearch size="0.875rem" />;
  }
  return null;
}
