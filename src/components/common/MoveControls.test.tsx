import { MantineProvider } from "@mantine/core";
import { Provider, useAtom } from "jotai";
import { act, useContext } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createTreeStore, type TreeStore } from "@/state/store/tree";
import { showVariationsFamily } from "@/state/atoms";
import { EphemeralTabScope, useTabAtom } from "@/state/tabScope";
import { press } from "@/tests/keyboard";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { installResizeObserverStub } from "@/tests/resizeObserver";
import { fixtureNode } from "@/tests/treeFixtures";
import { defaultTree } from "@/utils/treeReducer";
import { TreeStateContext, TreeStateProvider } from "@/components/common/TreeStateContext";
import BoardFrame from "@/components/boards/BoardFrame";
import AppModal from "./AppModal";
import Comment from "./Comment";
import { GameReferenceProvider } from "./GameReference";
import { MoveDeletionContext, type MoveDeletion } from "./MoveDeletionContext";

const citationMocks = vi.hoisted(() => ({ lookup: vi.fn(), navigate: vi.fn() }));

const settings = vi.hoisted(() => ({
  chooseVariation: true,
  keys: {
    NEXT_MOVE: "arrowright",
    PREVIOUS_MOVE: "arrowleft",
    GO_TO_BRANCH_START: "arrowup",
    GO_TO_BRANCH_END: "arrowdown",
    GO_TO_START: "shift+arrowup",
    GO_TO_END: "shift+arrowdown",
    NEXT_BRANCH: "c",
    PREVIOUS_BRANCH: "x",
    NEXT_BRANCHING: "shift+arrowright",
    PREVIOUS_BRANCHING: "shift+arrowleft",
    NEXT_OPEN_VARIATION: "u",
    DELETE_MOVE: "delete",
    DELETE_VARIATION: "ctrl+delete",
    DELETE_MOVES_AFTER: "shift+delete",
    PROMOTE_VARIATION: "ctrl+arrowup",
  },
}));

vi.mock("@/state/atoms", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/atoms")>();
  const { atom } = await import("jotai");
  return { ...original, chooseVariationAtom: atom(() => settings.chooseVariation) };
});
vi.mock("@/state/keybinds", async () => {
  const { atom } = await import("jotai");
  return {
    keyMapAtom: atom(() =>
      Object.fromEntries(
        Object.entries(settings.keys).map(([id, value]) => [id, { name: id, keys: value }]),
      ),
    ),
  };
});
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/utils/sound", () => ({ playSound: vi.fn() }));
vi.mock("@/utils/gameReferences", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/gameReferences")>()),
  lookupGameReference: citationMocks.lookup,
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => citationMocks.navigate }));

import MoveControls from "./MoveControls";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
installMatchMediaStub();
installResizeObserverStub();

let host: HTMLDivElement;
let root: Root;
let store: TreeStore;

// 1.e4 (1.d4) (1.c4) e5 — a three-way branch at the root, then a single continuation.
function branchingStore() {
  const tree = defaultTree();
  tree.root.children = [
    fixtureNode("e4", { children: [fixtureNode("e5", { halfMoves: 2 })] }),
    fixtureNode("d4"),
    fixtureNode("c4"),
  ];
  return createTreeStore(undefined, tree);
}

function middleGameStore() {
  const tree = defaultTree();
  tree.root.children = [
    fixtureNode("e4", {
      children: [fixtureNode("e5", { halfMoves: 2 }), fixtureNode("c5", { halfMoves: 2 })],
    }),
  ];
  tree.position = [0];
  return createTreeStore(undefined, tree);
}

function options() {
  return [...document.querySelectorAll('[role="option"]')].map((option) => ({
    text: option.textContent,
    selected: option.getAttribute("aria-selected") === "true",
  }));
}

function CaptureStore() {
  store = useContext(TreeStateContext)!;
  return null;
}

