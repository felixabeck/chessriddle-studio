import { act, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Provider, createStore as createJotaiStore, useAtomValue } from "jotai";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { FileMetadata } from "@/components/files/file";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import { activeTabAtom, tabsAtom, updateTabById } from "@/state/atoms";
import {
  closeTreeStore,
  createTreeStore,
  retargetTreeStore,
  type TreeStore,
} from "@/state/store/tree";
import { tabStorage, TabStorageRepository } from "@/state/store/tabStorage";
import { loadWorkspace, WORKSPACE_STORAGE_KEY } from "@/state/workspace";
import {
  getFileFreshness,
  removeFileFreshness,
  saveFileConflictVersion,
  setFileFreshness,
  startFileRevisionPoll,
} from "@/state/fileFreshness";
import { defaultTree } from "@/utils/treeReducer";
import { getTabTreeKey, saveToFile, serializeStoreTree } from "@/utils/tabs";
import type { Tab } from "@/utils/tabs";
import type { NormalizedGame } from "@/bindings";
import FileFreshnessGate from "./FileFreshnessGate";
import * as deferredView from "@/state/deferredTreeView";
import TreeRecoveryGate from "./TreeRecoveryGate";

const mocks = vi.hoisted(() => ({
  loadFileGame: vi.fn(),
  parsePGN: vi.fn(),
  pickPgnFile: vi.fn(),
  readFileGame: vi.fn(),
  reportPersistError: vi.fn(),
  writeGame: vi.fn(),
  getDbGame: vi.fn(),
  inferGameOrientation: vi.fn(),
  lexPgn: vi.fn(),
  insertDbGame: vi.fn(),
  showNotification: vi.fn(),
  translate: vi.fn((key: string) => key),
  collections: [] as import("@/bindings").CollectionDescriptor[],
  collectionListeners: new Set<() => void>(),
}));

vi.mock("@/hooks/useDatabaseList", () => ({
  useDatabaseList: () => ({
    data: {
      collections: useSyncExternalStore(
        (listener) => {
          mocks.collectionListeners.add(listener);
          return () => {
            mocks.collectionListeners.delete(listener);
          };
        },
        () => mocks.collections,
      ),
    },
  }),
}));

