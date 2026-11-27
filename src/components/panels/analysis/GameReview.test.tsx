import { MantineProvider } from "@mantine/core";
import { createInstance, type TFunction } from "i18next";
import { Provider, createStore as createAtomStore } from "jotai";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Score } from "@/bindings";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import { createTreeStore, type TreeStore } from "@/state/store/tree";
import { WorkspaceTabScope } from "@/state/tabScope";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { installResizeObserverStub } from "@/tests/resizeObserver";
import { buildExplainQuestion, type KeyMomentItem } from "./KeyMoments";
import { Scoreboard } from "./Scoreboard";
import ReportPanel from "./ReportPanel";
import { TimeStrip } from "./TimeStrip";
import { openingNameCache } from "@/hooks/useOpeningName";
import {
  coachExplainRequestFamily,
  disposeTabAtoms,
  fileWorkspaceAtom,
  reviewFocusFamily,
  sessionsAtom,
  tabFamily,
} from "@/state/atoms";
import {
  assistantAvailableAtom,
  coachEnabledAtom,
  refreshAssistantAvailabilityAtom,
} from "@/state/coachAvailability";
import type { RepertoireSnapshot } from "@/state/repertoireIndex";
import {
  type AnnotationCounts,
  type GameStats,
  getMainLine,
  reportRootFingerprint,
} from "@/utils/chess";
import { getMoveTimeUsage } from "@/utils/gameReview";
import { formatScore } from "@/utils/score";
import { defaultTree, getBoardState } from "@/utils/treeReducer";

const zeroCounts: AnnotationCounts = {
  "!!": 0,
  "!": 0,
  "!?": 0,
  "?!": 0,
  "?": 0,
  "??": 0,
};

const mocks = vi.hoisted(() => ({
  t: (key: string, options?: Record<string, unknown>) => {
    if (!options) return key;
    if ("opening" in options) return `${key}:${String(options.opening)}`;
    if ("played" in options && "repertoire" in options && "file" in options && "move" in options) {
      return `${key}:${String(options.move)}:${String(options.played)}:${String(options.repertoire)}:${String(options.file)}`;
    }
    if ("before" in options && "after" in options) {
      return `${key}:${String(options.move)}:${String(options.kind ?? "")}:${String(options.before)}:${String(options.after)}`;
    }
    if ("better" in options) return `${key}:${String(options.better)}`;
    if ("move" in options) return `${key}:${String(options.move)}`;
    return key;
  },
  cancelAnalysis: vi.fn(),
  getProgress: vi.fn().mockResolvedValue(null),
  getOpeningFromFens: vi.fn().mockResolvedValue(""),
  coachAvailable: vi.fn().mockResolvedValue(false),
  coachHasConnection: vi.fn().mockResolvedValue(false),
  refreshRepertoireIndex: vi.fn().mockResolvedValue(undefined),
  readRepertoireIndex: vi.fn().mockReturnValue(null),
  notifyUnlessCancelled: vi.fn(),
  chartProps: null as null | {
    isAnalysing: boolean;
    highlightedMovePath?: number[] | null;
    onHoverMove?: (movePath: number[] | null) => void;
  },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: mocks.t, i18n: { language: "en-US" } }),
  Trans: ({ i18nKey }: { i18nKey: string }) => <>{i18nKey}</>,
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children?: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));
vi.mock("@/platform/tauri", () => ({
  tauri: {
    cancelAnalysis: mocks.cancelAnalysis,
    getProgress: mocks.getProgress,
    getOpeningFromFens: mocks.getOpeningFromFens,
    coachAvailable: mocks.coachAvailable,
    coachHasConnection: mocks.coachHasConnection,
  },
}));
vi.mock("@/state/repertoireIndex", () => ({
  refreshRepertoireIndex: mocks.refreshRepertoireIndex,
  readRepertoireIndex: mocks.readRepertoireIndex,
}));
vi.mock("@/hooks/useProgress", () => ({
  useProgress: () => ({
    finished: false,
    progress: 0,
    isActive: false,
    item: null,
    clear: vi.fn(),
  }),
}));
vi.mock("@/components/common/EvalChart", () => ({
  default: (props: {
    isAnalysing: boolean;
    highlightedMovePath?: number[] | null;
    onHoverMove?: (movePath: number[] | null) => void;
  }) => {
    mocks.chartProps = props;
    return <div data-testid="mock-eval-chart" />;
  },
}));
vi.mock("./ReportModal", () => ({ default: () => null }));
vi.mock("@/utils/sound", () => ({ playSound: vi.fn() }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
installMatchMediaStub();
installResizeObserverStub();

let host: HTMLDivElement;
let root: Root;
let store: TreeStore;
let atoms: ReturnType<typeof createAtomStore>;

const cp = (value: number): Score => ({ value: { type: "cp", value }, wdl: null });

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  atoms = createAtomStore();
  store = createTreeStore();
  openingNameCache.clear();
  mocks.getOpeningFromFens.mockReset().mockResolvedValue("");
  mocks.coachAvailable.mockReset().mockResolvedValue(false);
  mocks.coachHasConnection.mockReset().mockResolvedValue(false);
  mocks.refreshRepertoireIndex.mockReset().mockResolvedValue(undefined);
  mocks.readRepertoireIndex.mockReset().mockReturnValue(null);
});

afterEach(async () => {
  await act(async () => root.unmount());
  disposeTabAtoms("tab-1");
  mocks.chartProps = null;
  host.remove();
});

async function renderReport() {
  await act(async () => {
    root.render(
      <MantineProvider>
        <Provider store={atoms}>
          <TreeStateContext.Provider value={store}>
            <WorkspaceTabScope tabId="tab-1">
              <ReportPanel />
            </WorkspaceTabScope>
          </TreeStateContext.Provider>
        </Provider>
      </MantineProvider>,
    );
  });
}

