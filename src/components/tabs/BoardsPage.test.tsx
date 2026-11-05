import { act, createContext, Suspense, useContext, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { getDefaultStore } from "jotai";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { TabTreeStorageStatus } from "@/state/store/tabStorage";
import type { Tab } from "@/state/workspaceTypes";

const fixtures = vi.hoisted(() => ({
  abortGame: vi.fn(),
  closeWorkspaceTab: vi.fn(),
  closeTreeStore: vi.fn(),
  confirm: null as null | {
    pendingClose: { tabId: string } | null;
    onCancel: () => void;
    onDiscard: () => void;
  },
  createTreeStore: vi.fn<(...args: any[]) => any>(() => ({
    dispose: fixtures.dispose,
    subscribe: fixtures.subscribe,
    getState: () => ({
      dirty: fixtures.dirty,
      setReportInProgress: fixtures.setReportInProgress,
      setReportOperationId: fixtures.setReportOperationId,
    }),
  })),
  createTab: vi.fn(),
  duplicateHandler: null as (() => void) | null,
  mountPanels: true,
  cloneDurable: vi.fn(),
  readForClone: vi.fn(),
  seed: vi.fn(),
  removeTreeSafely: vi.fn((_key: string) => true),
  recordFailedAdmission: vi.fn(),
  reportPersistError: vi.fn(),
  retryTreeStoreStorage: vi.fn(),
  discardTreeStoreStorage: vi.fn(),
  treeStatus: { kind: "available" } as TabTreeStorageStatus,
  treeStatuses: new Map<string, TabTreeStorageStatus>(),
  getStatus: vi.fn((key: string) => fixtures.treeStatuses.get(key) ?? fixtures.treeStatus),
  subscribeStatus: vi.fn((_key: string, listener: () => void) => {
    fixtures.treeStatusListeners.add(listener);
    return () => {
      fixtures.treeStatusListeners.delete(listener);
    };
  }),
  treeStatusListeners: new Set<() => void>(),
  dispose: vi.fn(),
  subscribe: vi.fn(() => vi.fn()),
  dirty: false,
  closeHandler: null as (() => unknown) | null,
  closeReceipt: true,
  commitReceipt: true,
  hotkeyBindings: null as Array<[string, () => void]> | null,
  killEngines: vi.fn(),
  invalidateReportOwner: vi.fn(),
  restoreReportOwner: vi.fn(),
  notifyUnlessCancelled: vi.fn(),
  tabsOnChange: null as ((value: string | null) => void) | null,
  nextPromise: null as Promise<void> | null,
  nextReady: false,
  resolveNext: null as (() => void) | null,
  setReportInProgress: vi.fn(),
  setReportOperationId: vi.fn(),
  tabs: [
    { value: "current", name: "Current", type: "new", gameOrigin: { kind: "none" } },
    { value: "next", name: "Next", type: "new", gameOrigin: { kind: "none" } },
  ] as TabFixture[],
}));

type TabFixture = {
  gameOrigin: Tab["gameOrigin"];
  name: string;
  type: "new" | "play" | "analysis" | "puzzles";
  value: string;
  treeKey?: string;
};

const persistentGameOrigin: Tab["gameOrigin"] = {
  kind: "database",
  database: { id: { id: "db" }, kind: "database" },
  gameId: 1,
};

function setTreeStatus(status: TabTreeStorageStatus) {
  fixtures.treeStatus = status;
  for (const listener of fixtures.treeStatusListeners) listener();
}

const TabsContext = createContext<string | null>(null);

vi.mock("@/state/atoms", async () => {
  const { atom } = await vi.importActual<typeof import("jotai")>("jotai");
  const { atomFamily } = await vi.importActual<typeof import("jotai/utils")>("jotai/utils");
  const activeTabAtom = atom<string | null>("current");
  const tabsStateAtom = atom<TabFixture[]>(fixtures.tabs);
  const tabsAtom = atom(
    (get) => get(tabsStateAtom),
    (get, set, update: TabFixture[] | ((tabs: TabFixture[]) => TabFixture[]), active?: string) => {
      if (!fixtures.commitReceipt) return false;
      const tabs = typeof update === "function" ? update(get(tabsStateAtom)) : update;
      set(tabsStateAtom, tabs);
      if (active !== undefined) set(activeTabAtom, active);
      return true;
    },
  );
  return {
    initializeWorkspace: vi.fn(),
    activeTabAtom,
    closeWorkspaceTabAtom: atom(null, (get, set, tabId: string) => {
      if (!fixtures.closeReceipt) return false;
      const tabs = get(tabsAtom).filter((tab) => tab.value !== tabId);
      set(tabsAtom, tabs);
      if (get(activeTabAtom) === tabId) set(activeTabAtom, tabs[0]?.value ?? null);
      fixtures.closeWorkspaceTab(tabId);
      return true;
    }),
    closingTabsAtom: atom<Set<string>>(new Set<string>()),
    gameIdFamily: atomFamily(() => atom<string | null>(null)),
    gameSessionFamily: atomFamily(() => atom<bigint | null>(null)),
    gameStateFamily: atomFamily(() => atom<"settingUp" | "playing" | "gameOver">("settingUp")),
    pendingGameStartFamily: atomFamily(() => atom<Promise<void> | null>(null)),
    tabsAtom,
  };
});
vi.mock("@/state/keybinds", async () => {
  const { atom } = await vi.importActual<typeof import("jotai")>("jotai");
  return {
    keyMapAtom: atom({
      CLOSE_TAB: { keys: "mod+w" },
      CYCLE_TABS: { keys: "mod+tab" },
      REVERSE_CYCLE_TABS: { keys: "mod+shift+tab" },
    }),
  };
});
vi.mock("@/platform/native", () => ({
  platform: () => "linux",
  warn: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/utils/sound", () => ({ playSound: vi.fn() }));
vi.mock("@/platform/tauri", () => ({
  tauri: { abortGame: fixtures.abortGame, killEngines: fixtures.killEngines },
}));
vi.mock("@/state/store/tree", () => ({
  closeTreeStore: fixtures.closeTreeStore,
  createTreeStore: fixtures.createTreeStore,
  retryTreeStoreStorage: fixtures.retryTreeStoreStorage,
  discardTreeStoreStorage: fixtures.discardTreeStoreStorage,
  invalidateReportOwner: fixtures.invalidateReportOwner,
  restoreReportOwner: fixtures.restoreReportOwner,
}));
vi.mock("@/state/store/tabStorage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/state/store/tabStorage")>();
  return {
    ...actual,
    persistStorageWriteError: (cause: unknown) => cause,
    tabStorage: {
      storageFor: actual.tabStorage.storageFor.bind(actual.tabStorage),
      cloneDurable: fixtures.cloneDurable,
      readForClone: fixtures.readForClone,
      seed: fixtures.seed,
      removeTreeSafely: fixtures.removeTreeSafely,
      recordFailedAdmission: fixtures.recordFailedAdmission,
      getStatus: fixtures.getStatus,
      readRawValueForRecovery: () => {
        if (fixtures.treeStatus.kind !== "unreadable") throw new Error("No unreadable value");
        return fixtures.treeStatus.rawValue;
      },
      subscribeStatus: fixtures.subscribeStatus,
    },
  };
});
vi.mock("@/state/persistError", () => ({ reportPersistError: fixtures.reportPersistError }));
vi.mock("@/utils/tabs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/tabs")>()),
  createTab: fixtures.createTab,
}));
vi.mock("../files/notifyError", () => ({ notifyUnlessCancelled: fixtures.notifyUnlessCancelled }));
vi.mock("jotai/utils", async () => {
  const actual = await vi.importActual<typeof import("jotai/utils")>("jotai/utils");
  const { atom } = await vi.importActual<typeof import("jotai")>("jotai");
  return { ...actual, atomWithStorage: (_key: string, initial: unknown) => atom(initial) };
});
vi.mock("@mantine/hooks", () => ({
  useHotkeys: vi.fn((bindings: Array<[string, () => void]>) => {
    fixtures.hotkeyBindings = bindings;
  }),
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@hello-pangea/dnd", () => ({
  DragDropContext: ({ children }: { children: ReactNode }) => children,
  Draggable: ({ children }: { children: (provided: Record<string, unknown>) => ReactNode }) =>
    children({ dragHandleProps: null, draggableProps: {}, innerRef: vi.fn() }),
  Droppable: ({ children }: { children: (provided: Record<string, unknown>) => ReactNode }) =>
    children({ droppableProps: {}, innerRef: vi.fn(), placeholder: null }),
}));
vi.mock("@mantine/core", () => {
  const Tabs = Object.assign(
    ({
      children,
      onChange,
      value,
    }: {
      children: ReactNode;
      onChange?: (value: string | null) => void;
      value: string | null;
    }) => {
      fixtures.tabsOnChange = onChange ?? null;
      return (
        <TabsContext.Provider value={value}>
          <div>{children}</div>
        </TabsContext.Provider>
      );
    },
    {
      List: ({ children }: { children: ReactNode }) => <div>{children}</div>,
      Panel: ({ children, value }: { children: ReactNode; value: string }) =>
        useContext(TabsContext) === value && fixtures.mountPanels ? (
          <div data-testid={`panel-${value}`}>{children}</div>
        ) : null,
      Tab: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
        <button type="button" onClick={onClick}>
          {children}
        </button>
      ),
    },
  );

  const passthrough = ({ children }: { children: ReactNode }) => <div>{children}</div>;
  return {
    Button: ({ children, disabled, onClick }: any) => (
      <button type="button" disabled={disabled} onClick={onClick}>
        {children}
      </button>
    ),
    Group: passthrough,
    Menu: Object.assign(passthrough, {
      Dropdown: passthrough,
      Item: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => {
        if (children === "Tab.Duplicate") fixtures.duplicateHandler = onClick ?? null;
        return (
          <button type="button" onClick={onClick}>
            {children}
          </button>
        );
      },
      Target: passthrough,
    }),
    ScrollArea: passthrough,
    Tabs,
    TextInput: passthrough,
  };
});
vi.mock("lucide-react", () => ({
  Copy: () => null,
  Ellipsis: () => null,
  Pencil: () => null,
  Plus: () => null,
  X: () => null,
}));
vi.mock("../boards/BoardAnalysis", () => ({
  default: () => <div data-testid="board-analysis-child" />,
}));
vi.mock("../boards/BoardGame", () => ({ default: () => <div data-testid="board-game-child" /> }));
vi.mock("../common/AppModal", () => ({ default: () => null }));
vi.mock("../common/IconAction", () => ({
  IconAction: ({ children, disabled, label, onClick }: any) => {
    if (label === "Tab.Close") fixtures.closeHandler = onClick;
    return (
      <button type="button" aria-label={label} disabled={disabled} onClick={onClick}>
        {children}
      </button>
    );
  },
}));
vi.mock("../puzzles/Puzzles", () => ({ default: () => <div data-testid="puzzles-child" /> }));
vi.mock("./BoardTab", () => ({
  BoardTab: ({ tab, setActiveTab }: { tab: TabFixture; setActiveTab: (value: string) => void }) => (
    <button type="button" data-testid={`tab-${tab.value}`} onClick={() => setActiveTab(tab.value)}>
      {tab.name}
    </button>
  ),
}));
vi.mock("./ConfirmChangesModal", () => ({
  default: (props: any) => {
    fixtures.confirm = props;
    return null;
  },
}));
vi.mock("./NewTabHome", () => ({
  default: ({ id }: { id: string }) => {
    if (id === "next" && !fixtures.nextReady) throw fixtures.nextPromise;
    return <div data-testid={`view-${id}`}>{id}</div>;
  },
}));
vi.mock("react-mosaic-component", () => ({ Mosaic: () => null }));
vi.mock("./BoardTabLayout", () => ({
  default: ({ children }: { children: ReactNode }) => children,
}));

