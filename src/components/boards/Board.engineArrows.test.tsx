import type { Config } from "@lichess-org/chessground/config";
import { MantineProvider } from "@mantine/core";
import { parseUci } from "chessops";
import { INITIAL_FEN } from "chessops/fen";
import { Provider as JotaiProvider, createStore } from "jotai";
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { BestMoves } from "@/bindings";
import { TreeStateProvider } from "@/components/common/TreeStateContext";
import { AnalysisLineMemory } from "@/components/panels/analysis/analysisLineMemory";
import { analysisSearch } from "@/components/panels/analysis/analysisSearch";
import { tauri } from "@/platform/tauri";
import {
  disposeTabAtoms,
  engineMovesFamily,
  enginesAtom,
  evalOpenFamily,
  showArrowsAtom,
  showConsecutiveArrowsAtom,
  showVariationArrowsAtom,
  tabEngineSettingsFamily,
} from "@/state/atoms";
import { createTreeStore, type TreeStore } from "@/state/store/tree";
import { WorkspaceTabScope } from "@/state/tabScope";
import { installMatchMediaStub } from "@/tests/matchMedia";
import Board from "./Board";

// Keep the real Board, Chessground wrapper, and engine atoms.
const nativeBoard = vi.hoisted(() => ({
  set: vi.fn((_config: Config) => {}),
  destroy: vi.fn(),
  state: { dom: { bounds: { clear: vi.fn() } } },
}));
vi.mock("@lichess-org/chessground", () => ({ Chessground: vi.fn(() => nativeBoard) }));
// Keybind initialization reads the desktop platform before a test can install spies.
vi.mock("@/platform/native", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/platform/native")>()),
  platform: () => "linux",
}));
// Observe actual PV parsing without introducing a production test hook.
vi.mock("chessops", async (importOriginal) => {
  const actual = await importOriginal<typeof import("chessops")>();
  return { ...actual, parseUci: vi.fn(actual.parseUci) };
});

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const tab = "board-engine-arrows";
const engine = {
  type: "local" as const,
  id: "board-engine",
  name: "Stockfish",
  version: "17",
  filename: "stockfish",
  handle: { id: { id: "board-engine-handle" }, kind: "engine" as const },
  loaded: true,
};

function lines(uci: string, depth = 20): BestMoves[] {
  return [
    {
      depth,
      multipv: 1,
      score: { value: { type: "cp", value: 10 }, wdl: null },
      nodes: BigInt(depth),
      nps: 1n,
      uciMoves: [uci, "e7e5"],
      sanMoves: [],
    },
  ];
}

let host: HTMLDivElement;
let root: Root;
let tree: TreeStore;
let atoms: ReturnType<typeof createStore>;

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  // enginesAtom persists through this native boundary even in jsdom.
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
  atoms = createStore();
});

afterEach(async () => {
  await act(async () => root.unmount());
  tree.dispose();
  disposeTabAtoms(tab);
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

async function publish(payload: BestMoves[]) {
  await act(async () => {
    atoms.set(
      engineMovesFamily({ tab, engine: engine.id }),
      new AnalysisLineMemory(new Map([[analysisSearch(INITIAL_FEN, [], false).key!, payload]])),
    );
    tree.getState().setScore({ ...payload[0].score, value: { ...payload[0].score.value } });
  });
}

async function mountBoard() {
  expect((await atoms.set(enginesAtom, [engine])).saved).toBe(true);
  atoms.set(showArrowsAtom, true);
  atoms.set(evalOpenFamily(tab), true);
  atoms.set(showConsecutiveArrowsAtom, false);
  atoms.set(showVariationArrowsAtom, false);
  const settings = tabEngineSettingsFamily({ tab, engineId: engine.id });
  atoms.set(settings, { ...atoms.get(settings), enabled: true });
  await act(async () =>
    root.render(
      <JotaiProvider store={atoms}>
        <MantineProvider>
          <WorkspaceTabScope tabId={tab}>
            <TreeStateProvider store={tree}>
              <Board editingMode={false} boardRef={createRef()} />
            </TreeStateProvider>
          </WorkspaceTabScope>
        </MantineProvider>
      </JotaiProvider>,
    ),
  );
  await publish(lines("e2e4"));
  expect(nativeBoard.set).toHaveBeenLastCalledWith(
    expect.objectContaining({
      drawable: expect.objectContaining({
        autoShapes: [expect.objectContaining({ orig: "e2", dest: "e4", brush: "blue" })],
      }),
    }),
  );
  expect(parseUci).toHaveBeenCalledWith("e2e4");
  nativeBoard.set.mockClear();
  vi.mocked(parseUci).mockClear();
}

test("a deeper identical engine payload and fresh equal score skip config and PV replay", async () => {
  await mountBoard();
  const before = tree.getState().currentNode();
  await publish(lines("e2e4", 25));
  const after = tree.getState().currentNode();
  expect(after).not.toBe(before);
  expect(after.score).not.toBe(before.score);
  expect(after.score).toEqual(before.score);
  expect(after.children).toBe(before.children);
  expect(nativeBoard.set).not.toHaveBeenCalled();
  expect(parseUci).not.toHaveBeenCalled();
});

test("a changed engine PV sets its new arrow once and a later equal score skips replay", async () => {
  await mountBoard();
  await publish(lines("d2d4", 25));
  expect(nativeBoard.set).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      drawable: expect.objectContaining({
        autoShapes: [expect.objectContaining({ orig: "d2", dest: "d4", brush: "blue" })],
      }),
    }),
  );
  expect(vi.mocked(parseUci).mock.calls.map(([uci]) => uci)).toEqual(["d2d4", "e7e5"]);
  vi.mocked(parseUci).mockClear();
  await act(async () => {
    tree.getState().setScore({ value: { type: "cp", value: 10 }, wdl: null });
  });
  expect(nativeBoard.set).toHaveBeenCalledOnce();
  expect(parseUci).not.toHaveBeenCalled();
});
