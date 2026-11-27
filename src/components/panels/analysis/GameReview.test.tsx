import { MantineProvider } from "@mantine/core";
import { createInstance } from "i18next";
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
import { Scoreboard } from "./Scoreboard";
import ReportPanel from "./ReportPanel";
import { TimeStrip } from "./TimeStrip";
import type { AnnotationCounts, GameStats } from "@/utils/chess";
import { getMoveTimeUsage } from "@/utils/gameReview";
import { defaultTree } from "@/utils/treeReducer";

const zeroCounts: AnnotationCounts = {
  "!!": 0,
  "!": 0,
  "!?": 0,
  "?!": 0,
  "?": 0,
  "??": 0,
};

const mocks = vi.hoisted(() => ({
  t: (key: string, options?: Record<string, unknown>) =>
    options && "move" in options ? `${key}:${String(options.move)}` : key,
  cancelAnalysis: vi.fn(),
  getProgress: vi.fn().mockResolvedValue(null),
  notifyUnlessCancelled: vi.fn(),
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
  },
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
  default: () => <div data-testid="mock-eval-chart" />,
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
});

afterEach(async () => {
  await act(async () => root.unmount());
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
    expect(tip).toContain("Annotate.TimeTrouble");
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

const phase2FiniteKeys = [
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
  "Board.Analysis.Report.Metric",
  "Board.Analysis.Report.Provenance",
  "Board.Analysis.Report.Regenerate",
  "Board.Analysis.Report.Summary.BalancedAgainBlack",
  "Board.Analysis.Report.Summary.BalancedAgainWhite",
  "Board.Analysis.Report.Summary.StayedBalanced",
  "Board.Analysis.Report.Summary.TookLeadBlack",
  "Board.Analysis.Report.Summary.TookLeadWhite",
  "Board.Analysis.Report.Summary.TurnedGameBlack",
  "Board.Analysis.Report.Summary.TurnedGameWhite",
  "Board.Analysis.Report.TimeBarLabel",
  "Board.Analysis.Report.TimeLeft",
  "Board.Analysis.Report.TimeSpent",
  "Board.Analysis.Report.TimeUsage",
  "Board.Analysis.Report.WinChance",
  "Board.Analysis.Report.WinChanceDesc",
] as const;

test("ships all 16 locales", () => expect(Object.keys(catalogues)).toHaveLength(16));

test.each(Object.entries(catalogues))(
  "every phase 2 finite message resolves without fallback in %s",
  async (_path, catalogue) => {
    const instance = createInstance();
    await instance.init({
      lng: "test",
      fallbackLng: false,
      keySeparator: false,
      nsSeparator: false,
      resources: { test: catalogue },
    });
    for (const key of phase2FiniteKeys) {
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
