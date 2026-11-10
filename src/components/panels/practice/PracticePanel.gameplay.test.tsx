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
  practiceCardStartTimeFamily,
  tabsAtom,
} from "@/state/atoms";
import { PRACTICE_SYNC_DEBOUNCE_MS, resetPracticeMigrationForTests } from "@/state/practiceStorage";
import { createTreeStore, type TreeStore } from "@/state/store/tree";
import { WorkspaceTabScope } from "@/state/tabScope";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { focusedDialogButton, press } from "@/tests/keyboard";
import { defaultTree, getBoardState, getNodeAtPath } from "@/utils/treeReducer";
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
    reviewedDues?: (Date | undefined)[];
    startPractice?: boolean;
    start?: number[];
    unseen?: boolean;
    grading?: "auto" | "manual";
    settle?: boolean;
    comment?: string;
    comments?: { path: number[]; text: string }[];
    newLimit?: number;
    practicePath?: number[];
  } = {},
) {
  tree = createTreeStore(undefined, defaultTree(spec.fen));
  for (const payload of variation ? [spec.moves, variation] : [spec.moves]) {
    tree.getState().goToStart();
    expect(tree.getState().makeMoves({ payload }).success).toBe(true);
  }
  if (options.comment) tree.getState().setComment(options.comment);
  for (const { path, text } of options.comments ?? []) {
    tree.getState().goToMove(path);
    tree.getState().setComment(text);
  }
  tree.getState().setHeaders({
    ...tree.getState().headers,
    orientation: spec.orientation,
    start: options.start,
  });
  tree.getState().goToMove([]);
  if (options.practicePath) tree.getState().setPracticePath(options.practicePath);
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
    if (due) cards[index].card = { ...cards[index].card, reps: 1, due };
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
  await renderStudy();
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

async function renderStudy() {
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

async function mountTransposedStudy({
  comment,
  variationAnswer = "Bg7",
  variationComment = comment,
  ...options
}: {
  unseen?: boolean;
  grading?: "auto" | "manual";
  comment?: string;
  settle?: boolean;
  variationAnswer?: string;
  variationComment?: string;
} = {}) {
  await mountStudy(
    { ...cases[1], moves: ["Nf3", "Nf6", "g3", "g6", "Bg2", "Bg7"] },
    ["g3", "g6", "Nf3", "Nf6", "Bg2", variationAnswer],
    false,
    {
      ...options,
      comments: comment
        ? [0, 1].map((index) => ({
            path: [index, 0, 0, 0, 0, 0],
            text: index === 0 ? comment : (variationComment ?? comment),
          }))
        : undefined,
      reviewedDues: [
        new Date(Date.now() + 60_000),
        new Date(Date.now() + 60_000),
        options.unseen ? undefined : new Date(Date.now() - 1_000),
        new Date(Date.now() + 60_000),
        new Date(Date.now() + 60_000),
      ],
    },
  );
}

test("a retained transposed card rebinds when promotion changes its exact FEN", async () => {
  await mountTransposedStudy();
  const before = atoms.get(practiceStateFamily(owner.value));
  const queue = [...stats().remainingPositionKeys];
  expect(tree.getState().currentNode().children[0].san).toBe("Bg7");
  expect(queue).toEqual([getBoardState(before.currentFen!)]);

  await act(async () => tree.getState().promoteVariation([1]));

  expect(phase()).toBe("waiting");
  expect(stats().remainingPositionKeys).toEqual(queue);
  expect(stats()).toMatchObject({ correct: 0, incorrect: 0 });
  expect(reviews).toHaveLength(0);
  await settleReplay();
  const after = atoms.get(practiceStateFamily(owner.value));
  expect(after.currentFen).not.toBe(before.currentFen);
  expect(getBoardState(after.currentFen!)).toBe(getBoardState(before.currentFen!));
  expect(after.positionKey).toBe(before.positionKey);
  expect(tree.getState().position).toEqual([0, 0, 0, 0, 0]);
  expect(tree.getState().currentNode().fen).toBe(after.currentFen);
  expect(controller()?.canMove).toBe(true);
  await answer("Bg7");
  expect(phase()).toBe("correct");
  expect(reviews).toHaveLength(1);
});

test.each([false, true])(
  "a failed transposed presentation keeps its one rating and re-append after FEN-changing promotion, later edit=%s",
  async (editAfterRebind) => {
    await mountTransposedStudy();
    const before = atoms.get(practiceStateFamily(owner.value));
    const queue = [...stats().remainingPositionKeys];
    await answer("d5");
    expect(phase()).toBe("retry");
    expect(reviews.map(({ entry }) => JSON.parse(entry).rating)).toEqual([1]);
    expect(stats()).toMatchObject({ correct: 0, incorrect: 1 });
    const startedAt = atoms.get(practiceCardStartTimeFamily(owner.value));

    await act(async () => tree.getState().promoteVariation([1]));
    expect(phase()).toBe("retry");
    expect(atoms.get(practiceCardStartTimeFamily(owner.value))).toBe(startedAt);
    expect(stats().remainingPositionKeys).toEqual(queue);
    if (editAfterRebind) {
      await tick(PRACTICE_REPLAY_STEP_MS);
      await act(async () => tree.getState().setComment("Keep this presentation"));
    }
    expect(phase()).toBe("retry");
    expect(atoms.get(practiceCardStartTimeFamily(owner.value))).toBe(startedAt);
    await settleReplay();
    const after = atoms.get(practiceStateFamily(owner.value));
    expect(after.currentFen).not.toBe(before.currentFen);
    expect(after.positionKey).toBe(before.positionKey);
    expect(controller()?.canMove).toBe(true);
    expect(atoms.get(practiceCardStartTimeFamily(owner.value))).toBe(startedAt);
    await answer("Bg7");

    expect(reviews.map(({ entry }) => JSON.parse(entry).rating)).toEqual([1]);
    expect(stats()).toMatchObject({ correct: 0, incorrect: 1 });
    expect(after.phase).toBe("retry");
    expect(phase()).toBe("correct");
    await tick(300);
    await settleReplay();
    expect(stats().remainingPositionKeys).toEqual(queue);
    expect(stats().reappendedPositionKeys).toEqual(queue);
    expect(stats()).toMatchObject({ correct: 0, incorrect: 1 });
    expect(phase()).toBe("waiting");
    expect(atoms.get(practiceStateFamily(owner.value)).positionKey).toBe(before.positionKey);
    expect(tree.getState().currentNode().children[0].san).toBe("Bg7");
    expect(reviews.map(({ entry }) => JSON.parse(entry).rating)).toEqual([1]);
  },
);

function grades() {
  return reviews.map(({ entry }) => JSON.parse(entry).rating);
}

function expectCompletedTransposedPractice(
  correct: number,
  incorrect: number,
  expectedGrades: number[],
  cursor = [0, 0, 0, 0, 0, 0],
) {
  expect(phase()).toBe("idle");
  expect(stats().remainingPositionKeys).toEqual([]);
  expect(stats().introducedPositionKeys).toEqual([]);
  expect(stats().reappendedPositionKeys).toEqual([]);
  expect(stats()).toMatchObject({ correct: 0, incorrect: 0 });
  expect(atoms.get(practiceCompletedSummaryFamily(owner.value))).toMatchObject({
    correct,
    incorrect,
  });
  expect(grades()).toEqual(expectedGrades);
  expect(tree.getState().position).toEqual(cursor);
  expect(tree.getState().practicePath).toBeNull();
  expect(controller()).toBeNull();
}

test.each(["waiting", "retry", "revealed", "learning"] as const)(
  "promotion rebinds %s without resetting presentation progress and accepts the answer",
  async (initialPhase) => {
    await mountTransposedStudy({ unseen: initialPhase === "learning" });
    if (initialPhase === "retry" || initialPhase === "revealed") await answer("d5");
    if (initialPhase === "revealed") await answer("d5");
    const before = atoms.get(practiceStateFamily(owner.value));
    const progress = stats();
    const written = [...reviews];
    const hint = controller()?.hintSan;
    const startedAt = atoms.get(practiceCardStartTimeFamily(owner.value));
    expect(before.phase).toBe(initialPhase);
    expect(progress.introducedPositionKeys).toEqual([]);

    await act(async () => tree.getState().promoteVariation([1]));

    const rebound = atoms.get(practiceStateFamily(owner.value));
    expect(rebound).toEqual({ ...before, currentFen: tree.getState().currentNode().fen });
    expect(rebound.currentFen).not.toBe(before.currentFen);
    expect(stats()).toEqual(progress);
    expect(reviews).toEqual(written);
    expect(controller()?.hintSan).toBe(hint);
    expect(controller()?.canMove).toBe(true);
    expect(tree.getState().position).toEqual([0, 0, 0, 0, 0]);
    expect(tree.getState().practicePath).toEqual([0, 0, 0, 0, 0]);
    expect(atoms.get(practiceCardStartTimeFamily(owner.value))).toBe(startedAt);
    expect(host.textContent).not.toContain("Board.Practice.NotOnPosition");
    await answer("Bg7");
    expect(phase()).toBe(initialPhase === "learning" ? "advancing" : "correct");
    expect(controller()?.hintSan).toBeUndefined();
    expect(tree.getState().position).toEqual([0, 0, 0, 0, 0, 0]);
    expect(stats().introducedPositionKeys).toEqual(
      initialPhase === "learning" ? progress.remainingPositionKeys : [],
    );
    expect(stats()).toMatchObject({
      correct: initialPhase === "waiting" ? 1 : 0,
      incorrect: progress.incorrect,
    });
    expect(grades()).toEqual(
      initialPhase === "waiting" ? [3] : initialPhase === "learning" ? [] : [1],
    );
    await tick(300);
    await settleReplay();
    expect(phase()).toBe(initialPhase === "waiting" ? "idle" : "waiting");
    expect(stats().remainingPositionKeys).toEqual(
      initialPhase === "waiting" ? [] : progress.remainingPositionKeys,
    );
    expect(stats().reappendedPositionKeys).toEqual(
      initialPhase === "waiting" ? [] : progress.remainingPositionKeys,
    );
    expect(controller()?.hintSan).toBeUndefined();
    if (initialPhase !== "waiting") {
      await answer("Bg7");
      await tick(300);
    }
    expectCompletedTransposedPractice(1, progress.incorrect, progress.incorrect ? [1, 3] : [3]);
  },
);

test.each(["auto", "manual"] as const)(
  "an already-correct %s presentation rebinds without repeating a count or rating",
  async (grading) => {
    await mountTransposedStudy({ grading, comment: "Keep this explanation" });
    await answer("Bg7");
    const before = atoms.get(practiceStateFamily(owner.value));
    const progress = stats();
    const written = [...reviews];
    expect(before.phase).toBe("correct");
    expect(progress.introducedPositionKeys).toEqual([]);
    expect(progress).toMatchObject({ correct: 1, incorrect: 0 });
    expect(grades()).toEqual(grading === "auto" ? [3] : []);
    let cursor: number[] = [];
    await act(async () => {
      tree.getState().promoteVariation([1]);
      cursor = tree.getState().position;
    });
    const rebound = atoms.get(practiceStateFamily(owner.value));
    expect(rebound).toEqual({
      ...before,
      currentFen: getNodeAtPath(tree.getState().root, [0, 0, 0, 0, 0]).fen,
    });
    expect(rebound.currentFen).not.toBe(before.currentFen);
    expect(tree.getState().position).toEqual(cursor);
    expect(tree.getState().practicePath).toEqual([0, 0, 0, 0, 0]);
    expect(stats()).toEqual(progress);
    expect(reviews).toEqual(written);
    expect(controller()?.hintSan).toBeUndefined();
    expect(controller()?.canMove).toBe(false);
    await tick(1_000);
    expect(phase()).toBe("correct");
    await click(grading === "auto" ? "Board.Practice.Continue" : "Board.Practice.Good");
    expectCompletedTransposedPractice(1, 0, [3], cursor);
  },
);

test("completed learning rebinds in advancing and re-appends once without another guided step", async () => {
  await mountTransposedStudy({ unseen: true, comment: "Develop this bishop" });
  const key = atoms.get(practiceStateFamily(owner.value)).positionKey!;
  await answer("Bg7");
  const before = atoms.get(practiceStateFamily(owner.value));
  const progress = stats();
  expect(before.phase).toBe("advancing");
  expect(progress.introducedPositionKeys).toEqual([key]);
  expect(progress.reappendedPositionKeys).toEqual([]);
  let cursor: number[] = [];
  await act(async () => {
    tree.getState().promoteVariation([1]);
    cursor = tree.getState().position;
  });
  const rebound = atoms.get(practiceStateFamily(owner.value));
  expect(rebound).toEqual({
    ...before,
    currentFen: getNodeAtPath(tree.getState().root, [0, 0, 0, 0, 0]).fen,
  });
  expect(rebound.currentFen).not.toBe(before.currentFen);
  expect(tree.getState().position).toEqual(cursor);
  expect(tree.getState().practicePath).toEqual([0, 0, 0, 0, 0]);
  expect(stats()).toEqual(progress);
  expect(stats()).toMatchObject({ correct: 0, incorrect: 0 });
  expect(grades()).toEqual([]);
  expect(controller()?.hintSan).toBeUndefined();
  expect(controller()?.canMove).toBe(false);
  await tick(5_000);
  expect(phase()).toBe("advancing");
  await click("Board.Practice.Continue");
  await settleReplay();
  expect(phase()).toBe("waiting");
  expect(stats().remainingPositionKeys).toEqual([key]);
  expect(stats().introducedPositionKeys).toEqual([key]);
  expect(stats().reappendedPositionKeys).toEqual([key]);
  expect(controller()?.hintSan).toBeUndefined();
  expect(tree.getState().position).toEqual([0, 0, 0, 0, 0]);
  await answer("Bg7");
  expect(phase()).toBe("correct");
  expect(grades()).toEqual([3]);
  expect(stats()).toMatchObject({ correct: 1, incorrect: 0 });
  await click("Board.Practice.Continue");
  expectCompletedTransposedPractice(1, 0, [3]);
});

test("rebind preserves the pending automatic advance's original deadline and fires once", async () => {
  await mountTransposedStudy();
  await answer("Bg7");
  const progress = stats();
  expect(progress.introducedPositionKeys).toEqual([]);
  await tick(200);
  let cursor: number[] = [];
  await act(async () => {
    tree.getState().promoteVariation([1]);
    cursor = tree.getState().position;
  });
  expect(phase()).toBe("correct");
  expect(stats()).toEqual(progress);
  expect(grades()).toEqual([3]);
  expect(controller()?.hintSan).toBeUndefined();
  expect(tree.getState().position).toEqual(cursor);
  await tick(99);
  expect(phase()).toBe("correct");
  await tick(1);
  expectCompletedTransposedPractice(1, 0, [3], cursor);
  await tick(1_000);
  expectCompletedTransposedPractice(1, 0, [3], cursor);
});

test.each(["delete representative", "reload clocks"] as const)(
  "%s keeps an equivalent queue entry and rebinds before stale deck reconciliation can drop it",
  async (change) => {
    await mountTransposedStudy();
    const before = atoms.get(practiceStateFamily(owner.value));
    const progress = stats();
    await act(async () => {
      if (change === "delete representative") tree.getState().deleteMove([0]);
      else {
        const replacement = createTreeStore(
          undefined,
          defaultTree(standard.replace("0 1", "8 10")),
        );
        try {
          for (const payload of [
            ["Nf3", "Nf6", "g3", "g6", "Bg2", "Bg7"],
            ["g3", "g6", "Nf3", "Nf6", "Bg2", "Bg7"],
          ]) {
            replacement.getState().goToStart();
            replacement.getState().makeMoves({ payload });
          }
          tree.getState().setState({
            ...defaultTree(replacement.getState().root.fen),
            root: replacement.getState().root,
            headers: { ...tree.getState().headers, fen: replacement.getState().root.fen },
          });
        } finally {
          replacement.dispose();
        }
      }
    });
    const rebound = atoms.get(practiceStateFamily(owner.value));
    expect(phase()).toBe("waiting");
    expect(rebound).toEqual({ ...before, currentFen: tree.getState().currentNode().fen });
    expect(rebound.currentFen).not.toBe(before.currentFen);
    expect(getBoardState(rebound.currentFen!)).toBe(before.positionKey);
    expect(stats()).toEqual(progress);
    expect(stats().introducedPositionKeys).toEqual([]);
    expect(stats()).toMatchObject({ correct: 0, incorrect: 0 });
    expect(grades()).toEqual([]);
    expect(tree.getState().position).toEqual([0, 0, 0, 0, 0]);
    expect(tree.getState().practicePath).toEqual([0, 0, 0, 0, 0]);
    expect(controller()?.hintSan).toBeUndefined();
    expect(controller()?.canMove).toBe(true);
    await answer("Bg7");
    await tick(300);
    expectCompletedTransposedPractice(1, 0, [3]);
  },
);

test("a replay restart keeps its queue and learning hint and eventually completes", async () => {
  await mountTransposedStudy({ unseen: true, settle: false });
  const progress = stats();
  expect(phase()).toBe("replaying");
  await tick(PRACTICE_REPLAY_STEP_MS);
  await act(async () => tree.getState().promoteVariation([1]));
  expect(phase()).toBe("replaying");
  expect(stats()).toEqual(progress);
  expect(progress.introducedPositionKeys).toEqual([]);
  expect(progress).toMatchObject({ correct: 0, incorrect: 0 });
  expect(grades()).toEqual([]);
  expect(controller()?.hintSan).toBeUndefined();
  expect(controller()?.canMove).toBe(false);
  expect(tree.getState().position).toEqual([]);
  await settleReplay();
  expect(phase()).toBe("learning");
  expect(controller()?.hintSan).toBe("Bg7");
  expect(tree.getState().position).toEqual([0, 0, 0, 0, 0]);
  await answer("Bg7");
  expect(stats().introducedPositionKeys).toEqual(progress.remainingPositionKeys);
  await tick(300);
  expect(phase()).toBe("waiting");
  expect(controller()?.hintSan).toBeUndefined();
  await answer("Bg7");
  await tick(300);
  expectCompletedTransposedPractice(1, 0, [3]);
});

test("genuine card removal drops the entry and completes through the next entry", async () => {
  await mountStudy(cases[0], ["d4", "d5", "c4"], true);
  const progress = stats();
  await act(async () => tree.getState().deleteMove([0]));
  expect(phase()).toBe("replaying");
  expect(stats().remainingPositionKeys).toEqual(progress.remainingPositionKeys.slice(1));
  expect(stats().introducedPositionKeys).toEqual([]);
  expect(stats()).toMatchObject({ correct: 0, incorrect: 0 });
  expect(grades()).toEqual([]);
  expect(controller()?.hintSan).toBeUndefined();
  expect(controller()?.canMove).toBe(false);
  expect(tree.getState().position).toEqual([]);
  await settleReplay();
  expect(phase()).toBe("waiting");
  expect(tree.getState().position).toEqual([0, 0]);
  expect(controller()?.canMove).toBe(true);
  await answer("c4");
  await tick(300);
  expectCompletedTransposedPractice(1, 0, [], [0, 0, 0]);
});

test.each(["waiting", "retry", "revealed"] as const)(
  "deleting the representative with a different surviving answer keeps %s and uses the live answer",
  async (initialPhase) => {
    await mountTransposedStudy({
      variationAnswer: "d5",
      comment: "Old bishop",
      variationComment: "Live pawn",
    });
    if (initialPhase !== "waiting") await answer("h5");
    if (initialPhase === "revealed") await click("Board.Practice.ShowMove");
    const before = atoms.get(practiceStateFamily(owner.value));
    const progress = stats();
    const written = [...reviews];
    expect(before.phase).toBe(initialPhase);
    expect(controller()?.hintSan).toBe(initialPhase === "revealed" ? "Bg7" : undefined);

    await act(async () => tree.getState().deleteMove([0]));

    const rebound = atoms.get(practiceStateFamily(owner.value));
    expect(phase()).toBe(initialPhase);
    expect(rebound).toEqual({
      ...before,
      currentFen: tree.getState().currentNode().fen,
      ...(before.answer ? { answer: "d5" } : {}),
    });
    expect(rebound.currentFen).not.toBe(before.currentFen);
    expect(stats()).toEqual(progress);
    expect(stats().introducedPositionKeys).toEqual([]);
    expect(reviews).toEqual(written);
    expect(tree.getState().position).toEqual([0, 0, 0, 0, 0]);
    expect(controller()?.canMove).toBe(true);
    expect(controller()?.hintSan).toBe(initialPhase === "revealed" ? "d5" : undefined);
    expect(host.textContent?.includes('"move":"d5"')).toBe(initialPhase === "revealed");
    await answer("Bg7");
    expect(phase()).toBe(initialPhase === "waiting" ? "retry" : "revealed");
    expect(stats()).toMatchObject({ correct: 0, incorrect: 1 });
    expect(grades()).toEqual([1]);
    expect(host.textContent).not.toContain("Board.Practice.Alternative");
    if (initialPhase === "waiting") await click("Board.Practice.ShowMove");
    expect(controller()?.hintSan).toBe("d5");
    expect(host.textContent).toContain('"move":"d5"');
    expect(host.textContent).not.toContain('"move":"Bg7"');
    await answer("d5");
    expect(phase()).toBe("correct");
    expect(stats()).toMatchObject({ correct: 0, incorrect: 1 });
    expect(grades()).toEqual([1]);
    expect(controller()?.hintSan).toBeUndefined();
    expect(tree.getState().currentNode().san).toBe("d5");
    expect(host.textContent).toContain("Live pawn");
    expect(host.textContent).not.toContain("Old bishop");
    await click("Board.Practice.Continue");
    expect(phase()).toBe("waiting");
    expect(stats().remainingPositionKeys).toEqual(progress.remainingPositionKeys);
    expect(stats().reappendedPositionKeys).toEqual(progress.remainingPositionKeys);
    await answer("d5");
    await click("Board.Practice.Continue");
    expectCompletedTransposedPractice(1, 1, [1, 3]);
  },
);

test("an answer-only rebind refreshes retry when the main child changes without a FEN change", async () => {
  await mountTransposedStudy();
  await act(async () => {
    tree.getState().makeMoves({ payload: ["d5"] });
    tree.getState().goToMove([0, 0, 0, 0, 0]);
  });
  await answer("h5");
  const before = atoms.get(practiceStateFamily(owner.value));
  const progress = stats();
  expect(before.answer).toBe("Bg7");
  await act(async () => tree.getState().promoteVariation([0, 0, 0, 0, 0, 1]));
  expect(atoms.get(practiceStateFamily(owner.value))).toEqual({ ...before, answer: "d5" });
  expect(stats()).toEqual(progress);
  await click("Board.Practice.ShowMove");
  expect(controller()?.hintSan).toBe("d5");
  expect(host.textContent).toContain('"move":"d5"');
  await answer("d5");
  expect(stats()).toMatchObject({ correct: 0, incorrect: 1 });
  expect(grades()).toEqual([1]);
  await tick(300);
  expect(phase()).toBe("waiting");
  await answer("d5");
  await tick(300);
  expectCompletedTransposedPractice(1, 1, [1, 3]);
});

async function mountScopedTransposition(startPractice: boolean) {
  await mountStudy(
    { ...cases[1], moves: ["Nf3", "Nf6", "g3", "g6", "Bg2", "Bg7"] },
    ["g3", "g6", "Nf3", "Nf6", "Bg2", "d5"],
    false,
    {
      start: [1],
      startPractice,
      settle: false,
      reviewedDues: [
        new Date(Date.now() + 60_000),
        new Date(Date.now() + 60_000),
        new Date(Date.now() - 1_000),
      ],
    },
  );
}

test("scoped transpositions use the in-scope occurrence for PositionsModal, replay and answers", async () => {
  await mountScopedTransposition(false);
  await click("Board.Practice.ShowAll");
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(dialog.textContent).toContain("d5");
  expect(dialog.textContent).not.toContain("Bg7");
  const card = [...dialog.querySelectorAll<HTMLElement>(".mantine-Card-root")].find((node) =>
    node.textContent?.includes("d5"),
  )!;
  expect(card).toBeDefined();
  await act(async () =>
    card
      .querySelector<HTMLButtonElement>('button[aria-label="Board.Practice.GoBackToPosition"]')!
      .click(),
  );
  expect(tree.getState().position).toEqual([1, 0, 0, 0, 0]);
  await act(async () => tree.getState().goToMove([]));
  await click("Board.Practice.StartPractice");
  expect(phase()).toBe("replaying");
  expect(tree.getState().position).toEqual([1]);
  expect(controller()?.canMove).toBe(false);
  expect(controller()?.hintSan).toBeUndefined();
  expect(stats().remainingPositionKeys).toEqual([
    getBoardState(getNodeAtPath(tree.getState().root, [1, 0, 0, 0, 0]).fen),
  ]);
  await tick(PRACTICE_REPLAY_STEP_MS);
  expect(tree.getState().position).toEqual([1, 0]);
  await settleReplay();
  expect(phase()).toBe("waiting");
  expect(tree.getState().position).toEqual([1, 0, 0, 0, 0]);
  expect(tree.getState().practicePath).toEqual([1, 0, 0, 0, 0]);
  expect(controller()?.canMove).toBe(true);
  expect(stats().introducedPositionKeys).toEqual([]);
  expect(grades()).toEqual([]);
  await act(async () => tree.getState().goToMove([0, 0, 0, 0, 0]));
  expect(host.textContent).toContain("Board.Practice.NotOnPosition");
  await click("Board.Practice.GoBackToPosition");
  expect(tree.getState().position).toEqual([1, 0, 0, 0, 0]);
  await answer("d5");
  await tick(300);
  expectCompletedTransposedPractice(1, 0, [3], [1, 0, 0, 0, 0, 0]);
});

test("scoped transpositions drop an outside-only survivor", async () => {
  await mountScopedTransposition(true);
  await settleReplay();
  const key = atoms.get(practiceStateFamily(owner.value)).positionKey;
  expect(tree.getState().position).toEqual([1, 0, 0, 0, 0]);
  expect(stats().remainingPositionKeys).toEqual([key]);
  await act(async () => tree.getState().deleteMove([1, 0, 0, 0, 0]));
  expect(getBoardState(getNodeAtPath(tree.getState().root, [0, 0, 0, 0, 0]).fen)).toBe(key);
  expect(tree.getState().headers.start).toEqual([1]);
  expect(phase()).toBe("idle");
  expect(stats().remainingPositionKeys).toEqual([]);
  expect(stats().introducedPositionKeys).toEqual([]);
  expect(stats()).toMatchObject({ correct: 0, incorrect: 0 });
  expect(grades()).toEqual([]);
  expect(controller()).toBeNull();
  expect(tree.getState().practicePath).toBeNull();
  expect(tree.getState().position).toEqual([1, 0, 0, 0]);
});

test("an idle mount clears a persisted practice path", async () => {
  await mountStudy(cases[0], undefined, false, {
    startPractice: false,
    practicePath: [0, 0],
  });
  expect(phase()).toBe("idle");
  expect(tree.getState().practicePath).toBeNull();
  await act(async () => tree.getState().goToNext());
  expect(tree.getState().position).toEqual([0]);
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

test.each(["active", "stopped", "finished", "tab switch"] as const)(
  "%s session summary survives unmount and is shown on return",
  async (exit) => {
    const card = await mountStudy();
    if (exit === "finished") {
      await answer(card.answer);
      await tick(300);
    } else {
      await answer("Nc3");
      if (exit === "stopped") await click("Common.Stop");
      if (exit === "tab switch") {
        const other = { ...owner, value: crypto.randomUUID(), treeKey: crypto.randomUUID() };
        await act(async () => {
          atoms.set(tabsAtom, [owner, other], owner.value);
          atoms.set(activeTabAtom, other.value);
        });
      }
    }
    await act(async () => root.unmount());
    mounted = false;
    expect(phase()).toBe("idle");
    const summary = atoms.get(practiceCompletedSummaryFamily(owner.value));
    expect(summary).toMatchObject({
      correct: exit === "finished" ? 1 : 0,
      incorrect: exit === "finished" ? 0 : 1,
    });
    await act(async () => atoms.set(activeTabAtom, owner.value));
    root = createRoot(host);
    mounted = true;
    await renderStudy();
    expect(atoms.get(practiceCompletedSummaryFamily(owner.value))).toBe(summary);
    expect(host.textContent).toContain("Board.Practice.SessionSummary");
    expect(host.textContent).toContain(
      exit === "finished"
        ? '"correct":1,"incorrect":0,"accuracy":100,"bestStreak":1'
        : '"correct":0,"incorrect":1,"accuracy":0,"bestStreak":0',
    );
  },
);

test.each([2, 0])("spaced session queues due reviews and at most %s new moves", async (limit) => {
  await mountStudy(
    {
      ...cases[0],
      moves: [
        "e4",
        "e5",
        "Nf3",
        "Nc6",
        "Bb5",
        "a6",
        "Ba4",
        "Nf6",
        "O-O",
        "Be7",
        "Re1",
        "b5",
        "Bb3",
      ],
    },
    undefined,
    false,
    {
      unseen: true,
      reviewedDues: [
        new Date(Date.now() - 1_000),
        undefined,
        new Date(Date.now() - 1_000),
        undefined,
        new Date(Date.now() + 60_000),
      ],
      newLimit: limit,
      startPractice: false,
    },
  );
  const deck = atoms.get(
    deckAtomFamily({ file: fileWorkspaceKey(getTabFile(owner)!.handle), game: 0 }),
  );
  expect(deck.positions.map(({ answer }) => answer)).toEqual([
    "Nf3",
    "Bb5",
    "Ba4",
    "O-O",
    "Re1",
    "Bb3",
  ]);
  const queued = (limit === 0 ? [0, 2] : [0, 1, 2, 3]).map((index) => deck.positions[index]);
  await click("Board.Practice.StartPractice");
  expect(stats().remainingPositionKeys).toEqual(queued.map(({ fen }) => getBoardState(fen)));
  expect(host.textContent).toContain(`"remaining":${queued.length},"correct":0,"incorrect":0`);
  await settleReplay();
  expect(phase()).toBe("waiting");
  expect(tree.getState().currentNode().children[0].san).toBe("Nf3");
  await answer("Nf3");
  await tick(300);
  const presentations =
    limit === 0
      ? [["Ba4", "waiting"]]
      : [
          ["Bb5", "learning"],
          ["Ba4", "waiting"],
          ["O-O", "learning"],
          ["Bb5", "waiting"],
          ["O-O", "waiting"],
        ];
  for (const [san, expectedPhase] of presentations) {
    await settleReplay();
    expect(tree.getState().currentNode().children[0].san).toBe(san);
    expect(phase()).toBe(expectedPhase);
    await answer(san);
    await tick(300);
  }
  expect(phase()).toBe("idle");
  expect(reviews.map(({ entry }) => JSON.parse(entry).fen)).toEqual(
    (limit === 0 ? [0, 2] : [0, 2, 1, 3]).map((index) => deck.positions[index].fen),
  );
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
