import { act } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { createTreeStore } from "@/state/store/tree";
import {
  currentDetachedEngineAtom,
  detachedEngineLinesAtom,
  detachedEnginePlacementAtom,
  enginesAtom,
  engineTerminalFamily,
  previewBoardOnHoverAtom,
  scoreTypeFamily,
  threatFamily,
} from "@/state/atoms";
import { INITIAL_FEN } from "chessops/fen";
import { engineIdentity, engineLineContext } from "../panels/analysis/analysisLineContext";
import { displayEngine, displayLines, engineDisplayHarness } from "@/tests/engineDisplay";
import { installResizeObserverStub } from "@/tests/resizeObserver";
import { TreeStateContext } from "./TreeStateContext";
import DetachedEval from "./DetachedEval";
import { analysisSearch } from "../panels/analysis/analysisSearch";
import scoreBubbleClasses from "../panels/analysis/ScoreBubble.module.css";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/utils/sound", () => ({ playSound: vi.fn() }));
vi.mock("@/platform/native", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/platform/native")>()),
  warn: vi.fn(),
}));
vi.mock("@/chessground/Chessground", () => ({
  Chessground: ({ fen }: { fen: string }) => <div data-preview-fen={fen} />,
}));
vi.mock("@/platform/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/platform/tauri")>();
  return {
    ...actual,
    tauri: { ...actual.tauri, reconcileEngineAttachments: vi.fn().mockResolvedValue(undefined) },
  };
});
/** `displayLines[0]` (e4 e5 Nf3) as rendered from the start position. */
const LINE = "1.e4e52.♘f3";
/** A threat search passes White's turn, so its line starts with a Black move. */
const threatLines = [
  { ...displayLines[0], sanMoves: ["e5", "Nf3", "Nc6"], uciMoves: ["e7e5", "g1f3", "b8c6"] },
];
const THREAT_LINE = "1...e52.♘f3♘c6";

let h: ReturnType<typeof engineDisplayHarness>;
afterEach(async () => h.close());
test("DetachedEval drops historical threat PV and score in check and restores legal analysis", async () => {
  h = engineDisplayHarness();
  const tree = createTreeStore();
  await h.store.set(enginesAtom, [displayEngine]);
  h.store.set(currentDetachedEngineAtom, displayEngine.id);
  h.store.set(threatFamily("display-tab"), true);
  h.store.set(h.memoryAtom, new Map([[analysisSearch(INITIAL_FEN, [], true).key!, threatLines]]));
  await h.render(
    <TreeStateContext.Provider value={tree}>
      <DetachedEval placement="tabs" />
    </TreeStateContext.Provider>,
  );
  expect(h.host.textContent).toContain(THREAT_LINE);
  await act(async () => tree.getState().makeMoves({ payload: ["e4", "d5", "Bb5+"] }));
  expect(h.host.textContent).toContain("—");
  expect(h.host.textContent).not.toContain(THREAT_LINE);
  expect(h.host.textContent).not.toContain("0.34");
  expect(h.host.textContent).not.toContain("Board.Analysis.EngineFailed");
  expect(h.host.querySelector("[inert]")).toBeNull();
  await act(async () => tree.getState().goToStart());
  expect(h.host.textContent).toContain(THREAT_LINE);
  expect(h.store.get(threatFamily("display-tab"))).toBe(true);
  tree.dispose();
});
test("DetachedEval uses the shared dimmed fallback and replaces it with current lines", async () => {
  h = engineDisplayHarness();
  const tree = createTreeStore();
  expect((await h.store.set(enginesAtom, [displayEngine])).saved).toBe(true);
  h.store.set(currentDetachedEngineAtom, displayEngine.id);
  await h.remember();
  await h.render(
    <TreeStateContext.Provider value={tree}>
      <DetachedEval placement="tabs" />
    </TreeStateContext.Provider>,
  );
  expect(h.host.textContent).toContain(LINE);
  await act(async () => tree.getState().makeMoves({ payload: ["d4"] }));
  expect(h.host.querySelector("[inert]")?.textContent).toContain(LINE);
  const dimmedMove = [...h.host.querySelectorAll("[inert] button")].find(
    (button) => button.textContent === "e4",
  );
  await act(async () => (dimmedMove as HTMLButtonElement).click());
  expect(tree.getState().currentNode().san).toBe("d4");
  await h.remember([{ ...displayLines[0], sanMoves: ["d5"], uciMoves: ["d7d5"] }], ["d2d4"]);
  expect(h.host.querySelector("[inert]")).toBeNull();
  expect(h.host.textContent).toContain("d5");
  tree.dispose();
});

