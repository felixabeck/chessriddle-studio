import type { Config } from "@lichess-org/chessground/config";
import { MantineProvider } from "@mantine/core";
import { Provider as JotaiProvider, createStore } from "jotai";
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { TreeStateProvider } from "@/components/common/TreeStateContext";
import {
  continuationBrushes,
  REVIEW_BETTER_BRUSH,
  REVIEW_PLAYED_BRUSH,
} from "@/components/boards/continuationArrows";
import { arrowColors } from "@/components/panels/analysis/BestMoves";
import { tauri } from "@/platform/tauri";
import {
  disposeTabAtoms,
  invisibleFamily,
  reviewFocusFamily,
  showArrowsAtom,
  showVariationArrowsAtom,
} from "@/state/atoms";
import { createTreeStore, type TreeStore } from "@/state/store/tree";
import { WorkspaceTabScope } from "@/state/tabScope";
import { installMatchMediaStub } from "@/tests/matchMedia";
import Board from "./Board";

const nativeBoard = vi.hoisted(() => ({
  set: vi.fn((_config: Config) => {}),
  destroy: vi.fn(),
  state: { dom: { bounds: { clear: vi.fn() } } },
}));
vi.mock("@lichess-org/chessground", () => ({ Chessground: vi.fn(() => nativeBoard) }));
vi.mock("@/platform/native", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/platform/native")>()),
  platform: () => "linux",
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const tab = "board-review-arrows";

let host: HTMLDivElement;
let root: Root;
let tree: TreeStore;
let atoms: ReturnType<typeof createStore>;

function lastAutoShapes() {
  const lastCall = nativeBoard.set.mock.calls.at(-1)?.[0];
  return lastCall?.drawable?.autoShapes ?? [];
}

async function renderBoard(extraProps?: Partial<React.ComponentProps<typeof Board>>) {
  await act(async () =>
    root.render(
      <JotaiProvider store={atoms}>
        <MantineProvider>
          <WorkspaceTabScope tabId={tab}>
            <TreeStateProvider store={tree}>
              <Board editingMode={false} boardRef={createRef()} {...extraProps} />
            </TreeStateProvider>
          </WorkspaceTabScope>
        </MantineProvider>
      </JotaiProvider>,
    ),
  );
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.clearAllMocks();
  vi.spyOn(tauri, "reconcileEngineAttachments").mockResolvedValue(null);
  installMatchMediaStub();
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
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  tree = createTreeStore();
  tree.getState().makeMoves({ payload: ["e4", "e5", "Qh5"], mainline: true });
  tree.setState((state) => ({
    report: {
      ...state.report,
      summary: {
        engine: "Stockfish 17",
        goMode: { t: "Time", c: 500 },
        createdAt: 1_700_000_000_000,
        missingEvaluations: 0,
        novelty: "notRequested",
        fingerprint: "fp-1",
      },
    },
  }));
  tree.getState().goToStart();
  atoms = createStore();
  atoms.set(showArrowsAtom, false);
  atoms.set(showVariationArrowsAtom, false);
});

afterEach(async () => {
  await act(async () => root.unmount());
  disposeTabAtoms(tab);
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});

test("review brushes exist and differ from each other and from engine/continuation brushes", () => {
  const played = continuationBrushes[REVIEW_PLAYED_BRUSH];
  const better = continuationBrushes[REVIEW_BETTER_BRUSH];
  expect(played).toBeDefined();
  expect(better).toBeDefined();
  expect(played.color).not.toBe(better.color);
  expect(played.key).not.toBe(better.key);

  const otherNames = new Set([
    ...arrowColors.flatMap((c) => [c.strong, c.pale]),
    "variation",
    "continuationSelected",
    "continuationOther",
  ]);
  expect(otherNames.has(REVIEW_PLAYED_BRUSH)).toBe(false);
  expect(otherNames.has(REVIEW_BETTER_BRUSH)).toBe(false);
});

test("Board draws both review arrows on matching focus, keeps focus on selection, and never persists it", async () => {
  await renderBoard();
  expect(lastAutoShapes()).toEqual([]);
  localStorage.clear();
  sessionStorage.clear();

  // Select moment 2.Qh5 (before-path [0, 0]) in the same update as setting focus.
  const beforeFen = tree.getState().root.children[0].children[0].fen;
  await act(async () => {
    atoms.set(reviewFocusFamily(tab), {
      documentId: tree.getState().documentId,
      path: [0, 0],
      fen: beforeFen,
      summaryCreatedAt: 1_700_000_000_000,
      playedSan: "Qh5",
      betterSan: "Nf3",
    });
    tree.getState().goToMove([0, 0]);
  });

  // Focus survives selection and draws both arrows in their own brushes.
  expect(atoms.get(reviewFocusFamily(tab))).not.toBeNull();
  expect(lastAutoShapes()).toEqual([
    { orig: "d1", dest: "h5", brush: REVIEW_PLAYED_BRUSH },
    { orig: "g1", dest: "f3", brush: REVIEW_BETTER_BRUSH },
  ]);
  // Never persisted to web storage.
  expect(localStorage.length).toBe(0);
  expect(sessionStorage.length).toBe(0);
});