vi.mock("@/utils/files", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/files")>()),
  loadFileGame: mocks.loadFileGame,
  pickPgnFile: mocks.pickPgnFile,
  readFileGame: mocks.readFileGame,
}));
vi.mock("@/platform/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/platform/tauri")>();
  return {
    ...actual,
    tauri: {
      ...actual.tauri,
      writeGame: mocks.writeGame,
      getDbGame: mocks.getDbGame,
      inferGameOrientation: mocks.inferGameOrientation,
      lexPgn: mocks.lexPgn,
      insertDbGame: mocks.insertDbGame,
      qualifyFileGame: vi.fn(async () => null),
      collectionForDatabase: vi.fn(async () => null),
    },
  };
});
vi.mock("@/utils/chess", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/chess")>()),
  parsePGN: mocks.parsePGN,
}));
vi.mock("@/state/persistError", () => ({ reportPersistError: mocks.reportPersistError }));
vi.mock("@mantine/notifications", () => ({ notifications: { show: mocks.showNotification } }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: mocks.translate }) }));
vi.mock("@mantine/core", () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
  Group: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Loader: () => <span>loader</span>,
  Stack: ({ children, ...props }: { children: React.ReactNode; className?: string }) => (
    <div {...props}>{children}</div>
  ),
  Text: ({ children, ...props }: { children: React.ReactNode; className?: string }) => (
    <p {...props}>{children}</p>
  ),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const tabId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const sharedTabId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const originalStamp = "a".repeat(64);
const changedStamp = "b".repeat(64);
const emptyStamp = "e".repeat(64);
const file: FileMetadata = {
  type: "file",
  handle: { id: { id: "file-handle" }, kind: "fileWorkspace" },
  name: "games.pgn",
  numGames: 2,
  metadata: { type: "game", tags: [] },
  lastModified: 1,
};
const fileTab: Tab = {
  value: tabId,
  name: "Game",
  type: "analysis",
  gameOrigin: { kind: "file", file, gameNumber: 0 },
};

let host: HTMLDivElement;
let root: Root;
let jotaiStore: ReturnType<typeof createJotaiStore>;
let treeStore: TreeStore;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function stampedGame(stamp = originalStamp, pgn = '[Event "Game"]\n\n1. e4 *', present = true) {
  return { pgn, stamp, revision: "device:inode:revision", present };
}

test.each(["old generation", "unqualified legacy tree"])(
  "dirty equal-text linked reads preserve the %s for recovery",
  async (kind) => {
    const locator = {
      collection: "22222222-2222-4222-8222-222222222222",
      generation: "new-generation",
      ordinal: 0,
      stamp: originalStamp,
    };
    await setup({
      dirty: true,
      readResult: (store) => {
        if (kind === "old generation")
          store.getState().setLinkedSource({ ...locator, generation: "old-generation" });
        return { ...stampedGame(), revision: locator.generation, linked: locator };
      },
    });
    expect(getFileFreshness(tabId).state).toBe("conflict");
    expect(treeStore.getState()).toMatchObject({
      dirty: true,
      headers: { event: "Unsaved edit" },
      sourceStamp: originalStamp,
    });
    expect(mocks.writeGame).not.toHaveBeenCalled();
  },
);

test("migration original retirement preserves the dirty linked tree for explicit recovery", async () => {
  const locator = {
    collection: "22222222-2222-4222-8222-222222222222",
    generation: "original-generation",
    ordinal: 0,
    stamp: originalStamp,
  };
  const closeTab = await setup({ dirty: true, freshness: "verified" });
  await act(async () => treeStore.getState().setLinkedSource(locator));
  expect(jotaiStore.get(tabsAtom)[0].gameOrigin.kind).toBe("file");
  expect(treeStore.getState().linkedSource).toEqual(locator);
  const before = serializeStoreTree(treeStore);
  mocks.collections = [
    {
      id: locator.collection,
      name: file.name,
      file: file.handle,
      database: null,
      account: null,
      status: "preservedOriginal",
      generation: "",
      omitted: 0,
      retiredDatabase: null,
      fetchSinceMs: null,
    },
  ];
  await act(async () => {
    mocks.collectionListeners.forEach((listener) => listener());
    root.render(
      <Provider store={jotaiStore}>
        <Harness closeTab={closeTab} />
      </Provider>,
    );
  });
  expect(treeStore.getState().linkedSource).toEqual(locator);
  expect(host.textContent).toContain("Collections.PreservedOriginal");
  expect(host.querySelector('[data-testid="board-and-panels"]')).toBeNull();
  expect(treeStore.getState().dirty).toBe(true);
  expect(serializeStoreTree(treeStore)).toBe(before);
  expect(mocks.writeGame).not.toHaveBeenCalled();
  await act(async () => button("Collections.KeepEdits").click());
  expect(jotaiStore.get(tabsAtom)[0].gameOrigin).toEqual({ kind: "none" });
  expect(treeStore.getState().linkedSource).toBeNull();
  expect(treeStore.getState().dirty).toBe(true);
  expect(serializeStoreTree(treeStore)).toBe(before);
});

function button(label: string): HTMLButtonElement {
  const result = Array.from(host.querySelectorAll("button")).find(
    (candidate) => candidate.textContent === label,
  );
  if (!(result instanceof HTMLButtonElement)) throw new Error(`Missing button ${label}`);
  return result;
}

function Harness({ closeTab }: { closeTab: (id: string) => void }) {
  const tabs = useAtomValue(tabsAtom);
  const tab = tabs.find((candidate) => candidate.value === tabId);
  return tab ? <GateForTab tab={tab} closeTab={closeTab} /> : null;
}

function GateForTab({ tab, closeTab }: { tab: Tab; closeTab: (id: string) => void }) {
  return (
    <TreeStateContext.Provider value={treeStore}>
      <TreeRecoveryGate tabId={tab.value} treeKey={getTabTreeKey(tab)}>
        <FileFreshnessGate tab={tab} closeTab={closeTab}>
          <div data-testid="board-and-panels">board and panels</div>
        </FileFreshnessGate>
      </TreeRecoveryGate>
    </TreeStateContext.Provider>
  );
}

function SharedGateHarness({ secondTab, secondStore }: { secondTab: Tab; secondStore: TreeStore }) {
  return (
    <>
      <TreeStateContext.Provider value={treeStore}>
        <FileFreshnessGate tab={fileTab} closeTab={() => undefined}>
          <div data-testid="first-shared-board">first board</div>
        </FileFreshnessGate>
      </TreeStateContext.Provider>
      <TreeStateContext.Provider value={secondStore}>
        <FileFreshnessGate tab={secondTab} closeTab={() => undefined}>
          <div data-testid="second-shared-board">second board</div>
        </FileFreshnessGate>
      </TreeStateContext.Provider>
    </>
  );
}

async function setup({
  treeStamp = originalStamp,
  dirty = false,
  appendAttempted = false,
  freshness = "unverified",
  persisted = true,
  readError,
  readResult,
  tab = fileTab,
}: {
  treeStamp?: string | null;
  dirty?: boolean;
  appendAttempted?: boolean;
  freshness?: "unverified" | "overdue" | "appending" | "verified" | "conflict" | "unavailable";
  persisted?: boolean;
  readError?: Error;
  readResult?: (store: TreeStore) => ReturnType<typeof stampedGame>;
  tab?: Tab;
} = {}) {
  const tree = defaultTree();
  tree.sourceStamp = treeStamp;
  tree.dirty = dirty;
  tree.appendAttempted = appendAttempted;
  if (dirty) tree.headers.event = "Unsaved edit";
  if (persisted && tab.treeKey) tabStorage.seed(getTabTreeKey(tab), tree);
  treeStore = createTreeStore(persisted ? tabId : undefined, tree, getTabTreeKey(tab));
  tabStorage.readTree(getTabTreeKey(tab));
  jotaiStore = createJotaiStore();
  jotaiStore.set(tabsAtom, [tab], tabId);
  jotaiStore.set(activeTabAtom, tabId);
  setFileFreshness(tabId, freshness);
  if (readResult)
    mocks.readFileGame.mockImplementation(() => Promise.resolve(readResult(treeStore)));
  else if (readError) mocks.readFileGame.mockRejectedValue(readError);
  else mocks.readFileGame.mockResolvedValue(stampedGame(treeStamp ?? originalStamp));
  mocks.loadFileGame.mockResolvedValue({
    ...stampedGame(changedStamp),
    tree: { ...defaultTree(), sourceStamp: changedStamp },
  });
  mocks.pickPgnFile.mockResolvedValue({ ...file, numGames: 7 });
  mocks.writeGame.mockResolvedValue({ stamp: changedStamp, revision: "new-revision" });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const closeTab = vi.fn();
  await act(async () =>
    root.render(
      <Provider store={jotaiStore}>
        <Harness closeTab={closeTab} />
      </Provider>,
    ),
  );
  return closeTab;
}

beforeEach(() => {
  mocks.lexPgn.mockResolvedValue([]);
  mocks.inferGameOrientation.mockResolvedValue(null);
  mocks.collections = [];
  sessionStorage.clear();
  vi.clearAllMocks();
  mocks.parsePGN.mockImplementation(async (pgn: string) => {
    const tree = defaultTree();
    const event = pgn.match(/\[Event "([^"]+)"\]/)?.[1];
    if (event) tree.headers.event = event;
    return tree;
  });
  removeFileFreshness(tabId);
});

const databaseTab: Tab = {
  ...fileTab,
  gameOrigin: {
    kind: "database",
    database: { id: { id: "database" }, kind: "database" },
    gameId: 812,
  },
};
const databaseRow: NormalizedGame = {
  id: 812,
  stamp: changedStamp,
  fen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1",
  event: "Row event",
  event_id: 1,
  site: "Berlin",
  site_id: 1,
  white: "White",
  white_id: 1,
  black: "Black",
  black_id: 2,
  result: "*",
  moves: "1... c5 *",
};

test("an unverified database tab shows the board until a conflict unmounts it", async () => {
  await setup({ tab: databaseTab });
  expect(host.querySelector('[data-testid="board-and-panels"]')).not.toBeNull();
  expect(mocks.getDbGame).not.toHaveBeenCalled();
  await act(async () => setFileFreshness(tabId, "conflict"));
  expect(host.querySelector('[data-testid="board-and-panels"]')).toBeNull();
  expect(host.textContent).toContain("FileFreshness.ChangedInDatabase");
});

test.each([undefined, "white", "black"] as const)(
  "database reload preserves stored/inferred orientation %s and the row's tree and stamp",
  async (orientation) => {
    await setup({ tab: databaseTab, freshness: "conflict", dirty: true });
    const actual = await vi.importActual<typeof import("@/utils/chess")>("@/utils/chess");
    mocks.parsePGN.mockImplementation(actual.parsePGN);
    mocks.lexPgn.mockResolvedValue([
      { type: "San", value: "c5" },
      { type: "Outcome", value: "*" },
    ]);
    mocks.getDbGame.mockResolvedValue({ kind: "found", game: { ...databaseRow, orientation } });
    mocks.inferGameOrientation.mockResolvedValue("black");
    await act(async () => button("FileFreshness.ReloadFromDatabase").click());
    expect(mocks.getDbGame).toHaveBeenCalledWith(
      databaseTab.gameOrigin.kind === "database" && databaseTab.gameOrigin.database,
      812,
      null,
      { signal: expect.any(AbortSignal) },
    );
    expect(treeStore.getState().root.fen).toBe(databaseRow.fen);
    expect(treeStore.getState().root.children[0].san).toBe("c5");
    expect(treeStore.getState().headers).toMatchObject({
      event: "Row event",
      site: "Berlin",
      white: "White",
      black: "Black",
    });
    expect(treeStore.getState()).toMatchObject({ sourceStamp: changedStamp, dirty: false });
    expect(treeStore.getState().headers.orientation).toBe(orientation ?? "black");
    expect(mocks.inferGameOrientation).toHaveBeenCalledTimes(orientation ? 0 : 1);
    expect(getFileFreshness(tabId).state).toBe("verified");
    expect(host.querySelector('[data-testid="board-and-panels"]')).not.toBeNull();
  },
);

test("a late database inference cannot replace an unmounted reload owner", async () => {
  await setup({ tab: databaseTab, freshness: "conflict", dirty: true });
  const actual = await vi.importActual<typeof import("@/utils/chess")>("@/utils/chess");
  mocks.parsePGN.mockImplementation(actual.parsePGN);
  mocks.getDbGame.mockResolvedValue({ kind: "found", game: databaseRow });
  const inference = deferred<"black">();
  mocks.inferGameOrientation.mockReturnValueOnce(inference.promise);
  const original = treeStore.getState().root;
  await act(async () => button("FileFreshness.ReloadFromDatabase").click());
  expect(mocks.inferGameOrientation).toHaveBeenCalledOnce();
  await act(async () => root.render(null));
  await act(async () => inference.resolve("black"));
  expect(treeStore.getState().root).toBe(original);
  expect(treeStore.getState().dirty).toBe(true);
});

test("a missing database row keeps the tree and offers Close", async () => {
  const closeTab = await setup({ tab: databaseTab, freshness: "conflict", dirty: true });
  const before = serializeStoreTree(treeStore);
  mocks.getDbGame.mockResolvedValue({ kind: "missing" });
  await act(async () => button("FileFreshness.ReloadFromDatabase").click());
  expect(getFileFreshness(tabId).state).toBe("unavailable");
  expect(serializeStoreTree(treeStore)).toBe(before);
  expect(treeStore.getState().dirty).toBe(true);
  expect(host.textContent).toContain("FileFreshness.GameNoLongerInDatabase");
  await act(async () => button("Tab.Close").click());
  expect(closeTab).toHaveBeenCalledWith(tabId);
});

test.each(["unmount", "origin change", "database row change"])(
  "database reload ignores completion after %s",
  async (exit) => {
    await setup({ tab: databaseTab, freshness: "conflict", dirty: true });
    const before = serializeStoreTree(treeStore);
    const read = deferred<{ kind: "found"; game: NormalizedGame }>();
    mocks.getDbGame.mockReturnValue(read.promise);
    await act(async () => button("FileFreshness.ReloadFromDatabase").click());
    await act(async () => {
      if (exit === "unmount") root.render(null);
      else
        updateTabById((...args) => jotaiStore.set(tabsAtom, ...args), tabId, {
          ...databaseTab,
          gameOrigin:
            exit === "database row change" && databaseTab.gameOrigin.kind === "database"
              ? { ...databaseTab.gameOrigin, gameId: 900 }
              : { kind: "none" },
        });
    });
    await act(async () => read.resolve({ kind: "found", game: databaseRow }));
    expect(serializeStoreTree(treeStore)).toBe(before);
    expect(getFileFreshness(tabId).state).toBe("conflict");
    expect(
      exit === "database row change" ? button("FileFreshness.ReloadFromDatabase").disabled : null,
    ).toBe(exit === "database row change" ? false : null);
  },
);

test("database reload errors keep the edits and show their message", async () => {
  await setup({ tab: databaseTab, freshness: "conflict", dirty: true });
  const before = serializeStoreTree(treeStore);
  mocks.getDbGame.mockRejectedValue(new Error("Read refused"));
  await act(async () => button("FileFreshness.ReloadFromDatabase").click());
  expect(host.textContent).toContain("Read refused");
  expect(serializeStoreTree(treeStore)).toBe(before);
});

test.each([false, true])(
  "database Save as new surfaces failure, registered=%s",
  async (registered) => {
    await setup({
      tab: databaseTab,
      freshness: registered ? "unavailable" : "conflict",
      dirty: true,
    });
    await act(async () => treeStore.getState().makeMove({ payload: "e4" }));
    mocks.insertDbGame.mockRejectedValue({
      tag: "backend-error",
      category: "permission",
      message: "Insert refused",
    });
    const before = serializeStoreTree(treeStore);
    let saveError: unknown;
    await act(async () => {
      if (registered) {
        try {
          await saveFileConflictVersion(tabId);
        } catch (error) {
          saveError = error;
        }
      } else button("FileFreshness.SaveAsNewGame").click();
    });
    expect(registered ? saveError : {}).toMatchObject(
      registered ? { message: "Insert refused" } : {},
    );
    expect(host.textContent).toContain("Insert refused");
    expect(serializeStoreTree(treeStore)).toBe(before);
    expect(mocks.insertDbGame).toHaveBeenCalledTimes(1);
  },
);

test("database Save as new admits the inserted id and stamp through the shared store path", async () => {
  await setup({ tab: databaseTab, freshness: "unavailable", dirty: true });
  await act(async () => treeStore.getState().makeMove({ payload: "e4" }));
  mocks.insertDbGame.mockResolvedValue({ id: 900, stamp: changedStamp });
  await act(async () => expect(await saveFileConflictVersion(tabId)).toBe(true));
  expect(mocks.insertDbGame).toHaveBeenCalledTimes(1);
  expect(jotaiStore.get(tabsAtom)[0].gameOrigin).toMatchObject({ kind: "database", gameId: 900 });
  expect(treeStore.getState()).toMatchObject({ sourceStamp: changedStamp, dirty: false });
  expect(getFileFreshness(tabId).state).toBe("verified");
});

afterEach(async () => {
  vi.useRealTimers();
  await act(async () => root?.unmount());
  host?.remove();
  tabStorage.flush();
  closeTreeStore(tabId);
  closeTreeStore(sharedTabId);
  removeFileFreshness(tabId);
  removeFileFreshness(sharedTabId);
  vi.restoreAllMocks();
});

test.each(["unchanged", "conflict", "unavailable"] as const)(
  "%s reconciliation neither parses nor defers a replacement",
  async (outcome) => {
    const defer = vi.spyOn(deferredView, "deferTreeView");
    await setup({
      dirty: outcome === "conflict",
      readResult: () =>
        stampedGame(
          outcome === "unchanged" ? originalStamp : changedStamp,
          '[Event "Changed"]\n\n1. d4 *',
          outcome !== "unavailable",
        ),
    });
    expect(getFileFreshness(tabId).state).toBe(outcome === "unchanged" ? "verified" : outcome);
    expect(mocks.parsePGN).not.toHaveBeenCalled();
    expect(defer).not.toHaveBeenCalled();
    expect(deferredView.isTreeViewDeferred(treeStore)).toBe(false);
  },
);

test("unverified files withhold the board until an equal stamp verifies", async () => {
  const read = deferred<ReturnType<typeof stampedGame>>();
  mocks.readFileGame.mockReturnValueOnce(read.promise);
  await setup();

  expect(host.querySelector('[data-testid="board-and-panels"]')).toBeNull();
  expect(host.textContent).toContain("FileFreshness.CheckingFile");

  await act(async () => read.resolve(stampedGame(originalStamp)));

  expect(host.querySelector('[data-testid="board-and-panels"]')).not.toBeNull();
  expect(getFileFreshness(tabId)).toMatchObject({
    state: "verified",
    verifiedRevision: "device:inode:revision",
  });
  expect(treeStore.getState().sourceStamp).toBe(originalStamp);
});

test("file-backed analysis enters normal freshness reconciliation after tree discard", async () => {
  sessionStorage.setItem(tabId, "unreadable file-backed tree");
  tabStorage.readTree(tabId);
  await setup({ persisted: true });

  expect(host.querySelector('[data-tree-recovery="unreadable"]')).not.toBeNull();
  expect(host.querySelector("[data-file-freshness]")).toBeNull();
  expect(mocks.readFileGame).not.toHaveBeenCalled();

  await act(async () => button("TreeRecovery.DiscardValue").click());
  await vi.waitFor(() => expect(mocks.readFileGame).toHaveBeenCalledOnce());
  await vi.waitFor(() => expect(getFileFreshness(tabId).state).toBe("conflict"));

  expect(host.querySelector("[data-tree-recovery]")).toBeNull();
  expect(host.querySelector('[data-file-freshness^="conflict:"]')).not.toBeNull();
  expect(host.querySelector('[data-testid="board-and-panels"]')).toBeNull();
});

test("clean stamped files reload from disk before rendering", async () => {
  mocks.readFileGame.mockResolvedValueOnce(stampedGame(changedStamp, '[Event "Fresh"]\n\n1. d4 *'));
  await setup();

  await vi.waitFor(() =>
    expect(host.querySelector('[data-testid="board-and-panels"]')).not.toBeNull(),
  );
  expect(treeStore.getState().sourceStamp).toBe(changedStamp);
  expect(treeStore.getState().headers.event).toBe("Fresh");
  expect(host.querySelector('[data-file-freshness="verified:1"]')).not.toBeNull();
});

test("a stampless tree matching the present disk text adopts its stamp without clearing dirty", async () => {
  await setup({
    treeStamp: null,
    dirty: true,
    readResult: (store) => stampedGame(changedStamp, serializeStoreTree(store)),
  });

  await vi.waitFor(() => expect(getFileFreshness(tabId).state).toBe("verified"));

  expect(treeStore.getState()).toMatchObject({ dirty: true, sourceStamp: changedStamp });
  expect(host.querySelector('[data-testid="board-and-panels"]')).not.toBeNull();
});

test("a clean stampless tree with different disk text conflicts without replacing the tree", async () => {
  await setup({
    treeStamp: null,
    readResult: () => stampedGame(changedStamp, '[Event "Different on disk"]\n\n1. d4 *'),
  });
  const rootBefore = treeStore.getState().root;

  await vi.waitFor(() => expect(getFileFreshness(tabId).state).toBe("conflict"));

  expect(treeStore.getState().root).toBe(rootBefore);
  expect(treeStore.getState().headers.event).not.toBe("Different on disk");
  expect(host.querySelector('[data-testid="board-and-panels"]')).toBeNull();
});

test("a reopened file tab reconciles the appended game at its refreshed end index", async () => {
  const appendedTab: Tab = {
    ...fileTab,
    gameOrigin: { kind: "file", file: { ...file, numGames: 5 }, gameNumber: 4 },
  };
  await setup({
    freshness: "unverified",
    tab: appendedTab,
    readResult: () => stampedGame(changedStamp, '[Event "New appended game"]\n\n*'),
  });

  await vi.waitFor(() => expect(getFileFreshness(tabId).state).toBe("verified"));

  expect(mocks.readFileGame).toHaveBeenCalledWith(file.handle, 4, expect.any(AbortSignal));
  expect(treeStore.getState()).toMatchObject({
    sourceStamp: changedStamp,
    headers: { event: "New appended game" },
  });
});

test("a stampless tree whose disk game is absent conflicts instead of adopting an empty slot", async () => {
  await setup({
    treeStamp: null,
    readResult: () => stampedGame(emptyStamp, "", false),
  });

  await vi.waitFor(() => expect(getFileFreshness(tabId).state).toBe("conflict"));

  expect(host.textContent).toContain("FileFreshness.Changed");
  expect(host.querySelector('[data-testid="board-and-panels"]')).toBeNull();
});

test("equal stamps render without replacing tree state", async () => {
  await setup();
  const setState = vi.spyOn(treeStore.getState(), "setState");

  await vi.waitFor(() =>
    expect(host.querySelector('[data-testid="board-and-panels"]')).not.toBeNull(),
  );

  expect(setState).not.toHaveBeenCalled();
});

test("a save seeds the poll revision without unmounting the verified board", async () => {
  vi.useFakeTimers();
  await setup({ freshness: "verified" });
  setFileFreshness(tabId, "verified", { verifiedRevision: "old-revision" });
  mocks.writeGame.mockResolvedValueOnce({ stamp: changedStamp, revision: "new-revision" });

  const updateTab = (id: string, update: Tab | ((tab: Tab) => Tab)) => {
    let found = false;
    const committed = jotaiStore.set(
      tabsAtom,
      (tabs) =>
        tabs.map((tab) => {
          if (tab.value !== id) return tab;
          found = true;
          return typeof update === "function" ? update(tab) : update;
        }),
      tabId,
    );
    return committed && found;
  };
  const board = host.querySelector('[data-testid="board-and-panels"]');
  const result = await saveToFile({
    tab: fileTab,
    updateTab,
    getTab: (id) => jotaiStore.get(tabsAtom).find((tab) => tab.value === id),
    store: treeStore,
  });
  const afterSave = getFileFreshness(tabId);
  expect(result).toBe("saved");
  expect(afterSave).toMatchObject({ state: "verified", verifiedRevision: "new-revision" });

  const fileRevision = vi.fn(async () => "new-revision");
  const stop = startFileRevisionPoll({
    getTabs: () => jotaiStore.get(tabsAtom),
    fileRevision,
    subscribeFocus: () => () => undefined,
  });
  await act(async () => vi.advanceTimersByTimeAsync(2_000));

  expect(fileRevision).toHaveBeenCalledOnce();
  expect(getFileFreshness(tabId)).toBe(afterSave);
  expect(getFileFreshness(tabId).epoch).toBe(afterSave.epoch);
  expect(host.querySelector('[data-testid="board-and-panels"]')).toBe(board);
  expect(host.textContent).not.toContain("loader");
  expect(mocks.readFileGame).toHaveBeenCalledExactlyOnceWith(
    file.handle,
    fileTab.gameOrigin.kind === "file" ? fileTab.gameOrigin.gameNumber : 0,
  );
  stop();
});

test("lossy source conflict explains the refusal and keeps both recovery actions", async () => {
  await setup({ dirty: true, freshness: "verified" });
  await act(async () => setFileFreshness(tabId, "conflict", { conflictReason: "lossy-source" }));
  expect(host.textContent).toContain("FileFreshness.LossySource");
  expect(host.textContent).not.toContain("FileFreshness.Changed");
  expect(button("FileFreshness.ReloadFromDisk").disabled).toBe(false);
  expect(button("FileFreshness.SaveAsNewGame").disabled).toBe(false);
  expect(treeStore.getState().headers.event).toBe("Unsaved edit");
});

test("dirty changed trees show conflict without mounting board or practice children", async () => {
  mocks.readFileGame.mockResolvedValueOnce(stampedGame(changedStamp));
  await setup({ dirty: true });

  await vi.waitFor(() => expect(getFileFreshness(tabId).state).toBe("conflict"));

  expect(host.querySelector('[data-testid="board-and-panels"]')).toBeNull();
  expect(host.textContent).toContain("FileFreshness.Changed");
  expect(host.textContent).toContain("FileFreshness.ReloadFromDisk");
  expect(host.textContent).toContain("FileFreshness.SaveAsNewGame");
  expect(treeStore.getState().headers.event).toBe("Unsaved edit");
});

test("an edit made during reconcile becomes a conflict instead of being replaced", async () => {
  const read = deferred<ReturnType<typeof stampedGame>>();
  mocks.readFileGame.mockReturnValueOnce(read.promise);
  await setup();
  await act(async () => {
    treeStore.getState().setHeaders({ ...treeStore.getState().headers, event: "Edited in flight" });
  });

  await act(async () => read.resolve(stampedGame(changedStamp, '[Event "Disk"]\n\n1. d4 *')));

  expect(getFileFreshness(tabId).state).toBe("conflict");
  expect(treeStore.getState().headers.event).toBe("Edited in flight");
  expect(host.querySelector('[data-testid="board-and-panels"]')).toBeNull();
});

test.each([
  ["invalid-input", "FileFreshness.GameNoLongerInFile"],
  ["missing-resource", "FileFreshness.Unavailable"],
  ["conflict", "FileFreshness.Unavailable"],
] as const)("routes %s reads to the unavailable panel", async (category, expectedText) => {
  mocks.readFileGame.mockRejectedValueOnce({
    tag: "backend-error",
    category,
    message: "file unavailable",
  });
  await setup();

  await vi.waitFor(() => expect(getFileFreshness(tabId).state).toBe("unavailable"));

  expect(host.textContent).toContain(expectedText);
  expect(host.querySelector('[data-testid="board-and-panels"]')).toBeNull();
});

test("a deleted game is unavailable, while a matching empty slot remains verified", async () => {
  mocks.readFileGame.mockResolvedValueOnce(stampedGame(emptyStamp, "", false));
  await setup({ treeStamp: emptyStamp });

  await vi.waitFor(() => expect(getFileFreshness(tabId).state).toBe("verified"));
  expect(host.querySelector('[data-testid="board-and-panels"]')).not.toBeNull();
});

test("a missing game with a prior non-empty stamp is unavailable", async () => {
  mocks.readFileGame.mockResolvedValueOnce(stampedGame(emptyStamp, "", false));
  await setup({ treeStamp: originalStamp });

  await vi.waitFor(() => expect(getFileFreshness(tabId).state).toBe("unavailable"));
  expect(host.querySelector('[data-testid="board-and-panels"]')).toBeNull();
});

test("an unavailable panel close request is routed through the tab close flow", async () => {
  mocks.readFileGame.mockRejectedValueOnce({
    tag: "backend-error",
    category: "missing-resource",
    message: "file missing",
  });
  const closeTab = await setup({ dirty: true });
  await vi.waitFor(() => expect(getFileFreshness(tabId).state).toBe("unavailable"));

  await act(async () => button("Tab.Close").click());

  expect(closeTab).toHaveBeenCalledWith(tabId);
  expect(treeStore.getState().dirty).toBe(true);
});

test("generic read failures keep the board withheld and offer retry", async () => {
  await setup({ readError: new Error("network offline") });

  expect(mocks.readFileGame).toHaveBeenCalled();
  await vi.waitFor(() => expect(host.textContent).toContain("network offline"), {
    timeout: 500,
  });
  expect(getFileFreshness(tabId).state).toBe("unverified");
  expect(host.querySelector('[data-testid="board-and-panels"]')).toBeNull();
  expect(host.textContent).toContain("FileFreshness.Retry");
});

test("append resolution flushes uncertainty first and moves the tab only after a stamped append", async () => {
  mocks.readFileGame.mockResolvedValueOnce(stampedGame(changedStamp));
  await setup({ dirty: true, persisted: true });
  await vi.waitFor(() => expect(getFileFreshness(tabId).state).toBe("conflict"));
  const serializedTree = serializeStoreTree(treeStore);
  const pending = deferred<{ stamp: string | null; revision: string | null }>();
  mocks.writeGame.mockImplementationOnce(async () => {
    expect(tabStorage.read(tabId)?.state).toMatchObject({ appendAttempted: true });
    return pending.promise;
  });

  await act(async () => button("FileFreshness.SaveAsNewGame").click());

  expect(mocks.writeGame).toHaveBeenCalledWith(file.handle, 7, expect.any(String), {
    kind: "append",
  });
  expect(mocks.writeGame.mock.calls[0][2]).toBe(serializedTree);
  await vi.waitFor(() => expect(button("FileFreshness.ReloadFromDisk").disabled).toBe(true));
  expect(button("FileFreshness.SaveAsNewGame").disabled).toBe(true);
  await act(async () => pending.resolve({ stamp: changedStamp, revision: "appended-revision" }));

  expect(jotaiStore.get(tabsAtom)[0].gameOrigin).toMatchObject({
    kind: "file",
    gameNumber: 7,
    file: { numGames: 8 },
  });
  expect(treeStore.getState()).toMatchObject({
    dirty: false,
    sourceStamp: changedStamp,
    appendAttempted: false,
  });
  expect(getFileFreshness(tabId).state).toBe("verified");
  expect(getFileFreshness(tabId).verifiedRevision).toBe("appended-revision");
});

test("recovery adoption preserves edits made during append and clears the admitted marker", async () => {
  const { pending, completion } = await startPendingAppend(true);
  await act(async () => treeStore.getState().setComment("Later recovery edit"));
  await act(async () => pending.resolve({ stamp: changedStamp, revision: "recovery-append" }));
  expect(await completion).toEqual({ result: false });
  expect(jotaiStore.get(tabsAtom)[0].gameOrigin).toMatchObject({ kind: "file", gameNumber: 7 });
  expect(treeStore.getState()).toMatchObject({
    dirty: true,
    sourceStamp: changedStamp,
    appendAttempted: false,
    root: { comment: "Later recovery edit" },
  });
});

test.each([
  { newer: false, isUserSave: true },
  { newer: true, isUserSave: false },
])(
  "linked recovery into a plain PGN persists destination provenance and permits the next save with newer=$newer user-save=$isUserSave",
  async ({ newer, isUserSave }) => {
    const locator = {
      collection: "22222222-2222-4222-8222-222222222222",
      generation: "old-linked-generation",
      ordinal: 0,
      stamp: originalStamp,
    };
    await setup({
      dirty: true,
      readResult: (store) => {
        store.getState().setLinkedSource(locator);
        return { ...stampedGame(changedStamp), linked: { ...locator, generation: "external" } };
      },
    });
    expect(getFileFreshness(tabId).state).toBe("conflict");
    const destination = {
      ...file,
      handle: { id: { id: "plain-recovery-destination" }, kind: "fileWorkspace" as const },
      name: "recovered.pgn",
      numGames: 3,
    };
    mocks.pickPgnFile.mockResolvedValueOnce(destination);
    const snapshot = serializeStoreTree(treeStore);
    const pending = deferred<AppendResult>();
    mocks.writeGame.mockReturnValueOnce(pending.promise);
    await act(async () => button("FileFreshness.SaveAsNewGame").click());
    expect(mocks.writeGame).toHaveBeenLastCalledWith(destination.handle, 3, snapshot, {
      kind: "append",
    });
    if (newer) await act(async () => treeStore.getState().setComment("Edit while recovering"));
    await act(async () => pending.resolve({ stamp: changedStamp, revision: "plain-appended" }));

    expect(treeStore.getState()).toMatchObject({
      linkedSource: null,
      sourceStamp: changedStamp,
      appendAttempted: false,
      dirty: newer,
      headers: { event: "Unsaved edit" },
      root: { comment: newer ? "Edit while recovering" : "" },
    });
    expect(tabStorage.flush()).toEqual([]);
    const admitted = loadWorkspace(sessionStorage, WORKSPACE_STORAGE_KEY).tabs[0]!;
    expect(admitted.gameOrigin).toMatchObject({
      kind: "file",
      gameNumber: 3,
      file: { ...destination, numGames: 4 },
    });
    expect(new TabStorageRepository().read(getTabTreeKey(admitted))?.state).toMatchObject({
      linkedSource: null,
      sourceStamp: changedStamp,
      dirty: newer,
      headers: { event: "Unsaved edit" },
      root: { comment: newer ? "Edit while recovering" : "" },
    });
    await act(async () => root.unmount());
    closeTreeStore(tabId);
    treeStore = createTreeStore(tabId, undefined, getTabTreeKey(admitted));
    expect(treeStore.getState().linkedSource).toBeNull();
    treeStore.getState().setComment("Edit after cold reload");
    const nextSnapshot = serializeStoreTree(treeStore);
    mocks.readFileGame.mockResolvedValueOnce(stampedGame(changedStamp));
    mocks.writeGame.mockImplementationOnce(async (_handle, _page, _pgn, expectation) => {
      if (expectation.kind !== "game")
        throw { tag: "backend-error", category: "stale-game", message: "Plain file is not linked" };
      return { stamp: emptyStamp, revision: "plain-saved" };
    });
    await expect(
      saveToFile({
        tab: admitted,
        store: treeStore,
        isUserSave,
        getTab: (id) => jotaiStore.get(tabsAtom).find((tab) => tab.value === id),
        updateTab: (id, update, onAdmitted) =>
          updateTabById(
            (next, active, saved) => jotaiStore.set(tabsAtom, next, active, saved),
            id,
            update,
            onAdmitted,
          ),
      }),
    ).resolves.toBe("saved");
    expect(mocks.writeGame).toHaveBeenLastCalledWith(destination.handle, 3, nextSnapshot, {
      kind: "game",
      stamp: changedStamp,
    });
    expect(treeStore.getState()).toMatchObject({ dirty: false, linkedSource: null });
    expect(mocks.showNotification).not.toHaveBeenCalled();
  },
);

test("refused recovery origin admission keeps append uncertainty durable and refuses retry", async () => {
  const { pending, completion } = await startPendingAppend(true);
  const original = Storage.prototype.setItem;
  const refuse = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(function (this: Storage, key, value) {
      if (key === WORKSPACE_STORAGE_KEY) throw new DOMException("quota", "QuotaExceededError");
      original.call(this, key, value);
    });
  await act(async () => pending.resolve({ stamp: changedStamp, revision: "refused-admission" }));
  expect(await completion).toEqual({ result: false });
  refuse.mockRestore();
  expect(jotaiStore.get(tabsAtom)[0].gameOrigin).toEqual(fileTab.gameOrigin);
  expect(treeStore.getState()).toMatchObject({ dirty: true, appendAttempted: true });
  expect(host.textContent).toContain("FileFreshness.AppendMayHaveBeenAdded");
  expect(await saveFileConflictVersion(tabId)).toBe(false);
  expect(tabStorage.flush()).toEqual([]);
  expect(new TabStorageRepository().read(tabId)?.state).toMatchObject({
    dirty: true,
    appendAttempted: true,
  });
  expect(mocks.writeGame).toHaveBeenCalledOnce();
});

test.each([false, true])(
  "recovery provider preserves admitted subscriber failure with newer edits %s",
  async (newer) => {
    const { pending, completion } = await startPendingAppend(true);
    if (newer) await act(async () => treeStore.getState().setComment("Newer recovery edit"));
    const failure = new Error("Recovery workspace subscriber failed");
    const unsubscribe = jotaiStore.sub(tabsAtom, () => {
      throw failure;
    });
    try {
      await act(async () =>
        pending.resolve({ stamp: changedStamp, revision: "subscriber-admitted" }),
      );
      expect(await completion).toMatchObject({
        error: { message: expect.stringContaining(failure.message) },
      });
      expect(mocks.showNotification).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
    const admitted = jotaiStore.get(tabsAtom)[0]!;
    expect(admitted).toMatchObject({
      value: tabId,
      gameOrigin: { kind: "file", gameNumber: 7, file: { numGames: 8 } },
    });
    expect(treeStore.getState()).toMatchObject({
      dirty: newer,
      sourceStamp: changedStamp,
      appendAttempted: false,
    });
    expect(treeStore.getState().root.comment).toBe(newer ? "Newer recovery edit" : "");
    expect(getFileFreshness(tabId)).toMatchObject({
      state: "verified",
      verifiedRevision: "subscriber-admitted",
    });
    tabStorage.flush();
    expect(new TabStorageRepository().read(getTabTreeKey(admitted))?.state).toMatchObject({
      dirty: newer,
      sourceStamp: changedStamp,
      appendAttempted: false,
    });
    await act(async () => treeStore.getState().setComment("Deliberate later recovery Save"));
    mocks.writeGame.mockResolvedValueOnce({ stamp: emptyStamp, revision: "later-recovery-cas" });
    mocks.readFileGame.mockResolvedValueOnce(stampedGame(changedStamp));
    await act(async () =>
      expect(
        saveToFile({
          tab: admitted,
          store: treeStore,
          getTab: (id) => jotaiStore.get(tabsAtom).find((candidate) => candidate.value === id),
          updateTab: (id, update, onAdmitted) =>
            updateTabById(
              (next, active, saved) => jotaiStore.set(tabsAtom, next, active, saved),
              id,
              update,
              onAdmitted,
            ),
          isUserSave: true,
        }),
      ).resolves.toBe("saved"),
    );
    expect(mocks.writeGame).toHaveBeenLastCalledWith(file.handle, 7, expect.any(String), {
      kind: "game",
      stamp: changedStamp,
    });
    expect(mocks.pickPgnFile).toHaveBeenCalledOnce();
  },
);

function subscribeForeignRecoveryReplacement(
  kind: "physical" | "origin",
  candidate: ReturnType<typeof defaultTree>,
  failureMessage: string,
) {
  const replacement: {
    replaced: boolean;
    foreign?: Tab;
    treeKey?: string;
    current?: ReturnType<typeof treeStore.getState>;
  } = { replaced: false };
  const unsubscribe = jotaiStore.sub(tabsAtom, () => {
    if (replacement.replaced) return;
    replacement.replaced = true;
    const admitted = jotaiStore.get(tabsAtom)[0]!;
    const foreign = {
      ...admitted,
      ...(kind === "physical"
        ? { treeKey: crypto.randomUUID() }
        : { gameOrigin: fileTab.gameOrigin }),
    };
    const treeKey = getTabTreeKey(foreign);
    replacement.foreign = foreign;
    replacement.treeKey = treeKey;
    tabStorage.seed(treeKey, candidate);
    jotaiStore.set(tabsAtom, [foreign], undefined, () =>
      retargetTreeStore(tabId, treeKey, candidate),
    );
    replacement.current = treeStore.getState();
    setFileFreshness(tabId, "conflict");
    throw new Error(failureMessage);
  });
  return {
    replacement,
    cleanup() {
      unsubscribe();
      if (replacement.treeKey && replacement.treeKey !== tabId)
        tabStorage.remove(replacement.treeKey);
    },
  };
}

test.each(["physical", "origin"] as const)(
  "recovery suppresses subscriber failure after reentrant foreign %s replacement",
  async (kind) => {
    const { pending, completion } = await startPendingAppend(true);
    const candidate = {
      ...defaultTree(),
      sourceStamp: emptyStamp,
      dirty: true,
      appendAttempted: true,
    };
    candidate.root.comment = "Reentrant recovery replacement";
    const { replacement, cleanup } = subscribeForeignRecoveryReplacement(
      kind,
      candidate,
      "Foreign recovery subscriber failure",
    );
    try {
      await act(async () =>
        pending.resolve({ stamp: changedStamp, revision: "obsolete-admitted" }),
      );
      expect(await completion).toEqual({ result: false });
      expect(replacement.replaced).toBe(true);
      expect(jotaiStore.get(tabsAtom)[0]).toEqual(replacement.foreign);
      expect(treeStore.getState()).toBe(replacement.current);
      expect(getFileFreshness(tabId).state).toBe("conflict");
      expect(host.textContent).not.toContain("Foreign recovery subscriber failure");
      tabStorage.flush();
      expect(new TabStorageRepository().read(replacement.treeKey!)?.state).toMatchObject(candidate);
    } finally {
      cleanup();
    }
  },
);

test("direct recovery notifies once when admitted subscriber failure hides its panel", async () => {
  const { pending } = await startPendingAppend(false);
  const unsubscribe = jotaiStore.sub(tabsAtom, () => {
    throw new Error("Direct recovery workspace subscriber failed");
  });
  try {
    await act(async () => pending.resolve({ stamp: changedStamp, revision: "direct-subscriber" }));
  } finally {
    unsubscribe();
  }
  expect(host.querySelector('[data-testid="board-and-panels"]')).not.toBeNull();
  expect(mocks.showNotification).toHaveBeenCalledExactlyOnceWith({
    color: "danger",
    title: "Common.Error",
    message: expect.stringContaining("Direct recovery workspace subscriber failed"),
  });
  expect(treeStore.getState()).toMatchObject({
    dirty: false,
    sourceStamp: changedStamp,
    appendAttempted: false,
  });
});

test.each(["success", "failure"] as const)(
  "settled admitted %s releases controls and admits another direct recovery",
  async (outcome) => {
    const { pending } = await startPendingAppend(false);
    const unsubscribe = jotaiStore.sub(tabsAtom, () => {
      if (outcome === "failure") throw new Error("Settled recovery subscriber failed");
    });
    try {
      await act(async () => pending.resolve({ stamp: changedStamp, revision: "settled-admitted" }));
    } finally {
      unsubscribe();
    }
    expect(getFileFreshness(tabId).state).toBe("verified");
    await act(async () => setFileFreshness(tabId, "conflict"));
    expect(button("FileFreshness.ReloadFromDisk").disabled).toBe(false);
    expect(button("FileFreshness.SaveAsNewGame").disabled).toBe(false);
    await act(async () => setFileFreshness(tabId, "unavailable"));
    expect(button("FileFreshness.SaveAsNewGame").disabled).toBe(false);
    expect(button("Tab.Close").disabled).toBe(false);
    const second = deferred<AppendResult>();
    mocks.pickPgnFile.mockResolvedValueOnce({ ...file, numGames: 8 });
    mocks.writeGame.mockReturnValueOnce(second.promise);
    await act(async () => button("FileFreshness.SaveAsNewGame").click());
    expect(mocks.writeGame).toHaveBeenCalledTimes(2);
    expect(mocks.writeGame).toHaveBeenLastCalledWith(file.handle, 8, expect.any(String), {
      kind: "append",
    });
    expect(button("FileFreshness.SaveAsNewGame").disabled).toBe(true);
    expect(button("Tab.Close").disabled).toBe(true);
    await act(async () => button("FileFreshness.SaveAsNewGame").click());
    expect(mocks.writeGame).toHaveBeenCalledTimes(2);
    await act(async () => second.resolve({ stamp: emptyStamp, revision: "second-admitted" }));
    await act(async () => setFileFreshness(tabId, "unavailable"));
    expect(button("FileFreshness.SaveAsNewGame").disabled).toBe(false);
    expect(button("Tab.Close").disabled).toBe(false);
  },
);

test("unmounted direct recovery suppresses its late failure notification and UI cleanup", async () => {
  const { pending, signal } = await startPendingAppend(false);
  const current = treeStore.getState();
  const freshness = getFileFreshness(tabId);
  await act(async () => root.unmount());
  expect(signal.aborted).toBe(true);
  await act(async () => pending.reject(new Error("Late direct recovery failure")));
  expect(mocks.showNotification).not.toHaveBeenCalled();
  expect(treeStore.getState()).toBe(current);
  expect(getFileFreshness(tabId)).toBe(freshness);
  expect(host.textContent).toBe("");
});

test.each(["physical", "origin"] as const)(
  "direct recovery suppresses notification after foreign %s replacement throws",
  async (kind) => {
    const { pending } = await startPendingAppend(false);
    const candidate = {
      ...defaultTree(),
      dirty: true,
      sourceStamp: emptyStamp,
      appendAttempted: false,
    };
    candidate.root.comment = "Foreign direct recovery";
    const { replacement, cleanup } = subscribeForeignRecoveryReplacement(
      kind,
      candidate,
      "Foreign direct subscriber failed",
    );
    try {
      await act(async () =>
        pending.resolve({ stamp: changedStamp, revision: "foreign-direct-admitted" }),
      );
      expect(replacement.replaced).toBe(true);
      expect(treeStore.getState()).toBe(replacement.current);
      expect(mocks.showNotification).not.toHaveBeenCalled();
      expect(host.textContent).not.toContain("Foreign direct subscriber failed");
    } finally {
      cleanup();
    }
  },
);

test("a failed storage flush aborts append, clears its marker, and reports persistence failure", async () => {
  mocks.readFileGame.mockResolvedValueOnce(stampedGame(changedStamp));
  await setup({ dirty: true, persisted: true });
  await vi.waitFor(() => expect(getFileFreshness(tabId).state).toBe("conflict"));
  const storageError = new Error("session storage quota exceeded");
  const flush = vi.spyOn(tabStorage, "flush").mockImplementation(({ notify = false } = {}) => {
    if (notify) mocks.reportPersistError(storageError);
    return [tabId];
  });

  await act(async () => button("FileFreshness.SaveAsNewGame").click());

  expect(mocks.writeGame).not.toHaveBeenCalled();
  expect(treeStore.getState().appendAttempted).toBe(false);
  expect(flush.mock.calls[1]?.[0]).toEqual({ notify: true });
  expect(mocks.reportPersistError).toHaveBeenCalledWith(storageError);
  expect(host.textContent).toContain("FileFreshness.CouldNotPrepareAppend");
  flush.mockRestore();
  tabStorage.flush();
});

test("physical-key marker refusal prevents native append for a distinct logical owner", async () => {
  const treeKey = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  mocks.readFileGame.mockResolvedValueOnce(stampedGame(changedStamp));
  await setup({ dirty: true, persisted: true, tab: { ...fileTab, treeKey } });
  await vi.waitFor(() => expect(getFileFreshness(tabId).state).toBe("conflict"));
  const set = Storage.prototype.setItem;
  const refuse = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(function (this: Storage, key, value) {
      if (key === treeKey) throw new DOMException("full", "QuotaExceededError");
      return set.call(this, key, value);
    });
  await act(async () => button("FileFreshness.SaveAsNewGame").click());
  expect(mocks.writeGame).not.toHaveBeenCalled();
  expect(treeStore.getState().appendAttempted).toBe(false);
  expect(host.textContent).toContain("FileFreshness.CouldNotPrepareAppend");
  refuse.mockRestore();
  expect(tabStorage.flush()).toEqual([]);
});

test("an uncertain append stays disabled across a persisted restart marker", async () => {
  mocks.readFileGame.mockResolvedValueOnce(stampedGame(changedStamp));
  await setup({ dirty: true, persisted: true });
  await vi.waitFor(() => expect(getFileFreshness(tabId).state).toBe("conflict"));
  mocks.writeGame.mockResolvedValueOnce({ stamp: null, revision: null });

  await act(async () => button("FileFreshness.SaveAsNewGame").click());

  expect(treeStore.getState().appendAttempted).toBe(true);
  expect(tabStorage.read(tabId)?.state).toMatchObject({ appendAttempted: true, dirty: true });
  expect(button("FileFreshness.SaveAsNewGame").disabled).toBe(true);
  expect(host.textContent).toContain("FileFreshness.AppendMayHaveBeenAdded");
  expect(mocks.writeGame).toHaveBeenCalledOnce();
});

test("a persisted uncertain append marker keeps the board withheld even when the source stamp matches", async () => {
  await setup({ dirty: true, appendAttempted: true });

  await vi.waitFor(() => expect(getFileFreshness(tabId).state).toBe("conflict"));

  expect(host.querySelector('[data-testid="board-and-panels"]')).toBeNull();
  expect(host.textContent).toContain("FileFreshness.AppendMayHaveBeenAdded");
  expect(button("FileFreshness.SaveAsNewGame").disabled).toBe(true);
  expect(button("FileFreshness.ReloadFromDisk").disabled).toBe(false);
});

test("Reload from disk clears append uncertainty and restores verified children", async () => {
  mocks.readFileGame.mockResolvedValueOnce(stampedGame(changedStamp));
  await setup({ dirty: true, appendAttempted: true });
  await vi.waitFor(() => expect(getFileFreshness(tabId).state).toBe("conflict"));

  await act(async () => button("FileFreshness.ReloadFromDisk").click());

  expect(treeStore.getState()).toMatchObject({
    dirty: false,
    sourceStamp: changedStamp,
    appendAttempted: false,
  });
  expect(getFileFreshness(tabId).state).toBe("verified");
  expect(host.querySelector('[data-testid="board-and-panels"]')).not.toBeNull();
});

test("cancelled and stale appends leave the conflicting tree available for retry", async () => {
  mocks.readFileGame.mockResolvedValueOnce(stampedGame(changedStamp));
  await setup({ dirty: true });
  await vi.waitFor(() => expect(getFileFreshness(tabId).state).toBe("conflict"));
  mocks.pickPgnFile.mockResolvedValueOnce(null);

  await act(async () => button("FileFreshness.SaveAsNewGame").click());
  expect(getFileFreshness(tabId).state).toBe("conflict");
  expect(treeStore.getState().headers.event).toBe("Unsaved edit");
  expect(mocks.writeGame).not.toHaveBeenCalled();

  const stale = new Error("The game changed on disk");
  Object.assign(stale, {
    details: { category: "validation", backendCategory: "stale-game", message: stale.message },
  });
  mocks.writeGame.mockRejectedValueOnce(stale);
  await act(async () => button("FileFreshness.SaveAsNewGame").click());
  expect(treeStore.getState().appendAttempted).toBe(false);
  expect(button("FileFreshness.SaveAsNewGame").disabled).toBe(false);
  expect(host.textContent).toContain("FileFreshness.AppendChanged");
  expect(mocks.showNotification).not.toHaveBeenCalled();
});

test.each([
  ["reload", "invalid-input", "unavailable"],
  ["append", "invalid-input", "unavailable"],
  ["reload", "io", "conflict"],
  ["append", "io", "conflict"],
] as const)(
  "%s action failures with %s keep the expected freshness panel",
  async (action, category, state) => {
    mocks.readFileGame.mockResolvedValueOnce(stampedGame(changedStamp));
    await setup({ dirty: true });
    await vi.waitFor(() => expect(getFileFreshness(tabId).state).toBe("conflict"));
    const message = `${action} ${category} failure`;
    const failure = { tag: "backend-error", category, message };
    if (action === "reload") mocks.loadFileGame.mockRejectedValueOnce(failure);
    else mocks.writeGame.mockRejectedValueOnce(failure);

    await act(async () =>
      button(
        action === "reload" ? "FileFreshness.ReloadFromDisk" : "FileFreshness.SaveAsNewGame",
      ).click(),
    );

    await vi.waitFor(() => expect(getFileFreshness(tabId).state).toBe(state));
    expect(host.textContent).toContain(message);
    expect(host.querySelector('[data-testid="board-and-panels"]')).toBeNull();
  },
);

test("the appending state withholds children and starts no reconcile", async () => {
  await setup({ freshness: "appending" });
  expect(host.querySelector('[data-testid="board-and-panels"]')).toBeNull();
  expect(host.textContent).toContain("FileFreshness.AddingGame");
  expect(mocks.readFileGame).not.toHaveBeenCalled();
});

test("a changed poll revision reconciles a mounted gate before restoring its board", async () => {
  vi.useFakeTimers();
  await setup({ freshness: "verified" });
  mocks.readFileGame.mockResolvedValueOnce(
    stampedGame(changedStamp, '[Event "Fresh from disk"]\n\n1. d4 *'),
  );
  const fileRevision = vi.fn(async () => "fresh-revision");
  const stop = startFileRevisionPoll({
    getTabs: () => jotaiStore.get(tabsAtom),
    fileRevision,
    subscribeFocus: () => () => undefined,
  });

  await act(async () => vi.advanceTimersByTimeAsync(2_000));

  expect(fileRevision).toHaveBeenCalledOnce();
  expect(mocks.readFileGame).toHaveBeenCalledOnce();
  expect(getFileFreshness(tabId).state).toBe("verified");
  expect(treeStore.getState().sourceStamp).toBe(changedStamp);
  expect(treeStore.getState().headers.event).toBe("Fresh from disk");
  expect(host.querySelector('[data-testid="board-and-panels"]')).not.toBeNull();
  stop();
});

test("one changed shared handle reconciles every mounted tab that references it", async () => {
  vi.useFakeTimers();
  const secondTab: Tab = { ...fileTab, value: sharedTabId, name: "Shared game copy" };
  const firstTree = defaultTree();
  firstTree.sourceStamp = originalStamp;
  const secondTree = defaultTree();
  secondTree.sourceStamp = originalStamp;
  treeStore = createTreeStore(undefined, firstTree);
  const secondStore = createTreeStore(undefined, secondTree);
  jotaiStore = createJotaiStore();
  jotaiStore.set(tabsAtom, [fileTab, secondTab], tabId);
  jotaiStore.set(activeTabAtom, tabId);
  setFileFreshness(tabId, "verified", { verifiedRevision: "old-revision" });
  setFileFreshness(sharedTabId, "verified", { verifiedRevision: "old-revision" });
  mocks.readFileGame.mockResolvedValue(
    stampedGame(changedStamp, '[Event "Shared fresh"]\n\n1. d4 *'),
  );
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root.render(
      <Provider store={jotaiStore}>
        <SharedGateHarness secondTab={secondTab} secondStore={secondStore} />
      </Provider>,
    ),
  );
  const fileRevision = vi.fn(async () => "new-revision");
  const stop = startFileRevisionPoll({
    getTabs: () => jotaiStore.get(tabsAtom),
    fileRevision,
    subscribeFocus: () => () => undefined,
  });

  await act(async () => vi.advanceTimersByTimeAsync(2_000));

  expect(fileRevision).toHaveBeenCalledOnce();
  expect(mocks.readFileGame).toHaveBeenCalledTimes(2);
  expect(getFileFreshness(tabId).state).toBe("verified");
  expect(getFileFreshness(sharedTabId).state).toBe("verified");
  expect(treeStore.getState().sourceStamp).toBe(changedStamp);
  expect(secondStore.getState().sourceStamp).toBe(changedStamp);
  expect(host.querySelector('[data-testid="first-shared-board"]')).not.toBeNull();
  expect(host.querySelector('[data-testid="second-shared-board"]')).not.toBeNull();
  stop();
});

test("a poll result during a held append is deferred and starts no reconcile read", async () => {
  vi.useFakeTimers();
  await setup({ freshness: "appending" });
  const append = deferred<void>();
  const appendSettled = append.promise.then(() => setFileFreshness(tabId, "unverified"));
  mocks.readFileGame.mockResolvedValueOnce(
    stampedGame(changedStamp, '[Event "Fresh after append"]\n\n1. d4 *'),
  );
  const fileRevision = vi.fn(async () => "new-revision");
  const stop = startFileRevisionPoll({
    getTabs: () => jotaiStore.get(tabsAtom),
    fileRevision,
    subscribeFocus: () => () => undefined,
  });

  await act(async () => vi.advanceTimersByTimeAsync(2_000));
  expect(fileRevision).toHaveBeenCalledOnce();
  expect(getFileFreshness(tabId).state).toBe("appending");
  expect(mocks.readFileGame).not.toHaveBeenCalled();
  expect(host.querySelector('[data-testid="board-and-panels"]')).toBeNull();

  await act(async () => {
    append.resolve();
    await appendSettled;
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
  });

  expect(mocks.readFileGame).toHaveBeenCalledOnce();
  expect(getFileFreshness(tabId).state).toBe("verified");
  expect(treeStore.getState().sourceStamp).toBe(changedStamp);
  expect(host.querySelector('[data-testid="board-and-panels"]')).not.toBeNull();
  stop();
});

test("a generic poll rejection keeps the gate withheld with its message and Retry", async () => {
  vi.useFakeTimers();
  await setup({ freshness: "verified" });
  const pendingRead = deferred<ReturnType<typeof stampedGame>>();
  mocks.readFileGame.mockReturnValueOnce(pendingRead.promise);
  const fileRevision = vi.fn(async () => {
    throw {
      tag: "backend-error",
      category: "io",
      message: "revision access failed",
    };
  });
  const stop = startFileRevisionPoll({
    getTabs: () => jotaiStore.get(tabsAtom),
    fileRevision,
    subscribeFocus: () => () => undefined,
  });

  await act(async () => vi.advanceTimersByTimeAsync(2_000));

  expect(getFileFreshness(tabId)).toMatchObject({
    state: "unverified",
    errorMessage: "revision access failed",
  });
  expect(mocks.readFileGame).toHaveBeenCalledOnce();
  expect(host.textContent).toContain("revision access failed");
  expect(host.textContent).toContain("FileFreshness.Retry");
  expect(host.querySelector('[data-testid="board-and-panels"]')).toBeNull();

  stop();
  await act(async () => {
    pendingRead.reject(new Error("read settled after stop"));
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
  });
});

test("an unverified reconcile completes after five seconds of poll outcomes", async () => {
  vi.useFakeTimers();
  const pendingRead = deferred<ReturnType<typeof stampedGame>>();
  mocks.readFileGame.mockReturnValueOnce(pendingRead.promise);
  await setup({ freshness: "unverified" });
  const initial = getFileFreshness(tabId);
  const fileRevision = vi.fn().mockResolvedValueOnce("poll-revision-1").mockRejectedValueOnce({
    tag: "backend-error",
    category: "io",
    message: "first poll failure",
  });
  const stop = startFileRevisionPoll({
    getTabs: () => jotaiStore.get(tabsAtom),
    fileRevision,
    subscribeFocus: () => () => undefined,
  });

  await act(async () => vi.advanceTimersByTimeAsync(2_000));
  expect(getFileFreshness(tabId)).toMatchObject({ state: "unverified", epoch: initial.epoch });
  expect(mocks.readFileGame).toHaveBeenCalledOnce();

  await act(async () => vi.advanceTimersByTimeAsync(2_000));
  expect(getFileFreshness(tabId)).toMatchObject({
    state: "unverified",
    errorMessage: "first poll failure",
    epoch: initial.epoch,
  });
  expect(mocks.readFileGame).toHaveBeenCalledOnce();

  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
    pendingRead.resolve(stampedGame(originalStamp));
    for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
  });

  expect(getFileFreshness(tabId)).toMatchObject({
    state: "verified",
    verifiedRevision: "device:inode:revision",
  });
  expect(mocks.readFileGame).toHaveBeenCalledOnce();
  expect(host.querySelector('[data-testid="board-and-panels"]')).not.toBeNull();
  stop();
});

