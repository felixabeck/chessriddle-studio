import { INITIAL_FEN } from "chessops/fen";
import { act } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Score } from "@/bindings";
import { ENGINE_LINES_LOADING_DELAY_MS } from "@/components/panels/analysis/useDisplayedEngineLines";
import {
  engineMovesFamily,
  enginesAtom,
  tabEngineSettingsFamily,
  threatFamily,
} from "@/state/atoms";
import { AnalysisLineMemory } from "@/components/panels/analysis/analysisLineMemory";
import { engineLineContext } from "@/components/panels/analysis/analysisLineContext";
import { analysisSearch } from "@/components/panels/analysis/analysisSearch";
import { displayEngine, displayLines, engineDisplayHarness } from "@/tests/engineDisplay";
import { useEvalBarScore } from "./useEvalBarScore";

// The real engine list persists through the native owner; a plain atom stands in for it here.
vi.mock("@/state/atoms", async () => {
  const actual = await vi.importActual<typeof import("@/state/atoms")>("@/state/atoms");
  const { atom } = await vi.importActual<typeof import("jotai")>("jotai");
  return { ...actual, enginesAtom: atom<unknown[] | undefined>(undefined) };
});

let h: ReturnType<typeof engineDisplayHarness>;
let shown: Score | null;

const cp = (value: number): Score => ({ value: { type: "cp", value }, wdl: null });
const E4 = ["e2e4"];
const E4E5 = ["e2e4", "e7e5"];

function Probe({
  score,
  moves,
  documentId = 1,
}: {
  score: Score | null;
  moves: string[];
  documentId?: number;
}) {
  shown = useEvalBarScore({ score, tab: "display-tab", documentId, rootFen: INITIAL_FEN, moves });
  return null;
}

const show = (props: Parameters<typeof Probe>[0]) => h.render(<Probe {...props} />);
const advance = (ms: number) => act(async () => vi.advanceTimersByTime(ms));

beforeEach(() => {
  vi.useFakeTimers();
  h = engineDisplayHarness();
  // The harness enables the engine for the tab; it has no lines for any position yet.
  h.store.set(enginesAtom, [displayEngine] as never);
});

afterEach(async () => {
  await h.close();
  vi.useRealTimers();
});

test("keeps the previous score while the engine computes the next position", async () => {
  await show({ score: cp(100), moves: [] });
  await show({ score: null, moves: E4 });
  expect(shown).toEqual(cp(100));

  await advance(ENGINE_LINES_LOADING_DELAY_MS - 1);
  expect(shown).toEqual(cp(100));

  await show({ score: cp(30), moves: E4 });
  expect(shown).toEqual(cp(30));
});

test("each move restarts the hold, and the newest score is the one held", async () => {
  await show({ score: cp(100), moves: [] });
  await show({ score: cp(30), moves: E4 });
  await show({ score: null, moves: E4E5 });
  expect(shown).toEqual(cp(30));

  await advance(ENGINE_LINES_LOADING_DELAY_MS - 300);
  await show({ score: null, moves: E4 });
  await advance(ENGINE_LINES_LOADING_DELAY_MS - 1);
  expect(shown).toEqual(cp(30));

  await advance(1);
  expect(shown).toBeNull();
});

test("clears once the engine takes longer than its loading delay", async () => {
  await show({ score: cp(100), moves: [] });
  await show({ score: null, moves: E4 });
  await advance(ENGINE_LINES_LOADING_DELAY_MS);
  expect(shown).toBeNull();
});

test("shows nothing when no engine search is pending for the position", async () => {
  await show({ score: cp(100), moves: [] });
  await act(async () =>
    h.store.set(h.settingsAtom, { ...h.store.get(h.settingsAtom), enabled: false }),
  );
  await show({ score: null, moves: E4 });
  expect(shown).toBeNull();
});

test("shows nothing while threat mode runs, which never writes the node score", async () => {
  await show({ score: cp(100), moves: [] });
  await act(async () => h.store.set(threatFamily("display-tab"), true));
  await show({ score: null, moves: E4 });
  expect(shown).toBeNull();
});

test("does not carry a score into another document loaded into the tab", async () => {
  await show({ score: cp(500), moves: E4 });
  await show({ score: null, moves: E4, documentId: 2 });
  expect(shown).toBeNull();
});

