import { WorkspaceTabScope } from "@/state/tabScope";
import { parseUci } from "chessops";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

vi.mock("@/hooks/useScaledMaxWidth", () => ({ useScaledMaxWidth: () => false }));

const fixtures = vi.hoisted(() => ({
  atoms: {
    currentEvalOpen: Symbol("current-eval-open"),
    currentInvisible: Symbol("current-invisible"),
    currentPracticeTab: Symbol("current-practice-tab"),
    currentShowComments: Symbol("current-show-comments"),
    currentTab: Symbol("current-tab"),
    deck: Symbol("deck"),
    practiceAutoDifficulty: Symbol("practice-auto-difficulty"),
    practiceCardStartTime: Symbol("practice-card-start-time"),
    practiceCompletedSummary: Symbol("practice-completed-summary"),
    practiceMoveController: Symbol("practice-move-controller"),
    practiceSessionStats: Symbol("practice-session-stats"),
    practiceState: Symbol("practice-state"),
  },
  deck: null as any,
  setDeck: vi.fn(),
  practiceState: { phase: "idle" } as any,
  setPracticeState: vi.fn(),
  practiceStats: {
    mode: "anki",
    remainingPositionKeys: [],
    correct: 0,
    incorrect: 0,
    streak: 0,
    bestStreak: 0,
  } as any,
  setPracticeStats: vi.fn(),
  setPracticeMoveController: vi.fn(),
  buildFromTree: vi.fn(() => []),
  syncDeck: vi.fn((..._args: unknown[]) => ({
    added: 0,
    positions: [] as unknown[],
    removed: 0,
    updated: 0,
    reordered: false,
  })),
  getCardForReview: vi.fn(),
  updateCardPerformance: vi.fn(),
  loadPracticeReviews: vi.fn(),
  node: { halfMoves: 0, san: "e4" },
  tree: {
    currentNode: () => ({ fen: "root" }),
    goToMove: vi.fn(),
    goToNext: vi.fn(),
    headers: { orientation: "white", start: [] as number[] },
    makeMove: vi.fn(),
    root: {},
    setPracticePath: vi.fn(),
  },
  currentTab: { value: "practice-tab" },
  autoDifficulty: "none" as "none" | "1" | "2" | "3" | "4",
}));

