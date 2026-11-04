import { WorkspaceTabScope } from "@/state/tabScope";
import { getFileFreshness, removeFileFreshness, setFileFreshness } from "@/state/fileFreshness";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Provider as JotaiProvider, createStore as createJotaiStore } from "jotai";
import { MantineProvider } from "@mantine/core";
import { SWRConfig } from "swr";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import { closeTreeStore, createTreeStore, type TreeStore } from "@/state/store/tree";
import { tabStorage } from "@/state/store/tabStorage";
import { deserializeStorageValue } from "@/state/store/debouncedStorage";
import { getTabTreeKey } from "@/state/workspaceTypes";
import { loadWorkspace, WORKSPACE_STORAGE_KEY } from "@/state/workspace";
import { activeTabAtom, currentTabAtom, deckAtomFamily, tabsAtom } from "@/state/atoms";
import { afterFileStructureChange } from "@/state/fileStructureChange";
import * as practiceStorage from "@/state/practiceStorage";
import { cancellationError, TauriCommandError } from "@/platform/tauri";
import type { Tab } from "@/state/workspaceTypes";
import { defaultTree } from "@/utils/treeReducer";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { activeDatabaseViewStore } from "@/state/store/database";
import type { SuccessDatabaseInfo } from "@/utils/db";
import type { loadFileGame } from "@/utils/files";
import InfoPanel from "./InfoPanel";
import classes from "./InfoPanel.module.css";

const mocks = vi.hoisted(() => ({
  deleteGame: vi.fn(),
  deleteRejected: vi.fn(),
  loadFileGame: vi.fn(),
  writeGame: vi.fn(),
  readGames: vi.fn(),
  readGame: vi.fn(),
  lexPgn: vi.fn(),
  countPgnGames: vi.fn(),
  parsePGN: vi.fn(),
  notify: vi.fn(),
  logError: vi.fn(),
  beforeDelete: vi.fn(),
  getDatabases: vi.fn(),
  navigate: vi.fn(),
  useActualGameSelector: false,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
}));

vi.mock("@mantine/notifications", () => ({
  notifications: { show: mocks.notify },
}));

vi.mock("@/platform/native", () => ({
  platform: () => "linux",
  error: mocks.logError,
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
      deleteGame: mocks.deleteGame,
      readGames: mocks.readGames,
      readGame: mocks.readGame,
      lexPgn: mocks.lexPgn,
      countPgnGames: mocks.countPgnGames,
      writeGame: mocks.writeGame,
    },
  };
});

vi.mock("@/utils/chess", async () => {
  const actual = await vi.importActual<typeof import("@/utils/chess")>("@/utils/chess");
  return {
    ...actual,
    parsePGN: mocks.parsePGN,
  };
});
vi.mock("@/utils/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/db")>()),
  getDatabases: mocks.getDatabases,
}));
vi.mock("@/utils/files", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/files")>()),
  loadFileGame: mocks.loadFileGame,
}));

vi.mock("./GameSelector", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./GameSelector")>();
  return {
    ...actual,
    default: ({
      games,
      setGames,
      setPage,
      deleteGame,
      onActivate,
      ...actualProps
    }: {
      games: Map<number, { name: string; identity?: { stamp: string; revision: string } }>;
      setGames: React.Dispatch<
        React.SetStateAction<
          Map<number, { name: string; identity?: { stamp: string; revision: string } }>
        >
      >;
      setPage: (page: number) => Promise<void>;
      onActivate?: (page: number) => Promise<void>;
      deleteGame: (snapshot: { index: number; stamp: string; revision: string }) => Promise<void>;
      path: { id: { id: string }; kind: "fileWorkspace" };
      activePage: number;
      total: number;
    }) => {
      if (mocks.useActualGameSelector) {
        return (
          <actual.default
            games={games}
            setGames={setGames}
            setPage={setPage}
            onActivate={onActivate}
            deleteGame={deleteGame}
            {...actualProps}
          />
        );
      }
      return (
        <>
          <span data-testid="game-cache-size">{games.size}</span>
          <button type="button" data-testid="activate-page" onClick={() => void onActivate?.(1)}>
            Activate page
          </button>
          <button type="button" data-testid="set-page" onClick={() => void setPage(1)}>
            Set Page
          </button>
          <button
            type="button"
            data-testid="prime-games"
            onClick={() =>
              setGames(
                new Map([
                  [
                    1,
                    {
                      name: "Cached",
                      identity: { stamp: "selected-stamp", revision: "selected-revision" },
                    },
                  ],
                ]),
              )
            }
          >
            Prime games
          </button>
          <button
            type="button"
            data-testid="delete-game"
            onClick={() => {
              mocks.beforeDelete();
              void deleteGame({
                index: 1,
                stamp: "selected-stamp",
                revision: "selected-revision",
              }).catch(mocks.deleteRejected);
            }}
          >
            Delete game
          </button>
        </>
      );
    },
  };
});

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 30,
    getVirtualItems: () => (count > 0 ? [{ index: 0, size: 30, start: 0 }] : []),
  }),
}));

vi.mock("./FileInfo", () => ({
  default: () => <div data-testid="file-info" />,
}));

vi.mock("./FenSearch", () => ({
  default: () => <div data-testid="fen-search" />,
}));

vi.mock("./PgnInput", () => ({
  default: () => <div data-testid="pgn-input" />,
}));

