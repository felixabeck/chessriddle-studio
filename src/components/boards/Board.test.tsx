import { MantineProvider } from "@mantine/core";
import { Provider as JotaiProvider, createStore as createJotaiStore } from "jotai";
import { act, createRef, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { TreeStateContext, VariationChooserContext } from "../common/TreeStateContext";
import { createTreeStore, type TreeStore } from "@/state/store/tree";
import { createVariationChooserStore } from "@/state/store/variationChooser";
import { moveHighlightAtom, moveInputAtom, showVariationArrowsAtom } from "@/state/atoms";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { focusedDialogButton, press as pressKey } from "@/tests/keyboard";
import Board from "./Board";
import type { Chessground } from "@/chessground/Chessground";
import type { Config } from "@lichess-org/chessground/config";
import type { BoardBar } from "./BoardBar";
import type FideInfo from "../databases/FideInfo";

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
    BOARD_ANIMATION_DURATION_MS: { normal: 200 },
    boardAnimationSpeedAtom: atom("normal"),
    boardImageAtom: atom("chessriddle.svg"),
    boardWoodTextureAtom: atom(false),
    moveMethodAtom: atom("both"),
  };
});
vi.mock("@/state/keybinds", async () => {
  const { atom } = await import("jotai");
  return { keyMapAtom: atom({ SWAP_ORIENTATION: { keys: "f" }, TOGGLE_EVAL_BAR: { keys: "b" } }) };
});
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const boardConfig = vi.hoisted(() => ({ current: {} as any }));
const nativeBoard = vi.hoisted(() => ({
  enabled: false,
  api: { set: vi.fn(), destroy: vi.fn(), state: { dom: { bounds: { clear: vi.fn() } } } },
}));
vi.mock("@lichess-org/chessground", () => ({ Chessground: vi.fn(() => nativeBoard.api) }));
vi.mock("@/chessground/Chessground", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/chessground/Chessground")>();
  return {
    Chessground: (props: ComponentProps<typeof Chessground>) => {
      boardConfig.current = props;
      return nativeBoard.enabled ? <actual.Chessground {...props} /> : null;
    },
  };
});
vi.mock("@/chessground/useNodeDrawables", () => ({ useNodeDrawables: () => ({}) }));
vi.mock("@/utils/sound", () => ({ playSound: vi.fn() }));
vi.mock("./BoardFrame", () => ({ default: ({ children }: { children: ReactNode }) => children }));
const boardBar = vi.hoisted(() =>
  vi.fn(({ children }: ComponentProps<typeof BoardBar>) => children),
);
vi.mock("./BoardBar", () => ({ BoardBar: boardBar }));
vi.mock("./Clock", () => ({ default: () => null }));
vi.mock("./EvalBar", () => ({ default: () => null }));
vi.mock("./PromotionModal", () => ({ default: () => null }));
vi.mock("./AnnotationHint", () => ({ default: () => null }));
vi.mock("../common/ShowMaterial", () => ({ default: () => null }));
vi.mock("../common/IconAction", () => ({ default: () => null }));
const fideInfo = vi.hoisted(() => vi.fn((_props: ComponentProps<typeof FideInfo>) => null));
vi.mock("../databases/FideInfo", () => ({ default: fideInfo }));
vi.mock("../panels/analysis/BestMoves", () => ({ arrowColors: [] }));

let host: HTMLDivElement;
let root: Root;
let tree: TreeStore;

beforeEach(() => {
  nativeBoard.enabled = false;
  vi.clearAllMocks();
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
  vi.restoreAllMocks();
});

