import { MantineProvider } from "@mantine/core";
import { parseUci } from "chessops";
import { Provider, createStore } from "jotai";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { moveHighlightAtom } from "@/state/atoms";
import { createTreeStore, type TreeStore } from "@/state/store/tree";
import { WorkspaceTabScope } from "@/state/tabScope";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { installResizeObserverStub } from "@/tests/resizeObserver";
import { TreeStateContext } from "./TreeStateContext";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("react-hotkeys-hook", () => ({ useHotkeys: vi.fn() }));
vi.mock("@/state/keybinds", async () => ({
  keyMapAtom: (await import("jotai")).atom({
    TOGGLE_BLUR: { keys: "ctrl+b" },
    COPY_PGN: { keys: "ctrl+k" },
  }),
}));
vi.mock("@/utils/sound", () => ({ playSound: vi.fn() }));
vi.mock("./OpeningName", () => ({ default: () => null }));
vi.mock("./GameReference", () => ({
  GameReferenceProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/common/Comment", () => ({
  default: ({ comment }: { comment: string }) => <span data-comment>{comment}</span>,
}));
vi.mock("@/chessground/Chessground", () => ({
  Chessground: (props: any) => (
    <div
      data-chessground
      data-fen={props.fen}
      data-orientation={props.orientation}
      data-turn={props.turnColor}
      data-check={String(props.check)}
      data-last-move={props.lastMove?.join("")}
      data-shapes={JSON.stringify(props.drawable.shapes)}
      data-view-only={String(props.viewOnly)}
    />
  ),
}));
vi.mock("./CompleteMoveCell", async () => ({
  NotationMoveActionsContext: (await import("react")).createContext(undefined),
  default: (props: any) => (
    <span data-move-cell={props.node.san} data-cell-comment={props.comment}>
      {props.move}
    </span>
  ),
}));
vi.mock("@tanstack/react-virtual", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-virtual")>()),
  useVirtualizer: (options: { count: number }) => ({
    scrollOffset: 0,
    getTotalSize: () => options.count * 30,
    getVirtualItems: () =>
      Array.from({ length: options.count }, (_, index) => ({ index, size: 30, start: index * 30 })),
    measureElement: () => {},
    getOffsetForIndex: (index: number, align: string) => [index * 30, align],
    scrollToOffset: () => {},
  }),
}));

import GameNotation from "./GameNotation";
import styles from "./GameNotation.module.css";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
installMatchMediaStub();
installResizeObserverStub();

let host: HTMLDivElement;
let root: Root;
let tree: TreeStore;
let jotai: ReturnType<typeof createStore>;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  tree = createTreeStore();
  jotai = createStore();
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

async function renderNotation() {
  await act(async () =>
    root.render(
      <MantineProvider env="test">
        <Provider store={jotai}>
          <TreeStateContext.Provider value={tree}>
            <WorkspaceTabScope tabId="diagram-test">
              <GameNotation topBar />
            </WorkspaceTabScope>
          </TreeStateContext.Provider>
        </Provider>
      </MantineProvider>,
    ),
  );
}

const diagrams = () => [...host.querySelectorAll<HTMLElement>("[data-notation-diagram]")];
const board = (diagram: Element) => diagram.querySelector<HTMLElement>("[data-chessground]")!;

/** Plays SAN moves from the store's root and returns the path of the last one. */
function play(...sans: string[]) {
  for (const san of sans) tree.getState().makeMove({ payload: san });
  return tree.getState().position;
}

test("a marked move shows the shared small board with its shapes, below the move and above its comment", async () => {
  const path = play("e4", "e5");
  tree.getState().goToMove([0]);
  tree.getState().setShapes([{ orig: "e2", dest: "e4", brush: "green" }]);
  tree.getState().setComment("Key position");
  tree.getState().toggleDiagram();
  tree.getState().goToMove(path);
  await renderNotation();

  expect(diagrams()).toHaveLength(1);
  const [diagram] = diagrams();
  expect(diagram.querySelector("[data-mini-board] [data-chessground]")).not.toBeNull();
  expect(board(diagram).dataset.fen).toBe(tree.getState().root.children[0].fen);
  expect(board(diagram).dataset.viewOnly).toBe("true");
  expect(JSON.parse(board(diagram).dataset.shapes!)).toEqual([
    { orig: "e2", dest: "e4", brush: "green" },
  ]);
  expect(board(diagram).dataset.orientation).toBe("white");
  expect(diagram.querySelector("[data-comment]")?.textContent).toBe("Key position");
  // The move's own cell no longer repeats the comment.
  expect(host.querySelector('[data-move-cell="e4"]')?.getAttribute("data-cell-comment")).toBe("");

  const rows = [...host.querySelectorAll("[data-index]")];
  const moveRow = rows.findIndex((row) => row.querySelector('[data-move-cell="e4"]'));
  expect(rows[moveRow + 1]).toBe(diagram.closest("[data-index]"));
});

