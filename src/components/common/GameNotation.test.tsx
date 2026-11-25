import { WorkspaceTabScope } from "@/state/tabScope";
import { parseUci } from "chessops";
import { createInstance } from "i18next";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createTreeStore, type TreeStore } from "@/state/store/tree";
import { TreeStateContext } from "./TreeStateContext";
import { createNode, defaultTree, getBoardState, type TreeNode } from "@/utils/treeReducer";
import {
  buildNotationRows,
  NOTATION_ROW_MAX_MOVES,
  pathForNotationNode,
  variationCollapseKey,
  type NotationRow,
} from "./notationRows";

const atoms = vi.hoisted(() => ({
  invisible: Symbol("invisible"),
  comments: Symbol("comments"),
  variations: Symbol("variations"),
  diagrams: Symbol("diagrams"),
  moveHighlight: Symbol("move-highlight"),
  opponentPreparation: Symbol("opponent-preparation"),
  preparationView: Symbol("preparation-view"),
  table: Symbol("table"),
  keyMap: Symbol("key-map"),
}));
const prepState = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const state = {
    preparation: null as import("@/state/atoms/preparation").StoredOpponentPreparation | null,
    view: null as import("@/state/atoms/preparation").TabPreparationView | null,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    notify: () => {
      for (const listener of listeners) listener();
    },
    setView: vi.fn((updater: any) => {
      state.view = typeof updater === "function" ? updater(state.view) : updater;
      state.notify();
    }),
  };
  return state;
});
const virtualizerMock = vi.hoisted(() => ({
  current: null as null | { count: number },
  scrollCalls: [] as { index: number; options: unknown }[],
  measured: [] as Element[],
}));
const notationSettings = vi.hoisted(() => ({
  showComments: false,
  tableView: false,
  invisible: false,
}));

vi.mock("@/state/atoms", () => ({
  invisibleFamily: () => atoms.invisible,
  showCommentsFamily: () => atoms.comments,
  showVariationsFamily: () => atoms.variations,
  showDiagramsFamily: () => atoms.diagrams,
  moveHighlightAtom: atoms.moveHighlight,
  opponentPreparationAtom: atoms.opponentPreparation,
  tabPreparationViewFamily: () => atoms.preparationView,
  tableViewAtom: atoms.table,
}));
vi.mock("@/state/keybinds", () => ({ keyMapAtom: atoms.keyMap }));
vi.mock("jotai", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useAtom: (atom: symbol) => {
      const prepView = useSyncExternalStore(prepState.subscribe, () => prepState.view);
      if (atom === atoms.table) return [notationSettings.tableView, vi.fn()];
      if (atom === atoms.invisible) return [notationSettings.invisible, vi.fn()];
      if (atom === atoms.preparationView) return [prepView, prepState.setView];
      return [false, vi.fn()];
    },
    useAtomValue: (atom: symbol) => {
      const prep = useSyncExternalStore(prepState.subscribe, () => prepState.preparation);
      if (atom === atoms.variations || atom === atoms.diagrams) return true;
      if (atom === atoms.comments) return notationSettings.showComments;
      if (atom === atoms.opponentPreparation) return prep;
      if (atom === atoms.keyMap) {
        return { TOGGLE_BLUR: { keys: "ctrl+b" }, COPY_PGN: { keys: "ctrl+k" } };
      }
      return false;
    },
  };
});
vi.mock("react-hotkeys-hook", () => ({ useHotkeys: vi.fn() }));
vi.mock("@/utils/sound", () => ({ playSound: vi.fn() }));
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
    Grid2x2: Icon,
    Grid2x2X: Icon,
    TableProperties: Icon,
    List: Icon,
    Minus: Icon,
    Plus: Icon,
  };
});
vi.mock("@/components/common/Comment", () => ({
  default: ({ comment, annotatedNode }: { comment: string; annotatedNode?: { fen: string } }) => (
    <span data-comment={comment} data-annotated-fen={annotatedNode?.fen} />
  ),
}));
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
vi.mock("@/components/common/MiniBoard", () => ({ MiniBoard: () => null }));
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
        data-score-text={props.scoreText}
        data-analysis={props.analysis ? "true" : "false"}
        data-open-variation={props.openVariation ? "true" : "false"}
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
    SegmentedControl: ({ data, value, onChange, "aria-label": ariaLabel }: any) => (
      <div role="radiogroup" aria-label={ariaLabel}>
        {data.map((item: any) => (
          <button
            key={item.value}
            type="button"
            role="radio"
            aria-checked={value === item.value}
            onClick={() => onChange(item.value)}
          >
            {item.label}
          </button>
        ))}
      </div>
    ),
    Stack: element,
    Table: table,
    Text: ({ children, ...props }: any) => <span {...props}>{children}</span>,
    UnstyledButton: ({ children, ...props }: any) => (
      <button type="button" {...props}>
        {children}
      </button>
    ),
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
  notationSettings.invisible = false;
  prepState.preparation = null;
  prepState.view = null;
  prepState.setView.mockClear();
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