/** The tab's "show variations" setting as the controls see it. */
let variations: { shown: boolean; set: (shown: boolean) => void };
function CaptureVariations() {
  const [shown, set] = useAtom(useTabAtom(showVariationsFamily));
  variations = { shown, set };
  return null;
}

function render({
  modal = false,
  controlsInModal = false,
  readOnly = false,
  citation = false,
  editors = false,
  deletion = undefined as MoveDeletion | undefined,
} = {}) {
  act(() => {
    root.render(
      // A fresh jotai store per render, so the setting is read anew in every case.
      <Provider>
        <MantineProvider env="test">
          <TreeStateProvider initial={store.getState()}>
            <CaptureStore />
            <BoardFrame>
              <div role="grid" />
            </BoardFrame>
            {!controlsInModal && (
              <EphemeralTabScope>
                <CaptureVariations />
                <MoveDeletionContext.Provider value={deletion}>
                  <MoveControls readOnly={readOnly} />
                </MoveDeletionContext.Provider>
              </EphemeralTabScope>
            )}
            {editors && (
              <>
                <input aria-label="Comment input" />
                <div contentEditable tabIndex={0} aria-label="Editable comment" />
              </>
            )}
            {citation && (
              <EphemeralTabScope>
                <GameReferenceProvider>
                  <Comment comment={store.getState().currentNode().comment} />
                </GameReferenceProvider>
              </EphemeralTabScope>
            )}
            {modal && (
              <AppModal opened onClose={vi.fn()} title="Citation" transitionProps={{ duration: 0 }}>
                <button type="button">Dialog action</button>
                {controlsInModal && (
                  <EphemeralTabScope>
                    <MoveControls />
                  </EphemeralTabScope>
                )}
              </AppModal>
            )}
          </TreeStateProvider>
        </MantineProvider>
      </Provider>,
    );
  });
}

