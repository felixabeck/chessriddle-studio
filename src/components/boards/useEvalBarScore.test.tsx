import { INITIAL_FEN } from "chessops/fen";
import { act } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Score } from "@/bindings";
import { ENGINE_LINES_LOADING_DELAY_MS } from "@/components/panels/analysis/useDisplayedEngineLines";
import {
  engineMovesFamily,
  engineTerminalFamily,
  enginesAtom,
  tabEngineSettingsFamily,
  threatFamily,
} from "@/state/atoms";
import { AnalysisLineMemory } from "@/utils/analysisLineMemory";
import {
  engineIdentity,
  engineLineContext,
} from "@/components/panels/analysis/analysisLineContext";
import { analysisSearch } from "@/utils/analysisSearch";
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
let shownEngine: string | null;

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
  const bar = useEvalBarScore({
    score,
    tab: "display-tab",
    documentId,
    rootFen: INITIAL_FEN,
    moves,
  });
  shown = bar?.score ?? null;
  shownEngine = bar?.engineName ?? null;
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

const cloud = {
  type: "chessdb",
  id: "cloud",
  name: "ChessDB",
  url: "https://x.test",
  loaded: true,
};

/** Gives `engine` remembered lines for E4 with the given top score, enabled or not. */
async function remember(engine: { id: string }, value: number, enabled = true) {
  const settings = tabEngineSettingsFamily({ tab: "display-tab", engineId: engine.id });
  await act(async () => h.store.set(settings, { ...h.store.get(settings), enabled }));
  const memory = new AnalysisLineMemory();
  memory.context = engineLineContext(h.store.get(settings), engine as never);
  memory.set(analysisSearch(INITIAL_FEN, E4, false).key!, [
    { ...displayLines[0], score: cp(value) },
  ]);
  await act(async () =>
    h.store.set(engineMovesFamily({ tab: "display-tab", engine: engine.id }), memory),
  );
}

test("a cloud engine still computing holds the bar like a local one", async () => {
  await act(async () => h.store.set(enginesAtom, [{ ...cloud, id: displayEngine.id }] as never));
  await show({ score: cp(100), moves: [] });
  await show({ score: null, moves: E4 });
  expect(shown).toEqual(cp(100));
});

test("a cloud engine running alone fills the bar and is named as the source", async () => {
  await act(async () => h.store.set(enginesAtom, [cloud] as never));
  await remember(cloud, 94);
  await show({ score: null, moves: E4 });
  expect(shown).toEqual(cp(94));
  expect(shownEngine).toBe("ChessDB");
});

test("the engine list order decides whose score shows when two engines have lines", async () => {
  await remember(cloud, 94);
  await remember(displayEngine, 100);
  for (const [engines, value, name] of [
    [[cloud, displayEngine], 94, "ChessDB"],
    [[displayEngine, cloud], 100, "Stockfish"],
  ] as const) {
    await act(async () => h.store.set(enginesAtom, engines as never));
    // The node still carries the other engine's stored score; the live order wins over it.
    await show({ score: cp(-500), moves: E4 });
    expect(shown).toEqual(cp(value));
    expect(shownEngine).toBe(name);
  }
});

test("the node's stored score shows unnamed when no engine has lines for the position", async () => {
  await show({ score: cp(100), moves: E4 });
  expect(shown).toEqual(cp(100));
  expect(shownEngine).toBeNull();
});

test("shows a local engine's remembered lines for a position the node has no score for", async () => {
  await remember(displayEngine, 34);
  await show({ score: cp(100), moves: [] });
  await show({ score: null, moves: E4 });
  expect(shown).toEqual(cp(34));
});

test("once the bar has shown empty, a later wait does not bring back an older score", async () => {
  await show({ score: cp(100), moves: [] });
  await show({ score: null, moves: E4 });
  await advance(ENGINE_LINES_LOADING_DELAY_MS);
  expect(shown).toBeNull();
  await show({ score: null, moves: E4E5 });
  expect(shown).toBeNull();
});

test("only a loaded, enabled engine counts, wherever it sits in the engine list", async () => {
  const unloaded = { ...displayEngine, id: "unloaded", loaded: false };
  const disabled = { ...displayEngine, id: "disabled" };
  const disabledCloud = { ...cloud, id: "disabled-cloud" };
  // The stale engines remember lines for E4; none may show them or hold the bar.
  await remember(unloaded, 1);
  await remember(disabled, 2, false);
  await remember(disabledCloud, 3, false);
  // The active local engine is still computing E4, whether it comes last or first.
  const orders = [
    [disabledCloud, unloaded, disabled, displayEngine],
    [displayEngine, disabledCloud, unloaded, disabled],
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
  await remember(second, 34);
  await act(async () => h.store.set(enginesAtom, [displayEngine, second] as never));
  await show({ score: cp(100), moves: [] });
  await show({ score: null, moves: E4 });
  expect(shown).toEqual(cp(34));
});

/** Marks `engine`'s search of E4 as finished without lines, as an unknown cloud position is. */
async function finishWithoutLines(engine: typeof cloud) {
  const settings = tabEngineSettingsFamily({ tab: "display-tab", engineId: engine.id });
  await act(async () => h.store.set(settings, { ...h.store.get(settings), enabled: true }));
  await act(async () =>
    h.store.set(engineTerminalFamily({ tab: "display-tab", engine: engine.id }), {
      type: "not-in-database",
      searchedKey: analysisSearch(INITIAL_FEN, E4, false).key!,
      context: engineLineContext(h.store.get(settings), engine as never),
      fingerprint: "",
      engineIdentity: engineIdentity(engine as never),
      generation: null,
      retry: 0,
    }),
  );
}

test("a cloud engine that does not know the position neither holds nor blocks the bar", async () => {
  await finishWithoutLines(cloud);
  await act(async () => h.store.set(enginesAtom, [cloud] as never));
  await show({ score: cp(100), moves: [] });
  await show({ score: null, moves: E4 });
  // Nothing is pending any more, so the previous move's score does not linger.
  expect(shown).toBeNull();

  await remember(displayEngine, 34);
  await act(async () => h.store.set(enginesAtom, [cloud, displayEngine] as never));
  await show({ score: null, moves: E4 });
  expect(shown).toEqual(cp(34));
  expect(shownEngine).toBe("Stockfish");
});