test("scoreboard shows BoardBar player names/ratings, accuracy hero, spelled-out average loss, phases and accessible counts", async () => {
  store.getState().makeMoves({ payload: ["e4", "e5", "Qh5", "Nc6"], mainline: true });
  store.setState((state) => {
    const e4 = state.root.children[0];
    const e5 = e4.children[0];
    const qh5 = e5.children[0];
    const nc6 = qh5.children[0];
    return {
      headers: {
        ...state.headers,
        white: "Alice",
        white_elo: 1920,
        black: "?",
        black_elo: null,
      },
      root: {
        ...state.root,
        score: cp(15),
        children: [
          {
            ...e4,
            score: cp(20),
            children: [
              {
                ...e5,
                score: cp(20),
                children: [
                  {
                    ...qh5,
                    nags: [6],
                    score: cp(-350),
                    // 10 majors+minors so middlegame starts at this move.
                    fen: "r2qk2r/pppp1ppp/2n2n2/4p2Q/4P3/8/PPPP1PPP/R3KBNR w KQkq - 2 3",
                    children: [
                      {
                        ...nc6,
                        nags: [4],
                        score: cp(450),
                        fen: "4k3/pppppppp/8/8/8/8/PPPPPPPP/4K3 w - - 0 4",
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    };
  });
  store.getState().goToStart();

  await renderReport();

  // No ACPL anywhere on the page.
  expect(host.textContent).not.toContain("ACPL");
  expect(host.textContent).toContain("Board.Analysis.Report.AverageLoss");

  // Column heads follow BoardBar rule.
  const colHeads = [...host.querySelectorAll("thead th")].map((th) => th.textContent);
  expect(colHeads[0]).toContain("Alice");
  expect(colHeads[0]).toContain("(1920)");
  expect(colHeads[2]).toBe("Common.BLACK");

  // Two accuracy cells with percentage format.
  const accuracyCells = [...host.querySelectorAll('[data-testid="report-accuracy"]')];
  expect(accuracyCells).toHaveLength(2);
  expect(accuracyCells.every((cell) => /\d+\.\d%/.test(cell.textContent ?? ""))).toBe(true);

  // Phases: Opening (both scored), Middlegame (White scored, Black dash), Endgame (White dash, Black scored).
  const rowHeaders = [...host.querySelectorAll("tbody th")].map((th) => th.textContent);
  expect(rowHeaders).toContain("Board.Analysis.Opening");
  expect(rowHeaders).toContain("Board.Analysis.Middlegame");
  expect(rowHeaders).toContain("Board.Analysis.Endgame");
  const endgameRow = [...host.querySelectorAll("tbody tr")].find(
    (tr) => tr.querySelector("th")?.textContent === "Board.Analysis.Endgame",
  )!;
  expect(endgameRow.querySelectorAll("td")[0].textContent).toBe("–");
  expect(endgameRow.querySelectorAll("td")[1].textContent).toMatch(/\d+\.\d%/);

  // Summary sentence rendered above scoreboard.
  expect(host.querySelector('[data-testid="report-summary"]')?.textContent).toContain(
    "Board.Analysis.Report.Summary.TurnedGameWhite:2... Nc6",
  );

  // Accessible count buttons step through annotations.
  const whiteDubious = host.querySelector<HTMLButtonElement>(
    'button[aria-label="Board.Analysis.NextAnnotationByWhite"]',
  )!;
  await act(async () => whiteDubious.click());
  expect(store.getState().position).toEqual([0, 0, 0]);
});

test("summary sentence is omitted for an unbalanced start position", async () => {
  store.getState().makeMoves({ payload: ["e4"], mainline: true });
  store.setState((state) => ({
    root: {
      ...state.root,
      score: cp(400),
      children: [{ ...state.root.children[0], score: cp(400) }],
    },
  }));
  await renderReport();
  expect(host.querySelector('[data-testid="report-summary"]')).toBeNull();
});

test("Scoreboard omits Middlegame and Endgame rows when only Opening phase exists", async () => {
  const tree = defaultTree();
  const stats: GameStats = {
    white: { accuracy: 92.5, acpl: 12.4, annotations: zeroCounts },
    black: { accuracy: 88.0, acpl: 24.1, annotations: zeroCounts },
    keyMoments: [],
    scoredPositions: 4,
    phases: { middlegamePly: null, endgamePly: null },
    phaseAccuracy: {
      white: { opening: 92.5, middlegame: null, endgame: null },
      black: { opening: 88.0, middlegame: null, endgame: null },
    },
  };

  await act(async () => {
    root.render(
      <MantineProvider>
        <Scoreboard stats={stats} headers={tree.headers} goToAnnotation={vi.fn()} />
      </MantineProvider>,
    );
  });

  const rowHeaders = [...host.querySelectorAll("tbody th")].map((th) => th.textContent);
  expect(rowHeaders).toContain("Board.Analysis.Opening");
  expect(rowHeaders).not.toContain("Board.Analysis.Middlegame");
  expect(rowHeaders).not.toContain("Board.Analysis.Endgame");
});

test("every O8 explanation appears on both keyboard focus and pointer hover", async () => {
  store.getState().makeMoves({ payload: ["e4", "e5"], mainline: true });
  store.setState((state) => {
    const e4 = state.root.children[0];
    const e5 = e4.children[0];
    return {
      root: {
        ...state.root,
        score: cp(15),
        children: [
          {
            ...e4,
            nags: [4],
            score: cp(-200),
            children: [{ ...e5, score: cp(-200) }],
          },
        ],
      },
    };
  });
  await renderReport();

  const tooltips = () =>
    [...document.querySelectorAll('[role="tooltip"]')].map((node) => node.textContent);

  const targets: { label: string; desc: string }[] = [
    { label: "Board.Analysis.Accuracy", desc: "Board.Analysis.Report.AccuracyDesc" },
    {
      label: "Board.Analysis.Report.AverageLoss",
      desc: "Board.Analysis.Report.AverageLossDesc",
    },
    {
      label: "Board.Analysis.Report.EvalDirectionLabel",
      desc: "Board.Analysis.Report.EvalDirectionDesc",
    },
  ];

  for (const { label, desc } of targets) {
    const button = [...host.querySelectorAll("button")].find(
      (candidate) => candidate.textContent === label,
    )!;
    expect(button).toBeDefined();

    // Pointer hover
    await act(async () => {
      button.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      button.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    });
    await vi.waitFor(() => expect(tooltips()).toContain(desc));
    await act(async () => {
      button.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
      button.dispatchEvent(new MouseEvent("mouseleave", { bubbles: true }));
    });
    await vi.waitFor(() => expect(tooltips()).not.toContain(desc));

    // Keyboard focus
    await act(async () => button.focus());
    await vi.waitFor(() => expect(tooltips()).toContain(desc));
    await act(async () => button.blur());
    await vi.waitFor(() => expect(tooltips()).not.toContain(desc));
  }

  // Hover-open then Escape on window (not the button) closes the tooltip; mouseleave + mouseenter re-opens it.
  const accuracyButton = [...host.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === "Board.Analysis.Accuracy",
  )!;
  await act(async () => {
    accuracyButton.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    accuracyButton.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
  });
  await vi.waitFor(() => expect(tooltips()).toContain("Board.Analysis.Report.AccuracyDesc"));
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  });
  await vi.waitFor(() => expect(tooltips()).not.toContain("Board.Analysis.Report.AccuracyDesc"));
  await act(async () => {
    accuracyButton.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
    accuracyButton.dispatchEvent(new MouseEvent("mouseleave", { bubbles: true }));
  });
  await act(async () => {
    accuracyButton.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    accuracyButton.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
  });
  await vi.waitFor(() => expect(tooltips()).toContain("Board.Analysis.Report.AccuracyDesc"));
  await act(async () => {
    accuracyButton.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
    accuracyButton.dispatchEvent(new MouseEvent("mouseleave", { bubbles: true }));
  });

  // Focus-open, Escape on the button itself closes it, then blur + new focus re-opens it.
  await act(async () => accuracyButton.focus());
  await vi.waitFor(() => expect(tooltips()).toContain("Board.Analysis.Report.AccuracyDesc"));
  await act(async () => {
    accuracyButton.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  await vi.waitFor(() => expect(tooltips()).not.toContain("Board.Analysis.Report.AccuracyDesc"));
  await act(async () => accuracyButton.blur());
  await act(async () => accuracyButton.focus());
  await vi.waitFor(() => expect(tooltips()).toContain("Board.Analysis.Report.AccuracyDesc"));
  await act(async () => accuracyButton.blur());
});

test("TimeStrip hides below half clocked moves, renders from half, omits spent=null bars, shows tooltip, and navigates on click", async () => {
  // 4 moves, only 1 clocked -> 25% < 50% -> absent.
  store.getState().makeMoves({ payload: ["e4", "e5", "Nf3", "Nc6"], mainline: true });
  store.setState((state) => {
    const e4 = state.root.children[0];
    return {
      headers: { ...state.headers, time_control: "300+0" },
      root: {
        ...state.root,
        children: [{ ...e4, clock: 295 }],
      },
    };
  });
  let state = store.getState();
  let usage = getMoveTimeUsage(state.root, state.headers);
  expect(usage.showTimeStrip).toBe(false);

  const onSelectMove = vi.fn();
  await act(async () => {
    root.render(
      <MantineProvider>
        <TimeStrip
          usage={usage}
          paths={[[0], [0, 0], [0, 0, 0], [0, 0, 0, 0]]}
          currentPosition={[]}
          onSelectMove={onSelectMove}
        />
      </MantineProvider>,
    );
  });
  expect(host.querySelector('[data-testid="report-time-strip"]')).toBeNull();

  // Add clocks on moves 2 and 3 (3/4 = 75% >= 50%), with move 2 adding time (clock > prev) -> spent=null -> no bar for move 2.
  store.setState((prev) => {
    const e4 = prev.root.children[0];
    const e5 = e4.children[0];
    const nf3 = e5.children[0];
    return {
      root: {
        ...prev.root,
        children: [
          {
            ...e4,
            clock: 290, // spent = 10
            children: [
              {
                ...e5,
                clock: 320, // rose above 300 base -> spent = null
                children: [
                  {
                    ...nf3,
                    clock: 25, // spent = 265, <= 30s -> time trouble
                  },
                ],
              },
            ],
          },
        ],
      },
    };
  });
  state = store.getState();
  usage = getMoveTimeUsage(state.root, state.headers);
  expect(usage.showTimeStrip).toBe(true);

  await act(async () => {
    root.render(
      <MantineProvider>
        <TimeStrip
          usage={usage}
          paths={[[0], [0, 0], [0, 0, 0], [0, 0, 0, 0]]}
          currentPosition={[]}
          onSelectMove={onSelectMove}
        />
      </MantineProvider>,
    );
  });

  const strip = host.querySelector('[data-testid="report-time-strip"]');
  expect(strip).not.toBeNull();
  const slots = strip!.querySelectorAll(":scope > div > div");
  expect(slots).toHaveLength(4);
  expect(strip!.querySelectorAll('[aria-hidden="true"]')).toHaveLength(2);
  const bars = [...host.querySelectorAll<HTMLButtonElement>('[data-testid="report-time-bar"]')];
  // Only move 1 (e4) and move 3 (Nf3) have valid spent !== null.
  expect(bars).toHaveLength(2);
  expect(bars[0].getAttribute("data-side")).toBe("white");
  expect(bars[1].getAttribute("data-time-trouble")).toBe("true");
  expect(bars[0].hasAttribute("data-current")).toBe(false);
  expect(bars[1].hasAttribute("data-current")).toBe(false);

  await act(async () => {
    bars[1].dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    bars[1].dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
  });
  await vi.waitFor(() => {
    const tip = document.querySelector('[role="tooltip"]')?.textContent ?? "";
    expect(tip).toContain("2. Nf3");
    expect(tip).toContain("Board.Analysis.Report.TimeSpent");
    expect(tip).toContain("Board.Analysis.Report.TimeLeft");
    expect(tip).toContain("Board.Analysis.Report.Tag.TimeTrouble");
  });

  await act(async () => bars[1].click());
  expect(onSelectMove).toHaveBeenCalledWith([0, 0, 0]);

  // Re-render with currentPosition equal to the first bar's path marks only that bar current.
  await act(async () => {
    root.render(
      <MantineProvider>
        <TimeStrip
          usage={usage}
          paths={[[0], [0, 0], [0, 0, 0], [0, 0, 0, 0]]}
          currentPosition={[0]}
          onSelectMove={onSelectMove}
        />
      </MantineProvider>,
    );
  });
  const updatedBars = [
    ...host.querySelectorAll<HTMLButtonElement>('[data-testid="report-time-bar"]'),
  ];
  expect(updatedBars[0].getAttribute("data-current")).toBe("true");
  expect(updatedBars[1].hasAttribute("data-current")).toBe(false);
});

const catalogues = import.meta.glob<{ translation: Record<string, string> }>(
  "../../../translation/*.json",
  { eager: true, import: "default" },
);

const phase2To5FiniteKeys = [
  "Board.Analysis.Opening",
  "Board.Analysis.Middlegame",
  "Board.Analysis.Endgame",
  "Board.Analysis.Accuracy",
  "Board.Analysis.Report.AccuracyDesc",
  "Board.Analysis.Report.AverageLoss",
  "Board.Analysis.Report.AverageLossDesc",
  "Board.Analysis.Report.EvalDirectionDesc",
  "Board.Analysis.Report.EvalDirectionLabel",
  "Board.Analysis.Report.Evaluation",
  "Board.Analysis.Report.EvaluationDesc",
  "Board.Analysis.Report.Explain",
  "Board.Analysis.Report.ExplainQuestion.Ask",
  "Board.Analysis.Report.ExplainQuestion.AskWithBetter",
  "Board.Analysis.Report.ExplainQuestion.Played",
  "Board.Analysis.Report.ExplainQuestion.PlayedWithKind",
  "Board.Analysis.Report.FilterBlack",
  "Board.Analysis.Report.FilterBoth",
  "Board.Analysis.Report.FilterSide",
  "Board.Analysis.Report.FilterWhite",
  "Board.Analysis.Report.Metric",
  "Board.Analysis.Report.MistakeKind.AllowsMate",
  "Board.Analysis.Report.MistakeKind.Decisive",
  "Board.Analysis.Report.MistakeKind.LosesMaterial",
  "Board.Analysis.Report.MistakeKind.MissesMate",
  "Board.Analysis.Report.MistakeKind.MissesMaterial",
  "Board.Analysis.Report.MistakeKind.MissesWin",
  "Board.Analysis.Report.NextMoment",
  "Board.Analysis.Report.NoMomentsForSide",
  "Board.Analysis.Report.Novelty",
  "Board.Analysis.Report.Opening",
  "Board.Analysis.Report.PreviousMoment",
  "Board.Analysis.Report.Provenance",
  "Board.Analysis.Report.Regenerate",
  "Board.Analysis.Report.RepertoireFollowed",
  "Board.Analysis.Report.RepertoireIncomplete",
  "Board.Analysis.Report.RepertoireLeft",
  "Board.Analysis.Report.Summary.BalancedAgainBlack",
  "Board.Analysis.Report.Summary.BalancedAgainWhite",
  "Board.Analysis.Report.Summary.StayedBalanced",
  "Board.Analysis.Report.Summary.TookLeadBlack",
  "Board.Analysis.Report.Summary.TookLeadWhite",
  "Board.Analysis.Report.Summary.TurnedGameBlack",
  "Board.Analysis.Report.Summary.TurnedGameWhite",
  "Board.Analysis.Report.Tag.TimeTrouble",
  "Board.Analysis.Report.Tag.TurningPoint",
  "Board.Analysis.Report.TimeBarLabel",
  "Board.Analysis.Report.TimeLeft",
  "Board.Analysis.Report.TimeSpent",
  "Board.Analysis.Report.TimeUsage",
  "Board.Analysis.Report.WinChance",
  "Board.Analysis.Report.WinChanceDesc",
] as const;

test("key moments: selection goes to before-path, previous/next walk filtered rows, filter uses halfMoves, and row/chart highlight each other", async () => {
  // 1. e4 e5 2. Qh5?! Nc6 3. Bc4 Nf6?? 4. Qxf7#
  store
    .getState()
    .makeMoves({ payload: ["e4", "e5", "Qh5", "Nc6", "Bc4", "Nf6", "Qxf7#"], mainline: true });
  // Add a child variation g6 at the position before 3...Nf6 so its better line is a link.
  store.getState().goToMove([0, 0, 0, 0, 0]);
  store.getState().makeMoves({ payload: ["g6"] });
  store.getState().goToStart();

  const createdAt = Date.UTC(2026, 10, 27);
  store.setState((state) => {
    const e4 = state.root.children[0];
    const e5 = e4.children[0];
    const qh5 = e5.children[0];
    const nc6 = qh5.children[0];
    const bc4 = nc6.children[0];
    const [nf6, g6] = bc4.children;
    const qxf7 = nf6.children[0];
    const updatedRoot = {
      ...state.root,
      score: cp(20),
      children: [
        {
          ...e4,
          score: cp(20),
          clock: 295,
          children: [
            {
              ...e5,
              score: cp(25),
              clock: 290,
              children: [
                {
                  ...qh5,
                  nags: [6], // ?!
                  score: cp(-60),
                  clock: 280,
                  children: [
                    {
                      ...nc6,
                      score: cp(-40),
                      clock: 270,
                      children: [
                        {
                          ...bc4,
                          score: cp(-50),
                          clock: 260,
                          children: [
                            {
                              ...nf6,
                              nags: [4], // ??
                              score: { value: { type: "mate" as const, value: 1 }, wdl: null },
                              clock: 20, // <= 30s -> time trouble
                              children: [{ ...qxf7, score: null, clock: 255 }],
                            },
                            g6,
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    return {
      headers: { ...state.headers, time_control: "300+3" },
      root: updatedRoot,
      report: {
        ...state.report,
        summary: {
          engine: "Stockfish 17",
          goMode: { t: "Time" as const, c: 500 },
          createdAt,
          missingEvaluations: 0,
          novelty: "notRequested" as const,
          fingerprint: reportRootFingerprint(updatedRoot.fen, getMainLine(updatedRoot)),
          facts: [
            { mainlineIndex: 3, kind: "decisive" as const, betterLine: ["Nf3", "Nc6"] },
            { mainlineIndex: 6, kind: "allowsMate" as const, betterLine: ["g6", "Qf3"] },
          ],
        },
      },
    };
  });

  await renderReport();

  const rows = () => [...host.querySelectorAll<HTMLLIElement>('[data-testid="report-key-moment"]')];
  expect(rows()).toHaveLength(2);
  expect(rows()[0].textContent).toContain("2. Qh5?!");
  expect(rows()[0].textContent).toContain("Board.Analysis.Report.MistakeKind.Decisive");
  expect(rows()[0].textContent).toContain("Board.Analysis.Report.BetterMove:Nf3 Nc6");
  // No child Nf3 before 2.Qh5 -> better line is plain text (only 1 button in row 0).
  expect(rows()[0].querySelectorAll("button")).toHaveLength(1);

  expect(rows()[1].textContent).toContain("3... Nf6??");
  expect(rows()[1].textContent).toContain("Board.Analysis.Report.MistakeKind.AllowsMate");
  expect(rows()[1].textContent).toContain("Board.Analysis.Report.Tag.TurningPoint");
  expect(rows()[1].textContent).toContain("Board.Analysis.Report.Tag.TimeTrouble");
  expect(rows()[1].textContent).toContain("Board.Analysis.Report.BetterMove:g6 4. Qf3");
  // Child g6 exists before 3...Nf6 -> better line is a link (2 buttons in row 1).
  expect(rows()[1].querySelectorAll("button")).toHaveLength(2);

  // Selecting row 0 focuses before-path [0, 0] and sets transient per-tab review focus.
  await act(async () => rows()[0].querySelector("button")!.click());
  expect(store.getState().position).toEqual([0, 0]);
  expect(rows()[0].getAttribute("data-current")).toBe("true");
  expect(rows()[1].hasAttribute("data-current")).toBe(false);
  expect(atoms.get(reviewFocusFamily("tab-1"))).toEqual({
    documentId: store.getState().documentId,
    path: [0, 0],
    fen: store.getState().currentNode().fen,
    summaryCreatedAt: createdAt,
    playedSan: "Qh5",
    betterSan: "Nf3",
  });
  expect(mocks.chartProps?.highlightedMovePath).toEqual([0, 0, 0]);

  // Previous is disabled at first moment; Next moves to second moment.
  const findBtn = (label: string) =>
    [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === label)!;
  expect(findBtn("Board.Analysis.Report.PreviousMoment").disabled).toBe(true);
  expect(findBtn("Board.Analysis.Report.NextMoment").disabled).toBe(false);

  await act(async () => findBtn("Board.Analysis.Report.NextMoment").click());
  expect(store.getState().position).toEqual([0, 0, 0, 0, 0]);
  expect(rows()[1].getAttribute("data-current")).toBe("true");
  expect(findBtn("Board.Analysis.Report.NextMoment").disabled).toBe(true);
  expect(findBtn("Board.Analysis.Report.PreviousMoment").disabled).toBe(false);

  await act(async () => findBtn("Board.Analysis.Report.PreviousMoment").click());
  expect(store.getState().position).toEqual([0, 0]);
  expect(rows()[0].getAttribute("data-current")).toBe("true");

  // Hovering a row highlights its move on the chart; leaving falls back to the focused moment.
  await act(async () => {
    rows()[1].dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    rows()[1].dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
  });
  expect(mocks.chartProps?.highlightedMovePath).toEqual([0, 0, 0, 0, 0, 0]);
  await act(async () => {
    rows()[1].dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
    rows()[1].dispatchEvent(new MouseEvent("mouseleave", { bubbles: true }));
  });
  expect(mocks.chartProps?.highlightedMovePath).toEqual([0, 0, 0]);

  // Chart hovering a move highlights its row.
  await act(async () => mocks.chartProps?.onHoverMove?.([0, 0, 0, 0, 0, 0]));
  expect(rows()[1].getAttribute("data-highlighted")).toBe("true");
  expect(rows()[0].hasAttribute("data-highlighted")).toBe(false);
  await act(async () => mocks.chartProps?.onHoverMove?.(null));
  expect(rows()[1].hasAttribute("data-highlighted")).toBe(false);

  // Clicking the better-line link on row 1 navigates to the g6 child [0, 0, 0, 0, 0, 1].
  await act(async () => rows()[1].querySelectorAll("button")[1].click());
  expect(store.getState().position).toEqual([0, 0, 0, 0, 0, 1]);

  // Side filter: Black shows only 3...Nf6??, White shows only 2.Qh5?!.
  const blackRadio = host.querySelector<HTMLInputElement>('input[type="radio"][value="black"]')!;
  await act(async () => blackRadio.click());
  expect(rows()).toHaveLength(1);
  expect(rows()[0].textContent).toContain("3... Nf6??");

  const whiteRadio = host.querySelector<HTMLInputElement>('input[type="radio"][value="white"]')!;
  await act(async () => whiteRadio.click());
  expect(rows()).toHaveLength(1);
  expect(rows()[0].textContent).toContain("2. Qh5?!");
});

test("side filter derives mover colour from root-anchored halfMoves on a Black-to-move start FEN", async () => {
  // Position after 1. e4, Black to move (halfMoves starts at 1, first move e5 has halfMoves = 2 -> Black).
  store.getState().setFen("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1");
  store.getState().makeMoves({ payload: ["e5"], mainline: true });
  store.setState((state) => ({
    root: {
      ...state.root,
      score: cp(20),
      children: [{ ...state.root.children[0], nags: [4], score: cp(300) }],
    },
  }));
  store.getState().goToStart();
  await renderReport();

  const rows = () => [...host.querySelectorAll('[data-testid="report-key-moment"]')];
  expect(rows()).toHaveLength(1);

  const whiteRadio = host.querySelector<HTMLInputElement>('input[type="radio"][value="white"]')!;
  await act(async () => whiteRadio.click());
  expect(rows()).toHaveLength(0);
  expect(host.textContent).toContain("Board.Analysis.Report.NoMomentsForSide");

  const blackRadio = host.querySelector<HTMLInputElement>('input[type="radio"][value="black"]')!;
  await act(async () => blackRadio.click());
  expect(rows()).toHaveLength(1);
  expect(rows()[0].textContent).toContain("1... e5??");
});

function seedScholarsMateMoments({ markE4 = false }: { markE4?: boolean } = {}) {
  store
    .getState()
    .makeMoves({ payload: ["e4", "e5", "Qh5", "Nc6", "Bc4", "Nf6", "Qxf7#"], mainline: true });
  store.getState().goToStart();

  const createdAt = Date.UTC(2026, 10, 27);
  store.setState((state) => {
    const e4 = state.root.children[0];
    const e5 = e4.children[0];
    const qh5 = e5.children[0];
    const nc6 = qh5.children[0];
    const bc4 = nc6.children[0];
    const nf6 = bc4.children[0];
    const qxf7 = nf6.children[0];
    const updatedRoot = {
      ...state.root,
      score: cp(20),
      children: [
        {
          ...e4,
          nags: markE4 ? [2] : [],
          score: cp(20),
          children: [
            {
              ...e5,
              score: cp(25),
              children: [
                {
                  ...qh5,
                  nags: [6],
                  score: cp(-60),
                  children: [
                    {
                      ...nc6,
                      score: cp(-40),
                      children: [
                        {
                          ...bc4,
                          score: cp(-50),
                          children: [
                            {
                              ...nf6,
                              nags: [4],
                              score: { value: { type: "mate" as const, value: 1 }, wdl: null },
                              children: [{ ...qxf7, score: null }],
                            },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    return {
      root: updatedRoot,
      report: {
        ...state.report,
        summary: {
          engine: "Stockfish 17",
          goMode: { t: "Time" as const, c: 500 },
          createdAt,
          missingEvaluations: 0,
          novelty: "notRequested" as const,
          fingerprint: reportRootFingerprint(updatedRoot.fen, getMainLine(updatedRoot)),
          facts: [
            { mainlineIndex: 3, kind: "decisive" as const, betterLine: ["Nf3", "Nc6"] },
            { mainlineIndex: 6, kind: "allowsMate" as const, betterLine: ["g6", "Qf3"] },
          ],
        },
      },
    };
  });
}

test("previous/next walkthrough steps only through filtered rows and handles an unfocused filter switch", async () => {
  seedScholarsMateMoments({ markE4: true });
  await renderReport();

  const rows = () => [...host.querySelectorAll<HTMLLIElement>('[data-testid="report-key-moment"]')];
  const findBtn = (label: string) =>
    [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === label)!;
  const sideRadio = (value: "both" | "white" | "black") =>
    host.querySelector<HTMLInputElement>(`input[type="radio"][value="${value}"]`)!;

  // All three moments visible in "both": 1. e4?, 2. Qh5?!, 3... Nf6??.
  expect(rows()).toHaveLength(3);

  // Filter White: two rows (1. e4?, 2. Qh5?!).
  await act(async () => sideRadio("white").click());
  expect(rows()).toHaveLength(2);
  expect(rows()[0].textContent).toContain("1. e4?");
  expect(rows()[1].textContent).toContain("2. Qh5?!");

  // Select first White row (1. e4?, beforePath []): Next goes to 2. Qh5?! (beforePath [0, 0]), then disables.
  await act(async () => rows()[0].querySelector("button")!.click());
  expect(store.getState().position).toEqual([]);
  await act(async () => findBtn("Board.Analysis.Report.NextMoment").click());
  expect(store.getState().position).toEqual([0, 0]);
  expect(rows()[1].getAttribute("data-current")).toBe("true");
  expect(findBtn("Board.Analysis.Report.NextMoment").disabled).toBe(true);

  // Previous returns to 1. e4?.
  await act(async () => findBtn("Board.Analysis.Report.PreviousMoment").click());
  expect(store.getState().position).toEqual([]);
  expect(rows()[0].getAttribute("data-current")).toBe("true");

  // Select Black's 3... Nf6?? in "both", then filter White so currentIndex === -1.
  await act(async () => sideRadio("both").click());
  await act(async () => rows()[2].querySelector("button")!.click());
  expect(store.getState().position).toEqual([0, 0, 0, 0, 0]);
  await act(async () => sideRadio("white").click());
  expect(rows().every((r) => !r.hasAttribute("data-current"))).toBe(true);

  // From unfocused filter state: Next selects first White moment (1. e4?).
  await act(async () => findBtn("Board.Analysis.Report.NextMoment").click());
  expect(store.getState().position).toEqual([]);
  expect(rows()[0].getAttribute("data-current")).toBe("true");

  // Re-select Black's 3... Nf6??, filter White again: Previous selects last White moment (2. Qh5?!).
  await act(async () => sideRadio("both").click());
  await act(async () => rows()[2].querySelector("button")!.click());
  await act(async () => sideRadio("white").click());
  await act(async () => findBtn("Board.Analysis.Report.PreviousMoment").click());
  expect(store.getState().position).toEqual([0, 0]);
  expect(rows()[1].getAttribute("data-current")).toBe("true");
});

test("keyboard focus on a key moment row highlights its move on the chart and blur clears it", async () => {
  seedScholarsMateMoments();
  await renderReport();

  const firstRowButton = host
    .querySelector<HTMLLIElement>('[data-testid="report-key-moment"]')!
    .querySelector<HTMLButtonElement>("button")!;

  expect(mocks.chartProps?.highlightedMovePath).toBeNull();
  await act(async () => firstRowButton.focus());
  expect(mocks.chartProps?.highlightedMovePath).toEqual([0, 0, 0]);

  await act(async () => firstRowButton.blur());
  expect(mocks.chartProps?.highlightedMovePath).toBeNull();
});

test("mistake-kind labels from review facts disappear when the summary fingerprint is outdated", async () => {
  seedScholarsMateMoments();
  await renderReport();

  expect(host.textContent).toContain("Board.Analysis.Report.MistakeKind.Decisive");
  expect(host.textContent).toContain("Board.Analysis.Report.MistakeKind.AllowsMate");

  await act(async () => {
    store.setState((state) => ({
      report: {
        ...state.report,
        summary: { ...state.report.summary!, fingerprint: "different-game-fingerprint" },
      },
    }));
  });

  expect(host.textContent).not.toContain("Board.Analysis.Report.MistakeKind.Decisive");
  expect(host.textContent).not.toContain("Board.Analysis.Report.MistakeKind.AllowsMate");
});

test("ships all 16 locales", () => expect(Object.keys(catalogues)).toHaveLength(16));

test.each(Object.entries(catalogues))(
  "every phase 2 to 5 finite message resolves without fallback in %s",
  async (_path, catalogue) => {
    const instance = createInstance();
    await instance.init({
      lng: "test",
      fallbackLng: false,
      keySeparator: false,
      nsSeparator: false,
      resources: { test: catalogue },
    });
    for (const key of phase2To5FiniteKeys) {
      expect({
        key,
        value: catalogue.translation[key],
        exists: instance.exists(key),
        resolved: instance.t(key, {
          move: "1. e4",
          aheadMove: "1. e4",
          balancedMove: "2. Nf3",
          time: "5s",
          spent: "5s",
          left: "04:55",
          engine: "Stockfish",
          limit: "depth 18",
          date: "Nov 27, 2026",
          opening: "King's Pawn Game",
          played: "Qh5",
          repertoire: "Nf3, Bc4",
          file: "White Repertoire",
          kind: "Allows mate",
          before: "-0.50",
          after: "+M1",
          better: "g6 4. Qf3",
        }),
      }).toEqual({
        key,
        value: expect.stringMatching(/\S/),
        exists: true,
        resolved: expect.not.stringContaining(key),
      });
    }
  },
);

test("O6 opening block looks up the mainline-end opening, hides non-text/empty answers, links novelty, and focuses deviation/followed/partial repertoire notes", async () => {
  // 1. e4 e5 2. Qh5 (novelty NAG 146, deviation from repertoire [Nf3, Bc4]) with reportLine sibling Nf3
  store.getState().makeMoves({ payload: ["e4", "e5", "Qh5"], mainline: true });
  store.getState().goToMove([0, 0]);
  store.getState().makeMoves({ payload: ["Nf3"] });
  store.getState().goToMove([0]); // Cursor sits at 1. e4, NOT the mainline end!
  const beforeQh5Fen = store.getState().root.children[0].children[0].fen;
  const afterE4Fen = store.getState().root.children[0].fen;

  store.setState((state) => {
    const e4 = state.root.children[0];
    const e5 = e4.children[0];
    const [qh5, nf3] = e5.children;
    return {
      headers: { ...state.headers, orientation: "white" as const },
      root: {
        ...state.root,
        children: [
          {
            ...e4,
            children: [
              {
                ...e5,
                children: [
                  { ...qh5, nags: [146] },
                  { ...nf3, reportLine: true },
                ],
              },
            ],
          },
        ],
      },
    };
  });

  // 1) Opening name lookup uses mainline-end FENs (4 FENs: root, e4, e5, Qh5), not cursor (2 FENs).
  mocks.getOpeningFromFens.mockResolvedValue("King's Pawn Game");

  // 2) Settled complete repertoire snapshot with Nf3, Bc4 after 1. e4 e5.
  const ws = { id: { id: "ws-1" }, kind: "fileWorkspace" as const };
  const snapshot: RepertoireSnapshot = {
    partial: false,
    partialReason: null,
    files: [
      {
        workspaceKey: "ws-1",
        file: {
          type: "file",
          name: "White Rep",
          numGames: 1,
          lastModified: 0,
          handle: ws,
          metadata: { type: "repertoire", tags: [] },
        },
        partial: false,
        chapters: [
          {
            chapter: 0,
            headers: { orientation: "white", start: undefined, white: "", black: "", event: "" },
            nodes: [
              {
                boardState: getBoardState(store.getState().root.fen),
                parent: -1,
                san: null,
                path: [],
                halfMoves: 0,
                hasContinuation: true,
              },
              {
                boardState: getBoardState(afterE4Fen),
                parent: 0,
                san: "e4",
                path: [0],
                halfMoves: 1,
                hasContinuation: true,
              },
              {
                boardState: getBoardState(beforeQh5Fen),
                parent: 1,
                san: "e5",
                path: [0, 0],
                halfMoves: 2,
                hasContinuation: true,
              },
              {
                boardState: "after-nf3",
                parent: 2,
                san: "Nf3",
                path: [0, 0, 0],
                halfMoves: 3,
                hasContinuation: false,
              },
              {
                boardState: "after-bc4",
                parent: 2,
                san: "Bc4",
                path: [0, 0, 1],
                halfMoves: 3,
                hasContinuation: false,
              },
            ],
          },
        ],
      },
    ],
  };
  atoms.set(fileWorkspaceAtom, ws);
  atoms.set(sessionsAtom, []);
  mocks.readRepertoireIndex.mockReturnValue(snapshot);

  await renderReport();
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

  // Mainline-end FEN count is 4 (root + 3 moves), even though board cursor is at [0].
  expect(mocks.getOpeningFromFens).toHaveBeenCalledTimes(1);
  expect(mocks.getOpeningFromFens.mock.calls[0][0]).toHaveLength(4);
  expect(host.querySelector('[data-testid="report-opening"]')?.textContent).toBe(
    "Board.Analysis.Report.Opening:King's Pawn Game",
  );

  // Clicking the novelty focuses its before-position ([0, 0], playedSan "Qh5", betterSan "Nf3").
  const noveltyBtn = host.querySelector<HTMLButtonElement>('[data-testid="report-novelty"]')!;
  expect(noveltyBtn.textContent).toBe("Board.Analysis.Report.Novelty:2. Qh5");
  await act(async () => noveltyBtn.click());
  expect(store.getState().position).toEqual([0, 0]);
  expect(atoms.get(reviewFocusFamily("tab-1"))).toEqual({
    documentId: store.getState().documentId,
    path: [0, 0],
    fen: beforeQh5Fen,
    summaryCreatedAt: null,
    playedSan: "Qh5",
    betterSan: "Nf3",
  });

  // Clicking the repertoire deviation focuses before-path with first repertoire SAN as betterSan.
  const devBtn = host.querySelector<HTMLButtonElement>('[data-testid="report-repertoire-note"]')!;
  expect(devBtn.getAttribute("data-repertoire-kind")).toBe("deviation");
  expect(devBtn.textContent).toBe("Board.Analysis.Report.RepertoireLeft:2:Qh5:Nf3, Bc4:White Rep");
  await act(async () => store.getState().goToStart());
  await act(async () => devBtn.click());
  expect(store.getState().position).toEqual([0, 0]);
  expect(atoms.get(reviewFocusFamily("tab-1"))).toEqual({
    documentId: store.getState().documentId,
    path: [0, 0],
    fen: beforeQh5Fen,
    summaryCreatedAt: null,
    playedSan: "Qh5",
    betterSan: "Nf3",
  });

  // Followed repertoire link focuses before-path with playedSan and betterSan null.
  await act(async () => {
    store.setState((state) => {
      const e4 = state.root.children[0];
      const e5 = e4.children[0];
      const qh5 = e5.children[0];
      return {
        root: {
          ...state.root,
          children: [{ ...e4, children: [{ ...e5, children: [{ ...qh5, san: "Nf3" }] }] }],
        },
      };
    });
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  const followedBtn = host.querySelector<HTMLButtonElement>(
    '[data-testid="report-repertoire-note"]',
  )!;
  expect(followedBtn.getAttribute("data-repertoire-kind")).toBe("followed");
  expect(followedBtn.textContent).toBe("Board.Analysis.Report.RepertoireFollowed:2");
  await act(async () => store.getState().goToStart());
  await act(async () => followedBtn.click());
  expect(store.getState().position).toEqual([0, 0]);
  expect(atoms.get(reviewFocusFamily("tab-1"))).toEqual({
    documentId: store.getState().documentId,
    path: [0, 0],
    fen: beforeQh5Fen,
    summaryCreatedAt: null,
    playedSan: "Nf3",
    betterSan: null,
  });

  // Partial index hides deviation/followed and shows the muted incomplete-index line.
  mocks.readRepertoireIndex.mockReturnValue({
    ...snapshot,
    partial: true,
    partialReason: "bound-reached",
  });
  await act(async () => {
    atoms.set(fileWorkspaceAtom, { id: { id: "ws-2" }, kind: "fileWorkspace" });
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  const partialEl = host.querySelector('[data-testid="report-repertoire-note"]')!;
  expect(partialEl.getAttribute("data-repertoire-kind")).toBe("partial");
  expect(partialEl.textContent).toBe("Board.Analysis.Report.RepertoireIncomplete");

  // Non-text opening answer + no novelty + no repertoire => opening block omitted completely.
  openingNameCache.clear();
  mocks.getOpeningFromFens.mockResolvedValue([]);
  mocks.readRepertoireIndex.mockReturnValue(null);
  await act(async () => {
    store.setState((state) => {
      const e4 = state.root.children[0];
      const e5 = e4.children[0];
      const nf3 = e5.children[0];
      return {
        root: {
          ...state.root,
          children: [{ ...e4, children: [{ ...e5, children: [{ ...nf3, nags: [] }] }] }],
        },
      };
    });
    atoms.set(fileWorkspaceAtom, null);
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(host.querySelector('[data-testid="report-opening-block"]')).toBeNull();
});

test("O7 Explain action is hidden without a connection, and when available focuses the moment, posts the request and shows the Coach tab", async () => {
  // 1. e4! e5 2. Qh5?! Nc6 3. Bc4 Nf6?? 4. Qxf7#
  seedScholarsMateMoments();
  // Mark 1. e4 as Good (!) so we verify Explain is NOT rendered for positive marks.
  store.setState((state) => {
    const e4 = state.root.children[0];
    return {
      root: {
        ...state.root,
        children: [{ ...e4, nags: [1] }],
      },
    };
  });

  // Without a connection (`assistantAvailableAtom` false): no Explain button anywhere.
  await renderReport();
  expect(atoms.get(assistantAvailableAtom)).toBe(false);
  const explainButtons = () =>
    [...host.querySelectorAll<HTMLButtonElement>("button")].filter(
      (b) => b.textContent === "Board.Analysis.Report.Explain",
    );
  expect(explainButtons()).toHaveLength(0);

  // Enable Coach + connection so `assistantAvailableAtom` becomes true.
  mocks.coachAvailable.mockResolvedValue(true);
  mocks.coachHasConnection.mockResolvedValue(true);
  // Fresh atom store so `coachAvailableAtom` reads the mocked true value.
  atoms = createAtomStore();
  atoms.set(tabFamily("tab-1"), "report");
  atoms.get(coachEnabledAtom);
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  await act(async () => {
    await atoms.set(refreshAssistantAvailabilityAtom);
  });
  expect(atoms.get(assistantAvailableAtom)).toBe(true);

  await renderReport();

  const rows = [...host.querySelectorAll<HTMLLIElement>('[data-testid="report-key-moment"]')];
  expect(rows).toHaveLength(3);
  // Row 0 is 1. e4! -> no Explain button; Row 1 (2. Qh5?!) and Row 2 (3... Nf6??) each have one.
  expect(
    [...rows[0].querySelectorAll("button")].filter(
      (b) => b.textContent === "Board.Analysis.Report.Explain",
    ),
  ).toHaveLength(0);
  expect(explainButtons()).toHaveLength(2);

  // Click Explain on 3... Nf6?? (row 2): focuses before-path [0,0,0,0,0], sets request, opens Coach tab.
  const nf6BeforeFen =
    store.getState().root.children[0].children[0].children[0].children[0].children[0].fen;
  const nf6ExplainBtn = [...rows[2].querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent === "Board.Analysis.Report.Explain",
  )!;
  await act(async () => nf6ExplainBtn.click());

  expect(store.getState().position).toEqual([0, 0, 0, 0, 0]);
  expect(atoms.get(reviewFocusFamily("tab-1"))).toEqual({
    documentId: store.getState().documentId,
    path: [0, 0, 0, 0, 0],
    fen: nf6BeforeFen,
    summaryCreatedAt: store.getState().report.summary?.createdAt ?? null,
    playedSan: "Nf6",
    betterSan: "g6",
  });
  const firstRequest = atoms.get(coachExplainRequestFamily("tab-1"));
  expect(firstRequest).not.toBeNull();
  expect(firstRequest!.documentId).toBe(store.getState().documentId);
  expect(firstRequest!.fen).toBe(nf6BeforeFen);
  expect(firstRequest!.question).toContain("Board.Analysis.Report.ExplainQuestion.PlayedWithKind");
  expect(firstRequest!.question).toContain("3... Nf6??");
  expect(firstRequest!.question).toContain("Board.Analysis.Report.MistakeKind.AllowsMate");
  expect(firstRequest!.question).toContain("Board.Analysis.Report.ExplainQuestion.AskWithBetter");
  expect(firstRequest!.question).toContain("g6 4. Qf3");
  expect(firstRequest!.question.length).toBeLessThan(4000);
  expect(atoms.get(tabFamily("tab-1"))).toBe("coach");

  // A second Explain click replaces the previous request with a new unique id.
  const qh5ExplainBtn = [...rows[1].querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent === "Board.Analysis.Report.Explain",
  )!;
  await act(async () => qh5ExplainBtn.click());
  const secondRequest = atoms.get(coachExplainRequestFamily("tab-1"));
  expect(secondRequest).not.toBeNull();
  expect(secondRequest!.id).not.toBe(firstRequest!.id);
  expect(secondRequest!.question).toContain("2. Qh5?!");
  expect(store.getState().position).toEqual([0, 0]);
});

test("O7 buildExplainQuestion handles missing mistakeKind, empty betterLine, missing evals, and formatted evals", () => {
  const t = mocks.t as unknown as TFunction;
  const baseItem: KeyMomentItem = {
    moment: {
      path: [0, 0, 0],
      halfMoves: 3,
      san: "Qh5",
      annotation: "?!",
      before: null,
      after: null,
      betterMove: null,
    },
    mainlineIndex: 3,
    color: "white",
    beforePath: [0, 0],
    beforeFen: "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2",
    mistakeKind: null,
    betterLine: [],
    betterChildPath: null,
    isTurningPoint: false,
    inTimeTrouble: false,
  };

  // No mistakeKind, empty betterLine, missing before/after evals -> Played + Ask + "–" placeholders.
  const minimal = buildExplainQuestion(t, baseItem);
  expect(minimal).toContain("Board.Analysis.Report.ExplainQuestion.Played:");
  expect(minimal).not.toContain("Board.Analysis.Report.ExplainQuestion.PlayedWithKind");
  expect(minimal).toContain("2. Qh5?!");
  expect(minimal).toContain(":–:–");
  expect(minimal).toMatch(/Board\.Analysis\.Report\.ExplainQuestion\.Ask$/);
  expect(minimal).not.toContain("Board.Analysis.Report.ExplainQuestion.AskWithBetter");

  // Present evals, mistakeKind, and betterLine -> formatted formatScore strings + PlayedWithKind + AskWithBetter.
  const beforeScore = cp(-50);
  const afterScore: Score = { value: { type: "mate", value: 1 }, wdl: null };
  const full = buildExplainQuestion(t, {
    ...baseItem,
    moment: { ...baseItem.moment, before: beforeScore, after: afterScore },
    mistakeKind: "allowsMate",
    betterLine: ["Nf3", "Nc6"],
  });
  expect(full).toContain("Board.Analysis.Report.ExplainQuestion.PlayedWithKind:");
  expect(full).toContain("Board.Analysis.Report.MistakeKind.AllowsMate");
  expect(full).toContain(formatScore(beforeScore.value));
  expect(full).toContain(formatScore(afterScore.value));
  expect(full).toContain("Board.Analysis.Report.ExplainQuestion.AskWithBetter:Nf3 Nc6");
});