test("an overdue poll withholds without a gate read until a settled request gets a fresh answer", async () => {
  vi.useFakeTimers();
  await setup({ freshness: "verified" });
  const first = deferred<string>();
  const signals: AbortSignal[] = [];
  const fileRevision = vi.fn((_handle, options: { signal: AbortSignal }) => {
    signals.push(options.signal);
    return signals.length === 1 ? first.promise : Promise.resolve("fresh-revision");
  });
  mocks.readFileGame.mockResolvedValueOnce(
    stampedGame(changedStamp, '[Event "Fresh after timeout"]\n\n1. d4 *'),
  );
  const stop = startFileRevisionPoll({
    getTabs: () => jotaiStore.get(tabsAtom),
    fileRevision,
    subscribeFocus: () => () => undefined,
  });

  await act(async () => vi.advanceTimersByTimeAsync(2_000));
  await act(async () => vi.advanceTimersByTimeAsync(2_000));
  expect(signals[0].aborted).toBe(true);
  expect(fileRevision).toHaveBeenCalledOnce();
  expect(getFileFreshness(tabId).state).toBe("overdue");
  expect(host.textContent).toContain("FileFreshness.FileNotResponding");
  expect(host.querySelector('[data-testid="board-and-panels"]')).toBeNull();
  expect(mocks.readFileGame).not.toHaveBeenCalled();

  await act(async () => {
    first.reject(new Error("native cancellation settled"));
    for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
  });

  expect(fileRevision).toHaveBeenCalledTimes(2);
  expect(mocks.readFileGame).toHaveBeenCalledOnce();
  expect(getFileFreshness(tabId).state).toBe("verified");
  expect(treeStore.getState().sourceStamp).toBe(changedStamp);
  expect(treeStore.getState().headers.event).toBe("Fresh after timeout");
  expect(host.querySelector('[data-testid="board-and-panels"]')).not.toBeNull();
  stop();
});