vi.mock("@/state/atoms", () => ({
  evalOpenFamily: () => fixtures.atoms.currentEvalOpen,
  invisibleFamily: () => fixtures.atoms.currentInvisible,
  practiceTabFamily: () => fixtures.atoms.currentPracticeTab,
  showCommentsFamily: () => fixtures.atoms.currentShowComments,
  tabsAtom: fixtures.atoms.currentTab,
  updateTabById: vi.fn(),
  deckAtomFamily: () => fixtures.atoms.deck,
  practiceAutoDifficultyAtom: fixtures.atoms.practiceAutoDifficulty,
  practiceCardStartTimeFamily: () => fixtures.atoms.practiceCardStartTime,
  practiceCompletedSummaryFamily: () => fixtures.atoms.practiceCompletedSummary,
  practiceMoveControllerFamily: () => fixtures.atoms.practiceMoveController,
  practiceSessionStatsFamily: () => fixtures.atoms.practiceSessionStats,
  practiceStateFamily: () => fixtures.atoms.practiceState,
}));
vi.mock("jotai", () => ({
  useAtom: (atom: symbol) => {
    if (atom === fixtures.atoms.deck) return [fixtures.deck, fixtures.setDeck];
    if (atom === fixtures.atoms.currentPracticeTab) return ["train", vi.fn()];
    if (atom === fixtures.atoms.practiceState) {
      return [fixtures.practiceState, fixtures.setPracticeState];
    }
    if (atom === fixtures.atoms.practiceSessionStats) {
      return [fixtures.practiceStats, fixtures.setPracticeStats];
    }
    if (atom === fixtures.atoms.practiceMoveController) {
      return [null, fixtures.setPracticeMoveController];
    }
    if (atom === fixtures.atoms.practiceCompletedSummary) return [null, vi.fn()];
    return [false, vi.fn()];
  },
  useAtomValue: (atom: symbol) => {
    if (atom === fixtures.atoms.currentTab) return [fixtures.currentTab];
    if (atom === fixtures.atoms.practiceAutoDifficulty) return fixtures.autoDifficulty;
    if (atom === fixtures.atoms.practiceCardStartTime) return 0;
    return false;
  },
  useSetAtom: (atom: symbol) =>
    atom === fixtures.atoms.practiceMoveController ? fixtures.setPracticeMoveController : vi.fn(),
}));
vi.mock("zustand", () => ({
  useStore: (_store: unknown, selector: (value: typeof fixtures.tree) => unknown) =>
    selector(fixtures.tree),
}));
vi.mock("react-hotkeys-hook", () => ({ useHotkeys: vi.fn() }));
vi.mock("@/state/practiceStorage", () => ({
  PRACTICE_LOG_PAGE_SIZE: 100,
  loadPracticeReviews: fixtures.loadPracticeReviews,
}));
vi.mock("@/components/files/opening", () => ({
  buildFromTree: fixtures.buildFromTree,
  formatReviewInterval: () => "",
  getCardForReview: fixtures.getCardForReview,
  getNextReviewTimes: () => null,
  getStats: () => ({ due: 1, nextDue: null, practiced: 0, total: 1, unseen: 1 }),
  syncDeck: fixtures.syncDeck,
  updateCardPerformance: fixtures.updateCardPerformance,
}));
vi.mock("@/utils/tabs", () => ({
  useTabActions: () => ({ getTab: () => fixtures.currentTab }),
  sameTabOwner: (current: unknown, captured: unknown) => current === captured,
  getTabFile: () => ({ handle: { id: { id: "file-a" } }, name: "opening.pgn" }),
  getTabGameNumber: () => 0,
}));
vi.mock("@/utils/pathCapabilities", () => ({ fileWorkspaceKey: () => "file-a" }));
vi.mock("@/utils/treeReducer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/treeReducer")>();
  return {
    ...actual,
    findFen: (fen: string) => (fen === "gone" || fen === "root" ? null : [0]),
    getNodeAtPath: () => fixtures.node,
    treeIterator: function* (root: TreeNode) {
      if (Array.isArray(root.children)) {
        yield* actual.treeIterator(root);
        return;
      }
      // The isolated harness supplies card frames. Gameplay tests use the real tree iterator.
      for (const card of [
        ...fixtures.deck.positions,
        { fen: fixtures.tree.currentNode().fen, answer: "e4" },
      ]) {
        if (card.fen === "gone" || card.fen === "root") continue;
        yield {
          position: [0],
          node: { ...fixtures.node, fen: card.fen, children: [{ san: card.answer }] },
        };
      }
    },
  };
});
vi.mock("@/components/common/AppModal", () => ({
  default: ({ opened, onClose, title, children }: any) =>
    opened ? (
      <div role="dialog">
        <h2>{title}</h2>
        <button type="button" aria-label="close" onClick={onClose}>
          close
        </button>
        {children}
      </div>
    ) : null,
}));
vi.mock("@/components/common/ConfirmModal", () => ({
  default: ({ opened, title, description, onConfirm, onClose }: any) =>
    opened ? (
      <div role="alertdialog">
        <div>{title}</div>
        <div>{description}</div>
        <button type="button" onClick={onConfirm}>
          confirm
        </button>
        <button type="button" onClick={onClose}>
          cancel
        </button>
      </div>
    ) : null,
}));
vi.mock("@/components/common/IconAction", () => ({
  IconAction: ({ children, ...props }: any) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}));
vi.mock("./RepertoireInfo", () => ({ default: () => null }));
vi.mock("lucide-react", () => {
  const Icon = () => null;
  return {
    Undo2: Icon,
    ArrowRight: Icon,
    BookOpen: Icon,
    Check: Icon,
    Flame: Icon,
    Info: Icon,
    Target: Icon,
    X: Icon,
  };
});
vi.mock("@mantine/core", () => {
  const element = ({ children, ...props }: any) => <div {...props}>{children}</div>;
  const button = ({ children, ...props }: any) => (
    <button type="button" {...props}>
      {children}
    </button>
  );
  const Tabs = ({ children, ...props }: any) => <div {...props}>{children}</div>;
  Tabs.List = element;
  Tabs.Panel = element;
  Tabs.Tab = button;
  return {
    Alert: ({ title, children, ...props }: any) => (
      <div {...props}>
        {title}
        {children}
      </div>
    ),
    Badge: element,
    Button: button,
    Card: element,
    Divider: element,
    Group: element,
    Paper: element,
    Progress: { Root: element, Section: element },
    SimpleGrid: element,
    Stack: element,
    Tabs,
    Text: element,
    ThemeIcon: element,
    Tooltip: element,
  };
});
vi.mock("@mantine/hooks", async () => {
  const actual = await vi.importActual<typeof import("@mantine/hooks")>("@mantine/hooks");
  return actual;
});
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number; cause?: string }) =>
      options?.count === undefined ? key : `${key}:${options.count}`,
  }),
}));
vi.mock("ts-fsrs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ts-fsrs")>()),
  formatDate: () => "date",
  formatReviewLog: () => "",
}));

import { TreeStateContext } from "@/components/common/TreeStateContext";
import { deferTreeView, releaseTreeView } from "@/state/deferredTreeView";
import { createNode, defaultTree, getBoardState, type TreeNode } from "@/utils/treeReducer";
import PracticePanel from "./PracticePanel";

