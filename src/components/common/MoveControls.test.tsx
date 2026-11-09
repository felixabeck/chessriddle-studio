import { MantineProvider } from "@mantine/core";
import { Provider } from "jotai";
import { act, useContext } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createTreeStore, type TreeStore } from "@/state/store/tree";
import { EphemeralTabScope } from "@/state/tabScope";
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
    DELETE_MOVE: "delete",
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

function render({
  modal = false,
  controlsInModal = false,
  readOnly = false,
  citation = false,
  editors = false,
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
            {!controlsInModal && <MoveControls readOnly={readOnly} />}
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
                {controlsInModal && <MoveControls />}
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
    input: "score",
    write: (tree: TreeStore) =>
      tree.getState().setScore({ value: { type: "cp", value: 42 }, wdl: null }),
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

test("arrow down at a line end jumps to the next line and never scrolls at the last one", () => {
  act(() => store.getState().goToMove([0, 0]));
  render();

  press("ArrowDown");
  expect(store.getState().position).toEqual([1]);
  press("ArrowDown");
  expect(store.getState().position).toEqual([2]);

  const event = new KeyboardEvent("keydown", {
    key: "ArrowDown",
    code: "ArrowDown",
    bubbles: true,
    cancelable: true,
  });
  act(() => {
    document.dispatchEvent(event);
  });
  expect(store.getState().position).toEqual([2]);
  expect(event.defaultPrevented).toBe(true);
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
