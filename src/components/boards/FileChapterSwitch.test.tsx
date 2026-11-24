import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Provider as JotaiProvider, createStore as createJotaiStore } from "jotai";
import { MantineProvider } from "@mantine/core";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import { TabCommandsProvider } from "@/components/tabs/TabCommands";
import { TauriCommandError } from "@/platform/tauri";
import { activeTabAtom, currentTabAtom, tabsAtom } from "@/state/atoms";
import { getFileFreshness, removeFileFreshness, setFileFreshness } from "@/state/fileFreshness";
import { hasFileOpenInFlight } from "@/state/fileStructureChange";
import { closeTreeStore, createTreeStore, type TreeStore } from "@/state/store/tree";
import { tabStorage } from "@/state/store/tabStorage";
import { WorkspaceTabScope } from "@/state/tabScope";
import { WORKSPACE_STORAGE_KEY } from "@/state/workspace";
import type { Tab } from "@/state/workspaceTypes";
import { installMatchMediaStub } from "@/tests/matchMedia";
import type { loadFileGame } from "@/utils/files";
import { defaultTree, getBoardState, getNodeAtPath } from "@/utils/treeReducer";
import {
  FileChapterSwitchProvider,
  useFileChapterSwitch,
  type ChapterLandingTarget,
  type SwitchFileChapter,
} from "./FileChapterSwitch";

const mocks = vi.hoisted(() => ({
  loadFileGame: vi.fn(),
  useRealLoadFileGame: false,
  readGame: vi.fn(),
  countPgnGames: vi.fn(),
  lexPgn: vi.fn(),
  writeGame: vi.fn(),
  notify: vi.fn(),
}));

vi.mock("react-i18next", async (original) => ({
  ...(await original<typeof import("react-i18next")>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useRouterState: ({
    select,
  }: {
    select: (state: { location: { pathname: string; href: string } }) => unknown;
  }) => select({ location: { pathname: "/", href: "/" } }),
}));

vi.mock("@mantine/notifications", () => ({
  notifications: { show: mocks.notify },
}));

vi.mock("@/platform/native", () => ({
  platform: () => "linux",
  error: vi.fn().mockResolvedValue(undefined),
  warn: vi.fn().mockResolvedValue(undefined),
  info: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
}));

vi.mock("@/platform/tauri", async () => {
  const actual = await vi.importActual<typeof import("@/platform/tauri")>("@/platform/tauri");
  return {
    ...actual,
    tauri: {
      ...actual.tauri,
      readGame: mocks.readGame,
      countPgnGames: mocks.countPgnGames,
      lexPgn: mocks.lexPgn,
      writeGame: mocks.writeGame,
    },
  };
});

vi.mock("@/utils/files", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/files")>();
  return {
    ...actual,
    loadFileGame: (...args: Parameters<typeof actual.loadFileGame>) =>
      mocks.useRealLoadFileGame ? actual.loadFileGame(...args) : mocks.loadFileGame(...args),
  };
});

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
installMatchMediaStub();

function buildChapterTree(
  mainLine: string[],
  variation?: { fromPath: number[]; moves: string[] },
  event = "Target Chapter",
) {
  const builder = createTreeStore();
  const main = builder.getState().makeMoves({ payload: mainLine });
  if (!main.success) throw main.error;
  if (variation) {
    builder.getState().goToMove(variation.fromPath);
    const branch = builder.getState().makeMoves({ payload: variation.moves });
    if (!branch.success) throw branch.error;
  }
  builder.getState().goToStart();
  const state = builder.getState();
  const tree = defaultTree();
  tree.root = state.root;
  tree.headers = { ...state.headers, event };
  tree.position = [];
  tree.dirty = false;
  tree.sourceStamp = "b".repeat(64);
  return tree;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, refuse) => {
    resolve = accept;
    reject = refuse;
  });
  return { promise, resolve, reject };
}