const position = (fen: string, card = { due: "2026-09-22T00:00:00.000Z", reps: 0 }) => ({
  fen,
  answer: "e4",
  card,
});

const initialFen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const secondFen = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
const thirdFen = "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2";

function deck(overrides: Record<string, unknown> = {}) {
  return {
    epoch: "no-map",
    positions: [position("in-repertoire")],
    revision: 1,
    generation: 0,
    unappliedReviews: 0,
    orphansAcknowledged: true,
    status: "ready",
    ...overrides,
  };
}

function renderPanel() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <TreeStateContext.Provider value={fixtures.tree as any}>
        <WorkspaceTabScope tabId={"practice-tab"}>
          <PracticePanel />
        </WorkspaceTabScope>
      </TreeStateContext.Provider>,
    );
  });
  return { container, root };
}

let root: Root | undefined;
let container: HTMLDivElement | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  fixtures.deck = deck();
  fixtures.node = { halfMoves: 0, san: "e4" };
  fixtures.autoDifficulty = "none";
  fixtures.getCardForReview.mockReset().mockReturnValue(null);
  fixtures.updateCardPerformance.mockReset();
  fixtures.syncDeck
    .mockReset()
    .mockReturnValue({ added: 0, positions: [], removed: 0, updated: 0, reordered: false });
  fixtures.tree.headers = { orientation: "white", start: [] };
  fixtures.tree.root = {};
  fixtures.practiceState = { phase: "idle" };
  fixtures.practiceStats = {
    mode: "anki",
    remainingPositionKeys: [],
    correct: 0,
    incorrect: 0,
    streak: 0,
    bestStreak: 0,
  };
  fixtures.setPracticeState.mockImplementation((next: any) => {
    fixtures.practiceState = next;
  });
  fixtures.setPracticeStats.mockImplementation((next: any) => {
    fixtures.practiceStats = typeof next === "function" ? next(fixtures.practiceStats) : next;
  });
  fixtures.setPracticeMoveController.mockImplementation(() => undefined);
  fixtures.loadPracticeReviews.mockResolvedValue({ entries: [], nextCursor: null });
  ({ root, container } = renderPanel());
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

test("shows loading without an empty deck, reset, or session start", async () => {
  fixtures.deck = deck({ positions: [], status: "loading" });
  await rerenderPracticePanel();

  expect(container?.textContent).toContain("Board.Practice.Loading");
  expect(container?.textContent).not.toContain("Board.Practice.StartPractice");
  expect(container?.textContent).not.toContain("Common.Reset");
  expect(fixtures.setDeck).not.toHaveBeenCalled();
});

test("shows a read failure with repair, no empty deck, and blocked controls", async () => {
  fixtures.deck = deck({ positions: [], status: "read-failed", error: { message: "read failed" } });
  await rerenderPracticePanel();

  expect(container?.textContent).toContain("Board.Practice.ReadFailed");
  expect(container?.textContent).toContain("Board.Practice.Repair");
  expect(container?.textContent).not.toContain("Board.Practice.StartPractice");
  expect(container?.textContent).not.toContain("Common.Reset");
  expect(fixtures.setDeck).not.toHaveBeenCalled();
});

test("dispatches retry without repair for an unreadable deck", async () => {
  fixtures.deck = deck({
    positions: [],
    status: "read-failed",
    repairable: false,
    error: { message: "read failed" },
  });
  await rerenderPracticePanel();

  expect(container?.textContent).toContain("Board.Practice.Retry");
  expect(container?.textContent).not.toContain("Board.Practice.Repair");
  const retry = [...(container?.querySelectorAll("button") ?? [])].find((button) =>
    button.textContent?.includes("Board.Practice.Retry"),
  );
  await act(async () => retry?.click());
  expect(fixtures.setDeck).toHaveBeenCalledWith({ type: "retry" });
  expect(fixtures.setDeck).not.toHaveBeenCalledWith({ type: "repair" });
});

test("dispatches repair only after confirmation", async () => {
  fixtures.deck = deck({ positions: [], status: "read-failed", error: { message: "read failed" } });
  await rerenderPracticePanel();

  const repair = [...(container?.querySelectorAll("button") ?? [])].find((button) =>
    button.textContent?.includes("Board.Practice.Repair"),
  );
  await act(async () => repair?.click());
  const dialog = container?.querySelector('[role="alertdialog"]');
  expect(dialog).toBeTruthy();
  await act(async () => dialog?.querySelector<HTMLButtonElement>("button:last-child")?.click());
  expect(fixtures.setDeck).not.toHaveBeenCalledWith({ type: "repair" });

  const reopen = [...(container?.querySelectorAll("button") ?? [])].find((button) =>
    button.textContent?.includes("Board.Practice.Repair"),
  );
  await act(async () => reopen?.click());
  await act(async () =>
    container?.querySelector<HTMLButtonElement>('[role="alertdialog"] button')?.click(),
  );
  expect(fixtures.setDeck).toHaveBeenCalledWith({ type: "repair" });
});