test("a pending reload disables append until the reload settles", async () => {
  mocks.readFileGame.mockResolvedValueOnce(stampedGame(changedStamp));
  await setup({ dirty: true });
  await vi.waitFor(() => expect(getFileFreshness(tabId).state).toBe("conflict"));
  const pendingLoad = deferred<{
    pgn: string;
    stamp: string;
    revision: string;
    present: boolean;
    tree: ReturnType<typeof defaultTree>;
  }>();
  mocks.loadFileGame.mockReturnValueOnce(pendingLoad.promise);

  await act(async () => button("FileFreshness.ReloadFromDisk").click());

  expect(button("FileFreshness.SaveAsNewGame").disabled).toBe(true);
  await act(async () => button("FileFreshness.SaveAsNewGame").click());
  expect(mocks.pickPgnFile).not.toHaveBeenCalled();
  const tree = defaultTree();
  tree.sourceStamp = changedStamp;
  await act(async () =>
    pendingLoad.resolve({
      pgn: "fresh",
      stamp: changedStamp,
      revision: "reload",
      present: true,
      tree,
    }),
  );
  expect(getFileFreshness(tabId).state).toBe("verified");
});

test("a pending reload cannot overwrite a replacement with only its physical generation changed", async () => {
  mocks.readFileGame.mockResolvedValueOnce(stampedGame(changedStamp));
  await setup({ dirty: true, persisted: true });
  await vi.waitFor(() => expect(getFileFreshness(tabId).state).toBe("conflict"));
  const pendingLoad =
    deferred<Awaited<ReturnType<(typeof import("@/utils/files"))["loadFileGame"]>>>();
  mocks.loadFileGame.mockReturnValueOnce(pendingLoad.promise);
  await act(async () => button("FileFreshness.ReloadFromDisk").click());
  expect(mocks.loadFileGame).toHaveBeenCalledWith(file.handle, 0, expect.any(AbortSignal));
  const signal = mocks.loadFileGame.mock.calls[0]![2] as AbortSignal;
  const originalTab = jotaiStore.get(tabsAtom)[0]!;
  const candidate = defaultTree();
  candidate.headers.event = "Replacement generation";
  candidate.sourceStamp = "c".repeat(64);
  const treeKey = crypto.randomUUID();
  tabStorage.seed(treeKey, candidate);
  await act(async () => {
    expect(
      jotaiStore.set(tabsAtom, [{ ...originalTab, treeKey }], undefined, () =>
        retargetTreeStore(tabId, treeKey, candidate),
      ),
    ).toBe(true);
    setFileFreshness(tabId, "verified", { verifiedRevision: "replacement-generation" });
  });
  expect(signal.aborted).toBe(false);
  expect(createTreeStore(tabId)).toBe(treeStore);
  expect(jotaiStore.get(tabsAtom)[0]?.gameOrigin).toEqual(originalTab.gameOrigin);
  const current = treeStore.getState();
  const freshness = getFileFreshness(tabId);
  const old = defaultTree();
  old.headers.event = "Obsolete reload";
  old.sourceStamp = changedStamp;
  await act(async () => pendingLoad.resolve({ ...stampedGame(changedStamp), tree: old }));
  expect(treeStore.getState()).toBe(current);
  expect(getFileFreshness(tabId)).toBe(freshness);
  expect(treeStore.getState().headers.event).toBe("Replacement generation");
  expect(host.querySelector('[data-testid="board-and-panels"]')).not.toBeNull();
});