async function render(props: Partial<ComponentProps<typeof Board>> = {}, moveInput = false) {
  const atoms = createJotaiStore();
  atoms.set(moveInputAtom, moveInput);
  atoms.set(moveHighlightAtom, true);
  atoms.set(showVariationArrowsAtom, true);
  const onMove = vi.fn(async () => true);
  const storeMove = vi.spyOn(tree.getState(), "makeMove");
  const onKeyboardPremove = vi.fn(() => true);
  const variationChooser = createVariationChooserStore();
  const boardRef = createRef<HTMLDivElement>();
  const rerender = async (nextProps: Partial<ComponentProps<typeof Board>>) =>
    act(async () =>
      root.render(
        <JotaiProvider store={atoms}>
          <MantineProvider>
            <TreeStateContext.Provider value={tree}>
              <VariationChooserContext.Provider value={variationChooser}>
                <Board
                  editingMode={false}
                  boardRef={boardRef}
                  onMove={onMove}
                  {...nextProps}
                  onKeyboardPremove={onKeyboardPremove}
                />
              </VariationChooserContext.Provider>
            </TreeStateContext.Provider>
          </MantineProvider>
        </JotaiProvider>,
      ),
    );
  await rerender(props);
  const grid = host.querySelector<HTMLDivElement>('[role="grid"]')!;
  grid.focus();
  expect(document.activeElement).toBe(grid);
  return { onMove, storeMove, onKeyboardPremove, grid, rerender };
}

test("changing only whiteTime does not set native Chessground config", async () => {
  nativeBoard.enabled = true;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 400, 400),
  );
  const { rerender } = await render({ whiteTime: 60000 });
  const before: Config = boardConfig.current;
  nativeBoard.api.set.mockClear();
  nativeBoard.api.state.dom.bounds.clear.mockClear();
  await rerender({ whiteTime: 59900 });
  // Board still publishes fresh destinations and closures. The generic wrapper decides to skip.
  expect(boardConfig.current).not.toBe(before);
  expect(boardConfig.current.movable.dests).not.toBe(before.movable?.dests);
  expect(nativeBoard.api.set).not.toHaveBeenCalled();
  expect(nativeBoard.api.state.dom.bounds.clear).not.toHaveBeenCalled();
});

test.each(["white", "black"] as const)(
  "repertoire titles are non-clickable and independent of %s orientation",
  async (orientation) => {
    tree.getState().setHeaders({
      ...tree.getState().headers,
      white: "Italian Game",
      black: "Quiet plan",
      white_elo: 2400,
      black_elo: 2300,
      orientation,
    });
    await render({ repertoire: true });
    const bars = boardBar.mock.calls.slice(-2).map(([props]) => props);
    expect(bars.map((props) => props.name)).toEqual(["Quiet plan", "Italian Game"]);
    for (const props of bars) {
      expect(props.onNameClick).toBeUndefined();
      expect(props.rating).toBeUndefined();
    }
    expect(fideInfo).not.toHaveBeenCalled();
  },
);

test("repertoire bars use trimmed line titles with the event fallback for an unknown White header", async () => {
  tree.getState().setHeaders({
    ...tree.getState().headers,
    white: "  ? ",
    event: "  Najdorf main line  ",
    black: "  English attack  ",
  });
  await render({ repertoire: true });
  const bars = boardBar.mock.calls.slice(-2).map(([props]) => props);
  expect(bars.map((props) => props.name)).toEqual(["English attack", "Najdorf main line"]);
  for (const props of bars) expect(props.onNameClick).toBeUndefined();
});

test("player bars remain clickable and open FideInfo for that player", async () => {
  tree.getState().setHeaders({
    ...tree.getState().headers,
    white: "White Player",
    black: "Black Player",
    white_elo: 2400,
    black_elo: 2300,
  });
  await render();
  const bars = boardBar.mock.calls.slice(-2).map(([props]) => props);
  expect(bars.map((props) => props.name)).toEqual(["Black Player", "White Player"]);
  expect(bars.map((props) => props.rating)).toEqual([2300, 2400]);
  expect(bars[0].onNameClick).toBeTypeOf("function");
  expect(bars[1].onNameClick).toBeTypeOf("function");
  await act(async () => bars[1].onNameClick?.());
  expect(
    fideInfo.mock.calls.slice(-2).map(([props]) => ({ name: props.name, opened: props.opened })),
  ).toEqual([
    { name: "White Player", opened: true },
    { name: "Black Player", opened: false },
  ]);
});