test("re-diffs the same tree once a new hydration lands", async () => {
  // A remount renders the atom's previous "ready" snapshot first (the mount in beforeEach diffed
  // it); the sync diffed from it is dropped while the deck loads, so the hydrated deck must be
  // diffed again against the same tree.
  const extended = [position("in-repertoire"), position("added-by-the-new-tree")];
  fixtures.syncDeck.mockReturnValue({
    added: 1,
    positions: extended,
    removed: 0,
    updated: 0,
    reordered: false,
  });
  fixtures.setDeck.mockClear();

  fixtures.deck = deck({ positions: [], status: "loading" });
  await rerenderPracticePanel();
  fixtures.deck = deck({ positions: [position("in-repertoire")] });
  await rerenderPracticePanel();

  expect(fixtures.setDeck).toHaveBeenCalledTimes(1);
  const update = fixtures.setDeck.mock.calls[0][0] as (value: unknown) => { positions: unknown };
  expect(update(fixtures.deck).positions).toBe(extended);
});

test.each([
  {
    name: "EP",
    raw: "4k3/8/8/3p4/8/8/4P3/4K3 w - d6 0 2",
    canonical: "4k3/8/8/3p4/8/8/4P3/4K3 w - - 12 8",
  },
  {
    name: "castling",
    raw: "4k3/8/8/3p4/8/8/4P3/R3K2R w HA - 0 2",
    canonical: "4k3/8/8/3p4/8/8/4P3/R3K2R w KQ - 12 8",
  },
])(
  "persists an unchanged-answer $name duplicate removal from real syncDeck",
  async ({ raw, canonical }) => {
    const actual = await vi.importActual<typeof import("@/components/files/opening")>(
      "@/components/files/opening",
    );
    const tree = defaultTree().root;
    const node = createNode({
      fen: canonical,
      move: parseUci("d7d5")!,
      san: "d5",
      halfMoves: 14,
    });
    node.children.push(
      createNode({ fen: canonical, move: parseUci("e2e4")!, san: "e4", halfMoves: 15 }),
    );
    tree.children.push(node);
    const [fresh] = actual.buildFromTree(tree, "white", []);
    expect(fresh).toMatchObject({ fen: canonical, answer: "e4" });
    const first = { ...fresh, fen: raw, card: { ...fresh.card, reps: 4 } };
    const last = { ...fresh, card: { ...fresh.card, reps: 9 } };
    fixtures.deck = deck({ positions: [first, last] });
    const inputBefore = structuredClone(fixtures.deck);
    fixtures.tree.root = tree;
    fixtures.setDeck.mockClear();
    fixtures.syncDeck
      .mockClear()
      .mockImplementation((...args) =>
        actual.syncDeck(...(args as Parameters<typeof actual.syncDeck>)),
      );

    await rerenderPracticePanel();

    expect(fixtures.syncDeck).toHaveBeenCalledOnce();
    const result = fixtures.syncDeck.mock.results[0].value;
    expect(result).toMatchObject({ added: 0, updated: 0, reordered: false });
    expect(result.positions).toEqual([last]);
    expect(result.positions[0].card).toBe(last.card);
    expect(fixtures.deck).toEqual(inputBefore);
    expect(fixtures.setDeck).toHaveBeenCalledOnce();
    const update = fixtures.setDeck.mock.calls[0][0];
    expect(typeof update).toBe("function");
    expect(update(fixtures.deck)).toEqual({ ...fixtures.deck, positions: [last] });
    expect(result.removed).toBe(1);
  },
);

test("re-diffs an unchanged tree when the practised side or start changes", async () => {
  fixtures.syncDeck.mockClear();
  fixtures.tree.headers = { orientation: "black", start: [] };
  await rerenderPracticePanel();
  expect(fixtures.syncDeck).toHaveBeenCalledTimes(1);
  expect(fixtures.syncDeck.mock.calls[0][2]).toBe("black");

  fixtures.tree.headers = { orientation: "black", start: [0] };
  await rerenderPracticePanel();
  expect(fixtures.syncDeck).toHaveBeenCalledTimes(2);
  expect(fixtures.syncDeck.mock.calls[1][3]).toEqual([0]);
});

test("persists a changed answer even when no position was added or removed", async () => {
  const promoted = [{ ...position("in-repertoire"), answer: "d4" }];
  fixtures.syncDeck.mockReturnValue({
    added: 0,
    positions: promoted,
    removed: 0,
    updated: 1,
    reordered: false,
  });
  fixtures.setDeck.mockClear();
  fixtures.tree.root = {};
  await rerenderPracticePanel();

  expect(fixtures.setDeck).toHaveBeenCalledTimes(1);
  const update = fixtures.setDeck.mock.calls[0][0] as (value: unknown) => { positions: unknown };
  expect(update(fixtures.deck).positions).toBe(promoted);
});

