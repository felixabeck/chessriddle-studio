import { INITIAL_FEN } from "chessops/fen";
import { act } from "react";
import { engineTerminalFamily, enginesAtom, scoreTypeFamily, threatFamily } from "@/state/atoms";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import { createTreeStore } from "@/state/store/tree";
import { installResizeObserverStub } from "@/tests/resizeObserver";
import { engineIdentity, engineLineContext } from "./analysisLineContext";
import { afterEach, expect, test, vi } from "vitest";
import { displayEngine, displayLines, engineDisplayHarness } from "@/tests/engineDisplay";
import AnalysisPanel, { applyEngineOrder, EngineSummary } from "./AnalysisPanel";
import { analysisSearch } from "./analysisSearch";
import scoreBubbleClasses from "./ScoreBubble.module.css";

const reorder = vi.hoisted(() => ({
  reconcile: vi.fn(),
  drag: undefined as
    | undefined
    | ((result: { source: { index: number }; destination: { index: number } }) => void),
}));
vi.mock("@/platform/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/platform/tauri")>();
  return { ...actual, tauri: { ...actual.tauri, reconcileEngineAttachments: reorder.reconcile } };
});
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("@hello-pangea/dnd", () => ({
  DragDropContext: ({ onDragEnd, children }: any) => {
    reorder.drag = onDragEnd;
    return children;
  },
  Droppable: ({ children }: any) =>
    children({ innerRef: () => undefined, droppableProps: {}, placeholder: null }),
  Draggable: ({ children }: any) =>
    children({ innerRef: () => undefined, draggableProps: {}, dragHandleProps: {} }),
}));
vi.mock("./BestMoves", () => ({
  default: ({ engine }: any) => <span data-engine-id={engine.id} />,
  arrowColors: [{ strong: "blue" }, { strong: "green" }],
}));

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("./EngineSelection", () => ({ default: () => null }));
vi.mock("./LogsPanel", () => ({ default: () => null }));
vi.mock("./ReportPanel", () => ({ default: () => null }));
vi.mock("./TablebaseInfo", () => ({ default: () => null }));
let h: ReturnType<typeof engineDisplayHarness>;
afterEach(async () => h?.close());
test("order intents preserve latest membership, unloaded slots and current record fields", () => {
  const first = { ...displayEngine, id: "first", name: "Same name" };
  const second = { ...displayEngine, id: "second", name: "Same name", version: "upgraded" };
  const added = { ...displayEngine, id: "added" };
  const unloaded = { ...displayEngine, id: "unloaded", loaded: false };
  const reordered = applyEngineOrder(
    [first, unloaded, second, added],
    ["removed", "second", "first"],
  );
  expect(reordered).toEqual([second, unloaded, first, added]);
  expect(reordered[0]).toBe(second);
});

test("real-store drag intent cannot resurrect a queued removal or overwrite newer fields", async () => {
  installResizeObserverStub();
  reorder.reconcile.mockReset().mockResolvedValue(undefined);
  h = engineDisplayHarness();
  const tree = createTreeStore();
  const first = { ...displayEngine, id: "first" };
  const second = { ...displayEngine, id: "second" };
  const third = { ...displayEngine, id: "third" };
  const added = { ...displayEngine, id: "added" };
  const unloaded = { ...displayEngine, id: "unloaded", loaded: false };
  await h.store.set(enginesAtom, [first, unloaded, second, third]);
  await h.render(
    <TreeStateContext.Provider value={tree}>
      <AnalysisPanel />
    </TreeStateContext.Provider>,
  );
  let release!: () => void;
  reorder.reconcile.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const newer = h.store.set(enginesAtom, (current) => [
    ...current.map((engine) =>
      engine.id === second.id ? { ...engine, name: "Updated", version: "new" } : engine,
    ),
    added,
  ]);
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  const removal = h.store.set(enginesAtom, { removeLocalId: first.id });
  await act(async () => reorder.drag!({ source: { index: 2 }, destination: { index: 0 } }));
  await act(async () => {
    release();
    await newer;
    await removal;
  });
  await vi.waitFor(() =>
    expect(h.store.get(enginesAtom)).toEqual([
      { ...unloaded, legacyAssessment: null },
      { ...third, legacyAssessment: null },
      { ...second, name: "Updated", version: "new", legacyAssessment: null },
      { ...added, legacyAssessment: null },
    ]),
  );
  tree.dispose();
});

