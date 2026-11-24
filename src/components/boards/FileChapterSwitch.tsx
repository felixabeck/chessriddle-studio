import {
  createContext,
  use,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useStore as useJotaiStore } from "jotai";
import { notifications } from "@mantine/notifications";
import { useTranslation } from "react-i18next";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import { notifyUnlessCancelled } from "@/components/files/notifyError";
import ConfirmChangesModal from "@/components/tabs/ConfirmChangesModal";
import { errorUnlessCancelled } from "@/platform/errors";
import { tauri } from "@/platform/tauri";
import { currentTabAtom } from "@/state/atoms";
import { setFileFreshness } from "@/state/fileFreshness";
import { beginFileOpen } from "@/state/fileStructureChange";
import type { TreeStore } from "@/state/store/tree";
import { useOwnerTab } from "@/state/tabScope";
import { loadFileGame } from "@/utils/files";
import { fileWorkspaceKey } from "@/utils/pathCapabilities";
import { getTabFile, isFileBackedTab, replaceFileGame, type FileBackedTab } from "@/utils/tabs";
import { locateBoardState } from "@/utils/treeReducer";

/**
 * Optional position to land on after loading a target chapter.
 * `boardState` is a `getBoardState` key; `path` is checked first via `locateBoardState` before
 * falling back to the first matching node in the loaded chapter.
 */
export type ChapterLandingTarget = {
  path: readonly number[];
  boardState: string;
};

/**
 * Switches the current file-backed analysis tab to another chapter of its file.
 *
 * `chapter` is the 0-based game index in the file — the same numbering used by
 * `getTabGameNumber`, `loadFileGame` / `tauri.readGames` start index, and
 * `filePositionIndex`'s `chapter` field.
 *
 * When `landing` is provided, the loaded chapter must be present on disk and contain
 * `landing.boardState` (matched via `locateBoardState`). If not, nothing is installed, the open
 * chapter stays untouched, and an error notification is shown.
 */
export type SwitchFileChapter = (chapter: number, landing?: ChapterLandingTarget) => Promise<void>;

type ChapterSwitchRequest = {
  tab: FileBackedTab;
  store: TreeStore;
  fileKey: string;
  chapter: number;
  landing?: ChapterLandingTarget;
  generation: number;
  controller: AbortController;
};

type ChapterTreeSnapshot = Pick<ReturnType<TreeStore["getState"]>, "root" | "headers" | "dirty">;

const FileChapterSwitchContext = createContext<SwitchFileChapter | null>(null);

/** Returns the tab-scoped chapter switcher when inside `FileChapterSwitchProvider`, else `null`. */
export function useFileChapterSwitch(): SwitchFileChapter | null {
  return use(FileChapterSwitchContext);
}

/**
 * Tracks the mounted file-backed tab's identity (`tabId`, `fileKey`, `store`) and proves that an
 * async callback still belongs to the active workspace owner for that file.
 */
export function useFileTabOwner(store: TreeStore) {
  const [currentTab] = useOwnerTab();
  const jotaiStore = useJotaiStore();
  const tabFile = getTabFile(currentTab);
  const tabId = currentTab?.value;
  const fileKey = tabFile ? fileWorkspaceKey(tabFile.handle) : null;
  const currentIdentityRef = useRef({ tabId, fileKey, store });
  currentIdentityRef.current = { tabId, fileKey, store };

  const isCurrentOwner = useCallback(
    (ownerId: string, ownerFileKey: string, ownerStore: TreeStore) => {
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
    },
    [jotaiStore],
  );

  return { currentTab, tabFile, tabId, fileKey, isCurrentOwner };
}

/**
 * Tab-scoped owner of chapter switching and its unsaved-changes confirmation for a file-backed
 * analysis tab. Mounted outside the side-panel `Tabs` so switching works regardless of which side
 * panel is active.
 */