test("persists a reordering of the same cards", async () => {
  const reorderedDeck = [position("second"), position("in-repertoire")];
  fixtures.syncDeck.mockReturnValue({
    added: 0,
    positions: reorderedDeck,
    removed: 0,
    updated: 0,
    reordered: true,
  });
  fixtures.setDeck.mockClear();
  fixtures.tree.root = {};
  await rerenderPracticePanel();

  expect(fixtures.setDeck).toHaveBeenCalledTimes(1);
});

test("a committed rating does not re-diff an unchanged tree", async () => {
  fixtures.syncDeck.mockClear();
  fixtures.deck = deck({ positions: [position("in-repertoire")], status: "write-pending" });
  await rerenderPracticePanel();
  fixtures.deck = deck({ positions: [position("in-repertoire", { due: "2026-09-30", reps: 1 })] });
  await rerenderPracticePanel();

  expect(fixtures.syncDeck).not.toHaveBeenCalled();
});

test("defers deck sync until the retained view is released", async () => {
  const store = fixtures.tree as typeof fixtures.tree & {
    getState: () => typeof fixtures.tree;
  };
  store.getState = () => store;
  const deferredStore = store as unknown as Parameters<typeof deferTreeView>[0];
  deferTreeView(deferredStore);
  fixtures.syncDeck.mockClear();
  fixtures.buildFromTree.mockClear();
  fixtures.tree.root = { children: [] };
  await rerenderPracticePanel();

  expect(fixtures.syncDeck).not.toHaveBeenCalled();
  expect(fixtures.buildFromTree).not.toHaveBeenCalled();

  releaseTreeView(deferredStore);
  await act(async () => {});
  expect(fixtures.syncDeck).toHaveBeenCalledOnce();
});

test("does not create a native deck when an empty tree yields no positions", async () => {
  fixtures.setDeck.mockClear();
  fixtures.buildFromTree.mockClear();
  fixtures.deck = deck({ positions: [] });
  fixtures.tree.root = {};
  await rerenderPracticePanel();

  expect(fixtures.buildFromTree).toHaveBeenCalledOnce();
  expect(fixtures.setDeck).not.toHaveBeenCalled();
});

test("renders and dismisses only unacknowledged unapplied reviews", async () => {
  fixtures.deck = deck({ unappliedReviews: 2, orphansAcknowledged: false });
  await rerenderPracticePanel();
  expect(container?.textContent).toContain("Board.Practice.UnappliedReviews:2");
  const dismiss = [...(container?.querySelectorAll("button") ?? [])].find((button) =>
    button.textContent?.includes("Board.Practice.DismissUnappliedReviews"),
  );
  await act(async () => dismiss?.click());
  expect(fixtures.setDeck).toHaveBeenCalledWith({ type: "acknowledge" });

  fixtures.deck = deck({ unappliedReviews: 0, orphansAcknowledged: false });
  await rerenderPracticePanel();
  expect(container?.textContent).not.toContain("Board.Practice.UnappliedReviews");
});

test.each([
  { halfMoves: 2, answer: "Nf3", expected: "2. Nf3" },
  { halfMoves: 1, answer: "e5", expected: "1... e5" },
])("renders the exact positions card label $expected", async ({ halfMoves, answer, expected }) => {
  fixtures.node = { halfMoves, san: "e4" };
  fixtures.deck = deck({ positions: [{ ...position("in-repertoire"), answer }] });
  await rerenderPracticePanel();
  const showPositions = [...(container?.querySelectorAll("button") ?? [])].find((button) =>
    button.textContent?.includes("Board.Practice.ShowAll"),
  );
  await act(async () => showPositions?.click());

  const dialog = container?.querySelector('[role="dialog"]');
  expect(dialog).not.toBeNull();
  const labels = [...(dialog?.querySelectorAll("div") ?? [])]
    .filter((element) => element.children.length === 0)
    .map((element) => element.textContent);
  expect(labels).toContain(expected);
});

test.each([
  { halfMoves: 2, san: "e5", expected: "1... e5" },
  { halfMoves: 1, san: "e4", expected: "1. e4" },
])("renders the exact logs card label $expected", async ({ halfMoves, san, expected }) => {
  fixtures.node = { halfMoves, san };
  fixtures.loadPracticeReviews.mockResolvedValueOnce({
    entries: [
      {
        id: "numbered-log",
        entry: JSON.stringify({ due: "2026-09-22", fen: "in-repertoire", rating: 3 }),
      },
    ],
    nextCursor: null,
  });
  const showLogs = [...(container?.querySelectorAll("button") ?? [])].find((button) =>
    button.textContent?.includes("Board.Practice.ShowLogs"),
  );
  await act(async () => showLogs?.click());
  await vi.waitFor(() =>
    expect(
      container?.querySelector('[data-practice-entry-id="numbered-log"]')?.firstElementChild
        ?.textContent,
    ).toBe(expected),
  );
});