import BoardsPage from "./BoardsPage";
import {
  activeTabAtom,
  closingTabsAtom,
  gameIdFamily,
  gameSessionFamily,
  gameStateFamily,
  pendingGameStartFamily,
  tabsAtom,
} from "@/state/atoms";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let container: HTMLDivElement;
let root: Root;
const store = getDefaultStore();

function deferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function renderPage() {
  return act(async () => {
    root.render(
      <Suspense fallback={<div data-testid="fallback">Loading</div>}>
        <BoardsPage />
      </Suspense>,
    );
  });
}

function invokeHotkey(keys: string) {
  const binding = fixtures.hotkeyBindings?.find(([shortcut]) => shortcut === keys);
  if (!binding) throw new Error(`Missing hotkey binding: ${keys}`);
  binding[1]();
}

beforeEach(() => {
  vi.clearAllMocks();
  fixtures.commitReceipt = true;
  fixtures.treeStatuses.clear();
  fixtures.mountPanels = true;
  fixtures.duplicateHandler = null;
  fixtures.getStatus.mockImplementation(
    (key) => fixtures.treeStatuses.get(key) ?? fixtures.treeStatus,
  );
  fixtures.subscribeStatus.mockImplementation((_key, listener) => {
    fixtures.treeStatusListeners.add(listener);
    return () => {
      fixtures.treeStatusListeners.delete(listener);
    };
  });
  fixtures.tabs = [
    { value: "current", name: "Current", type: "new", gameOrigin: { kind: "none" } },
    { value: "next", name: "Next", type: "new", gameOrigin: { kind: "none" } },
  ];
  setTreeStatus({ kind: "available" });
  store.set(tabsAtom, fixtures.tabs);
  store.set(activeTabAtom, "current");
  store.set(closingTabsAtom, new Set());
  for (const tabId of ["current", "next"]) {
    store.set(gameIdFamily(tabId), null);
    store.set(gameSessionFamily(tabId), null);
    store.set(pendingGameStartFamily(tabId), null);
  }
  fixtures.confirm = null;
  fixtures.dirty = false;
  fixtures.nextReady = false;
  fixtures.closeHandler = null;
  fixtures.closeReceipt = true;
  fixtures.commitReceipt = true;
  fixtures.createTab.mockResolvedValue("created");
  fixtures.cloneDurable.mockReset();
  fixtures.readForClone.mockReset();
  fixtures.seed.mockReset();
  fixtures.removeTreeSafely.mockReset();
  fixtures.removeTreeSafely.mockReturnValue(true);
  fixtures.recordFailedAdmission.mockReset();
  fixtures.reportPersistError.mockReset();
  fixtures.retryTreeStoreStorage.mockReset();
  fixtures.retryTreeStoreStorage.mockImplementation(async () => fixtures.treeStatus);
  fixtures.discardTreeStoreStorage.mockReset();
  fixtures.discardTreeStoreStorage.mockImplementation(() => {
    setTreeStatus({ kind: "absent" });
    return true;
  });
  fixtures.hotkeyBindings = null;
  fixtures.notifyUnlessCancelled.mockReset();
  fixtures.tabsOnChange = null;
  fixtures.nextPromise = new Promise<void>((resolve) => {
    fixtures.resolveNext = resolve;
  });
  fixtures.killEngines.mockResolvedValue(undefined);
  fixtures.invalidateReportOwner.mockReturnValue({ previous: {}, invalidated: {} });
  fixtures.abortGame.mockResolvedValue(undefined);
  fixtures.createTreeStore.mockImplementation(() => ({
    dispose: fixtures.dispose,
    subscribe: fixtures.subscribe,
    getState: () => ({
      dirty: fixtures.dirty,
      setReportInProgress: fixtures.setReportInProgress,
      setReportOperationId: fixtures.setReportOperationId,
    }),
  }));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await act(async () => root.unmount());
  container.remove();
});