vi.mock("@/components/common/GameInfo", () => ({
  default: () => <div data-testid="game-info" />,
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

installMatchMediaStub();

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = MockResizeObserver;

describe("InfoPanel game loading and cancellation", () => {
  let container: HTMLDivElement;
  let root: Root;
  let treeStore: TreeStore;
  let jotaiStore: ReturnType<typeof createJotaiStore>;

  const tabAId = "11111111-1111-4111-8111-111111111111";
  const tabA: Tab = {
    name: "Tab A",
    value: tabAId,
    type: "analysis",
    gameOrigin: {
      kind: "file",
      gameNumber: 0,
      file: {
        type: "file",
        handle: { id: { id: "workspace-token-a" }, kind: "fileWorkspace" },
        name: "games_a.pgn",
        numGames: 5,
        metadata: { type: "game", tags: [] },
        lastModified: 1,
      },
    },
  };

  const tabBId = "22222222-2222-4222-8222-222222222222";
  const tabB: Tab = {
    name: "Tab B",
    value: tabBId,
    type: "analysis",
    gameOrigin: {
      kind: "file",
      gameNumber: 0,
      file: {
        type: "file",
        handle: { id: { id: "workspace-token-b" }, kind: "fileWorkspace" },
        name: "games_b.pgn",
        numGames: 5,
        metadata: { type: "game", tags: [] },
        lastModified: 1,
      },
    },
  };

  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    activeDatabaseViewStore.getState().clearDatabase();
    sessionStorage.setItem(
      "workspace",
      JSON.stringify({ version: 1, tabs: [tabA, tabB], activeTab: tabAId }),
    );

    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    closeTreeStore(tabAId);
    tabStorage.seed(tabAId, defaultTree());
    treeStore = createTreeStore(tabAId, defaultTree());
    jotaiStore = createJotaiStore();
    jotaiStore.set(tabsAtom, [tabA, tabB]);
    jotaiStore.set(activeTabAtom, tabAId);

    mocks.readGames.mockReset();
    mocks.readGame.mockReset().mockImplementation(async () => ({
      pgn: "*",
      stamp: treeStore.getState().sourceStamp,
      present: true,
    }));
    mocks.lexPgn.mockReset().mockResolvedValue([{ type: "Outcome", value: "*" }]);
    mocks.readGames.mockResolvedValue([]);
    mocks.countPgnGames.mockReset().mockResolvedValue(5);
    mocks.loadFileGame.mockReset();
    mocks.loadFileGame.mockImplementation(async () => {
      const tree = defaultTree();
      tree.sourceStamp = "b".repeat(64);
      return { pgn: "fresh", stamp: tree.sourceStamp, revision: "r1", present: true, tree };
    });
    mocks.deleteGame.mockReset();
    mocks.deleteRejected.mockReset();
    mocks.parsePGN.mockReset();
    mocks.notify.mockReset();
    mocks.logError.mockReset().mockResolvedValue(undefined);
    mocks.beforeDelete.mockReset();
    mocks.getDatabases.mockReset().mockResolvedValue({
      databases: [],
      unread: [],
      root: { id: { id: "listing-test-root" }, kind: "databaseRoot" as const },
    });
    mocks.navigate.mockReset().mockResolvedValue(undefined);
    mocks.useActualGameSelector = false;
    mocks.writeGame
      .mockReset()
      .mockResolvedValue({ stamp: "c".repeat(64), revision: "saved-revision" });
    removeFileFreshness(tabAId);
    removeFileFreshness(tabBId);
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    container?.remove();
    closeTreeStore(tabAId);
    closeTreeStore(tabBId);
    activeDatabaseViewStore.getState().clearDatabase();
    mocks.useActualGameSelector = false;
    vi.restoreAllMocks();
    tabStorage.flush();
  });

  function refuseWorkspaceWrites() {
    const originalSetItem = Storage.prototype.setItem;
    return vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(function (this: Storage, key, value) {
        if (key === "workspace") throw new DOMException("quota", "QuotaExceededError");
        return originalSetItem.call(this, key, value);
      });
  }

  function refuseSecondWorkspaceWrite() {
    let workspaceWrites = 0;
    const originalSetItem = Storage.prototype.setItem;
    return vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(function (this: Storage, key, value) {
        if (key === "workspace" && ++workspaceWrites === 2) {
          throw new DOMException("quota", "QuotaExceededError");
        }
        return originalSetItem.call(this, key, value);
      });
  }

  async function primeAndDelete() {
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="prime-games"]')!.click();
    });
    expect(container.querySelector('[data-testid="game-cache-size"]')?.textContent).toBe("1");
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="delete-game"]')!.click();
      await Promise.resolve();
    });
  }

  async function openActualDeleteModal() {
    mocks.useActualGameSelector = true;
    mocks.readGames.mockResolvedValue([
      {
        pgn: '[Event "Selected game"]\n\n1. e4 *',
        stamp: "selected-stamp",
        revision: "selected-revision",
        present: true,
      },
    ]);
    mocks.parsePGN.mockResolvedValue({ headers: { event: "Selected game" } });
    await act(async () => root.render(renderPanel()));
    await vi.waitFor(() =>
      expect(container.querySelector('[aria-label="Files.RemoveGame"]')).not.toBeNull(),
    );
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Files.RemoveGame"]')!.click();
    });
    await vi.waitFor(() => expect(document.body.querySelector('[role="dialog"]')).not.toBeNull());
  }

  function actualDeleteConfirmButton() {
    return [...document.body.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Common.Delete",
    ) as HTMLButtonElement;
  }

  test.each(["tree", "workspace", "inactive"] as const)(
    "InfoPanel retains its strict current-owner error policy after admitted %s observer failure",
    async (subscriber) => {
      setFileFreshness(tabAId, "verified", { verifiedRevision: "original" });
      await act(async () => root.render(renderPanel()));
      const tree = defaultTree();
      tree.headers.event = "Admitted InfoPanel page";
      tree.sourceStamp = "b".repeat(64);
      mocks.loadFileGame.mockResolvedValueOnce({
        pgn: "admitted",
        stamp: tree.sourceStamp,
        revision: "admitted",
        present: true,
        tree,
      });
      let threw = false;
      const listener = () => {
        if (threw || treeStore.getState().sourceStamp !== tree.sourceStamp) return;
        threw = true;
        expect(jotaiStore.get(tabsAtom)[0]?.gameOrigin).toMatchObject({ gameNumber: 1 });
        if (subscriber === "inactive") jotaiStore.set(activeTabAtom, tabBId);
        throw new Error("InfoPanel admitted observer failed");
      };
      const unsubscribe =
        subscriber === "workspace"
          ? jotaiStore.sub(tabsAtom, listener)
          : treeStore.subscribe(listener);
      try {
        await act(async () =>
          container.querySelector<HTMLButtonElement>('[data-testid="set-page"]')!.click(),
        );
        expect(threw).toBe(true);
        const current = jotaiStore.get(tabsAtom)[0]!;
        expect(current.gameOrigin).toMatchObject({ gameNumber: 1 });
        expect(treeStore.getState()).toMatchObject(tree);
        expect(getTabTreeKey(current)).not.toBe(tabAId);
        expect(loadWorkspace(sessionStorage, WORKSPACE_STORAGE_KEY).tabs[0]).toEqual(current);
        expect(tabStorage.flush()).toEqual([]);
        expect(tabStorage.read(getTabTreeKey(current), true)?.state).toMatchObject(tree);
        expect(getFileFreshness(tabAId)).toMatchObject({
          state: "verified",
          verifiedRevision: "original",
        });
        expect(mocks.notify.mock.calls).toHaveLength(subscriber === "inactive" ? 0 : 1);
        expect(jotaiStore.get(activeTabAtom)).toBe(subscriber === "inactive" ? tabBId : tabAId);
      } finally {
        unsubscribe();
      }
    },
  );

  function renderPanel(store: TreeStore = treeStore) {
    const tabId = jotaiStore.get(activeTabAtom);
    if (tabId === null) throw new Error("Test workspace has no active tab");
    return (
      <MantineProvider env="test">
        <JotaiProvider store={jotaiStore}>
          <TreeStateContext.Provider value={store}>
            <WorkspaceTabScope tabId={tabId}>
              <InfoPanel />
            </WorkspaceTabScope>
          </TreeStateContext.Provider>
        </JotaiProvider>
      </MantineProvider>
    );
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

  function diskGame(): Awaited<ReturnType<typeof loadFileGame>> {
    const tree = defaultTree();
    tree.headers.event = "Replacement game";
    tree.sourceStamp = "d".repeat(64);
    return {
      pgn: "replacement",
      stamp: tree.sourceStamp,
      revision: "disk-revision",
      present: true,
      tree,
    };
  }

  async function openActualPageConfirmation() {
    mocks.useActualGameSelector = true;
    mocks.readGames.mockResolvedValue([
      { pgn: "selected", stamp: "selected-stamp", revision: "selected-revision", present: true },
    ]);
    mocks.parsePGN.mockResolvedValue({ headers: { event: "Selected" } });
    jotaiStore.set(tabsAtom, [
      { ...tabA, gameOrigin: { ...tabA.gameOrigin, gameNumber: 2 } } as Tab,
      tabB,
    ]);
    treeStore.getState().setSourceStamp("a".repeat(64));
    treeStore.getState().setComment("Unsaved original comment");
    await act(async () => root.render(renderPanel()));
    await activateActualRow();
    await expectPageConfirmation();
    expect(mocks.loadFileGame).not.toHaveBeenCalled();
  }

  async function activateActualRow() {
    const row = container.querySelector<HTMLElement>('[role="option"]')!;
    expect(row).not.toBeNull();
    await act(async () => {
      row.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
  }

  function modalButton(label: string) {
    const button = [
      ...document.body.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'),
    ].find((candidate) => candidate.textContent?.trim() === label);
    expect(button).toBeDefined();
    return button!;
  }

  async function discardActualPage() {
    await act(async () => modalButton("Tab.CloseWithoutSaving").click());
  }

  async function expectPageConfirmation() {
    await vi.waitFor(() =>
      expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain(
        "Tab.UnsavedChanges",
      ),
    );
  }

  function expectOriginalOrigin() {
    expect(jotaiStore.get(currentTabAtom)?.gameOrigin).toEqual({
      ...tabA.gameOrigin,
      gameNumber: 2,
    });
    expect(treeStore.getState().sourceStamp).toBe("a".repeat(64));
    expect(treeStore.getState().dirty).toBe(true);
    expect(jotaiStore.get(tabsAtom).map((tab) => tab.value)).toEqual([tabAId, tabBId]);
  }

  test("actual selector discard switches the current game after reading without clearing dirty early", async () => {
    const read = deferred<Awaited<ReturnType<typeof loadFileGame>>>();
    const replacement = diskGame();
    mocks.loadFileGame.mockReturnValueOnce(read.promise);
    await openActualPageConfirmation();
    const original = treeStore.getState();
    const dirtyStates: boolean[] = [];
    const unsubscribe = treeStore.subscribe((state) => dirtyStates.push(state.dirty));
    await discardActualPage();

    expect(mocks.loadFileGame).toHaveBeenCalledExactlyOnceWith(
      tabA.gameOrigin.kind === "file" ? tabA.gameOrigin.file.handle : null,
      0,
      expect.any(AbortSignal),
    );
    expect(treeStore.getState()).toBe(original);
    expectOriginalOrigin();
    expect(dirtyStates).toEqual([]);
    await act(async () => read.resolve(replacement));
    unsubscribe();

    expect(treeStore.getState().root).toBe(replacement.tree.root);
    expect(treeStore.getState().headers).toBe(replacement.tree.headers);
    expect(treeStore.getState()).toMatchObject({ dirty: false, sourceStamp: "d".repeat(64) });
    expect(dirtyStates).toEqual([false]);
    expect(jotaiStore.get(currentTabAtom)?.gameOrigin).toEqual(tabA.gameOrigin);
    expect(jotaiStore.get(tabsAtom).map((tab) => tab.value)).toEqual([tabAId, tabBId]);
    expect(getFileFreshness(tabAId)).toMatchObject({
      state: "verified",
      verifiedRevision: "disk-revision",
    });
    expect(mocks.notify).not.toHaveBeenCalled();
    const published = jotaiStore.get(currentTabAtom)!;
    const durable = deserializeStorageValue<{ state: ReturnType<typeof defaultTree> }>(
      sessionStorage.getItem(getTabTreeKey(published))!,
    );
    expect(durable?.state).toMatchObject({
      dirty: false,
      sourceStamp: "d".repeat(64),
      headers: { event: "Replacement game" },
    });
    expect(createTreeStore(tabAId)).toBe(treeStore);
    expect(tabStorage.flush()).toEqual([]);
    closeTreeStore(tabAId);
    const reloaded = loadWorkspace(sessionStorage, WORKSPACE_STORAGE_KEY);
    expect(reloaded.tabs.map((tab) => tab.value)).toEqual([tabAId, tabBId]);
    const recovered = createTreeStore(tabAId, undefined, getTabTreeKey(reloaded.tabs[0]!));
    expect(recovered.getState()).toMatchObject({
      dirty: false,
      sourceStamp: "d".repeat(64),
      headers: { event: "Replacement game" },
    });
  });

  test("actual selector discard preserves metadata committed during the pending page read", async () => {
    const read = deferred<Awaited<ReturnType<typeof loadFileGame>>>();
    mocks.loadFileGame.mockReturnValueOnce(read.promise);
    await openActualPageConfirmation();
    const original = treeStore.getState();
    await discardActualPage();
    expect(mocks.loadFileGame).toHaveBeenCalledOnce();
    const owner = jotaiStore.get(currentTabAtom)!;
    if (owner.gameOrigin.kind !== "file") throw new Error("expected file-backed owner");
    const refreshedFile = {
      ...owner.gameOrigin.file,
      numGames: 8,
      name: "Refreshed games.pgn",
      lastModified: 2,
      metadata: { type: "game" as const, tags: ["refreshed"] },
    };
    await act(async () => {
      expect(
        jotaiStore.set(currentTabAtom, {
          ...owner,
          gameOrigin: { ...owner.gameOrigin, file: refreshedFile },
        }),
      ).toBe(true);
    });
    expect(loadWorkspace(sessionStorage, WORKSPACE_STORAGE_KEY).tabs[0]?.gameOrigin).toEqual({
      ...owner.gameOrigin,
      file: refreshedFile,
    });
    expect(treeStore.getState()).toBe(original);
    await act(async () => read.resolve(diskGame()));

    const published = jotaiStore.get(currentTabAtom)!;
    expect(published.gameOrigin).toEqual({
      ...owner.gameOrigin,
      gameNumber: 0,
      file: refreshedFile,
    });
    expect(getTabTreeKey(published)).not.toBe(getTabTreeKey(owner));
    expect(jotaiStore.get(tabsAtom).map((tab) => tab.value)).toEqual([tabAId, tabBId]);
    expect(createTreeStore(tabAId)).toBe(treeStore);
    expect(treeStore.getState()).toMatchObject({
      dirty: false,
      sourceStamp: "d".repeat(64),
      headers: { event: "Replacement game" },
    });
    expect(loadWorkspace(sessionStorage, WORKSPACE_STORAGE_KEY).tabs[0]).toEqual(published);
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  test("actual page confirmation cancel retains the exact tree and file origin", async () => {
    await openActualPageConfirmation();
    const original = treeStore.getState();
    await act(async () => {
      modalButton("Tab.CloseWithoutSaving").dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(treeStore.getState()).toBe(original);
    expectOriginalOrigin();
    expect(mocks.loadFileGame).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(document.body.querySelector('[role="dialog"]')).toBeNull());
  });

  test.each(["header", "move", "comment"])(
    "a new %s edit during the authorized discard read requires fresh confirmation",
    async (edit) => {
      const read = deferred<Awaited<ReturnType<typeof loadFileGame>>>();
      mocks.loadFileGame.mockReturnValueOnce(read.promise);
      await openActualPageConfirmation();
      await discardActualPage();
      const accepted = treeStore.getState();
      await act(async () => {
        if (edit === "header")
          treeStore.getState().setHeaders({ ...accepted.headers, event: "New header" });
        else if (edit === "move")
          treeStore.getState().makeMove({ payload: "e4", changeHeaders: false });
        else treeStore.getState().setComment("New comment");
      });
      const newer = treeStore.getState();
      expect(newer.root === accepted.root).toBe(edit === "header");
      expect(
        edit === "header"
          ? newer.headers.event
          : edit === "move"
            ? newer.root.children[0].san
            : newer.root.comment,
      ).toBe(edit === "header" ? "New header" : edit === "move" ? "e4" : "New comment");
      await act(async () => read.resolve(diskGame()));

      expect(treeStore.getState()).toBe(newer);
      expectOriginalOrigin();
      await expectPageConfirmation();
      expect(mocks.loadFileGame).toHaveBeenCalledOnce();
    },
  );

  test("discard retains the dirty tree and origin when the workspace write refuses replacement", async () => {
    await openActualPageConfirmation();
    const original = treeStore.getState();
    refuseWorkspaceWrites();
    await discardActualPage();
    expect(mocks.loadFileGame).toHaveBeenCalledOnce();
    expect(treeStore.getState()).toBe(original);
    expectOriginalOrigin();
  });

  test("actual discard refuses the candidate tree before changing the current page and succeeds on retry", async () => {
    await openActualPageConfirmation();
    // Settle queued edits and read normalization before snapshotting the durable refusal baseline.
    expect(tabStorage.flush()).toEqual([]);
    const oldPending = tabStorage.readTree(tabAId);
    const oldBytes = sessionStorage.getItem(tabAId);
    const oldTree = treeStore.getState();
    const workspaceBytes = sessionStorage.getItem(WORKSPACE_STORAGE_KEY);
    const set = Storage.prototype.setItem;
    const refused = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(function (this: Storage, key, value) {
        if (key !== WORKSPACE_STORAGE_KEY && key !== tabAId && key !== tabBId)
          throw new DOMException("full", "QuotaExceededError");
        return set.call(this, key, value);
      });
    await discardActualPage();
    expectOriginalOrigin();
    expect(treeStore.getState()).toBe(oldTree);
    expect(tabStorage.readTree(tabAId)).toEqual(oldPending);
    expect(sessionStorage.getItem(tabAId)).toBe(oldBytes);
    expect(sessionStorage.getItem(WORKSPACE_STORAGE_KEY)).toBe(workspaceBytes);
    refused.mockRestore();
    await activateActualRow();
    await expectPageConfirmation();
    await discardActualPage();
    expect(jotaiStore.get(currentTabAtom)?.gameOrigin).toEqual(tabA.gameOrigin);
    expect(treeStore.getState().dirty).toBe(false);
  });

  test.each(["tab", "store", "Jotai before render"])(
    "a %s switch during discard load retains both owners",
    async (switchKind) => {
      const read = deferred<Awaited<ReturnType<typeof loadFileGame>>>();
      mocks.loadFileGame.mockReturnValueOnce(read.promise);
      await openActualPageConfirmation();
      const original = treeStore.getState();
      await discardActualPage();
      const signal = mocks.loadFileGame.mock.calls[0][2] as AbortSignal;
      const otherStore = createTreeStore(undefined, defaultTree());
      const otherOriginal = otherStore.getState();
      await act(async () => {
        if (switchKind !== "store") jotaiStore.set(activeTabAtom, tabBId);
        if (switchKind !== "Jotai before render") root.render(renderPanel(otherStore));
        if (switchKind === "Jotai before render") {
          read.resolve(diskGame());
          await read.promise;
        }
      });
      expect(signal.aborted).toBe(switchKind !== "Jotai before render");
      await act(async () => read.resolve(diskGame()));
      expect(treeStore.getState()).toBe(original);
      expect(otherStore.getState()).toBe(otherOriginal);
      expect(jotaiStore.get(tabsAtom).map((tab) => tab.gameOrigin)).toEqual([
        { ...tabA.gameOrigin, gameNumber: 2 },
        tabB.gameOrigin,
      ]);
      expect(mocks.loadFileGame).toHaveBeenCalledOnce();
    },
  );

  test.each(["active owner", "Jotai owner switch before React renders"])(
    "%s ordinary discard read rejection retains both exact trees and origins",
    async (owner) => {
      const read = deferred<Awaited<ReturnType<typeof loadFileGame>>>();
      mocks.loadFileGame.mockReturnValueOnce(read.promise);
      await openActualPageConfirmation();
      const original = treeStore.getState();
      const otherStore = createTreeStore(undefined, defaultTree());
      otherStore.getState().setSourceStamp("e".repeat(64));
      otherStore.getState().setComment("Other owner's unsaved comment");
      const otherOriginal = otherStore.getState();
      await discardActualPage();
      expect(mocks.loadFileGame).toHaveBeenCalledOnce();
      const signal = mocks.loadFileGame.mock.calls[0][2] as AbortSignal;

      await act(async () => {
        if (owner !== "active owner") jotaiStore.set(activeTabAtom, tabBId);
        read.reject(new Error("Ordinary page read failed"));
        await read.promise.catch(() => {});
        // The rejection has been consumed before React's owner cleanup can abort the read.
        expect(signal.aborted).toBe(false);
      });
      if (owner !== "active owner") {
        await act(async () => root.render(renderPanel(otherStore)));
      }

      expect(treeStore.getState()).toBe(original);
      expect(otherStore.getState()).toBe(otherOriginal);
      expect(jotaiStore.get(tabsAtom).map((tab) => tab.gameOrigin)).toEqual([
        { ...tabA.gameOrigin, gameNumber: 2 },
        tabB.gameOrigin,
      ]);
      expect(jotaiStore.get(currentTabAtom)?.value).toBe(
        owner === "active owner" ? tabAId : tabBId,
      );
      const expectedNotifications =
        owner === "active owner"
          ? [[{ color: "danger", title: "Common.Error", message: "Ordinary page read failed" }]]
          : [];
      expect(mocks.notify.mock.calls).toEqual(expectedNotifications);
      expect(mocks.logError).not.toHaveBeenCalled();
    },
  );

  test("switching Jotai owner before discard acceptance starts no read for either owner", async () => {
    await openActualPageConfirmation();
    const original = treeStore.getState();
    const discard = modalButton("Tab.CloseWithoutSaving");
    await act(async () => {
      jotaiStore.set(activeTabAtom, tabBId);
      discard.click();
    });
    expect(mocks.loadFileGame).not.toHaveBeenCalled();
    expect(treeStore.getState()).toBe(original);
    expect(jotaiStore.get(currentTabAtom)).toEqual(tabB);
    expect(jotaiStore.get(tabsAtom)[0].gameOrigin).toEqual({ ...tabA.gameOrigin, gameNumber: 2 });
  });

  test("a captured save continuation after unmount starts no page read", async () => {
    const write = deferred<{ stamp: string; revision: string }>();
    mocks.writeGame.mockReturnValueOnce(write.promise);
    await openActualPageConfirmation();
    await act(async () => modalButton("Tab.SaveAndClose").click());
    expect(mocks.writeGame).toHaveBeenCalledOnce();
    await act(async () => root.unmount());
    await act(async () => write.resolve({ stamp: "c".repeat(64), revision: "saved-revision" }));
    expect(mocks.loadFileGame).not.toHaveBeenCalled();
    expect(mocks.readGame).toHaveBeenCalledTimes(1);
    expect(jotaiStore.get(tabsAtom)[0].gameOrigin).toEqual({ ...tabA.gameOrigin, gameNumber: 2 });
  });

  test("save continuation remains unforced and retains fresh edits during its page read", async () => {
    const read = deferred<Awaited<ReturnType<typeof loadFileGame>>>();
    mocks.loadFileGame.mockReturnValueOnce(read.promise);
    await openActualPageConfirmation();
    await act(async () => modalButton("Tab.SaveAndClose").click());
    expect(mocks.writeGame).toHaveBeenCalledOnce();
    expect(mocks.loadFileGame).toHaveBeenCalledOnce();
    expect(treeStore.getState().dirty).toBe(false);
    expect(mocks.readGame).toHaveBeenCalledTimes(1);
    await act(async () => treeStore.getState().setComment("Edited after saving"));
    const newer = treeStore.getState();
    await act(async () => read.resolve(diskGame()));
    expect(treeStore.getState()).toBe(newer);
    expect(treeStore.getState()).toMatchObject({ dirty: true, sourceStamp: "c".repeat(64) });
    expect(jotaiStore.get(currentTabAtom)?.gameOrigin).toEqual({
      ...tabA.gameOrigin,
      gameNumber: 2,
    });
    await expectPageConfirmation();
  });

  test("a new dirty page request aborts the prior read before opening confirmation", async () => {
    const read = deferred<Awaited<ReturnType<typeof loadFileGame>>>();
    mocks.loadFileGame.mockReturnValueOnce(read.promise);
    await act(async () => root.render(renderPanel()));
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="set-page"]')!.click(),
    );
    const signal = mocks.loadFileGame.mock.calls[0][2] as AbortSignal;
    await act(async () => {
      treeStore.getState().setComment("New edit");
      container.querySelector<HTMLButtonElement>('[data-testid="activate-page"]')!.click();
    });
    expect(signal.aborted).toBe(true);
    const newer = treeStore.getState();
    await act(async () => read.resolve(diskGame()));
    expect(treeStore.getState()).toBe(newer);
    expect(jotaiStore.get(currentTabAtom)?.gameOrigin).toEqual(tabA.gameOrigin);
    await expectPageConfirmation();
    expect(mocks.loadFileGame).toHaveBeenCalledOnce();
  });

  test.each(["admitted", "refused"])(
    "the database card navigates only after admission is %s",
    async (admission) => {
      const database: SuccessDatabaseInfo = {
        type: "success",
        file: { id: { id: "info-database" }, kind: "database" },
        filename: "info-database.db3",
        title: "Info database",
        description: "Database card",
        player_count: 0,
        event_count: 0,
        game_count: 0,
        storage_size: "0",
        indexed: false,
      };
      mocks.getDatabases.mockResolvedValue({
        databases: [database],
        unread: [],
        root: { id: { id: "listing-test-root" }, kind: "databaseRoot" as const },
      });
      let resolveNavigation!: () => void;
      mocks.navigate.mockReturnValueOnce(
        new Promise<void>((resolve) => {
          resolveNavigation = resolve;
        }),
      );
      const previous = {
        ...database,
        title: "Previous",
        file: { id: { id: "previous" }, kind: "database" as const },
      };
      activeDatabaseViewStore.getState().setDatabase(previous);
      const before = activeDatabaseViewStore.getState();
      const seeded = JSON.stringify({ state: before, version: 0 });
      sessionStorage.setItem("database-view", seeded);
      jotaiStore.set(tabsAtom, [
        {
          ...tabA,
          gameOrigin: { kind: "database", database: database.file, gameId: 1 },
        },
      ]);
      await act(async () =>
        root.render(
          <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
            {renderPanel()}
          </SWRConfig>,
        ),
      );
      await vi.waitFor(() =>
        expect(container.querySelector(`.${classes.databaseCard}`)).not.toBeNull(),
      );

      const nativeSetItem = Storage.prototype.setItem;
      const setItem = vi
        .spyOn(Storage.prototype, "setItem")
        .mockImplementation(function (this: Storage, key, value) {
          if (admission === "refused" && this === sessionStorage && key === "database-view") {
            expect(activeDatabaseViewStore.getState()).toBe(before);
            expect(sessionStorage.getItem(key)).toBe(seeded);
            throw new DOMException("quota", "QuotaExceededError");
          }
          return nativeSetItem.call(this, key, value);
        });
      const stop = activeDatabaseViewStore.subscribe(() => {
        expect(mocks.navigate).not.toHaveBeenCalled();
      });
      try {
        await act(async () =>
          container.querySelector<HTMLElement>(`.${classes.databaseCard}`)!.click(),
        );
        expect(mocks.navigate.mock.calls).toEqual(
          admission === "refused"
            ? []
            : [
                [
                  {
                    to: "/databases/$databaseId",
                    params: { databaseId: "info-database" },
                  },
                ],
              ],
        );
        expect(activeDatabaseViewStore.getState() === before).toBe(admission === "refused");
        expect(sessionStorage.getItem("database-view") === seeded).toBe(admission === "refused");
        expect(mocks.notify).toHaveBeenCalledTimes(admission === "refused" ? 1 : 0);
        expect(activeDatabaseViewStore.getState().database).toEqual(
          admission === "refused" ? previous : database,
        );

        await act(async () => resolveNavigation());
        expect(activeDatabaseViewStore.getState().database).toEqual(
          admission === "refused" ? previous : database,
        );
      } finally {
        stop();
        setItem.mockRestore();
      }
    },
  );

  test("successful setPage loads game and updates tab and tree state", async () => {
    const mockTree = defaultTree();
    mockTree.sourceStamp = "b".repeat(64);
    mocks.loadFileGame.mockResolvedValueOnce({
      pgn: "1. e4 e5 *",
      stamp: mockTree.sourceStamp,
      revision: "r2",
      present: true,
      tree: mockTree,
    });

    await act(async () => {
      root.render(renderPanel());
    });

    const setPageBtn = container.querySelector<HTMLButtonElement>('[data-testid="set-page"]')!;
    await act(async () => {
      setPageBtn.click();
    });

    const fileAHandle = tabA.gameOrigin.kind === "file" ? tabA.gameOrigin.file.handle : null;
    expect(mocks.loadFileGame).toHaveBeenCalledWith(fileAHandle, 1, expect.any(AbortSignal));

    const updatedTab = jotaiStore.get(currentTabAtom);
    expect(updatedTab?.gameOrigin).toMatchObject({ kind: "file", gameNumber: 1 });
    expect(mocks.notify).not.toHaveBeenCalled();
    // The page was just read, so the tab starts verified at that revision without a second read.
    expect(getFileFreshness(tabA.value)).toMatchObject({
      state: "verified",
      verifiedRevision: "r2",
    });
  });

  test("explicit row activation uses guarded current-tab replacement, never tab creation", async () => {
    await act(async () => root.render(renderPanel()));
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="activate-page"]')!.click(),
    );
    expect(mocks.loadFileGame).toHaveBeenCalledOnce();
    expect(jotaiStore.get(currentTabAtom)?.gameOrigin).toMatchObject({
      kind: "file",
      gameNumber: 1,
    });
    expect(jotaiStore.get(tabsAtom).map((tab) => tab.value)).toEqual([tabAId, tabBId]);
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  test.each(["double-click", "Enter"])(
    "real selector %s retains unsaved-change protection",
    async (gesture) => {
      mocks.useActualGameSelector = true;
      mocks.readGames.mockResolvedValue([
        { pgn: "selected", stamp: "s", revision: "r", present: true },
      ]);
      mocks.parsePGN.mockResolvedValue({ headers: { event: "Selected" } });
      treeStore.getState().setComment("Unsaved edit");
      await act(async () => root.render(renderPanel()));
      const row = container.querySelector<HTMLElement>('[role="option"]')!;
      expect(row).not.toBeNull();
      await act(async () => {
        row.dispatchEvent(
          gesture === "Enter"
            ? new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
            : new MouseEvent("dblclick", { bubbles: true }),
        );
      });
      await vi.waitFor(() =>
        expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain(
          "Tab.UnsavedChanges",
        ),
      );
      expect(mocks.loadFileGame).not.toHaveBeenCalled();
      expect(treeStore.getState().root.comment).toBe("Unsaved edit");
      expect(jotaiStore.get(tabsAtom).map((tab) => tab.value)).toEqual([tabAId, tabBId]);
    },
  );

  test("setPage leaves metadata and tree unchanged when the workspace write is refused", async () => {
    const setState = vi.spyOn(treeStore.getState(), "setState");
    const nextTree = defaultTree();
    nextTree.headers.event = "Next tree";
    nextTree.sourceStamp = "b".repeat(64);
    mocks.loadFileGame.mockResolvedValueOnce({
      pgn: "1. e4 e5 *",
      stamp: nextTree.sourceStamp,
      revision: "r2",
      present: true,
      tree: nextTree,
    });
    refuseWorkspaceWrites();
    await act(async () => root.render(renderPanel()));

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="set-page"]')!.click();
    });

    expect(jotaiStore.get(currentTabAtom)?.gameOrigin).toMatchObject({ gameNumber: 0 });
    expect(setState).not.toHaveBeenCalled();
  });

  test("setPage does not replace an edit made while the fresh file read is pending", async () => {
    let resolveLoad!: (value: {
      pgn: string;
      stamp: string;
      revision: string;
      present: boolean;
      tree: ReturnType<typeof defaultTree>;
    }) => void;
    mocks.loadFileGame.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveLoad = resolve;
      }),
    );
    await act(async () => root.render(renderPanel()));

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="set-page"]')!.click();
    });
    await act(async () => {
      treeStore.getState().setComment("Edit made during file read");
    });
    const loadedTree = defaultTree();
    loadedTree.headers.event = "Disk version";
    const loadedStamp = "d".repeat(64);
    loadedTree.sourceStamp = loadedStamp;
    await act(async () => {
      resolveLoad({
        pgn: "fresh disk game",
        stamp: loadedStamp,
        revision: "r5",
        present: true,
        tree: loadedTree,
      });
    });

    expect(jotaiStore.get(currentTabAtom)?.gameOrigin).toMatchObject({ gameNumber: 0 });
    expect(treeStore.getState()).toMatchObject({ dirty: true, sourceStamp: null });
    expect(treeStore.getState().root.comment).toBe("Edit made during file read");
  });

  test("delete refuses native mutation and cache clearing when metadata cannot be saved", async () => {
    mocks.deleteGame.mockResolvedValue(undefined);
    await act(async () => root.render(renderPanel()));
    refuseWorkspaceWrites();

    await primeAndDelete();

    expect(mocks.deleteGame).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="game-cache-size"]')?.textContent).toBe("1");
    expect(jotaiStore.get(currentTabAtom)?.gameOrigin).toMatchObject({
      file: { numGames: 5 },
    });
  });

  test("a local count mismatch clears cached rows and refreshes without invoking native delete", async () => {
    mocks.countPgnGames.mockResolvedValueOnce(7);
    mocks.beforeDelete.mockImplementation(() => {
      jotaiStore.set(tabsAtom, (tabs) =>
        tabs.map((tab) =>
          tab.value === tabAId && tab.gameOrigin.kind === "file"
            ? {
                ...tab,
                gameOrigin: {
                  ...tab.gameOrigin,
                  file: { ...tab.gameOrigin.file, numGames: 6 },
                },
              }
            : tab,
        ),
      );
    });
    await act(async () => root.render(renderPanel()));

    await primeAndDelete();
    await vi.waitFor(() =>
      expect(jotaiStore.get(currentTabAtom)?.gameOrigin).toMatchObject({
        file: { numGames: 7 },
      }),
    );

    const handle = tabA.gameOrigin.kind === "file" ? tabA.gameOrigin.file.handle : null;
    expect(mocks.deleteGame).not.toHaveBeenCalled();
    expect(mocks.countPgnGames).toHaveBeenCalledWith(handle, { signal: expect.any(AbortSignal) });
    expect(container.querySelector('[data-testid="game-cache-size"]')?.textContent).toBe("0");
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Common.Error", message: "Files.RemoveGameStale" }),
    );
    expect(mocks.deleteRejected).not.toHaveBeenCalled();
  });

  test("a workspace write refusal stays visible in the real delete confirmation modal", async () => {
    await openActualDeleteModal();
    refuseWorkspaceWrites();

    await act(async () => actualDeleteConfirmButton().click());

    expect(mocks.deleteGame).not.toHaveBeenCalled();
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.body.querySelector('[role="alert"]')?.textContent).toBe(
      "Common.ConfirmationError.unexpected",
    );
    expect(jotaiStore.get(currentTabAtom)?.gameOrigin).toMatchObject({ file: { numGames: 5 } });
  });

  test("a post-delete workspace write refusal reports an applied outcome in the real modal", async () => {
    mocks.deleteGame.mockResolvedValueOnce(undefined);
    await openActualDeleteModal();
    const storageWrites = refuseSecondWorkspaceWrite();
    const readsBeforeDelete = mocks.readGames.mock.calls.length;

    await act(async () => actualDeleteConfirmButton().click());
    await vi.waitFor(() =>
      expect(document.body.querySelector('[role="alert"]')?.textContent).toBe(
        "Common.ConfirmationError.applied-despite-error",
      ),
    );
    await vi.waitFor(() =>
      expect(mocks.readGames.mock.calls.length).toBeGreaterThan(readsBeforeDelete),
    );

    expect(mocks.deleteGame).toHaveBeenCalledOnce();
    expect(storageWrites.mock.calls.filter(([key]) => key === "workspace")).toHaveLength(2);
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.body.querySelector('[role="alert"]')?.textContent).not.toMatch(/try again/i);
    expect(jotaiStore.get(currentTabAtom)?.gameOrigin).toMatchObject({ file: { numGames: 4 } });
  });

  test("the real confirmation modal handles InfoPanel's native stale refusal", async () => {
    const stale = new TauriCommandError({
      tag: "backend-error",
      category: "stale-game",
      message: "stale game",
    });
    mocks.deleteGame.mockRejectedValueOnce(stale);
    mocks.countPgnGames.mockResolvedValueOnce(6);
    await openActualDeleteModal();

    await act(async () => actualDeleteConfirmButton().click());
    await vi.waitFor(() => expect(document.body.querySelector('[role="dialog"]')).toBeNull());
    await vi.waitFor(() =>
      expect(jotaiStore.get(currentTabAtom)?.gameOrigin).toMatchObject({ file: { numGames: 6 } }),
    );

    const handle = tabA.gameOrigin.kind === "file" ? tabA.gameOrigin.file.handle : null;
    expect(mocks.deleteGame).toHaveBeenCalledWith(handle, 0, "selected-stamp", "selected-revision");
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Common.Error", message: "Files.RemoveGameStale" }),
    );
    expect(mocks.deleteRejected).not.toHaveBeenCalled();
  });

  test("delete restores the captured count and retains cache when native deletion rejects", async () => {
    const failure = new Error("delete failed");
    let rejectDelete!: (error: unknown) => void;
    mocks.deleteGame.mockReturnValueOnce(
      new Promise((_, reject) => {
        rejectDelete = reject;
      }),
    );
    await act(async () => root.render(renderPanel()));

    await primeAndDelete();
    await act(async () => {
      jotaiStore.set(tabsAtom, (tabs) =>
        tabs.map((tab) =>
          tab.value === tabAId && tab.gameOrigin.kind === "file"
            ? { ...tab, name: "Concurrent title", gameOrigin: { ...tab.gameOrigin, gameNumber: 2 } }
            : tab,
        ),
      );
      rejectDelete(failure);
      await Promise.resolve();
    });

    expect(mocks.deleteGame).toHaveBeenCalledOnce();
    expect(jotaiStore.get(currentTabAtom)).toMatchObject({
      name: "Concurrent title",
      gameOrigin: { gameNumber: 2, file: { numGames: 5 } },
    });
    expect(container.querySelector('[data-testid="game-cache-size"]')?.textContent).toBe("1");
    expect(mocks.deleteRejected).toHaveBeenCalledWith(failure);
  });

  test("typed stale delete refusal rolls back, clears rows, notifies, and refreshes the count", async () => {
    const stale = new TauriCommandError({
      tag: "backend-error",
      category: "stale-game",
      message: "stale game",
    });
    mocks.deleteGame.mockRejectedValueOnce(stale);
    mocks.countPgnGames.mockImplementationOnce(async () => {
      expect(jotaiStore.get(currentTabAtom)?.gameOrigin).toMatchObject({
        file: { numGames: 5 },
      });
      return 6;
    });
    await act(async () => root.render(renderPanel()));

    await primeAndDelete();
    await act(async () => Promise.resolve());

    const handle = tabA.gameOrigin.kind === "file" ? tabA.gameOrigin.file.handle : null;
    expect(mocks.deleteGame).toHaveBeenCalledWith(handle, 1, "selected-stamp", "selected-revision");
    expect(mocks.deleteRejected).not.toHaveBeenCalled();
    expect(jotaiStore.get(currentTabAtom)?.gameOrigin).toMatchObject({
      file: { numGames: 6 },
    });
    expect(container.querySelector('[data-testid="game-cache-size"]')?.textContent).toBe("0");
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Common.Error", message: "Files.RemoveGameStale" }),
    );
  });

  test("failed stale count refresh keeps the rollback count and reports its error", async () => {
    const stale = new TauriCommandError({
      tag: "backend-error",
      category: "stale-game",
      message: "stale game",
    });
    mocks.deleteGame.mockRejectedValueOnce(stale);
    mocks.countPgnGames.mockRejectedValueOnce(new Error("count refresh failed"));
    await act(async () => root.render(renderPanel()));

    await primeAndDelete();
    await vi.waitFor(() => expect(mocks.notify).toHaveBeenCalledTimes(2));

    expect(jotaiStore.get(currentTabAtom)?.gameOrigin).toMatchObject({
      file: { numGames: 5 },
    });
    expect(mocks.notify).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: "Common.Error", message: "count refresh failed" }),
    );
    expect(mocks.deleteRejected).not.toHaveBeenCalled();
  });

  test("committed but uncertain deletion keeps the predicted count and refreshes without hiding the error", async () => {
    const uncertain = new TauriCommandError({
      tag: "backend-error",
      category: "durability",
      message: "Committed but durability uncertain: PGN edit",
    });
    mocks.deleteGame.mockRejectedValueOnce(uncertain);
    mocks.countPgnGames.mockResolvedValueOnce(4);
    await act(async () => root.render(renderPanel()));

    await primeAndDelete();
    await vi.waitFor(() =>
      expect(jotaiStore.get(currentTabAtom)?.gameOrigin).toMatchObject({
        file: { numGames: 4 },
      }),
    );

    expect(container.querySelector('[data-testid="game-cache-size"]')?.textContent).toBe("0");
    expect(mocks.deleteRejected).toHaveBeenCalledWith(uncertain);
  });

  test("stale count refresh cannot update an owner after switching tabs", async () => {
    const stale = new TauriCommandError({
      tag: "backend-error",
      category: "stale-game",
      message: "stale game",
    });
    let resolveCount!: (count: number) => void;
    mocks.deleteGame.mockRejectedValueOnce(stale);
    mocks.countPgnGames.mockImplementationOnce(
      (_handle: unknown, options?: { signal?: AbortSignal }) => {
        return new Promise<number>((resolve) => {
          resolveCount = resolve;
          expect(options?.signal).toBeInstanceOf(AbortSignal);
        });
      },
    );
    await act(async () => root.render(renderPanel()));
    await primeAndDelete();

    const treeStoreB = createTreeStore(tabBId, defaultTree());
    await act(async () => {
      jotaiStore.set(activeTabAtom, tabBId);
      root.render(renderPanel(treeStoreB));
    });
    await act(async () => {
      resolveCount(99);
      await Promise.resolve();
    });

    expect(jotaiStore.get(tabsAtom)).toMatchObject([
      { value: tabAId, gameOrigin: { file: { numGames: 5 } } },
      { value: tabBId, gameOrigin: { file: { numGames: 5 } } },
    ]);
    expect(jotaiStore.get(activeTabAtom)).toBe(tabBId);
  });

  test("stale count refresh cannot update an owner closed while the count is pending", async () => {
    const stale = new TauriCommandError({
      tag: "backend-error",
      category: "stale-game",
      message: "stale game",
    });
    let resolveCount!: (count: number) => void;
    let capturedSignal!: AbortSignal;
    mocks.deleteGame.mockRejectedValueOnce(stale);
    mocks.countPgnGames.mockImplementationOnce(
      (_handle: unknown, options?: { signal?: AbortSignal }) => {
        capturedSignal = options!.signal!;
        return new Promise<number>((resolve) => {
          resolveCount = resolve;
        });
      },
    );
    await act(async () => root.render(renderPanel()));
    await primeAndDelete();

    await act(async () => {
      jotaiStore.set(tabsAtom, [tabB], tabBId);
      root.render(renderPanel(createTreeStore(undefined, defaultTree())));
    });
    expect(capturedSignal.aborted).toBe(true);
    await act(async () => {
      resolveCount(99);
      await Promise.resolve();
    });

    expect(jotaiStore.get(tabsAtom)).toEqual([tabB]);
    expect(jotaiStore.get(activeTabAtom)).toBe(tabBId);
  });

  test("delete does not resurrect a captured owner closed before native rejection", async () => {
    let rejectDelete!: (error: unknown) => void;
    mocks.deleteGame.mockReturnValueOnce(
      new Promise((_, reject) => {
        rejectDelete = reject;
      }),
    );
    await act(async () => root.render(renderPanel()));
    await primeAndDelete();

    await act(async () => {
      jotaiStore.set(tabsAtom, [tabB], tabBId);
      root.render(renderPanel(createTreeStore(undefined, defaultTree())));
      rejectDelete(new Error("delete failed"));
      await Promise.resolve();
    });

    expect(jotaiStore.get(tabsAtom)).toEqual([tabB]);
    expect(jotaiStore.get(activeTabAtom)).toBe(tabBId);
    expect(mocks.deleteRejected).toHaveBeenCalledOnce();
  });

  test("successful delete keeps the decremented count and clears its cache", async () => {
    mocks.deleteGame.mockResolvedValueOnce(undefined);
    await act(async () => root.render(renderPanel()));

    await primeAndDelete();

    expect(jotaiStore.get(currentTabAtom)?.gameOrigin).toMatchObject({
      file: { numGames: 4 },
    });
    expect(container.querySelector('[data-testid="game-cache-size"]')?.textContent).toBe("0");
    expect(mocks.deleteRejected).not.toHaveBeenCalled();
  });

  test.each([
    ["success", undefined, true, false],
    ["native error", new Error("delete failed"), false, false],
    [
      "stale refusal",
      new TauriCommandError({ tag: "backend-error", category: "stale-game", message: "stale" }),
      false,
      false,
    ],
    [
      "committed uncertainty",
      new TauriCommandError({ tag: "backend-error", category: "durability", message: "uncertain" }),
      true,
      false,
    ],
    [
      "applied-despite-error",
      { category: "applied-despite-error", message: "installed" },
      true,
      false,
    ],
    ["post-delete metadata refusal", undefined, true, true],
    ["rollback metadata refusal", new Error("delete failed"), false, true],
  ] as const)(
    "%s releases practice waiters after reconciling tabs and invalidating installed outcomes",
    async (_name, error, installed, refuseMetadata) => {
      const clearFailures = vi.spyOn(practiceStorage, "clearPracticeFileMigrationFailures");
      const deletion = deferred<void>();
      mocks.deleteGame.mockReturnValueOnce(deletion.promise);
      await act(async () => root.render(renderPanel()));
      const before = [0, 1, 9].map((game) => deckAtomFamily({ file: "workspace-token-a", game }));
      const other = deckAtomFamily({ file: "workspace-token-b", game: 0 });
      const initialFreshness = getFileFreshness(tabAId).state;
      if (refuseMetadata) refuseSecondWorkspaceWrite();
      await primeAndDelete();
      expect(mocks.deleteGame).toHaveBeenCalledOnce();
      const resumed = vi.fn(async () => ({
        failureClearCalls: clearFailures.mock.calls.slice(),
        decks: [0, 1, 9].map((game) => deckAtomFamily({ file: "workspace-token-a", game })),
        freshness: getFileFreshness(tabAId).state,
        origin: jotaiStore.get(currentTabAtom)?.gameOrigin,
      }));
      const waiting = afterFileStructureChange("workspace-token-a", resumed);
      await Promise.resolve();
      expect(resumed).not.toHaveBeenCalled();

      await act(async () => {
        if (error) deletion.reject(error);
        else deletion.resolve();
        await waiting;
      });

      expect(resumed).toHaveBeenCalledOnce();
      const observed = await waiting;
      expect(observed.failureClearCalls).toEqual(installed ? [["workspace-token-a"]] : []);
      clearFailures.mockRestore();
      observed.decks.forEach((deck, index) => {
        expect(deck === before[index]).toBe(!installed);
      });
      expect(deckAtomFamily({ file: "workspace-token-b", game: 0 })).toBe(other);
      const expectedFreshness = installed
        ? error || refuseMetadata
          ? "conflict"
          : "unverified"
        : initialFreshness;
      const expectedCount = error && !refuseMetadata ? 5 : 4;
      expect(observed.freshness).toBe(expectedFreshness);
      expect(observed.origin).toMatchObject({ file: { numGames: expectedCount } });
      await expect(
        afterFileStructureChange("workspace-token-a", async () => "released"),
      ).resolves.toBe("released");
    },
  );

  test("a renderer exception after native success invalidates decks and releases the barrier", async () => {
    const deletion = deferred<void>();
    mocks.deleteGame.mockReturnValueOnce(deletion.promise);
    await act(async () => root.render(renderPanel()));
    const before = deckAtomFamily({ file: "workspace-token-a", game: 0 });
    await primeAndDelete();
    const resumed = vi.fn(async () => ({
      deck: deckAtomFamily({ file: "workspace-token-a", game: 0 }),
      freshness: getFileFreshness(tabAId).state,
    }));
    const waiting = afterFileStructureChange("workspace-token-a", resumed);
    const unsubscribe = jotaiStore.sub(tabsAtom, () => {
      throw new Error("post-delete workspace observer failed");
    });
    try {
      await act(async () => {
        deletion.resolve();
        await waiting;
      });
      expect(resumed).toHaveBeenCalledOnce();
      expect((await waiting).deck).not.toBe(before);
      expect((await waiting).freshness).toBe("conflict");
      expect(mocks.deleteRejected).toHaveBeenCalledOnce();
    } finally {
      unsubscribe();
    }
  });

  test("an applied-error barrier spans the count refresh even when that refresh fails", async () => {
    const deletion = deferred<void>();
    const count = deferred<number>();
    mocks.deleteGame.mockReturnValueOnce(deletion.promise);
    mocks.countPgnGames.mockReturnValueOnce(count.promise);
    await act(async () => root.render(renderPanel()));
    const before = deckAtomFamily({ file: "workspace-token-a", game: 0 });
    await primeAndDelete();
    const resumed = vi.fn().mockResolvedValue(null);
    const waiting = afterFileStructureChange("workspace-token-a", resumed);
    await act(async () => {
      deletion.reject({ category: "applied-despite-error", message: "installed" });
    });
    expect(mocks.countPgnGames).toHaveBeenCalledOnce();
    expect(getFileFreshness(tabAId).state).toBe("conflict");
    expect(resumed).not.toHaveBeenCalled();
    await act(async () => {
      count.reject(new Error("count refresh failed"));
      await waiting;
    });
    expect(resumed).toHaveBeenCalledOnce();
    expect(deckAtomFamily({ file: "workspace-token-a", game: 0 })).not.toBe(before);
    expect(mocks.deleteRejected).toHaveBeenCalledWith({
      category: "applied-despite-error",
      message: "installed",
    });
  });

  test("successful delete updates same-file tabs and shifts only later game numbers", async () => {
    const ownerOrigin = tabA.gameOrigin;
    if (ownerOrigin.kind !== "file") throw new Error("Test tab must be file-backed");
    const owner = {
      ...tabA,
      gameOrigin: { ...ownerOrigin, gameNumber: 4 },
    } as Tab;
    const siblingAfter: Tab = {
      ...owner,
      value: "33333333-3333-4333-8333-333333333333",
      gameOrigin: { ...ownerOrigin, gameNumber: 2 },
    };
    const siblingAtRemovedIndex: Tab = {
      ...owner,
      value: "44444444-4444-4444-8444-444444444444",
      gameOrigin: { ...ownerOrigin, gameNumber: 1 },
    };
    const siblingBefore: Tab = {
      ...owner,
      value: "55555555-5555-4555-8555-555555555555",
      gameOrigin: { ...ownerOrigin, gameNumber: 0 },
    };
    mocks.deleteGame.mockResolvedValueOnce(undefined);
    jotaiStore.set(tabsAtom, [owner, siblingAfter, siblingAtRemovedIndex, siblingBefore, tabB]);
    jotaiStore.set(activeTabAtom, tabAId);
    await act(async () => root.render(renderPanel()));

    await primeAndDelete();

    const tabs = jotaiStore.get(tabsAtom);
    expect(tabs.map((tab) => tab.gameOrigin)).toMatchObject([
      { kind: "file", gameNumber: 3, file: { numGames: 4 } },
      { kind: "file", gameNumber: 1, file: { numGames: 4 } },
      { kind: "file", gameNumber: 1, file: { numGames: 4 } },
      { kind: "file", gameNumber: 0, file: { numGames: 4 } },
      { kind: "file", gameNumber: 0, file: { numGames: 5 } },
    ]);
  });

  test("successful delete leaves a same-file tab opened during the native call at its current index", async () => {
    const ownerOrigin = tabA.gameOrigin;
    if (ownerOrigin.kind !== "file") throw new Error("Test tab must be file-backed");
    let resolveDelete!: () => void;
    mocks.deleteGame.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveDelete = resolve;
      }),
    );
    await act(async () => root.render(renderPanel()));
    await primeAndDelete();

    const openedDuringDeleteId = "66666666-6666-4666-8666-666666666666";
    const openedDuringDelete: Tab = {
      ...tabA,
      value: openedDuringDeleteId,
      gameOrigin: {
        ...ownerOrigin,
        gameNumber: 3,
        file: { ...ownerOrigin.file, numGames: 4 },
      },
    };
    await act(async () => {
      jotaiStore.set(tabsAtom, (tabs) => [...tabs, openedDuringDelete]);
    });
    await act(async () => {
      resolveDelete();
      await Promise.resolve();
    });

    const openedTab = jotaiStore.get(tabsAtom).find((tab) => tab.value === openedDuringDeleteId);
    expect(openedTab?.gameOrigin).toMatchObject({ gameNumber: 3, file: { numGames: 4 } });
    expect(getFileFreshness(openedDuringDeleteId)).toMatchObject({ state: "unverified" });
  });

  test("successful delete does not shift a same-file sibling whose count changed while pending", async () => {
    const ownerOrigin = tabA.gameOrigin;
    if (ownerOrigin.kind !== "file") throw new Error("Test tab must be file-backed");
    const siblingId = "77777777-7777-4777-8777-777777777777";
    const sibling: Tab = {
      ...tabA,
      value: siblingId,
      gameOrigin: { ...ownerOrigin, gameNumber: 3 },
    };
    let resolveDelete!: () => void;
    mocks.deleteGame.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveDelete = resolve;
      }),
    );
    jotaiStore.set(tabsAtom, [tabA, sibling, tabB]);
    await act(async () => root.render(renderPanel()));
    await primeAndDelete();

    await act(async () => {
      jotaiStore.set(tabsAtom, (tabs) =>
        tabs.map((tab) =>
          tab.value === siblingId && tab.gameOrigin.kind === "file"
            ? {
                ...tab,
                gameOrigin: {
                  ...tab.gameOrigin,
                  file: { ...tab.gameOrigin.file, numGames: 6 },
                },
              }
            : tab,
        ),
      );
      resolveDelete();
      await Promise.resolve();
    });

    const updatedSibling = jotaiStore.get(tabsAtom).find((tab) => tab.value === siblingId);
    expect(updatedSibling?.gameOrigin).toMatchObject({ gameNumber: 3, file: { numGames: 6 } });
  });

  test("successful delete leaves initially stale same-file siblings for freshness reconciliation", async () => {
    const ownerOrigin = tabA.gameOrigin;
    if (ownerOrigin.kind !== "file") throw new Error("Test tab must be file-backed");
    const siblingId = "88888888-8888-4888-8888-888888888888";
    const sibling: Tab = {
      ...tabA,
      value: siblingId,
      gameOrigin: {
        ...ownerOrigin,
        gameNumber: 3,
        file: { ...ownerOrigin.file, numGames: 4 },
      },
    };
    mocks.deleteGame.mockResolvedValueOnce(undefined);
    jotaiStore.set(tabsAtom, [tabA, sibling, tabB]);
    await act(async () => root.render(renderPanel()));

    await primeAndDelete();

    const updatedSibling = jotaiStore.get(tabsAtom).find((tab) => tab.value === siblingId);
    expect(updatedSibling?.gameOrigin).toMatchObject({ gameNumber: 3, file: { numGames: 4 } });
    expect(getFileFreshness(siblingId)).toMatchObject({ state: "unverified" });
  });

  test("successful delete does not clear the cache after the active owner changes", async () => {
    let resolveDelete!: () => void;
    mocks.deleteGame.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveDelete = resolve;
      }),
    );
    await act(async () => root.render(renderPanel()));
    await primeAndDelete();

    const treeStoreB = createTreeStore(tabBId, defaultTree());
    await act(async () => {
      jotaiStore.set(activeTabAtom, tabBId);
      root.render(renderPanel(treeStoreB));
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="prime-games"]')!.click();
    });
    await act(async () => {
      resolveDelete();
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="game-cache-size"]')?.textContent).toBe("1");
  });

  test("rapid tab replacement while readGames is pending aborts signal and ignores stale resolve", async () => {
    let capturedSignal!: AbortSignal;
    let resolveLoad!: (data: Awaited<ReturnType<typeof mocks.loadFileGame>>) => void;

    mocks.loadFileGame.mockImplementation(
      (_handle: unknown, _page: number, signal?: AbortSignal) => {
        if (signal) capturedSignal = signal;
        return new Promise((resolve) => {
          resolveLoad = resolve;
        });
      },
    );

    await act(async () => {
      root.render(renderPanel());
    });

    const setPageBtn = container.querySelector<HTMLButtonElement>('[data-testid="set-page"]')!;
    act(() => {
      setPageBtn.click();
    });

    expect(capturedSignal).toBeDefined();
    expect(capturedSignal.aborted).toBe(false);

    // Switch active tab to tab B
    const treeStoreB = createTreeStore(tabBId, defaultTree());
    await act(async () => {
      sessionStorage.setItem(
        "workspace",
        JSON.stringify({ version: 1, tabs: [tabA, tabB], activeTab: tabBId }),
      );
      jotaiStore.set(activeTabAtom, tabBId);
      root.render(renderPanel(treeStoreB));
    });

    // The effect cleanup on [tabId, fileKey, store] must have aborted the in-flight read
    expect(capturedSignal.aborted).toBe(true);

    // Resolve the stale loaded game
    await act(async () => {
      const tree = defaultTree();
      tree.headers.event = "Stale result";
      tree.sourceStamp = "c".repeat(64);
      resolveLoad({
        pgn: "1. d4 d5 *",
        stamp: tree.sourceStamp,
        revision: "r3",
        present: true,
        tree,
      });
    });

    // The stale result is ignored and tab A gameNumber remains 0.
    const tabAState = jotaiStore.get(tabsAtom).find((t) => t.value === tabAId);
    expect(tabAState?.gameOrigin.kind === "file" && tabAState.gameOrigin.gameNumber).toBe(0);
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  test("shared peer survival: tab B page load succeeds independently after tab A was replaced", async () => {
    let signalA!: AbortSignal;
    mocks.loadFileGame.mockImplementationOnce(
      (_handle: unknown, _page: number, signal?: AbortSignal) => {
        if (signal) signalA = signal;
        return new Promise(() => {}); // never resolves
      },
    );

    await act(async () => {
      root.render(renderPanel());
    });

    const setPageBtn = container.querySelector<HTMLButtonElement>('[data-testid="set-page"]')!;
    act(() => {
      setPageBtn.click();
    });

    expect(signalA.aborted).toBe(false);

    // Switch to tab B
    const treeStoreB = createTreeStore(tabBId, defaultTree());
    await act(async () => {
      sessionStorage.setItem(
        "workspace",
        JSON.stringify({ version: 1, tabs: [tabA, tabB], activeTab: tabBId }),
      );
      jotaiStore.set(activeTabAtom, tabBId);
      root.render(renderPanel(treeStoreB));
    });

    expect(signalA.aborted).toBe(true);

    // Tab B now calls setPage
    let signalB!: AbortSignal;
    const mockTreeB = defaultTree();
    mockTreeB.sourceStamp = "d".repeat(64);
    mocks.loadFileGame.mockImplementationOnce(
      (_handle: unknown, _page: number, signal?: AbortSignal) => {
        if (signal) signalB = signal;
        return Promise.resolve({
          pgn: "1. c4 e5 *",
          stamp: mockTreeB.sourceStamp,
          revision: "r4",
          present: true,
          tree: mockTreeB,
        });
      },
    );

    const setPageBtnB = container.querySelector<HTMLButtonElement>('[data-testid="set-page"]')!;
    await act(async () => {
      setPageBtnB.click();
    });

    expect(signalB).toBeDefined();
    expect(signalB.aborted).toBe(false);
    const fileBHandle = tabB.gameOrigin.kind === "file" ? tabB.gameOrigin.file.handle : null;
    expect(mocks.loadFileGame).toHaveBeenCalledWith(fileBHandle, 1, signalB);

    const activeTab = jotaiStore.get(currentTabAtom);
    expect(activeTab?.value).toBe(tabBId);
    expect(activeTab?.gameOrigin.kind === "file" && activeTab.gameOrigin.gameNumber).toBe(1);
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  test("unmount during pending loadFileGame aborts signal and stays silent", async () => {
    let capturedSignal!: AbortSignal;

    mocks.loadFileGame.mockImplementation(
      (_handle: unknown, _page: number, signal?: AbortSignal) => {
        if (signal) capturedSignal = signal;
        return new Promise((_, reject) => {
          signal?.addEventListener("abort", () => {
            reject(cancellationError());
          });
        });
      },
    );

    await act(async () => {
      root.render(renderPanel());
    });

    const setPageBtn = container.querySelector<HTMLButtonElement>('[data-testid="set-page"]')!;
    act(() => {
      setPageBtn.click();
    });

    expect(capturedSignal).toBeDefined();
    expect(capturedSignal.aborted).toBe(false);

    await act(async () => {
      root.unmount();
    });

    expect(capturedSignal.aborted).toBe(true);
    expect(mocks.notify).not.toHaveBeenCalled();
    expect(mocks.logError).not.toHaveBeenCalled();
  });
});