const reloadFailures = ["missing-resource", "invalid-input", "conflict", "io"] as const;

async function startPendingReload() {
  mocks.readFileGame.mockResolvedValueOnce(stampedGame(changedStamp));
  await setup({ dirty: true, persisted: true });
  await vi.waitFor(() => expect(getFileFreshness(tabId).state).toBe("conflict"));
  const pendingLoad =
    deferred<Awaited<ReturnType<(typeof import("@/utils/files"))["loadFileGame"]>>>();
  mocks.loadFileGame.mockReturnValueOnce(pendingLoad.promise);
  await act(async () => button("FileFreshness.ReloadFromDisk").click());
  expect(mocks.loadFileGame).toHaveBeenCalledWith(file.handle, 0, expect.any(AbortSignal));
  const signal = mocks.loadFileGame.mock.calls[0]![2] as AbortSignal;
  expect(signal.aborted).toBe(false);
  return { pendingLoad, signal };
}

test.each(reloadFailures)(
  "obsolete physical-generation reload rejection with %s preserves its durable replacement",
  async (category) => {
    const { pendingLoad, signal } = await startPendingReload();
    const originalTab = jotaiStore.get(tabsAtom)[0]!;
    const candidate = defaultTree();
    candidate.headers.event = "Durable rejection replacement";
    candidate.root.comment = "Replacement comment";
    candidate.sourceStamp = "c".repeat(64);
    const treeKey = crypto.randomUUID();
    tabStorage.seed(treeKey, candidate);
    const seedBytes = sessionStorage.getItem(treeKey);
    expect(new TabStorageRepository().read(treeKey)?.state).toEqual(candidate);
    await act(async () => {
      expect(
        jotaiStore.set(tabsAtom, [{ ...originalTab, treeKey }], undefined, () =>
          retargetTreeStore(tabId, treeKey, candidate),
        ),
      ).toBe(true);
      setFileFreshness(tabId, "verified", { verifiedRevision: "replacement-generation" });
    });
    expect(treeKey).not.toBe(getTabTreeKey(originalTab));
    expect(jotaiStore.get(tabsAtom)).toEqual([{ ...originalTab, treeKey }]);
    expect(jotaiStore.get(activeTabAtom)).toBe(tabId);
    expect(createTreeStore(tabId)).toBe(treeStore);
    expect(signal.aborted).toBe(false);
    expect(tabStorage.flush()).toEqual([]);
    const durableTree = candidate;
    expect(new TabStorageRepository().read(treeKey)?.state).toEqual(durableTree);
    expect(sessionStorage.getItem(treeKey)).toBe(seedBytes);
    const durableBytes = sessionStorage.getItem(treeKey);
    expect(durableBytes).not.toBeNull();
    const current = treeStore.getState();
    const freshness = getFileFreshness(tabId);
    const message = `obsolete reload ${category} failure`;

    await act(async () => pendingLoad.reject({ tag: "backend-error", category, message }));

    expect(signal.aborted).toBe(false);
    expect(treeStore.getState()).toBe(current);
    expect(getFileFreshness(tabId)).toBe(freshness);
    expect(host.querySelector('[data-testid="board-and-panels"]')).not.toBeNull();
    expect(host.textContent).not.toContain(message);
    expect(tabStorage.flush()).toEqual([]);
    expect(sessionStorage.getItem(treeKey)).toBe(durableBytes);
    expect(new TabStorageRepository().read(treeKey)?.state).toEqual(durableTree);
    // A verified board hides the panel, so reveal it to detect a retained stale error.
    await act(async () => setFileFreshness(tabId, "conflict", { conflictReason: "changed" }));
    expect(host.textContent).toContain("FileFreshness.Changed");
    expect(host.textContent).not.toContain(message);
    expect(button("FileFreshness.ReloadFromDisk").disabled).toBe(false);
    expect(treeStore.getState()).toBe(current);
  },
);

