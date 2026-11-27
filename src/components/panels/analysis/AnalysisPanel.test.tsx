import { act } from "react";
import { enginesAtom } from "@/state/atoms";
import {
  BoardArrangementContext,
  type BoardArrangementContextValue,
} from "@/components/tabs/BoardTabLayout";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import { engineAreaId, type EngineAreaId, type PanelAreaId } from "@/state/boardArrangement";
import { createTreeStore } from "@/state/store/tree";
import { installResizeObserverStub } from "@/tests/resizeObserver";
import { afterEach, expect, test, vi } from "vitest";
import { displayEngine, engineDisplayHarness } from "@/tests/engineDisplay";
import AnalysisPanel, { applyEngineOrder } from "./AnalysisPanel";

const reorder = vi.hoisted(() => ({
  reconcile: vi.fn(),
  showPageTab: vi.fn(),
  cards: new Map<
    string,
    {
      canMoveUp?: boolean;
      canMoveDown?: boolean;
      onMoveUp?: () => void;
      onMoveDown?: () => void;
      canShowAsArea?: boolean;
      onShowAsArea?: () => void;
      onDragStart?: (event: any) => void;
      id: number;
    }
  >(),
}));
vi.mock("@/platform/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/platform/tauri")>();
  return { ...actual, tauri: { ...actual.tauri, reconcileEngineAttachments: reorder.reconcile } };
});
vi.mock("@/components/tabs/TabCommands", () => ({
  useTabCommands: () => ({ showPageTab: reorder.showPageTab }),
}));
vi.mock("./BestMoves", () => ({
  default: (props: any) => {
    reorder.cards.set(props.engine.id, props);
    return (
      <span
        data-engine-id={props.engine.id}
        data-color-index={props.id}
        data-can-move-up={String(Boolean(props.canMoveUp))}
        data-can-move-down={String(Boolean(props.canMoveDown))}
        data-can-show-as-area={String(Boolean(props.canShowAsArea))}
      />
    );
  },
  arrowColors: [{ strong: "blue" }, { strong: "green" }, { strong: "red" }, { strong: "yellow" }],
}));

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("./EngineSelection", () => ({ default: () => null }));
vi.mock("./TablebaseInfo", () => ({ default: () => null }));

let h: ReturnType<typeof engineDisplayHarness>;
afterEach(async () => {
  reorder.cards.clear();
  await h?.close();
});

function makeArrangementCtx(
  overrides: Partial<BoardArrangementContextValue> = {},
): BoardArrangementContextValue {
  return {
    shownPanelAreas: new Set<PanelAreaId>(),
    shownEngineAreas: new Set<EngineAreaId>(),
    getAreaTarget: () => undefined,
    arrangingAvailable: true,
    canTakeOut: () => true,
    canTakeOutEngine: () => true,
    returnPanel: vi.fn(),
    returnEngine: vi.fn(),
    registerReturnListener: vi.fn(),
    beginDrag: vi.fn(),
    consumeSuppressedClick: vi.fn(),
    startPlacing: vi.fn(),
    tabsHidden: false,
    setTabsHidden: vi.fn(),
    ...overrides,
  };
}

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