test("table notation shows the live engine score ahead of the saved one", async () => {
  notationSettings.showComments = true;
  notationSettings.tableView = true;
  const state = defaultTree();
  const e4 = createNode({ fen: "e4 b - - 0 1", move: parseUci("e2e4")!, san: "e4", halfMoves: 1 });
  e4.score = { value: { type: "cp", value: 30 }, wdl: null };
  const e5 = createNode({ fen: "e5 w - - 0 2", move: parseUci("e7e5")!, san: "e5", halfMoves: 2 });
  e5.score = { value: { type: "cp", value: 20 }, wdl: null };
  e5.engineScore = { value: { type: "cp", value: -150 }, wdl: null };
  e4.children = [e5];
  state.root.children = [e4];
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

  expect(host.querySelector('[data-node="e4"]')?.getAttribute("data-score-text")).toBe("+0.3");
  expect(host.querySelector('[data-node="e5"]')?.getAttribute("data-score-text")).toBe("-1.5");
});

test("table comments annotate their move's position, or before it for a pre-move comment", async () => {
  notationSettings.showComments = true;
  notationSettings.tableView = true;
  const state = defaultTree();
  const e4 = createNode({ fen: "e4 b - - 0 1", move: parseUci("e2e4")!, san: "e4", halfMoves: 1 });
  const e5 = createNode({ fen: "e5 w - - 0 2", move: parseUci("e7e5")!, san: "e5", halfMoves: 2 });
  e4.comment = "After e4";
  e5.startingComment = "Before e5";
  e4.children = [e5];
  state.root.children = [e4];
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

  const annotated = (comment: string) =>
    host.querySelector(`[data-comment="${comment}"]`)?.getAttribute("data-annotated-fen");
  expect(annotated("After e4")).toBe(e4.fen);
  expect(annotated("Before e5")).toBe(e4.fen);
});