test("a diagram inside a variation is drawn inside that variation's guide", async () => {
  play("e4", "e5");
  tree.getState().goToMove([0]);
  tree.getState().makeMove({ payload: "c5" });
  tree.getState().toggleDiagram([0, 1]);
  tree.getState().toggleDiagram([0, 0]);
  await renderNotation();

  const [mainline, variation] = diagrams();
  expect(board(mainline).dataset.fen).toBe(tree.getState().root.children[0].children[0].fen);
  expect(board(variation).dataset.fen).toBe(tree.getState().root.children[0].children[1].fen);
  expect(mainline.classList.contains(styles.variationBlock)).toBe(false);
  expect(mainline.style.getPropertyValue("--notation-variation-depth")).toBe("");
  expect(variation.classList.contains(styles.variationBlock)).toBe(true);
  expect(variation.style.getPropertyValue("--notation-variation-depth")).toBe("1");
});

test("clicking a diagram moves the board to its position", async () => {
  play("e4", "e5", "Nf3");
  tree.getState().toggleDiagram([0, 0]);
  await renderNotation();
  expect(tree.getState().position).toEqual([0, 0, 0]);

  const button = diagrams()[0].querySelector<HTMLButtonElement>("button")!;
  expect(button.getAttribute("aria-label")).toBe("Notation.DiagramGoTo");
  await act(async () => button.click());
  expect(tree.getState().position).toEqual([0, 0]);
});

test("the diagram follows the board's orientation", async () => {
  play("e4");
  tree.getState().toggleDiagram();
  tree.getState().setHeaders({ ...tree.getState().headers, orientation: "black" });
  await renderNotation();
  expect(board(diagrams()[0]).dataset.orientation).toBe("black");
});

test("side to move and check come from the position, not from ply parity", async () => {
  // Black moves first and gives check: the node is one move from the root, where counting plies
  // from a White start would make Black the side to move, yet White is to move and in check.
  const fen = "4k3/8/8/8/8/8/5q2/7K b - - 0 1";
  tree.getState().setHeaders({ ...tree.getState().headers, fen });
  const path = play("Qf1+");
  expect(path).toHaveLength(1);
  tree.getState().toggleDiagram(path);
  jotai.set(moveHighlightAtom, true);
  await renderNotation();
  expect(board(diagrams()[0]).dataset.turn).toBe("white");
  expect(board(diagrams()[0]).dataset.check).toBe("true");
  expect(board(diagrams()[0]).dataset.lastMove).toBe("f2f1");
});

test("a castling diagram highlights the king's destination, and no move without move highlighting", async () => {
  tree.getState().setHeaders({
    ...tree.getState().headers,
    fen: "4k3/8/8/8/8/8/8/4K2R w K - 0 1",
  });
  const path = play("O-O");
  expect(tree.getState().root.children[0].move).toEqual(parseUci("e1h1"));
  tree.getState().toggleDiagram(path);
  jotai.set(moveHighlightAtom, true);
  await renderNotation();
  expect(board(diagrams()[0]).dataset.lastMove).toBe("e1g1");

  await act(async () => jotai.set(moveHighlightAtom, false));
  expect(board(diagrams()[0]).dataset.lastMove).toBeUndefined();
  expect(board(diagrams()[0]).dataset.check).toBe("false");
});

test("the View menu toggles diagrams and hands the comment back to the move", async () => {
  play("e4");
  tree.getState().setComment("Key position");
  tree.getState().toggleDiagram();
  await renderNotation();
  expect(diagrams()).toHaveLength(1);

  const viewButton = host.querySelector<HTMLButtonElement>(
    'button[aria-label="Notation.ViewOptions"]',
  )!;
  await act(async () => viewButton.click());
  const toggleItem = () =>
    [
      ...document.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemcheckbox"]'),
    ].find((el) => el.textContent?.includes("Notation.ShowDiagrams"));
  await vi.waitFor(() => expect(toggleItem()).toBeDefined());
  expect(toggleItem()!.getAttribute("aria-checked")).toBe("true");
  await act(async () => toggleItem()!.click());
  expect(diagrams()).toHaveLength(0);
  expect(host.querySelector('[data-move-cell="e4"]')?.getAttribute("data-cell-comment")).toBe(
    "Key position",
  );
  expect(toggleItem()!.getAttribute("aria-checked")).toBe("false");

  await act(async () => toggleItem()!.click());
  expect(diagrams()).toHaveLength(1);
});

test("a marked start position shows a board before the first move", async () => {
  play("e4");
  tree.getState().toggleDiagram([]);
  await renderNotation();
  expect(diagrams()).toHaveLength(1);
  const rows = [...host.querySelectorAll("[data-index]")];
  expect(rows[0]).toBe(diagrams()[0].closest("[data-index]"));
  expect(board(diagrams()[0]).dataset.fen).toBe(tree.getState().root.fen);
  expect(board(diagrams()[0]).dataset.lastMove).toBeUndefined();
});
