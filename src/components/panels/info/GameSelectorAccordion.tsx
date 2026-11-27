import { tauri } from "@/platform/tauri";
import { notifications } from "@mantine/notifications";
import { Accordion, Box, Group, Text } from "@mantine/core";
import { Plus } from "lucide-react";
import { errorUnlessCancelled, normalizeError } from "@/platform/errors";
import { useAtomValue, useSetAtom, useStore as useJotaiStore } from "jotai";
import { use, useCallback, useEffect, useRef } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import type { FileWorkspaceHandle } from "@/bindings";
import { useFileChapterSwitch, useFileTabOwner } from "@/components/boards/FileChapterSwitch";
import { GameTitle } from "@/components/files/GameTitle";
import { lineTitleOf, type LineTitle } from "@/utils/lineTitle";
import { getGameName } from "@/utils/treeReducer";
import { IconAction } from "@/components/common/IconAction";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import { tabsAtom } from "@/state/atoms";
import { keyMapAtom } from "@/state/keybinds";
import { formatNumber } from "@/utils/format";
import {
  getTabGameNumber,
  isFileBackedTab,
  rebindFileTabsAfterStructureChange,
  type FileBackedTab,
} from "@/utils/tabs";
import GameSelector, { type DeleteGameSnapshot, type GameSelectorRow } from "./GameSelector";
import { notifyUnlessCancelled } from "@/components/files/notifyError";
import { fileWorkspaceKey } from "@/utils/pathCapabilities";
import { backgroundHotkeyOptions } from "@/utils/keyboardOwnership";
import { withFileWrite } from "@/utils/files";
import { setFileFreshness, useFileFreshness } from "@/state/fileFreshness";
import { beginFileStructureChange, hasFileOpenInFlight } from "@/state/fileStructureChange";
import { invalidateFileStructureCaches, markFileTabsFreshness } from "@/state/fileStructureEffects";
import type { Tab } from "@/state/workspaceTypes";

type FileTabUpdateResult = {
  saved: boolean;
  matched: boolean;
};

export default function GameSelectorAccordion({
  games,
  setGames,
  addGame,
}: {
  games: Map<number, GameSelectorRow>;
  setGames: React.Dispatch<React.SetStateAction<Map<number, GameSelectorRow>>>;
  addGame?: () => void;
}) {
  const store = use(TreeStateContext)!;
  const { currentTab, tabFile, tabId, fileKey, isCurrentOwner } = useFileTabOwner(store);
  const { verifiedRevision } = useFileFreshness(currentTab?.value ?? "");
  const setTabs = useSetAtom(tabsAtom);
  const jotaiStore = useJotaiStore();
  const switchChapter = useFileChapterSwitch();
  const setPage = useCallback(
    (page: number) => (switchChapter ? switchChapter(page) : Promise.resolve()),
    [switchChapter],
  );

  const gameNumber = getTabGameNumber(currentTab);
  const headers = useStore(store, (state) => state.headers);
  const repertoire = tabFile?.metadata.type === "repertoire";
  const currentTitle: LineTitle = repertoire
    ? lineTitleOf(headers)
    : { name: getGameName(headers) };

  const keyMap = useAtomValue(keyMapAtom);
  const { t } = useTranslation();

  useHotkeys(
    keyMap.NEXT_GAME.keys,
    () => {
      if (!tabFile?.numGames) return;
      const nextPage = Math.min(gameNumber + 1, tabFile.numGames - 1);
      if (nextPage === gameNumber) return;
      void setPage(nextPage);
    },
    {
      ...backgroundHotkeyOptions,
      enabled: !!tabFile,
    },
  );

  useHotkeys(
    keyMap.PREVIOUS_GAME.keys,
    () => {
      const nextPage = Math.max(0, gameNumber - 1);
      if (nextPage === gameNumber) return;
      void setPage(nextPage);
    },
    {
      ...backgroundHotkeyOptions,
      enabled: !!tabFile,
    },
  );

  const countRefreshAbortRef = useRef<AbortController | null>(null);
  const countRefreshGenerationRef = useRef(0);

  useEffect(() => {
    return () => {
      countRefreshGenerationRef.current += 1;
      countRefreshAbortRef.current?.abort();
      countRefreshAbortRef.current = null;
    };
  }, [tabId, fileKey, store]);

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
        // A tab that had the deleted game open keeps its number, which now names the next game
        // (or no game). Withhold it rather than let its reconcile adopt that game. The captured
        // number tells it apart from the next game's tab, which the rebind just moved to `index`.
        const replacing = index < predictedCount;
        for (const tab of jotaiStore.get(tabsAtom)) {
          if (
            belongsToFile(tab, fileKey) &&
            tab.gameOrigin.gameNumber === index &&
            initialTabMetadata.get(tab.value)?.gameNumber === index
          ) {
            setFileFreshness(tab.value, "unavailable", {
              gameReplaced: replacing,
              errorMessage: t("FileFreshness.GameNoLongerInFile"),
            });
          }
        }
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
    <Accordion
      styles={{
        control: {
          flex: 1,
          width: "auto",
          minWidth: 0,
        },
        content: { padding: 0 },
      }}
    >
      <Accordion.Item value="game">
        {/* Add game is a sibling of the trigger: a button inside Accordion.Control is nested-interactive. */}
        <Group
          wrap="nowrap"
          gap={0}
          align="center"
          w="100%"
          style={{
            borderBottom: "1px solid var(--mantine-color-default-border)",
          }}
        >
          <Accordion.Control>
            <Text truncate>
              {formatNumber(gameNumber + 1)}.{" "}
              <GameTitle title={currentTitle} repertoire={repertoire} />
            </Text>
          </Accordion.Control>
          {addGame && (
            <IconAction
              label={t("Board.Action.AddGame")}
              size="sm"
              variant="subtle"
              mr="xs"
              flex="none"
              onClick={addGame}
            >
              <Plus size="0.9rem" />
            </IconAction>
          )}
        </Group>
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
              repertoire={repertoire}
              activeTitle={currentTitle}
              verifiedRevision={verifiedRevision ?? undefined}
            />
          </Box>
        </Accordion.Panel>
      </Accordion.Item>
    </Accordion>
  );
}
