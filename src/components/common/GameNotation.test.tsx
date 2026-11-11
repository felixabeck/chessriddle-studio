import { WorkspaceTabScope } from "@/state/tabScope";
import { parseUci } from "chessops";
import { createInstance } from "i18next";
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
  current: null as null | { count: number },
  scrollCalls: [] as { index: number; options: unknown }[],
  measured: [] as Element[],
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
vi.mock("./CompleteMoveCell", async () => ({
  NotationMoveActionsContext: (await import("react")).createContext<
    import("./CompleteMoveCell").NotationMoveActions | undefined
  >(undefined),
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
        data-analysis={props.analysis ? "true" : "false"}
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
  useVirtualizer: (options: { count: number }) => {
    virtualizerMock.current = options;
    let target: { index: number; align: "center" | "start" };
    const virtualizer = {
      scrollOffset: 0,
      getTotalSize: () => options.count * 30,
      getVirtualItems: () =>
        Array.from({ length: Math.min(options.count, 20) }, (_, index) => ({
          index,
          size: 30,
          start: index * 30,
        })),
      measureElement: (element: Element | null) => {
        if (element) virtualizerMock.measured.push(element);
      },
      getOffsetForIndex: (index: number, align: "center" | "start") => {
        target = { index, align };
        return [index * 30, align];
      },
      scrollToOffset: (offset: number) => {
        virtualizer.scrollOffset = offset;
        virtualizerMock.scrollCalls.push({ index: offset / 30, options: { align: target.align } });
      },
    };
    return virtualizer;
  },
}));

import React from "react";
import { elementScroll, Virtualizer } from "@tanstack/react-virtual";
import GameNotation, { scrollNotationToIndex } from "./GameNotation";
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
  virtualizerMock.measured.length = 0;
  notationSettings.showComments = false;
  notationSettings.tableView = false;
});

test.each([false, true])(
  "renders and measures the inline end, forwards analysis, and removes the bottom result (tableView: %s)",
  async (tableView) => {
    notationSettings.tableView = tableView;
    const state = defaultTree();
    state.headers.result = "0-1";
    const end = createNode({
      fen: "end b - - 0 1",
      move: parseUci("e2e4")!,
      san: "e4",
      halfMoves: 1,
    });
    const analysis = createNode({
      fen: "analysis w - - 0 2",
      move: parseUci("e7e5")!,
      san: "e5",
      halfMoves: 2,
    });
    end.gameEnd = { termination: "Abandoned" };
    end.children = [analysis];
    state.root.children = [end];
    store.getState().setState(state);
    await act(async () =>
      root.render(
        <TreeStateContext.Provider value={store}>
          <WorkspaceTabScope tabId="notation-test">
            <GameNotation />
          </WorkspaceTabScope>
        </TreeStateContext.Provider>,
      ),
    );
    const boundary = host.querySelector("[data-notation-game-end]")!;
    expect(boundary.textContent).toBe(
      "0-1 · Board.Analysis.Tablebase.BlackWins · AbandonedNotation.AnalysisAfterGame",
    );
    expect(virtualizerMock.measured).toContain(boundary.closest("[data-index]"));
    expect(host.textContent?.match(/Board.Analysis.Tablebase.BlackWins/g)).toHaveLength(1);
    expect(host.querySelector('[data-node="e4"]')?.getAttribute("data-analysis")).toBe("false");
    expect(host.querySelector('[data-node="e5"]')?.getAttribute("data-analysis")).toBe("true");
  },
);

test.each([
  ["Normal", "1-0", "Board.Analysis.Tablebase.WhiteWins"],
  ["Unterminated", "1/2-1/2", "Board.Analysis.Tablebase.Draw"],
  [undefined, "*", undefined],
] as const)(
  "a leaf end hides the analysis label and suppresses termination %s",
  async (termination, result, resultText) => {
    const state = defaultTree();
    state.headers.result = result;
    const end = createNode({
      fen: "end b - - 0 1",
      move: parseUci("e2e4")!,
      san: "e4",
      halfMoves: 1,
    });
    end.gameEnd = { termination };
    state.root.children = [end];
    store.getState().setState(state);
    await act(async () =>
      root.render(
        <TreeStateContext.Provider value={store}>
          <WorkspaceTabScope tabId="notation-test">
            <GameNotation />
          </WorkspaceTabScope>
        </TreeStateContext.Provider>,
      ),
    );
    const boundary = host.querySelector("[data-notation-game-end]")!;
    expect(boundary.textContent).toBe(resultText ? `${result} · ${resultText}` : result);
    expect(host.textContent).not.toContain("Notation.AnalysisAfterGame");
  },
);