test("leaves no hold timer behind on unmount", async () => {
  await show({ score: cp(100), moves: [] });
  await show({ score: null, moves: E4 });
  const holding = vi.getTimerCount();
  await show({ score: null, moves: E4E5 });
  expect(vi.getTimerCount()).toBe(holding);
  await h.close();
  expect(vi.getTimerCount()).toBe(holding - 1);
});

test("a cloud engine never writes the node score, so it does not hold the bar", async () => {
  await act(async () =>
    h.store.set(enginesAtom, [
      { type: "chessdb", id: displayEngine.id, name: "Cloud", url: "https://x.test", loaded: true },
    ] as never),
  );
  await show({ score: cp(100), moves: [] });
  await show({ score: null, moves: E4 });
  expect(shown).toBeNull();
});

test("shows a local engine's remembered lines for a position the node has no score for", async () => {
  const memory = new AnalysisLineMemory();
  memory.context = engineLineContext(h.store.get(h.settingsAtom), displayEngine);
  memory.set(analysisSearch(INITIAL_FEN, E4, false).key!, displayLines);
  await act(async () => h.store.set(h.memoryAtom, memory));
  await show({ score: cp(100), moves: [] });
  await show({ score: null, moves: E4 });
  expect(shown).toEqual(displayLines[0].score);
});

test("once the bar has shown empty, a later wait does not bring back an older score", async () => {
  await show({ score: cp(100), moves: [] });
  await show({ score: null, moves: E4 });
  await advance(ENGINE_LINES_LOADING_DELAY_MS);
  expect(shown).toBeNull();
  await show({ score: null, moves: E4E5 });
  expect(shown).toBeNull();
});

test("only a loaded, enabled local engine counts, wherever it sits in the engine list", async () => {
  const cloud = {
    type: "chessdb",
    id: "cloud",
    name: "Cloud",
    url: "https://x.test",
    loaded: true,
  };
  const unloaded = { ...displayEngine, id: "unloaded", loaded: false };
  const disabled = { ...displayEngine, id: "disabled" };
  const remember = async (engine: typeof displayEngine, enabled: boolean) => {
    const settings = tabEngineSettingsFamily({ tab: "display-tab", engineId: engine.id });
    await act(async () => h.store.set(settings, { ...h.store.get(settings), enabled }));
    const memory = new AnalysisLineMemory();
    memory.context = engineLineContext(h.store.get(settings), engine);
    memory.set(analysisSearch(INITIAL_FEN, E4, false).key!, displayLines);
    await act(async () =>
      h.store.set(engineMovesFamily({ tab: "display-tab", engine: engine.id }), memory),
    );
  };
  // Both stale engines remember lines for E4; neither may show them or hold the bar.
  await remember(unloaded, true);
  await remember(disabled, false);
  // The active local engine is still computing E4, whether it comes last or first.
  const orders = [
    [cloud, unloaded, disabled, displayEngine],
    [displayEngine, cloud, unloaded, disabled],
  ];
  for (const [index, engines] of orders.entries()) {
    await act(async () => h.store.set(enginesAtom, engines as never));
    await show({ score: cp(100), moves: [], documentId: index });
    await show({ score: null, moves: E4, documentId: index });
    expect(shown).toEqual(cp(100));
  }
});

test("a second local engine's remembered lines win over the first engine still computing", async () => {
  const second = { ...displayEngine, id: "second" };
  const settings = tabEngineSettingsFamily({ tab: "display-tab", engineId: second.id });
  await act(async () => h.store.set(settings, { ...h.store.get(settings), enabled: true }));
  const memory = new AnalysisLineMemory();
  memory.context = engineLineContext(h.store.get(settings), second);
  memory.set(analysisSearch(INITIAL_FEN, E4, false).key!, displayLines);
  await act(async () => {
    h.store.set(engineMovesFamily({ tab: "display-tab", engine: second.id }), memory);
    h.store.set(enginesAtom, [displayEngine, second] as never);
  });
  await show({ score: cp(100), moves: [] });
  await show({ score: null, moves: E4 });
  expect(shown).toEqual(displayLines[0].score);
});
