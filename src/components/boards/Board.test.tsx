import { MantineProvider } from "@mantine/core";
import { Provider as JotaiProvider, createStore as createJotaiStore } from "jotai";
import { act, createRef, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { TreeStateContext, VariationChooserContext } from "../common/TreeStateContext";
import { createTreeStore, type TreeStore } from "@/state/store/tree";
import { createVariationChooserStore } from "@/state/store/variationChooser";
import { moveInputAtom } from "@/state/atoms";
import { installMatchMediaStub } from "@/tests/matchMedia";
import Board from "./Board";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

vi.mock("@/state/tabScope", () => ({
  useOwnerTabId: () => "board-test",
  useTabAtom: (family: (id: string) => unknown) => family("board-test"),
}));
vi.mock("@/state/atoms", async () => {
  const { atom } = await import("jotai");
  const evalOpen = atom(false);
  const showComments = atom(false);
  return {
    autoPromoteAtom: atom(false),
    createBestMovesAtom: () => atom(new Map()),
    enginesAtom: atom([]),
    tabEngineSettingsFamily: () => atom({ enabled: false }),
    evalOpenFamily: () => evalOpen,
    showCommentsFamily: () => showComments,
    enableBoardScrollAtom: atom(false),
    materialDisplayAtom: atom("none"),
    moveHighlightAtom: atom(false),
    moveInputAtom: atom(false),
    showArrowsAtom: atom(false),
    showConsecutiveArrowsAtom: atom(false),
    showCoordinatesAtom: atom("no"),
    showDestsAtom: atom(true),
    showVariationArrowsAtom: atom(false),
    snapArrowsAtom: atom(false),
  };
});
vi.mock("@/state/keybinds", async () => {
  const { atom } = await import("jotai");
  return { keyMapAtom: atom({ SWAP_ORIENTATION: { keys: [] }, TOGGLE_EVAL_BAR: { keys: [] } }) };
});
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("react-hotkeys-hook", () => ({ useHotkeys: () => {} }));
vi.mock("@/chessground/Chessground", () => ({ Chessground: () => null }));
vi.mock("@/chessground/useNodeDrawables", () => ({ useNodeDrawables: () => ({}) }));
vi.mock("@/utils/sound", () => ({ playSound: vi.fn() }));
vi.mock("./BoardFrame", () => ({ default: ({ children }: { children: ReactNode }) => children }));
vi.mock("./BoardBar", () => ({
  BoardBar: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./Clock", () => ({ default: () => null }));
vi.mock("./EvalBar", () => ({ default: () => null }));
vi.mock("./PromotionModal", () => ({ default: () => null }));
vi.mock("./AnnotationHint", () => ({ default: () => null }));
vi.mock("../common/ShowMaterial", () => ({ default: () => null }));
vi.mock("../common/IconAction", () => ({ default: () => null }));
vi.mock("../databases/FideInfo", () => ({ default: () => null }));
vi.mock("../panels/analysis/BestMoves", () => ({ arrowColors: [] }));

let host: HTMLDivElement;
let root: Root;
let tree: TreeStore;

beforeEach(() => {
  installMatchMediaStub();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  tree = createTreeStore();
});

afterEach(async () => {
  await act(async () => root.unmount());
  tree.dispose();
  host.remove();
  vi.unstubAllGlobals();
});

async function render(props: Partial<ComponentProps<typeof Board>> = {}, moveInput = false) {
  const atoms = createJotaiStore();
  atoms.set(moveInputAtom, moveInput);
  const onMove = vi.fn(async () => true);
  const storeMove = vi.spyOn(tree.getState(), "makeMove");
  const onKeyboardPremove = vi.fn(() => true);
  await act(async () =>
    root.render(
      <JotaiProvider store={atoms}>
        <MantineProvider>
          <TreeStateContext.Provider value={tree}>
            <VariationChooserContext.Provider value={createVariationChooserStore()}>
              <Board
                editingMode={false}
                boardRef={createRef()}
                onMove={onMove}
                {...props}
                onKeyboardPremove={onKeyboardPremove}
              />
            </VariationChooserContext.Provider>
          </TreeStateContext.Provider>
        </MantineProvider>
      </JotaiProvider>,
    ),
  );
  const grid = host.querySelector<HTMLDivElement>('[role="grid"]')!;
  grid.focus();
  expect(document.activeElement).toBe(grid);
  return { onMove, storeMove, onKeyboardPremove, grid };
}

async function press(grid: HTMLDivElement, ...keys: string[]) {
  for (const key of keys) {
    await act(async () => {
      grid.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    });
  }
}

test("pointer-focused grid yields Space without a selection and preserves Enter selection", async () => {
  const { grid, onMove } = await render();
  await act(async () => grid.dispatchEvent(new Event("pointerdown", { bubbles: true })));
  const space = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
  await act(async () => grid.dispatchEvent(space));
  expect(space.defaultPrevented).toBe(false);
  expect(host.querySelector('[aria-live="polite"]')?.textContent).toBe("");
  await press(grid, "Enter", "ArrowUp", "ArrowUp");
  const selectedSpace = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
  await act(async () => grid.dispatchEvent(selectedSpace));
  expect(selectedSpace.defaultPrevented).toBe(true);
  expect(onMove).toHaveBeenCalledExactlyOnceWith("e2e4");
});

test("focus-visible grid consumes Space for square selection", async () => {
  const { grid, onMove } = await render();
  grid.blur();
  vi.spyOn(grid, "matches").mockReturnValue(true);
  await act(async () => grid.focus());
  const space = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
  await act(async () => grid.dispatchEvent(space));
  expect(space.defaultPrevented).toBe(true);
  expect(host.querySelector('[aria-live="polite"]')?.textContent).toBe("Board.Aria.MoveSource");
  expect(onMove).not.toHaveBeenCalled();
});

test("history with variations disabled refuses a legal keyboard move", async () => {
  tree.getState().makeMoves({ payload: ["e4", "e5", "Nf3", "Nc6"] });
  tree.getState().goToMove([0, 0]);
  const { grid, onMove } = await render({ disableVariations: true });
  // Start at e2, select f1 and then c4 in the displayed position.
  await press(
    grid,
    "ArrowRight",
    "ArrowDown",
    "Enter",
    "ArrowLeft",
    "ArrowLeft",
    "ArrowLeft",
    "ArrowUp",
    "ArrowUp",
    "ArrowUp",
    " ",
  );
  expect(onMove).not.toHaveBeenCalled();
  expect(host.querySelector('[aria-live="polite"]')?.textContent).toBe("Board.Aria.IllegalMove");
});

test.each([
  { viewOnly: true, enablePremoves: true },
  { editingMode: true, enablePremoves: true },
  { movable: "none" as const },
])("restricted board refuses keyboard e2e4: %j", async (props) => {
  const { grid, onMove, storeMove, onKeyboardPremove } = await render(props);
  await press(grid, "Enter", "ArrowUp", "ArrowUp", " ");
  expect(onMove).not.toHaveBeenCalled();
  expect(storeMove).not.toHaveBeenCalled();
  expect(onKeyboardPremove).not.toHaveBeenCalled();
  expect(host.querySelector('[aria-live="polite"]')?.textContent).toBe("Board.Aria.IllegalMove");
});

test("editing without an onMove callback does not change the tree", async () => {
  const { grid, storeMove } = await render({ editingMode: true, onMove: undefined });
  await press(grid, "Enter", "ArrowUp", "ArrowUp", " ");
  expect(storeMove).not.toHaveBeenCalled();
  expect(tree.getState().position).toEqual([]);
  await press(grid, "Escape");
  expect(host.querySelector('[aria-live="polite"]')?.textContent).toBe(
    "Board.Aria.MoveSelectionCancelled",
  );
});

test("white-only movement refuses a legal black move", async () => {
  tree.getState().makeMove({ payload: "e4" });
  const { grid, onMove } = await render({ movable: "white" });
  await press(
    grid,
    "ArrowUp",
    "ArrowUp",
    "ArrowUp",
    "ArrowUp",
    "ArrowUp",
    " ",
    "ArrowDown",
    "ArrowDown",
    "Enter",
  );
  expect(onMove).not.toHaveBeenCalled();
  expect(host.querySelector('[aria-live="polite"]')?.textContent).toBe("Board.Aria.IllegalMove");
});

test("a legal live keyboard move reaches onMove", async () => {
  const { grid, onMove } = await render();
  await press(grid, "Enter", "ArrowUp", "ArrowUp", " ");
  expect(grid.getAttribute("aria-activedescendant")).toBe("board-square-e4");
  expect(onMove).toHaveBeenCalledExactlyOnceWith("e2e4");
});

test("keyboard source stays aria-selected after the focus square moves", async () => {
  const { grid } = await render();
  await press(grid, "Enter", "ArrowUp", "ArrowUp");
  expect(grid.getAttribute("aria-activedescendant")).toBe("board-square-e4");
  expect(host.querySelector("#board-square-e2")?.getAttribute("aria-selected")).toBe("true");
  expect(host.querySelector("#board-square-e4")?.getAttribute("aria-selected")).toBe("false");
});

async function typeMove(move: string) {
  const input = host.querySelector<HTMLInputElement>('input[placeholder="MoveInput.EnterMove"]')!;
  expect(input).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, move);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  return input;
}

test("history with variations disabled refuses a legal text move", async () => {
  tree.getState().makeMoves({ payload: ["e4", "e5", "Nf3", "Nc6"] });
  tree.getState().goToMove([0, 0]);
  const { onMove, storeMove } = await render({ disableVariations: true }, true);
  const input = await typeMove("Bc4");
  expect(onMove).not.toHaveBeenCalled();
  expect(storeMove).not.toHaveBeenCalled();
  expect(tree.getState().position).toEqual([0, 0]);
  expect(input.value).toBe("Bc4");
  expect(input.getAttribute("aria-invalid")).toBe("true");
});

test.each([
  { viewOnly: true },
  { editingMode: true },
  { movable: "none" as const },
  { movable: "black" as const },
  { practiceMove: { canMove: false, submitMove: vi.fn() } },
])("restricted board refuses text e4: %j", async (props) => {
  const { onMove, storeMove } = await render(props, true);
  const input = await typeMove("e4");
  expect(onMove).not.toHaveBeenCalled();
  expect(storeMove).not.toHaveBeenCalled();
  expect(tree.getState().position).toEqual([]);
  expect(input.value).toBe("e4");
  expect(input.getAttribute("aria-invalid")).toBe("true");
});

test("a legal live text move reaches onMove and clears the input", async () => {
  const { onMove, storeMove } = await render({ disableVariations: true }, true);
  const input = await typeMove(" e4 ");
  expect(onMove).toHaveBeenCalledExactlyOnceWith("e2e4");
  expect(storeMove).not.toHaveBeenCalled();
  expect(input.value).toBe("");
});

test("an invalid text move is refused", async () => {
  const { onMove, storeMove } = await render({}, true);
  const input = await typeMove("e5");
  expect(onMove).not.toHaveBeenCalled();
  expect(storeMove).not.toHaveBeenCalled();
  expect(input.value).toBe("e5");
  expect(input.getAttribute("aria-invalid")).toBe("true");
});

test("a text move in practice submits SAN without advancing the tree", async () => {
  const submitMove = vi.fn();
  const { onMove, storeMove } = await render({ practiceMove: { canMove: true, submitMove } }, true);
  const input = await typeMove("e2e4");
  expect(submitMove).toHaveBeenCalledExactlyOnceWith("e4");
  expect(onMove).not.toHaveBeenCalled();
  expect(storeMove).not.toHaveBeenCalled();
  expect(input.value).toBe("");
});

test.each([
  ["O-O", "e1h1"],
  ["e1h1", "e1h1"],
  ["e1g1", "e1g1"],
  ["O-O-O", "e1a1"],
  ["e1c1", "e1c1"],
])("legal text castling %s reaches onMove as %s", async (text, uci) => {
  tree.getState().setFen("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1");
  const { onMove, storeMove } = await render({}, true);
  const input = await typeMove(text);
  expect(onMove).toHaveBeenCalledExactlyOnceWith(uci);
  expect(storeMove).not.toHaveBeenCalled();
  expect(input.value).toBe("");
});

test.each([
  ["a8=Q+", "a7a8q"],
  ["a7a8n", "a7a8n"],
])("legal text promotion %s reaches onMove as %s", async (text, uci) => {
  tree.getState().setFen("7k/P7/8/8/8/8/8/7K w - - 0 1");
  const { onMove, storeMove } = await render({}, true);
  const input = await typeMove(text);
  expect(onMove).toHaveBeenCalledExactlyOnceWith(uci);
  expect(storeMove).not.toHaveBeenCalled();
  expect(input.value).toBe("");
});