test("keeps the current view while closing into a suspending next tab", async () => {
  await renderPage();
  expect(container.querySelector('[data-testid="view-current"]')).not.toBeNull();

  const close = fixtures.closeHandler!;
  const teardown = deferred<void>();
  fixtures.killEngines.mockReturnValueOnce(teardown.promise);
  const closePromise = close();

  await act(async () => {
    await Promise.resolve();
  });
  expect(fixtures.closeWorkspaceTab).not.toHaveBeenCalled();

  await act(async () => {
    teardown.resolve();
    await closePromise;
  });
  expect(fixtures.closeWorkspaceTab).toHaveBeenCalledWith("current");
  expect(fixtures.abortGame).not.toHaveBeenCalled();
  expect(container.querySelector('[data-testid="fallback"]')).toBeNull();
  expect(container.querySelector('[data-testid="view-current"]')).not.toBeNull();
  expect(container.querySelector('[data-testid="view-next"]')).toBeNull();

  await act(async () => {
    fixtures.nextReady = true;
    fixtures.resolveNext?.();
    await Promise.resolve();
  });
  expect(container.querySelector('[data-testid="view-next"]')).not.toBeNull();
});

test("restores the report owner and tree store when durable close is refused", async () => {
  await renderPage();
  fixtures.closeReceipt = false;

  await act(async () => {
    await fixtures.closeHandler!();
  });

  expect(fixtures.restoreReportOwner).toHaveBeenCalledOnce();
  expect(fixtures.closeTreeStore).not.toHaveBeenCalled();
  expect(fixtures.dispose).not.toHaveBeenCalled();
  expect(store.get(tabsAtom).some((tab) => tab.value === "current")).toBe(true);
  expect(store.get(closingTabsAtom)).toEqual(new Set());
});

test("does not loop when replacement creation after the last close is refused", async () => {
  const onlyTab = fixtures.tabs[0]!;
  store.set(tabsAtom, [onlyTab]);
  store.set(activeTabAtom, onlyTab.value);
  fixtures.createTab.mockResolvedValue(null);
  await renderPage();

  await act(async () => {
    await fixtures.closeHandler!();
    await Promise.resolve();
  });

  expect(store.get(tabsAtom)).toEqual([]);
  expect(fixtures.createTab).toHaveBeenCalledOnce();
  expect(fixtures.notifyUnlessCancelled).not.toHaveBeenCalled();
});

test("duplicate clones the requested tab and preserves metadata and selection on refusal", async () => {
  fixtures.commitReceipt = false;
  await renderPage();
  const before = store.get(tabsAtom);
  const duplicate = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "Tab.Duplicate",
  )!;

  await act(async () => {
    duplicate.click();
    await Promise.resolve();
  });

  expect(fixtures.cloneDurable).toHaveBeenCalledOnce();
  expect(fixtures.cloneDurable.mock.calls[0]![0]).toBe("current");
  expect(fixtures.cloneDurable.mock.calls[0]![1]).not.toBe("current");
  expect(store.get(tabsAtom)).toEqual(before);
  expect(store.get(activeTabAtom)).toBe("current");
});

test("duplicate uses the physical generation and clears its inherited reference", async () => {
  const physical = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const original = { ...fixtures.tabs[0]!, treeKey: physical };
  store.set(tabsAtom, [original]);
  await renderPage();
  const duplicate = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "Tab.Duplicate",
  )!;
  await act(async () => duplicate.click());
  expect(fixtures.cloneDurable.mock.calls[0]?.[0]).toBe(physical);
  const tabs = store.get(tabsAtom);
  expect(tabs).toHaveLength(2);
  expect(tabs[0]).toEqual(original);
  expect(tabs[1]?.treeKey).toBeUndefined();
  expect(tabs[1]?.value).not.toBe(original.value);
  expect(store.get(activeTabAtom)).toBe(tabs[1]?.value);
});

