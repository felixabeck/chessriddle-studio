import { MantineProvider } from "@mantine/core";
import { Provider, createStore } from "jotai";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import { buildFromTree, updateCardPerformance } from "@/components/files/opening";
import {
  activeTabAtom,
  autoSaveAtom,
  deckAtomFamily,
  practiceMoveControllerFamily,
  practiceGradingAtom,
  practiceNewPerSessionAtom,
  practiceCompletedSummaryFamily,
  practiceStateFamily,
  practiceSessionStatsFamily,
  tabsAtom,
} from "@/state/atoms";
import { PRACTICE_SYNC_DEBOUNCE_MS, resetPracticeMigrationForTests } from "@/state/practiceStorage";
import { createTreeStore, type TreeStore } from "@/state/store/tree";
import { WorkspaceTabScope } from "@/state/tabScope";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { focusedDialogButton, press } from "@/tests/keyboard";
import { defaultTree, getNodeAtPath } from "@/utils/treeReducer";
import { fileWorkspaceKey } from "@/utils/pathCapabilities";
import { getTabFile } from "@/utils/tabs";
import PracticePanel from "./PracticePanel";
import { PRACTICE_REPLAY_STEP_MS } from "./session";

const mocks = vi.hoisted(() => ({
  native: {
    loadPracticeDeck: vi.fn(),
    recordPracticeReview: vi.fn(),
    syncPracticePositions: vi.fn(),
    loadPracticeReviews: vi.fn(),
    listPracticeDecks: vi.fn(),
  },
}));
vi.mock("@/platform/tauri", async (original) => {
  const actual = await original<typeof import("@/platform/tauri")>();
  return {
    ...actual,
    tauri: new Proxy(actual.tauri, {
      get(target, key, receiver) {
        return key in mocks.native
          ? mocks.native[key as keyof typeof mocks.native]
          : Reflect.get(target, key, receiver);
      },
    }),
  };
});
vi.mock("@/utils/sound", () => ({ playSound: vi.fn() }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: unknown) => (options ? key + " " + JSON.stringify(options) : key),
  }),
}));
vi.mock("./RepertoireInfo", () => ({ default: () => null }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
installMatchMediaStub();
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);
const standard = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const cases = [
  {
    name: "White",
    fen: standard,
    orientation: "white" as const,
    moves: ["e4", "e5", "Nf3"],
    wrong: "Nc3",
    label: "1... e5",
  },
  {
    name: "Black",
    fen: standard,
    orientation: "black" as const,
    moves: ["e4", "c5"],
    wrong: "e5",
    label: "1. e4",
  },
  {
    name: "custom White",
    fen: standard.replace("0 1", "0 12"),
    orientation: "white" as const,
    moves: ["e4", "e5", "Nf3"],
    wrong: "Nc3",
    label: "12... e5",
  },
  {
    name: "custom Black",
    fen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 12",
    orientation: "black" as const,
    moves: ["c5", "Nf3", "d6"],
    wrong: "e5",
    label: "13. Nf3",
  },
];
let host: HTMLDivElement;
let root: Root;
let tree: TreeStore;
let atoms: ReturnType<typeof createStore>;
let owner: import("@/state/workspaceTypes").Tab;
let reviews: { id: string; entry: string }[];
let mounted = false;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-21T12:00:00Z"));
  sessionStorage.clear();
  localStorage.clear();
  resetPracticeMigrationForTests();
  reviews = [];
  mocks.native.listPracticeDecks.mockResolvedValue({ decks: [], anomalies: [] });
  mocks.native.syncPracticePositions.mockImplementation(
    async (_file, _game, _generation, revision) => revision + 1,
  );
  mocks.native.recordPracticeReview.mockImplementation(async (_file, _game, _epoch, write) => {
    reviews.push({ id: write.entryId, entry: write.entry });
    return write.revision + 1;
  });
  mocks.native.loadPracticeReviews.mockImplementation(async () => ({
    entries: reviews,
    nextCursor: null,
  }));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  mounted = true;
});
afterEach(async () => {
  if (mounted) await act(async () => root.unmount());
  tree?.dispose();
  host.remove();
  vi.useRealTimers();
  sessionStorage.clear();
  localStorage.clear();
});

