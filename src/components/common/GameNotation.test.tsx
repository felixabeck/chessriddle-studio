import { WorkspaceTabScope } from "@/state/tabScope";
import { parseUci } from "chessops";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createTreeStore, type TreeStore } from "@/state/store/tree";
import { TreeStateContext } from "./TreeStateContext";
import { createNode, defaultTree, type TreeNode } from "@/utils/treeReducer";
import {
  buildNotationRows,
  NOTATION_ROW_MAX_MOVES,
  pathForNotationNode,
  type NotationRow,
} from "./notationRows";

const atoms = vi.hoisted(() => ({
  invisible: Symbol("invisible"),
  comments: Symbol("comments"),
  variations: Symbol("variations"),
  table: Symbol("table"),
  keyMap: Symbol("key-map"),
}));
const virtualizerMock = vi.hoisted(() => ({
  current: null as null | { count: number; scrollToFn?: unknown },
  scrollCalls: [] as { index: number; options: unknown }[],
}));
const notationSettings = vi.hoisted(() => ({ showComments: false, tableView: false }));

vi.mock("@/state/atoms", () => ({
  invisibleFamily: () => atoms.invisible,
  showCommentsFamily: () => atoms.comments,
  showVariationsFamily: () => atoms.variations,
  tableViewAtom: atoms.table,
}));
vi.mock("@/state/keybinds", () => ({ keyMapAtom: atoms.keyMap }));
vi.mock("jotai", () => ({
  useAtom: (atom: symbol) => {
    if (atom === atoms.table) return [notationSettings.tableView, vi.fn()];
    return [false, vi.fn()];
  },
  useAtomValue: (atom: symbol) => {
    if (atom === atoms.variations) return true;
    if (atom === atoms.comments) return notationSettings.showComments;
    if (atom === atoms.keyMap) {
      return { TOGGLE_BLUR: { keys: "ctrl+b" }, COPY_PGN: { keys: "ctrl+k" } };
    }
    return false;
  },
}));
vi.mock("react-hotkeys-hook", () => ({ useHotkeys: vi.fn() }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("lucide-react", () => {
  const Icon = () => null;
  return {
    ArrowRight: Icon,
    Split: Icon,
    MessageSquare: Icon,
    MessageSquareOff: Icon,
    Eye: Icon,
    EyeOff: Icon,
    TableProperties: Icon,
    List: Icon,
    Minus: Icon,
    Plus: Icon,
  };
});
vi.mock("@/components/common/Comment", () => ({ default: () => null }));
vi.mock("./GameReference", () => ({
  GameReferenceProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/common/IconAction", () => ({
  default: ({ children, label, ...props }: any) => (
    <button type="button" aria-label={label} {...props}>
      {children}
    </button>
  ),
}));
vi.mock("./OpeningName", () => ({ default: () => null }));
vi.mock("./CompleteMoveCell", () => ({
  default: (props: any) => {
    const store = React.useContext(TreeStateContext)!;
    const path = pathForNotationNode(props.nodeIndex, props.node)!;
    return (
      <button
        type="button"
        data-move-cell="true"
        data-node={props.node.san}
        data-current={props.isCurrentVariation ? "true" : "false"}
        data-starting-comment={props.startingComment}
        onClick={() => store.getState().goToMove(path)}
      >
        {props.move}
      </button>
    );
  },
}));
vi.mock("@mantine/core", () => {
  const element = ({ children, ...props }: any) => <div {...props}>{children}</div>;
  const table = ({ children, ...props }: any) => <table {...props}>{children}</table>;
  table.Tbody = element;
  table.Tr = ({ children, ...props }: any) => <tr {...props}>{children}</tr>;
  table.Td = ({ children, ...props }: any) => <td {...props}>{children}</td>;
  return {
    Box: element,
    Divider: element,
    Group: element,
    Overlay: element,
    Paper: element,
    ScrollArea: ({ children, viewportRef }: any) => <div ref={viewportRef}>{children}</div>,
    Stack: element,
    Table: table,
    Text: ({ children, ...props }: any) => <span {...props}>{children}</span>,
    useComputedColorScheme: () => "light",
  };
});
vi.mock("@tanstack/react-virtual", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-virtual")>()),
  useVirtualizer: (options: { count: number; scrollToFn?: unknown }) => {
    virtualizerMock.current = options;
    return {
      getTotalSize: () => options.count * 30,
      getVirtualItems: () =>
        Array.from({ length: Math.min(options.count, 20) }, (_, index) => ({
          index,
          size: 30,
          start: index * 30,
        })),
      measureElement: () => undefined,
      scrollToIndex: (index: number, options: unknown) => {
        virtualizerMock.scrollCalls.push({ index, options });
      },
    };
  },
}));