test.each(["cold", "vanished"] as const)(
  "inactive explicit-reference duplication refuses a %s missing source before any original hydration",
  async (sourceState) => {
    const { tabStorage: repository } = await vi.importActual<
      typeof import("@/state/store/tabStorage")
    >("@/state/store/tabStorage");
    const realTree =
      await vi.importActual<typeof import("@/state/store/tree")>("@/state/store/tree");
    const { defaultTree } = await import("@/utils/treeReducer");
    const { serializeStorageValue } = await import("@/state/store/debouncedStorage");
    const owner = {
      ...fixtures.tabs[1]!,
      value: crypto.randomUUID(),
      type: "play" as const,
      treeKey: crypto.randomUUID(),
    };
    const originalTabs = [fixtures.tabs[0]!, owner];
    const workspaceBytes = serializeStorageValue({
      version: 1,
      tabs: originalTabs,
      activeTab: "current",
    });
    sessionStorage.setItem("workspace", workspaceBytes);
    fixtures.cloneDurable.mockImplementation(repository.cloneDurable.bind(repository));
    fixtures.getStatus.mockImplementation(repository.getStatus.bind(repository));
    fixtures.subscribeStatus.mockImplementation(repository.subscribeStatus.bind(repository));
    fixtures.createTreeStore.mockImplementation(realTree.createTreeStore);
    fixtures.removeTreeSafely.mockImplementation(repository.removeTreeSafely.bind(repository));
    fixtures.recordFailedAdmission.mockImplementation(
      repository.recordFailedAdmission.bind(repository),
    );
    store.set(tabsAtom, originalTabs);
    // Retain the real menu action before the source becomes inactive. Delay panel mounting
    // so this original owner has never acquired a cached store or hydration status.
    fixtures.mountPanels = false;
    store.set(activeTabAtom, owner.value);
    await renderPage();
    const duplicateOriginal = fixtures.duplicateHandler!;
    fixtures.mountPanels = true;
    await act(async () => store.set(activeTabAtom, "current"));
    expect(realTree.getCachedTreeStore(owner.value)).toBeUndefined();
    expect(repository.getStatus(owner.treeKey).kind).toBe("not-read");
    let priorSourceStatus = repository.getStatus(owner.treeKey).kind;
    if (sourceState === "vanished") {
      const tree = defaultTree();
      tree.headers.event = "Previously available physical source";
      repository.seed(owner.treeKey, tree);
      priorSourceStatus = repository.readTree(owner.treeKey).kind;
      sessionStorage.removeItem(owner.treeKey);
    }
    expect(priorSourceStatus).toBe(sourceState === "vanished" ? "available" : "not-read");
    const publishedSourceStatuses: string[] = [];
    const unsubscribe = repository.subscribeStatus(owner.treeKey, () => {
      publishedSourceStatuses.push(repository.getStatus(owner.treeKey).kind);
    });
    await act(async () => duplicateOriginal());
    unsubscribe();
    expect(store.get(tabsAtom)).toEqual(originalTabs);
    expect(store.get(activeTabAtom)).toBe("current");
    expect(repository.getStatus(owner.treeKey)).toMatchObject({ kind: "unavailable" });
    expect(publishedSourceStatuses).toEqual(["unavailable"]);
    expect(realTree.getCachedTreeStore(owner.value)).toBeUndefined();
    expect(sessionStorage.getItem("workspace")).toBe(workspaceBytes);
    expect(sessionStorage.getItem(owner.treeKey)).toBeNull();
    expect(repository.pendingCount()).toBe(0);
    await act(async () => store.set(activeTabAtom, owner.value));
    expect(container.querySelector('[data-tree-recovery="unavailable"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="board-game-child"]')).toBeNull();
    const originalStore = realTree.getCachedTreeStore(owner.value)!;
    originalStore.getState().setComment("cannot persist an editable blank original");
    expect(repository.pendingCount()).toBe(0);
    expect(sessionStorage.getItem(owner.treeKey)).toBeNull();
    await act(async () => root.render(null));
    realTree.closeTreeStore(owner.value);
    repository.remove(owner.treeKey);
    sessionStorage.removeItem("workspace");
  },
);

async function realDuplicateStorage() {
  const { tabStorage: repository } = await vi.importActual<
    typeof import("@/state/store/tabStorage")
  >("@/state/store/tabStorage");
  const realTree = await vi.importActual<typeof import("@/state/store/tree")>("@/state/store/tree");
  fixtures.cloneDurable.mockImplementation(repository.cloneDurable.bind(repository));
  fixtures.readForClone.mockImplementation(repository.readForClone.bind(repository));
  fixtures.seed.mockImplementation(repository.seed.bind(repository));
  fixtures.getStatus.mockImplementation(repository.getStatus.bind(repository));
  fixtures.subscribeStatus.mockImplementation(repository.subscribeStatus.bind(repository));
  fixtures.createTreeStore.mockImplementation(realTree.createTreeStore);
  fixtures.removeTreeSafely.mockImplementation(repository.removeTreeSafely.bind(repository));
  fixtures.recordFailedAdmission.mockImplementation(
    repository.recordFailedAdmission.bind(repository),
  );
  return { repository, realTree };
}

