import { WorkspaceTabScope } from "@/state/tabScope";
import { parseUci } from "chessops";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

vi.mock("@/hooks/useScaledMaxWidth", () => ({ useScaledMaxWidth: () => false }));

const fixtures = vi.hoisted(() => ({
  language: "en-US",
  stats: { due: 1, nextDue: null as Date | null, learned: 0, total: 1, unseen: 1 },
  atoms: {
    currentEvalOpen: Symbol("current-eval-open"),
    currentInvisible: Symbol("current-invisible"),
    currentPracticeTab: Symbol("current-practice-tab"),
    currentShowComments: Symbol("current-show-comments"),
    currentTab: Symbol("current-tab"),
    deck: Symbol("deck"),
    practiceGrading: Symbol("practice-grading"),
    practiceCardStartTime: Symbol("practice-card-start-time"),
    practiceCompletedSummary: Symbol("practice-completed-summary"),
    practiceMoveController: Symbol("practice-move-controller"),
    practiceSessionStats: Symbol("practice-session-stats"),
    practiceState: Symbol("practice-state"),
  },
  deck: null as any,
  setDeck: vi.fn(),
  atomStore: { get: vi.fn() },
  collectRetainedPracticePositions: vi.fn(() => new Set<string>()),
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
  getNextReviewTimes: vi.fn(() => null as Record<1 | 2 | 3 | 4, Date> | null),
  syncDeck: vi.fn((..._args: unknown[]) => ({
    added: 0,
    positions: [] as unknown[],
    removed: 0,
    updated: 0,
    reordered: false,
  })),
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
  grading: "auto" as "auto" | "manual",
}));

vi.mock("@/state/atoms", () => ({
  evalOpenFamily: () => fixtures.atoms.currentEvalOpen,
  invisibleFamily: () => fixtures.atoms.currentInvisible,
  practiceTabFamily: () => fixtures.atoms.currentPracticeTab,
  showCommentsFamily: () => fixtures.atoms.currentShowComments,
  tabsAtom: fixtures.atoms.currentTab,
  updateTabById: vi.fn(),
  deckAtomFamily: () => fixtures.atoms.deck,
  practiceGradingAtom: fixtures.atoms.practiceGrading,
  practiceNewPerSessionAtom: Symbol("new-per-session"),
  activeTabAtom: Symbol("active-tab"),
  practiceCardStartTimeFamily: () => fixtures.atoms.practiceCardStartTime,
  practiceCompletedSummaryFamily: () => fixtures.atoms.practiceCompletedSummary,
  practiceMoveControllerFamily: () => fixtures.atoms.practiceMoveController,
  practiceSessionStatsFamily: () => fixtures.atoms.practiceSessionStats,
  practiceStateFamily: () => fixtures.atoms.practiceState,
}));
vi.mock("jotai", () => ({
  useStore: () => fixtures.atomStore,
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
    if (atom === fixtures.atoms.practiceGrading) return fixtures.grading;
    if (atom === fixtures.atoms.practiceCardStartTime) return 0;
    return 10;
  },
  useSetAtom: (atom: symbol) =>
    atom === fixtures.atoms.practiceMoveController ? fixtures.setPracticeMoveController : vi.fn(),
}));
vi.mock("./retainedPositions", () => ({
  collectRetainedPracticePositions: fixtures.collectRetainedPracticePositions,
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
vi.mock("@/components/files/opening", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/files/opening")>()),
  buildFromTree: fixtures.buildFromTree,
  getNextReviewTimes: fixtures.getNextReviewTimes,
  getStats: () => fixtures.stats,
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
    t: (key: string, options?: { count?: number; cause?: string; date?: string; value?: string }) =>
      options?.date !== undefined
        ? `${key}:${options.date}`
        : options?.value !== undefined
          ? `${key}:${options.value}`
          : options?.count === undefined
            ? key
            : `${key}:${options.count}`,
    i18n: { language: fixtures.language },
  }),
}));
vi.mock("ts-fsrs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ts-fsrs")>()),
  formatDate: (date: unknown) => `date:${String(date)}`,
  formatReviewLog: () => "",
}));

import { TreeStateContext } from "@/components/common/TreeStateContext";
import { deferTreeView, releaseTreeView } from "@/state/deferredTreeView";
import { createNode, defaultTree, type TreeNode } from "@/utils/treeReducer";
import PracticePanel from "./PracticePanel";

