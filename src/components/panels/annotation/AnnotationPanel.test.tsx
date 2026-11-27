import { MantineProvider } from "@mantine/core";
import { Provider, createStore } from "jotai";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import MoveControls from "@/components/common/MoveControls";
import { TreeStateContext, VariationChooserContext } from "@/components/common/TreeStateContext";
import { chooseVariationAtom } from "@/state/atoms";
import { createTreeStore, type TreeStore } from "@/state/store/tree";
import { createVariationChooserStore } from "@/state/store/variationChooser";
import { EphemeralTabScope } from "@/state/tabScope";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { installResizeObserverStub } from "@/tests/resizeObserver";
import AnnotationPanel from "./AnnotationPanel";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/utils/sound", () => ({ playSound: vi.fn() }));
vi.mock("@/platform/native", () => ({ platform: vi.fn(() => "linux") }));
vi.mock("./AnnotationEditor", () => ({ default: () => null }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
installMatchMediaStub();
installResizeObserverStub();

let host: HTMLDivElement;
let root: Root;
let tree: TreeStore;

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
});

async function renderPanel(withControls = false) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const atoms = createStore();
  atoms.set(chooseVariationAtom, false);
  const chooser = createVariationChooserStore();
  await act(async () => {
    root.render(
      <MantineProvider>
        <Provider store={atoms}>
          <TreeStateContext.Provider value={tree}>
            <VariationChooserContext.Provider value={chooser}>
              <AnnotationPanel />
              {withControls && (
                <EphemeralTabScope>
                  <MoveControls />
                </EphemeralTabScope>
              )}
            </VariationChooserContext.Provider>
          </TreeStateContext.Provider>
        </Provider>
      </MantineProvider>,
    );
  });
}

function goodButton() {
  return host.querySelector<HTMLButtonElement>('button[aria-label="Annotate.Good"]')!;
}

function clockInput() {
  return Array.from(host.querySelectorAll<HTMLLabelElement>("label")).find(
    (label) => label.textContent === "Board.Annotate.Clock",
  )!.control as HTMLInputElement;
}