test("pages logs in backend order until the cursor is exhausted and keeps off-repertoire FENs", async () => {
  const entry = (id: string, fen: string) => ({
    id,
    entry: JSON.stringify({ due: "2026-09-22", fen, rating: 3 }),
  });
  fixtures.loadPracticeReviews
    .mockResolvedValueOnce({
      entries: [entry("one", "in-repertoire"), entry("two", "gone")],
      nextCursor: "next",
    })
    .mockResolvedValueOnce({ entries: [entry("three", "in-repertoire")], nextCursor: null });
  const showLogs = [...(container?.querySelectorAll("button") ?? [])].find((button) =>
    button.textContent?.includes("Board.Practice.ShowLogs"),
  );
  await act(async () => showLogs?.click());
  await vi.waitFor(() =>
    expect(container?.querySelectorAll("[data-practice-entry-id]")).toHaveLength(2),
  );
  expect(
    [...container!.querySelectorAll<HTMLElement>("[data-practice-entry-id]")].map(
      (node) => node.dataset.practiceEntryId,
    ),
  ).toEqual(["one", "two"]);
  expect(container?.textContent).toContain("gone");

  const loadMore = [...(container?.querySelectorAll("button") ?? [])].find((button) =>
    button.textContent?.includes("Board.Practice.LoadMore"),
  );
  await act(async () => loadMore?.click());
  await vi.waitFor(() =>
    expect(container?.querySelectorAll("[data-practice-entry-id]")).toHaveLength(3),
  );
  expect(
    [...container!.querySelectorAll<HTMLElement>("[data-practice-entry-id]")].map(
      (node) => node.dataset.practiceEntryId,
    ),
  ).toEqual(["one", "two", "three"]);
  expect(container?.textContent).not.toContain("Board.Practice.LoadMore");
});

test("keeps existing logs and cursor after a failed page", async () => {
  fixtures.loadPracticeReviews
    .mockResolvedValueOnce({
      entries: [
        {
          id: "kept",
          entry: JSON.stringify({ due: "2026-09-22", fen: "in-repertoire", rating: 3 }),
        },
      ],
      nextCursor: "retry",
    })
    .mockRejectedValueOnce(new Error("page failed"));
  const showLogs = [...(container?.querySelectorAll("button") ?? [])].find((button) =>
    button.textContent?.includes("Board.Practice.ShowLogs"),
  );
  await act(async () => showLogs?.click());
  await vi.waitFor(() =>
    expect(container?.querySelectorAll("[data-practice-entry-id]")).toHaveLength(1),
  );
  const loadMore = [...(container?.querySelectorAll("button") ?? [])].find((button) =>
    button.textContent?.includes("Board.Practice.LoadMore"),
  );
  await act(async () => loadMore?.click());
  await vi.waitFor(() => expect(container?.textContent).toContain("Board.Practice.LogsLoadFailed"));
  expect(container?.querySelectorAll("[data-practice-entry-id]")).toHaveLength(1);
  expect(container?.textContent).toContain("Board.Practice.LoadMore");
});

test("drops a late log page after the modal closes", async () => {
  let release!: (value: { entries: any[]; nextCursor: null }) => void;
  fixtures.loadPracticeReviews.mockImplementationOnce(
    () => new Promise((resolve) => (release = resolve)),
  );
  const showLogs = [...(container?.querySelectorAll("button") ?? [])].find((button) =>
    button.textContent?.includes("Board.Practice.ShowLogs"),
  );
  await act(async () => showLogs?.click());
  const close = container?.querySelector<HTMLButtonElement>('button[aria-label="close"]');
  await act(async () => close?.click());
  release({
    entries: [{ id: "late", entry: JSON.stringify({ due: "2026-09-22", fen: "gone", rating: 3 }) }],
    nextCursor: null,
  });
  await act(async () => Promise.resolve());
  expect(container?.textContent).not.toContain("late");
});

test("drops a log page that started before the deck generation changed", async () => {
  let release!: (value: { entries: any[]; nextCursor: null }) => void;
  fixtures.loadPracticeReviews.mockImplementationOnce(
    () => new Promise((resolve) => (release = resolve)),
  );
  const showLogs = [...(container?.querySelectorAll("button") ?? [])].find((button) =>
    button.textContent?.includes("Board.Practice.ShowLogs"),
  );
  await act(async () => showLogs?.click());

  fixtures.deck = deck({ generation: 1 });
  await rerenderPracticePanel();
  release({
    entries: [{ id: "reset-late", entry: JSON.stringify({ due: "2026-09-22", fen: "gone" }) }],
    nextCursor: null,
  });
  await act(async () => Promise.resolve());
  expect(container?.textContent).not.toContain("reset-late");
});