async function mountStudy(
  spec = cases[0],
  variation?: string[],
  full = false,
  options: {
    reviewedDue?: Date;
    reviewedDues?: Date[];
    startPractice?: boolean;
    start?: number[];
    unseen?: boolean;
    grading?: "auto" | "manual";
    settle?: boolean;
    comment?: string;
    newLimit?: number;
  } = {},
) {
  tree = createTreeStore(undefined, defaultTree(spec.fen));
  for (const payload of variation ? [spec.moves, variation] : [spec.moves]) {
    tree.getState().goToStart();
    expect(tree.getState().makeMoves({ payload }).success).toBe(true);
  }
  if (options.comment) tree.getState().setComment(options.comment);
  tree.getState().setHeaders({
    ...tree.getState().headers,
    orientation: spec.orientation,
    start: options.start,
  });
  tree.getState().goToMove([]);
  tree.getState().save("a".repeat(64));
  const cards = buildFromTree(tree.getState().root, spec.orientation, options.start || []);
  expect(cards.length).toBeGreaterThan(0);
  if (!options.unseen)
    for (const card of cards)
      card.card = { ...card.card, reps: 1, due: new Date(Date.now() - 1_000) };
  if (options.reviewedDue) {
    cards[0].card = { ...cards[0].card, reps: 1, due: options.reviewedDue };
  }
  options.reviewedDues?.forEach((due, index) => {
    cards[index].card = { ...cards[index].card, reps: 1, due };
  });
  mocks.native.loadPracticeDeck.mockResolvedValue({
    epoch: "no-map",
    deck: {
      positionsDocument: JSON.stringify({ positions: cards }),
      revision: 1,
      generation: 0,
      migrated: false,
      unappliedReviews: 0,
      orphansAcknowledged: true,
    },
  });
  atoms = createStore();
  atoms.set(practiceGradingAtom, options.grading ?? "auto");
  atoms.set(practiceNewPerSessionAtom, options.newLimit ?? 10);
  owner = {
    name: "Practice",
    value: crypto.randomUUID(),
    type: "analysis",
    gameOrigin: {
      kind: "file",
      gameNumber: 0,
      file: {
        type: "file",
        handle: { id: { id: crypto.randomUUID() }, kind: "fileWorkspace" },
        name: "Practice",
        numGames: 1,
        metadata: { type: "repertoire", tags: [] },
        lastModified: 1,
      },
    },
  };
  atoms.set(tabsAtom, [owner], owner.value);
  atoms.set(activeTabAtom, owner.value);
  atoms.set(autoSaveAtom, false);
  await act(async () =>
    root.render(
      <MantineProvider env="test">
        <Provider store={atoms}>
          <WorkspaceTabScope tabId={owner.value}>
            <TreeStateContext.Provider value={tree}>
              <PracticePanel />
            </TreeStateContext.Provider>
          </WorkspaceTabScope>
        </Provider>
      </MantineProvider>,
    ),
  );
  if (options.startPractice !== false) {
    await click(full ? "Board.Practice.PracticeFullRepertoire" : "Board.Practice.StartPractice");
  }
  if (options.startPractice !== false && options.settle !== false) await settleReplay();
  expect(phase()).toBe(
    options.startPractice === false
      ? "idle"
      : options.settle === false
        ? "replaying"
        : options.unseen && !full
          ? "learning"
          : "waiting",
  );
  return cards[0];
}
async function click(label: string) {
  const button = [...document.querySelectorAll<HTMLButtonElement>('button, [role="button"]')].find(
    (value) => (value.getAttribute("aria-label") ?? value.textContent)?.includes(label),
  );
  expect(button).toBeDefined();
  await act(async () => button!.click());
}

