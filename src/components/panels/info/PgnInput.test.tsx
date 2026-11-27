import { act } from "react";
import { WorkspaceTabScope } from "@/state/tabScope";
import { createRoot, type Root } from "react-dom/client";
import { Provider, createStore } from "jotai";
import { afterEach, expect, test, vi } from "vitest";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import { closeTreeStore, createTreeStore, type TreeStore } from "@/state/store/tree";
import { tabStorage, TabStorageRepository } from "@/state/store/tabStorage";
import {
  closeWorkspaceTabAtom,
  closingTabsAtom,
  pgnOptionsFamily,
  tabsAtom,
  updateTabById,
} from "@/state/atoms";
import { loadWorkspace, WORKSPACE_STORAGE_KEY } from "@/state/workspace";
import { getTabTreeKey, replaceFileGame, saveToFile, type FileBackedTab } from "@/utils/tabs";
import ConfirmChangesModal from "@/components/tabs/ConfirmChangesModal";
import { TabCommandsProvider } from "@/components/tabs/TabCommands";
import { defaultTree, type TreeState } from "@/utils/treeReducer";
import { cancellationError } from "@/platform/tauri";
import PgnInput from "./PgnInput";

const mocks = vi.hoisted(() => ({
  parsePGN: vi.fn(),
  writeGame: vi.fn(),
  readGame: vi.fn(),
  lexPgn: vi.fn(async () => [{ type: "Outcome", value: "*" }]),
  showNotification: vi.fn(),
}));

