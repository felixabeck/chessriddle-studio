import { WorkspaceTabScope } from "@/state/tabScope";
import { tauri } from "@/platform/tauri";
import { DragDropContext, Draggable, Droppable } from "@hello-pangea/dnd";
import { Button, Group, Menu, ScrollArea, Tabs, TextInput } from "@mantine/core";
import { useHotkeys } from "@mantine/hooks";
import { Copy, Ellipsis, Pencil, Plus, X } from "lucide-react";
import { getDefaultStore, useAtom, useAtomValue, useSetAtom } from "jotai";
import { startTransition, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import BoardTabLayout from "./BoardTabLayout";
import {
  activeTabAtom,
  closeWorkspaceTabAtom,
  closingTabsAtom,
  gameIdFamily,
  gameSessionFamily,
  gameStateFamily,
  pendingGameStartFamily,
  tabsAtom,
} from "@/state/atoms";
import { keyMapAtom } from "@/state/keybinds";
import {
  closeTreeStore,
  createTreeStore,
  invalidateReportOwner,
  restoreReportOwner,
  type TreeStore,
} from "@/state/store/tree";
import { tabStorage } from "@/state/store/tabStorage";
import { restorePuzzleSession } from "@/state/puzzleSession";
import { defaultTree } from "@/utils/treeReducer";
import {
  createTab,
  commitNewTab,
  getTabTreeKey,
  asksBeforeDiscardingChanges,
  runTabCreation,
  type Tab,
} from "@/utils/tabs";
import BoardAnalysis from "../boards/BoardAnalysis";
import BoardGame from "../boards/BoardGame";
import { abortExactTabGame } from "../boards/gameSession";
import { TreeStateProvider } from "../common/TreeStateContext";
import Puzzles from "../puzzles/Puzzles";
import { BoardTab } from "./BoardTab";
import { IconAction } from "../common/IconAction";
import AppModal from "../common/AppModal";
import ConfirmChangesModal from "./ConfirmChangesModal";
import NewTabHome from "./NewTabHome";
import FileFreshnessGate from "./FileFreshnessGate";
import TreeRecoveryGate from "./TreeRecoveryGate";

import "react-mosaic-component/react-mosaic-component.css";

import "@/styles/react-mosaic.css";
import { platform } from "@/platform/native";
import classes from "./BoardsPage.module.css";
import { notifyUnlessCancelled } from "../files/notifyError";

export default function BoardsPage() {
  const { t } = useTranslation();

  const [tabs, setTabs] = useAtom(tabsAtom);
  const [activeTab, setActiveTab] = useAtom(activeTabAtom);
  const closeWorkspaceTab = useSetAtom(closeWorkspaceTabAtom);
  const [pendingClose, setPendingClose] = useState<{ tabId: string; store: TreeStore } | null>(
    null,
  );
  const [renameOpened, setRenameOpened] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const tabListRef = useRef<HTMLDivElement>(null);

  const handleSetActiveTab = useCallback(
    (value: string | null | ((previous: string | null) => string | null)) => {
      let saved = false;
      startTransition(() => {
        saved = setActiveTab(value);
      });
      return saved;
    },
    [setActiveTab],
  );

  useEffect(() => {
    if (tabs.length === 0) {
      void runTabCreation({
        create: () => createTab({ tab: { name: t("Tab.NewTab"), type: "new" }, setTabs }),
        onError: (error) => notifyUnlessCancelled(t("Common.Error"), error),
      });
    }
  }, [setTabs, tabs, t]);

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

  const closeTab = useCallback(
    async (value: string | null, discard = false) => {
      if (value !== null) {
        const closedTab = tabs.find((tab) => tab.value === value);
        if (!closedTab) return;
        const jotaiStore = getDefaultStore();
        if (jotaiStore.get(closingTabsAtom).has(value)) return;
        const store = createTreeStore(value, undefined, getTabTreeKey(closedTab));
        if (
          (closedTab.type === "play" ||
            closedTab.type === "analysis" ||
            closedTab.type === "puzzles") &&
          ["not-read", "unreadable", "unavailable"].includes(
            tabStorage.getStatus(getTabTreeKey(closedTab)).kind,
          )
        )
          return;
        // An origin-less analysis tree is the user's unsaved work (the modal's Save routes origin "none" to append-to-picked-file); play and puzzle trees mark themselves dirty on every move and keep closing directly.
        if (asksBeforeDiscardingChanges(closedTab) && store.getState().dirty && !discard) {
          setPendingClose({ tabId: value, store });
          return;
        }
        jotaiStore.set(closingTabsAtom, (previous: Set<string>) => new Set(previous).add(value));
        const reportInvalidation = invalidateReportOwner(value);
        const ownerGameIdAtom = gameIdFamily(value);
        const ownerSessionAtom = gameSessionFamily(value);
        const ownerStateAtom = gameStateFamily(value);
        const ownerPendingStartAtom = pendingGameStartFamily(value);
        try {
          await jotaiStore.get(ownerPendingStartAtom);
          await tauri.killEngines(value);
          await abortExactTabGame(
            value,
            () => jotaiStore.get(ownerGameIdAtom),
            () => jotaiStore.get(ownerSessionAtom),
            (gameId, expectedSession) => tauri.abortGame(gameId, expectedSession),
            (gameId, session) => {
              if (
                jotaiStore.get(ownerGameIdAtom) === gameId &&
                jotaiStore.get(ownerSessionAtom) === session
              ) {
                jotaiStore.set(ownerGameIdAtom, null);
                jotaiStore.set(ownerSessionAtom, null);
                jotaiStore.set(ownerStateAtom, "gameOver");
              }
            },
          );
          let closed = false;
          startTransition(() => {
            closed = closeWorkspaceTab(value);
            if (closed) closeTreeStore(value);
          });
          if (!closed) {
            restoreReportOwner(value, reportInvalidation);
            return;
          }
          store.dispose();
        } catch (error) {
          restoreReportOwner(value, reportInvalidation);
          notifyUnlessCancelled(t("Common.Error"), error);
          return;
        } finally {
          jotaiStore.set(closingTabsAtom, (previous: Set<string>) => {
            const next = new Set(previous);
            next.delete(value);
            return next;
          });
        }
      }
    },
    [closeWorkspaceTab, t, tabs],
  );

  function selectTab(index: number) {
    handleSetActiveTab(tabs[Math.min(index, tabs.length - 1)].value);
  }

  function cycleTabs(reverse = false) {
    const index = tabs.findIndex((tab) => tab.value === activeTab);
    if (reverse) {
      if (index === 0) {
        handleSetActiveTab(tabs[tabs.length - 1].value);
      } else {
        handleSetActiveTab(tabs[index - 1].value);
      }
    } else {
      if (index === tabs.length - 1) {
        handleSetActiveTab(tabs[0].value);
      } else {
        handleSetActiveTab(tabs[index + 1].value);
      }
    }
  }

  const duplicateTab = useCallback(
    (value: string) => {
      const tab = tabs.find((candidate) => candidate.value === value);
      if (!tab) return;
      void runTabCreation({
        create: () =>
          commitNewTab({
            tab: { ...tab },
            setTabs,
            seed: (id) => {
              if (tab.type === "puzzles") {
                const tree =
                  tabStorage.readForClone(getTabTreeKey(tab), tab.treeKey !== undefined) ??
                  defaultTree();
                tabStorage.seed(id, {
                  ...tree,
                  puzzleSession: restorePuzzleSession(tab.value, tree),
                });
              } else {
                tabStorage.cloneDurable(getTabTreeKey(tab), id, tab.treeKey !== undefined);
              }
            },
            existingTabIds: tabs.flatMap((candidate) => [
              candidate.value,
              getTabTreeKey(candidate),
            ]),
          }),
        onError: (error) => notifyUnlessCancelled(t("Common.Error"), error),
      });
    },
    [setTabs, t, tabs],
  );

  const openRename = () => {
    const tab = tabs.find((candidate) => candidate.value === activeTab);
    if (!tab) return;
    setRenameValue(t(tab.name, { defaultValue: tab.name }));
    setRenameOpened(true);
  };

  const saveRename = () => {
    if (!activeTab || !renameValue.trim()) return;
    setTabs((previous) =>
      previous.map((tab) => (tab.value === activeTab ? { ...tab, name: renameValue.trim() } : tab)),
    );
    setRenameOpened(false);
  };

  useEffect(() => {
    if (platform() !== "macos") return;

    const handler = (e: KeyboardEvent) => {
      if (e.metaKey && e.key.toLowerCase() === "w") {
        e.preventDefault();
        e.stopPropagation();
        closeTab(activeTab);
      }
    };

    window.addEventListener("keydown", handler, { capture: true });

    return () => window.removeEventListener("keydown", handler, { capture: true });
  }, [closeTab, activeTab]);

  const keyMap = useAtomValue(keyMapAtom);
  useHotkeys([
    [keyMap.CLOSE_TAB.keys, () => closeTab(activeTab)],
    [keyMap.CYCLE_TABS.keys, () => cycleTabs()],
    [keyMap.REVERSE_CYCLE_TABS.keys, () => cycleTabs(true)],
    ["alt+1", () => selectTab(0)],
    ["ctrl+1", () => selectTab(0)],
    ["alt+2", () => selectTab(1)],
    ["ctrl+2", () => selectTab(1)],
    ["alt+3", () => selectTab(2)],
    ["ctrl+3", () => selectTab(2)],
    ["alt+4", () => selectTab(3)],
    ["ctrl+4", () => selectTab(3)],
    ["alt+5", () => selectTab(4)],
    ["ctrl+5", () => selectTab(4)],
    ["alt+6", () => selectTab(5)],
    ["ctrl+6", () => selectTab(5)],
    ["alt+7", () => selectTab(6)],
    ["ctrl+7", () => selectTab(6)],
    ["alt+8", () => selectTab(7)],
    ["ctrl+8", () => selectTab(7)],
    ["alt+9", () => selectTab(tabs.length - 1)],
    ["ctrl+9", () => selectTab(tabs.length - 1)],
  ]);

  return (
    <Tabs
      value={activeTab}
      onChange={handleSetActiveTab}
      keepMounted={false}
      className={classes.tabsContainer}
    >
      <div className={classes.tabsHeaderRow}>
        <ScrollArea scrollbarSize={4} className={classes.tabsHeader}>
          <DragDropContext
            onDragEnd={({ destination, source }) =>
              destination?.index !== undefined &&
              setTabs((prev) => {
                const result = Array.from(prev);
                const [removed] = result.splice(source.index, 1);
                result.splice(destination.index, 0, removed);
                return result;
              })
            }
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
                    <Draggable key={tab.value} draggableId={tab.value} index={i}>
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
                            setActiveTab={handleSetActiveTab}
                            selected={activeTab === tab.value}
                            dragHandleProps={provided.dragHandleProps}
                          />
                        </div>
                      )}
                    </Draggable>
                  ))}
                  {provided.placeholder}
                  <div className={classes.tabsFiller} role="presentation" />
                </Tabs.List>
              )}
            </Droppable>
          </DragDropContext>
        </ScrollArea>
        <Menu shadow="md" width={200}>
          <Menu.Target>
            <IconAction
              label={t("Tab.Actions", { defaultValue: "Tab actions" })}
              variant="default"
              disabled={!activeTab}
              classNames={{ root: classes.newTab }}
            >
              <Ellipsis />
            </IconAction>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Item
              leftSection={<Copy size="0.875rem" />}
              onClick={() => activeTab && duplicateTab(activeTab)}
            >
              {t("Tab.Duplicate", { defaultValue: "Duplicate tab" })}
            </Menu.Item>
            <Menu.Item leftSection={<Pencil size="0.875rem" />} onClick={openRename}>
              {t("Tab.Rename", { defaultValue: "Rename tab" })}
            </Menu.Item>
            <Menu.Item
              color="danger"
              leftSection={<X size="0.875rem" />}
              onClick={() => void closeTab(activeTab)}
            >
              {t("Tab.Close", { defaultValue: "Close tab" })}
            </Menu.Item>
          </Menu.Dropdown>
        </Menu>
        <IconAction
          label={t("Tab.NewTab", { defaultValue: "New tab" })}
          variant="default"
          onClick={() =>
            void runTabCreation({
              create: () => createTab({ tab: { name: t("Tab.NewTab"), type: "new" }, setTabs }),
              onError: (error) => notifyUnlessCancelled(t("Common.Error"), error),
            })
          }
          classNames={{ root: classes.newTab }}
        >
          <Plus />
        </IconAction>
        <IconAction
          label={t("Tab.Close", { defaultValue: "Close tab" })}
          variant="default"
          disabled={!activeTab}
          onClick={() => void closeTab(activeTab)}
          classNames={{ root: classes.newTab }}
        >
          <X />
        </IconAction>
      </div>
      <AppModal
        opened={renameOpened}
        onClose={() => setRenameOpened(false)}
        title={t("Tab.Rename", { defaultValue: "Rename tab" })}
      >
        <TextInput
          autoFocus
          label={t("Tab.Rename", { defaultValue: "Rename tab" })}
          value={renameValue}
          onChange={(event) => setRenameValue(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") saveRename();
          }}
        />
        <Group justify="end" mt="md">
          <Button variant="default" onClick={() => setRenameOpened(false)}>
            {t("Common.Cancel")}
          </Button>
          <Button onClick={saveRename}>{t("Common.Save")}</Button>
        </Group>
      </AppModal>
      {tabs.map((tab) => (
        <Tabs.Panel key={tab.value} value={tab.value} h="100%" w="100%" mih={0} pb="sm" px="xs">
          <TabSwitch tab={tab} closeTab={(tabId) => void closeTab(tabId)} />
        </Tabs.Panel>
      ))}
      <ConfirmChangesModal
        pendingClose={pendingClose}
        tab={tabs.find((tab) => tab.value === pendingClose?.tabId)}
        updateTab={(tabId, update) =>
          setTabs((previous) =>
            previous.map((tab) =>
              tab.value === tabId ? (typeof update === "function" ? update(tab) : update) : tab,
            ),
          )
        }
        onCancel={() => {
          pendingClose?.store.dispose();
          setPendingClose(null);
        }}
        onDiscard={() => {
          const tabId = pendingClose?.tabId;
          pendingClose?.store.dispose();
          setPendingClose(null);
          if (tabId) void closeTab(tabId, true);
        }}
        onSaved={() => {
          const tabId = pendingClose?.tabId;
          pendingClose?.store.dispose();
          setPendingClose(null);
          if (tabId) void closeTab(tabId, true);
        }}
      />
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
