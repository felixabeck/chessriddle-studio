import { WorkspaceTabScope } from "@/state/tabScope";
import {
  DragDropContext,
  Draggable,
  Droppable,
  useMouseSensor,
  useTouchSensor,
} from "@hello-pangea/dnd";
import { Menu, ScrollArea, Tabs } from "@mantine/core";
import { Ellipsis, Plus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import PointerContextMenu from "@/components/common/PointerContextMenu";
import BoardTabLayout from "./BoardTabLayout";
import { getTabTreeKey, type Tab } from "@/utils/tabs";
import BoardAnalysis from "../boards/BoardAnalysis";
import BoardGame from "../boards/BoardGame";
import { TreeStateProvider } from "../common/TreeStateContext";
import Puzzles from "../puzzles/Puzzles";
import { BoardTab } from "./BoardTab";
import { TabActionsMenu } from "./TabActionsMenu";
import { IconAction } from "../common/IconAction";
import NewTabHome from "./NewTabHome";
import FileFreshnessGate from "./FileFreshnessGate";
import TreeRecoveryGate from "./TreeRecoveryGate";
import { useTabCommands } from "./TabCommands";

import "react-mosaic-component/react-mosaic-component.css";

import "@/styles/react-mosaic.css";
import classes from "./BoardsPage.module.css";

// Tabs are reordered by pointer only: a keyboard lift would claim Space and the arrow keys,
// which the tab list already uses to activate and move between tabs.
const POINTER_DRAG_SENSORS = [useMouseSensor, useTouchSensor];

export default function BoardsPage() {
  const { t } = useTranslation();
  const { tabs, activeTab, selectTab, closeTab, duplicateTab, renameTab, reorderTabs, newTab } =
    useTabCommands();
  const [actionsOpened, setActionsOpened] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ tabId: string; x: number; y: number } | null>(
    null,
  );
  const tabListRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (contextMenu && !tabs.some((tab) => tab.value === contextMenu.tabId)) setContextMenu(null);
  }, [contextMenu, tabs]);

  useEffect(() => {
    if (document.activeElement !== document.body || !activeTab) return;
    tabListRef.current
      ?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')
      ?.focus();
  }, [activeTab, tabs.length]);

  // Keep the active tab visible when it changes and when a resize makes the bar overflow.
  // ResizeObserver delivers an initial notification on observe, which covers the change.
  useEffect(() => {
    const list = tabListRef.current;
    if (!list) return;
    const observer = new ResizeObserver(() =>
      list
        .querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')
        ?.scrollIntoView({ block: "nearest", inline: "nearest" }),
    );
    observer.observe(list);
    return () => observer.disconnect();
  }, [activeTab, tabs.length]);

  return (
    <Tabs
      value={activeTab}
      onChange={(value) => {
        if (value) selectTab(value);
      }}
      keepMounted={false}
      className={classes.tabsContainer}
    >
      <div className={classes.tabsHeaderRow}>
        <div className={classes.tabStrip} data-tab-strip>
          <ScrollArea scrollbarSize={4} className={classes.tabsHeader}>
            <DragDropContext
              enableDefaultSensors={false}
              sensors={POINTER_DRAG_SENSORS}
              onDragEnd={({ destination, source }) => {
                if (destination?.index !== undefined) reorderTabs(source.index, destination.index);
              }}
            >
              <Droppable droppableId="droppable" direction="horizontal">
                {(provided) => (
                  <Tabs.List
                    ref={(node) => {
                      provided.innerRef(node);
                      tabListRef.current = node;
                    }}
                    {...provided.droppableProps}
                    className={classes.tabList}
                  >
                    {tabs.map((tab, i) => (
                      // The drag handle is the tab's own button, which the library refuses as a
                      // drag start unless interactive-element blocking is off. Only pointer
                      // sensors run, so Space and the arrow keys keep their tab behaviour.
                      <Draggable
                        key={tab.value}
                        draggableId={tab.value}
                        index={i}
                        disableInteractiveElementBlocking
                      >
                        {(provided) => (
                          <div
                            ref={provided.innerRef}
                            {...provided.draggableProps}
                            className={classes.tabSlot}
                            role="presentation"
                          >
                            <BoardTab
                              tab={tab}
                              tabType={tab.type}
                              setActiveTab={selectTab}
                              selected={activeTab === tab.value}
                              dragHandleProps={provided.dragHandleProps}
                              onContextMenu={(event) => {
                                event.preventDefault();
                                const rect = event.currentTarget.getBoundingClientRect();
                                const keyboard = event.clientX === 0 && event.clientY === 0;
                                setActionsOpened(false);
                                setContextMenu({
                                  tabId: tab.value,
                                  x: keyboard ? rect.left : event.clientX,
                                  y: keyboard ? rect.bottom : event.clientY,
                                });
                              }}
                            />
                          </div>
                        )}
                      </Draggable>
                    ))}
                    {provided.placeholder}
                  </Tabs.List>
                )}
              </Droppable>
            </DragDropContext>
          </ScrollArea>
          {/* Outside the scrolled list: it follows the last tab while the tabs fit and stays
            pinned at the strip's end once they overflow, and it is never a drop target. */}
          <IconAction
            label={t("Tab.NewTab", { defaultValue: "New tab" })}
            variant="subtle"
            color="gray"
            onClick={newTab}
            classNames={{ root: classes.stripNewTab }}
          >
            <Plus />
          </IconAction>
        </div>
        <Menu
          shadow="md"
          width={200}
          opened={actionsOpened}
          onChange={(opened) => {
            setActionsOpened(opened);
            if (opened) setContextMenu(null);
          }}
        >
          <Menu.Target>
            <IconAction
              label={t("Tab.Actions", { defaultValue: "Tab actions" })}
              variant="default"
              disabled={!activeTab}
              classNames={{ root: classes.headerAction }}
            >
              <Ellipsis />
            </IconAction>
          </Menu.Target>
          <Menu.Dropdown>
            {activeTab && (
              <TabActionsMenu
                tabId={activeTab}
                onDuplicate={duplicateTab}
                onRename={renameTab}
                onClose={(id) => void closeTab(id)}
              />
            )}
          </Menu.Dropdown>
        </Menu>
        <IconAction
          label={t("Tab.Close", { defaultValue: "Close tab" })}
          variant="default"
          disabled={!activeTab}
          onClick={() => void closeTab(activeTab)}
          classNames={{ root: classes.headerAction }}
        >
          <X />
        </IconAction>
      </div>
      {contextMenu && tabs.some((tab) => tab.value === contextMenu.tabId) && (
        <PointerContextMenu
          key={`${contextMenu.tabId}:${contextMenu.x}:${contextMenu.y}`}
          point={contextMenu}
          onClose={() => setContextMenu(null)}
        >
          <TabActionsMenu
            tabId={contextMenu.tabId}
            onDuplicate={duplicateTab}
            onRename={renameTab}
            onClose={(id) => void closeTab(id)}
          />
        </PointerContextMenu>
      )}
      {tabs.map((tab) => (
        <Tabs.Panel key={tab.value} value={tab.value} h="100%" w="100%" mih={0} pb="sm" px="xs">
          <TabSwitch tab={tab} closeTab={(tabId) => void closeTab(tabId)} />
        </Tabs.Panel>
      ))}
    </Tabs>
  );
}

function TabSwitch({ tab, closeTab }: { tab: Tab; closeTab: (tabId: string) => void }) {
  if (tab.type === "new") {
    return (
      <WorkspaceTabScope tabId={tab.value}>
        <NewTabHome id={tab.value} />
      </WorkspaceTabScope>
    );
  }
  return (
    <WorkspaceTabScope tabId={tab.value}>
      <TreeStateProvider id={tab.value} treeKey={getTabTreeKey(tab)}>
        <TreeRecoveryGate tabId={tab.value} treeKey={getTabTreeKey(tab)}>
          {tab.type === "analysis" ? (
            <FileFreshnessGate tab={tab} closeTab={closeTab}>
              <BoardTabLayout>
                <BoardAnalysis />
              </BoardTabLayout>
            </FileFreshnessGate>
          ) : (
            <BoardTabLayout>
              {tab.type === "play" ? <BoardGame tabId={tab.value} /> : <Puzzles id={tab.value} />}
            </BoardTabLayout>
          )}
        </TreeRecoveryGate>
      </TreeStateProvider>
    </WorkspaceTabScope>
  );
}