function latestMoveController(): { submitMove: (san: string) => void } {
  const value = [...fixtures.setPracticeMoveController.mock.calls]
    .reverse()
    .map(([controller]) => controller)
    .find((controller) => controller !== null);
  if (!value) throw new Error("practice move controller was not registered");
  return value;
}

async function rerenderPracticePanel() {
  await act(async () =>
    root?.render(
      <TreeStateContext.Provider value={fixtures.tree as any}>
        <WorkspaceTabScope tabId={"practice-tab"}>
          <PracticePanel />
        </WorkspaceTabScope>
      </TreeStateContext.Provider>,
    ),
  );
}

async function startPracticeSession(
  positions: ReturnType<typeof position>[],
  mode: "normal" | "full",
) {
  fixtures.deck = deck({ positions });
  await rerenderPracticePanel();
  const label =
    mode === "full" ? "Board.Practice.PracticeFullRepertoire" : "Board.Practice.StartPractice";
  const start = [...(container?.querySelectorAll("button") ?? [])].find((button) =>
    button.textContent?.includes(label),
  );
  await act(async () => start?.click());
  const first = positions[0];
  if (!first) throw new Error("practice session needs an initial position");
  fixtures.tree.currentNode = () => ({ fen: first.fen });
  await rerenderPracticePanel();
  return first;
}

async function startNormalSession(positions: ReturnType<typeof position>[]) {
  return startPracticeSession(positions, "normal");
}

async function startFullSession(positions: ReturnType<typeof position>[]) {
  return startPracticeSession(positions, "full");
}

async function submitCorrectMove(fen: string) {
  fixtures.tree.currentNode = () => ({ fen });
  await rerenderPracticePanel();
  await act(async () => latestMoveController().submitMove("e4"));
  await rerenderPracticePanel();
}

test("current castling card resolves its exact answer-bearing occurrence and retires when only an alias remains", async () => {
  const raw = "4k3/8/8/3p4/8/8/4P3/R3K2R w HA - 0 2";
  const canonical = raw.replace(" HA ", " KQ ");
  expect(getBoardState(raw)).toBe(getBoardState(canonical));
  const exact = createNode({ fen: raw, move: parseUci("d7d5")!, san: "d5", halfMoves: 2 });
  exact.children.push(
    createNode({ fen: canonical, move: parseUci("e2e4")!, san: "e4", halfMoves: 3 }),
  );
  const alias = { ...exact, fen: canonical };
  const tree = defaultTree().root;
  tree.children.push(alias, { ...exact, children: [] }, exact);
  fixtures.tree.root = tree;
  fixtures.tree.goToMove.mockClear();

  await startFullSession([position(raw)]);

  expect(fixtures.tree.goToMove).toHaveBeenCalledExactlyOnceWith([2]);
  expect(fixtures.practiceState.currentFen).toBe(raw);
  expect(fixtures.practiceState.phase).toBe("waiting");
  fixtures.tree.root = { ...tree, children: [alias] };
  await rerenderPracticePanel();
  expect(fixtures.practiceState.phase).toBe("idle");
});

test("full mode skips an active position removed by a deck sync", async () => {
  vi.useFakeTimers();
  const first = position(initialFen);
  const second = position(secondFen);
  const third = position(thirdFen);
  await startFullSession([first, second, third]);

  fixtures.deck = deck({ positions: [second, third] });
  await rerenderPracticePanel();
  await act(async () => latestMoveController().submitMove("e4"));
  await rerenderPracticePanel();
  await act(async () => vi.advanceTimersByTimeAsync(300));

  expect(fixtures.practiceState.currentFen).toBe(second.fen);
  expect(fixtures.practiceState.phase).toBe("waiting");
  vi.useRealTimers();
});

test("full mode skips a queued position removed by a deck sync", async () => {
  vi.useFakeTimers();
  const first = position(initialFen);
  const second = position(secondFen);
  const third = position(thirdFen);
  await startFullSession([first, second, third]);
  await submitCorrectMove(first.fen);

  fixtures.deck = deck({ positions: [first, third] });
  await rerenderPracticePanel();
  await act(async () => vi.advanceTimersByTimeAsync(300));

  expect(fixtures.practiceState.currentFen).toBe(third.fen);
  expect(fixtures.practiceState.phase).toBe("waiting");
  vi.useRealTimers();
});

test("full mode completes when a sync removes its final position during advance", async () => {
  vi.useFakeTimers();
  const first = position(initialFen);
  await startFullSession([first]);
  await submitCorrectMove(first.fen);

  fixtures.deck = deck({ positions: [] });
  await rerenderPracticePanel();
  await act(async () => vi.advanceTimersByTimeAsync(300));

  expect(fixtures.practiceState.phase).toBe("idle");
  vi.useRealTimers();
});