test("Show All marks a reviewed card hydrated with a past ISO due as Due", async () => {
  const due = new Date(Date.now() - 1_000);
  await mountStudy(cases[0], undefined, false, { reviewedDue: due, startPractice: false });
  const hydrated = atoms.get(
    deckAtomFamily({ file: fileWorkspaceKey(getTabFile(owner)!.handle), game: 0 }),
  );
  expect(hydrated.positions[0].card.due).toBe(due.toISOString());

  await click("Board.Practice.ShowAll");

  const badge = document.querySelector('[role="dialog"] .mantine-Badge-root');
  expect(badge?.textContent).toBe("Board.Practice.Due");
});

test.each([
  { name: "near future", delay: 1_000 },
  { name: "beyond the maximum timer delay", delay: 2_147_484_647 },
])("idle practice becomes available at a due boundary in the $name", async ({ delay }) => {
  const due = new Date(Date.now() + delay);
  await mountStudy(cases[0], undefined, false, { reviewedDue: due, startPractice: false });
  expect(host.textContent).toContain("Board.Practice.PracticedAll1");
  expect(host.textContent).not.toContain("Board.Practice.StartPractice");

  const firstDelay = Math.min(delay - 1, 2_147_483_647);
  await act(async () => vi.advanceTimersByTimeAsync(firstDelay));
  expect(host.textContent).toContain("Board.Practice.PracticedAll1");
  expect(host.textContent).not.toContain("Board.Practice.StartPractice");
  await act(async () => vi.advanceTimersByTimeAsync(delay - firstDelay + 1));

  expect(host.textContent).not.toContain("Board.Practice.PracticedAll1");
  const start = [...host.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("Board.Practice.StartPractice"),
  );
  expect(start).toBeDefined();
  expect(start?.disabled).toBe(false);
});

test("idle practice becomes available at the earlier of two future dues", async () => {
  await mountStudy({ ...cases[0], moves: ["e4", "e5", "Nf3", "Nc6", "Bb5"] }, undefined, false, {
    reviewedDues: [new Date(Date.now() + 5_000), new Date(Date.now() + 1_000)],
    startPractice: false,
  });
  await act(async () => vi.advanceTimersByTimeAsync(999));
  expect(host.textContent).not.toContain("Board.Practice.StartPractice");
  await act(async () => vi.advanceTimersByTimeAsync(2));
  expect(host.textContent).toContain("Board.Practice.StartPractice");
  await click("Board.Practice.StartPractice");
  await settleReplay();
  expect(tree.getState().currentNode().children[0].san).toBe("Bb5");
});

test("adding an earlier reviewed card re-arms the idle practice due timer", async () => {
  const card = await mountStudy(cases[0], undefined, false, {
    reviewedDue: new Date(Date.now() + 10_000),
    startPractice: false,
  });
  const earlier = {
    ...card,
    fen: tree.getState().root.fen,
    answer: "e4",
    card: { ...card.card, due: new Date(Date.now() + 1_000) },
  };
  await act(async () => {
    const writing = atoms.set(
      deckAtomFamily({ file: fileWorkspaceKey(getTabFile(owner)!.handle), game: 0 }),
      { type: "sync", positions: [card, earlier] },
    );
    await vi.advanceTimersByTimeAsync(PRACTICE_SYNC_DEBOUNCE_MS);
    await writing;
  });
  expect(host.textContent).not.toContain("Board.Practice.StartPractice");
  await act(async () => vi.advanceTimersByTimeAsync(1_001 - PRACTICE_SYNC_DEBOUNCE_MS));
  expect(host.textContent).toContain("Board.Practice.StartPractice");
  await click("Board.Practice.StartPractice");
  expect(tree.getState().position).toEqual([]);
});

function phase() {
  return atoms.get(practiceStateFamily(owner.value)).phase;
}
function stats() {
  return atoms.get(practiceSessionStatsFamily(owner.value));
}
function controller() {
  return atoms.get(practiceMoveControllerFamily(owner.value));
}
async function tick(ms: number) {
  await act(async () => vi.advanceTimersByTimeAsync(ms));
}
async function settleReplay() {
  for (let step = 0; phase() === "replaying" && step < 40; step++)
    await tick(PRACTICE_REPLAY_STEP_MS);
  expect(phase()).not.toBe("replaying");
}
async function answer(san: string) {
  await act(async () => controller()!.submitMove(san));
}