async function press(grid: HTMLDivElement, ...keys: string[]) {
  for (const key of keys) {
    await act(async () => {
      grid.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    });
  }
}

test("swap orientation ignores a focused modal button and still flips outside the dialog", async () => {
  const { grid } = await render();
  const { button } = focusedDialogButton(host);
  expect(document.activeElement).toBe(button);
  const before = tree.getState();
  expect(before.dirty).toBe(false);

  const event = pressKey("f", { target: button });

  expect(tree.getState().headers.orientation).toBe(before.headers.orientation);
  expect(tree.getState().dirty).toBe(false);
  expect(event.defaultPrevented).toBe(false);
  grid.focus();
  pressKey("f", { target: grid });
  expect(tree.getState().headers.orientation).toBe("black");
  expect(tree.getState().dirty).toBe(true);
});

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
  expect(host.querySelector("#board-square-e2")?.getAttribute("aria-selected")).toBe("false");
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
  expect(input.getAttribute("aria-label")).toBe("MoveInput.EnterMove");
  const errorId = input.getAttribute("aria-describedby");
  expect(errorId).toBeTruthy();
  const error = document.getElementById(errorId!);
  expect(error?.textContent).toBe("MoveInput.InvalidMove");
  expect(error?.getAttribute("aria-live")).toBe("polite");

  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Bc");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(document.getElementById(errorId!)).toBeNull();
  expect(host.textContent).not.toContain("MoveInput.InvalidMove");
  expect(input.hasAttribute("aria-describedby")).toBe(false);
  expect(input.getAttribute("aria-invalid")).toBe("false");
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

test("practice hides variation arrows and draws only a legal hint arrow", async () => {
  tree.getState().makeMove({ payload: "e4" });
  tree.getState().goToStart();
  tree.getState().makeMove({ payload: "d4" });
  tree.getState().goToStart();
  await render();
  expect(boardConfig.current.drawable.autoShapes).toHaveLength(2);
  await render({ practiceMove: { canMove: true, hintSan: "Nf3", submitMove: vi.fn() } });
  expect(boardConfig.current.drawable.autoShapes).toEqual([
    { orig: "g1", dest: "f3", brush: "green" },
  ]);
  await render({ practiceMove: { canMove: true, hintSan: "invalid", submitMove: vi.fn() } });
  expect(boardConfig.current.drawable.autoShapes).toEqual([]);
});

test("a rejected practice move reapplies the position and legal destinations", async () => {
  await render({ practiceMove: { canMove: true, submitMove: vi.fn() } });
  const before = boardConfig.current;
  await act(async () => boardConfig.current.movable.events.after("e2", "e4", {}));
  expect(boardConfig.current).not.toBe(before);
  expect(boardConfig.current.fen).toBe(before.fen);
  expect(boardConfig.current.movable.dests.get("e2")).toContain("e4");
});

test.each([
  ["5k2/8/8/8/8/8/8/4K2R w K - 0 1", "O-O", "O-O+", ["e1", "g1"]],
  ["3k4/8/8/8/8/8/8/R3K3 w Q - 0 1", "O-O-O", "O-O-O+", ["e1", "c1"]],
  ["4k2r/8/8/8/8/8/8/5K2 b k - 0 1", "O-O", "O-O+", ["e8", "g8"]],
  ["4k3/8/8/8/8/8/8/4K2R w K - 0 1", "O-O", "O-O", ["e1", "g1"]],
] as const)(
  "castling highlights the king destination from %s",
  async (fen, move, san, lastMove) => {
    tree.getState().setFen(fen);
    tree.getState().makeMove({ payload: move });
    expect(tree.getState().currentNode().san).toBe(san);
    await render();
    expect(boardConfig.current.lastMove).toEqual(lastMove);
  },
);

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