test("real-store reorder intent cannot resurrect a queued removal or overwrite newer fields", async () => {
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
  const beginDrag = vi.fn();
  await h.render(
    <BoardArrangementContext.Provider value={makeArrangementCtx({ beginDrag })}>
      <TreeStateContext.Provider value={tree}>
        <AnalysisPanel />
      </TreeStateContext.Provider>
    </BoardArrangementContext.Provider>,
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
  // Trigger reorder (move third from index 2 to index 0) via the beginDrag reorder callback.
  reorder.cards.get("third")!.onDragStart!({});
  const onReorder = beginDrag.mock.calls[0][2].onReorder as (from: number, to: number) => void;
  await act(async () => onReorder(2, 0));
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
});

test("has no inner tablist and no score pills; hides start/pause-all when no engine is listed", async () => {
  installResizeObserverStub();
  h = engineDisplayHarness();
  await h.store.set(enginesAtom, []);
  await h.render(
    <BoardArrangementContext.Provider value={makeArrangementCtx()}>
      <TreeStateContext.Provider value={createTreeStore()}>
        <AnalysisPanel />
      </TreeStateContext.Provider>
    </BoardArrangementContext.Provider>,
  );
  expect(h.host.querySelector('[role="tablist"]')).toBeNull();
  expect(h.host.querySelectorAll('[role="tab"]')).toHaveLength(0);
  expect(
    h.host.querySelector(
      'button[aria-label="Board.Analysis.EnableAllEngines"], button[aria-label="Board.Analysis.PauseAllEngines"]',
    ),
  ).toBeNull();
  expect(h.host.querySelector('[data-testid="all-engines-pulled-out"]')).toBeNull();
});

test("pulled-out engines are omitted from the panel, remaining engines keep their loaded-order index, and all-out shows hint and hides start-all", async () => {
  installResizeObserverStub();
  h = engineDisplayHarness();
  const first = { ...displayEngine, id: "first", loaded: true };
  const second = { ...displayEngine, id: "second", loaded: true };
  await h.store.set(enginesAtom, [first, second]);

  // First engine pulled out -> only second is listed, keeping its loaded-order index 1.
  await h.render(
    <BoardArrangementContext.Provider
      value={makeArrangementCtx({ shownEngineAreas: new Set([engineAreaId("first")]) })}
    >
      <TreeStateContext.Provider value={createTreeStore()}>
        <AnalysisPanel />
      </TreeStateContext.Provider>
    </BoardArrangementContext.Provider>,
  );
  const listed = [...h.host.querySelectorAll("[data-engine-id]")];
  expect(listed.map((el) => el.getAttribute("data-engine-id"))).toEqual(["second"]);
  expect(listed[0].getAttribute("data-color-index")).toBe("1");
  expect(
    h.host.querySelector('button[aria-label="Board.Analysis.EnableAllEngines"]'),
  ).not.toBeNull();

  // All loaded engines pulled out -> dimmed hint shown, start/pause-all hidden.
  await h.render(
    <BoardArrangementContext.Provider
      value={makeArrangementCtx({
        shownEngineAreas: new Set([engineAreaId("first"), engineAreaId("second")]),
      })}
    >
      <TreeStateContext.Provider value={createTreeStore()}>
        <AnalysisPanel />
      </TreeStateContext.Provider>
    </BoardArrangementContext.Provider>,
  );
  expect(h.host.querySelectorAll("[data-engine-id]")).toHaveLength(0);
  expect(h.host.querySelector('[data-testid="all-engines-pulled-out"]')).not.toBeNull();
  expect(
    h.host.querySelector(
      'button[aria-label="Board.Analysis.EnableAllEngines"], button[aria-label="Board.Analysis.PauseAllEngines"]',
    ),
  ).toBeNull();
});

test("grip menu disables end move items, hides Show as its own area at cap, and reorders on click", async () => {
  installResizeObserverStub();
  reorder.reconcile.mockReset().mockResolvedValue(undefined);
  h = engineDisplayHarness();
  const first = { ...displayEngine, id: "first", loaded: true };
  const second = { ...displayEngine, id: "second", loaded: true };
  await h.store.set(enginesAtom, [first, second]);

  await h.render(
    <BoardArrangementContext.Provider value={makeArrangementCtx({ canTakeOutEngine: () => false })}>
      <TreeStateContext.Provider value={createTreeStore()}>
        <AnalysisPanel />
      </TreeStateContext.Provider>
    </BoardArrangementContext.Provider>,
  );
  expect(reorder.cards.get("first")!.canMoveUp).toBe(false);
  expect(reorder.cards.get("first")!.canMoveDown).toBe(true);
  expect(reorder.cards.get("first")!.canShowAsArea).toBe(false);
  expect(reorder.cards.get("second")!.canMoveUp).toBe(true);
  expect(reorder.cards.get("second")!.canMoveDown).toBe(false);

  await act(async () => reorder.cards.get("first")!.onMoveDown!());
  await vi.waitFor(() =>
    expect(h.store.get(enginesAtom)?.map((e) => e.id)).toEqual(["second", "first"]),
  );
});

test("refused routed reorder rolls its presentation back to committed order", async () => {
  installResizeObserverStub();
  reorder.reconcile.mockReset().mockResolvedValue(undefined);
  h = engineDisplayHarness();
  const tree = createTreeStore();
  await h.store.set(enginesAtom, [
    { ...displayEngine, id: "first" },
    { ...displayEngine, id: "second" },
  ]);
  await h.render(
    <BoardArrangementContext.Provider value={makeArrangementCtx()}>
      <TreeStateContext.Provider value={tree}>
        <AnalysisPanel />
      </TreeStateContext.Provider>
    </BoardArrangementContext.Provider>,
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
  await act(async () => reorder.cards.get("first")!.onMoveDown!());
  await vi.waitFor(() => expect(reject).toBeTypeOf("function"));
  expect(order()).toEqual(["second", "first"]);
  await act(async () => reject(new Error("drag refused")));
  await vi.waitFor(() => expect(order()).toEqual(["first", "second"]));
  expect(h.store.get(enginesAtom)?.map((item) => item.id)).toEqual(["first", "second"]);
});

test("Manage Engines opens the engines page tab via showPageTab", async () => {
  installResizeObserverStub();
  reorder.showPageTab.mockReset().mockResolvedValue(undefined);
  h = engineDisplayHarness();
  await h.store.set(enginesAtom, []);
  await h.render(
    <BoardArrangementContext.Provider value={makeArrangementCtx()}>
      <TreeStateContext.Provider value={createTreeStore()}>
        <AnalysisPanel />
      </TreeStateContext.Provider>
    </BoardArrangementContext.Provider>,
  );
  const manageButton = [...h.host.querySelectorAll<HTMLButtonElement>("button")].find(
    (btn) => btn.textContent === "Board.Analysis.ManageEngines",
  )!;
  await act(async () => manageButton.click());
  expect(reorder.showPageTab).toHaveBeenCalledExactlyOnceWith("engines");
});