test("replay visits every intermediate ply, locks input and starts timing only on arrival", async () => {
  await mountStudy(cases[0], undefined, false, { settle: false });
  expect(phase()).toBe("replaying");
  expect(tree.getState().position).toEqual([]);
  expect(controller()?.canMove).toBe(false);
  await answer("Nf3");
  expect(reviews).toHaveLength(0);
  expect(tree.getState().position).toEqual([]);
  await tick(449);
  expect(tree.getState().position).toEqual([]);
  await tick(1);
  expect(tree.getState().position).toEqual([0]);
  expect(phase()).toBe("replaying");
  await tick(450);
  expect(tree.getState().position).toEqual([0, 0]);
  expect(phase()).toBe("waiting");
  expect(controller()?.canMove).toBe(true);
});

test.each(["stop", "unmount", "tab switch", "owner replacement", "file replacement"] as const)(
  "%s cancels replay and prevents later navigation",
  async (exit) => {
    await mountStudy(cases[0], undefined, false, { settle: false });
    await tick(450);
    if (exit === "stop") await click("Common.Stop");
    else
      await act(async () => {
        if (exit === "unmount") {
          root.unmount();
          mounted = false;
        }
        if (exit === "tab switch") {
          const other = { ...owner, value: crypto.randomUUID(), treeKey: crypto.randomUUID() };
          atoms.set(tabsAtom, [owner, other], owner.value);
          atoms.set(activeTabAtom, other.value);
        }
        if (exit === "owner replacement")
          atoms.set(tabsAtom, [{ ...owner, treeKey: crypto.randomUUID() }], owner.value);
        if (exit === "file replacement") {
          if (owner.gameOrigin.kind !== "file") throw new Error("Expected file owner");
          atoms.set(
            tabsAtom,
            [
              {
                ...owner,
                gameOrigin: {
                  ...owner.gameOrigin,
                  file: {
                    ...owner.gameOrigin.file,
                    handle: { id: { id: crypto.randomUUID() }, kind: "fileWorkspace" },
                  },
                },
              },
            ],
            owner.value,
          );
        }
      });
    expect(phase()).toBe("idle");
    expect(controller()).toBeNull();
    const position = tree.getState().position;
    await tick(10_000);
    expect(tree.getState().position).toBe(position);
    expect(tree.getState().practicePath).toBeNull();
    expect(phase()).toBe("idle");
    expect(vi.getTimerCount()).toBe(0);
  },
);

test("a surviving tree edit restarts replay and reaches its live frame", async () => {
  await mountStudy(cases[0], undefined, false, { settle: false });
  await tick(450);
  await act(async () => tree.getState().setComment("Replay context"));
  expect(phase()).toBe("replaying");
  await tick(450);
  expect(tree.getState().position).toEqual([0, 0]);
  expect(phase()).toBe("waiting");
  await tick(1_000);
  expect(tree.getState().position).toEqual([0, 0]);
});

test.each([false, true])(
  "the next card keeps its replay timer after an answer, full=%s",
  async (full) => {
    await mountStudy({ ...cases[0], moves: ["e4", "e5", "Nf3", "Nc6", "Bb5"] }, undefined, full);
    await answer("Nf3");
    await tick(300);
    expect(phase()).toBe("replaying");
    expect(tree.getState().position).toEqual([0, 0, 0]);
    expect(controller()?.canMove).toBe(false);
    await tick(449);
    expect(tree.getState().position).toEqual([0, 0, 0]);
    await tick(1);
    expect(tree.getState().position).toEqual([0, 0, 0, 0]);
    expect(phase()).toBe("waiting");
    expect(controller()?.canMove).toBe(true);
  },
);

test("removing a replayed card drops it and reaches the next branch", async () => {
  await mountStudy(cases[0], ["d4", "d5", "c4"], true, { settle: false });
  await tick(450);
  await act(async () => tree.getState().deleteMove([0, 0, 0]));
  await settleReplay();
  expect(tree.getState().position).toEqual([1, 0]);
  expect(tree.getState().currentNode().children[0].san).toBe("c4");
  expect(stats().remainingPositionKeys).toHaveLength(1);
});