import React from "react";
import { Virtualizer } from "@tanstack/react-virtual";
import GameNotation, {
  cancelNotationIndexScroll,
  scrollNotationElement,
  scrollNotationToOffset,
} from "./GameNotation";
import styles from "./GameNotation.module.css";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let host: HTMLDivElement;
let root: Root;
let store: TreeStore;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  store = createTreeStore();
  virtualizerMock.current = null;
  virtualizerMock.scrollCalls.length = 0;
  notationSettings.showComments = false;
  notationSettings.tableView = false;
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

test.each([false, true])(
  "cancels the real virtualizer's index verification (retry already queued: %s)",
  (retryQueued) => {
    const frames: FrameRequestCallback[] = [];
    const requestFrame = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback) => {
        frames.push(callback);
        return frames.length;
      });
    const viewport = document.createElement("div");
    Object.defineProperties(viewport, {
      clientHeight: { value: 100 },
      scrollHeight: { value: 3200 },
    });
    const offsets: number[] = [];
    const virtualizer = new Virtualizer<HTMLDivElement, Element>({
      count: 100,
      estimateSize: () => 32,
      getScrollElement: () => viewport,
      observeElementRect: (_instance, callback) => callback({ width: 300, height: 100 }),
      observeElementOffset: () => undefined,
      scrollToFn: scrollNotationElement,
    });
    Object.defineProperty(viewport, "scrollTo", {
      value: ({ top }: ScrollToOptions) => {
        const offset = top!;
        offsets.push(offset);
        virtualizer.scrollOffset = offset;
      },
    });
    const cleanup = virtualizer._didMount();
    try {
      virtualizer._willUpdate();
      virtualizer.elementsCache.set(2, viewport);
      virtualizer.scrollToIndex(2, { align: "center" });
      // This assertion also fails if a library upgrade renames the private cancellation field.
      expect(virtualizer).toHaveProperty("currentScrollToIndex", 2);
      if (retryQueued) {
        // Change the offset before verify runs, so it queues tryScroll for the old index.
        virtualizer.scrollOffset = 1000;
        frames.shift()!(0);
        frames.shift()!(0);
      }
      expect(frames).toHaveLength(1);
      const previousOffset = virtualizer.scrollOffset;
      const previousScrollCount = offsets.length;
      cancelNotationIndexScroll(virtualizer);
      expect(virtualizer).toHaveProperty("currentScrollToIndex", null);
      expect(virtualizer.scrollOffset).toBe(previousOffset);
      expect(offsets).toHaveLength(previousScrollCount);
      scrollNotationToOffset(virtualizer, 2000);
      expect(virtualizer.scrollOffset).toBe(2000);
      offsets.length = 0;
      while (frames.length) frames.shift()!(0);
      expect(offsets).toEqual([]);
      expect(virtualizer.scrollOffset).toBe(2000);
      // Resize corrections and subsequent short-row index navigation still use normal scrolling.
      virtualizer.options.scrollToFn(2000, { adjustments: 10 }, virtualizer);
      expect(virtualizer.scrollOffset).toBe(2010);
      virtualizer.scrollToIndex(3, { align: "center" });
      expect(virtualizer.scrollOffset).toBe(62);
      while (frames.length) frames.shift()!(0);
      expect(virtualizer.scrollOffset).toBe(62);
    } finally {
      cleanup();
      requestFrame.mockRestore();
    }
  },
);