test("normal-mode rating follows the board identity after a deck sync and ignores a duplicate", async () => {
  vi.useFakeTimers();
  const first = position(initialFen);
  const firstWithNewMoveCounters = position(
    "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 7 42",
  );
  const second = position("in-repertoire-second", {
    due: "2026-09-23T00:00:00.000Z",
    reps: 0,
  });
  const inserted = position("in-repertoire-inserted", {
    due: "2026-09-24T00:00:00.000Z",
    reps: 0,
  });
  const rated = {
    ...first,
    card: { ...first.card, due: "2026-10-01T00:00:00.000Z", reps: 1 },
  };
  fixtures.getCardForReview.mockImplementation(
    (positions: any[]) =>
      positions
        .filter((candidate) => new Date(candidate.card.due) <= new Date())
        .sort((left, right) => +new Date(left.card.due) - +new Date(right.card.due))[0] ?? null,
  );
  fixtures.updateCardPerformance.mockReturnValue({
    positions: [inserted, { ...firstWithNewMoveCounters, card: rated.card }, second],
    entry: { fen: first.fen, rating: 3 },
    entryId: "rated-first",
  });
  await startNormalSession([first, second]);
  await submitCorrectMove(first.fen);
  fixtures.deck = deck({ positions: [inserted, firstWithNewMoveCounters, second] });
  await rerenderPracticePanel();
  const good = [...(container?.querySelectorAll("button") ?? [])].find((button) =>
    button.textContent?.includes("Board.Practice.Good"),
  );
  await act(async () => {
    good?.click();
    good?.click();
  });
  await act(async () => vi.advanceTimersByTimeAsync(300));

  expect(fixtures.updateCardPerformance).toHaveBeenCalledOnce();
  expect(fixtures.updateCardPerformance.mock.calls[0]?.[1]).toBe(1);
  expect(fixtures.updateCardPerformance.mock.calls[0]?.[0][1]?.fen).toBe(
    firstWithNewMoveCounters.fen,
  );
  expect(fixtures.practiceStats.correct).toBe(1);
  expect(fixtures.practiceState.currentFen).toBe(second.fen);
  vi.useRealTimers();
});

test("auto-difficulty rates the latest card after a deck sync", async () => {
  vi.useFakeTimers();
  fixtures.autoDifficulty = "3";
  const first = position("in-repertoire-first");
  const second = position("in-repertoire-second", {
    due: "2026-09-23T00:00:00.000Z",
    reps: 0,
  });
  const inserted = position("in-repertoire-inserted", {
    due: "2026-09-24T00:00:00.000Z",
    reps: 0,
  });
  const rated = {
    ...first,
    card: { ...first.card, due: "2026-10-01T00:00:00.000Z", reps: 1 },
  };
  fixtures.getCardForReview.mockImplementation(
    (positions: any[]) =>
      positions
        .filter((candidate) => new Date(candidate.card.due) <= new Date())
        .sort((left, right) => +new Date(left.card.due) - +new Date(right.card.due))[0] ?? null,
  );
  fixtures.updateCardPerformance.mockReturnValue({
    positions: [inserted, rated, second],
    entry: { fen: first.fen, rating: 3 },
    entryId: "rated-first",
  });
  await startNormalSession([first, second]);
  await submitCorrectMove(first.fen);
  fixtures.deck = deck({ positions: [inserted, first, second] });
  await rerenderPracticePanel();
  await act(async () => vi.advanceTimersByTimeAsync(300));

  expect(fixtures.updateCardPerformance).toHaveBeenCalledOnce();
  expect(fixtures.updateCardPerformance.mock.calls[0]?.[1]).toBe(1);
  expect(fixtures.practiceState.currentFen).toBe(second.fen);
  vi.useRealTimers();
});

test("full-repertoire mode enters the first position and advances through the remaining positions", async () => {
  vi.useFakeTimers();
  const first = position("in-repertoire-first");
  const second = position("in-repertoire-second");
  const inserted = position("in-repertoire-inserted");
  await startFullSession([first, second]);
  expect(fixtures.practiceState.currentFen).toBe(first.fen);

  await submitCorrectMove(first.fen);
  fixtures.deck = deck({ positions: [inserted, first, second] });
  await rerenderPracticePanel();
  await act(async () => vi.advanceTimersByTimeAsync(300));
  expect(fixtures.practiceState.currentFen).toBe(second.fen);

  await submitCorrectMove(second.fen);
  await act(async () => vi.advanceTimersByTimeAsync(300));
  expect(fixtures.practiceState.phase).toBe("idle");
  vi.useRealTimers();
});