test.each([
  { delay: 10_000, grade: 3 },
  { delay: 10_001, grade: 2 },
])("automatic grading writes grade $grade once after $delay ms", async ({ delay, grade }) => {
  const card = await mountStudy();
  await tick(delay);
  await answer(card.answer);
  await answer(card.answer);
  expect(phase()).toBe("correct");
  expect(host.textContent).not.toContain("Board.Practice.HowDifficult");
  expect(reviews).toHaveLength(1);
  expect(JSON.parse(reviews[0].entry)).toMatchObject({ fen: card.fen, rating: grade });
  await tick(300);
  expect(phase()).toBe("idle");
  expect(atoms.get(practiceCompletedSummaryFamily(owner.value))).toMatchObject({
    correct: 1,
    incorrect: 0,
    bestStreak: 1,
  });
});

test.each([1, 2, 3, 4] as const)(
  "manual grade %s waits and respects dialog keyboard ownership",
  async (grade) => {
    const card = await mountStudy(cases[0], undefined, false, { grading: "manual" });
    await answer(card.answer);
    expect(phase()).toBe("correct");
    expect(host.textContent).toContain("Board.Practice.HowDifficult");
    await tick(5_000);
    expect(reviews).toHaveLength(0);
    const { dialog, button } = focusedDialogButton(host);
    await act(async () => {
      press(String(grade), { target: button });
    });
    expect(reviews).toHaveLength(0);
    dialog.remove();
    await act(async () => {
      press(String(grade));
    });
    expect(reviews).toHaveLength(1);
    expect(JSON.parse(reviews[0].entry).rating).toBe(grade);
    expect(phase()).toBe("idle");
  },
);

test.each(cases)(
  "first wrong $name answer rates Again once and the second reveals the hint",
  async (spec) => {
    const card = await mountStudy(spec, undefined, false, { grading: "manual" });
    const source = tree.getState();
    await answer(spec.wrong);
    expect(phase()).toBe("retry");
    expect(controller()?.hintSan).toBeUndefined();
    expect(tree.getState().position).toBe(source.position);
    expect(reviews).toHaveLength(1);
    expect(JSON.parse(reviews[0].entry)).toMatchObject({ fen: card.fen, rating: 1 });
    expect(stats()).toMatchObject({ correct: 0, incorrect: 1 });
    await answer(spec.wrong);
    expect(phase()).toBe("revealed");
    expect(controller()?.hintSan).toBe(card.answer);
    await answer(spec.wrong);
    expect(reviews).toHaveLength(1);
    expect(tree.getState().position).toBe(source.position);
    await answer(card.answer);
    expect(phase()).toBe("correct");
    expect(controller()?.hintSan).toBeUndefined();
    expect(host.textContent).not.toContain("Board.Practice.HowDifficult");
    expect(tree.getState().root).toBe(source.root);
    expect(tree.getState().dirty).toBe(false);
    await tick(300);
    await settleReplay();
    expect(phase()).toBe("waiting");
    expect(stats().remainingPositionKeys).toHaveLength(1);
    await answer(card.answer);
    await click("Board.Practice.Good");
    expect(phase()).toBe("idle");
    expect(reviews).toHaveLength(2);
    expect(atoms.get(practiceCompletedSummaryFamily(owner.value))).toMatchObject({
      correct: 1,
      incorrect: 1,
    });
  },
);

test("the right answer on retry has no manual prompt and advances without another rating", async () => {
  const card = await mountStudy(cases[0], undefined, false, { grading: "manual" });
  await answer("Nc3");
  await answer(card.answer);
  expect(phase()).toBe("correct");
  expect(host.textContent).not.toContain("Board.Practice.HowDifficult");
  await tick(300);
  await settleReplay();
  expect(phase()).toBe("waiting");
  expect(reviews).toHaveLength(1);
});