beforeEach(() => {
  citationMocks.lookup
    .mockReset()
    .mockResolvedValue({ candidates: [], complete: true, failures: [] });
  settings.chooseVariation = true;
  settings.keys.NEXT_MOVE = "arrowright";
  settings.keys.GO_TO_BRANCH_START = "arrowup";
  settings.keys.GO_TO_BRANCH_END = "arrowdown";
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  store = branchingStore();
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

test("next move at a branch lists every continuation, main line first, without moving", () => {
  render();

  press("ArrowRight");

  expect(store.getState().position).toEqual([]);
  expect(options()).toEqual([
    { text: "1. e4", selected: true },
    { text: "1. d4", selected: false },
    { text: "1. c4", selected: false },
  ]);
});

test("ArrowDown on the open variation listbox still changes the chooser selection", () => {
  render();
  press("ArrowRight");
  const listbox = document.querySelector<HTMLElement>('[role="listbox"]');
  expect(listbox).not.toBeNull();
  act(() => listbox!.focus());
  expect(document.activeElement).toBe(listbox);
  expect(options().map((option) => option.selected)).toEqual([true, false, false]);

  press("ArrowDown", { target: listbox! });

  expect(options().map((option) => option.selected)).toEqual([false, true, false]);
});

test("arrow down then next move plays the selected variation and closes the list", () => {
  render();

  press("ArrowRight");
  press("ArrowDown");
  press("ArrowDown");
  expect(options().map((option) => option.selected)).toEqual([false, false, true]);
  press("ArrowRight");

  expect(store.getState().position).toEqual([2]);
  expect(options()).toEqual([]);
});

test("arrow up wraps to the last variation and never jumps to the branch start", () => {
  store = middleGameStore();
  render();

  press("ArrowRight");
  press("ArrowUp");
  expect(store.getState().position).toEqual([0]);
  press("ArrowRight");

  expect(store.getState().position).toEqual([0, 1]);
});

test("previous move closes the list without moving, and a single continuation never opens it", () => {
  render();

  press("ArrowRight");
  press("ArrowLeft");
  expect(options()).toEqual([]);
  expect(store.getState().position).toEqual([]);

  press("ArrowRight");
  press("ArrowRight");
  press("ArrowRight");
  expect(store.getState().position).toEqual([0, 0]);
  expect(options()).toEqual([]);
});

test("with the setting off, next move follows the main line as before", () => {
  settings.chooseVariation = false;
  render();

  press("ArrowRight");

  expect(store.getState().position).toEqual([0]);
  expect(options()).toEqual([]);
});

test("a practice drill keeps following its own path", () => {
  render();
  act(() => store.getState().setPracticePath([1]));

  press("ArrowRight");

  expect(store.getState().position).toEqual([1]);
  expect(options()).toEqual([]);
});

test("arrow down wraps from the last variation back to the main line", () => {
  render();
  press("ArrowRight");

  press("ArrowDown");
  press("ArrowDown");
  expect(options().map((option) => option.selected)).toEqual([false, false, true]);
  press("ArrowDown");

  expect(options().map((option) => option.selected)).toEqual([true, false, false]);
  expect(store.getState().position).toEqual([]);
});

test.each(["ArrowLeft", "Escape"])(
  "%s closes the list in the middle of a game without moving",
  (key) => {
    store = middleGameStore();
    render();
    press("ArrowRight");
    expect(options()).toHaveLength(2);

    press(key);

    expect(options()).toEqual([]);
    expect(store.getState().position).toEqual([0]);
  },
);

test.each([
  { key: "ArrowUp", shiftKey: true },
  { key: "c", shiftKey: false },
])("$key closes the list even when navigation stays at the branching root", ({ key, shiftKey }) => {
  render();
  press("ArrowRight");
  expect(options()).toHaveLength(3);

  press(key, { shiftKey });

  expect(options()).toEqual([]);
  expect(store.getState().position).toEqual([]);
});

test("navigating away and back to the same node never resurrects the list", () => {
  render();
  press("ArrowRight");
  expect(options()).toHaveLength(3);

  act(() => store.getState().goToMove([0]));
  expect(options()).toEqual([]);
  act(() => store.getState().goToMove([]));

  expect(options()).toEqual([]);
  expect(store.getState().position).toEqual([]);
});

test("a rebound branch-end key closes the list and navigates to the branch end", () => {
  settings.keys.GO_TO_BRANCH_END = "j";
  render();
  press("ArrowRight");
  expect(options()).toHaveLength(3);

  press("j");

  expect(options()).toEqual([]);
  expect(store.getState().position).toEqual([0, 0]);
});

test.each([
  { binding: "k", key: "k", modifiers: undefined },
  { binding: "ctrl+arrowup", key: "ArrowUp", modifiers: { ctrlKey: true } },
])(
  "a branch-start key bound to $binding closes the list and navigates to the branch start",
  ({ binding, key, modifiers }) => {
    settings.keys.GO_TO_BRANCH_START = binding;
    store = middleGameStore();
    render();
    press("ArrowRight");
    expect(options()).toHaveLength(2);
    expect(store.getState().position).toEqual([0]);

    press(key, modifiers);

    expect(options()).toEqual([]);
    expect(store.getState().position).toEqual([]);
  },
);

test.each([
  { input: "comment", write: (tree: TreeStore) => tree.getState().setComment("x") },
  {
    input: "engine score",
    write: (tree: TreeStore) =>
      tree.getState().setEngineScore({ value: { type: "cp", value: 42 }, wdl: null }),
  },
])("writing a $input keeps the list and cursor in place", ({ write }) => {
  store = middleGameStore();
  render();
  press("ArrowRight");
  press("ArrowDown");
  const expectedOptions = [
    { text: "1... e5", selected: false },
    { text: "1... c5", selected: true },
  ];
  expect(options()).toEqual(expectedOptions);
  const previous = store.getState();

  act(() => write(store));

  expect(store.getState().root).not.toBe(previous.root);
  expect(store.getState().position).toBe(previous.position);
  expect(store.getState().position).toEqual([0]);
  expect(options()).toEqual(expectedOptions);
});

test("adding a legal variation closes the list without moving the cursor", () => {
  render();
  press("ArrowRight");
  expect(options()).toHaveLength(3);
  const previous = store.getState();

  act(() =>
    store.getState().makeMove({
      payload: "Nf3",
      changePosition: false,
      changeHeaders: false,
    }),
  );

  expect(store.getState().root).not.toBe(previous.root);
  expect(store.getState().root.children).not.toBe(previous.root.children);
  expect(store.getState().root.children.map((child) => child.san)).toEqual([
    "e4",
    "d4",
    "c4",
    "Nf3",
  ]);
  expect(store.getState().headers).toBe(previous.headers);
  expect(store.getState().position).toBe(previous.position);
  expect(store.getState().position).toEqual([]);
  expect(options()).toEqual([]);
});

test("a transposed leaf offers every continuation and plays the chosen variation", () => {
  const tree = defaultTree();
  const target = fixtureNode("e4", {
    children: [
      fixtureNode("e5", { halfMoves: 2 }),
      fixtureNode("c5", { halfMoves: 2 }),
      fixtureNode("e6", { halfMoves: 2 }),
    ],
  });
  tree.root.children = [target, fixtureNode("leaf", { fen: target.fen })];
  tree.position = [1];
  store = createTreeStore(undefined, tree);
  render();

  press("ArrowRight");

  expect(store.getState().position).toEqual([1]);
  expect(options()).toEqual([
    { text: "1... e5", selected: true },
    { text: "1... c5", selected: false },
    { text: "1... e6", selected: false },
  ]);
  press("ArrowDown");
  press("ArrowRight");

  expect(options()).toEqual([]);
  expect(store.getState().position).toEqual([0, 1]);
});

test("arrow down visits the next sibling then the main move and never scrolls at the main line end", () => {
  act(() => store.getState().goToMove([1]));
  render();

  press("ArrowDown");
  expect(store.getState().position).toEqual([2]);
  press("ArrowDown");
  expect(store.getState().position).toEqual([0]);
  press("ArrowDown");
  expect(store.getState().position).toEqual([0, 0]);

  const event = new KeyboardEvent("keydown", {
    key: "ArrowDown",
    code: "ArrowDown",
    bubbles: true,
    cancelable: true,
  });
  act(() => {
    document.dispatchEvent(event);
  });
  expect(store.getState().position).toEqual([0, 0]);
  expect(event.defaultPrevented).toBe(true);
});

function focusedRow(host: Element = document.body) {
  const row = document.createElement("div");
  row.tabIndex = 0;
  row.setAttribute("data-move-key-releases-focus", "true");
  host.append(row);
  act(() => row.focus());
  expect(document.activeElement).toBe(row);
  return row;
}

test.each([
  ["PREVIOUS_MOVE", "goToPrevious", "ArrowLeft", false],
  ["NEXT_MOVE", "goToNext", "ArrowRight", false],
  ["GO_TO_START", "goToStart", "ArrowUp", true],
  ["GO_TO_END", "goToEnd", "ArrowDown", true],
  ["GO_TO_BRANCH_START", "goToBranchStart", "ArrowUp", false],
  ["GO_TO_BRANCH_END", "goToBranchEndOrNextLine", "ArrowDown", false],
  ["NEXT_BRANCH", "nextBranch", "c", false],
  ["PREVIOUS_BRANCH", "previousBranch", "x", false],
  ["NEXT_BRANCHING", "nextBranching", "ArrowRight", true],
  ["PREVIOUS_BRANCHING", "previousBranching", "ArrowLeft", true],
  ["NEXT_OPEN_VARIATION", "goToNextOpenVariation", "u", false],
] as const)("%s runs and lets a marked row give up focus", (_shortcut, action, key, shiftKey) => {
  settings.chooseVariation = false;
  store = middleGameStore();
  render();
  const spy = vi.fn();
  act(() => store.setState({ [action]: spy }));
  const row = focusedRow();

  press(key, { target: row, shiftKey });

  expect(spy).toHaveBeenCalledOnce();
  expect(document.activeElement).not.toBe(row);
  row.remove();
});

test("arrows that only pick in the open variation list leave the row focused", () => {
  render();
  press("ArrowRight");
  expect(options()[0].selected).toBe(true);
  const row = focusedRow();

  press("ArrowDown", { target: row });

  expect(options()[1].selected).toBe(true);
  expect(document.activeElement).toBe(row);
  row.remove();
});

test("the row gives up focus and the move still happens, on a remapped key", () => {
  settings.chooseVariation = false;
  settings.keys.NEXT_MOVE = "j";
  store = middleGameStore();
  render();
  const row = focusedRow();

  press("j", { target: row });

  expect(document.activeElement).not.toBe(row);
  expect(store.getState().position).toEqual([0, 0]);
  row.remove();
});

test("non-navigation keys leave the row focused", () => {
  store = middleGameStore();
  render();
  const row = focusedRow();

  press("Delete", { target: row });
  press("Enter", { target: row });

  expect(document.activeElement).toBe(row);
  row.remove();
});

test("a control nested in a marked row keeps its focus", () => {
  store = middleGameStore();
  render();
  const row = focusedRow();
  const nested = document.createElement("button");
  row.append(nested);
  act(() => nested.focus());

  press("ArrowRight", { target: nested });

  expect(document.activeElement).toBe(nested);
  row.remove();
});

test("a row without the marker keeps focus on a move key", () => {
  store = middleGameStore();
  render();
  const row = focusedRow();
  row.removeAttribute("data-move-key-releases-focus");

  press("ArrowRight", { target: row });

  expect(document.activeElement).toBe(row);
  row.remove();
});

test("a row inside an open dialog-owned keyboard keeps focus", () => {
  store = middleGameStore();
  render({ modal: true });
  const dialog = document.querySelector('[role="dialog"]')!;
  const row = focusedRow(dialog);

  press("ArrowRight", { target: row });

  expect(document.activeElement).toBe(row);
  row.remove();
});

function focusDialogButton() {
  const button = document.querySelector<HTMLButtonElement>('[role="dialog"] button')!;
  expect(button).not.toBeNull();
  act(() => button.focus());
  expect(document.activeElement).toBe(button);
  expect(document.activeElement?.closest('[role="dialog"]')).not.toBeNull();
  return button;
}

test("Delete from a focused modal button preserves the background move and its subtree", () => {
  store = middleGameStore();
  render({ modal: true });
  const button = focusDialogButton();
  const before = store.getState();
  expect(before.dirty).toBe(false);

  const onKeydown = vi.fn();
  window.addEventListener("keydown", onKeydown);
  try {
    const event = press("Delete", { target: button });
    expect(onKeydown).toHaveBeenCalledExactlyOnceWith(event);
    expect(event.defaultPrevented).toBe(false);
  } finally {
    window.removeEventListener("keydown", onKeydown);
  }

  expect(store.getState().root).toBe(before.root);
  expect(store.getState().root.children).toBe(before.root.children);
  expect(store.getState().position).toEqual(before.position);
  expect(store.getState().dirty).toBe(false);
});

test.each(["ArrowLeft", "ArrowRight"])(
  "%s from a focused modal button preserves the background position",
  (key) => {
    settings.chooseVariation = false;
    store = middleGameStore();
    render({ modal: true });
    const button = focusDialogButton();

    press(key, { target: button });

    expect(store.getState().position).toEqual([0]);
  },
);

test.each([
  { shortcut: "GO_TO_START", key: "ArrowUp", shiftKey: true, expected: [] },
  { shortcut: "GO_TO_END", key: "ArrowDown", shiftKey: true, expected: [0, 0] },
  { shortcut: "NEXT_BRANCH", key: "c", shiftKey: false, expected: [1] },
  { shortcut: "PREVIOUS_BRANCH", key: "x", shiftKey: false, expected: [2] },
  { shortcut: "NEXT_BRANCHING", key: "ArrowRight", shiftKey: true, expected: [0, 0] },
  { shortcut: "PREVIOUS_BRANCHING", key: "ArrowLeft", shiftKey: true, expected: [] },
])(
  "modal-owned $shortcut stays put while the same key without the modal navigates",
  ({ key, shiftKey, expected }) => {
    store = branchingStore();
    store.getState().goToMove([0]);
    render({ modal: true });
    const button = focusDialogButton();
    const before = store.getState();

    const event = press(key, { target: button, shiftKey });

    expect(store.getState().position).toEqual([0]);
    expect(store.getState().root).toBe(before.root);
    expect(store.getState().dirty).toBe(false);
    expect(event.defaultPrevented).toBe(false);
    render();
    expect(document.querySelector('[aria-modal="true"]')).toBeNull();
    press(key, { shiftKey });
    expect(store.getState().position).toEqual(expected);
    expect(store.getState().position).not.toEqual([0]);
  },
);

test.each(["ArrowLeft", "ArrowRight"])(
  "%s steps an open engine-line preview board instead of the game, and the game again once it closes",
  (key) => {
    settings.chooseVariation = false;
    store = middleGameStore();
    render();
    const preview = document.createElement("div");
    preview.setAttribute("data-engine-line-preview", "");
    document.body.append(preview);

    press(key);
    expect(store.getState().position).toEqual([0]);

    preview.remove();
    press(key);
    expect(store.getState().position).toEqual(key === "ArrowLeft" ? [] : [0, 0]);
  },
);

test("modified arrows keep their own bindings while an engine-line preview board is open", () => {
  store = branchingStore();
  render();
  const preview = document.createElement("div");
  preview.setAttribute("data-engine-line-preview", "");
  document.body.append(preview);

  press("ArrowRight", { shiftKey: true });
  expect(store.getState().position).toEqual([0, 0]);
  press("ArrowUp", { shiftKey: true });
  expect(store.getState().position).toEqual([]);
  preview.remove();
});

test("Delete dispatched on document with a modal open preserves the background game", () => {
  store = middleGameStore();
  render({ modal: true });
  const button = focusDialogButton();
  act(() => button.blur());
  expect(document.activeElement).toBe(document.body);
  const before = store.getState();

  press("Delete");

  expect(store.getState().root).toBe(before.root);
  expect(store.getState().root.children).toBe(before.root.children);
  expect(store.getState().position).toEqual(before.position);
  expect(store.getState().dirty).toBe(false);
});

test("main-board Delete and ArrowLeft work again after the modal unmounts", () => {
  settings.chooseVariation = false;
  store = middleGameStore();
  render({ modal: true });
  focusDialogButton();
  render();
  expect(document.querySelector('[aria-modal="true"]')).toBeNull();

  press("ArrowLeft");
  expect(store.getState().position).toEqual([]);
  press("ArrowRight");
  expect(store.getState().position).toEqual([0]);
  press("Delete");
  expect(store.getState().position).toEqual([]);
  expect(store.getState().root.children).toEqual([]);
  expect(store.getState().dirty).toBe(true);
});

test("MoveControls inside the owning modal still navigate from a focused modal button", () => {
  settings.chooseVariation = false;
  store = middleGameStore();
  render({ modal: true, controlsInModal: true });
  const button = focusDialogButton();

  press("ArrowRight", { target: button });
  expect(store.getState().position).toEqual([0, 0]);
  press("ArrowLeft", { target: button });
  expect(store.getState().position).toEqual([0]);
});

test.each(["ArrowUp", "ArrowDown"])(
  "%s leaves the modal key default intact while background branch navigation is suspended",
  (key) => {
    store = middleGameStore();
    render({ modal: true });
    const button = focusDialogButton();

    const event = press(key, { target: button });

    expect(event.defaultPrevented).toBe(false);
    expect(store.getState().position).toEqual([0]);
  },
);

test.each(["slider", "grid"] as const)(
  "arrows on a focused %s leave the tree position unchanged",
  (role) => {
    settings.chooseVariation = false;
    store = middleGameStore();
    render();
    const widget = document.createElement("div");
    widget.setAttribute("role", role);
    widget.tabIndex = 0;
    host.append(widget);
    act(() => widget.focus());
    expect(document.activeElement).toBe(widget);

    for (const key of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]) {
      const event = press(key, { target: widget });
      expect(store.getState().position).toEqual([0]);
      expect(event.defaultPrevented).toBe(false);
    }

    widget.remove();
    press("ArrowLeft", { target: document.body });
    expect(store.getState().position).toEqual([]);
  },
);

test("readOnly keeps Delete harmless while ArrowLeft still navigates", () => {
  store = middleGameStore();
  render({ readOnly: true });
  const before = store.getState();

  press("Delete");

  expect(store.getState().root).toBe(before.root);
  expect(store.getState().position).toEqual([0]);
  expect(store.getState().dirty).toBe(false);
  press("ArrowLeft");
  expect(store.getState().position).toEqual([]);
  expect(store.getState().root).toBe(before.root);
  expect(store.getState().dirty).toBe(false);
});

test("a provided move deletion receives Delete at the cursor and the tree stays untouched", () => {
  store = middleGameStore();
  const deletion = { canDelete: vi.fn(() => true), delete: vi.fn() };
  render({ deletion });
  const before = store.getState();

  press("Delete");

  expect(deletion.delete).toHaveBeenCalledExactlyOnceWith([0]);
  expect(store.getState().root).toBe(before.root);
  expect(store.getState().position).toEqual([0]);
  expect(store.getState().dirty).toBe(false);
});

test("readOnly keeps Delete harmless even with a provided move deletion", () => {
  store = middleGameStore();
  const deletion = { canDelete: vi.fn(() => true), delete: vi.fn() };
  render({ readOnly: true, deletion });

  press("Delete");

  expect(deletion.delete).not.toHaveBeenCalled();
  expect(store.getState().root.children).toHaveLength(1);
});

test("Ctrl+Delete removes the whole side line and leaves the plain Delete binding unfired", () => {
  const tree = defaultTree();
  tree.root.children = [
    fixtureNode("e4", { children: [fixtureNode("e5", { halfMoves: 2 })] }),
    fixtureNode("d4", { children: [fixtureNode("d5", { halfMoves: 2 })] }),
  ];
  tree.position = [1, 0];
  store = createTreeStore(undefined, tree);
  render();

  press("Delete", { ctrlKey: true });

  let state = store.getState();
  expect(state.root.children.map((child) => child.san)).toEqual(["e4"]);
  expect(state.root.children[0].children.map((child) => child.san)).toEqual(["e5"]);
  expect(state.position).toEqual([]);
  // One edit: had Delete also fired, a single undo would bring back d4 without d5.
  act(() => store.getState().undo());
  state = store.getState();
  expect(state.root.children[1].children.map((child) => child.san)).toEqual(["d5"]);
});

test("Shift+Delete removes the moves after the cursor and keeps the cursor move", () => {
  store = middleGameStore();
  render();

  press("Delete", { shiftKey: true });

  const state = store.getState();
  expect(state.root.children.map((child) => child.san)).toEqual(["e4"]);
  expect(state.root.children[0].children).toEqual([]);
  expect(state.position).toEqual([0]);
});

test("Ctrl+ArrowUp promotes the cursor's variation without jumping to the branch start", () => {
  store = middleGameStore();
  store.getState().goToMove([0, 1]);
  render();

  press("ArrowUp", { ctrlKey: true });

  const state = store.getState();
  expect(state.root.children[0].children.map((child) => child.san)).toEqual(["c5", "e5"]);
  expect(state.position).toEqual([0, 0]);
});

test.each([
  ["a live game's move deletion", { deletion: { canDelete: () => true, delete: vi.fn() } }],
  ["readOnly", { readOnly: true }],
] as const)("%s keeps the variation edit keys harmless", (_label, renderOptions) => {
  store = middleGameStore();
  store.getState().goToMove([0, 1]);
  store.setState({ dirty: false });
  render(renderOptions);
  const before = store.getState().root;

  press("Delete", { ctrlKey: true });
  press("Delete", { shiftKey: true });
  press("ArrowUp", { ctrlKey: true });

  expect(store.getState().root).toBe(before);
  expect(store.getState().dirty).toBe(false);
});

test("opening a real commentary citation suspends background Delete and ArrowLeft", async () => {
  store = middleGameStore();
  store
    .getState()
    .setComment("0-1 Beerdsen,T (2520)-Bluebaum,M (2651) Elllobregat op 3rd 2022 (3)");
  store.setState({ dirty: false });
  render({ citation: true });
  const reference = host.querySelector<HTMLButtonElement>("[data-game-reference]");
  expect(reference).not.toBeNull();
  await act(async () => reference!.click());
  expect(citationMocks.lookup).toHaveBeenCalledOnce();
  const retry = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
    (button) => button.textContent === "GameReferences.Retry",
  );
  expect(retry).toBeDefined();
  await act(async () => retry!.click());
  expect(citationMocks.lookup).toHaveBeenCalledTimes(2);
  const button = focusDialogButton();
  expect(button.closest('[aria-modal="true"]')).not.toBeNull();
  const before = store.getState();

  press("Delete", { target: button });
  press("ArrowLeft", { target: button });

  expect(store.getState().root).toBe(before.root);
  expect(store.getState().root.children).toBe(before.root.children);
  expect(store.getState().position).toEqual([0]);
  expect(store.getState().dirty).toBe(false);
});