test.each(reloadFailures)(
  "current-owner reload rejection with %s surfaces its error",
  async (category) => {
    const { pendingLoad, signal } = await startPendingReload();
    const current = treeStore.getState();
    const message = `current reload ${category} failure`;
    await act(async () => pendingLoad.reject({ tag: "backend-error", category, message }));

    expect(signal.aborted).toBe(false);
    expect(treeStore.getState()).toBe(current);
    expect(getFileFreshness(tabId).state).toBe(category === "io" ? "conflict" : "unavailable");
    expect(host.textContent).toContain(message);
    expect(host.querySelector('[data-testid="board-and-panels"]')).toBeNull();
    expect(button("FileFreshness.SaveAsNewGame").disabled).toBe(false);
  },
);

test("unmount aborts a pending reload and suppresses its late rejection", async () => {
  const { pendingLoad, signal } = await startPendingReload();
  const current = treeStore.getState();
  const freshness = getFileFreshness(tabId);
  await act(async () => root.unmount());
  expect(signal.aborted).toBe(true);

  await act(async () =>
    pendingLoad.reject({
      tag: "backend-error",
      category: "missing-resource",
      message: "late unmounted reload failure",
    }),
  );

  expect(treeStore.getState()).toBe(current);
  expect(getFileFreshness(tabId)).toBe(freshness);
  expect(host.textContent).toBe("");
});