test.each(["legacy", "migrated"] as const)(
  "puzzle Duplicate saves a complete independent %s owner while source migration is refused",
  async (format) => {
    const { repository, realTree } = await realDuplicateStorage();
    const { defaultTree } = await import("@/utils/treeReducer");
    const { restorePuzzleSession, selectedPuzzleIndex } = await import("@/state/puzzleSession");
    const { deserializeStorageValue } = await import("@/state/store/debouncedStorage");
    const source = crypto.randomUUID();
    const physical = crypto.randomUUID();
    const tree = defaultTree();
    const puzzle = {
      id: 7,
      fen: tree.root.fen,
      moves: ["e2e4", "e7e5", "g1f3", "b8c6"],
      rating: 1200,
      rating_deviation: 50,
      popularity: 1,
      nb_plays: 1,
      completion: "incomplete" as const,
    };
    const history = JSON.stringify([puzzle]);
    sessionStorage.setItem(`${source}-puzzles`, history);
    if (format === "migrated") tree.puzzleSession = restorePuzzleSession(source, tree);
    repository.seed(physical, tree);
    const live = realTree.createTreeStore(source, undefined, physical);
    live.getState().makeMove({ payload: { from: 12, to: 28 } });
    live.getState().setComment("latest pending source annotation");
    const state = live.getState();
    const owns = state.capturePuzzleSessionOwner();
    const bytes = sessionStorage.getItem(physical);
    const pending = repository.pendingCount();
    const originalSet = Storage.prototype.setItem;
    const writes: string[] = [];
    const fault = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(function (this: Storage, key, value) {
        if (key === physical)
          throw new DOMException("source migration refused", "QuotaExceededError");
        writes.push(key);
        return originalSet.call(this, key, value);
      });
    let destinationId: string | undefined;
    let unsubscribe = () => {};
    try {
      expect(
        state.transitionPuzzleSession((draft) => {
          draft.puzzleSession = restorePuzzleSession(source, state);
        }).success,
      ).toBe(false);
      expect(live.getState()).toBe(state);
      const original = {
        ...fixtures.tabs[0]!,
        value: source,
        treeKey: physical,
        type: "puzzles" as const,
      };
      store.set(tabsAtom, [original]);
      store.set(activeTabAtom, source);
      await renderPage();
      const admittedFrames: unknown[] = [];
      unsubscribe = store.sub(tabsAtom, () => {
        const destination = store.get(tabsAtom)[1];
        if (destination)
          admittedFrames.push(
            deserializeStorageValue<{ state: typeof tree }>(
              sessionStorage.getItem(destination.value)!,
            )?.state,
          );
      });
      await act(async () => fixtures.duplicateHandler!());
      unsubscribe();
      const destination = store.get(tabsAtom)[1]!;
      destinationId = destination?.value;
      expect(destination).toBeDefined();
      expect(destination.treeKey).toBeUndefined();
      expect(store.get(activeTabAtom)).toBe(destination.value);
      const saved = deserializeStorageValue<{ state: typeof tree }>(
        sessionStorage.getItem(destination.value)!,
      )!.state;
      expect(saved.puzzleSession).toBeDefined();
      expect(saved.puzzleSession!.attempts.map((attempt) => attempt.puzzle)).toEqual([puzzle]);
      expect(selectedPuzzleIndex(saved.puzzleSession)).toBe(0);
      expect(saved.root).toEqual(state.root);
      expect(saved.position).toEqual(state.position);
      expect(admittedFrames).toEqual([saved]);
      const legacyAttemptId = expect.any(String);
      expect(saved.puzzleSession).toEqual(
        state.puzzleSession ?? {
          version: 1,
          attempts: [{ attemptId: legacyAttemptId, puzzle }],
          selectedAttemptId: saved.puzzleSession!.attempts[0].attemptId,
        },
      );
      expect(writes).toContain(destination.value);
      expect(sessionStorage.getItem(physical)).toBe(bytes);
      expect(sessionStorage.getItem(`${source}-puzzles`)).toBe(history);
      expect(live.getState()).toBe(state);
      expect(owns()).toBe(true);
      expect(repository.pendingCount()).toBe(pending);
      expect(repository.flush({ notify: true })).toEqual([physical]);
      expect(repository.pendingCount()).toBe(pending);
      expect(sessionStorage.getItem(physical)).toBe(bytes);
      const copy = realTree.getCachedTreeStore(destination.value)!;
      expect(
        copy.getState().transitionPuzzleSession((draft) => {
          draft.root.comment = "independent destination edit";
          draft.puzzleSession!.attempts[0].puzzle.timeSpent = 123;
        }).success,
      ).toBe(true);
      expect(live.getState()).toBe(state);
      expect(sessionStorage.getItem(physical)).toBe(bytes);
      expect(sessionStorage.getItem(`${source}-puzzles`)).toBe(history);
    } finally {
      unsubscribe();
      fault.mockRestore();
      await act(async () => root.render(null));
      realTree.closeTreeStore(source);
      repository.remove(physical);
      if (destinationId) {
        realTree.closeTreeStore(destinationId);
        repository.remove(destinationId);
      }
    }
  },
);

test("puzzle Duplicate retains legacy history when its unrequired physical tree is absent", async () => {
  const { repository } = await realDuplicateStorage();
  const { defaultTree } = await import("@/utils/treeReducer");
  const source = crypto.randomUUID();
  const tree = defaultTree();
  const puzzle = {
    id: 1,
    fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1",
    moves: ["e7e5"],
    rating: 1,
    rating_deviation: 1,
    popularity: 1,
    nb_plays: 1,
    completion: "incomplete",
  };
  const history = JSON.stringify([puzzle]);
  sessionStorage.setItem(`${source}-puzzles`, history);
  store.set(tabsAtom, [{ ...fixtures.tabs[0]!, value: source, type: "puzzles" }]);
  store.set(activeTabAtom, source);
  fixtures.mountPanels = false;
  await renderPage();
  await act(async () => fixtures.duplicateHandler!());
  const destination = store.get(tabsAtom)[1]!;
  expect(destination).toBeDefined();
  const saved = repository.readForClone(destination.value)!;
  expect(saved).not.toBeNull();
  expect(saved.puzzleSession).toBeDefined();
  expect(saved.puzzleSession!.attempts.map((attempt) => attempt.puzzle)).toEqual([puzzle]);
  expect(saved.puzzleSession!.selectedAttemptId).toBeNull();
  expect(saved.root).toEqual(tree.root);
  expect(sessionStorage.getItem(source)).toBeNull();
  expect(sessionStorage.getItem(`${source}-puzzles`)).toBe(history);
  repository.remove(destination.value);
});