test("without an end it retains the bottom result and emits no gameEnd row", async () => {
  const state = defaultTree();
  state.headers.result = "1-0";
  state.root.children = [
    createNode({ fen: "end b - - 0 1", move: parseUci("e2e4")!, san: "e4", halfMoves: 1 }),
  ];
  store.getState().setState(state);
  await act(async () =>
    root.render(
      <TreeStateContext.Provider value={store}>
        <WorkspaceTabScope tabId="notation-test">
          <GameNotation />
        </WorkspaceTabScope>
      </TreeStateContext.Provider>,
    ),
  );
  expect(host.querySelector("[data-notation-game-end]")).toBeNull();
  expect(host.textContent).toContain("1-0Board.Analysis.Tablebase.WhiteWins");
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const catalogues = import.meta.glob<{ translation: Record<string, string> }>(
  "../../translation/*.json",
  { eager: true, import: "default" },
);
test.each(Object.entries(catalogues))(
  "ships game-end copy in %s with fallback disabled",
  async (path, catalogue) => {
    const locale = path.split("/").at(-1)!.replace(".json", "");
    const i18n = createInstance();
    await i18n.init({
      lng: locale,
      fallbackLng: false,
      keySeparator: false,
      resources: { [locale]: catalogue },
    });
    for (const key of [
      "Notation.AnalysisAfterGame",
      "Notation.MarkGameEndHere",
      "Notation.ClearGameEnd",
      "GameInfo.Termination",
    ]) {
      expect(catalogue.translation[key]?.trim()).toBeTruthy();
      expect(i18n.t(key)).toBe(catalogue.translation[key]);
      expect(i18n.t(key)).not.toBe(key);
    }
  },
);

function queueAnimationFrames() {
  const frames = new Map<number, FrameRequestCallback>();
  let nextId = 0;
  const request = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frames.set(++nextId, callback);
    return nextId;
  });
  const cancel = vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    frames.delete(id);
  });
  const flushOne = () => {
    const [id, callback] = frames.entries().next().value!;
    frames.delete(id);
    callback(0);
  };
  return {
    frames,
    flushOne,
    flush: () => {
      while (frames.size) flushOne();
    },
    restore: () => {
      request.mockRestore();
      cancel.mockRestore();
    },
  };
}

function mountRealVirtualizer() {
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
    scrollToFn: elementScroll,
  });
  Object.defineProperty(viewport, "scrollTo", {
    value: ({ top }: ScrollToOptions) => {
      offsets.push(top!);
      virtualizer.scrollOffset = top!;
    },
  });
  const cleanup = virtualizer._didMount();
  virtualizer._willUpdate();
  virtualizer.elementsCache.set(2, viewport);
  offsets.length = 0;
  return { virtualizer, offsets, cleanup };
}

test.each([false, true])(
  "cancels owned index verification after real virtualizer unmount (verify queued: %s)",
  (verifyQueued) => {
    const queue = queueAnimationFrames();
    const { virtualizer, offsets, cleanup } = mountRealVirtualizer();
    const getOffset = vi.spyOn(virtualizer, "getOffsetForIndex");
    try {
      const cancel = scrollNotationToIndex(virtualizer, 2, "center");
      expect(offsets).toEqual([30]);
      if (verifyQueued) queue.flushOne();
      const queuedCallback = queue.frames.values().next().value!;
      cleanup();
      virtualizer.scrollOffset = 1000;
      getOffset.mockClear();
      cancel();
      expect(queue.frames.size).toBe(0);
      expect(() => queue.flush()).not.toThrow();
      // A callback already dispatched before cancellation must also leave its owner alone.
      expect(() => queuedCallback(0)).not.toThrow();
      expect(getOffset).not.toHaveBeenCalled();
      expect(queue.frames.size).toBe(0);
      expect(offsets).toEqual([30]);
    } finally {
      cleanup();
      getOffset.mockRestore();
      queue.restore();
    }
  },
);

test("the library's unowned dynamic index frame throws after real virtualizer unmount", () => {
  const queue = queueAnimationFrames();
  const { virtualizer, cleanup } = mountRealVirtualizer();
  try {
    virtualizer.scrollToIndex(2, { align: "center" });
    cleanup();
    expect(() => queue.flush()).toThrow(TypeError);
  } finally {
    cleanup();
    queue.restore();
  }
});