test("wires the guarded scroll function into the mounted notation virtualizer", async () => {
  await act(async () => {
    root.render(
      <TreeStateContext.Provider value={store}>
        <WorkspaceTabScope tabId="notation-test">
          <GameNotation />
        </WorkspaceTabScope>
      </TreeStateContext.Provider>,
    );
  });

  expect(virtualizerMock.current?.scrollToFn).toBe(scrollNotationElement);
});

test("forwards a variation's starting comment prose to its mounted move cell", async () => {
  notationSettings.showComments = true;
  const state = defaultTree();
  const mainline = createNode({
    fen: "mainline b - - 0 1",
    move: parseUci("e2e4")!,
    san: "e4",
    halfMoves: 1,
  });
  const variation = createNode({
    fen: "variation b - - 0 1",
    move: parseUci("d2d4")!,
    san: "d4",
    halfMoves: 1,
  });
  variation.startingComment = "Another opening [%evp 0,34]";
  state.root.children = [mainline, variation];
  store.getState().setState(state);

  await act(async () => {
    root.render(
      <TreeStateContext.Provider value={store}>
        <WorkspaceTabScope tabId="notation-test">
          <GameNotation />
        </WorkspaceTabScope>
      </TreeStateContext.Provider>,
    );
  });

  expect(host.querySelector('[data-node="d4"]')?.getAttribute("data-starting-comment")).toBe(
    "Another opening",
  );
});

test("virtualizes a 20,000-node line and navigates/highlights mounted moves", async () => {
  const state = defaultTree();
  let parent = state.root;
  const sharedMove = parseUci("e2e4")!;
  const sharedNags: [] = [];
  const sharedShapes: [] = [];
  for (let index = 1; index <= 20_000; index += 1) {
    const child: TreeNode = {
      fen: "line w - - 0 1",
      move: sharedMove,
      san: `m${index}`,
      children: [],
      score: null,
      depth: null,
      halfMoves: index,
      shapes: sharedShapes,
      nags: sharedNags,
      comment: "",
    };
    parent.children = [child];
    parent = child;
  }
  store.getState().setState(state);

  await act(async () => {
    root.render(
      <TreeStateContext.Provider value={store}>
        <WorkspaceTabScope tabId={"notation-test"}>
          <GameNotation />
        </WorkspaceTabScope>
      </TreeStateContext.Provider>,
    );
  });

  const mounted = () => [...host.querySelectorAll<HTMLButtonElement>("[data-move-cell]")];
  expect(virtualizerMock.current?.count).toBeGreaterThan(600);
  expect(mounted().length).toBeLessThanOrEqual(20 * NOTATION_ROW_MAX_MOVES);
  expect(host.querySelector('[data-node="m1"][data-current="false"]')).not.toBeNull();

  await act(async () => mounted()[1].click());
  expect(store.getState().position).toEqual([0, 0]);
  expect(host.querySelector('[data-node="m2"][data-current="true"]')).not.toBeNull();
});

test("scrolls to a deep current node row after navigation", async () => {
  const state = defaultTree();
  let parent = state.root;
  const targetPath: number[] = [];
  let target: TreeNode = state.root;
  for (let index = 1; index <= 20_000; index += 1) {
    const child = createNode({
      fen: "line w - - 0 1",
      move: parseUci("e2e4")!,
      san: `m${index}`,
      halfMoves: index,
    });
    parent.children = [child];
    parent = child;
    targetPath.push(0);
    target = child;
  }
  store.getState().setState(state);

  await act(async () => {
    root.render(
      <TreeStateContext.Provider value={store}>
        <WorkspaceTabScope tabId={"notation-test"}>
          <GameNotation />
        </WorkspaceTabScope>
      </TreeStateContext.Provider>,
    );
  });

  const model = buildNotationRows(state.root, {
    showVariations: true,
    showComments: false,
    tableView: false,
  });
  const targetRow = model.rowForNode.get(target);
  expect(targetRow).toBeDefined();
  expect(targetRow).toBeGreaterThan(20);
  virtualizerMock.scrollCalls.length = 0;

  await act(async () => {
    store.getState().goToMove(targetPath);
  });

  expect(virtualizerMock.scrollCalls).toContainEqual({
    index: targetRow,
    options: { align: "center" },
  });
});