test("full mode retries and advances without persisting a rating or repeating cards", async () => {
  const card = await mountStudy(cases[0], undefined, true, { unseen: true, grading: "manual" });
  expect(phase()).toBe("waiting");
  await answer("Nc3");
  expect(phase()).toBe("retry");
  await answer(card.answer);
  expect(phase()).toBe("correct");
  await tick(300);
  expect(phase()).toBe("idle");
  expect(reviews).toHaveLength(0);
});

test("repertoire alternatives keep the quiz phase and persist nothing", async () => {
  await mountStudy(cases[0], ["e4", "e5", "Bc4"]);
  await answer("Bc4");
  expect(phase()).toBe("waiting");
  expect(host.textContent).toContain("Board.Practice.Alternative");
  expect(stats()).toMatchObject({ correct: 0, incorrect: 0 });
  expect(reviews).toHaveLength(0);
  await answer("Nc3");
  await answer("Bc4");
  expect(phase()).toBe("retry");
  expect(reviews).toHaveLength(1);
  expect(stats().incorrect).toBe(1);
});

test("learning publishes the hint, refuses other moves and repeats the card as an unrated quiz", async () => {
  const card = await mountStudy(cases[0], undefined, false, { unseen: true });
  expect(phase()).toBe("learning");
  expect(controller()?.hintSan).toBe(card.answer);
  await answer("Nc3");
  expect(phase()).toBe("learning");
  expect(reviews).toHaveLength(0);
  await answer(card.answer);
  expect(phase()).toBe("advancing");
  expect(controller()?.hintSan).toBeUndefined();
  expect(stats()).toMatchObject({ correct: 0, incorrect: 0 });
  await tick(300);
  await settleReplay();
  expect(phase()).toBe("waiting");
  expect(controller()?.hintSan).toBeUndefined();
  expect(reviews).toHaveLength(0);
  await answer(card.answer);
  await tick(300);
  expect(phase()).toBe("idle");
  expect(reviews).toHaveLength(1);
});

test.each([false, true])("comments stay visible until Continue, unseen=%s", async (unseen) => {
  const card = await mountStudy(cases[0], undefined, false, {
    unseen,
    comment: "**Develop** the knight",
  });
  expect(phase()).toBe(unseen ? "learning" : "waiting");
  expect(host.querySelector("strong")?.textContent).toBe(unseen ? "Develop" : undefined);
  await answer(card.answer);
  expect(host.textContent).toContain("Develop the knight");
  expect(host.querySelector("strong")?.textContent).toBe("Develop");
  const position = tree.getState().position;
  await tick(5_000);
  expect(tree.getState().position).toBe(position);
  expect(phase()).toBe(unseen ? "advancing" : "correct");
  await click("Board.Practice.Continue");
  expect(phase()).toBe(unseen ? "waiting" : "idle");
});

test("Space reveals and plays the move, and respects blocking dialogs", async () => {
  await mountStudy();
  await answer("Nc3");
  const { dialog, button } = focusedDialogButton(host);
  await act(async () => {
    press("Space", { target: button });
  });
  expect(phase()).toBe("retry");
  dialog.remove();
  await act(async () => {
    press("Space");
  });
  expect(phase()).toBe("revealed");
  expect(controller()?.hintSan).toBe("Nf3");
  await act(async () => {
    press("Space");
  });
  expect(phase()).toBe("correct");
  expect(reviews).toHaveLength(1);
});

test("a refused rating ends the session and keeps the write-blocked alert", async () => {
  const card = await mountStudy();
  mocks.native.recordPracticeReview.mockRejectedValueOnce(new Error("Review refused"));
  await answer(card.answer);
  expect(phase()).toBe("idle");
  expect(controller()).toBeNull();
  expect(host.textContent).toContain("Board.Practice.WriteBlocked");
  await tick(5_000);
  expect(mocks.native.recordPracticeReview).toHaveBeenCalledOnce();
  const start = [...host.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("Board.Practice.StartPractice"),
  );
  expect(start?.disabled).toBe(true);
  const full = [...host.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("Board.Practice.PracticeFullRepertoire"),
  );
  expect(full?.disabled).toBe(true);
});

