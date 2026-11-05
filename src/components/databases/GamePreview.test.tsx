import { MantineProvider } from "@mantine/core";
import { createStore, Provider } from "jotai";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cancellationError } from "@/platform/tauri";
import type { StampedGame } from "@/bindings";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { activeTabAtom, tabsAtom } from "@/state/atoms";
import { DatabaseLayoutContext } from "@/state/databaseLayout";
import { getEffectiveGameEnd, type GameHeaders, type TreeNode } from "@/utils/treeReducer";
import { INITIAL_FEN } from "chessops/fen";

const mocks = vi.hoisted(() => ({
  lexPgn: vi.fn(),
  readGames: vi.fn(),
  notifyUnlessCancelled: vi.fn(),
  realNotation: false,
}));

vi.mock("@/platform/tauri", async () => {
  const actual = await vi.importActual<typeof import("@/platform/tauri")>("@/platform/tauri");
  return {
    ...actual,
    tauri: {
      ...actual.tauri,
      lexPgn: mocks.lexPgn,
      readGames: mocks.readGames,
    },
  };
});

vi.mock("@/components/files/notifyError", () => ({
  notifyUnlessCancelled: mocks.notifyUnlessCancelled,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/platform/native", () => ({
  platform: () => "linux",
  warn: vi.fn().mockResolvedValue(undefined),
  error: vi.fn(),
}));
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 32,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ index, start: index * 32 })),
    measureElement: () => undefined,
    getOffsetForIndex: () => undefined,
    scrollToOffset: () => undefined,
    scrollOffset: 0,
  }),
}));

vi.mock("@/chessground/Chessground", () => ({
  Chessground: (props: {
    fen?: string;
    orientation?: string;
    drawable?: { autoShapes?: unknown[] };
  }) => (
    <div
      data-testid="chessground"
      data-fen={props.fen}
      data-orientation={props.orientation}
      data-shapes={JSON.stringify(props.drawable?.autoShapes)}
    />
  ),
}));

vi.mock("../common/GameNotation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../common/GameNotation")>();
  const { useContext } = await import("react");
  const { useStore } = await import("zustand");
  const { TreeStateContext } = await import("../common/TreeStateContext");
  return {
    default: () => {
      const tree = useStore(useContext(TreeStateContext)!);
      return mocks.realNotation ? (
        <actual.default />
      ) : (
        <div
          data-testid="game-notation"
          data-headers={JSON.stringify(tree.headers)}
          data-root-fen={tree.root.fen}
          data-root={JSON.stringify(tree.root)}
          data-position={JSON.stringify(tree.position)}
        />
      );
    },
  };
});

vi.mock("../common/MoveControls", async () => {
  const { useContext } = await import("react");
  const { TreeStateContext, useVariationChooser } =
    await import("@/components/common/TreeStateContext");
  const { nextContinuation } = await import("@/state/store/tree");
  return {
    default: () => {
      const tree = useContext(TreeStateContext)!;
      const chooser = useVariationChooser();
      return (
        <button
          data-testid="move-controls"
          onClick={() => {
            const continuation = nextContinuation(tree.getState());
            if (continuation) chooser.open(continuation.children);
          }}
        />
      );
    },
  };
});

vi.mock("../common/OpeningName", () => ({
  default: () => <div data-testid="opening-name" />,
}));