vi.mock("@/utils/chess", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/chess")>()),
  parsePGN: mocks.parsePGN,
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/platform/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/platform/tauri")>();
  return {
    ...actual,
    tauri: {
      ...actual.tauri,
      writeGame: mocks.writeGame,
      readGame: mocks.readGame,
      lexPgn: mocks.lexPgn,
    },
  };
});
vi.mock("@/platform/native", () => ({
  platform: () => "linux",
  warn: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useRouterState: ({
    select,
  }: {
    select: (state: { location: { pathname: string } }) => unknown;
  }) => select({ location: { pathname: "/" } }),
}));
vi.mock("@mantine/notifications", () => ({ notifications: { show: mocks.showNotification } }));
vi.mock("@/utils/sound", () => ({ playSound: vi.fn() }));
vi.mock("@/components/common/AppModal", () => ({
  default: ({ children, opened }: { children: React.ReactNode; opened: boolean }) =>
    opened ? <div role="dialog">{children}</div> : null,
}));
vi.mock("@mantine/core", () => ({
  Box: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
    <div {...props}>{children}</div>
  ),
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
  Checkbox: ({
    label,
    checked,
    onChange,
  }: {
    label?: React.ReactNode;
    checked?: boolean;
    onChange?: React.ChangeEventHandler<HTMLInputElement>;
  }) => (
    <label>
      <input
        type="checkbox"
        aria-label={typeof label === "string" ? label : undefined}
        checked={checked}
        onChange={onChange}
      />
      {label}
    </label>
  ),
  Group: ({ children }: React.HTMLAttributes<HTMLDivElement>) => <div>{children}</div>,
  TextInput: ({
    label,
    autoFocus: _autoFocus,
    ...props
  }: React.InputHTMLAttributes<HTMLInputElement> & { label?: string }) => (
    <input aria-label={label} {...props} />
  ),
  rem: (value: number) => `${value}rem`,
  Stack: ({ children }: React.HTMLAttributes<HTMLDivElement>) => <div>{children}</div>,
  Text: ({ children, ...props }: React.HTMLAttributes<HTMLElement>) => (
    <label {...props}>{children}</label>
  ),
  Textarea: ({
    autosize: _autosize,
    ...props
  }: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { autosize?: boolean }) => (
    <textarea {...props} />
  ),
}));
vi.mock("@/components/common/IconAction", () => ({
  IconAction: ({
    children,
    label,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) => (
    <button {...props} aria-label={label}>
      {children}
    </button>
  ),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let host: HTMLDivElement;
let root: Root;
const fixtures: Array<{ id: string; physical: string }> = [];

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  for (const { id, physical } of fixtures.splice(0)) {
    closeTreeStore(id);
    tabStorage.remove(id);
    tabStorage.remove(physical);
  }
  tabStorage.flush();
  sessionStorage.clear();
  mocks.parsePGN.mockReset();
  mocks.writeGame.mockReset();
  mocks.showNotification.mockReset();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const stampA = "a".repeat(64);
const stampB = "b".repeat(64);
const stampC = "c".repeat(64);
const locator = {
  collection: "22222222-2222-4222-8222-222222222222",
  generation: "linked-before-edit",
  ordinal: 2,
  stamp: stampA,
};

function parsedTree(event: string) {
  const tree = createTreeStore();
  tree.getState().makeMoves({ payload: ["e4", "e5"] });
  return {
    ...defaultTree(),
    root: tree.getState().root,
    headers: { ...tree.getState().headers, event },
  };
}

function annotatedTree(event: string) {
  const tree = createTreeStore();
  tree.getState().makeMove({ payload: "e4" });
  tree.getState().setComment("Key idea");
  tree.getState().makeMove({ payload: "e5" });
  tree.getState().goToPrevious();
  tree.getState().makeMove({ payload: "c5" });
  return {
    ...defaultTree(),
    root: tree.getState().root,
    headers: { ...tree.getState().headers, event },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function setup({
  linked = true,
  appendAttempted = false,
  extraMarkups = true,
  tree = parsedTree("Initial game"),
} = {}) {
  sessionStorage.clear();
  const id = crypto.randomUUID();
  const physical = crypto.randomUUID();
  fixtures.push({ id, physical });
  const owner: FileBackedTab = {
    value: id,
    treeKey: physical,
    name: "PGN document",
    type: "analysis",
    gameOrigin: {
      kind: "file",
      gameNumber: 2,
      file: {
        type: "file",
        handle: { kind: "fileWorkspace", id: { id: "pgn-edit-source" } },
        name: "source.pgn",
        numGames: 4,
        metadata: { type: "game", tags: [] },
        lastModified: 1,
      },
    },
  };
  const workspace = createStore();
  tabStorage.seed(physical, {
    ...tree,
    linkedSource: linked ? locator : null,
    sourceStamp: stampA,
    appendAttempted,
  });
  expect(workspace.set(tabsAtom, [owner], id)).toBe(true);
  const options = workspace.get(pgnOptionsFamily(id));
  workspace.set(pgnOptionsFamily(id), { ...options, extraMarkups });
  const store = createTreeStore(id, undefined, physical);
  const getTab = (tabId: string) => workspace.get(tabsAtom).find((tab) => tab.value === tabId);
  const updateTab: import("@/utils/tabs").UpdateTab = (tabId, update, onAdmitted) =>
    updateTabById(
      (next, active, saved) => workspace.set(tabsAtom, next, active, saved),
      tabId,
      update,
      onAdmitted,
    );
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);

  const render = async (editors = 1, tree: TreeStore = store) =>
    act(async () =>
      root.render(
        <Provider store={workspace}>
          <TreeStateContext.Provider value={tree}>
            <WorkspaceTabScope tabId={id}>
              {Array.from({ length: editors }, (_, index) => (
                <div key={index} data-editor={index}>
                  <PgnInput />
                </div>
              ))}
            </WorkspaceTabScope>
          </TreeStateContext.Provider>
        </Provider>,
      ),
    );
  await render();
  return { id, physical, owner, workspace, store, getTab, updateTab, render };
}

function editor(index = 0) {
  return host.querySelector<HTMLDivElement>(`[data-editor="${index}"]`)!;
}

async function draft(text: string, index = 0) {
  const textarea = editor(index).querySelector("textarea")!;
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => {
    valueSetter.call(textarea, text);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function updateButton(index = 0) {
  return Array.from(editor(index).querySelectorAll("button")).find(
    (candidate) => candidate.textContent === "Common.Update",
  );
}

async function update(index = 0) {
  const button = updateButton(index);
  expect(button).toBeDefined();
  await act(async () => button!.click());
}

function optionCheckbox(label: string, index = 0) {
  return editor(index).querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
}

async function toggleOption(label: string, index = 0) {
  const input = optionCheckbox(label, index);
  await act(async () => input.click());
}

function expectAnnotatedRoot(store: TreeStore) {
  const e4 = store.getState().root.children[0];
  expect(e4?.san).toBe("e4");
  expect(e4?.comment).toBe("Key idea");
  expect(e4?.children.map((child) => child.san)).toEqual(["e5", "c5"]);
}

function parseSignal(call = 0): AbortSignal {
  return mocks.parsePGN.mock.calls[call][2].signal;
}

test("the named PGN editor reports a rejected clipboard write from its Copy action", async () => {
  const writeText = vi.fn().mockRejectedValue(new Error("clipboard denied"));
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  await setup();
  const textarea = editor().querySelector("textarea")!;
  expect(textarea.getAttribute("aria-label")).toBe("Common.PGNGame");
  await act(async () =>
    editor().querySelector<HTMLButtonElement>('[aria-label="Menu.Edit.Copy"]')!.click(),
  );
  expect(writeText).toHaveBeenCalledExactlyOnceWith(textarea.value);
  expect(mocks.showNotification).toHaveBeenCalledExactlyOnceWith({
    message: "Board.CopyFailed",
    color: "danger",
  });
  expect(editor().querySelector('[aria-label="Common.Copied"]')).toBeNull();
});

test("a successful clipboard write copies the PGN draft and shows copied feedback without a notification", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  await setup();
  const text = '[Event "Copied draft"]\n\n1. d4 *';
  await draft(text);
  await act(async () =>
    editor().querySelector<HTMLButtonElement>('[aria-label="Menu.Edit.Copy"]')!.click(),
  );
  expect(writeText).toHaveBeenCalledExactlyOnceWith(text);
  expect(editor().querySelector('[aria-label="Common.Copied"]')).not.toBeNull();
  expect(mocks.showNotification).not.toHaveBeenCalled();
});

test("an engine score keeps an unsaved PGN draft when the serialization does not change", async () => {
  const { store } = await setup({ extraMarkups: false });
  const draftText = "1. e4 e5 {unsaved} *";
  await draft(draftText);
  const rootBefore = store.getState().root;
  await act(async () => {
    store.getState().setEngineScore({ value: { type: "cp", value: 30 }, wdl: null });
  });
  expect(store.getState().root).not.toBe(rootBefore);
  expect(editor().querySelector("textarea")!.value).toBe(draftText);
});

test("PGN editor replacement keeps the same game's source stamp and append marker", async () => {
  const { store } = await setup({ appendAttempted: true });
  mocks.parsePGN.mockResolvedValueOnce(parsedTree("Updated PGN"));
  await draft('[Event "Edited"]\n\n1. d4 *');
  await update();
  expect(store.getState()).toMatchObject({
    dirty: true,
    linkedSource: locator,
    sourceStamp: stampA,
    appendAttempted: true,
    headers: { event: "Updated PGN" },
  });
});

test.each([true, false])(
  "same-game apply retains linked=%s provenance through physical reload, Save and actual close-save",
  async (linked) => {
    const fixture = await setup({ linked });
    mocks.parsePGN.mockResolvedValueOnce(parsedTree("Edited source game"));
    await draft('[Event "Edited source game"]\n\n1. e4 e5 *');
    await update();
    const expectedSource = linked ? locator : null;
    expect(fixture.store.getState()).toMatchObject({
      linkedSource: expectedSource,
      sourceStamp: stampA,
      appendAttempted: false,
      dirty: true,
      headers: { event: "Edited source game" },
    });
    expect(tabStorage.flush()).toEqual([]);
    const stored = new TabStorageRepository().read(fixture.physical, true)?.state;
    expect(stored).toMatchObject({
      linkedSource: expectedSource,
      sourceStamp: stampA,
      dirty: true,
    });
    closeTreeStore(fixture.id);
    const admitted = loadWorkspace(sessionStorage, WORKSPACE_STORAGE_KEY).tabs[0]!;
    const cold = createTreeStore(fixture.id, undefined, getTabTreeKey(admitted));
    mocks.readGame
      .mockReset()
      .mockResolvedValueOnce({ pgn: "*", stamp: stampA, present: true })
      .mockResolvedValueOnce({ pgn: "*", stamp: stampB, present: true });
    expect(cold.getState()).toMatchObject({
      linkedSource: expectedSource,
      sourceStamp: stampA,
      appendAttempted: false,
      headers: { event: "Edited source game" },
    });
    mocks.writeGame.mockImplementationOnce(async (_handle, _ordinal, _pgn, expectation) => {
      if ((expectation.kind === "linkedGame") !== linked)
        throw { tag: "backend-error", category: "stale-game", message: "Wrong source expectation" };
      return { stamp: stampB, revision: "saved-edit" };
    });
    await expect(
      saveToFile({
        tab: fixture.getTab(fixture.id),
        store: cold,
        getTab: fixture.getTab,
        updateTab: fixture.updateTab,
        isUserSave: true,
      }),
    ).resolves.toBe("saved");
    expect(mocks.writeGame).toHaveBeenLastCalledWith(
      fixture.owner.gameOrigin.file.handle,
      2,
      expect.stringContaining('[Event "Edited source game"]'),
      linked
        ? { kind: "linkedGame", stamp: stampA, revision: locator.generation }
        : { kind: "game", stamp: stampA },
    );
    cold.getState().setComment("Close-save edited source");
    mocks.writeGame.mockResolvedValueOnce({ stamp: stampC, revision: "close-saved-edit" });
    const onSaved = vi.fn(() => fixture.workspace.set(closeWorkspaceTabAtom, fixture.id));
    await act(async () =>
      root.render(
        <Provider store={fixture.workspace}>
          <TabCommandsProvider>
            <ConfirmChangesModal
              pendingClose={{ tabId: fixture.id, store: cold }}
              tab={fixture.getTab(fixture.id)}
              updateTab={fixture.updateTab}
              onSaved={onSaved}
            />
          </TabCommandsProvider>
        </Provider>,
      ),
    );
    const saveAndClose = Array.from(host.querySelectorAll("button")).find(
      (candidate) => candidate.textContent === "Tab.SaveAndClose",
    );
    expect(saveAndClose).toBeDefined();
    await act(async () => saveAndClose!.click());
    expect(onSaved).toHaveBeenCalledOnce();
    expect(mocks.writeGame).toHaveBeenLastCalledWith(
      fixture.owner.gameOrigin.file.handle,
      2,
      expect.stringContaining("Close-save edited source"),
      linked
        ? { kind: "linkedGame", stamp: stampB, revision: "saved-edit" }
        : { kind: "game", stamp: stampB },
    );
    expect(cold.getState()).toMatchObject({ dirty: false, sourceStamp: stampC });
    expect(mocks.readGame.mock.calls).toEqual([
      [fixture.owner.gameOrigin.file.handle, 2, undefined],
      [fixture.owner.gameOrigin.file.handle, 2, undefined],
    ]);
    expect(fixture.getTab(fixture.id)).toBeUndefined();
    expect(mocks.showNotification).not.toHaveBeenCalled();
  },
);

test("genuine complete replacement still clears absent linked provenance", async () => {
  const { store, physical } = await setup();
  await act(async () => store.getState().setState(parsedTree("Different game")));
  expect(store.getState().linkedSource).toBeNull();
  expect(tabStorage.flush()).toEqual([]);
  expect(new TabStorageRepository().read(physical, true)?.state).toMatchObject({
    linkedSource: null,
    sourceStamp: null,
    headers: { event: "Different game" },
  });
});

test.each(["unmounted", "remounted", "cursor"] as const)(
  "accepted edit completes for an unchanged document after %s",
  async (navigation) => {
    const fixture = await setup();
    const pending = deferred<ReturnType<typeof parsedTree>>();
    mocks.parsePGN.mockReturnValueOnce(pending.promise);
    await draft("Accepted edit survives navigation");
    await update();
    const signal = parseSignal();
    if (navigation !== "cursor") await fixture.render(0);
    if (navigation === "remounted") await fixture.render();
    if (navigation === "cursor") await act(async () => fixture.store.getState().goToNext());
    expect(signal.aborted).toBe(false);
    await act(async () => pending.resolve(parsedTree("Accepted after navigation")));
    expect(fixture.store.getState()).toMatchObject({
      headers: { event: "Accepted after navigation" },
      dirty: true,
      linkedSource: locator,
      sourceStamp: stampA,
    });
    expect(tabStorage.flush()).toEqual([]);
    expect(new TabStorageRepository().read(fixture.physical, true)?.state).toMatchObject({
      headers: { event: "Accepted after navigation" },
      linkedSource: locator,
    });
    expect(signal.aborted).toBe(true);
    expect(mocks.showNotification).not.toHaveBeenCalled();
  },
);

test.each([
  "draft",
  "new Update",
  "remounted draft",
  "remounted Update",
  "another editor",
] as const)(
  "%s supersedes an older accepted edit even when parsing ignores abort",
  async (intent) => {
    const fixture = await setup();
    const older = deferred<ReturnType<typeof parsedTree>>();
    const newer = deferred<ReturnType<typeof parsedTree>>();
    mocks.parsePGN.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    await draft("Older accepted text");
    await update();
    const oldSignal = parseSignal();
    if (intent.startsWith("remounted")) {
      await fixture.render(0);
      await fixture.render();
    }
    if (intent === "another editor") await fixture.render(2);
    const index = intent === "another editor" ? 1 : 0;
    await draft("Newest draft text", index);
    const acceptsNewer = intent !== "draft" && intent !== "remounted draft";
    if (acceptsNewer) await update(index);
    expect(oldSignal.aborted).toBe(true);
    await act(async () => older.resolve(parsedTree("Obsolete parsed result")));
    expect(fixture.store.getState().headers.event).toBe("Initial game");
    expect(editor(index).querySelector("textarea")!.value).toBe("Newest draft text");
    expect(mocks.showNotification).not.toHaveBeenCalled();
    if (acceptsNewer) await act(async () => newer.resolve(parsedTree("Newest parsed result")));
    expect(fixture.store.getState().headers.event).toBe(
      acceptsNewer ? "Newest parsed result" : "Initial game",
    );
    expect(tabStorage.flush()).toEqual([]);
    expect(
      new TabStorageRepository().read<TreeState>(fixture.physical, true)?.state.headers.event,
    ).toBe(acceptsNewer ? "Newest parsed result" : "Initial game");
  },
);

test("a late older finally cannot delete a pending successor operation", async () => {
  const fixture = await setup();
  const older = deferred<ReturnType<typeof parsedTree>>();
  const newer = deferred<ReturnType<typeof parsedTree>>();
  mocks.parsePGN.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
  await draft("Older accepted text");
  await update();
  await draft("Newer accepted text");
  await update();
  await act(async () => older.reject(new Error("Old lexer refuses after abort")));
  expect(parseSignal(1).aborted).toBe(false);
  expect(mocks.showNotification).not.toHaveBeenCalled();
  await act(async () => newer.resolve(parsedTree("Surviving successor")));
  expect(fixture.store.getState().headers.event).toBe("Surviving successor");
});

test("a repeated Update without a new draft keeps the newer accepted result", async () => {
  const fixture = await setup();
  const older = deferred<ReturnType<typeof parsedTree>>();
  const newer = deferred<ReturnType<typeof parsedTree>>();
  mocks.parsePGN.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
  await draft("Same draft accepted twice");
  await update();
  await update();
  expect(parseSignal().aborted).toBe(true);
  await act(async () => newer.resolve(parsedTree("Newest accepted result")));
  const state = fixture.store.getState();
  await act(async () => older.resolve(parsedTree("Late older result")));
  expect(fixture.store.getState()).toBe(state);
  expect(fixture.store.getState().headers.event).toBe("Newest accepted result");
  expect(mocks.showNotification).not.toHaveBeenCalled();
});

test.each(["success", "error", "draft", "source", "close"] as const)(
  "%s releases document subscriptions at retirement even if native parsing stays pending",
  async (terminal) => {
    const fixture = await setup();
    const subscribe = fixture.workspace.sub;
    const active = new Set<object>();
    vi.spyOn(fixture.workspace, "sub").mockImplementation((atom, listener) => {
      const token = {};
      active.add(token);
      const stop = subscribe(atom, listener);
      return () => {
        active.delete(token);
        stop();
      };
    });
    const pending = deferred<ReturnType<typeof parsedTree>>();
    mocks.parsePGN.mockReturnValueOnce(pending.promise);
    await draft("Accepted resource owner");
    await update();
    expect(active.size).toBe(2);
    await fixture.render(0);
    expect(active.size).toBe(2);
    if (terminal === "draft") {
      await fixture.render();
      await draft("Superseding draft");
      await fixture.render(0);
    }
    if (terminal === "source")
      await act(async () => fixture.store.getState().setSourceStamp(stampB));
    if (terminal === "close")
      await act(async () => fixture.workspace.set(closeWorkspaceTabAtom, fixture.id));
    if (terminal === "success")
      await act(async () => pending.resolve(parsedTree("Accepted resource result")));
    if (terminal === "error")
      await act(async () => pending.reject(new Error("Current lexer failure")));
    expect(active.size).toBe(0);
    expect(parseSignal().aborted).toBe(true);
    await act(async () => pending.resolve(parsedTree("Ignored after retirement")));
    expect(active.size).toBe(0);
  },
);

test.each(
  (
    [
      "generation",
      "close",
      "closing",
      "content",
      "headers",
      "stamp",
      "locator",
      "append",
      "origin",
    ] as const
  ).flatMap((change) => ["success", "error"].map((outcome) => ({ change, outcome }))),
)(
  "$change retires the captured document and silences stale $outcome despite cooperative abort",
  async ({ change, outcome }) => {
    const fixture = await setup();
    const pending = deferred<ReturnType<typeof parsedTree>>();
    mocks.parsePGN.mockReturnValueOnce(pending.promise);
    await draft("Parse before document replacement");
    await update();
    const signal = parseSignal();
    await act(async () => {
      if (change === "generation") {
        const result = replaceFileGame({
          store: fixture.workspace,
          owner: fixture.owner,
          treeStore: fixture.store,
          snapshot: fixture.store.getState(),
          tree: { ...parsedTree("Replacement document"), sourceStamp: stampB },
          page: 1,
          isCurrent: () => true,
        });
        if (result.kind !== "committed") throw new Error("Expected real replacement admission");
        fixtures.push({ id: fixture.id, physical: result.treeKey });
      }
      if (change === "close") fixture.workspace.set(closeWorkspaceTabAtom, fixture.id);
      if (change === "closing") fixture.workspace.set(closingTabsAtom, new Set([fixture.id]));
      if (change === "content") fixture.store.getState().setComment("Newer board content");
      if (change === "headers")
        fixture.store
          .getState()
          .setHeaders({ ...fixture.store.getState().headers, event: "New header" });
      if (change === "stamp") fixture.store.getState().setSourceStamp(stampB);
      if (change === "locator")
        fixture.store.getState().setLinkedSource({ ...locator, generation: "new-generation" });
      if (change === "append") fixture.store.getState().setAppendAttempted(true);
      if (change === "origin")
        fixture.updateTab(fixture.id, (tab) => ({
          ...tab,
          gameOrigin: { ...fixture.owner.gameOrigin, gameNumber: 1 },
        }));
    });
    expect(signal.aborted).toBe(true);
    const state = fixture.store.getState();
    const tabs = fixture.workspace.get(tabsAtom);
    expect(tabStorage.flush()).toEqual([]);
    const physical = getTabTreeKey(fixture.getTab(fixture.id) ?? fixture.owner);
    const bytes = sessionStorage.getItem(physical);
    await fixture.render(0);
    await act(async () => {
      if (outcome === "success") pending.resolve(parsedTree("Obsolete document parse"));
      else
        pending.reject({
          tag: "backend-error",
          category: "invalid-input",
          message: "Old lexer error",
        });
    });
    expect(fixture.store.getState()).toBe(state);
    expect(fixture.workspace.get(tabsAtom)).toBe(tabs);
    expect(tabStorage.flush()).toEqual([]);
    expect(sessionStorage.getItem(physical)).toBe(bytes);
    expect(mocks.showNotification).not.toHaveBeenCalled();
  },
);

test.each(["mounted", "unmounted", "remounted", "cancelled", "abort-message"] as const)(
  "current parser refusal is mapped once for %s and cancellation stays silent",
  async (view) => {
    const fixture = await setup();
    const pending = deferred<ReturnType<typeof parsedTree>>();
    mocks.parsePGN.mockReturnValueOnce(pending.promise);
    await draft("Current invalid PGN");
    await update();
    const before = fixture.store.getState();
    if (view === "unmounted" || view === "remounted") await fixture.render(0);
    if (view === "remounted") await fixture.render();
    await act(async () =>
      pending.reject(
        view === "cancelled"
          ? cancellationError()
          : view === "abort-message"
            ? new DOMException("Canceled", "AbortError")
            : {
                tag: "backend-error",
                category: "invalid-input",
                message: "Current lexer refused PGN",
              },
      ),
    );
    expect(fixture.store.getState()).toBe(before);
    expect(mocks.showNotification.mock.calls).toEqual(
      view === "cancelled"
        ? []
        : [
            [
              {
                color: "danger",
                title: "Common.Error",
                message: view === "abort-message" ? "Canceled" : "Current lexer refused PGN",
              },
            ],
          ],
    );
    expect(parseSignal().aborted).toBe(true);
    const next = parsedTree("Edit after refusal");
    mocks.parsePGN.mockResolvedValueOnce(next);
    await fixture.render();
    await draft("Valid later edit");
    await update();
    expect(fixture.store.getState().headers.event).toBe("Edit after refusal");
  },
);

test.each(["PgnInput.Variations", "PgnInput.Comments"] as const)(
  "filtering %s on a game with hidden content does not offer Update or parse the filtered PGN",
  async (option) => {
    const fixture = await setup({ tree: annotatedTree("Initial game") });
    const dirty = fixture.store.getState().dirty;
    expect(updateButton()).toBeUndefined();
    expect(editor().querySelector("textarea")!.readOnly).toBe(false);
    expect(editor().textContent).not.toContain("PgnInput.FilteredReadOnly");
    await toggleOption(option);
    expect(updateButton()).toBeUndefined();
    expect(editor().querySelector("textarea")!.hasAttribute("readonly")).toBe(true);
    expect(editor().textContent).toContain("PgnInput.FilteredReadOnly");
    expect(mocks.parsePGN).not.toHaveBeenCalled();
    expectAnnotatedRoot(fixture.store);
    expect(fixture.store.getState().dirty).toBe(dirty);
  },
);

test("ticking Variations back on keeps comments and variations in the text sent to Update", async () => {
  const fixture = await setup({ tree: annotatedTree("Initial game") });
  mocks.parsePGN.mockResolvedValueOnce(parsedTree("Edited event"));
  await toggleOption("PgnInput.Variations");
  expect(editor().querySelector("textarea")!.hasAttribute("readonly")).toBe(true);
  await toggleOption("PgnInput.Variations");
  const textarea = editor().querySelector("textarea")!;
  expect(textarea.hasAttribute("readonly")).toBe(false);
  const edited = textarea.value.replace('[Event "Initial game"]', '[Event "Edited event"]');
  expect(edited).toContain("(1... c5");
  expect(edited).toContain("Key idea");
  await draft(edited);
  await update();
  expect(mocks.parsePGN).toHaveBeenCalledOnce();
  const sent = mocks.parsePGN.mock.calls[0][0] as string;
  expect(sent).toContain("(1... c5");
  expect(sent).toContain("Key idea");
  expect(sent).toContain('[Event "Edited event"]');
  expect(fixture.store.getState().headers.event).toBe("Edited event");
});

test("re-ticking Variations does not offer Update on the stale filtered draft", async () => {
  await setup({ tree: annotatedTree("Initial game") });
  await toggleOption("PgnInput.Variations");
  expect(updateButton()).toBeUndefined();
  expect(editor().querySelector("textarea")!.value).not.toContain("(1... c5");

  await act(async () => {
    optionCheckbox("PgnInput.Variations").click();
    expect(updateButton()).toBeUndefined();
    expect(
      mocks.parsePGN.mock.calls.filter(([text]) => !String(text).includes("(1... c5")),
    ).toEqual([]);
  });
  expect(updateButton()).toBeUndefined();
  expect(editor().querySelector("textarea")!.value).toContain("(1... c5");
  expect(mocks.parsePGN).not.toHaveBeenCalled();
});

test("unticking Variations on a game with nothing to hide leaves the editor editable", async () => {
  await setup();
  await toggleOption("PgnInput.Variations");
  expect(editor().querySelector("textarea")!.hasAttribute("readonly")).toBe(false);
  expect(editor().textContent).not.toContain("PgnInput.FilteredReadOnly");
  expect(updateButton()).toBeUndefined();
});

test("editing the raw PGN keeps the ScoresheetPhotos tag in the serialized text and parsed headers", async () => {
  const photoId = "a".repeat(64);
  const initial = defaultTree();
  initial.headers.event = "Club Open";
  initial.headers.other = { ScoresheetPhotos: photoId };

  const fixture = await setup({ tree: initial });
  const textarea = editor().querySelector("textarea")!;
  expect(textarea.value).toContain(`[ScoresheetPhotos "${photoId}"]`);

  const updatedTree = parsedTree("Updated Event");
  updatedTree.headers.other = { ScoresheetPhotos: photoId };
  mocks.parsePGN.mockResolvedValueOnce(updatedTree);

  const edited = textarea.value.replace('[Event "Club Open"]', '[Event "Updated Event"]');
  expect(edited).toContain(`[ScoresheetPhotos "${photoId}"]`);
  await draft(edited);
  await update();

  expect(mocks.parsePGN).toHaveBeenCalledOnce();
  expect(mocks.parsePGN.mock.calls[0][0]).toContain(`[ScoresheetPhotos "${photoId}"]`);
  expect(fixture.store.getState().headers.event).toBe("Updated Event");
  expect(fixture.store.getState().headers.other?.ScoresheetPhotos).toBe(photoId);
});