const position = (fen: string, card = { due: "2026-09-22T00:00:00.000Z", reps: 0 }) => ({
  fen,
  answer: "e4",
  card,
});

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
  fixtures.language = "en-US";
  fixtures.stats = { due: 1, nextDue: null, learned: 0, total: 1, unseen: 1 };
  fixtures.deck = deck();
  fixtures.node = { halfMoves: 0, san: "e4" };
  fixtures.grading = "auto";
  fixtures.getNextReviewTimes.mockReset().mockReturnValue(null);
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

test("the next due date follows the German interface language", async () => {
  fixtures.language = "de-DE";
  fixtures.stats = {
    due: 0,
    nextDue: new Date(2099, 0, 22, 15, 4),
    learned: 1,
    total: 1,
    unseen: 0,
  };
  await rerenderPracticePanel();
  expect(container?.textContent).toContain("Board.Practice.PracticedAll1");
  expect(container?.textContent).toContain("Board.Practice.NextDue:22. Jan., 15:04");
  expect(container?.textContent).not.toContain("Jan 22");
});

test("grade buttons format review intervals in the active German locale", async () => {
  const now = Date.UTC(2026, 10, 11, 12);
  vi.useFakeTimers();
  vi.setSystemTime(now);
  try {
    fixtures.language = "de-DE";
    fixtures.grading = "manual";
    fixtures.practiceState = {
      phase: "correct",
      positionKey: "in-repertoire",
      timeTaken: 2500,
    };
    fixtures.getNextReviewTimes.mockReturnValue({
      1: new Date(now + 20 * 1000),
      2: new Date(now + 10 * 60 * 1000),
      3: new Date(now + 5 * 3600 * 1000),
      4: new Date(now + 3 * 24 * 3600 * 1000),
    });
    await rerenderPracticePanel();

    expect(container?.textContent).toContain("(Common.SecondsShort:2,5)");
    const buttons = [...(container?.querySelectorAll("button") ?? [])];
    const buttonTextFor = (label: string) =>
      buttons.find((button) => button.textContent?.includes(label))?.textContent;
    expect(buttonTextFor("Board.Practice.Again")).toBe("Board.Practice.Again< 1 Min.");
    expect(buttonTextFor("Board.Practice.Hard")).toBe("Board.Practice.Hard10 Min.");
    expect(buttonTextFor("Board.Practice.Good")).toBe("Board.Practice.Good5 Std.");
    expect(buttonTextFor("Board.Practice.Easy")).toBe("Board.Practice.Easy3 Tg.");
  } finally {
    vi.useRealTimers();
  }
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

test("deck sync reads the latest tabs only when retention is requested", async () => {
  expect(fixtures.atomStore.get).not.toHaveBeenCalled();
  const retained = fixtures.syncDeck.mock.calls[0][4] as () => ReadonlySet<string>;
  expect(retained).toBeTypeOf("function");
  const latestTabs = [fixtures.currentTab, { value: "other-tab" }];
  fixtures.atomStore.get.mockReturnValue(latestTabs);
  await rerenderPracticePanel();
  expect(fixtures.syncDeck).toHaveBeenCalledOnce();
  expect(fixtures.atomStore.get).not.toHaveBeenCalled();

  const collected = new Set(["retained-position"]);
  fixtures.collectRetainedPracticePositions.mockReturnValueOnce(collected);
  expect(retained()).toBe(collected);

  expect(fixtures.atomStore.get).toHaveBeenCalledWith(fixtures.atoms.currentTab);
  expect(fixtures.collectRetainedPracticePositions).toHaveBeenCalledWith({
    tabs: latestTabs,
    currentTabId: fixtures.currentTab.value,
    identity: { file: "file-a", game: 0 },
    existing: fixtures.deck.positions,
  });
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
  fixtures.tree.headers = { orientation: halfMoves % 2 === 0 ? "white" : "black", start: [] };
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

test("logs show the review date instead of the card's previous due date", async () => {
  const due = "2026-09-22T00:00:00.000Z";
  const review = "2026-11-12T12:00:00.000Z";
  fixtures.loadPracticeReviews.mockResolvedValueOnce({
    entries: [
      {
        id: "review-date",
        entry: JSON.stringify({ due, review, fen: "in-repertoire", rating: 3 }),
      },
    ],
    nextCursor: null,
  });
  const showLogs = [...(container?.querySelectorAll("button") ?? [])].find((button) =>
    button.textContent?.includes("Board.Practice.ShowLogs"),
  );
  expect(showLogs).toBeDefined();
  await act(async () => showLogs?.click());

  const log = container?.querySelector('[data-practice-entry-id="review-date"]');
  expect(log?.textContent).toContain(`date:${review}`);
  expect(log?.textContent).not.toContain(`date:${due}`);
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
