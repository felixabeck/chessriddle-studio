import { Button, Group, TextInput } from "@mantine/core";
import { useHotkeys } from "@mantine/hooks";
import { useNavigate } from "@tanstack/react-router";
import { getDefaultStore, useAtom, useAtomValue, useSetAtom } from "jotai";
import {
  createContext,
  startTransition,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { tauri } from "@/platform/tauri";
import { platform } from "@/platform/native";
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
import { restorePuzzleSession } from "@/state/puzzleSession";
import { tabStorage } from "@/state/store/tabStorage";
import {
  closeTreeStore,
  createTreeStore,
  invalidateReportOwner,
  restoreReportOwner,
  type TreeStore,
} from "@/state/store/tree";
import { isKeyboardOwnedElsewhere, withKeyboardOwnership } from "@/utils/keyboardOwnership";
import {
  asksBeforeDiscardingChanges,
  commitNewTab,
  createTab,
  getTabTreeKey,
  runTabCreation,
  type Tab,
} from "@/utils/tabs";
import { defaultTree } from "@/utils/treeReducer";
import { abortExactTabGame } from "../boards/gameSession";
import AppModal from "../common/AppModal";
import { notifyUnlessCancelled } from "../files/notifyError";
import ConfirmChangesModal from "./ConfirmChangesModal";

export type TabCommands = {
  tabs: Tab[];
  activeTab: string | null;
  selectTab: (tabId: string) => void;
  closeTab: (tabId: string | null, discard?: boolean) => Promise<void>;
  duplicateTab: (tabId: string) => void;
  renameTab: (tabId: string) => void;
  reorderTabs: (fromIndex: number, toIndex: number) => void;
  newTab: () => void;
};

const TabCommandsContext = createContext<TabCommands | null>(null);

export function useTabCommands(): TabCommands {
  const commands = useContext(TabCommandsContext);
  if (!commands) throw new Error("useTabCommands used outside a TabCommandsProvider");
  return commands;
}

export function TabCommandsProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const [tabs, setTabs] = useAtom(tabsAtom);
  const [activeTab, setActiveTab] = useAtom(activeTabAtom);
  const closeWorkspaceTab = useSetAtom(closeWorkspaceTabAtom);
  const [pendingClose, setPendingClose] = useState<{ tabId: string; store: TreeStore } | null>(
    null,
  );
  const [renameTarget, setRenameTarget] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

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

  const showTab = useCallback(
    (tabId: string) => {
      handleSetActiveTab(tabId);
      void navigate({ to: "/" });
    },
    [handleSetActiveTab, navigate],
  );

  useEffect(() => {
    if (tabs.length === 0) {
      void runTabCreation({
        create: () => createTab({ tab: { name: t("Tab.NewTab"), type: "new" }, setTabs }),
        onError: (error) => notifyUnlessCancelled(t("Common.Error"), error),
      });
    }
  }, [setTabs, tabs, t]);

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
        ) {
          showTab(value);
          return;
        }
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
    [closeWorkspaceTab, showTab, t, tabs],
  );

  const selectTab = useCallback(
    (tabId: string) => {
      if (!tabs.some((tab) => tab.value === tabId)) return;
      handleSetActiveTab(tabId);
    },
    [handleSetActiveTab, tabs],
  );

  const selectTabAt = useCallback(
    (index: number) => {
      if (tabs.length === 0) return;
      handleSetActiveTab(tabs[Math.min(index, tabs.length - 1)].value);
    },
    [handleSetActiveTab, tabs],
  );

  const cycleTabs = useCallback(
    (reverse = false) => {
      if (tabs.length === 0) return;
      const index = tabs.findIndex((tab) => tab.value === activeTab);
      if (index === -1) return;
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
    },
    [activeTab, handleSetActiveTab, tabs],
  );

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

  const renameTab = useCallback(
    (tabId: string) => {
      const tab = tabs.find((candidate) => candidate.value === tabId);
      if (!tab) return;
      setRenameValue(t(tab.name, { defaultValue: tab.name }));
      setRenameTarget(tabId);
    },
    [t, tabs],
  );

  const saveRename = () => {
    if (!renameTarget) return;
    if (!tabs.some((tab) => tab.value === renameTarget)) {
      setRenameTarget(null);
      return;
    }
    if (!renameValue.trim()) return;
    setTabs((previous) =>
      previous.map((tab) =>
        tab.value === renameTarget ? { ...tab, name: renameValue.trim() } : tab,
      ),
    );
    setRenameTarget(null);
  };

  const reorderTabs = useCallback(
    (fromIndex: number, toIndex: number) => {
      setTabs((prev) => {
        const result = Array.from(prev);
        const [removed] = result.splice(fromIndex, 1);
        result.splice(toIndex, 0, removed);
        return result;
      });
    },
    [setTabs],
  );

  const newTab = useCallback(() => {
    void runTabCreation({
      create: () => createTab({ tab: { name: t("Tab.NewTab"), type: "new" }, setTabs }),
      onError: (error) => notifyUnlessCancelled(t("Common.Error"), error),
    });
  }, [setTabs, t]);

  useEffect(() => {
    if (platform() !== "macos") return;

    const handler = (e: KeyboardEvent) => {
      if (isKeyboardOwnedElsewhere(e, null)) return;
      if (e.metaKey && e.key.toLowerCase() === "w") {
        e.preventDefault();
        e.stopPropagation();
        void closeTab(activeTab);
      }
    };

    window.addEventListener("keydown", handler, { capture: true });

    return () => window.removeEventListener("keydown", handler, { capture: true });
  }, [closeTab, activeTab]);

  const keyMap = useAtomValue(keyMapAtom);
  useHotkeys(
    withKeyboardOwnership([
      [keyMap.CLOSE_TAB.keys, () => void closeTab(activeTab)],
      [keyMap.CYCLE_TABS.keys, () => cycleTabs()],
      [keyMap.REVERSE_CYCLE_TABS.keys, () => cycleTabs(true)],
      ["alt+1", () => selectTabAt(0)],
      ["ctrl+1", () => selectTabAt(0)],
      ["alt+2", () => selectTabAt(1)],
      ["ctrl+2", () => selectTabAt(1)],
      ["alt+3", () => selectTabAt(2)],
      ["ctrl+3", () => selectTabAt(2)],
      ["alt+4", () => selectTabAt(3)],
      ["ctrl+4", () => selectTabAt(3)],
      ["alt+5", () => selectTabAt(4)],
      ["ctrl+5", () => selectTabAt(4)],
      ["alt+6", () => selectTabAt(5)],
      ["ctrl+6", () => selectTabAt(5)],
      ["alt+7", () => selectTabAt(6)],
      ["ctrl+7", () => selectTabAt(6)],
      ["alt+8", () => selectTabAt(7)],
      ["ctrl+8", () => selectTabAt(7)],
      ["alt+9", () => selectTabAt(tabs.length - 1)],
      ["ctrl+9", () => selectTabAt(tabs.length - 1)],
    ]),
  );

  const commands = useMemo<TabCommands>(
    () => ({
      tabs,
      activeTab,
      selectTab,
      closeTab,
      duplicateTab,
      renameTab,
      reorderTabs,
      newTab,
    }),
    [activeTab, closeTab, duplicateTab, newTab, renameTab, reorderTabs, selectTab, tabs],
  );

  return (
    <TabCommandsContext.Provider value={commands}>
      {children}
      <AppModal
        opened={renameTarget !== null}
        onClose={() => setRenameTarget(null)}
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
          <Button variant="default" onClick={() => setRenameTarget(null)}>
            {t("Common.Cancel")}
          </Button>
          <Button onClick={saveRename}>{t("Common.Save")}</Button>
        </Group>
      </AppModal>
      <ConfirmChangesModal
        pendingClose={pendingClose}
        tab={tabs.find((tab) => tab.value === pendingClose?.tabId)}
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
    </TabCommandsContext.Provider>
  );
}