test("owned index verification corrects a changed offset and cancellation stops retries", () => {
  const queue = queueAnimationFrames();
  const { virtualizer, offsets, cleanup } = mountRealVirtualizer();
  try {
    const cancel = scrollNotationToIndex(virtualizer, 2, "center");
    virtualizer.scrollOffset = 1000;
    queue.flushOne();
    expect(offsets).toEqual([30]);
    queue.flushOne();
    expect(offsets).toEqual([30, 30]);
    expect(virtualizer.scrollOffset).toBe(30);
    virtualizer.scrollOffset = 1000;
    queue.flushOne();
    cancel();
    queue.flush();
    expect(offsets).toEqual([30, 30]);
  } finally {
    cleanup();
    queue.restore();
  }
});

test("owned index verification scrolls to the updated target after a row is measured", () => {
  const queue = queueAnimationFrames();
  const { virtualizer, offsets, cleanup } = mountRealVirtualizer();
  try {
    const initialTarget = virtualizer.getOffsetForIndex(2, "center")![0];
    const cancel = scrollNotationToIndex(virtualizer, 2, "center");
    expect(offsets).toEqual([initialTarget]);

    virtualizer.resizeItem(2, 64);
    expect(virtualizer.getVirtualItems().find((item) => item.index === 2)?.size).toBe(64);
    const updatedTarget = virtualizer.getOffsetForIndex(2, "center")![0];
    expect(updatedTarget).not.toBe(initialTarget);
    // Measuring the target row changes its centered offset without a scroll correction.
    expect(offsets).toEqual([initialTarget]);

    queue.flushOne();
    queue.flushOne();
    expect(offsets).toEqual([initialTarget, updatedTarget]);
    expect(virtualizer.scrollOffset).toBe(updatedTarget);

    cancel();
    expect(queue.frames.size).toBe(0);
  } finally {
    cleanup();
    queue.restore();
  }
});

test("owned index verification bounds unsuccessful scrolling to ten attempts", () => {
  const queue = queueAnimationFrames();
  const { virtualizer, offsets, cleanup } = mountRealVirtualizer();
  try {
    scrollNotationToIndex(virtualizer, 2, "center");
    while (queue.frames.size) {
      virtualizer.scrollOffset = 1000;
      queue.flushOne();
    }
    expect(offsets).toEqual(Array(10).fill(30));
  } finally {
    cleanup();
    queue.restore();
  }
});

test.each([false, true])(
  "notation cleanup cancels its owned index frames (started inside reveal: %s)",
  async (insideReveal) => {
    const queue = queueAnimationFrames();
    const height = vi
      .spyOn(HTMLElement.prototype, "clientHeight", "get")
      .mockReturnValue(insideReveal ? 100 : 0);
    const bounds = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      height: 200,
    } as DOMRect);
    try {
      const state = defaultTree();
      state.root.children = [
        createNode({ fen: "e4 b - - 0 1", move: parseUci("e2e4")!, san: "e4", halfMoves: 1 }),
      ];
      store.getState().setState({ ...state, position: [0] });
      await act(async () => {
        root.render(
          <TreeStateContext.Provider value={store}>
            <WorkspaceTabScope tabId="notation-test">
              <GameNotation />
            </WorkspaceTabScope>
          </TreeStateContext.Provider>,
        );
      });
      expect(virtualizerMock.scrollCalls).toHaveLength(insideReveal ? 0 : 1);
      if (insideReveal) {
        bounds.mockReturnValue({ height: 30 } as DOMRect);
        queue.flushOne();
        queue.flushOne();
      }
      expect(virtualizerMock.scrollCalls).toEqual([{ index: 0, options: { align: "center" } }]);
      expect(queue.frames.size).toBe(1);
      await act(async () => root.render(null));
      expect(queue.frames.size).toBe(0);
      queue.flush();
      expect(virtualizerMock.scrollCalls).toHaveLength(1);
    } finally {
      await act(async () => root.render(null));
      height.mockRestore();
      bounds.mockRestore();
      queue.restore();
    }
  },
);

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
      expect(surface?.style.getPropertyValue("--notation-variation-depth")).toBe(
        guideDepth === null ? "" : String(guideDepth),
      );
      expect(surface?.style.marginLeft).toBe("");
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
      )?.style.getPropertyValue("--notation-variation-depth"),
    ).toBe("1");
    expect(
      (
        host.querySelector(`[data-index="${depth1MovesIndex}"]`)
          ?.firstElementChild as HTMLElement | null
      )?.style.getPropertyValue("--notation-variation-depth"),
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