test.each([
  "cold-missing",
  "read-refused",
  "missing",
  "unreadable",
  "unavailable",
  "history",
  "destination",
  "workspace",
] as const)(
  "puzzle Duplicate refuses %s and preserves the original selection and recovery gate",
  async (failure) => {
    const { repository } = await realDuplicateStorage();
    const { defaultTree } = await import("@/utils/treeReducer");
    const source = crypto.randomUUID();
    const physical = crypto.randomUUID();
    const tree = defaultTree();
    if (failure === "unreadable") sessionStorage.setItem(physical, "broken source bytes");
    else if (failure !== "missing" && failure !== "cold-missing") repository.seed(physical, tree);
    sessionStorage.setItem(`${source}-puzzles`, "[]");
    const bytes = sessionStorage.getItem(physical);
    const original = {
      ...fixtures.tabs[0]!,
      value: source,
      treeKey: physical,
      type: "puzzles" as const,
    };
    store.set(tabsAtom, [original]);
    store.set(activeTabAtom, source);
    fixtures.mountPanels = false;
    const getItem = Storage.prototype.getItem;
    const setItem = Storage.prototype.setItem;
    const readFault = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(function (this: Storage, key) {
        if (
          ((failure === "unavailable" || failure === "read-refused") && key === physical) ||
          (failure === "history" && key === `${source}-puzzles`)
        )
          throw new DOMException("read refused", "SecurityError");
        return getItem.call(this, key);
      });
    if (["missing", "unreadable", "unavailable"].includes(failure)) {
      repository.readTree(physical, true);
      // Underlying bytes recover, but Duplicate must retain the original cached recovery gate.
      readFault.mockRestore();
      sessionStorage.setItem(physical, JSON.stringify({ version: 1, state: tree }));
    }
    const gate = repository.getStatus(physical);
    const recoveryBytes = getItem.call(sessionStorage, physical);
    const writeFault = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(function (this: Storage, key, value) {
        if (failure === "destination" && key !== physical)
          throw new DOMException("destination refused", "QuotaExceededError");
        return setItem.call(this, key, value);
      });
    fixtures.commitReceipt = failure !== "workspace";
    await renderPage();
    await act(async () => fixtures.duplicateHandler!());
    expect(store.get(tabsAtom)).toEqual([original]);
    expect(store.get(activeTabAtom)).toBe(source);
    expect(getItem.call(sessionStorage, physical)).toBe(recoveryBytes ?? bytes);
    expect(getItem.call(sessionStorage, `${source}-puzzles`)).toBe("[]");
    const status = repository.getStatus(physical);
    const newlyUnavailable = failure === "cold-missing" || failure === "read-refused";
    expect(status).toMatchObject(newlyUnavailable ? { kind: "unavailable" } : gate);
    expect(status === gate).toBe(!newlyUnavailable);
    expect(fixtures.removeTreeSafely).toHaveBeenCalledOnce();
    const refusedId = fixtures.removeTreeSafely.mock.calls[0]![0];
    expect(getItem.call(sessionStorage, refusedId)).toBeNull();
    readFault.mockRestore();
    writeFault.mockRestore();
    repository.remove(physical);
  },
);

test("reports a tree-copy failure without admitting a duplicate tab", async () => {
  const failure = new Error("source storage is unavailable");
  fixtures.cloneDurable.mockImplementationOnce(() => {
    throw failure;
  });
  await renderPage();
  const before = store.get(tabsAtom);
  const duplicate = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "Tab.Duplicate",
  )!;

  await act(async () => {
    duplicate.click();
    await Promise.resolve();
  });

  expect(fixtures.cloneDurable).toHaveBeenCalledOnce();
  expect(store.get(tabsAtom)).toEqual(before);
  expect(fixtures.reportPersistError).toHaveBeenCalledOnce();
  expect(fixtures.reportPersistError).toHaveBeenCalledWith(failure);
  expect(fixtures.removeTreeSafely).toHaveBeenCalledOnce();
});

test("keeps a gated game tab open and allows close after its tree recovers", async () => {
  fixtures.tabs = fixtures.tabs.map((tab) =>
    tab.value === "current" ? { ...tab, type: "analysis" } : tab,
  );
  store.set(tabsAtom, fixtures.tabs);
  setTreeStatus({ kind: "unavailable", error: new Error("storage read refused") });
  await renderPage();

  await act(async () => {
    await fixtures.closeHandler!();
  });
  expect(fixtures.closeWorkspaceTab).not.toHaveBeenCalled();

  setTreeStatus({ kind: "available" });
  await act(async () => {
    await fixtures.closeHandler!();
  });

  expect(fixtures.closeWorkspaceTab).toHaveBeenCalledWith("current");
  expect(fixtures.closeTreeStore).toHaveBeenCalledWith("current");
});

const suspendedNavigationCases = [
  {
    name: "a BoardTab click",
    navigate: () => container.querySelector<HTMLButtonElement>('[data-testid="tab-next"]')?.click(),
  },
  { name: "the Mantine tab selection", navigate: () => fixtures.tabsOnChange?.("next") },
  { name: "the forward cycle hotkey", navigate: () => invokeHotkey("mod+tab") },
  { name: "the reverse cycle hotkey", navigate: () => invokeHotkey("mod+shift+tab") },
  { name: "the numbered selection hotkey", navigate: () => invokeHotkey("alt+2") },
] as const;