test("a reconcile invalidated by a newer epoch cannot release stale children", async () => {
  const read = deferred<ReturnType<typeof stampedGame>>();
  mocks.readFileGame.mockReturnValueOnce(read.promise);
  await setup();
  setFileFreshness(tabId, "conflict", { conflictReason: "changed" });

  await act(async () => read.resolve(stampedGame(originalStamp)));

  expect(getFileFreshness(tabId).state).toBe("conflict");
  expect(host.querySelector('[data-testid="board-and-panels"]')).toBeNull();
});

const appendFailures = ["stale-game", ...reloadFailures] as const;
const appendFulfillments = [
  "stamped",
  "unknown-stamp",
  "unknown-revision",
  "unknown-both",
] as const;
const appendOutcomes = [...appendFulfillments, ...appendFailures] as const;
type AppendOutcome = (typeof appendOutcomes)[number];
type AppendResult = { stamp: string | null; revision: string | null };

async function startPendingAppend(registered = false) {
  mocks.readFileGame.mockResolvedValueOnce(stampedGame(changedStamp));
  await setup({ dirty: true, persisted: true });
  await vi.waitFor(() => expect(getFileFreshness(tabId).state).toBe("conflict"));
  const signalGetter = Object.getOwnPropertyDescriptor(AbortController.prototype, "signal")!.get!;
  const signals = new Set<AbortSignal>();
  const capture = vi
    .spyOn(AbortController.prototype, "signal", "get")
    .mockImplementation(function (this: AbortController) {
      const signal = signalGetter.call(this) as AbortSignal;
      signals.add(signal);
      return signal;
    });
  const pending = deferred<AppendResult>();
  mocks.writeGame.mockReturnValueOnce(pending.promise);
  let completion: Promise<{ result: boolean } | { error: unknown }> | undefined;
  await act(async () => {
    if (registered) {
      completion = saveFileConflictVersion(tabId).then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
    } else button("FileFreshness.SaveAsNewGame").click();
  });
  capture.mockRestore();
  expect(signals.size).toBe(1);
  const signal = [...signals][0]!;
  expect(signal.aborted).toBe(false);
  expect(mocks.writeGame).toHaveBeenCalledWith(file.handle, 7, serializeStoreTree(treeStore), {
    kind: "append",
  });
  expect(new TabStorageRepository().read(tabId)?.state).toMatchObject({
    appendAttempted: true,
    dirty: true,
  });
  return { pending, signal, completion };
}

async function installAppendReplacement(appendAttempted: boolean) {
  const originalTab = jotaiStore.get(tabsAtom)[0]!;
  const candidate = defaultTree();
  candidate.headers.event = "Durable append replacement";
  candidate.root.comment = "Replacement append comment";
  candidate.sourceStamp = "c".repeat(64);
  candidate.appendAttempted = appendAttempted;
  const treeKey = crypto.randomUUID();
  tabStorage.seed(treeKey, candidate);
  const seedBytes = sessionStorage.getItem(treeKey);
  expect(new TabStorageRepository().read(treeKey)?.state).toEqual(candidate);
  await act(async () => {
    expect(
      jotaiStore.set(tabsAtom, [{ ...originalTab, treeKey }], undefined, () =>
        retargetTreeStore(tabId, treeKey, candidate),
      ),
    ).toBe(true);
    setFileFreshness(tabId, "verified", { verifiedRevision: "append-replacement-generation" });
  });
  expect(treeKey).not.toBe(getTabTreeKey(originalTab));
  expect(jotaiStore.get(tabsAtom)).toEqual([{ ...originalTab, treeKey }]);
  expect(jotaiStore.get(activeTabAtom)).toBe(tabId);
  expect(createTreeStore(tabId)).toBe(treeStore);
  expect(tabStorage.flush()).toEqual([]);
  const durableTree = candidate;
  expect(new TabStorageRepository().read(treeKey)?.state).toEqual(durableTree);
  expect(sessionStorage.getItem(treeKey)).toBe(seedBytes);
  const durableBytes = sessionStorage.getItem(treeKey);
  expect(durableBytes).not.toBeNull();
  return {
    treeKey,
    durableTree,
    durableBytes,
    current: treeStore.getState(),
    freshness: getFileFreshness(tabId),
    tabs: jotaiStore.get(tabsAtom),
    workspaceBytes: sessionStorage.getItem(WORKSPACE_STORAGE_KEY),
  };
}

function settleAppend(pending: ReturnType<typeof deferred<AppendResult>>, outcome: AppendOutcome) {
  if (outcome === "stamped" || outcome.startsWith("unknown-")) {
    pending.resolve({
      stamp: outcome === "unknown-stamp" || outcome === "unknown-both" ? null : changedStamp,
      revision:
        outcome === "unknown-revision" || outcome === "unknown-both" ? null : "obsolete-append",
    });
  } else {
    pending.reject({ tag: "backend-error", category: outcome, message: `late append ${outcome}` });
  }
}

function expectAppendReplacement(
  replacement: Awaited<ReturnType<typeof installAppendReplacement>>,
) {
  expect(treeStore.getState()).toBe(replacement.current);
  expect(getFileFreshness(tabId)).toBe(replacement.freshness);
  expect(jotaiStore.get(tabsAtom)).toBe(replacement.tabs);
  expect(replacement.workspaceBytes).not.toBeNull();
  expect(sessionStorage.getItem(WORKSPACE_STORAGE_KEY)).toBe(replacement.workspaceBytes);
  expect(treeStore.getState()).toMatchObject({
    headers: { event: "Durable append replacement" },
    root: { comment: "Replacement append comment" },
    sourceStamp: "c".repeat(64),
    appendAttempted: replacement.durableTree.appendAttempted,
  });
  expect(tabStorage.flush()).toEqual([]);
  expect(sessionStorage.getItem(replacement.treeKey)).toBe(replacement.durableBytes);
  expect(new TabStorageRepository().read(replacement.treeKey)?.state).toEqual(
    replacement.durableTree,
  );
}

test.each(appendOutcomes)(
  "obsolete physical-generation append outcome %s leaves its durable replacement and later panel intact",
  async (outcome) => {
    const { pending, signal } = await startPendingAppend();
    // A nonempty replacement marker catches stale-count rejection clearing a new owner's uncertainty.
    const replacement = await installAppendReplacement(outcome === "stale-game");
    expect(signal.aborted).toBe(false);

    await act(async () => settleAppend(pending, outcome));

    expect(signal.aborted).toBe(false);
    expectAppendReplacement(replacement);
    expect(host.querySelector('[data-testid="board-and-panels"]')).not.toBeNull();
    await act(async () => setFileFreshness(tabId, "conflict", { conflictReason: "changed" }));
    expect(host.textContent).toContain("FileFreshness.Changed");
    expect(host.textContent).not.toContain(`late append ${outcome}`);
    expect(host.textContent).not.toContain("FileFreshness.AppendChanged");
    const uncertaintyMessages = Array.from(host.querySelectorAll("p")).filter(
      (element) => element.textContent === "FileFreshness.AppendMayHaveBeenAdded",
    );
    expect(uncertaintyMessages).toHaveLength(outcome === "stale-game" ? 1 : 0);
    expect(button("FileFreshness.SaveAsNewGame").disabled).toBe(outcome === "stale-game");
    expect(button("FileFreshness.ReloadFromDisk").disabled).toBe(false);
    expect(treeStore.getState()).toBe(replacement.current);
  },
);