describe("FileChapterSwitchProvider", () => {
  let container: HTMLDivElement;
  let root: Root;
  let treeStore: TreeStore;
  let jotaiStore: ReturnType<typeof createJotaiStore>;
  let capturedSwitch: SwitchFileChapter | null;

  const tabId = "33333333-3333-4333-8333-333333333333";
  const tab: Tab = {
    name: "Chapter 1",
    value: tabId,
    type: "analysis",
    gameOrigin: {
      kind: "file",
      gameNumber: 0,
      file: {
        type: "file",
        handle: { id: { id: "workspace-token-switch" }, kind: "fileWorkspace" },
        name: "openings.pgn",
        numGames: 3,
        metadata: { type: "repertoire", tags: [] },
        lastModified: 1,
      },
    },
  };

  function Consumer() {
    capturedSwitch = useFileChapterSwitch();
    return <div data-testid="no-info-panel-consumer" />;
  }

  function renderOwner(store: TreeStore = treeStore, activeTabId: string = tabId) {
    return (
      <MantineProvider env="test">
        <JotaiProvider store={jotaiStore}>
          <TabCommandsProvider>
            <TreeStateContext.Provider value={store}>
              <WorkspaceTabScope tabId={activeTabId}>
                <FileChapterSwitchProvider>
                  <Consumer />
                </FileChapterSwitchProvider>
              </WorkspaceTabScope>
            </TreeStateContext.Provider>
          </TabCommandsProvider>
        </JotaiProvider>
      </MantineProvider>
    );
  }

  function modalButton(label: string) {
    const button = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
      (element) => element.textContent?.trim() === label,
    );
    if (!button) throw new Error(`Missing modal button ${label}`);
    return button;
  }

  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    sessionStorage.setItem(
      WORKSPACE_STORAGE_KEY,
      JSON.stringify({ version: 1, tabs: [tab], activeTab: tabId }),
    );
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    capturedSwitch = null;

    closeTreeStore(tabId);
    const initial = buildChapterTree(["e4", "e5"], undefined, "Chapter 1");
    initial.sourceStamp = "a".repeat(64);
    tabStorage.seed(tabId, initial);
    treeStore = createTreeStore(tabId, initial);

    jotaiStore = createJotaiStore();
    jotaiStore.set(tabsAtom, [tab]);
    jotaiStore.set(activeTabAtom, tabId);
    setFileFreshness(tabId, "verified", { verifiedRevision: "rev-0" });

    mocks.loadFileGame.mockReset();
    mocks.useRealLoadFileGame = false;
    mocks.readGame.mockReset().mockImplementation(async () => ({
      pgn: "*",
      stamp: treeStore.getState().sourceStamp,
      present: true,
    }));
    mocks.countPgnGames.mockReset().mockResolvedValue(3);
    mocks.lexPgn.mockReset().mockResolvedValue([{ type: "Outcome", value: "*" }]);
    mocks.writeGame.mockReset().mockResolvedValue({ stamp: "c".repeat(64), revision: "rev-saved" });
    mocks.notify.mockReset();
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    container?.remove();
    closeTreeStore(tabId);
    removeFileFreshness(tabId);
    vi.restoreAllMocks();
    tabStorage.flush();
  });

  test("returns null outside FileChapterSwitchProvider", async () => {
    let outside: SwitchFileChapter | null | undefined;
    function Outside() {
      outside = useFileChapterSwitch();
      return null;
    }
    await act(async () => root.render(<Outside />));
    expect(outside).toBeNull();
  });

  test("switches chapters without InfoPanel mounted", async () => {
    const targetTree = buildChapterTree(["d4", "d5", "c4"], undefined, "Chapter 2");
    mocks.loadFileGame.mockResolvedValueOnce({
      pgn: "1. d4 d5 2. c4 *",
      stamp: targetTree.sourceStamp,
      revision: "rev-1",
      present: true,
      tree: targetTree,
    });
    await act(async () => root.render(renderOwner()));
    expect(capturedSwitch).not.toBeNull();

    await act(async () => {
      await capturedSwitch!(1);
    });

    expect(mocks.loadFileGame).toHaveBeenCalledWith(
      tab.gameOrigin.kind === "file" ? tab.gameOrigin.file.handle : undefined,
      1,
      expect.any(AbortSignal),
    );
    expect(jotaiStore.get(currentTabAtom)?.gameOrigin).toMatchObject({ gameNumber: 1 });
    expect(treeStore.getState().root).toBe(targetTree.root);
    expect(treeStore.getState().position).toEqual([]);
    expect(getFileFreshness(tabId)).toMatchObject({
      state: "verified",
      verifiedRevision: "rev-1",
    });
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  test("landing target installs the chapter with cursor on the remembered path when it still matches", async () => {
    // Both 1. d4 d5 2. c4 (path [0,0,0]) and 1. c4 d5 2. d4 (path [1,0,0]) reach the same position.
    const targetTree = buildChapterTree(["d4", "d5", "c4"], {
      fromPath: [],
      moves: ["c4", "d5", "d4"],
    });
    const rememberedPath = [1, 0, 0];
    const targetBoardState = getBoardState(getNodeAtPath(targetTree.root, rememberedPath).fen);
    mocks.loadFileGame.mockResolvedValueOnce({
      pgn: "target",
      stamp: targetTree.sourceStamp,
      revision: "rev-2",
      present: true,
      tree: targetTree,
    });

    await act(async () => root.render(renderOwner()));
    await act(async () => {
      await capturedSwitch!(2, { path: rememberedPath, boardState: targetBoardState });
    });

    expect(jotaiStore.get(currentTabAtom)?.gameOrigin).toMatchObject({ gameNumber: 2 });
    expect(treeStore.getState().root).toBe(targetTree.root);
    expect(treeStore.getState().position).toEqual(rememberedPath);
    expect(getFileFreshness(tabId)).toMatchObject({
      state: "verified",
      verifiedRevision: "rev-2",
    });
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  test("landing target falls back to the first matching node when the remembered path is stale", async () => {
    const targetTree = buildChapterTree(["d4", "d5", "c4"]);
    const actualPath = [0, 0, 0];
    const targetBoardState = getBoardState(getNodeAtPath(targetTree.root, actualPath).fen);
    mocks.loadFileGame.mockResolvedValueOnce({
      pgn: "target",
      stamp: targetTree.sourceStamp,
      revision: "rev-3",
      present: true,
      tree: targetTree,
    });

    await act(async () => root.render(renderOwner()));
    await act(async () => {
      await capturedSwitch!(1, { path: [0, 1, 2], boardState: targetBoardState });
    });

    expect(jotaiStore.get(currentTabAtom)?.gameOrigin).toMatchObject({ gameNumber: 1 });
    expect(treeStore.getState().root).toBe(targetTree.root);
    expect(treeStore.getState().position).toEqual(actualPath);
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  test("landing target refuses an absent chapter even when its parsed default tree matches the start position", async () => {
    const emptyTree = defaultTree();
    const startBoardState = getBoardState(emptyTree.root.fen);
    const originalRoot = treeStore.getState().root;
    mocks.loadFileGame.mockResolvedValueOnce({
      pgn: "",
      stamp: emptyTree.sourceStamp,
      revision: "rev-4",
      present: false,
      tree: emptyTree,
    });

    await act(async () => root.render(renderOwner()));
    await act(async () => {
      await capturedSwitch!(2, { path: [], boardState: startBoardState });
    });

    expect(jotaiStore.get(currentTabAtom)?.gameOrigin).toMatchObject({ gameNumber: 0 });
    expect(treeStore.getState().root).toBe(originalRoot);
    expect(getFileFreshness(tabId)).toMatchObject({
      state: "verified",
      verifiedRevision: "rev-0",
    });
    expect(hasFileOpenInFlight("workspace-token-switch")).toBe(false);
    expect(mocks.notify).toHaveBeenCalledOnce();
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        color: "danger",
        title: "Common.Error",
        message: "Notation.TranspositionMissingInChapter",
      }),
    );
  });

  test("landing target refuses a present chapter that no longer contains the position", async () => {
    const otherTree = buildChapterTree(["Nf3", "Nf6"]);
    const missingBoardState = getBoardState(
      getNodeAtPath(buildChapterTree(["d4", "d5", "c4"]).root, [0, 0, 0]).fen,
    );
    const originalRoot = treeStore.getState().root;
    mocks.loadFileGame.mockResolvedValueOnce({
      pgn: "1. Nf3 Nf6 *",
      stamp: otherTree.sourceStamp,
      revision: "rev-5",
      present: true,
      tree: otherTree,
    });

    await act(async () => root.render(renderOwner()));
    await act(async () => {
      await capturedSwitch!(1, { path: [0, 0, 0], boardState: missingBoardState });
    });

    expect(jotaiStore.get(currentTabAtom)?.gameOrigin).toMatchObject({ gameNumber: 0 });
    expect(treeStore.getState().root).toBe(originalRoot);
    expect(getFileFreshness(tabId)).toMatchObject({
      state: "verified",
      verifiedRevision: "rev-0",
    });
    expect(hasFileOpenInFlight("workspace-token-switch")).toBe(false);
    expect(mocks.notify).toHaveBeenCalledOnce();
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        color: "danger",
        title: "Common.Error",
        message: "Notation.TranspositionMissingInChapter",
      }),
    );
  });

  test("dirty tree prompts before a landing switch with no InfoPanel mounted, supporting Cancel, Discard, and Save", async () => {
    const targetTree = buildChapterTree(["d4", "d5", "c4"]);
    const landing: ChapterLandingTarget = {
      path: [0, 0, 0],
      boardState: getBoardState(getNodeAtPath(targetTree.root, [0, 0, 0]).fen),
    };
    mocks.loadFileGame.mockResolvedValue({
      pgn: "1. d4 d5 2. c4 *",
      stamp: targetTree.sourceStamp,
      revision: "rev-dirty",
      present: true,
      tree: targetTree,
    });

    await act(async () => root.render(renderOwner()));
    await act(async () => {
      treeStore.getState().setComment("unsaved opening edit");
    });
    expect(treeStore.getState().dirty).toBe(true);

    // 1. Cancel leaves the open chapter untouched and never loads.
    await act(async () => {
      await capturedSwitch!(1, landing);
    });
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
    expect(mocks.loadFileGame).not.toHaveBeenCalled();

    await act(async () => {
      modalButton("Tab.CloseWithoutSaving").dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(mocks.loadFileGame).not.toHaveBeenCalled();
    expect(jotaiStore.get(currentTabAtom)?.gameOrigin).toMatchObject({ gameNumber: 0 });

    // 2. Discard skips saving, loads the chapter, and lands on the target path.
    await act(async () => {
      await capturedSwitch!(1, landing);
    });
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
    await act(async () => modalButton("Tab.CloseWithoutSaving").click());
    expect(mocks.writeGame).not.toHaveBeenCalled();
    expect(mocks.loadFileGame).toHaveBeenCalledOnce();
    expect(jotaiStore.get(currentTabAtom)?.gameOrigin).toMatchObject({ gameNumber: 1 });
    expect(treeStore.getState().position).toEqual([0, 0, 0]);

    // 3. Save writes first, then loads the chapter and lands on the target path.
    const thirdTree = buildChapterTree(["c4", "e5"]);
    const thirdLanding: ChapterLandingTarget = {
      path: [0, 0],
      boardState: getBoardState(getNodeAtPath(thirdTree.root, [0, 0]).fen),
    };
    mocks.loadFileGame.mockResolvedValueOnce({
      pgn: "1. c4 e5 *",
      stamp: thirdTree.sourceStamp,
      revision: "rev-after-save",
      present: true,
      tree: thirdTree,
    });
    await act(async () => {
      treeStore.getState().setComment("unsaved edit");
    });
    expect(treeStore.getState().dirty).toBe(true);

    await act(async () => {
      await capturedSwitch!(2, thirdLanding);
    });
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
    await act(async () => modalButton("Tab.SaveAndClose").click());
    expect(mocks.writeGame).toHaveBeenCalledOnce();
    expect(jotaiStore.get(currentTabAtom)?.gameOrigin).toMatchObject({ gameNumber: 2 });
    expect(treeStore.getState().position).toEqual([0, 0]);
    expect(getFileFreshness(tabId)).toMatchObject({
      state: "verified",
      verifiedRevision: "rev-after-save",
    });
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  test("superseded landing switch does not notify, prompt, or install when its read resolves late", async () => {
    const firstRead = deferred<Awaited<ReturnType<typeof loadFileGame>>>();
    const secondRead = deferred<Awaited<ReturnType<typeof loadFileGame>>>();
    const secondTree = buildChapterTree(["c4", "e5"]);
    mocks.loadFileGame
      .mockReturnValueOnce(firstRead.promise)
      .mockReturnValueOnce(secondRead.promise);

    await act(async () => root.render(renderOwner()));
    let firstPromise!: Promise<void>;
    let secondPromise!: Promise<void>;
    await act(async () => {
      firstPromise = capturedSwitch!(1, {
        path: [0],
        boardState: "nonexistent-board-state",
      });
    });
    const firstSignal = mocks.loadFileGame.mock.calls[0][2] as AbortSignal;

    await act(async () => {
      secondPromise = capturedSwitch!(2);
    });
    expect(firstSignal.aborted).toBe(true);

    // Resolve the superseded first read while the second read is still pending (tree unchanged).
    await act(async () => {
      firstRead.resolve({
        pgn: "",
        stamp: "e".repeat(64),
        revision: "rev-stale",
        present: false,
        tree: defaultTree(),
      });
      await firstPromise;
    });

    expect(mocks.notify).not.toHaveBeenCalled();
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(jotaiStore.get(currentTabAtom)?.gameOrigin).toMatchObject({ gameNumber: 0 });

    await act(async () => {
      secondRead.resolve({
        pgn: "1. c4 e5 *",
        stamp: secondTree.sourceStamp!,
        revision: "rev-second",
        present: true,
        tree: secondTree,
      });
      await secondPromise;
    });

    expect(jotaiStore.get(currentTabAtom)?.gameOrigin).toMatchObject({ gameNumber: 2 });
    expect(treeStore.getState().root).toBe(secondTree.root);
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  test("non-landing switch whose read returns present:false with chapter < numGames marks freshness unavailable", async () => {
    const emptyTree = defaultTree();
    mocks.loadFileGame.mockResolvedValueOnce({
      pgn: "",
      stamp: emptyTree.sourceStamp,
      revision: "rev-missing",
      present: false,
      tree: emptyTree,
    });

    await act(async () => root.render(renderOwner()));
    await act(async () => {
      await capturedSwitch!(1);
    });

    expect(jotaiStore.get(currentTabAtom)?.gameOrigin).toMatchObject({ gameNumber: 1 });
    expect(treeStore.getState().root).toBe(emptyTree.root);
    expect(getFileFreshness(tabId).state).toBe("unavailable");
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  test("clears an open unsaved-changes confirmation when the owner changes", async () => {
    await act(async () => root.render(renderOwner()));
    await act(async () => {
      treeStore.getState().setComment("unsaved edit");
    });
    await act(async () => {
      await capturedSwitch!(1);
    });
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();

    const otherTabId = "44444444-4444-4444-8444-444444444444";
    const otherTab: Tab = {
      ...tab,
      value: otherTabId,
      name: "Other Tab",
    };
    const otherStore = createTreeStore(otherTabId, defaultTree());
    try {
      await act(async () => {
        jotaiStore.set(tabsAtom, [tab, otherTab]);
        jotaiStore.set(activeTabAtom, otherTabId);
        root.render(renderOwner(otherStore, otherTabId));
      });
      expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    } finally {
      closeTreeStore(otherTabId);
      removeFileFreshness(otherTabId);
    }
  });

  test("landing switch shows missing-in-chapter notice when read is refused and countPgnGames says the chapter is gone", async () => {
    mocks.useRealLoadFileGame = true;
    mocks.readGame.mockRejectedValueOnce(
      new TauriCommandError({
        tag: "backend-error",
        category: "invalid-input",
        message: "game index is out of bounds",
      }),
    );
    mocks.countPgnGames.mockResolvedValueOnce(2);
    const originalRoot = treeStore.getState().root;

    await act(async () => root.render(renderOwner()));
    await act(async () => {
      await capturedSwitch!(2, { path: [0], boardState: getBoardState(originalRoot.fen) });
    });

    expect(mocks.readGame).toHaveBeenCalledOnce();
    expect(mocks.countPgnGames).toHaveBeenCalledWith(
      tab.gameOrigin.kind === "file" ? tab.gameOrigin.file.handle : undefined,
      { signal: expect.any(AbortSignal) },
    );
    expect(jotaiStore.get(currentTabAtom)?.gameOrigin).toMatchObject({ gameNumber: 0 });
    expect(treeStore.getState().root).toBe(originalRoot);
    expect(getFileFreshness(tabId)).toMatchObject({
      state: "verified",
      verifiedRevision: "rev-0",
    });
    expect(hasFileOpenInFlight("workspace-token-switch")).toBe(false);
    expect(mocks.notify).toHaveBeenCalledOnce();
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        color: "danger",
        title: "Common.Error",
        message: "Notation.TranspositionMissingInChapter",
      }),
    );
  });

  test("landing switch uses the original error route when read fails with io/permission and chapter is still within count", async () => {
    mocks.useRealLoadFileGame = true;
    mocks.readGame.mockRejectedValueOnce(
      new TauriCommandError({
        tag: "backend-error",
        category: "permission",
        message: "permission denied",
      }),
    );
    mocks.countPgnGames.mockResolvedValueOnce(3);
    const originalRoot = treeStore.getState().root;

    await act(async () => root.render(renderOwner()));
    await act(async () => {
      await capturedSwitch!(1, { path: [0], boardState: getBoardState(originalRoot.fen) });
    });

    expect(mocks.countPgnGames).toHaveBeenCalledOnce();
    expect(jotaiStore.get(currentTabAtom)?.gameOrigin).toMatchObject({ gameNumber: 0 });
    expect(treeStore.getState().root).toBe(originalRoot);
    expect(hasFileOpenInFlight("workspace-token-switch")).toBe(false);
    expect(mocks.notify).toHaveBeenCalledOnce();
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        color: "danger",
        title: "Common.Error",
        message: "permission denied",
      }),
    );
  });

  test("landing switch routes a parse rejection with chapter within count through the existing error route", async () => {
    mocks.useRealLoadFileGame = true;
    mocks.readGame.mockResolvedValueOnce({
      pgn: "corrupt pgn",
      stamp: "f".repeat(64),
      revision: "rev-corrupt",
      present: true,
    });
    mocks.lexPgn.mockRejectedValueOnce(
      new TauriCommandError({
        tag: "backend-error",
        category: "parsing",
        message: "corrupt PGN payload",
      }),
    );
    mocks.countPgnGames.mockResolvedValueOnce(3);
    const originalRoot = treeStore.getState().root;

    await act(async () => root.render(renderOwner()));
    await act(async () => {
      await capturedSwitch!(1, { path: [0], boardState: getBoardState(originalRoot.fen) });
    });

    expect(mocks.readGame).toHaveBeenCalledOnce();
    expect(mocks.lexPgn).toHaveBeenCalledOnce();
    expect(mocks.countPgnGames).toHaveBeenCalledOnce();
    expect(jotaiStore.get(currentTabAtom)?.gameOrigin).toMatchObject({ gameNumber: 0 });
    expect(treeStore.getState().root).toBe(originalRoot);
    expect(hasFileOpenInFlight("workspace-token-switch")).toBe(false);
    expect(mocks.notify).toHaveBeenCalledOnce();
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        color: "danger",
        title: "Common.Error",
        message: "corrupt PGN payload",
      }),
    );
  });

  test("non-landing switch with a read refusal uses the existing error route and never calls countPgnGames", async () => {
    mocks.useRealLoadFileGame = true;
    mocks.readGame.mockRejectedValueOnce(
      new TauriCommandError({
        tag: "backend-error",
        category: "invalid-input",
        message: "game index is out of bounds",
      }),
    );
    const originalRoot = treeStore.getState().root;

    await act(async () => root.render(renderOwner()));
    await act(async () => {
      await capturedSwitch!(5);
    });

    expect(mocks.countPgnGames).not.toHaveBeenCalled();
    expect(jotaiStore.get(currentTabAtom)?.gameOrigin).toMatchObject({ gameNumber: 0 });
    expect(treeStore.getState().root).toBe(originalRoot);
    expect(mocks.notify).toHaveBeenCalledOnce();
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        color: "danger",
        title: "Common.Error",
        message: "game index is out of bounds",
      }),
    );
  });

  test("superseded landing request whose countPgnGames resolves late does not notify", async () => {
    mocks.useRealLoadFileGame = true;
    const staleCount = deferred<number>();
    const secondTree = buildChapterTree(["c4", "e5"]);
    mocks.readGame.mockRejectedValueOnce(
      new TauriCommandError({
        tag: "backend-error",
        category: "invalid-input",
        message: "game index is out of bounds",
      }),
    );
    mocks.countPgnGames.mockReturnValueOnce(staleCount.promise);

    await act(async () => root.render(renderOwner()));
    let firstPromise!: Promise<void>;
    await act(async () => {
      firstPromise = capturedSwitch!(5, { path: [0], boardState: "any-board-state" });
    });
    const firstSignal = mocks.countPgnGames.mock.calls[0][1].signal as AbortSignal;

    // Start a second switch that supersedes the first while countPgnGames is still pending.
    mocks.useRealLoadFileGame = false;
    mocks.loadFileGame.mockResolvedValueOnce({
      pgn: "1. c4 e5 *",
      stamp: secondTree.sourceStamp,
      revision: "rev-second",
      present: true,
      tree: secondTree,
    });
    await act(async () => {
      await capturedSwitch!(1);
    });
    expect(firstSignal.aborted).toBe(true);
    expect(jotaiStore.get(currentTabAtom)?.gameOrigin).toMatchObject({ gameNumber: 1 });

    await act(async () => {
      staleCount.resolve(2);
      await firstPromise;
    });

    expect(mocks.notify).not.toHaveBeenCalled();
    expect(jotaiStore.get(currentTabAtom)?.gameOrigin).toMatchObject({ gameNumber: 1 });
    expect(treeStore.getState().root).toBe(secondTree.root);
  });

  test("landing switch notifies with the original read error when countPgnGames rejects while current", async () => {
    mocks.useRealLoadFileGame = true;
    mocks.readGame.mockRejectedValueOnce(
      new TauriCommandError({
        tag: "backend-error",
        category: "io",
        message: "original read failure",
      }),
    );
    mocks.countPgnGames.mockRejectedValueOnce(
      new TauriCommandError({
        tag: "backend-error",
        category: "io",
        message: "count failure",
      }),
    );
    const originalRoot = treeStore.getState().root;

    await act(async () => root.render(renderOwner()));
    await act(async () => {
      await capturedSwitch!(2, { path: [0], boardState: getBoardState(originalRoot.fen) });
    });

    expect(mocks.countPgnGames).toHaveBeenCalledOnce();
    expect(jotaiStore.get(currentTabAtom)?.gameOrigin).toMatchObject({ gameNumber: 0 });
    expect(treeStore.getState().root).toBe(originalRoot);
    expect(hasFileOpenInFlight("workspace-token-switch")).toBe(false);
    expect(mocks.notify).toHaveBeenCalledOnce();
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        color: "danger",
        title: "Common.Error",
        message: "original read failure",
      }),
    );
  });

  test("superseded landing request whose countPgnGames rejects late does not notify", async () => {
    mocks.useRealLoadFileGame = true;
    const staleCount = deferred<number>();
    const secondTree = buildChapterTree(["c4", "e5"]);
    mocks.readGame.mockRejectedValueOnce(
      new TauriCommandError({
        tag: "backend-error",
        category: "io",
        message: "original read failure",
      }),
    );
    mocks.countPgnGames.mockReturnValueOnce(staleCount.promise);

    await act(async () => root.render(renderOwner()));
    let firstPromise!: Promise<void>;
    await act(async () => {
      firstPromise = capturedSwitch!(5, { path: [0], boardState: "any-board-state" });
    });
    const firstSignal = mocks.countPgnGames.mock.calls[0][1].signal as AbortSignal;

    mocks.useRealLoadFileGame = false;
    mocks.loadFileGame.mockResolvedValueOnce({
      pgn: "1. c4 e5 *",
      stamp: secondTree.sourceStamp,
      revision: "rev-second",
      present: true,
      tree: secondTree,
    });
    await act(async () => {
      await capturedSwitch!(1);
    });
    expect(firstSignal.aborted).toBe(true);

    await act(async () => {
      staleCount.reject(new Error("late count failure"));
      await firstPromise;
    });

    expect(mocks.notify).not.toHaveBeenCalled();
    expect(jotaiStore.get(currentTabAtom)?.gameOrigin).toMatchObject({ gameNumber: 1 });
    expect(treeStore.getState().root).toBe(secondTree.root);
  });

  test("landing switch uses the original error route when read rejects with invalid-input while chapter < count", async () => {
    mocks.useRealLoadFileGame = true;
    mocks.readGame.mockRejectedValueOnce(
      new TauriCommandError({
        tag: "backend-error",
        category: "invalid-input",
        message: "workspace entry is not persistent",
      }),
    );
    mocks.countPgnGames.mockResolvedValueOnce(3);
    const originalRoot = treeStore.getState().root;

    await act(async () => root.render(renderOwner()));
    await act(async () => {
      await capturedSwitch!(1, { path: [0], boardState: getBoardState(originalRoot.fen) });
    });

    expect(mocks.countPgnGames).toHaveBeenCalledOnce();
    expect(jotaiStore.get(currentTabAtom)?.gameOrigin).toMatchObject({ gameNumber: 0 });
    expect(treeStore.getState().root).toBe(originalRoot);
    expect(hasFileOpenInFlight("workspace-token-switch")).toBe(false);
    expect(mocks.notify).toHaveBeenCalledOnce();
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        color: "danger",
        title: "Common.Error",
        message: "workspace entry is not persistent",
      }),
    );
  });
});