import GamePreviewWrapper from "./GamePreview";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("GamePreviewWrapper", () => {
  let container: HTMLDivElement;
  let root: Root;
  const cache = new Map();

  beforeEach(() => {
    cache.clear();
    mocks.lexPgn.mockReset();
    mocks.readGames.mockReset();
    mocks.notifyUnlessCancelled.mockReset();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  function Tree({ pgn, sub1, sub2 }: { pgn: string; sub1: boolean; sub2: boolean }) {
    return (
      <SWRConfig value={{ provider: () => cache }}>
        {sub1 && <GamePreviewWrapper pgn={pgn} />}
        {sub2 && <GamePreviewWrapper pgn={pgn} />}
      </SWRConfig>
    );
  }

  test("shared request cancels only after last subscriber unmounts during lexing", async () => {
    let capturedSignal!: AbortSignal;
    mocks.lexPgn.mockImplementation((_pgn: string, options?: { signal?: AbortSignal }) => {
      if (options?.signal) capturedSignal = options.signal;
      return new Promise(() => {});
    });

    await act(async () => {
      root.render(<Tree pgn="1. e4 e5" sub1={true} sub2={true} />);
    });
    await vi.waitFor(() => expect(mocks.lexPgn).toHaveBeenCalledOnce());
    expect(capturedSignal).toBeDefined();
    expect(capturedSignal.aborted).toBe(false);

    // Unmount sub1: sub2 remains, so signal must not abort
    await act(async () => {
      root.render(<Tree pgn="1. e4 e5" sub1={false} sub2={true} />);
    });
    await act(async () => Promise.resolve());
    expect(capturedSignal.aborted).toBe(false);

    // Unmount sub2: last subscriber leaves, signal must abort
    await act(async () => {
      root.render(<Tree pgn="1. e4 e5" sub1={false} sub2={false} />);
    });
    await vi.waitFor(() => expect(capturedSignal.aborted).toBe(true));
    expect(mocks.notifyUnlessCancelled).not.toHaveBeenCalled();
  });

  test("key replacement cancels previous lexer work", async () => {
    let firstSignal!: AbortSignal;
    let secondSignal!: AbortSignal;
    mocks.lexPgn.mockImplementation((pgn: string, options?: { signal?: AbortSignal }) => {
      if (options?.signal) {
        if (pgn === "1. e4") {
          firstSignal = options.signal;
        } else {
          secondSignal = options.signal;
        }
      }
      return new Promise(() => {});
    });

    await act(async () => {
      root.render(<Tree pgn="1. e4" sub1={true} sub2={false} />);
    });
    await vi.waitFor(() => expect(mocks.lexPgn).toHaveBeenCalledOnce());
    expect(firstSignal.aborted).toBe(false);

    // Replace key with 1. d4
    await act(async () => {
      root.render(<Tree pgn="1. d4" sub1={true} sub2={false} />);
    });
    await vi.waitFor(() => expect(firstSignal.aborted).toBe(true));
    await vi.waitFor(() => expect(secondSignal).toBeDefined());
    expect(secondSignal.aborted).toBe(false);
  });

  test("genuine parser failures surface error notification while cancellation remains silent", async () => {
    // 1. Genuine parser error
    mocks.lexPgn.mockRejectedValueOnce(new Error("Corrupted PGN header"));

    await act(async () => {
      root.render(<Tree pgn="invalid-pgn" sub1={true} sub2={false} />);
    });
    await vi.waitFor(() =>
      expect(mocks.notifyUnlessCancelled).toHaveBeenCalledWith(
        "Common.Error",
        expect.objectContaining({ message: "Corrupted PGN header" }),
      ),
    );
    expect(container.querySelector("[data-testid='chessground']")).toBeNull();

    // 2. Cancellation error stays silent
    mocks.notifyUnlessCancelled.mockClear();
    mocks.lexPgn.mockRejectedValueOnce(cancellationError());

    await act(async () => {
      root.render(<Tree pgn="cancelled-pgn" sub1={true} sub2={false} />);
    });
    await vi.waitFor(() => expect(mocks.lexPgn).toHaveBeenCalledTimes(2));
    expect(container.querySelector("[data-testid='chessground']")).toBeNull();
  });

  test("cancel after readGames completed while lexer is held parsing: worker exits and neither data nor failure is published", async () => {
    const controller = new AbortController();
    const game: StampedGame = {
      pgn: "1. e4 e5 2. Nf3",
      stamp: "preview-stamp",
      revision: "preview-revision",
      present: true,
    };
    mocks.readGames.mockResolvedValueOnce([game]);

    let lexSignal!: AbortSignal;
    let rejectLex!: (reason?: unknown) => void;
    mocks.lexPgn.mockImplementation((_pgn: string, options?: { signal?: AbortSignal }) => {
      if (options?.signal) lexSignal = options.signal;
      return new Promise((_resolve, reject) => {
        rejectLex = reject;
        options?.signal?.addEventListener("abort", () => {
          reject(cancellationError());
        });
      });
    });

    // Simulate pipeline: readGames completes, then lexPgn is held
    const games = await mocks.readGames("file.pgn", 0, 0, { signal: controller.signal });
    expect(games).toEqual([game]);

    // Component starts preview
    await act(async () => {
      root.render(<Tree pgn={games[0].pgn} sub1={true} sub2={false} />);
    });
    await vi.waitFor(() => expect(mocks.lexPgn).toHaveBeenCalledOnce());
    expect(lexSignal).toBeDefined();
    expect(lexSignal.aborted).toBe(false);

    // Unmount before lexer finishes
    await act(async () => {
      root.render(<Tree pgn={games[0].pgn} sub1={false} sub2={false} />);
    });
    await vi.waitFor(() => expect(lexSignal.aborted).toBe(true));

    // Allow mock cancellation to settle
    await act(async () => {
      rejectLex(cancellationError());
    });

    expect(mocks.notifyUnlessCancelled).not.toHaveBeenCalled();
    expect(container.querySelector("[data-testid='chessground']")).toBeNull();
  });

  test("late genuine parser rejection after last owner unmount does not notify", async () => {
    let rejectLex!: (reason?: unknown) => void;
    let lexSignal!: AbortSignal;
    mocks.lexPgn.mockImplementation((_pgn: string, options?: { signal?: AbortSignal }) => {
      if (options?.signal) lexSignal = options.signal;
      return new Promise((_resolve, reject) => {
        rejectLex = reject;
      });
    });

    await act(async () => {
      root.render(<Tree pgn="1. e4 e5" sub1={true} sub2={false} />);
    });
    await vi.waitFor(() => expect(mocks.lexPgn).toHaveBeenCalledOnce());
    expect(lexSignal.aborted).toBe(false);

    // Unmount subscriber
    await act(async () => {
      root.render(<Tree pgn="1. e4 e5" sub1={false} sub2={false} />);
    });
    expect(lexSignal.aborted).toBe(true);

    // Now lexer fails with genuine syntax/parser error
    await act(async () => {
      rejectLex(new Error("Malformed SAN move at ply 3"));
    });

    // Stale rejection after departure must remain silent
    expect(mocks.notifyUnlessCancelled).not.toHaveBeenCalled();
    expect(container.querySelector("[data-testid='chessground']")).toBeNull();
  });
});

// MantineProvider reads the colour scheme through matchMedia, which jsdom lacks.
installMatchMediaStub();

// jsdom has no ResizeObserver. This one lets a test report the size of an observed element.
const observed = new Map<Element, ResizeObserverCallback>();
class ReportingResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(element: Element) {
    observed.set(element, this.callback);
  }
  unobserve() {}
  disconnect() {}
}

describe("GamePreview board sizing", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    observed.clear();
    vi.stubGlobal("ResizeObserver", ReportingResizeObserver);
    mocks.lexPgn.mockReset();
    mocks.lexPgn.mockResolvedValue([{ type: "San", value: "e4" }]);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    mocks.realNotation = false;
  });

  test("renders real notation when the workspace has zero tabs", async () => {
    const store = createStore();
    store.set(tabsAtom, []);
    mocks.realNotation = true;
    await act(async () => {
      root.render(
        <Provider store={store}>
          <MantineProvider>
            <SWRConfig value={{ provider: () => new Map() }}>
              <GamePreviewWrapper pgn="1. e4" />
            </SWRConfig>
          </MantineProvider>
        </Provider>,
      );
    });
    await vi.waitFor(() => expect(container.textContent).toContain("e4"));
    expect(store.get(tabsAtom)).toEqual([]);
    expect(store.get(activeTabAtom)).toBeNull();
    expect(mocks.notifyUnlessCancelled).not.toHaveBeenCalled();
  });

  async function renderPreview(
    props: {
      fitHeight?: boolean;
      hideControls?: boolean;
      adaptive?: boolean;
      showOpening?: boolean;
    },
    rootFont = 16,
  ) {
    await act(async () => {
      root.render(
        <MantineProvider>
          <DatabaseLayoutContext.Provider value={{ compact: false, minimum: 20, rootFont }}>
            <SWRConfig value={{ provider: () => new Map() }}>
              <GamePreviewWrapper pgn={`1. e4 ${JSON.stringify(props)}`} {...props} />
            </SWRConfig>
          </DatabaseLayoutContext.Provider>
        </MantineProvider>,
      );
    });
    await vi.waitFor(() =>
      expect(container.querySelector("[data-testid='chessground']")).not.toBeNull(),
    );
    // Group (frame) > board box > chooser frame > wheel box > board.
    const boardBox = container.querySelector("[data-testid='chessground']")!.parentElement!
      .parentElement!.parentElement as HTMLElement;
    return { boardBox, frame: boardBox.parentElement! };
  }

  async function reportSize(element: Element, width: number, height: number) {
    const callback = observed.get(element);
    expect(callback).toBeDefined();
    await act(async () => {
      callback!(
        [
          {
            contentRect: {
              width,
              height,
              x: 0,
              y: 0,
              top: 0,
              left: 0,
              bottom: height,
              right: width,
            },
          } as never,
        ],
        {} as ResizeObserver,
      );
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
  }

  const recordA: GameHeaders = {
    id: 1,
    fen: INITIAL_FEN,
    white: "Alice",
    black: "Bob",
    event: "First",
    site: "Here",
    result: "1-0",
    orientation: "white",
  };
  const recordB: GameHeaders = {
    ...recordA,
    id: 2,
    fen: "rnbqkbnr/pppppppp/8/8/8/8/1PPPPPPP/RNBQKBNR w KQkq - 0 7",
    white: "Carol",
    orientation: "black",
  };

  async function renderRecord(headers?: GameHeaders, warm = false, adaptive = true) {
    await act(async () =>
      root.render(
        <MantineProvider>
          <SWRConfig value={{ provider: () => new Map() }}>
            <div data-testid="selected-preview">
              <GamePreviewWrapper pgn="same movetext" headers={headers} adaptive={adaptive} />
            </div>
            <div hidden>{warm && <GamePreviewWrapper pgn="same movetext" headers={recordB} />}</div>
          </SWRConfig>
        </MantineProvider>,
      ),
    );
    await vi.waitFor(() => expect(selectedBoard()).not.toBeNull());
  }

  function selectedBoard() {
    return container.querySelector(
      '[data-testid="selected-preview"] [data-testid="chessground"]',
    ) as HTMLElement;
  }

  function selectedHeaders() {
    return JSON.parse(
      container
        .querySelector('[data-testid="selected-preview"] [data-testid="game-notation"]')!
        .getAttribute("data-headers")!,
    ) as GameHeaders;
  }

  async function wheelNext() {
    await act(async () =>
      selectedBoard().parentElement!.dispatchEvent(
        new WheelEvent("wheel", { bubbles: true, deltaY: 1 }),
      ),
    );
  }

  test.each([false, true])(
    "preview final-header boundary applies the game-end default without mutating the parse cache, marker=%s",
    async (marked) => {
      mocks.lexPgn.mockResolvedValue([
        { type: "San", value: "e4" },
        ...(marked ? [{ type: "Comment", value: "[%gameend] Game ended here" }] : []),
        { type: "San", value: "e5" },
      ]);
      for (const result of ["1-0", "*", "0-1"] as const) {
        await renderRecord({ ...recordA, result, other: { Termination: "Abandoned" } });
        const notation = container.querySelector(
          '[data-testid="selected-preview"] [data-testid="game-notation"]',
        )!;
        const treeRoot = JSON.parse(notation.getAttribute("data-root")!) as TreeNode;
        const end = getEffectiveGameEnd(treeRoot);
        expect(end?.position).toEqual(marked ? [0] : result === "*" ? undefined : [0, 0]);
        expect(end?.node.gameEnd?.termination).toBe(
          marked || result !== "*" ? "Abandoned" : undefined,
        );
        expect(selectedHeaders().other?.Termination).toBe(
          marked || result !== "*" ? undefined : "Abandoned",
        );
      }
      expect(mocks.lexPgn).toHaveBeenCalledOnce();
    },
  );

  test("warm FEN cache switches A-B-A with the selected root and navigable tree each time", async () => {
    await renderRecord(recordA, true);
    await vi.waitFor(() =>
      expect(container.querySelectorAll('[data-testid="chessground"]')).toHaveLength(2),
    );
    expect(mocks.lexPgn).toHaveBeenCalledTimes(2);
    for (const record of [recordA, recordB, recordA]) {
      await renderRecord(record);
      expect(selectedBoard().dataset.fen).toBe(record.fen);
      await wheelNext();
      expect(selectedBoard().dataset.fen).toBe(
        record.id === 1
          ? "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1"
          : "rnbqkbnr/pppppppp/8/8/4P3/8/1PPP1PPP/RNBQKBNR b KQkq - 0 7",
      );
    }
    expect(mocks.lexPgn).toHaveBeenCalledTimes(2);
  });

  test("equal FEN records replace metadata, orientation and selected move without reparsing", async () => {
    await renderRecord(recordA);
    await wheelNext();
    const other = {
      ...recordA,
      id: 9,
      white: "Other player",
      event: "Other event",
      orientation: "black" as const,
    };
    await renderRecord(other);
    expect(selectedBoard().dataset.fen).toBe(INITIAL_FEN);
    expect(selectedBoard().dataset.orientation).toBe("black");
    expect(selectedHeaders()).toMatchObject(other);
    await wheelNext();
    expect(selectedBoard().dataset.fen).toContain("4P3");
    expect(mocks.lexPgn).toHaveBeenCalledOnce();
  });

  test("header-only changes reset navigation and replace metadata with id, PGN, FEN and Start unchanged", async () => {
    const original = { ...recordA, start: [] };
    await renderRecord(original);
    await wheelNext();
    expect(selectedBoard().dataset.fen).not.toBe(original.fen);
    const updated = {
      ...original,
      white: "Updated player",
      black: "Updated opponent",
      event: "Corrected event",
      orientation: "black" as const,
    };
    expect(updated.id).toBe(original.id);
    expect(updated.fen).toBe(original.fen);
    expect(updated.start).toEqual(original.start);
    await renderRecord(updated);
    expect(selectedBoard().dataset.fen).toBe(original.fen);
    expect(selectedBoard().dataset.orientation).toBe("black");
    expect(selectedHeaders()).toMatchObject(updated);
    await wheelNext();
    expect(selectedBoard().dataset.fen).toContain("4P3");
    expect(mocks.lexPgn).toHaveBeenCalledOnce();
  });

  test("equivalent reordered headers and adaptive reflow retain selected move and chooser", async () => {
    mocks.lexPgn.mockResolvedValue([
      { type: "San", value: "e4" },
      { type: "San", value: "e5" },
      { type: "ParenOpen" },
      { type: "San", value: "c5" },
      { type: "ParenClose" },
    ]);
    const headers = { ...recordA, other: { Custom: "kept", Another: "tag" } };
    await renderRecord(headers);
    await wheelNext();
    await act(async () =>
      (
        container.querySelector(
          '[data-testid="selected-preview"] [data-testid="move-controls"]',
        ) as HTMLElement
      ).click(),
    );
    const board = selectedBoard();
    const chooser = container.querySelector('[role="listbox"]');
    expect(chooser).not.toBeNull();
    const selectedFen = board.dataset.fen;
    const replacement = Object.fromEntries(
      Object.entries(headers).reverse(),
    ) as unknown as GameHeaders;
    replacement.other = { Another: "tag", Custom: "kept" };
    await renderRecord(replacement);
    expect(selectedBoard()).toBe(board);
    expect(board.dataset.fen).toBe(selectedFen);
    expect(container.querySelector('[role="listbox"]')).toBe(chooser);
    const frame = board.parentElement!.parentElement!.parentElement!.parentElement!;
    await reportSize(frame, 900, 700);
    expect(frame.dataset.previewArrangement).toBe("beside");
    await reportSize(frame, 500, 850);
    expect(frame.dataset.previewArrangement).toBe("below");
    await renderRecord(replacement, false, false);
    expect(selectedBoard()).toBe(board);
    expect(board.dataset.fen).toBe(selectedFen);
    expect(container.querySelector('[role="listbox"]')).toBe(chooser);
    await act(async () => (chooser!.querySelectorAll('[role="option"]')[1] as HTMLElement).click());
    expect(board.dataset.fen).toContain("2p5");
  });

  test("retains parsed Start and file metadata, validates supplied Start and aligns header FEN with root", async () => {
    mocks.lexPgn.mockResolvedValue([
      { type: "Header", value: { tag: "White", value: "PGN player" } },
      { type: "Header", value: { tag: "Start", value: "[0]" } },
      { type: "Header", value: { tag: "Orientation", value: "black" } },
      { type: "San", value: "e4" },
    ]);
    await renderRecord();
    expect(selectedHeaders()).toMatchObject({
      white: "PGN player",
      orientation: "black",
      start: [0],
    });
    expect(selectedBoard().dataset.fen).toContain("4P3");
    await renderRecord({ ...recordB, fen: `  ${recordB.fen}  ` });
    expect(selectedHeaders()).toMatchObject({ white: "Carol", start: [0], fen: recordB.fen });
    expect(selectedBoard().dataset.fen).toContain("4P3");
    await renderRecord({ ...recordB, start: [8] });
    expect(selectedHeaders().start).toEqual([]);
    expect(selectedBoard().dataset.fen).toBe(recordB.fen);
    await renderRecord({ ...recordB, start: [0] });
    expect(selectedHeaders().start).toEqual([0]);
    expect(selectedBoard().dataset.fen).toContain("4P3");
  });

  test("a short, wide frame limits the board by its height", async () => {
    const { boardBox, frame } = await renderPreview({ fitHeight: true });
    await reportSize(frame, 600, 200);

    expect(boardBox.style.width).toBe("200px");
    expect(container.querySelector("[data-testid='move-controls']")).not.toBeNull();
  });

  test("adaptive remaining frame after headers chooses both arrangements without replacing position or chooser", async () => {
    mocks.lexPgn.mockResolvedValue([
      { type: "San", value: "e4" },
      { type: "ParenOpen" },
      { type: "San", value: "d4" },
      { type: "ParenClose" },
    ]);
    const { boardBox, frame } = await renderPreview({ adaptive: true, showOpening: true });
    expect(container.querySelector("[data-testid='opening-name']")!.parentElement).toBe(
      frame.parentElement,
    );
    await reportSize(frame, 900, 700);
    expect(frame.dataset.previewArrangement).toBe("beside");
    expect(boardBox.style.width).toBe("692px");
    await act(async () =>
      (container.querySelector("[data-testid='move-controls']") as HTMLElement).click(),
    );
    const chooser = container.querySelector('[role="listbox"]')!;
    const board = container.querySelector("[data-testid='chessground']")!;
    const fen = board.getAttribute("data-fen");
    await reportSize(frame, 500, 850);
    expect(frame.dataset.previewArrangement).toBe("below");
    expect(boardBox.style.width).toBe("500px");
    expect(container.querySelector('[role="listbox"]')).toBe(chooser);
    expect(container.querySelector("[data-testid='chessground']")).toBe(board);
    expect(board.getAttribute("data-fen")).toBe(fen);
    await act(async () => (chooser.querySelector('[role="option"]') as HTMLElement).click());
    const selectedFen = board.getAttribute("data-fen");
    expect(selectedFen).not.toBe(fen);
    await reportSize(frame, 1000, 600);
    expect(frame.dataset.previewArrangement).toBe("beside");
    expect(board.getAttribute("data-fen")).toBe(selectedFen);
  });

  test("adaptive measured geometry at 200% stays in pixels and reserves usable notation and controls", async () => {
    const { boardBox, frame } = await renderPreview({ adaptive: true }, 32);
    await reportSize(frame, 1200, 600);
    expect(frame.dataset.previewArrangement).toBe("beside");
    expect(boardBox.style.width).toBe("600px");
    expect(container.querySelector("[data-testid='game-notation']")).not.toBeNull();
    expect(container.querySelector("[data-testid='move-controls']")).not.toBeNull();
  });

  test("a narrow frame limits the board by its share of the width", async () => {
    const { boardBox, frame } = await renderPreview({ fitHeight: true });
    await reportSize(frame, 300, 400);

    // Half the width: the notation and controls take the other half.
    expect(boardBox.style.width).toBe("150px");
  });

  test("without controls the board may take the whole frame width", async () => {
    const { boardBox, frame } = await renderPreview({ fitHeight: true, hideControls: true });
    await reportSize(frame, 300, 400);

    expect(boardBox.style.width).toBe("300px");
    expect(container.querySelector("[data-testid='move-controls']")).toBeNull();
  });

  test("the default layout leaves the board sized by its column", async () => {
    const { boardBox, frame } = await renderPreview({});
    await reportSize(frame, 600, 200);

    expect(boardBox.style.width).toBe("");
  });
  test.each([
    { name: "Saved shapes follow the current node", orig: "a2", dest: "a4" },
    { name: "Overlap keeps both lists", orig: "e2", dest: "e4" },
  ])("$name", async ({ orig, dest }) => {
    mocks.lexPgn.mockResolvedValue([
      { type: "Comment", value: `[%cal R${orig}${dest}] [%csl Ch5]` },
      { type: "San", value: "e4" },
      { type: "Comment", value: "[%cal Of7f5]" },
      { type: "ParenOpen" },
      { type: "San", value: "d4" },
      { type: "ParenClose" },
    ]);
    await renderRecord(recordA);
    const board = selectedBoard();
    const savedShapes = [
      { orig, dest, brush: "red" },
      { orig: "h5", dest: "h5", brush: "cyan" },
    ];
    expect(JSON.parse(board.dataset.shapes!)).toEqual(savedShapes);
    expect(board.dataset.fen).toBe(INITIAL_FEN);
    await act(async () =>
      (container.querySelector("[data-testid='move-controls']") as HTMLElement).click(),
    );
    expect(container.querySelector('[role="listbox"]')).not.toBeNull();
    expect(board.dataset.fen).toBe(INITIAL_FEN);
    expect(JSON.parse(board.dataset.shapes!)).toEqual([
      { orig: "e2", dest: "e4", brush: "continuationSelected" },
      { orig: "d2", dest: "d4", brush: "continuationOther" },
      ...savedShapes,
    ]);
    await wheelNext();
    expect(board.dataset.fen).toContain("4P3");
    expect(container.querySelector('[role="listbox"]')).toBeNull();
    expect(JSON.parse(board.dataset.shapes!)).toEqual([
      { orig: "f7", dest: "f5", brush: "orange" },
    ]);
  });

  test("preview chooser shares its frame and draws every continuation", async () => {
    mocks.lexPgn.mockResolvedValue([
      { type: "San", value: "e4" },
      { type: "ParenOpen" },
      { type: "San", value: "d4" },
      { type: "ParenClose" },
    ]);
    await renderPreview({});
    await act(async () =>
      (container.querySelector("[data-testid='move-controls']") as HTMLElement).click(),
    );
    const list = container.querySelector('[role="listbox"]')!;
    const board = container.querySelector("[data-testid='chessground']")!;
    expect(list.parentElement!.parentElement).toBe(board.parentElement!.parentElement);
    expect([...list.querySelectorAll('[role="option"]')].map((row) => row.textContent)).toEqual([
      "1. e4",
      "1. d4",
    ]);
    expect(JSON.parse(board.getAttribute("data-shapes")!)).toEqual([
      { orig: "e2", dest: "e4", brush: "continuationSelected" },
      { orig: "d2", dest: "d4", brush: "continuationOther" },
    ]);
  });
});