test("Board drops arrows and clears focus when leaving the position, switching document, or applying a newer summary", async () => {
  const beforeFen = tree.getState().root.children[0].children[0].fen;
  await renderBoard();

  const focusMoment = async () => {
    await act(async () => {
      atoms.set(reviewFocusFamily(tab), {
        documentId: tree.getState().documentId,
        path: [0, 0],
        fen: beforeFen,
        summaryCreatedAt: tree.getState().report.summary?.createdAt ?? null,
        playedSan: "Qh5",
        betterSan: "Nf3",
      });
      tree.getState().goToMove([0, 0]);
    });
    expect(lastAutoShapes()).toHaveLength(2);
  };

  // 1. Leaving the position clears focus and drops arrows; returning does not revive them.
  await focusMoment();
  await act(async () => tree.getState().goToMove([0, 0, 0]));
  expect(lastAutoShapes()).toEqual([]);
  expect(atoms.get(reviewFocusFamily(tab))).toBeNull();
  await act(async () => tree.getState().goToMove([0, 0]));
  expect(lastAutoShapes()).toEqual([]);

  // 2. Another document (resetting the game to a new documentId) drops arrows and clears focus.
  await focusMoment();
  await act(async () => {
    tree.getState().reset();
    tree.getState().makeMoves({ payload: ["e4", "e5"], mainline: true });
  });
  expect(lastAutoShapes()).toEqual([]);
  expect(atoms.get(reviewFocusFamily(tab))).toBeNull();

  // 3. A newer report summary (different createdAt) drops arrows and clears focus.
  await act(async () => {
    tree.getState().makeMoves({ payload: ["Qh5"], mainline: true });
    tree.setState((state) => ({
      report: {
        ...state.report,
        summary: {
          engine: "Stockfish 17",
          goMode: { t: "Time", c: 500 },
          createdAt: 1_700_000_000_001,
          missingEvaluations: 0,
          novelty: "notRequested",
          fingerprint: "fp-2",
        },
      },
    }));
  });
  await focusMoment();
  await act(async () => {
    tree.setState((state) => ({
      report: {
        ...state.report,
        summary: { ...state.report.summary!, createdAt: 1_700_000_000_999 },
      },
    }));
  });
  expect(lastAutoShapes()).toEqual([]);
  expect(atoms.get(reviewFocusFamily(tab))).toBeNull();
});

test("Board hides review arrows in practice mode and while notation is hidden", async () => {
  const beforeFen = tree.getState().root.children[0].children[0].fen;
  await renderBoard();

  await act(async () => {
    atoms.set(reviewFocusFamily(tab), {
      documentId: tree.getState().documentId,
      path: [0, 0],
      fen: beforeFen,
      summaryCreatedAt: 1_700_000_000_000,
      playedSan: "Qh5",
      betterSan: "Nf3",
    });
    tree.getState().goToMove([0, 0]);
  });
  expect(lastAutoShapes()).toHaveLength(2);

  // Hidden notation suppresses review arrows.
  await act(async () => atoms.set(invisibleFamily(tab), true));
  expect(lastAutoShapes()).toEqual([]);
  await act(async () => atoms.set(invisibleFamily(tab), false));
  expect(lastAutoShapes()).toHaveLength(2);

  // Practice mode suppresses review arrows.
  await renderBoard({
    practiceMove: { canMove: true, submitMove: vi.fn() },
  });
  expect(lastAutoShapes()).toEqual([]);
});

test("Board drops arrows and clears focus when only the current node FEN changes", async () => {
  const beforeFen = tree.getState().root.children[0].children[0].fen;
  await renderBoard();

  await act(async () => {
    atoms.set(reviewFocusFamily(tab), {
      documentId: tree.getState().documentId,
      path: [0, 0],
      fen: beforeFen,
      summaryCreatedAt: 1_700_000_000_000,
      playedSan: "Qh5",
      betterSan: "Nf3",
    });
    tree.getState().goToMove([0, 0]);
  });
  expect(lastAutoShapes()).toHaveLength(2);

  // Mutate only the current node's FEN (same documentId, path and summaryCreatedAt).
  const differentFen = "rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2";
  await act(async () => {
    tree.setState((state) => {
      const e4 = state.root.children[0];
      const e5 = e4.children[0];
      return {
        root: {
          ...state.root,
          children: [{ ...e4, children: [{ ...e5, fen: differentFen }] }],
        },
      };
    });
  });

  expect(lastAutoShapes()).toEqual([]);
  expect(atoms.get(reviewFocusFamily(tab))).toBeNull();
});

test("Board draws only the played arrow when betterSan is null", async () => {
  const beforeFen = tree.getState().root.children[0].children[0].fen;
  await renderBoard();

  await act(async () => {
    atoms.set(reviewFocusFamily(tab), {
      documentId: tree.getState().documentId,
      path: [0, 0],
      fen: beforeFen,
      summaryCreatedAt: 1_700_000_000_000,
      playedSan: "Qh5",
      betterSan: null,
    });
    tree.getState().goToMove([0, 0]);
  });

  expect(lastAutoShapes()).toEqual([{ orig: "d1", dest: "h5", brush: REVIEW_PLAYED_BRUSH }]);
});