test.each([false, true])(
  "P2 DetachedEval shows failure with historical evaluation, partial lines %s",
  async (partial) => {
    h = engineDisplayHarness();
    const tree = createTreeStore();
    expect((await h.store.set(enginesAtom, [displayEngine])).saved).toBe(true);
    h.store.set(currentDetachedEngineAtom, displayEngine.id);
    if (partial) await h.remember();
    await h.render(
      <TreeStateContext.Provider value={tree}>
        <DetachedEval placement="tabs" />
      </TreeStateContext.Provider>,
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
    expect(h.host.querySelector("[inert]")?.textContent).toBe(partial ? `+0.34${LINE}` : undefined);
    tree.dispose();
  },
);

const threeLines = [
  displayLines[0],
  {
    ...displayLines[0],
    multipv: 2,
    score: { value: { type: "cp" as const, value: 20 }, wdl: null },
    sanMoves: ["d4", "d5"],
    uciMoves: ["d2d4", "d7d5"],
  },
  {
    ...displayLines[0],
    multipv: 3,
    score: { value: { type: "cp" as const, value: 10 }, wdl: null },
    sanMoves: ["c4", "e5"],
    uciMoves: ["c2c4", "e7e5"],
  },
];

async function renderPinned(multiPv: string | null, lines = threeLines) {
  installResizeObserverStub();
  h = engineDisplayHarness();
  const tree = createTreeStore();
  expect((await h.store.set(enginesAtom, [displayEngine])).saved).toBe(true);
  h.store.set(currentDetachedEngineAtom, displayEngine.id);
  if (multiPv !== null)
    h.store.set(h.settingsAtom, (s) => ({
      ...s,
      settings: [{ type: "string", name: "MultiPV", value: multiPv }],
    }));
  await h.remember(lines);
  await h.render(
    <TreeStateContext.Provider value={tree}>
      <DetachedEval placement="tabs" />
    </TreeStateContext.Provider>,
  );
  return tree;
}

const lineCountInput = (count: number) =>
  h.host.querySelector<HTMLInputElement>(`input[type="radio"][value="${count}"]`);

test("DetachedEval displays the pinned engine's shared WDL preference", async () => {
  const tree = await renderPinned(null, [
    { ...displayLines[0], score: { ...displayLines[0].score, wdl: [450, 300, 250] } },
  ]);
  await act(async () => h.store.set(scoreTypeFamily(displayEngine.id), "wdl"));
  expect(h.host.querySelector('[aria-label="Board.Analysis.Tablebase.WhiteWins"]')).not.toBeNull();
  tree.dispose();
});

test("DetachedEval toggles the engine's score preference only for current lines", async () => {
  const tree = await renderPinned(null, [
    { ...displayLines[0], score: { ...displayLines[0].score, wdl: [450, 300, 250] } },
  ]);
  const chip = () => h.host.querySelector<HTMLElement>(`.${scoreBubbleClasses.bubble}`)!;
  expect(chip().textContent).toBe("+0.34");
  await act(async () => chip().click());
  expect(h.store.get(scoreTypeFamily(displayEngine.id))).toBe("wdl");
  await act(async () => tree.getState().makeMoves({ payload: ["d4"] }));
  expect(chip().closest("[inert]")).not.toBeNull();
  await act(async () => chip().click());
  expect(h.store.get(scoreTypeFamily(displayEngine.id))).toBe("wdl");
  tree.dispose();
});

test("DetachedEval shows every computed line until a cap is chosen, and never more than computed", async () => {
  const tree = await renderPinned("3");
  for (const text of [LINE, "1.d4d5", "1.c4e5"]) expect(h.host.textContent).toContain(text);
  expect(lineCountInput(3)?.checked).toBe(true);
  expect([4, 5].map((count) => lineCountInput(count)?.disabled)).toEqual([true, true]);

  await act(async () => lineCountInput(2)!.click());
  expect(h.store.get(detachedEngineLinesAtom)).toBe(2);
  expect(localStorage.getItem("detached-engine-lines")).toBe("2");
  expect(h.host.textContent).toContain("1.d4d5");
  expect(h.host.textContent).not.toContain("1.c4e5");

  await act(async () => h.store.set(detachedEngineLinesAtom, 5));
  expect(h.host.textContent).toContain("1.c4e5");
  expect(lineCountInput(3)?.checked).toBe(true);
  tree.dispose();
});

test("DetachedEval hides the line selector when the engine computes one line", async () => {
  const tree = await renderPinned(null, [displayLines[0]]);
  expect(h.host.textContent).toContain(LINE);
  expect(lineCountInput(1)).toBeNull();
  tree.dispose();
});

test("DetachedEval numbers moves from the current position and plays a clicked line", async () => {
  const tree = await renderPinned("2");
  await act(async () => tree.getState().makeMoves({ payload: ["e4"] }));
  await h.remember(
    [{ ...displayLines[0], sanMoves: ["e5", "Nf3"], uciMoves: ["e7e5", "g1f3"] }],
    ["e2e4"],
  );
  expect(h.host.textContent).toContain("1...e52.♘f3");

  const knight = [...h.host.querySelectorAll("button")].find((b) => b.textContent === "♘f3");
  await act(async () => knight!.click());
  expect(tree.getState().currentNode().san).toBe("Nf3");
  expect(tree.getState().currentNode().halfMoves).toBe(3);
  tree.dispose();
});

const hover = (element: Element) =>
  act(async () => {
    element.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  });
const unhover = (element: Element) =>
  act(async () => {
    element.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
  });
const moveButton = (san: string, root: ParentNode = h.host) =>
  [...root.querySelectorAll("button")].find((b) => b.textContent === san)!;
const previewFen = () =>
  document
    .querySelector("[data-testid=engine-line-preview] [data-preview-fen]")
    ?.getAttribute("data-preview-fen");

test("DetachedEval header shows the best line's depth and advantage symbol", async () => {
  const tree = await renderPinned("3");
  expect(h.host.textContent).toContain("GoMode.Depth20");
  const symbol = h.host.querySelector("[data-testid=assessment-symbol]");
  expect(symbol?.textContent).toBe("⩲");
  expect(symbol?.getAttribute("aria-label")).toBe("Annotate.WhiteEdge");
  tree.dispose();
});

test("DetachedEval previews the position after a hovered move, and not on dimmed lines", async () => {
  const tree = await renderPinned("3");
  await hover(moveButton("e5"));
  expect(previewFen()).toBe("rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2");
  await unhover(moveButton("e5"));
  expect(previewFen()).toBeUndefined();

  await act(async () => tree.getState().makeMoves({ payload: ["d4"] }));
  const dimmed = h.host.querySelector("[inert]")!;
  await hover(moveButton("e5", dimmed));
  expect(previewFen()).toBeUndefined();
  tree.dispose();
});

test("DetachedEval shows no preview board when previews on hover are turned off", async () => {
  const tree = await renderPinned("3");
  await act(async () => h.store.set(previewBoardOnHoverAtom, false));
  await hover(moveButton("e5"));
  expect(previewFen()).toBeUndefined();
  // The setting persists in localStorage; later tests expect the default.
  await act(async () => h.store.set(previewBoardOnHoverAtom, true));
  tree.dispose();
});

test("DetachedEval flips the preview above a line at the window bottom, without taking the pointer", async () => {
  const tree = await renderPinned("3");
  const line = moveButton("e5").closest(".mantine-Group-root")!;
  vi.spyOn(line, "getBoundingClientRect").mockReturnValue(
    DOMRect.fromRect({ x: 40, y: window.innerHeight - 40, width: 600, height: 40 }),
  );
  await hover(moveButton("e5"));
  const preview = document.querySelector<HTMLElement>("[data-testid=engine-line-preview]")!;
  expect(preview.style.top).toBe(`${window.innerHeight - 240}px`);
  expect(preview.style.left).toBe("40px");
  expect(preview.style.pointerEvents).toBe("none");
  tree.dispose();
});

test("DetachedEval renders a line only up to its first illegal move", async () => {
  const tree = await renderPinned(null, [
    { ...displayLines[0], sanMoves: ["e4", "Ke7", "Nf3"], uciMoves: ["e2e4", "e8e7", "g1f3"] },
  ]);
  expect(h.host.textContent).toContain("1.e4");
  expect(h.host.textContent).not.toContain("e7");
  expect(h.host.textContent).not.toContain("f3");
  tree.dispose();
});

const PLACEMENT_KEY = "detached-engine-placement";

async function renderBothSlots(stored: string | null) {
  if (stored === null) localStorage.removeItem(PLACEMENT_KEY);
  else localStorage.setItem(PLACEMENT_KEY, stored);
  installResizeObserverStub();
  h = engineDisplayHarness();
  const tree = createTreeStore();
  expect((await h.store.set(enginesAtom, [displayEngine])).saved).toBe(true);
  h.store.set(currentDetachedEngineAtom, displayEngine.id);
  await h.remember();
  await h.render(
    <TreeStateContext.Provider value={tree}>
      <div data-slot="tabs">
        <DetachedEval placement="tabs" />
      </div>
      <div data-slot="notation">
        <DetachedEval placement="notation" />
      </div>
    </TreeStateContext.Provider>,
  );
  return tree;
}

const slot = (name: string) => h.host.querySelector(`[data-slot=${name}]`)!;

test.each([
  ['"notation"', "notation"],
  ['"sideways"', "tabs"],
  ["not json", "tabs"],
])("DetachedEval hydrates stored placement %s into the %s slot", async (stored, expected) => {
  try {
    const tree = await renderBothSlots(stored);
    const other = expected === "tabs" ? "notation" : "tabs";
    expect(slot(expected).textContent).toContain(LINE);
    expect(slot(other).childElementCount).toBe(0);
    tree.dispose();
  } finally {
    localStorage.removeItem(PLACEMENT_KEY);
  }
});

test("DetachedEval renders in the stored slot only, and its swap button moves it and persists", async () => {
  try {
    const tree = await renderBothSlots(null);
    const swap = (label: string) =>
      slot(label === "Engine.MoveAboveNotation" ? "tabs" : "notation").querySelector<HTMLElement>(
        `[aria-label="${label}"]`,
      );

    expect(h.store.get(detachedEnginePlacementAtom)).toBe("tabs");
    expect(slot("tabs").textContent).toContain(LINE);
    expect(slot("notation").childElementCount).toBe(0);

    await act(async () => swap("Engine.MoveAboveNotation")!.click());
    expect(localStorage.getItem(PLACEMENT_KEY)).toBe('"notation"');
    expect(slot("tabs").childElementCount).toBe(0);
    expect(slot("notation").textContent).toContain(LINE);
    expect(document.activeElement).toBe(swap("Engine.MoveAboveTabs"));

    await act(async () => swap("Engine.MoveAboveTabs")!.click());
    expect(h.store.get(detachedEnginePlacementAtom)).toBe("tabs");
    expect(slot("tabs").textContent).toContain(LINE);
    expect(slot("notation").childElementCount).toBe(0);
    tree.dispose();
  } finally {
    localStorage.removeItem(PLACEMENT_KEY);
  }
});

test("DetachedEval swap focus does not leak into a later mount when the other slot is absent", async () => {
  try {
    localStorage.removeItem(PLACEMENT_KEY);
    installResizeObserverStub();
    h = engineDisplayHarness();
    const tree = createTreeStore();
    expect((await h.store.set(enginesAtom, [displayEngine])).saved).toBe(true);
    h.store.set(currentDetachedEngineAtom, displayEngine.id);
    await h.remember();
    // Board editing renders no notation slot, so a swap to it mounts nothing.
    await h.render(
      <TreeStateContext.Provider value={tree}>
        <DetachedEval placement="tabs" />
      </TreeStateContext.Provider>,
    );
    const swap = () => h.host.querySelector<HTMLElement>('[aria-label="Engine.MoveAboveNotation"]');
    await act(async () => swap()!.click());
    expect(h.host.textContent).not.toContain(LINE);
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    await act(async () => h.store.set(detachedEnginePlacementAtom, "tabs"));
    expect(h.host.textContent).toContain(LINE);
    expect(document.activeElement).not.toBe(swap());
    tree.dispose();
  } finally {
    localStorage.removeItem(PLACEMENT_KEY);
  }
});