async function startPendingPicker(route: "button" | "registered") {
  mocks.readFileGame.mockResolvedValueOnce(stampedGame(changedStamp));
  await setup({ dirty: true, persisted: true });
  await vi.waitFor(() => expect(getFileFreshness(tabId).state).toBe("conflict"));
  const picker = deferred<Awaited<ReturnType<(typeof import("@/utils/files"))["pickPgnFile"]>>>();
  mocks.pickPgnFile.mockReturnValueOnce(picker.promise);
  let completion: Promise<{ result: boolean } | { error: unknown }> | undefined;
  await act(async () => {
    if (route === "registered") {
      completion = saveFileConflictVersion(tabId).then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
    } else button("FileFreshness.SaveAsNewGame").click();
  });
  expect(mocks.pickPgnFile).toHaveBeenCalledOnce();
  return { picker, completion };
}

for (const route of ["button", "registered"] as const) {
  test.each(reloadFailures)(
    `obsolete physical-generation ${route} picker rejection with %s leaves its durable replacement and later panel intact`,
    async (category) => {
      const { picker, completion } = await startPendingPicker(route);
      const replacement = await installAppendReplacement(false);

      await act(async () =>
        picker.reject({ tag: "backend-error", category, message: `late picker ${category}` }),
      );

      expect(await completion).toEqual(route === "registered" ? { result: false } : undefined);
      expectAppendReplacement(replacement);
      expect(mocks.writeGame).not.toHaveBeenCalled();
      expect(mocks.showNotification).not.toHaveBeenCalled();
      await act(async () => setFileFreshness(tabId, "conflict", { conflictReason: "changed" }));
      expect(host.textContent).not.toContain(`late picker ${category}`);
      expect(host.textContent).toContain("FileFreshness.Changed");
      expect(button("FileFreshness.SaveAsNewGame").disabled).toBe(false);
    },
  );

  test.each(reloadFailures)(
    `unmount silences a pending ${route} picker rejection with %s`,
    async (category) => {
      const { picker, completion } = await startPendingPicker(route);
      const current = treeStore.getState();
      const freshness = getFileFreshness(tabId);
      expect(tabStorage.flush()).toEqual([]);
      const durableBytes = sessionStorage.getItem(tabId);
      await act(async () => root.unmount());

      await act(async () =>
        picker.reject({ tag: "backend-error", category, message: `late picker ${category}` }),
      );

      expect(await completion).toEqual(route === "registered" ? { result: false } : undefined);
      expect(treeStore.getState()).toBe(current);
      expect(getFileFreshness(tabId)).toBe(freshness);
      expect(tabStorage.flush()).toEqual([]);
      expect(sessionStorage.getItem(tabId)).toBe(durableBytes);
      expect(mocks.writeGame).not.toHaveBeenCalled();
      expect(mocks.showNotification).not.toHaveBeenCalled();
      expect(host.textContent).toBe("");
    },
  );

  test(`current-owner ${route} picker rejection surfaces its error`, async () => {
    const { picker, completion } = await startPendingPicker(route);

    await act(async () =>
      picker.reject({ tag: "backend-error", category: "io", message: "late picker io" }),
    );

    const failure = {
      error: expect.objectContaining({ backendCategory: "io", message: "late picker io" }),
    };
    expect(await completion).toEqual(route === "registered" ? failure : undefined);
    expect(host.textContent).toContain("late picker io");
    expect(mocks.writeGame).not.toHaveBeenCalled();
    expect(getFileFreshness(tabId).state).toBe("conflict");
    expect(button("FileFreshness.SaveAsNewGame").disabled).toBe(false);
  });
}

test.each(["stale-game", "io"] as const)(
  "registered append returns false for an obsolete %s rejection without damaging its replacement",
  async (outcome) => {
    const { pending, signal, completion } = await startPendingAppend(true);
    const replacement = await installAppendReplacement(true);
    await act(async () => settleAppend(pending, outcome));
    expect(await completion).toEqual({ result: false });
    expect(signal.aborted).toBe(false);
    expectAppendReplacement(replacement);
  },
);

test.each(appendOutcomes)(
  "unmount cancels a pending registered append and silences its late %s outcome",
  async (outcome) => {
    const { pending, signal, completion } = await startPendingAppend(true);
    expect(tabStorage.flush()).toEqual([]);
    const current = treeStore.getState();
    const freshness = getFileFreshness(tabId);
    new TabStorageRepository().read(tabId);
    const durableBytes = sessionStorage.getItem(tabId);
    await act(async () => root.unmount());
    expect(signal.aborted).toBe(true);

    await act(async () => settleAppend(pending, outcome));

    expect(await completion).toEqual({ result: false });
    expect(treeStore.getState()).toBe(current);
    expect(getFileFreshness(tabId)).toBe(freshness);
    expect(tabStorage.flush()).toEqual([]);
    expect(sessionStorage.getItem(tabId)).toBe(durableBytes);
    expect(host.textContent).toBe("");
  },
);

test.each(appendFailures)(
  "current-owner registered append rejection %s publishes its error and propagates failure",
  async (category) => {
    const { pending, signal, completion } = await startPendingAppend(true);
    await act(async () => settleAppend(pending, category));

    expect(await completion).toMatchObject({
      error: { backendCategory: category, message: `late append ${category}` },
    });
    expect(signal.aborted).toBe(false);
    expect(treeStore.getState().appendAttempted).toBe(category !== "stale-game");
    expect(new TabStorageRepository().read(tabId)?.state).toMatchObject({
      appendAttempted: category !== "stale-game",
      dirty: true,
      sourceStamp: originalStamp,
    });
    expect(getFileFreshness(tabId).state).toBe(
      category === "stale-game" || category === "io" ? "conflict" : "unavailable",
    );
    expect(host.textContent).toContain(
      category === "stale-game" ? "FileFreshness.AppendChanged" : `late append ${category}`,
    );
    expect(button("FileFreshness.SaveAsNewGame").disabled).toBe(category !== "stale-game");
  },
);

test.each(appendFulfillments.slice(1))(
  "current-owner %s append persists retry prohibition through a cold store restart",
  async (outcome) => {
    const { pending, completion } = await startPendingAppend(true);
    await act(async () => settleAppend(pending, outcome));
    expect(await completion).toEqual({ result: false });
    expect(host.textContent).toContain("FileFreshness.AppendMayHaveBeenAdded");
    expect(tabStorage.flush()).toEqual([]);
    expect(new TabStorageRepository().read(tabId)?.state).toMatchObject({ appendAttempted: true });
    const previousStore = treeStore;
    await act(async () => root.unmount());
    closeTreeStore(tabId);
    treeStore = createTreeStore(tabId);
    expect(treeStore).not.toBe(previousStore);
    expect(treeStore.getState()).toMatchObject({
      appendAttempted: true,
      dirty: true,
      headers: { event: "Unsaved edit" },
      sourceStamp: originalStamp,
    });
    root = createRoot(host);
    await act(async () => {
      setFileFreshness(tabId, "unverified");
      root.render(
        <Provider store={jotaiStore}>
          <Harness closeTab={() => undefined} />
        </Provider>,
      );
    });
    expect(host.querySelector('[data-testid="board-and-panels"]')).toBeNull();
    expect(button("FileFreshness.SaveAsNewGame").disabled).toBe(true);
    await act(async () => button("FileFreshness.SaveAsNewGame").click());
    expect(await saveFileConflictVersion(tabId)).toBe(false);
    expect(mocks.writeGame).toHaveBeenCalledOnce();
    expect(new TabStorageRepository().read(tabId)?.state).toMatchObject({ appendAttempted: true });
  },
);

test("current-owner stale-count rejection allows a real second append and verified save", async () => {
  const { pending, completion } = await startPendingAppend(true);
  await act(async () => settleAppend(pending, "stale-game"));
  expect(await completion).toMatchObject({ error: { backendCategory: "stale-game" } });
  expect(button("FileFreshness.SaveAsNewGame").disabled).toBe(false);
  await act(async () => button("FileFreshness.SaveAsNewGame").click());
  expect(mocks.writeGame).toHaveBeenCalledTimes(2);
  expect(treeStore.getState()).toMatchObject({
    appendAttempted: false,
    dirty: false,
    sourceStamp: changedStamp,
  });
  expect(getFileFreshness(tabId)).toMatchObject({
    state: "verified",
    verifiedRevision: "new-revision",
  });
  expect(jotaiStore.get(tabsAtom)[0]?.gameOrigin).toMatchObject({
    gameNumber: 7,
    file: { numGames: 8 },
  });
});

test("registered append propagates a physical marker flush refusal without a native write", async () => {
  const treeKey = crypto.randomUUID();
  mocks.readFileGame.mockResolvedValueOnce(stampedGame(changedStamp));
  await setup({ dirty: true, persisted: true, tab: { ...fileTab, treeKey } });
  const set = Storage.prototype.setItem;
  const refuse = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(function (this: Storage, key, value) {
      if (key === treeKey) throw new DOMException("append marker refused", "QuotaExceededError");
      return set.call(this, key, value);
    });
  await act(async () => {
    await expect(saveFileConflictVersion(tabId)).rejects.toMatchObject({
      message: "FileFreshness.CouldNotPrepareAppend",
    });
  });
  expect(mocks.writeGame).not.toHaveBeenCalled();
  expect(mocks.reportPersistError).toHaveBeenCalled();
  expect(treeStore.getState().appendAttempted).toBe(false);
  expect(host.textContent).toContain("FileFreshness.CouldNotPrepareAppend");
  expect(button("FileFreshness.SaveAsNewGame").disabled).toBe(false);
  refuse.mockRestore();
  expect(tabStorage.flush()).toEqual([]);
  expect(new TabStorageRepository().read(treeKey)?.state).toMatchObject({ appendAttempted: false });
});

test("shared gate ownership keeps recovery's effective-key fallback and file-kind flexibility", async () => {
  const { pendingLoad, signal } = await startPendingReload();
  const owner = jotaiStore.get(tabsAtom)[0]!;
  if (owner.gameOrigin.kind !== "file") throw new Error("Expected file owner");
  const capturedOrigin = owner.gameOrigin;
  await act(async () => {
    expect(
      jotaiStore.set(tabsAtom, [
        {
          ...owner,
          treeKey: owner.value,
          name: "Current metadata",
          gameOrigin: { ...capturedOrigin, kind: "temp_file" },
        },
      ]),
    ).toBe(true);
  });
  expect(signal.aborted).toBe(false);
  const tree = defaultTree();
  tree.headers.event = "Current recovery";
  tree.sourceStamp = changedStamp;
  await act(async () => pendingLoad.resolve({ ...stampedGame(changedStamp), tree }));
  expect(treeStore.getState()).toMatchObject({
    sourceStamp: changedStamp,
    headers: { event: "Current recovery" },
  });
  expect(jotaiStore.get(tabsAtom)[0]).toMatchObject({
    name: "Current metadata",
    treeKey: owner.value,
    gameOrigin: { kind: "temp_file" },
  });
  expect(getFileFreshness(tabId).state).toBe("verified");
  expect(host.querySelector('[data-testid="board-and-panels"]')).not.toBeNull();
});