test.each(suspendedNavigationCases)(
  "transitions $name before showing a suspending tab",
  async ({ navigate }) => {
    await renderPage();

    await act(async () => {
      navigate();
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="fallback"]')).toBeNull();
    expect(container.querySelector('[data-testid="view-current"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="view-next"]')).toBeNull();

    await act(async () => {
      fixtures.nextReady = true;
      fixtures.resolveNext?.();
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="view-next"]')).not.toBeNull();
  },
);

test("keeps the tab when engine teardown rejects", async () => {
  await renderPage();
  const teardownError = new Error("engine shutdown failed");
  fixtures.killEngines.mockRejectedValueOnce(teardownError);

  await act(async () => {
    fixtures.closeHandler!();
    await Promise.resolve();
  });

  expect(fixtures.closeWorkspaceTab).not.toHaveBeenCalled();
  expect(fixtures.restoreReportOwner).toHaveBeenCalledWith(
    "current",
    fixtures.invalidateReportOwner.mock.results[0].value,
  );
  expect(fixtures.setReportOperationId).not.toHaveBeenCalled();
  expect(fixtures.setReportInProgress).not.toHaveBeenCalled();
  expect(fixtures.notifyUnlessCancelled).toHaveBeenCalledWith("Common.Error", teardownError);
  expect(container.querySelector('[data-testid="view-current"]')).not.toBeNull();
});

test("deduplicates close teardown and holds intent until completion", async () => {
  await renderPage();
  const teardown = deferred<void>();
  fixtures.killEngines.mockReturnValue(teardown.promise);

  const first = fixtures.closeHandler!();
  const second = fixtures.closeHandler!();
  await act(async () => Promise.resolve());
  expect(fixtures.killEngines).toHaveBeenCalledTimes(1);
  expect(store.get(closingTabsAtom).has("current")).toBe(true);

  await act(async () => {
    teardown.resolve();
    await first;
    await second;
  });
  expect(store.get(closingTabsAtom).has("current")).toBe(false);
  expect(fixtures.closeWorkspaceTab).toHaveBeenCalledTimes(1);
});

test("failed teardown releases close intent and permits a fresh close", async () => {
  await renderPage();
  fixtures.killEngines.mockRejectedValueOnce(new Error("failed"));
  await act(async () => fixtures.closeHandler!());
  expect(store.get(closingTabsAtom).has("current")).toBe(false);

  await act(async () => fixtures.closeHandler!());
  expect(fixtures.killEngines).toHaveBeenCalledTimes(2);
});

test("close waits for a pending start before exact cleanup and removal", async () => {
  await renderPage();
  const start = deferred<void>();
  store.set(pendingGameStartFamily("current"), start.promise);
  fixtures.closeHandler!();
  await act(async () => Promise.resolve());
  expect(fixtures.killEngines).not.toHaveBeenCalled();
  expect(fixtures.closeWorkspaceTab).not.toHaveBeenCalled();

  store.set(gameIdFamily("current"), "late-game");
  store.set(gameSessionFamily("current"), 9n);
  await act(async () => {
    start.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(fixtures.abortGame).toHaveBeenCalledWith("late-game", 9n);
  expect(fixtures.closeWorkspaceTab).toHaveBeenCalledWith("current");
});

test("closing a terminal tab with relinquished ownership does not abort", async () => {
  await renderPage();
  store.set(gameStateFamily("current"), "gameOver");
  store.set(gameIdFamily("current"), null);
  store.set(gameSessionFamily("current"), null);
  await act(async () => fixtures.closeHandler!());
  expect(fixtures.abortGame).not.toHaveBeenCalled();
  expect(fixtures.closeWorkspaceTab).toHaveBeenCalledWith("current");
});

test("typed missing game permits close while genuine abort failure retains the tab", async () => {
  await renderPage();
  store.set(gameIdFamily("current"), "native-game");
  store.set(gameSessionFamily("current"), 3n);
  fixtures.abortGame.mockRejectedValueOnce({
    tag: "backend-error",
    category: "missing-resource",
    message: "gone",
  });
  await act(async () => fixtures.closeHandler!());
  expect(fixtures.closeWorkspaceTab).toHaveBeenCalledWith("current");

  store.set(tabsAtom, fixtures.tabs);
  store.set(activeTabAtom, "current");
  store.set(gameIdFamily("current"), "native-game-2");
  store.set(gameSessionFamily("current"), 4n);
  fixtures.abortGame.mockRejectedValueOnce(new Error("abort failed"));
  await renderPage();
  await act(async () => fixtures.closeHandler!());
  expect(store.get(tabsAtom).some((tab) => tab.value === "current")).toBe(true);
  expect(store.get(gameIdFamily("current"))).toBe("native-game-2");
  expect(fixtures.notifyUnlessCancelled).toHaveBeenCalledWith(
    "Common.Error",
    expect.objectContaining({ message: "abort failed" }),
  );
});

test("holds close intent through kill and game abort, then removes metadata before release", async () => {
  await renderPage();
  const kill = deferred<void>();
  const abort = deferred<null>();
  fixtures.killEngines.mockReturnValueOnce(kill.promise);
  store.set(gameIdFamily("current"), "native-game");
  store.set(gameSessionFamily("current"), 7n);
  fixtures.abortGame.mockReturnValueOnce(abort.promise);
  let markerAtMetadataRemoval = false;
  let tabPresentAtMetadataRemoval = true;
  fixtures.closeWorkspaceTab.mockImplementationOnce(() => {
    markerAtMetadataRemoval = store.get(closingTabsAtom).has("current");
    tabPresentAtMetadataRemoval = store
      .get(tabsAtom)
      .some((candidate) => candidate.value === "current");
  });

  fixtures.closeHandler!();
  expect(store.get(closingTabsAtom).has("current")).toBe(true);
  expect(fixtures.abortGame).not.toHaveBeenCalled();

  await act(async () => {
    kill.resolve();
    await Promise.resolve();
  });
  expect(fixtures.abortGame).toHaveBeenCalledWith("native-game", 7n);
  expect(store.get(closingTabsAtom).has("current")).toBe(true);
  expect(store.get(gameIdFamily("current"))).toBe("native-game");
  expect(store.get(gameSessionFamily("current"))).toBe(7n);

  await act(async () => {
    abort.resolve(null);
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(markerAtMetadataRemoval).toBe(true);
  expect(tabPresentAtMetadataRemoval).toBe(false);
  expect(store.get(closingTabsAtom).has("current")).toBe(false);
  expect(store.get(tabsAtom).some((candidate) => candidate.value === "current")).toBe(false);
});

test("dirty confirmation leaves analysis eligible until discard establishes close intent", async () => {
  fixtures.dirty = true;
  fixtures.tabs = [
    {
      value: "current",
      name: "Current",
      type: "analysis",
      gameOrigin: persistentGameOrigin,
    },
    { value: "next", name: "Next", type: "new", gameOrigin: { kind: "none" } },
  ];
  store.set(tabsAtom, fixtures.tabs);
  await renderPage();

  await act(async () => {
    fixtures.closeHandler!();
    await Promise.resolve();
  });
  expect(fixtures.confirm?.pendingClose?.tabId).toBe("current");
  expect(store.get(closingTabsAtom).has("current")).toBe(false);
  expect(store.get(tabsAtom).some((candidate) => candidate.value === "current")).toBe(true);
  expect(fixtures.killEngines).not.toHaveBeenCalled();

  await act(async () => fixtures.confirm?.onCancel());
  expect(store.get(closingTabsAtom).has("current")).toBe(false);
  expect(store.get(tabsAtom).some((candidate) => candidate.value === "current")).toBe(true);

  await act(async () => {
    fixtures.closeHandler!();
    await Promise.resolve();
  });
  let markerAtKill = false;
  fixtures.killEngines.mockImplementationOnce(async () => {
    markerAtKill = store.get(closingTabsAtom).has("current");
  });
  await act(async () => {
    fixtures.confirm?.onDiscard();
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(markerAtKill).toBe(true);
  expect(store.get(closingTabsAtom).has("current")).toBe(false);
  expect(store.get(tabsAtom).some((candidate) => candidate.value === "current")).toBe(false);
});

test("dirty origin-less analysis tab opens unsaved-changes confirm", async () => {
  fixtures.dirty = true;
  fixtures.tabs = [
    { value: "current", name: "Current", type: "analysis", gameOrigin: { kind: "none" } },
    { value: "next", name: "Next", type: "new", gameOrigin: { kind: "none" } },
  ];
  store.set(tabsAtom, fixtures.tabs);
  await renderPage();

  await act(async () => {
    fixtures.closeHandler!();
    await Promise.resolve();
  });
  expect(fixtures.confirm?.pendingClose?.tabId).toBe("current");
  expect(store.get(tabsAtom).some((candidate) => candidate.value === "current")).toBe(true);
  expect(fixtures.killEngines).not.toHaveBeenCalled();
});

test("clean origin-less analysis tab closes without confirm", async () => {
  fixtures.dirty = false;
  fixtures.tabs = [
    { value: "current", name: "Current", type: "analysis", gameOrigin: { kind: "none" } },
    { value: "next", name: "Next", type: "new", gameOrigin: { kind: "none" } },
  ];
  store.set(tabsAtom, fixtures.tabs);
  await renderPage();

  await act(async () => {
    fixtures.closeHandler!();
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(fixtures.confirm?.pendingClose).toBeNull();
  expect(store.get(tabsAtom).some((candidate) => candidate.value === "current")).toBe(false);
});

test.each(["play", "puzzles"] as const)(
  "dirty origin-less %s tab closes without confirm",
  async (type) => {
    fixtures.dirty = true;
    fixtures.tabs = [
      { value: "current", name: "Current", type, gameOrigin: { kind: "none" } },
      { value: "next", name: "Next", type: "new", gameOrigin: { kind: "none" } },
    ];
    store.set(tabsAtom, fixtures.tabs);
    await renderPage();

    await act(async () => {
      fixtures.closeHandler!();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fixtures.confirm?.pendingClose).toBeNull();
    expect(store.get(tabsAtom).some((candidate) => candidate.value === "current")).toBe(false);
  },
);

const recoveryRoutes = [
  { type: "play", child: "board-game-child" },
  { type: "analysis", child: "board-analysis-child" },
  { type: "puzzles", child: "puzzles-child" },
] as const;

test("BoardsPage routes provider, recovery and close through the physical generation", async () => {
  const treeKey = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const owner = { ...fixtures.tabs[0]!, type: "play" as const, treeKey };
  store.set(tabsAtom, [owner]);
  fixtures.treeStatuses.set(treeKey, {
    kind: "unavailable",
    error: new Error("physical read refused"),
  });
  fixtures.retryTreeStoreStorage.mockImplementationOnce(async (id) => {
    expect(id).toBe(owner.value);
    fixtures.treeStatuses.set(treeKey, { kind: "available" });
    for (const listener of fixtures.treeStatusListeners) listener();
    return fixtures.getStatus(treeKey);
  });
  await renderPage();
  expect(fixtures.createTreeStore).toHaveBeenCalledWith(owner.value, undefined, treeKey);
  expect(fixtures.subscribeStatus).toHaveBeenCalledWith(treeKey, expect.any(Function));
  expect(fixtures.getStatus).toHaveBeenCalledWith(treeKey);
  expect(container.querySelector('[data-tree-recovery="unavailable"]')).not.toBeNull();
  expect(container.querySelector('[data-testid="board-game-child"]')).toBeNull();
  fixtures.createTreeStore.mockClear();
  fixtures.getStatus.mockClear();
  await act(async () => fixtures.closeHandler!());
  expect(fixtures.createTreeStore).toHaveBeenCalledWith(owner.value, undefined, treeKey);
  expect(fixtures.getStatus).toHaveBeenCalledWith(treeKey);
  expect(fixtures.closeWorkspaceTab).not.toHaveBeenCalled();
  expect(fixtures.killEngines).not.toHaveBeenCalled();
  const retry = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent === "TreeRecovery.Retry",
  )!;
  await act(async () => retry.click());
  expect(fixtures.retryTreeStoreStorage).toHaveBeenCalledWith(owner.value);
  expect(container.querySelector("[data-tree-recovery]")).toBeNull();
  expect(container.querySelector('[data-testid="board-game-child"]')).not.toBeNull();
  await act(async () => fixtures.closeHandler!());
  expect(fixtures.killEngines).toHaveBeenCalledWith(owner.value);
  expect(fixtures.closeWorkspaceTab).toHaveBeenCalledWith(owner.value);
  expect(fixtures.closeTreeStore).toHaveBeenCalledWith(owner.value);
});

test.each(recoveryRoutes)(
  "withholds the $type route behind the unreadable-tree gate and keeps its workspace owner",
  async ({ type, child }) => {
    fixtures.tabs = [
      { value: "current", name: "Current", type, gameOrigin: { kind: "none" } },
      { value: "next", name: "Next", type: "new", gameOrigin: { kind: "none" } },
    ];
    store.set(tabsAtom, fixtures.tabs);
    store.set(activeTabAtom, "current");
    setTreeStatus({ kind: "unreadable", rawValue: "exact raw tree value" });
    await renderPage();

    expect(container.querySelector('[data-tree-recovery="unreadable"]')).not.toBeNull();
    expect(container.querySelector(`[data-testid="${child}"]`)).toBeNull();

    await act(async () => {
      await fixtures.closeHandler!();
      invokeHotkey("mod+w");
      await Promise.resolve();
    });
    expect(fixtures.closeWorkspaceTab).not.toHaveBeenCalled();
    expect(store.get(tabsAtom).some((tab) => tab.value === "current")).toBe(true);

    await act(async () => root.render(null));
    await renderPage();
    expect(container.querySelector('[data-tree-recovery="unreadable"]')).not.toBeNull();
    expect(container.querySelector(`[data-testid="${child}"]`)).toBeNull();
    expect(store.get(tabsAtom).some((tab) => tab.value === "current")).toBe(true);
  },
);

test.each(recoveryRoutes)(
  "keeps the $type route gated when tree storage is unavailable",
  async ({ type, child }) => {
    fixtures.tabs = [
      { value: "current", name: "Current", type, gameOrigin: { kind: "none" } },
      { value: "next", name: "Next", type: "new", gameOrigin: { kind: "none" } },
    ];
    store.set(tabsAtom, fixtures.tabs);
    store.set(activeTabAtom, "current");
    setTreeStatus({ kind: "unavailable", error: new Error("storage refused") });
    await renderPage();

    expect(container.querySelector('[data-tree-recovery="unavailable"]')).not.toBeNull();
    expect(container.querySelector(`[data-testid="${child}"]`)).toBeNull();
    await act(async () => {
      await fixtures.closeHandler!();
      invokeHotkey("mod+w");
    });
    expect(fixtures.closeWorkspaceTab).not.toHaveBeenCalled();
    expect(store.get(tabsAtom).some((tab) => tab.value === "current")).toBe(true);
  },
);
