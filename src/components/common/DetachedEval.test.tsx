import { act } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { createTreeStore } from "@/state/store/tree";
import {
  currentDetachedEngineAtom,
  detachedEngineLinesAtom,
  enginesAtom,
  engineTerminalFamily,
  threatFamily,
} from "@/state/atoms";
import { INITIAL_FEN } from "chessops/fen";
import { engineIdentity, engineLineContext } from "../panels/analysis/analysisLineContext";
import { displayEngine, displayLines, engineDisplayHarness } from "@/tests/engineDisplay";
import { installResizeObserverStub } from "@/tests/resizeObserver";
import { TreeStateContext } from "./TreeStateContext";
import DetachedEval from "./DetachedEval";
import { analysisSearch } from "../panels/analysis/analysisSearch";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/utils/sound", () => ({ playSound: vi.fn() }));
vi.mock("@/platform/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/platform/tauri")>();
  return {
    ...actual,
    tauri: { ...actual.tauri, reconcileEngineAttachments: vi.fn().mockResolvedValue(undefined) },
  };
});
/** `displayLines[0]` (e4 e5 Nf3) as rendered from the start position, and as a threat line. */
const LINE = "1.e4e52.♘f3";
const THREAT_LINE = "1...e42.e5♘f3";

let h: ReturnType<typeof engineDisplayHarness>;
afterEach(async () => h.close());
test("DetachedEval drops historical threat PV and score in check and restores legal analysis", async () => {
  h = engineDisplayHarness();
  const tree = createTreeStore();
  await h.store.set(enginesAtom, [displayEngine]);
  h.store.set(currentDetachedEngineAtom, displayEngine.id);
  h.store.set(threatFamily("display-tab"), true);
  h.store.set(h.memoryAtom, new Map([[analysisSearch(INITIAL_FEN, [], true).key!, displayLines]]));
  await h.render(
    <TreeStateContext.Provider value={tree}>
      <DetachedEval />
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
      <DetachedEval />
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
        <DetachedEval />
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
      <DetachedEval />
    </TreeStateContext.Provider>,
  );
  return tree;
}

const lineCountInput = (count: number) =>
  h.host.querySelector<HTMLInputElement>(`input[type="radio"][value="${count}"]`);

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