test("a diagram's comment annotates the diagram's position", async () => {
  notationSettings.showComments = true;
  const state = defaultTree();
  const e4 = createNode({
    fen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
    move: parseUci("e2e4")!,
    san: "e4",
    halfMoves: 1,
  });
  e4.diagram = true;
  e4.comment = "Diagram note";
  state.root.children = [e4];
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

  expect(host.querySelector("[data-notation-diagram]")).not.toBeNull();
  expect(
    host.querySelector('[data-comment="Diagram note"]')?.getAttribute("data-annotated-fen"),
  ).toBe(e4.fen);
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
    showDiagrams: true,
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
    showDiagrams: true,
    tableView: false,
    collapsedVariations: new Set([variationCollapseKey(state.root, [0])]),
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
      showDiagrams: true,
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

test("keeps a collapsed variation hidden after a comment and a mainline move", async () => {
  store.getState().makeMoves({ payload: ["e4"] });
  store.getState().goToStart();
  store.getState().makeMove({ payload: "d4" });

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
  await act(async () => toggle!.click());
  expect(host.querySelector('[data-node="d4"]')).toBeNull();

  await act(async () => {
    store.getState().goToMove([0]);
    store.getState().setComment("note on e4");
    store.getState().makeMove({ payload: "e5" });
  });

  expect(host.querySelector('[data-node="e4"]')).not.toBeNull();
  expect(host.querySelector('[data-node="e5"]')).not.toBeNull();
  expect(host.querySelector('[data-node="d4"]')).toBeNull();
  expect(store.getState().root.children[0].comment).toBe("note on e4");
});

test("keeps a collapsed variation on its move sequence after promoting a sibling", async () => {
  store.getState().makeMoves({ payload: ["e4", "e5"] });
  store.getState().goToMove([0]);
  store.getState().makeMove({ payload: "c5" });

  await act(async () => {
    root.render(
      <TreeStateContext.Provider value={store}>
        <WorkspaceTabScope tabId="notation-test">
          <GameNotation />
        </WorkspaceTabScope>
      </TreeStateContext.Provider>,
    );
  });

  expect(host.querySelector('[data-node="c5"]')).not.toBeNull();
  const toggle = host.querySelector<HTMLButtonElement>('[aria-label="Notation.ToggleVariation"]');
  expect(toggle).not.toBeNull();
  await act(async () => toggle!.click());
  expect(host.querySelector('[data-node="c5"]')).toBeNull();

  await act(async () => {
    store.getState().goToStart();
    store.getState().makeMove({ payload: "d4" });
    store.getState().promoteVariation([1]);
  });

  expect(store.getState().root.children.map((node) => node.san)).toEqual(["d4", "e4"]);
  expect(host.querySelector('[data-node="d4"]')).not.toBeNull();
  expect(host.querySelector('[data-node="e4"]')).not.toBeNull();
  expect(host.querySelector('[data-node="e5"]')).not.toBeNull();
  expect(host.querySelector('[data-node="c5"]')).toBeNull();
  expect(host.querySelectorAll('[aria-label="Notation.ToggleVariation"]')).toHaveLength(2);
});

test.each([false, true])(
  "hidden notation takes its moves out of focus and the accessibility tree (invisible: %s)",
  async (invisible) => {
    notationSettings.invisible = invisible;
    store.getState().makeMoves({ payload: ["e4", "e5", "Nf3"] });
    store.getState().goToMove([0, 0]);
    store.getState().setPracticePath([0, 0]);

    await act(async () => {
      root.render(
        <TreeStateContext.Provider value={store}>
          <WorkspaceTabScope tabId="notation-test">
            <GameNotation topBar />
          </WorkspaceTabScope>
        </TreeStateContext.Provider>,
      );
    });

    // f-20261119-15: the blur overlay blocks only the pointer; Tab + Enter on a hidden move
    // past the drill card showed the answer. `inert` is what removes that path in a browser.
    const answer = host.querySelector('[data-node="Nf3"]');
    expect(answer).not.toBeNull();
    expect(answer!.closest("[inert]") !== null).toBe(invisible);
    // The reveal toggle in the header must stay operable while the moves are hidden.
    const toggle = host.querySelector(
      `[aria-label="${invisible ? "Notation.ShowMoves" : "Notation.HideMoves"}"]`,
    );
    expect(toggle).not.toBeNull();
    expect(toggle!.closest("[inert]")).toBeNull();
  },
);

const renderNotation = (markOpenVariations = false) =>
  act(async () => {
    root.render(
      <TreeStateContext.Provider value={store}>
        <WorkspaceTabScope tabId="notation-test">
          <GameNotation markOpenVariations={markOpenVariations} />
        </WorkspaceTabScope>
      </TreeStateContext.Provider>,
    );
  });

const cellAttribute = (san: string, name: string) =>
  host.querySelector(`[data-node="${san}"]`)?.getAttribute(name);

test.each([false, true])(
  "hands each move its open-variation flag and drops it with the second move (tableView: %s)",
  async (tableView) => {
    notationSettings.tableView = tableView;
    // 1.e4 (1.d4) e5 (1...c5 2.Nf3)
    store.getState().makeMoves({ payload: ["e4", "e5"] });
    store.getState().goToMove([0]);
    store.getState().makeMoves({ payload: ["c5", "Nf3"] });
    store.getState().goToStart();
    store.getState().makeMove({ payload: "d4" });

    // Only a notation that asks for the mark hands it on.
    await renderNotation();
    expect(cellAttribute("d4", "data-open-variation")).toBe("false");

    await renderNotation(true);

    expect(cellAttribute("d4", "data-open-variation")).toBe("true");
    expect(cellAttribute("c5", "data-open-variation")).toBe("false");
    expect(cellAttribute("Nf3", "data-open-variation")).toBe("false");
    expect(cellAttribute("e5", "data-open-variation")).toBe("false");

    await act(async () => store.getState().makeMove({ payload: "d5" }));

    expect(cellAttribute("d4", "data-open-variation")).toBe("false");
  },
);

test("a cursor that lands inside a collapsed variation opens it", async () => {
  // 1.e4 (1.d4 d5 (1...Nf6)) e5: the open variation 1...Nf6 sits inside the 1.d4 side line.
  store.getState().makeMoves({ payload: ["e4", "e5"] });
  store.getState().goToStart();
  store.getState().makeMoves({ payload: ["d4", "d5"] });
  store.getState().goToMove([1]);
  store.getState().makeMove({ payload: "Nf6" });
  store.getState().goToMove([0]);
  await renderNotation();
  const toggles = () => [
    ...host.querySelectorAll<HTMLButtonElement>('[aria-label="Notation.ToggleVariation"]'),
  ];
  // Collapse the inner toggle first, then the outer one that also hides it.
  await act(async () => toggles()[1].click());
  await act(async () => toggles()[0].click());
  expect(cellAttribute("d4", "data-current")).toBeUndefined();
  expect(cellAttribute("Nf6", "data-current")).toBeUndefined();

  await act(async () => store.getState().goToNextOpenVariation());

  expect(store.getState().position).toEqual([1, 1]);
  expect(cellAttribute("Nf6", "data-current")).toBe("true");
  expect(cellAttribute("d5", "data-current")).toBe("false");
});

test("a variation collapsed around the current move stays closed while that move is edited", async () => {
  store.getState().makeMoves({ payload: ["e4"] });
  store.getState().goToStart();
  store.getState().makeMove({ payload: "d4" });
  await renderNotation();
  expect(store.getState().position).toEqual([1]);
  const toggle = host.querySelector<HTMLButtonElement>('[aria-label="Notation.ToggleVariation"]');
  await act(async () => toggle!.click());
  expect(host.querySelector('[data-node="d4"]')).toBeNull();

  // An edit replaces the current node; the cursor has not moved.
  await act(async () => store.getState().setComment("still to analyse"));

  expect(store.getState().currentNode().comment).toBe("still to analyse");
  expect(host.querySelector('[data-node="d4"]')).toBeNull();

  // Leaving and coming back is a cursor move and opens it.
  await act(async () => store.getState().goToMove([0]));
  expect(host.querySelector('[data-node="d4"]')).toBeNull();
  await act(async () => store.getState().goToMove([1]));
  expect(cellAttribute("d4", "data-current")).toBe("true");
});

describe("opponent preparation notation filtering", () => {
  function makePrep(
    played: string[],
    overrides: Partial<import("@/state/atoms/preparation").StoredOpponentPreparation> = {},
  ): import("@/state/atoms/preparation").StoredOpponentPreparation {
    const emptyView = {
      lines: [],
      gaps: [],
      total: 10,
      playedPositions: new Set(played),
      positionGames: new Map(played.map((fen) => [fen, 1])),
    };
    return {
      id: "prep-1",
      identityKey: "id-1",
      cardDatabaseKey: "db-1",
      playerId: 1,
      opponentName: "Karpov",
      opponentColor: "white",
      period: 3,
      source: "otb",
      views: { otb: emptyView, online: null, both: null },
      partial: false,
      onlineFailed: false,
      ...overrides,
    };
  }

  function setupVariedTree() {
    // Black repertoire against White: 1. e4 (1. d4, 1. c4) c5 (1... e5) 2. Nf3 d6
    store.getState().makeMoves({ payload: ["e4", "c5", "Nf3", "d6"] });
    store.getState().goToStart();
    store.getState().makeMove({ payload: "d4" });
    store.getState().goToStart();
    store.getState().makeMove({ payload: "c4" });
    store.getState().goToMove([0]);
    store.getState().makeMove({ payload: "e5" });
    store.getState().goToMove([0]);
    store.getState().setHeaders({
      ...store.getState().headers,
      orientation: "black",
    });

    const s = store.getState().root;
    const e4 = s.children[0];
    const c5 = e4.children[0];
    const e5 = e4.children[1];
    const nf3 = c5.children[0];
    const d6 = nf3.children[0];
    const d4 = s.children[1];
    const c4 = s.children[2];
    return { root: s, e4, c5, e5, nf3, d6, d4, c4 };
  }

  const renderTopBar = () =>
    act(async () => {
      root.render(
        <TreeStateContext.Provider value={store}>
          <WorkspaceTabScope tabId="notation-test">
            <GameNotation topBar />
          </WorkspaceTabScope>
        </TreeStateContext.Provider>,
      );
    });

  test("shows unfiltered notation and no header control without matching preparation or chapter", async () => {
    const { e4, c5 } = setupVariedTree();
    const played = [e4, c5].map((n) => getBoardState(n.fen));

    // No preparation view
    await renderTopBar();
    expect(host.querySelector("[data-notation-preparation-header]")).toBeNull();
    expect(host.querySelector('[data-node="d4"]')).not.toBeNull();

    // View names a different preparation id
    prepState.preparation = makePrep(played, { id: "prep-2" });
    prepState.view = { preparationId: "prep-1", landing: null, showAllLines: false };
    await renderTopBar();
    expect(host.querySelector("[data-notation-preparation-header]")).toBeNull();
    expect(host.querySelector('[data-node="d4"]')).not.toBeNull();

    // Matching id, wrong chapter orientation (white instead of black)
    prepState.preparation = makePrep(played, { id: "prep-1", opponentColor: "white" });
    await act(async () => {
      store.getState().setHeaders({ ...store.getState().headers, orientation: "white" });
    });
    expect(host.querySelector("[data-notation-preparation-header]")).toBeNull();
    expect(host.querySelector('[data-node="d4"]')).not.toBeNull();

    // Matching orientation, but chapter has no played node
    await act(async () => {
      store.getState().setHeaders({ ...store.getState().headers, orientation: "black" });
      prepState.preparation = makePrep(["nonexistent/fen w - -"], { id: "prep-1" });
      prepState.notify();
    });
    expect(host.querySelector("[data-notation-preparation-header]")).toBeNull();
    expect(host.querySelector('[data-node="d4"]')).not.toBeNull();
  });

  test("hides irrelevant side lines with count on toggle row, reveals by toggle and cursor, and user collapse wins", async () => {
    const { e4, c5 } = setupVariedTree();
    // Played: e4, c5 -> d4 & c4 are irrelevant (2 hidden at root); after c5 (Black), White is to move,
    // so 2. Nc3 (irrelevant) and 2. Bc4 (relevant) test mixed siblings under c5.
    store.getState().goToMove([0, 0]); // c5
    store.getState().makeMove({ payload: "Nc3" });
    store.getState().goToMove([0, 0]);
    store.getState().makeMove({ payload: "Bc4" });
    store.getState().goToMove([0]);
    const bc4 = store.getState().root.children[0].children[0].children[2];

    prepState.preparation = makePrep([
      getBoardState(e4.fen),
      getBoardState(c5.fen),
      getBoardState(bc4.fen),
    ]);
    prepState.view = { preparationId: "prep-1", landing: null, showAllLines: false };

    await renderTopBar();

    // Root has 2 irrelevant side lines (d4, c4); c5 has 1 irrelevant side line (Nc3) and 1 relevant side line (Bc4).
    expect(host.querySelector('[data-node="d4"]')).toBeNull();
    expect(host.querySelector('[data-node="c4"]')).toBeNull();
    expect(host.querySelector('[data-node="Nc3"]')).toBeNull();
    expect(host.querySelector('[data-node="Bc4"]')).not.toBeNull();

    const rootReveal = host.querySelector<HTMLButtonElement>(
      '[data-notation-reveal-variations="2"]',
    );
    const c5Reveal = host.querySelector<HTMLButtonElement>('[data-notation-reveal-variations="1"]');
    expect(rootReveal).not.toBeNull();
    expect(c5Reveal).not.toBeNull();
    // Every side line of root is hidden, so root shows no collapse toggle yet (only e4 and c5 do).
    expect(host.querySelectorAll('[aria-label="Notation.ToggleVariation"]')).toHaveLength(2);

    // Clicking root's reveal button reveals only root's hidden side lines (d4, c4), leaving Nc3 hidden.
    await act(async () => rootReveal!.click());
    expect(host.querySelector('[data-node="d4"]')).not.toBeNull();
    expect(host.querySelector('[data-node="c4"]')).not.toBeNull();
    expect(host.querySelector('[data-node="Nc3"]')).toBeNull();

    // User collapse on c5 hides BOTH relevant (Bc4) and hidden (Nc3) side lines; user collapse wins.
    const toggles = [
      ...host.querySelectorAll<HTMLButtonElement>('[aria-label="Notation.ToggleVariation"]'),
    ];
    // toggles: [0]=root, [1]=e4, [2]=c5
    await act(async () => toggles[2].click());
    expect(host.querySelector('[data-node="Bc4"]')).toBeNull();
    expect(host.querySelector('[data-node="Nc3"]')).toBeNull();
    // Uncollapse c5 again -> Bc4 returns, Nc3 still hidden until revealed.
    const expandC5 = host.querySelectorAll<HTMLButtonElement>(
      '[aria-label="Notation.ToggleVariation"]',
    )[2];
    await act(async () => expandC5.click());
    expect(host.querySelector('[data-node="Bc4"]')).not.toBeNull();
    expect(host.querySelector('[data-node="Nc3"]')).toBeNull();

    // Cursor landing inside already-relevant Bc4 ([0, 0, 2]) does NOT reveal sibling Nc3.
    await act(async () => {
      store.getState().goToMove([0, 0, 2]);
    });
    expect(host.querySelector('[data-node="Nc3"]')).toBeNull();

    // Cursor landing inside hidden Nc3 ([0, 0, 1]) reveals c5's hidden side lines.
    await act(async () => {
      store.getState().goToMove([0, 0, 1]);
    });
    expect(host.querySelector('[data-node="Nc3"]')).not.toBeNull();
    expect(host.querySelector("[data-notation-reveal-variations]")).toBeNull();
  });

  test.each([false, true])(
    "keeps an excluded main line visible as one thread while hiding its side lines (tableView: %s)",
    async (tableView) => {
      notationSettings.tableView = tableView;
      const { e4, c5 } = setupVariedTree();
      // Continue main line with 3. d4 and add an irrelevant side line 3. Bb5+ off d6 (excluded).
      store.getState().goToMove([0, 0, 0, 0]); // d6
      store.getState().makeMove({ payload: "d4" });
      store.getState().goToMove([0, 0, 0, 0]);
      store.getState().makeMove({ payload: "Bb5+" });
      store.getState().goToMove([0]);

      // Only e4 and c5 are played; after c5 (White/opponent to move), Nf3 -> d6 -> d4 is excluded,
      // and side line Bb5+ is excluded.
      prepState.preparation = makePrep([getBoardState(e4.fen), getBoardState(c5.fen)]);
      prepState.view = { preparationId: "prep-1", landing: null, showAllLines: false };

      await renderTopBar();

      // Main continuation e4 -> c5 -> Nf3 -> d6 -> d4 stays visible as one thread, while Bb5+ is hidden.
      expect(host.querySelector('[data-node="e4"]')).not.toBeNull();
      expect(host.querySelector('[data-node="c5"]')).not.toBeNull();
      expect(host.querySelector('[data-node="Nf3"]')).not.toBeNull();
      expect(host.querySelector('[data-node="d6"]')).not.toBeNull();
      expect(host.querySelector('[data-node="d4"]')).not.toBeNull();
      expect(host.querySelector('[data-node="Bb5+"]')).toBeNull();
      expect(host.querySelector('[data-notation-reveal-variations="1"]')).not.toBeNull();
    },
  );

  test("follows live tree edits without a new search", async () => {
    const { e4, c5 } = setupVariedTree();
    prepState.preparation = makePrep([getBoardState(e4.fen), getBoardState(c5.fen)]);
    prepState.view = { preparationId: "prep-1", landing: null, showAllLines: false };

    await renderTopBar();
    expect(host.querySelector('[data-node="d4"]')).toBeNull();

    // Edit the tree so 1. d4 gains a move reaching the already-played 1. e4 c5 position (e.g. a played FEN).
    const nextRoot = structuredClone(store.getState().root);
    nextRoot.children[1].children.push(
      createNode({
        fen: c5.fen,
        move: parseUci("c7c5")!,
        san: "c5",
        halfMoves: 2,
      }),
    );
    await act(async () => {
      store.getState().setState({
        ...defaultTree(),
        root: nextRoot,
        position: store.getState().position,
        headers: store.getState().headers,
      });
    });

    // Now d4 has a relevant descendant and becomes visible immediately without clicking reveal.
    expect(host.querySelector('[data-node="d4"]')).not.toBeNull();
    expect(host.querySelector('[data-notation-reveal-variations="2"]')).toBeNull();
    expect(host.querySelector('[data-notation-reveal-variations="1"]')).not.toBeNull();
  });

  test("header names the opponent, switches between opponent lines and all lines, and persists showAllLines on the tab", async () => {
    const { e4, c5 } = setupVariedTree();
    prepState.preparation = makePrep([getBoardState(e4.fen), getBoardState(c5.fen)]);
    prepState.view = { preparationId: "prep-1", landing: null, showAllLines: false };

    await renderTopBar();

    const header = host.querySelector("[data-notation-preparation-header]")!;
    expect(header.textContent).toContain("Notation.PreparationFor");
    expect(host.querySelector('[data-node="d4"]')).toBeNull();

    const allButton = [...header.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(
      (btn) => btn.textContent === "Notation.PreparationAllLines",
    )!;
    await act(async () => allButton.click());
    expect(prepState.view?.showAllLines).toBe(true);

    // Re-render / remount keeps showAllLines from tabPreparationViewFamily.
    await act(async () => root.render(null));
    await renderTopBar();
    expect(host.querySelector('[data-node="d4"]')).not.toBeNull();

    const relevantButton = [
      ...host
        .querySelector("[data-notation-preparation-header]")!
        .querySelectorAll<HTMLButtonElement>('[role="radio"]'),
    ].find((btn) => btn.textContent === "Notation.PreparationOpponentLines")!;
    await act(async () => relevantButton.click());
    expect(prepState.view?.showAllLines).toBe(false);
    await renderTopBar();
    expect(host.querySelector('[data-node="d4"]')).toBeNull();
  });

  test("filters by online or both view playedPositions and falls back to otb when that view is null", async () => {
    const { e4, c5 } = setupVariedTree();
    store.getState().goToMove([0, 0]);
    store.getState().makeMove({ payload: "Nc3" });
    store.getState().goToMove([0, 0]);
    store.getState().makeMove({ payload: "Bc4" });
    store.getState().goToMove([0]);
    const nc3 = store.getState().root.children[0].children[0].children[1];
    const bc4 = store.getState().root.children[0].children[0].children[2];

    const viewOf = (nodes: TreeNode[]) => {
      const keys = nodes.map((n) => getBoardState(n.fen));
      return {
        lines: [],
        gaps: [],
        total: 10,
        playedPositions: new Set(keys),
        positionGames: new Map(keys.map((k) => [k, 1])),
      };
    };

    const otbView = viewOf([e4, c5]);
    const onlineView = viewOf([e4, c5, bc4]);
    const bothView = viewOf([e4, c5, nc3]);

    prepState.preparation = makePrep([], {
      source: "online",
      views: { otb: otbView, online: onlineView, both: bothView },
    });
    prepState.view = { preparationId: "prep-1", landing: null, showAllLines: false };
    await renderTopBar();
    expect(host.querySelector('[data-node="Bc4"]')).not.toBeNull();
    expect(host.querySelector('[data-node="Nc3"]')).toBeNull();

    await act(async () => {
      prepState.preparation = makePrep([], {
        source: "both",
        views: { otb: otbView, online: onlineView, both: bothView },
      });
      prepState.notify();
    });
    expect(host.querySelector('[data-node="Nc3"]')).not.toBeNull();
    expect(host.querySelector('[data-node="Bc4"]')).toBeNull();

    await act(async () => {
      prepState.preparation = makePrep([], {
        source: "online",
        views: { otb: otbView, online: null, both: null },
      });
      prepState.notify();
    });
    expect(host.querySelector('[data-node="Bc4"]')).toBeNull();
    expect(host.querySelector('[data-node="Nc3"]')).toBeNull();

    await act(async () => {
      prepState.preparation = makePrep([], {
        source: "both",
        views: { otb: otbView, online: null, both: null },
      });
      prepState.notify();
    });
    expect(host.querySelector('[data-node="Bc4"]')).toBeNull();
    expect(host.querySelector('[data-node="Nc3"]')).toBeNull();
  });

  test("hides the reveal control while a parent with hidden side lines is collapsed by the user", async () => {
    store.getState().makeMoves({ payload: ["e4", "c5", "Nf3"] });
    store.getState().goToMove([0, 0]);
    store.getState().makeMove({ payload: "Nc3" });
    store.getState().goToMove([0, 0]);
    store.getState().makeMove({ payload: "Bc4" });
    store.getState().goToMove([0]);
    store.getState().setHeaders({ ...store.getState().headers, orientation: "black" });

    const rootNode = store.getState().root;
    const e4 = rootNode.children[0];
    const c5 = e4.children[0];
    const bc4 = c5.children[2];

    prepState.preparation = makePrep([
      getBoardState(e4.fen),
      getBoardState(c5.fen),
      getBoardState(bc4.fen),
    ]);
    prepState.view = { preparationId: "prep-1", landing: null, showAllLines: false };
    await renderTopBar();

    expect(host.querySelector('[data-notation-reveal-variations="1"]')).not.toBeNull();

    const toggle = host.querySelector<HTMLButtonElement>(
      '[aria-label="Notation.ToggleVariation"]',
    )!;
    await act(async () => toggle.click());

    expect(host.querySelector('[data-node="Bc4"]')).toBeNull();
    expect(host.querySelector('[data-node="Nc3"]')).toBeNull();
    expect(host.querySelector("[data-notation-reveal-variations]")).toBeNull();

    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="Notation.ToggleVariation"]')!.click(),
    );
    expect(host.querySelector('[data-node="Bc4"]')).not.toBeNull();
    expect(host.querySelector('[data-notation-reveal-variations="1"]')).not.toBeNull();
  });

  test("re-hides previously revealed side lines when a new preparation becomes current", async () => {
    const { e4, c5 } = setupVariedTree();
    const played = [getBoardState(e4.fen), getBoardState(c5.fen)];
    prepState.preparation = makePrep(played, { id: "prep-1" });
    prepState.view = { preparationId: "prep-1", landing: null, showAllLines: false };
    await renderTopBar();

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-notation-reveal-variations="2"]')!.click();
    });
    expect(host.querySelector('[data-node="d4"]')).not.toBeNull();
    expect(host.querySelector('[data-node="c4"]')).not.toBeNull();

    await act(async () => {
      prepState.preparation = makePrep(played, { id: "prep-2" });
      prepState.view = { preparationId: "prep-2", landing: null, showAllLines: false };
      prepState.notify();
    });
    expect(host.querySelector('[data-node="d4"]')).toBeNull();
    expect(host.querySelector('[data-node="c4"]')).toBeNull();
    expect(host.querySelector('[data-notation-reveal-variations="2"]')).not.toBeNull();
  });

  test.each(Object.entries(catalogues))(
    "ships preparation notation copy in %s with fallback disabled",
    async (path, catalogue) => {
      const locale = path.split("/").at(-1)!.replace(".json", "");
      const i18n = createInstance();
      await i18n.init({
        lng: locale,
        fallbackLng: false,
        keySeparator: false,
        resources: { [locale]: catalogue },
      });
      for (const [key, opts] of [
        ["Notation.PreparationFor", { name: "Karpov" }],
        ["Notation.PreparationLinesFilter", undefined],
        ["Notation.PreparationOpponentLines", undefined],
        ["Notation.PreparationAllLines", undefined],
        ["Notation.HiddenVariations", { count: 1 }],
        ["Notation.HiddenVariations", { count: 2 }],
      ] as const) {
        const value = String(i18n.t(key, opts as any));
        expect(value.trim()).toBeTruthy();
        expect(value).not.toBe(key);
      }
    },
  );
});