test("scrolls to the nearest listed ancestor inside a collapsed variation", async () => {
  const state = defaultTree();
  const move = parseUci("e2e4")!;
  const mainline = createNode({
    fen: "mainline w - - 0 1",
    move,
    san: "mainline",
    halfMoves: 1,
  });
  const mainlineContinuation = createNode({
    fen: "continuation b - - 0 1",
    move,
    san: "continuation",
    halfMoves: 2,
  });
  const variation = createNode({
    fen: "variation b - - 0 1",
    move,
    san: "variation",
    halfMoves: 2,
  });
  const deepVariation = createNode({
    fen: "deep-variation w - - 0 1",
    move,
    san: "deep-variation",
    halfMoves: 3,
  });
  state.root.children = [mainline];
  mainline.children = [mainlineContinuation, variation];
  variation.children = [deepVariation];
  store.getState().setState(state);

  await act(async () => {
    root.render(
      <TreeStateContext.Provider value={store}>
        <WorkspaceTabScope tabId={"notation-test"}>
          <GameNotation />
        </WorkspaceTabScope>
      </TreeStateContext.Provider>,
    );
  });

  const toggle = host.querySelector<HTMLButtonElement>('[aria-label="Notation.ToggleVariation"]');
  expect(toggle).not.toBeNull();
  await act(async () => toggle!.click());
  virtualizerMock.scrollCalls.length = 0;

  const collapsedModel = buildNotationRows(state.root, {
    showVariations: true,
    showComments: false,
    tableView: false,
    collapsedVariations: new Set([mainline]),
  });
  const ancestorRow = collapsedModel.rowForNode.get(mainline);
  expect(ancestorRow).toBeDefined();

  await act(async () => {
    store.getState().goToMove([0, 1, 0]);
  });

  expect(virtualizerMock.scrollCalls).toContainEqual({
    index: ancestorRow,
    options: { align: "center" },
  });
});

function isVariationBlockRow(row: NotationRow) {
  return row.type === "variation" || (row.type === "moves" && row.depth >= 1);
}

function variationGuideDepth(row: NotationRow) {
  if (row.type === "variation") return row.depth + 1;
  if (row.type === "moves" && row.depth >= 1) return row.depth;
  return null;
}