test.each(["input", "contenteditable"])(
  "Delete and ArrowLeft from a focused %s preserve the game without a modal",
  (editor) => {
    store = middleGameStore();
    render({ editors: true });
    expect(document.querySelector('[aria-modal="true"]')).toBeNull();
    const target = host.querySelector<HTMLElement>(
      editor === "input" ? "input" : '[contenteditable="true"]',
    )!;
    if (editor === "contenteditable") {
      // jsdom does not implement this browser property.
      Object.defineProperty(target, "isContentEditable", { value: true });
    }
    target.focus();
    expect(document.activeElement).toBe(target);
    const before = store.getState();

    for (const key of ["Delete", "ArrowLeft"]) {
      const event = press(key, { target });
      expect(store.getState().root).toBe(before.root);
      expect(store.getState().position).toEqual(before.position);
      expect(store.getState().dirty).toBe(false);
      expect(event.defaultPrevented).toBe(false);
    }
  },
);

test("the open-variation key steps through them in notation order and turns hidden variations on", () => {
  // 1.e4 (1.d4) (1.c4) e5: both alternatives are one move long.
  render();
  act(() => variations.set(false));

  press("u");
  expect(store.getState().position).toEqual([1]);
  expect(variations.shown).toBe(true);

  press("u");
  expect(store.getState().position).toEqual([2]);
  press("u");
  expect(store.getState().position).toEqual([1]);
});

test("the open-variation key leaves hidden variations hidden when there is nowhere to go", () => {
  const tree = defaultTree();
  tree.root.children = [fixtureNode("e4", { children: [fixtureNode("e5", { halfMoves: 2 })] })];
  store = createTreeStore(undefined, tree);
  render();
  act(() => variations.set(false));

  press("u");

  expect(store.getState().position).toEqual([]);
  expect(variations.shown).toBe(false);
});

test("the open-variation key typed into a comment field does not move the game", () => {
  render({ editors: true });
  const input = host.querySelector<HTMLInputElement>("input")!;
  input.focus();

  press("u", { target: input });

  expect(store.getState().position).toEqual([]);
});