test("session line replaces idle figures and Stop keeps the answered summary", async () => {
  await mountStudy();
  expect(host.textContent).toContain("Board.Practice.SessionLine");
  expect(host.textContent).toContain('"remaining":1,"correct":0,"incorrect":0');
  expect(host.textContent).not.toContain("Board.Practice.LearnedProgress");
  expect(host.querySelectorAll(".mantine-Progress-root")).toHaveLength(0);
  await answer("Nc3");
  await click("Common.Stop");
  expect(host.textContent).not.toContain("Board.Practice.SessionLine");
  expect(host.textContent).toContain("Board.Practice.Explanation");
  expect(host.textContent).toContain("Board.Practice.LearnedProgress");
  expect(host.textContent).toContain("Board.Practice.SessionSummary");
  expect(host.textContent).toContain('"correct":0,"incorrect":1,"accuracy":0,"bestStreak":0');
  expect(atoms.get(practiceCompletedSummaryFamily(owner.value))).toMatchObject({
    correct: 0,
    incorrect: 1,
    bestStreak: 0,
  });
});

test("new-move limit zero offers reviews only and never introduces an unseen card", async () => {
  await mountStudy(cases[0], undefined, false, { unseen: true, newLimit: 0, startPractice: false });
  expect(host.textContent).toContain("Board.Practice.PracticedAll1");
  expect(host.textContent).not.toContain("Board.Practice.StartPractice");
});

test("the sync notice dismisses after five seconds and clears its timer on unmount", async () => {
  await mountStudy(cases[0], undefined, false, { startPractice: false });
  await act(async () => {
    tree.getState().goToMove([0, 0, 0]);
    tree.getState().makeMoves({ payload: ["Nc6", "Bb5"] });
  });
  expect(host.textContent).toContain("Board.Practice.DeckSynced");
  await tick(4999);
  expect(host.textContent).toContain("Board.Practice.DeckSynced");
  await tick(1);
  expect(host.textContent).not.toContain("Board.Practice.DeckSynced");
  await act(async () => {
    tree.getState().makeMoves({ payload: ["a6", "Ba4"] });
  });
  expect(host.textContent).toContain("Board.Practice.DeckSynced");
  await tick(300);
  await act(async () => {
    root.unmount();
    mounted = false;
  });
  expect(vi.getTimerCount()).toBe(0);
});

test("Start scope and Black-to-move starts preserve the actual card frame", async () => {
  const card = await mountStudy(cases[3], undefined, false, { start: [0, 0] });
  expect(tree.getState().position).toEqual([0, 0]);
  expect(card.answer).toBe("d6");
  expect(phase()).toBe("waiting");
  await answer(card.answer);
  expect(tree.getState().currentNode().san).toBe("d6");
});

test("actual log writer keeps distinct repeated-FEN IDs and historical fallbacks", async () => {
  const card = await mountStudy();
  const written = [
    updateCardPerformance([card], 0, card.card, 3)!,
    updateCardPerformance([card], 0, card.card, 1)!,
  ];
  expect(written[0].entryId).not.toBe(written[1].entryId);
  reviews = [
    ...written.map((value) => ({ id: value.entryId, entry: JSON.stringify(value.entry) })),
    { id: "root", entry: JSON.stringify({ ...written[0].entry, fen: tree.getState().root.fen }) },
    {
      id: "missing",
      entry: JSON.stringify({ ...written[0].entry, fen: "Historical off-repertoire FEN" }),
    },
  ];
  await click("Board.Practice.ShowLogs");
  const nodes = [...document.querySelectorAll("[data-practice-entry-id]")];
  expect(nodes.map((node) => node.getAttribute("data-practice-entry-id"))).toEqual(
    reviews.map((entry) => entry.id),
  );
  expect(nodes.map((node) => node.firstElementChild?.textContent)).toEqual([
    "1... e5",
    "1... e5",
    standard,
    "Historical off-repertoire FEN",
  ]);
  expect(getNodeAtPath(tree.getState().root, tree.getState().position).fen).toBe(card.fen);
});
