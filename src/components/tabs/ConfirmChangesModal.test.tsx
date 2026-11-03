import { act } from "react";
import { useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Provider, createStore, useAtomValue } from "jotai";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { activeTabAtom, currentTabAtom, tabsAtom } from "@/state/atoms";
import { closeTreeStore, createTreeStore, type TreeStore } from "@/state/store/tree";
import type { Tab } from "@/state/workspaceTypes";
import { TreeStateContext } from "../common/TreeStateContext";
import {
  registerFileConflictSave,
  removeFileFreshness,
  setFileFreshness,
} from "@/state/fileFreshness";
import { defaultTree } from "@/utils/treeReducer";
import { tabStorage, TabStorageRepository } from "@/state/store/tabStorage";
import ConfirmChangesModal from "./ConfirmChangesModal";
import FileFreshnessGate from "./FileFreshnessGate";

const mocks = vi.hoisted(() => ({
  pickPgnFile: vi.fn(),
  readFileGame: vi.fn(),
  writeGame: vi.fn(),
  lexPgn: vi.fn(),
}));

vi.mock("@/platform/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/platform/tauri")>();
  return {
    ...actual,
    tauri: { ...actual.tauri, writeGame: mocks.writeGame, lexPgn: mocks.lexPgn },
  };
});
vi.mock("@/utils/files", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/files")>()),
  pickPgnFile: mocks.pickPgnFile,
  readFileGame: mocks.readFileGame,
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@mantine/core", () => ({
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
  Group: ({ children }: any) => <div>{children}</div>,
  Stack: ({ children }: any) => <div>{children}</div>,
  Text: ({ children, ...props }: any) => <p {...props}>{children}</p>,
}));
vi.mock("../common/AppModal", () => ({
  default: ({ opened, children }: any) => (opened ? <div role="dialog">{children}</div> : null),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const currentTab: Tab = {
  name: "Current",
  value: "11111111-1111-4111-8111-111111111111",
  type: "analysis",
  gameOrigin: { kind: "none" },
};
const backgroundTab: Tab = {
  ...currentTab,
  name: "Background",
  value: "22222222-2222-4222-8222-222222222222",
};

let host: HTMLDivElement;
let root: Root;
let jotaiStore: ReturnType<typeof createStore>;
let treeStore: TreeStore;

beforeEach(() => {
  sessionStorage.clear();
  vi.clearAllMocks();
  mocks.lexPgn.mockReset().mockResolvedValue([{ type: "Outcome", value: "*" }]);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  jotaiStore = createStore();
  jotaiStore.set(tabsAtom, [currentTab, backgroundTab], currentTab.value);
  treeStore = createTreeStore(backgroundTab.value);
  mocks.pickPgnFile.mockResolvedValue({
    type: "file",
    name: "saved.pgn",
    handle: { id: { id: "saved" }, kind: "fileWorkspace" },
    numGames: 1,
    metadata: { type: "game", tags: [] },
    lastModified: 1,
  });
  mocks.readFileGame.mockReset().mockImplementation(async () => ({
    pgn: "*",
    stamp: treeStore.getState().sourceStamp ?? "a".repeat(64),
    revision: "r1",
    present: true,
  }));
  mocks.writeGame
    .mockReset()
    .mockResolvedValue({ stamp: "b".repeat(64), revision: "new-revision" });
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  closeTreeStore(currentTab.value);
  closeTreeStore(backgroundTab.value);
  removeFileFreshness(currentTab.value);
  removeFileFreshness(backgroundTab.value);
  removeFileFreshness("unavailable-file-save");
  vi.restoreAllMocks();
});

async function saveAndClose() {
  await act(async () => {
    host.querySelector<HTMLButtonElement>('[role="dialog"] button:last-of-type')!.click();
    await Promise.resolve();
  });
}

test("a successful background save forwards the receipt to the captured pending tab", async () => {
  const updateTab = vi.fn(
    (tabId: string, update: React.SetStateAction<Tab>, onAdmitted?: (successor: Tab) => void) =>
      jotaiStore.set(
        tabsAtom,
        (tabs) =>
          tabs.map((tab) =>
            tab.value === tabId ? (typeof update === "function" ? update(tab) : update) : tab,
          ),
        undefined,
        (saved) => onAdmitted?.(saved.tabs.find((tab) => tab.value === tabId)!),
      ),
  );
  const onSaved = vi.fn();
  await act(async () =>
    root.render(
      <Provider store={jotaiStore}>
        <ConfirmChangesModal
          pendingClose={{ tabId: backgroundTab.value, store: treeStore }}
          tab={backgroundTab}
          updateTab={updateTab}
          onCancel={vi.fn()}
          onDiscard={vi.fn()}
          onSaved={onSaved}
        />
      </Provider>,
    ),
  );

  await saveAndClose();

  expect(updateTab).toHaveBeenCalledWith(
    backgroundTab.value,
    expect.any(Function),
    expect.any(Function),
  );
  expect(
    jotaiStore.get(tabsAtom).find((tab) => tab.value === backgroundTab.value)?.gameOrigin.kind,
  ).toBe("file");
  expect(onSaved).toHaveBeenCalledOnce();
});

test("first-save pending close retains a no-throw subscriber edit and saves it later with game CAS", async () => {
  treeStore.getState().setComment("Captured first save");
  const onSaved = vi.fn();
  const onCancel = vi.fn();
  function PendingCloseHarness() {
    const tabs = useAtomValue(tabsAtom);
    const liveTab = tabs.find((tab) => tab.value === backgroundTab.value)!;
    const [pending, setPending] = useState(true);
    return (
      <ConfirmChangesModal
        pendingClose={pending ? { tabId: backgroundTab.value, store: treeStore } : null}
        tab={liveTab}
        onCancel={onCancel}
        onDiscard={vi.fn()}
        onSaved={() => {
          onSaved();
          setPending(false);
        }}
      />
    );
  }
  await act(async () =>
    root.render(
      <Provider store={jotaiStore}>
        <PendingCloseHarness />
      </Provider>,
    ),
  );
  const unsubscribe = jotaiStore.sub(tabsAtom, () =>
    treeStore.getState().setComment("No-throw close subscriber edit"),
  );
  try {
    await saveAndClose();
  } finally {
    unsubscribe();
  }
  expect(onSaved).not.toHaveBeenCalled();
  expect(onCancel).not.toHaveBeenCalled();
  expect(host.querySelector('[role="dialog"]')?.textContent).toContain("Tab.SaveSuperseded");
  expect(treeStore.getState()).toMatchObject({
    dirty: true,
    sourceStamp: "b".repeat(64),
    appendAttempted: false,
    root: { comment: "No-throw close subscriber edit" },
  });
  tabStorage.flush();
  expect(new TabStorageRepository().read(backgroundTab.value)?.state).toMatchObject({
    dirty: true,
    root: { comment: "No-throw close subscriber edit" },
  });
  mocks.writeGame.mockResolvedValueOnce({
    stamp: "c".repeat(64),
    revision: "close-subscriber-cas",
  });
  await saveAndClose();
  expect(mocks.writeGame).toHaveBeenLastCalledWith(
    { id: { id: "saved" }, kind: "fileWorkspace" },
    1,
    expect.stringContaining("No-throw close subscriber edit"),
    { kind: "game", stamp: "b".repeat(64) },
  );
  expect(mocks.pickPgnFile).toHaveBeenCalledOnce();
  expect(onSaved).toHaveBeenCalledOnce();
  expect(host.querySelector('[role="dialog"]')).toBeNull();
});

test("a failed fresh background append keeps its captured pending close open", async () => {
  treeStore.getState().setComment("Captured background edits");
  const currentTree = createTreeStore(currentTab.value);
  currentTree.getState().setComment("Active tab edits");
  const currentState = currentTree.getState();
  let rejectAppend!: (error: Error) => void;
  mocks.writeGame.mockReturnValueOnce(
    new Promise((_resolve, reject) => {
      rejectAppend = reject;
    }),
  );
  const onSaved = vi.fn();
  const onCancel = vi.fn();
  const updateTab = vi.fn((tabId: string, update: React.SetStateAction<Tab>) =>
    jotaiStore.set(tabsAtom, (tabs) =>
      tabs.map((tab) =>
        tab.value === tabId ? (typeof update === "function" ? update(tab) : update) : tab,
      ),
    ),
  );
  await act(async () =>
    root.render(
      <Provider store={jotaiStore}>
        <ConfirmChangesModal
          pendingClose={{ tabId: backgroundTab.value, store: treeStore }}
          tab={backgroundTab}
          updateTab={updateTab}
          onCancel={onCancel}
          onDiscard={vi.fn()}
          onSaved={onSaved}
        />
      </Provider>,
    ),
  );

  await saveAndClose();
  expect(mocks.pickPgnFile).toHaveBeenCalledExactlyOnceWith("export");
  expect(mocks.readFileGame).not.toHaveBeenCalled();
  expect(mocks.writeGame).toHaveBeenCalledExactlyOnceWith(
    { id: { id: "saved" }, kind: "fileWorkspace" },
    1,
    expect.stringContaining("Captured background edits"),
    { kind: "append" },
  );
  expect(jotaiStore.get(currentTabAtom)).toEqual(currentTab);
  expect(currentTree.getState()).toBe(currentState);
  await act(async () => rejectAppend(new Error("destination unavailable")));

  expect(
    jotaiStore.get(tabsAtom).find((tab) => tab.value === backgroundTab.value)?.gameOrigin,
  ).toEqual({ kind: "none" });
  expect(treeStore.getState()).toMatchObject({
    dirty: true,
    appendAttempted: true,
    root: { comment: "Captured background edits" },
  });
  expect(currentTree.getState()).toBe(currentState);
  expect(updateTab).not.toHaveBeenCalled();
  expect(onSaved).not.toHaveBeenCalled();
  expect(onCancel).not.toHaveBeenCalled();
  expect(jotaiStore.get(currentTabAtom)).toEqual(currentTab);
  expect(host.querySelector('[role="dialog"]')?.textContent).toContain("destination unavailable");
});

test("a typed current-tab save failure is shown and keeps the modal open", async () => {
  const currentTreeStore = createTreeStore(currentTab.value);
  const save = vi.spyOn(currentTreeStore.getState(), "save");
  mocks.writeGame.mockRejectedValueOnce(new Error("typed write failure"));
  const closeTab = vi.fn();
  const toggle = vi.fn();
  await act(async () =>
    root.render(
      <Provider store={jotaiStore}>
        <TreeStateContext.Provider value={currentTreeStore}>
          <ConfirmChangesModal opened toggle={toggle} closeTab={closeTab} />
        </TreeStateContext.Provider>
      </Provider>,
    ),
  );

  await saveAndClose();

  expect(jotaiStore.get(currentTabAtom)?.gameOrigin).toEqual({ kind: "none" });
  expect(mocks.writeGame).toHaveBeenCalledOnce();
  expect(save).not.toHaveBeenCalled();
  expect(closeTab).not.toHaveBeenCalled();
  expect(toggle).not.toHaveBeenCalled();
  expect(host.querySelector('[role="dialog"]')?.textContent).toContain("typed write failure");
});

function fileBackedTab(value: string): Tab {
  return {
    ...currentTab,
    value,
    gameOrigin: {
      kind: "file",
      gameNumber: 0,
      file: {
        type: "file",
        name: "source.pgn",
        handle: { id: { id: `file-${value}` }, kind: "fileWorkspace" },
        numGames: 1,
        metadata: { type: "game", tags: [] },
        lastModified: 1,
      },
    },
  };
}

async function startUnavailableRecoveryClose() {
  const sourceTab = fileBackedTab(backgroundTab.value);
  jotaiStore.set(tabsAtom, [currentTab, sourceTab], currentTab.value);
  treeStore.getState().setState({ ...defaultTree(), dirty: true, sourceStamp: "a".repeat(64) });
  treeStore.getState().setComment("Captured recovery edits");
  setFileFreshness(sourceTab.value, "unavailable");
  let resolveAppend!: (written: { stamp: string; revision: string }) => void;
  mocks.writeGame.mockReturnValueOnce(
    new Promise((resolve) => {
      resolveAppend = resolve;
    }),
  );
  const onSaved = vi.fn();
  const onCancel = vi.fn();
  const closeTab = vi.fn();
  function RecoveryCloseHarness() {
    const tabs = useAtomValue(tabsAtom);
    const liveTab = tabs.find((tab) => tab.value === sourceTab.value)!;
    const [pending, setPending] = useState(true);
    return (
      <TreeStateContext.Provider value={treeStore}>
        <FileFreshnessGate tab={liveTab} closeTab={closeTab}>
          <div>board</div>
        </FileFreshnessGate>
        <ConfirmChangesModal
          pendingClose={pending ? { tabId: sourceTab.value, store: treeStore } : null}
          tab={liveTab}
          onCancel={onCancel}
          onDiscard={vi.fn()}
          onSaved={() => {
            onSaved();
            setPending(false);
          }}
          closeTab={closeTab}
        />
      </TreeStateContext.Provider>
    );
  }
  await act(async () =>
    root.render(
      <Provider store={jotaiStore}>
        <RecoveryCloseHarness />
      </Provider>,
    ),
  );
  await saveAndClose();
  await vi.waitFor(() => expect(mocks.writeGame).toHaveBeenCalledOnce());
  expect(mocks.writeGame).toHaveBeenCalledWith(
    { id: { id: "saved" }, kind: "fileWorkspace" },
    1,
    expect.stringContaining("Captured recovery edits"),
    { kind: "append" },
  );
  return { resolveAppend, onSaved, onCancel, closeTab, sourceTab };
}

test("unavailable recovery keeps a pending close open for later edits, then CAS saves them before closing", async () => {
  const { resolveAppend, onSaved, onCancel, closeTab, sourceTab } =
    await startUnavailableRecoveryClose();
  await act(async () => treeStore.getState().setComment("Later recovery edit"));
  await act(async () => resolveAppend({ stamp: "b".repeat(64), revision: "recovery-append" }));
  expect(onSaved).not.toHaveBeenCalled();
  expect(onCancel).not.toHaveBeenCalled();
  expect(closeTab).not.toHaveBeenCalled();
  expect(host.querySelector('[role="dialog"]')?.textContent).toContain("Tab.SaveSuperseded");
  expect(treeStore.getState()).toMatchObject({
    dirty: true,
    appendAttempted: false,
    sourceStamp: "b".repeat(64),
    root: { comment: "Later recovery edit" },
  });
  expect(
    jotaiStore.get(tabsAtom).find((tab) => tab.value === sourceTab.value)?.gameOrigin,
  ).toMatchObject({
    kind: "file",
    gameNumber: 1,
    file: { numGames: 2, handle: { id: { id: "saved" } } },
  });
  expect(jotaiStore.get(currentTabAtom)).toEqual(currentTab);
  mocks.writeGame.mockResolvedValueOnce({ stamp: "c".repeat(64), revision: "latest-edits" });
  await saveAndClose();
  expect(mocks.writeGame).toHaveBeenCalledTimes(2);
  expect(mocks.writeGame).toHaveBeenLastCalledWith(
    { id: { id: "saved" }, kind: "fileWorkspace" },
    1,
    expect.stringContaining("Later recovery edit"),
    { kind: "game", stamp: "b".repeat(64) },
  );
  expect(mocks.pickPgnFile).toHaveBeenCalledOnce();
  expect(onSaved).toHaveBeenCalledOnce();
  expect(treeStore.getState()).toMatchObject({ dirty: false, sourceStamp: "c".repeat(64) });
  expect(host.querySelector('[role="dialog"]')).toBeNull();
});

test("unavailable recovery keeps close pending after an admitted subscriber failure and later CAS saves newer edits", async () => {
  const { resolveAppend, onSaved, onCancel, closeTab, sourceTab } =
    await startUnavailableRecoveryClose();
  await act(async () => treeStore.getState().setComment("Later recovery observer edit"));
  const unsubscribe = jotaiStore.sub(tabsAtom, () => {
    throw new Error("Recovery close workspace subscriber failed");
  });
  try {
    await act(async () => resolveAppend({ stamp: "b".repeat(64), revision: "recovery-observer" }));
    expect(host.querySelector('[role="dialog"]')?.textContent).toContain(
      "Recovery close workspace subscriber failed",
    );
    expect(onSaved).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    expect(closeTab).not.toHaveBeenCalled();
    expect(treeStore.getState()).toMatchObject({
      dirty: true,
      appendAttempted: false,
      sourceStamp: "b".repeat(64),
      root: { comment: "Later recovery observer edit" },
    });
    expect(
      jotaiStore.get(tabsAtom).find((tab) => tab.value === sourceTab.value)?.gameOrigin,
    ).toMatchObject({ kind: "file", gameNumber: 1 });
  } finally {
    unsubscribe();
  }
  mocks.writeGame.mockResolvedValueOnce({
    stamp: "c".repeat(64),
    revision: "later-observer-edits",
  });
  await saveAndClose();
  expect(mocks.writeGame).toHaveBeenLastCalledWith(
    { id: { id: "saved" }, kind: "fileWorkspace" },
    1,
    expect.stringContaining("Later recovery observer edit"),
    { kind: "game", stamp: "b".repeat(64) },
  );
  expect(mocks.pickPgnFile).toHaveBeenCalledOnce();
  expect(onSaved).toHaveBeenCalledOnce();
});

test("unavailable recovery closes normally when the appended snapshot contains all current edits", async () => {
  const { resolveAppend, onSaved, onCancel } = await startUnavailableRecoveryClose();
  await act(async () => resolveAppend({ stamp: "b".repeat(64), revision: "clean-recovery" }));
  expect(onSaved).toHaveBeenCalledOnce();
  expect(onCancel).not.toHaveBeenCalled();
  expect(treeStore.getState()).toMatchObject({
    dirty: false,
    appendAttempted: false,
    sourceStamp: "b".repeat(64),
  });
  expect(mocks.writeGame).toHaveBeenCalledOnce();
  expect(host.querySelector('[role="dialog"]')).toBeNull();
});

test("close-tab conflict closes the dialog, keeps the tab, and activates it", async () => {
  const sourceTab = fileBackedTab(backgroundTab.value);
  jotaiStore.set(tabsAtom, [currentTab, sourceTab], currentTab.value);
  const sourceTree = defaultTree();
  sourceTree.sourceStamp = "a".repeat(64);
  sourceTree.dirty = true;
  treeStore.getState().setState(sourceTree);
  const onCancel = vi.fn();
  const onSaved = vi.fn();
  const updateTab = vi.fn();
  mocks.writeGame.mockRejectedValueOnce({
    tag: "backend-error",
    category: "stale-game",
    message: "The game changed on disk",
  });

  function PendingCloseHarness() {
    const [pendingClose, setPendingClose] = useState<{
      tabId: string;
      store: TreeStore;
    } | null>({ tabId: sourceTab.value, store: treeStore });
    return (
      <Provider store={jotaiStore}>
        <ConfirmChangesModal
          pendingClose={pendingClose}
          tab={sourceTab}
          updateTab={updateTab}
          onCancel={() => {
            onCancel();
            setPendingClose(null);
          }}
          onDiscard={vi.fn()}
          onSaved={onSaved}
        />
      </Provider>
    );
  }

  await act(async () => root.render(<PendingCloseHarness />));
  await saveAndClose();

  expect(onCancel).toHaveBeenCalledOnce();
  expect(onSaved).not.toHaveBeenCalled();
  expect(updateTab).not.toHaveBeenCalled();
  expect(jotaiStore.get(tabsAtom)).toContainEqual(sourceTab);
  expect(jotaiStore.get(activeTabAtom)).toBe(sourceTab.value);
  expect(host.querySelector('[role="dialog"]')).toBeNull();
});

test("page-switch conflict leaves the tree and selected game in place", async () => {
  const sourceTab = fileBackedTab(currentTab.value);
  jotaiStore.set(tabsAtom, [sourceTab], sourceTab.value);
  const currentTree = createTreeStore(currentTab.value);
  const sourceTree = defaultTree();
  sourceTree.sourceStamp = "a".repeat(64);
  sourceTree.dirty = true;
  currentTree.getState().setState(sourceTree);
  mocks.writeGame.mockRejectedValueOnce({
    tag: "backend-error",
    category: "stale-game",
    message: "The game changed on disk",
  });
  const toggle = vi.fn();
  const changePage = vi.fn();

  await act(async () =>
    root.render(
      <Provider store={jotaiStore}>
        <TreeStateContext.Provider value={currentTree}>
          <ConfirmChangesModal
            opened
            toggle={toggle}
            closeTab={changePage}
            tab={sourceTab}
            updateTab={(tabId, update) =>
              jotaiStore.set(tabsAtom, (tabs) =>
                tabs.map((tab) =>
                  tab.value === tabId ? (typeof update === "function" ? update(tab) : update) : tab,
                ),
              )
            }
          />
        </TreeStateContext.Provider>
      </Provider>,
    ),
  );
  await saveAndClose();

  expect(toggle).toHaveBeenCalledOnce();
  expect(changePage).not.toHaveBeenCalled();
  expect(currentTree.getState()).toMatchObject({ dirty: true, sourceStamp: "a".repeat(64) });
  expect(jotaiStore.get(currentTabAtom)?.gameOrigin).toMatchObject({ gameNumber: 0 });
});

test("Save on an unavailable tab runs the registered append action", async () => {
  const action = vi.fn(async () => true);
  const unregister = registerFileConflictSave(backgroundTab.value, action);
  setFileFreshness(backgroundTab.value, "unavailable");
  const onSaved = vi.fn();

  await act(async () =>
    root.render(
      <Provider store={jotaiStore}>
        <ConfirmChangesModal
          pendingClose={{ tabId: backgroundTab.value, store: treeStore }}
          tab={backgroundTab}
          onCancel={vi.fn()}
          onDiscard={vi.fn()}
          onSaved={onSaved}
        />
      </Provider>,
    ),
  );
  await saveAndClose();

  expect(action).toHaveBeenCalledOnce();
  expect(onSaved).toHaveBeenCalledOnce();
  expect(mocks.writeGame).not.toHaveBeenCalled();
  unregister();
});

test("Save shows the real Gate append failure inside the unavailable-tab modal", async () => {
  const unavailableTab = fileBackedTab("unavailable-file-save");
  jotaiStore.set(tabsAtom, [currentTab, unavailableTab], currentTab.value);
  const unavailableStore = createTreeStore(unavailableTab.value);
  const updateTab = (tabId: string, update: React.SetStateAction<Tab>) =>
    jotaiStore.set(tabsAtom, (tabs) =>
      tabs.map((tab) =>
        tab.value === tabId ? (typeof update === "function" ? update(tab) : update) : tab,
      ),
    );
  setFileFreshness(unavailableTab.value, "unavailable");
  mocks.writeGame.mockRejectedValueOnce({
    tag: "backend-error",
    category: "permission",
    message: "The selected PGN cannot be written",
  });
  const onSaved = vi.fn();

  await act(async () =>
    root.render(
      <Provider store={jotaiStore}>
        <TreeStateContext.Provider value={unavailableStore}>
          <FileFreshnessGate tab={unavailableTab} closeTab={vi.fn()}>
            <div>board</div>
          </FileFreshnessGate>
          <ConfirmChangesModal
            pendingClose={{ tabId: unavailableTab.value, store: unavailableStore }}
            tab={unavailableTab}
            updateTab={updateTab}
            onCancel={vi.fn()}
            onDiscard={vi.fn()}
            onSaved={onSaved}
          />
        </TreeStateContext.Provider>
      </Provider>,
    ),
  );
  await saveAndClose();

  expect(onSaved).not.toHaveBeenCalled();
  expect(mocks.writeGame).toHaveBeenCalledWith(
    expect.objectContaining({ id: { id: "saved" } }),
    1,
    expect.any(String),
    { kind: "append" },
  );
  expect(host.querySelector('[role="dialog"]')?.textContent).toContain(
    "The selected PGN cannot be written",
  );
});