test.each([false, true])(
  "places the variation-block class on variation rows including a depth-0 toggle (tableView: %s)",
  async (tableView) => {
    notationSettings.showComments = true;
    notationSettings.tableView = tableView;

    const state = defaultTree();
    state.root.comment = "root comment";
    const move = parseUci("e2e4")!;
    const e4 = createNode({
      fen: "e4 b - - 0 1",
      move,
      san: "e4",
      halfMoves: 1,
    });
    e4.comment = "main comment";
    const e5 = createNode({
      fen: "e5 w - - 0 1",
      move,
      san: "e5",
      halfMoves: 2,
    });
    const d4 = createNode({
      fen: "d4 b - - 0 1",
      move,
      san: "d4",
      halfMoves: 1,
    });
    const d5 = createNode({
      fen: "d5 w - - 0 1",
      move,
      san: "d5",
      halfMoves: 2,
    });
    const nf6 = createNode({
      fen: "nf6 b - - 0 1",
      move,
      san: "Nf6",
      halfMoves: 2,
    });
    state.root.children = [e4, d4];
    e4.children = [e5];
    d4.children = [d5, nf6];
    store.getState().setState(state);

    await act(async () => {
      root.render(
        <TreeStateContext.Provider value={store}>
          <WorkspaceTabScope tabId="notation-test">
            <GameNotation />
          </WorkspaceTabScope>
        </TreeStateContext.Provider>,
      );
    });

    const model = buildNotationRows(state.root, {
      showVariations: true,
      showComments: true,
      tableView,
    });
    const firstLevelToggle = model.rows.find((row) => row.type === "variation" && row.depth === 0);
    expect(firstLevelToggle).toBeDefined();
    expect(model.rows.some((row) => row.type === "comment")).toBe(true);
    expect(model.rows.some((row) => row.type === "table")).toBe(tableView);
    expect(model.rows.some((row) => row.type === "moves" && row.depth === 0)).toBe(!tableView);

    const mounted = [...host.querySelectorAll("[data-index]")];
    expect(mounted.length).toBe(model.rows.length);
    for (const element of mounted) {
      const row = model.rows[Number(element.getAttribute("data-index"))];
      const surface = element.firstElementChild as HTMLElement | null;
      expect(surface?.classList.contains(styles.variationBlock)).toBe(isVariationBlockRow(row));
      const guideDepth = variationGuideDepth(row);
      expect(surface?.style.getPropertyValue("--variation-depth")).toBe(
        guideDepth === null ? "" : String(guideDepth),
      );
      expect(isVariationBlockRow(row) ? surface?.style.marginLeft : "").toBe("");
    }

    const firstLevelIndex = model.rows.indexOf(firstLevelToggle!);
    const depth1MovesIndex = model.rows.findIndex((row) => row.type === "moves" && row.depth === 1);
    expect(depth1MovesIndex).toBeGreaterThanOrEqual(0);
    expect(
      host
        .querySelector(`[data-index="${firstLevelIndex}"]`)
        ?.firstElementChild?.classList.contains(styles.variationBlock),
    ).toBe(true);
    expect(
      (
        host.querySelector(`[data-index="${firstLevelIndex}"]`)
          ?.firstElementChild as HTMLElement | null
      )?.style.getPropertyValue("--variation-depth"),
    ).toBe("1");
    expect(
      (
        host.querySelector(`[data-index="${depth1MovesIndex}"]`)
          ?.firstElementChild as HTMLElement | null
      )?.style.getPropertyValue("--variation-depth"),
    ).toBe("1");
  },
);

test("collapse still hides variation moves and keeps the toggle in the variation block", async () => {
  const state = defaultTree();
  const move = parseUci("e2e4")!;
  const e4 = createNode({
    fen: "e4 b - - 0 1",
    move,
    san: "e4",
    halfMoves: 1,
  });
  const d4 = createNode({
    fen: "d4 b - - 0 1",
    move,
    san: "d4",
    halfMoves: 1,
  });
  state.root.children = [e4, d4];
  store.getState().setState(state);

  await act(async () => {
    root.render(
      <TreeStateContext.Provider value={store}>
        <WorkspaceTabScope tabId="notation-test">
          <GameNotation />
        </WorkspaceTabScope>
      </TreeStateContext.Provider>,
    );
  });

  expect(host.querySelector('[data-node="d4"]')).not.toBeNull();
  const toggle = host.querySelector<HTMLButtonElement>('[aria-label="Notation.ToggleVariation"]');
  expect(toggle).not.toBeNull();
  expect(
    toggle!.closest("[data-index]")?.firstElementChild?.classList.contains(styles.variationBlock),
  ).toBe(true);

  await act(async () => toggle!.click());

  expect(host.querySelector('[data-node="d4"]')).toBeNull();
  expect(host.querySelector('[aria-label="Notation.ToggleVariation"]')).not.toBeNull();
  expect(
    host
      .querySelector('[aria-label="Notation.ToggleVariation"]')
      ?.closest("[data-index]")
      ?.firstElementChild?.classList.contains(styles.variationBlock),
  ).toBe(true);
});