async function setDraft(input: HTMLInputElement, value: string) {
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    valueSetter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function pressKey(
  target: EventTarget,
  key: string,
  options: KeyboardEventInit = {},
): Promise<KeyboardEvent> {
  const event = new KeyboardEvent("keydown", {
    key,
    code: key,
    bubbles: true,
    cancelable: true,
    ...options,
  });
  await act(async () => {
    target.dispatchEvent(event);
  });
  return event;
}

test("the good-move symbol is disabled at the root and enabled after a move", async () => {
  tree = createTreeStore();
  await renderPanel();
  expect(tree.getState().position).toEqual([]);
  expect(goodButton().disabled).toBe(true);

  await act(async () => {
    tree.getState().makeMove({ payload: "e4" });
  });
  expect(tree.getState().position).toEqual([0]);
  expect(goodButton().disabled).toBe(false);
});

test("the show-more button sits outside every separator (no nested interactive control)", async () => {
  tree = createTreeStore();
  await renderPanel();
  const showMore = host.querySelector<HTMLButtonElement>('button[aria-label="Annotate.ShowMore"]')!;
  expect(showMore).not.toBeNull();
  expect(showMore.closest('[role="separator"]')).toBeNull();
  expect(host.querySelectorAll('[role="separator"] button')).toHaveLength(0);
});

test("clock field is disabled at the root, saves on Enter/Tab/Shift+Tab, removes on empty, and selects next value", async () => {
  tree = createTreeStore();
  await act(async () => {
    tree.getState().makeMove({ payload: "e4" });
    tree.getState().makeMove({ payload: "e5" });
    tree.getState().setClock(5100);
    tree.getState().makeMove({ payload: "Nf3" });
    tree.getState().goToStart();
  });
  await renderPanel(true);

  const input = clockInput();
  expect(input.disabled).toBe(true);
  expect(input.value).toBe("");

  await act(async () => {
    tree.getState().goToNext();
  });
  expect(input.disabled).toBe(false);
  expect(input.value).toBe("");

  // Tab on an empty move without clock skips without marking dirty.
  await act(async () => {
    tree.setState({ dirty: false });
    input.focus();
  });
  await pressKey(input, "Tab");
  expect(tree.getState().position).toEqual([0, 0]);
  expect(tree.getState().dirty).toBe(false);
  expect(document.activeElement).toBe(input);
  expect(input.value).toBe("1:25");
  expect(input.selectionStart).toBe(0);
  expect(input.selectionEnd).toBe(4);

  // Unchanged Tab advances without writing.
  const historyBeforeUnchanged = tree.getState().history.past.length;
  await pressKey(input, "Tab");
  expect(tree.getState().position).toEqual([0, 0, 0]);
  expect(tree.getState().history.past).toHaveLength(historyBeforeUnchanged);

  // Enter at the last move saves and stays, normalizing 86 -> 1:26.
  await setDraft(input, "86");
  await pressKey(input, "Enter");
  expect(tree.getState().position).toEqual([0, 0, 0]);
  expect(tree.getState().currentNode().clock).toBe(5160);
  expect(input.value).toBe("1:26");

  // Shift+Tab saves and moves back, keeping focus and selecting the previous move's value.
  await setDraft(input, "1:24");
  await pressKey(input, "Tab", { shiftKey: true });
  expect(tree.getState().position).toEqual([0, 0]);
  expect(tree.getState().getNode([0, 0, 0])?.clock).toBe(5040);
  expect(document.activeElement).toBe(input);
  expect(input.value).toBe("1:25");
  expect(input.selectionStart).toBe(0);
  expect(input.selectionEnd).toBe(4);

  // Clearing text removes the clock and moves to the first move.
  await setDraft(input, "");
  await pressKey(input, "Tab", { shiftKey: true });
  expect(tree.getState().position).toEqual([0]);
  expect(tree.getState().getNode([0, 0])?.clock).toBeUndefined();

  // Shift+Tab on the first move saves and stays (never lands on disabled root).
  await setDraft(input, "90");
  await pressKey(input, "Tab", { shiftKey: true });
  expect(tree.getState().position).toEqual([0]);
  expect(tree.getState().currentNode().clock).toBe(5400);
  expect(input.disabled).toBe(false);
});

test("Enter on a non-last move saves and advances to the next half-move with text selected", async () => {
  tree = createTreeStore();
  await act(async () => {
    tree.getState().makeMove({ payload: "e4" });
    tree.getState().makeMove({ payload: "e5" });
    tree.getState().setClock(5100);
    tree.getState().goToMove([0]);
  });
  await renderPanel(true);

  const input = clockInput();
  await act(async () => input.focus());
  await setDraft(input, "86");
  await pressKey(input, "Enter");

  expect(tree.getState().position).toEqual([0, 0]);
  expect(tree.getState().getNode([0])?.clock).toBe(5160);
  expect(document.activeElement).toBe(input);
  expect(input.value).toBe("1:25");
  expect(input.selectionStart).toBe(0);
  expect(input.selectionEnd).toBe(4);
});

test("invalid clock stays with error, Tab at final repeated position never jumps back, and hotkeys ignore typing", async () => {
  tree = createTreeStore();
  await act(async () => {
    for (const san of ["Nf3", "Nf6", "Ng1", "Ng8"]) {
      tree.getState().makeMove({ payload: san });
    }
    tree.getState().goToMove([0, 0]);
    tree.getState().setClock(4800);
    tree.getState().goToMove([0]);
  });
  await renderPanel(true);

  const input = clockInput();
  await act(async () => input.focus());

  // MoveControls hotkeys must not fire while typing in the Clock input.
  await pressKey(input, "ArrowRight");
  await pressKey(input, "ArrowLeft");
  await pressKey(input, "Delete");
  expect(tree.getState().position).toEqual([0]);

  // Invalid input shows error and prevents Tab navigation.
  await setDraft(input, "601");
  await pressKey(input, "Tab");
  expect(tree.getState().position).toEqual([0]);
  expect(tree.getState().currentNode().clock).toBeUndefined();
  expect(input.getAttribute("aria-invalid")).toBe("true");
  expect(host.textContent).toContain("Board.Annotate.InvalidClock");

  // External navigation while focused resets the invalid draft to the new node's stored value and clears error.
  await act(async () => {
    tree.getState().goToMove([0, 0]);
  });
  expect(input.value).toBe("1:20");
  expect(input.getAttribute("aria-invalid")).not.toBe("true");

  // At the final repeated position (children.length === 0), Tab saves and stays.
  await act(async () => {
    tree.getState().goToMove([0, 0, 0, 0]);
    input.focus();
  });
  await setDraft(input, "85");
  await pressKey(input, "Tab");
  expect(tree.getState().position).toEqual([0, 0, 0, 0]);
  expect(tree.getState().currentNode().clock).toBe(5100);
  expect(input.value).toBe("1:25");
});

test("Escape reverts without saving and blurs, blur saves valid or reverts invalid, and undo resets draft", async () => {
  tree = createTreeStore();
  await act(async () => {
    tree.getState().makeMove({ payload: "e4" });
    tree.getState().setClock(5160);
    tree.getState().makeMove({ payload: "e5" });
    tree.getState().goToMove([0]);
  });
  await renderPanel(true);

  const input = clockInput();
  await act(async () => input.focus());
  await setDraft(input, "80");
  await pressKey(input, "Escape");
  expect(tree.getState().currentNode().clock).toBe(5160);
  expect(input.value).toBe("1:26");
  expect(document.activeElement).not.toBe(input);

  // MoveControls ArrowRight works immediately after Escape blurred the input.
  await pressKey(document.body, "ArrowRight");
  expect(tree.getState().position).toEqual([0, 0]);

  // Blur saves a valid changed draft without navigating.
  await act(async () => input.focus());
  await setDraft(input, "84");
  await act(async () => input.blur());
  expect(tree.getState().position).toEqual([0, 0]);
  expect(tree.getState().currentNode().clock).toBe(5040);
  expect(input.value).toBe("1:24");

  // Blur reverts an invalid draft without writing.
  await act(async () => input.focus());
  await setDraft(input, "abc");
  await pressKey(input, "Enter");
  expect(input.getAttribute("aria-invalid")).toBe("true");
  await act(async () => input.blur());
  expect(tree.getState().currentNode().clock).toBe(5040);
  expect(input.value).toBe("1:24");
  expect(input.getAttribute("aria-invalid")).not.toBe("true");

  // Undo reverts setClock and updates the field draft.
  await act(async () => {
    tree.getState().undo();
  });
  expect(tree.getState().currentNode().clock).toBeUndefined();
  expect(input.value).toBe("");
});