export function FileChapterSwitchProvider({ children }: { children: ReactNode }) {
  const store = use(TreeStateContext)!;
  const jotaiStore = useJotaiStore();
  const { t } = useTranslation();
  const { currentTab, tabId, fileKey, isCurrentOwner } = useFileTabOwner(store);

  const [chapterConfirmation, setChapterConfirmation] = useState<ChapterSwitchRequest | null>(null);

  const chapterAbortRef = useRef<AbortController | null>(null);
  const chapterGenerationRef = useRef(0);
  const currentOwnerRef = useRef({ currentTab, fileKey, store });
  currentOwnerRef.current = { currentTab, fileKey, store };

  useEffect(() => {
    setChapterConfirmation(null);
    return () => {
      chapterGenerationRef.current += 1;
      chapterAbortRef.current?.abort();
      chapterAbortRef.current = null;
    };
  }, [tabId, fileKey, store]);

  const isCurrentChapterRequest = useCallback(
    (request: ChapterSwitchRequest) =>
      request.generation === chapterGenerationRef.current &&
      !request.controller.signal.aborted &&
      isCurrentOwner(request.tab.value, request.fileKey, request.store),
    [isCurrentOwner],
  );

  const loadChapter = useCallback(
    async (request: ChapterSwitchRequest, discardSnapshot?: ChapterTreeSnapshot) => {
      if (!isCurrentChapterRequest(request)) return;
      const { tab, store: ownerStore, chapter, landing, controller } = request;
      chapterAbortRef.current = controller;
      const initialTree = discardSnapshot ?? ownerStore.getState();
      if (!discardSnapshot && initialTree.dirty) {
        setChapterConfirmation(request);
        return;
      }

      let endOpen: (() => void) | undefined;
      try {
        endOpen = beginFileOpen(request.fileKey);
        const loaded = await loadFileGame(tab.gameOrigin.file.handle, chapter, controller.signal);
        if (!isCurrentChapterRequest(request)) {
          return;
        }
        const currentTree = ownerStore.getState();
        if (
          (!discardSnapshot && currentTree.dirty) ||
          currentTree.root !== initialTree.root ||
          currentTree.headers !== initialTree.headers
        ) {
          setChapterConfirmation(request);
          return;
        }
        let treeToInstall = loaded.tree;
        if (landing) {
          const located = loaded.present
            ? locateBoardState(loaded.tree.root, landing.path, landing.boardState)
            : null;
          if (!located) {
            notifications.show({
              color: "danger",
              title: t("Common.Error"),
              message: t("Notation.TranspositionMissingInChapter"),
            });
            return;
          }
          treeToInstall = { ...loaded.tree, position: located.position };
        }
        const result = replaceFileGame({
          store: jotaiStore,
          owner: tab,
          treeStore: ownerStore,
          snapshot: initialTree,
          tree: treeToInstall,
          page: chapter,
          isCurrent: () => isCurrentChapterRequest(request),
        });
        if (result.kind !== "committed") return;
        // The tree was just read from disk, so the gate need not read it a second time.
        if (!loaded.present && chapter < tab.gameOrigin.file.numGames) {
          setFileFreshness(tab.value, "unavailable");
        } else {
          setFileFreshness(tab.value, "verified", { verifiedRevision: loaded.revision });
        }
      } catch (error) {
        if (!isCurrentChapterRequest(request)) {
          return;
        }
        if (errorUnlessCancelled(error) === null) return;
        if (landing) {
          try {
            const count = await tauri.countPgnGames(tab.gameOrigin.file.handle, {
              signal: controller.signal,
            });
            if (!isCurrentChapterRequest(request)) {
              return;
            }
            if (chapter >= count) {
              notifications.show({
                color: "danger",
                title: t("Common.Error"),
                message: t("Notation.TranspositionMissingInChapter"),
              });
              return;
            }
          } catch {
            if (!isCurrentChapterRequest(request)) {
              return;
            }
          }
        }
        notifyUnlessCancelled(t("Common.Error"), error);
      } finally {
        endOpen?.();
        if (chapterAbortRef.current === controller) chapterAbortRef.current = null;
      }
    },
    [isCurrentChapterRequest, jotaiStore, t],
  );

  const switchChapter = useCallback<SwitchFileChapter>(
    (chapter, landing) => {
      const {
        currentTab: tab,
        fileKey: currentFileKey,
        store: currentStore,
      } = currentOwnerRef.current;
      if (!isFileBackedTab(tab) || currentFileKey === null) return Promise.resolve();
      chapterAbortRef.current?.abort();
      const request: ChapterSwitchRequest = {
        tab,
        store: currentStore,
        fileKey: currentFileKey,
        chapter,
        landing,
        generation: ++chapterGenerationRef.current,
        controller: new AbortController(),
      };
      setChapterConfirmation(null);
      return loadChapter(request);
    },
    [loadChapter],
  );

  function continueChapterConfirmation(discard: boolean) {
    if (!chapterConfirmation || !isCurrentChapterRequest(chapterConfirmation)) return;
    const snapshot = discard ? chapterConfirmation.store.getState() : undefined;
    // The generation check also prevents a captured callback from dismissing a newer request.
    setChapterConfirmation(null);
    void loadChapter(chapterConfirmation, snapshot);
  }

  return (
    <FileChapterSwitchContext.Provider value={switchChapter}>
      <ConfirmChangesModal
        pendingClose={
          chapterConfirmation
            ? { tabId: chapterConfirmation.tab.value, store: chapterConfirmation.store }
            : null
        }
        tab={chapterConfirmation?.tab}
        onCancel={() => {
          if (!chapterConfirmation || !isCurrentChapterRequest(chapterConfirmation)) return;
          setChapterConfirmation(null);
          chapterConfirmation.controller.abort();
        }}
        onDiscard={() => continueChapterConfirmation(true)}
        onSaved={() => continueChapterConfirmation(false)}
      />
      {children}
    </FileChapterSwitchContext.Provider>
  );
}