test("refused routed drag rolls its presentation back to committed order", async () => {
  installResizeObserverStub();
  reorder.reconcile.mockReset().mockResolvedValue(undefined);
  h = engineDisplayHarness();
  const tree = createTreeStore();
  await h.store.set(enginesAtom, [
    { ...displayEngine, id: "first" },
    { ...displayEngine, id: "second" },
  ]);
  await h.render(
    <TreeStateContext.Provider value={tree}>
      <AnalysisPanel />
    </TreeStateContext.Provider>,
  );
  const order = () =>
    [...h.host.querySelectorAll("[data-engine-id]")].map((node) =>
      node.getAttribute("data-engine-id"),
    );
  let reject!: (error: Error) => void;
  reorder.reconcile.mockImplementationOnce(
    () =>
      new Promise((_resolve, refuse) => {
        reject = refuse;
      }),
  );
  await act(async () => reorder.drag!({ source: { index: 0 }, destination: { index: 1 } }));
  await vi.waitFor(() => expect(reject).toBeTypeOf("function"));
  expect(order()).toEqual(["second", "first"]);
  await act(async () => reject(new Error("drag refused")));
  await vi.waitFor(() => expect(order()).toEqual(["first", "second"]));
  expect(h.store.get(enginesAtom)?.map((item) => item.id)).toEqual(["first", "second"]);
  tree.dispose();
});
test("EngineSummary uses the shared dimmed fallback instead of ??? until a current result", async () => {
  h = engineDisplayHarness();
  await h.remember();
  const summary = (moves: string[]) => (
    <EngineSummary engine={displayEngine} fen={INITIAL_FEN} moves={moves} shorten={false} i={0} />
  );
  await h.render(summary([]));
  await h.render(summary(["e2e4"]));
  expect(h.host.querySelector("[inert]")?.textContent).toContain("0.34");
  expect(h.host.textContent).not.toContain("???");
  await h.remember(
    [{ ...displayLines[0], score: { value: { type: "cp", value: 55 }, wdl: null } }],
    ["e2e4"],
  );
  expect(h.host.querySelector("[inert]")).toBeNull();
  expect(h.host.textContent).toContain("0.55");
});

test("EngineSummary displays and toggles the engine's shared WDL preference unless dimmed", async () => {
  h = engineDisplayHarness();
  h.store.set(scoreTypeFamily(displayEngine.id), "wdl");
  await h.remember([
    { ...displayLines[0], score: { ...displayLines[0].score, wdl: [450, 300, 250] } },
  ]);
  const summary = (moves: string[]) => (
    <EngineSummary engine={displayEngine} fen={INITIAL_FEN} moves={moves} shorten={false} i={0} />
  );
  await h.render(summary([]));
  const chip = () => h.host.querySelector<HTMLElement>(`.${scoreBubbleClasses.bubble}`)!;
  expect(h.host.querySelector('[aria-label="Board.Analysis.Tablebase.WhiteWins"]')).not.toBeNull();
  await act(async () => chip().click());
  expect(h.store.get(scoreTypeFamily(displayEngine.id))).toBe("cp");
  await act(async () => chip().click());
  expect(h.store.get(scoreTypeFamily(displayEngine.id))).toBe("wdl");
  await h.render(summary(["e2e4"]));
  expect(chip().closest("[inert]")).not.toBeNull();
  await act(async () => chip().click());
  expect(h.store.get(scoreTypeFamily(displayEngine.id))).toBe("wdl");
});

test("EngineSummary clears historical threat evaluation while unavailable and restores the legal key", async () => {
  h = engineDisplayHarness();
  h.store.set(threatFamily("display-tab"), true);
  h.store.set(h.memoryAtom, new Map([[analysisSearch(INITIAL_FEN, [], true).key!, displayLines]]));
  const summary = (moves: string[]) => (
    <EngineSummary engine={displayEngine} fen={INITIAL_FEN} moves={moves} shorten={false} i={0} />
  );
  await h.render(summary([]));
  expect(h.host.textContent).toContain("0.34");
  await h.render(summary(["e2e4", "d7d5", "f1b5"]));
  expect(h.host.textContent).toContain("???");
  expect(h.host.textContent).not.toContain("0.34");
  expect(h.host.textContent).not.toContain("Board.Analysis.EngineFailed");
  expect(h.host.querySelector("[inert]")).toBeNull();
  await h.render(summary([]));
  expect(h.host.textContent).toContain("0.34");
});

test.each([false, true])(
  "P2 EngineSummary shows failure with historical evaluation, partial lines %s",
  async (partial) => {
    h = engineDisplayHarness();
    if (partial) await h.remember();
    await h.render(
      <EngineSummary engine={displayEngine} fen={INITIAL_FEN} moves={[]} shorten={false} i={0} />,
    );
    await act(async () =>
      h.store.set(engineTerminalFamily({ tab: "display-tab", engine: displayEngine.id }), {
        type: "failed",
        searchedKey: `${INITIAL_FEN}:`,
        fingerprint: "attempt",
        generation: "generation",
        retry: 0,
        context: engineLineContext(h.store.get(h.settingsAtom), displayEngine),
        engineIdentity: engineIdentity(displayEngine),
      }),
    );
    expect(h.host.textContent).toContain("Board.Analysis.EngineFailed");
    expect(h.host.querySelector("[inert]") !== null).toBe(partial);
    expect(h.host.querySelector("[inert]")?.textContent).toBe(partial ? "+0.34" : undefined);
  },
);
