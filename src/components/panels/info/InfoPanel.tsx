import { useOwnerTab } from "@/state/tabScope";
import { tauri } from "@/platform/tauri";
import { notifications } from "@mantine/notifications";
import { Accordion, Box, Divider, Group, ScrollArea, Stack, Text } from "@mantine/core";
import { Plus } from "lucide-react";
import { errorUnlessCancelled, normalizeError } from "@/platform/errors";
import { useAtomValue, useSetAtom, useStore as useJotaiStore } from "jotai";
import { use, useEffect, useRef, useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { isTreeViewDeferred, useTreeView } from "@/state/deferredTreeView";
import { type DatabaseHandle, type FileWorkspaceHandle } from "@/bindings";
import GameInfo from "@/components/common/GameInfo";
import { IconAction } from "@/components/common/IconAction";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import ConfirmChangesModal from "@/components/tabs/ConfirmChangesModal";
import { currentTabAtom, tabsAtom } from "@/state/atoms";
import { keyMapAtom } from "@/state/keybinds";
import { formatNumber } from "@/utils/format";
import {
  getTabFile,
  getTabGameNumber,
  isFileBackedTab,
  matchesFileGameTab,
  sameTabOwner,
  rebindFileTabsAfterStructureChange,
  replaceFileGame,
  type FileBackedTab,
} from "@/utils/tabs";
import FenSearch from "./FenSearch";
import FileInfo from "./FileInfo";
import GameSelector, { type DeleteGameSnapshot, type GameSelectorRow } from "./GameSelector";
import classes from "./InfoPanel.module.css";
import PgnInput from "./PgnInput";
import { getStats } from "@/utils/repertoire";
import { useDatabaseList } from "@/hooks/useDatabaseList";
import { sameDatabaseHandle } from "@/utils/db";
import { databaseRouteTarget } from "@/components/databases/databaseRoute";
import { useNavigate } from "@tanstack/react-router";
import { useActiveDatabaseViewStore } from "@/state/store/database";
import { notifyUnlessCancelled } from "@/components/files/notifyError";
import { fileWorkspaceKey } from "@/utils/pathCapabilities";
import { backgroundHotkeyOptions } from "@/utils/keyboardOwnership";
import { getFileGameName, loadFileGame, withFileWrite } from "@/utils/files";
import { setFileFreshness } from "@/state/fileFreshness";
import {
  beginFileOpen,
  beginFileStructureChange,
  hasFileOpenInFlight,
} from "@/state/fileStructureChange";
import { invalidateFileStructureCaches, markFileTabsFreshness } from "@/state/fileStructureEffects";
import type { Tab } from "@/state/workspaceTypes";
import type { TreeStore } from "@/state/store/tree";

type FileTabUpdateResult = {
  saved: boolean;
  matched: boolean;
};

type PageRequest = {
  tab: FileBackedTab;
  store: TreeStore;
  fileKey: string;
  page: number;
  generation: number;
  controller: AbortController;
};

type PageTreeSnapshot = Pick<ReturnType<TreeStore["getState"]>, "root" | "headers" | "dirty">;

function InfoPanel({ addGame }: { addGame?: () => void }) {
  const store = use(TreeStateContext)!;
  const view = useTreeView(store);
  const stats = isTreeViewDeferred(store) ? { total: 0, leafs: 0, depth: 0 } : getStats(view);
  const headers = useStore(store, (s) => s.headers);
  const [games, setGames] = useState<Map<number, GameSelectorRow>>(new Map());
  const [currentTab, setCurrentTab] = useOwnerTab();
  const tabFile = getTabFile(currentTab);
  const gameNumber = getTabGameNumber(currentTab);
  const isReportoire = tabFile?.metadata.type === "repertoire";

  const { t } = useTranslation();

  return (
    <Stack h="100%" gap={0}>
      {currentTab?.gameOrigin.kind === "database" && (
        <DatabaseInfo path={currentTab.gameOrigin.database} id={currentTab.gameOrigin.gameId} />
      )}
      <GameSelectorAccordion games={games} setGames={setGames} addGame={addGame} />
      <ScrollArea pb="sm">
        <FileInfo setGames={setGames} />
        <Stack px="sm">
          <GameInfo
            headers={headers}
            simplified={isReportoire}
            changeTitle={(title: string) => {
              if (isFileBackedTab(currentTab)) {
                const name = getFileGameName(
                  { ...headers, event: title },
                  currentTab.gameOrigin.file,
                );
                setCurrentTab((tab) =>
                  sameTabOwner(tab, currentTab) && matchesFileGameTab(tab, currentTab.gameOrigin)
                    ? { ...tab, name }
                    : tab,
                );
              }
              setGames((prev) => {
                const newGames = new Map(prev);
                newGames.set(gameNumber, { ...newGames.get(gameNumber), name: title });
                return newGames;
              });
            }}
          />
          <FenSearch />
          <PgnInput />

          <Group>
            <Text fz="xs" c="dimmed">
              {t("PgnInput.Variations")}: {stats.leafs}
            </Text>
            <Text fz="xs" c="dimmed">
              {t("PgnInput.MaxDepth")}: {stats.depth}
            </Text>
            <Text fz="xs" c="dimmed">
              {t("PgnInput.TotalMoves")}: {stats.total}
            </Text>
          </Group>
        </Stack>
      </ScrollArea>
    </Stack>
  );
}

function DatabaseInfo({ path, id: _id }: { path: DatabaseHandle; id: number }) {
  const { t } = useTranslation();
  const { data: databases, isLoading } = useDatabaseList();

  const dbInfo = databases?.databases.find((db) => sameDatabaseHandle(db.file, path));
  const navigate = useNavigate();
  const setActiveDatabase = useActiveDatabaseViewStore((store) => store.setDatabase);

  if (isLoading || !dbInfo || dbInfo.type !== "success") {
    return null;
  }
  return (
    <Stack gap={0}>
      <Box
        className={classes.databaseCard}
        onClick={async () => {
          if (setActiveDatabase(dbInfo) !== true) return;
          await navigate(databaseRouteTarget(dbInfo));
        }}
      >
        <Text tt="uppercase" c="dimmed" fw={700} size="xs">
          {t("Board.Tabs.Database")}
        </Text>
        <Text fw="bold">{dbInfo.title}</Text>
        <Text size="xs" c="dimmed">
          {dbInfo.description}
        </Text>
      </Box>
      <Divider />
    </Stack>
  );
}

function GameSelectorAccordion({
  games,
  setGames,
  addGame,
}: {
  games: Map<number, GameSelectorRow>;
  setGames: React.Dispatch<React.SetStateAction<Map<number, GameSelectorRow>>>;
  addGame?: () => void;
}) {
  const store = use(TreeStateContext)!;
  const [currentTab] = useOwnerTab();
  const setTabs = useSetAtom(tabsAtom);
  const jotaiStore = useJotaiStore();

  const [pageConfirmation, setPageConfirmation] = useState<PageRequest | null>(null);

  const tabFile = getTabFile(currentTab);
  const gameNumber = getTabGameNumber(currentTab);
  const currentName = games.get(gameNumber)?.name || "Untitled";

  const keyMap = useAtomValue(keyMapAtom);
  const { t } = useTranslation();

  useHotkeys(
    keyMap.NEXT_GAME.keys,
    () => {
      if (!tabFile?.numGames) return;
      void setPage(Math.min(gameNumber + 1, tabFile.numGames - 1));
    },
    {
      ...backgroundHotkeyOptions,
      enabled: !!tabFile,
    },
  );

  useHotkeys(keyMap.PREVIOUS_GAME.keys, () => setPage(Math.max(0, gameNumber - 1)), {
    ...backgroundHotkeyOptions,
    enabled: !!tabFile,
  });

  const tabId = currentTab?.value;
  const fileKey = tabFile ? fileWorkspaceKey(tabFile.handle) : null;
  const pageAbortRef = useRef<AbortController | null>(null);
  const pageGenerationRef = useRef(0);
  const countRefreshAbortRef = useRef<AbortController | null>(null);
  const countRefreshGenerationRef = useRef(0);
  const currentIdentityRef = useRef({ tabId, fileKey, store });
  currentIdentityRef.current = { tabId, fileKey, store };

  useEffect(() => {
    setPageConfirmation(null);
    return () => {
      pageGenerationRef.current += 1;
      pageAbortRef.current?.abort();
      pageAbortRef.current = null;
      countRefreshGenerationRef.current += 1;
      countRefreshAbortRef.current?.abort();
      countRefreshAbortRef.current = null;
    };
  }, [tabId, fileKey, store]);

  function isCurrentOwner(ownerId: string, ownerFileKey: string, ownerStore: typeof store) {
    const identity = currentIdentityRef.current;
    if (
      identity.tabId !== ownerId ||
      identity.fileKey !== ownerFileKey ||
      identity.store !== ownerStore
    ) {
      return false;
    }
    // currentTabAtom selects from tabsAtom, so the active tab also proves workspace membership.
    const active = jotaiStore.get(currentTabAtom);
    const activeFile = getTabFile(active);
    return (
      active?.value === ownerId &&
      !!activeFile &&
      fileWorkspaceKey(activeFile.handle) === ownerFileKey
    );
  }

  function belongsToFile(tab: Tab | undefined, key: string): tab is FileBackedTab {
    return isFileBackedTab(tab) && fileWorkspaceKey(tab.gameOrigin.file.handle) === key;
  }

  function withFileCount(
    tab: FileBackedTab,
    numGames: number,
    gameNumber = tab.gameOrigin.gameNumber,
  ): FileBackedTab {
    return {
      ...tab,
      gameOrigin: {
        ...tab.gameOrigin,
        gameNumber,
        file: { ...tab.gameOrigin.file, numGames },
      },
    };
  }

  function updateFileTabs(
    ownerFileKey: string,
    updateTab: (tab: FileBackedTab) => FileBackedTab | null,
    ownerCountPrecondition?: { id: string; count: number },
  ): FileTabUpdateResult {
    let matched = false;
    const saved = setTabs((tabs) => {
      if (ownerCountPrecondition) {
        const owner = tabs.find((tab) => tab.value === ownerCountPrecondition.id);
        const ownerMatched =
          belongsToFile(owner, ownerFileKey) &&
          owner.gameOrigin.file.numGames === ownerCountPrecondition.count;
        if (!ownerMatched) return tabs;
      }

      return tabs.map((tab) => {
        if (!belongsToFile(tab, ownerFileKey)) {
          return tab;
        }
        const updated = updateTab(tab);
        if (updated === null) return tab;
        matched = true;
        return updated;
      });
    });
    return { saved, matched };
  }

  function updateOwnerCount(
    ownerId: string,
    ownerFileKey: string,
    ownerCountPrecondition: number,
    numGames: number,
  ) {
    return updateFileTabs(
      ownerFileKey,
      (tab) => {
        if (tab.value !== ownerId || tab.gameOrigin.file.numGames !== ownerCountPrecondition) {
          return null;
        }
        return withFileCount(tab, numGames);
      },
      { id: ownerId, count: ownerCountPrecondition },
    );
  }

  function workspaceWriteRefusedError() {
    return new Error("Workspace file metadata could not be saved");
  }

  async function refreshOwnerCount(
    ownerId: string,
    handle: FileWorkspaceHandle,
    ownerFileKey: string,
    ownerStore: typeof store,
    ownerCountPrecondition: number,
  ): Promise<"updated" | "superseded" | "refused" | "failed"> {
    countRefreshAbortRef.current?.abort();
    const controller = new AbortController();
    countRefreshAbortRef.current = controller;
    const generation = ++countRefreshGenerationRef.current;
    const isObsolete = () =>
      controller.signal.aborted ||
      generation !== countRefreshGenerationRef.current ||
      !isCurrentOwner(ownerId, ownerFileKey, ownerStore);
    const initialTabs = jotaiStore.get(tabsAtom);
    const owner = initialTabs.find((tab) => tab.value === ownerId);
    if (
      !belongsToFile(owner, ownerFileKey) ||
      owner.gameOrigin.file.numGames !== ownerCountPrecondition ||
      !isCurrentOwner(ownerId, ownerFileKey, ownerStore)
    ) {
      if (countRefreshAbortRef.current === controller) countRefreshAbortRef.current = null;
      return "superseded";
    }
    const countPreconditions = new Map(
      initialTabs
        .filter((tab): tab is FileBackedTab => belongsToFile(tab, ownerFileKey))
        .map((tab) => [tab.value, tab.gameOrigin.file.numGames]),
    );

    try {
      const numGames = await tauri.countPgnGames(handle, { signal: controller.signal });
      if (isObsolete()) {
        return "superseded";
      }

      const update = updateFileTabs(
        ownerFileKey,
        (tab) => {
          const countPrecondition = countPreconditions.get(tab.value);
          if (
            !countPreconditions.has(tab.value) ||
            tab.gameOrigin.file.numGames !== countPrecondition
          ) {
            return null;
          }
          return withFileCount(tab, numGames);
        },
        { id: ownerId, count: ownerCountPrecondition },
      );
      if (!update.matched) return "superseded";
      return update.saved ? "updated" : "refused";
    } catch (error) {
      if (isObsolete() || errorUnlessCancelled(error) === null) {
        return "superseded";
      }
      notifyUnlessCancelled(t("Common.Error"), error);
      return "failed";
    } finally {
      if (countRefreshAbortRef.current === controller) countRefreshAbortRef.current = null;
    }
  }

  function setPage(page: number) {
    if (!isFileBackedTab(currentTab) || fileKey === null) return;
    pageAbortRef.current?.abort();
    const request: PageRequest = {
      tab: currentTab,
      store,
      fileKey,
      page,
      generation: ++pageGenerationRef.current,
      controller: new AbortController(),
    };
    setPageConfirmation(null);
    return loadPage(request);
  }

  function isCurrentPageRequest(request: PageRequest) {
    return (
      request.generation === pageGenerationRef.current &&
      !request.controller.signal.aborted &&
      isCurrentOwner(request.tab.value, request.fileKey, request.store)
    );
  }

  function continuePageConfirmation(discard: boolean) {
    if (!pageConfirmation || !isCurrentPageRequest(pageConfirmation)) return;
    const snapshot = discard ? pageConfirmation.store.getState() : undefined;
    // The generation check also prevents a captured callback from dismissing a newer request.
    setPageConfirmation(null);
    void loadPage(pageConfirmation, snapshot);
  }

  async function loadPage(request: PageRequest, discardSnapshot?: PageTreeSnapshot) {
    if (!isCurrentPageRequest(request)) return;
    const { tab, store: ownerStore, page, controller } = request;
    pageAbortRef.current = controller;
    const initialTree = discardSnapshot ?? ownerStore.getState();
    if (!discardSnapshot && initialTree.dirty) {
      setPageConfirmation(request);
      return;
    }

    let endOpen: (() => void) | undefined;
    try {
      endOpen = beginFileOpen(request.fileKey);
      const loaded = await loadFileGame(tab.gameOrigin.file.handle, page, controller.signal);
      if (!isCurrentPageRequest(request)) {
        return;
      }
      const currentTree = ownerStore.getState();
      if (
        (!discardSnapshot && currentTree.dirty) ||
        currentTree.root !== initialTree.root ||
        currentTree.headers !== initialTree.headers
      ) {
        setPageConfirmation(request);
        return;
      }
      const result = replaceFileGame({
        store: jotaiStore,
        owner: tab,
        treeStore: ownerStore,
        snapshot: initialTree,
        tree: loaded.tree,
        page,
        isCurrent: () => isCurrentPageRequest(request),
      });
      if (result.kind !== "committed") return;
      // The tree was just read from disk, so the gate need not read it a second time.
      if (!loaded.present && page < tab.gameOrigin.file.numGames) {
        setFileFreshness(tab.value, "unavailable");
      } else {
        setFileFreshness(tab.value, "verified", { verifiedRevision: loaded.revision });
      }
    } catch (error) {
      if (!isCurrentPageRequest(request)) {
        return;
      }
      if (errorUnlessCancelled(error) === null) return;
      notifyUnlessCancelled(t("Common.Error"), error);
    } finally {
      endOpen?.();
      if (pageAbortRef.current === controller) pageAbortRef.current = null;
    }
  }

  async function deleteGame(snapshot: DeleteGameSnapshot) {
    if (!tabFile || !currentTab) return;
    const { index, stamp, revision } = snapshot;
    const ownerId = currentTab.value;
    const filePath = tabFile.handle;
    const fileKey = fileWorkspaceKey(filePath);
    const ownerStore = store;
    countRefreshGenerationRef.current += 1;
    countRefreshAbortRef.current?.abort();
    countRefreshAbortRef.current = null;
    const originalCount = tabFile.numGames;
    const predictedCount = originalCount - 1;
    const workspaceTabs = jotaiStore.get(tabsAtom);
    const owner = workspaceTabs.find((tab) => tab.value === ownerId);
    if (!isCurrentOwner(ownerId, fileKey, ownerStore) || !isFileBackedTab(owner)) return;

    const refreshCount = async (
      currentOwner = jotaiStore.get(tabsAtom).find((tab) => tab.value === ownerId),
    ) => {
      if (!isCurrentOwner(ownerId, fileKey, ownerStore) || !isFileBackedTab(currentOwner)) {
        return "superseded";
      }
      return refreshOwnerCount(
        ownerId,
        filePath,
        fileKey,
        ownerStore,
        currentOwner.gameOrigin.file.numGames,
      );
    };

    const showStaleRefusal = () => {
      if (!isCurrentOwner(ownerId, fileKey, ownerStore)) return;
      setGames(new Map());
      notifications.show({
        color: "danger",
        title: t("Common.Error"),
        message: t("Files.RemoveGameStale", {
          defaultValue:
            "The file changed, so no game was removed. Refresh the game list before deleting.",
        }),
      });
    };

    if (
      fileWorkspaceKey(owner.gameOrigin.file.handle) !== fileKey ||
      owner.gameOrigin.file.numGames !== originalCount ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= owner.gameOrigin.file.numGames
    ) {
      showStaleRefusal();
      const refresh = await refreshCount(owner);
      if (refresh === "refused") throw workspaceWriteRefusedError();
      return;
    }

    const initialTabMetadata = new Map(
      workspaceTabs
        .filter((tab): tab is FileBackedTab => belongsToFile(tab, fileKey))
        .map((tab) => [
          tab.value,
          {
            numGames: tab.gameOrigin.file.numGames,
            gameNumber: tab.gameOrigin.gameNumber,
          },
        ]),
    );
    if (hasFileOpenInFlight(fileKey)) {
      showStaleRefusal();
      return;
    }
    const endStructureChange = beginFileStructureChange(fileKey);
    try {
      const optimistic = updateOwnerCount(ownerId, fileKey, originalCount, predictedCount);
      if (!optimistic.matched) {
        showStaleRefusal();
        const refresh = await refreshCount();
        if (refresh === "refused") throw workspaceWriteRefusedError();
        return;
      }
      if (!optimistic.saved) throw workspaceWriteRefusedError();

      let nativeMutationSucceeded = false;
      let replacementMayBeInstalled = false;
      try {
        await withFileWrite(filePath, async () => {
          try {
            await tauri.deleteGame(filePath, index, stamp, revision);
            nativeMutationSucceeded = true;
            replacementMayBeInstalled = true;
          } catch (error) {
            replacementMayBeInstalled = normalizeError(error).category === "applied-despite-error";
            throw error;
          }
        });

        const update = rebindFileTabsAfterStructureChange({
          setTabs,
          fileKey,
          captured: initialTabMetadata,
          count: {
            kind: "changed",
            originalCount,
            numGames: predictedCount,
            optimisticOwner: ownerId,
          },
          ordinals: new Map(
            Array.from(initialTabMetadata.values(), ({ gameNumber }) => [
              gameNumber,
              gameNumber > index ? gameNumber - 1 : gameNumber,
            ]),
          ),
        });
        if (!update.saved && update.matched) {
          markFileTabsFreshness(jotaiStore.get(tabsAtom), fileKey, "conflict");
          if (isCurrentOwner(ownerId, fileKey, ownerStore)) setGames(new Map());
          throw new Error("Committed but durability uncertain: file deletion tab metadata");
        }

        markFileTabsFreshness(jotaiStore.get(tabsAtom), fileKey, "unverified");
        if (isCurrentOwner(ownerId, fileKey, ownerStore)) setGames(new Map());
      } catch (error) {
        const errorDetails = normalizeError(error);
        if (replacementMayBeInstalled || errorDetails.category === "applied-despite-error") {
          replacementMayBeInstalled = true;
          markFileTabsFreshness(jotaiStore.get(tabsAtom), fileKey, "conflict");
          if (isCurrentOwner(ownerId, fileKey, ownerStore)) setGames(new Map());
          if (!nativeMutationSucceeded) await refreshCount();
          throw error;
        }
        const rollbackCount = () =>
          updateOwnerCount(ownerId, fileKey, predictedCount, originalCount);

        if (errorDetails.backendCategory === "stale-game") {
          const rollback = rollbackCount();
          showStaleRefusal();
          const refresh = await refreshCount();
          if ((rollback.matched && !rollback.saved) || refresh === "refused")
            throw workspaceWriteRefusedError();
          return;
        }

        const rollback = rollbackCount();
        if (rollback.matched && !rollback.saved) throw workspaceWriteRefusedError();
        throw error;
      } finally {
        if (replacementMayBeInstalled) invalidateFileStructureCaches(fileKey);
      }
    } finally {
      endStructureChange();
    }
  }

  if (!tabFile) return null;
  const filePath = tabFile.handle;

  return (
    <>
      <ConfirmChangesModal
        pendingClose={
          pageConfirmation
            ? { tabId: pageConfirmation.tab.value, store: pageConfirmation.store }
            : null
        }
        tab={pageConfirmation?.tab}
        onCancel={() => {
          if (!pageConfirmation || !isCurrentPageRequest(pageConfirmation)) return;
          setPageConfirmation(null);
          pageConfirmation.controller.abort();
        }}
        onDiscard={() => continuePageConfirmation(true)}
        onSaved={() => continuePageConfirmation(false)}
      />
      <Accordion
        styles={{
          control: {
            borderBottom: "1px solid var(--mantine-color-default-border)",
          },
          content: { padding: 0 },
        }}
      >
        <Accordion.Item value="game">
          <Accordion.Control>
            <Group justify="space-between" wrap="nowrap" w="100%">
              <Text truncate flex={1}>
                {formatNumber(gameNumber + 1)}. {currentName}
              </Text>
              {addGame && (
                <IconAction
                  label={t("Board.Action.AddGame")}
                  size="sm"
                  variant="subtle"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    addGame();
                  }}
                >
                  <Plus size="0.9rem" />
                </IconAction>
              )}
            </Group>
          </Accordion.Control>
          <Accordion.Panel>
            <Box h="10rem">
              <GameSelector
                games={games}
                setGames={setGames}
                setPage={setPage}
                onActivate={setPage}
                deleteGame={deleteGame}
                path={filePath}
                activePage={gameNumber || 0}
                total={tabFile.numGames}
              />
            </Box>
          </Accordion.Panel>
        </Accordion.Item>
      </Accordion>
    </>
  );
}
export default InfoPanel;
