import { MantineProvider } from "@mantine/core";
import { Provider, createStore as createAtomStore } from "jotai";
import { act, cloneElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Score } from "@/bindings";
import { reportTypeAtom } from "@/state/atoms";
import { createTreeStore, type TreeStore } from "@/state/store/tree";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { catalogueI18n } from "@/tests/catalogues";
import { installResizeObserverStub } from "@/tests/resizeObserver";
import EvalChart from "./EvalChart";
import { TreeStateContext } from "./TreeStateContext";

const i18nMock = vi.hoisted(() => ({
  language: "en-US",
  t: (key: string, _options?: Record<string, unknown>) => key,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: i18nMock.t, i18n: { language: i18nMock.language } }),
}));
vi.mock("@/platform/native", () => ({ platform: () => "linux", warn: vi.fn(), error: vi.fn() }));
vi.mock("@/utils/sound", () => ({ playSound: vi.fn() }));

// Mantine AreaChart spreads resolved areaProps into both the filled Area and the dots Area
// for each series. The dots layer is rendered because withDots defaults to true.
// The tooltip is rendered as recharts would while the first point is hovered.
vi.mock("@mantine/charts", () => ({
  AreaChart: ({
    data,
    series,
    referenceLines,
    areaProps,
    areaChartProps,
    type,
    tooltipProps,
  }: any) => (
    <div
      data-chart-type={type}
      onMouseMove={(e) =>
        areaChartProps?.onMouseMove?.({
          activeLabel: (e.target as HTMLElement).getAttribute("data-hover-label") ?? data[0]?.name,
        })
      }
      onMouseLeave={() => areaChartProps?.onMouseLeave?.()}
    >
      <div data-tooltip>
        {tooltipProps.content({ active: true, payload: [{ payload: data[0] }] })}
      </div>
      {referenceLines.map((line: any, index: number) => (
        <div
          key={index}
          data-reference-line
          data-x={line.x}
          data-y={line.y}
          data-label={line.label}
          data-label-position={line.labelPosition}
        />
      ))}
      {series.map((series: any) => (
        <div key={series.name} data-series={series.name}>
          {["area", "dots"].map((layer) => {
            const resolved = typeof areaProps === "function" ? areaProps(series) : areaProps;
            return (
              <div
                key={layer}
                data-layer={layer}
                data-animation-active={String(resolved?.isAnimationActive)}
              >
                {data.map((point: any, index: number) => (
                  <svg key={point.name} data-point={point.name} data-y-value={point.yValue}>
                    {resolved?.dot &&
                      cloneElement(resolved.dot, { payload: point, cx: index * 10, cy: 10 })}
                  </svg>
                ))}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  ),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
installMatchMediaStub();
installResizeObserverStub();

let host: HTMLDivElement;
let root: Root;
let store: TreeStore;
let atoms: ReturnType<typeof createAtomStore>;

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  store = createTreeStore();
  store.getState().makeMove({ payload: "e4" });
  store.getState().makeMove({ payload: "e5" });
  const score: Score = { value: { type: "cp", value: 30 }, wdl: [500, 300, 200] };
  store.setState((state) => {
    const first = state.root.children[0];
    const second = first.children[0];
    return {
      root: {
        ...state.root,
        score,
        children: [
          {
            ...first,
            score,
            nags: [1],
            // Material snapshots cross the real phase thresholds: eight pieces, then four.
            fen: "r1b1kb1r/pppppppp/8/8/4P3/8/PPPP1PPP/R1B1KB1R b KQkq - 0 1",
            children: [
              {
                ...second,
                score,
                fen: "r3k2r/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/R3K2R w KQkq - 0 2",
              },
            ],
          },
        ],
      },
    };
  });
  atoms = createAtomStore();
  atoms.set(reportTypeAtom, "CP");
});

afterEach(async () => {
  i18nMock.language = "en-US";
  i18nMock.t = (key: string) => key;
  await act(async () => root.unmount());
  host.remove();
});

async function renderChart(props?: {
  highlightedMovePath?: number[] | null;
  onHoverMove?: (movePath: number[] | null) => void;
}) {
  await act(async () =>
    root.render(
      <MantineProvider>
        <Provider store={atoms}>
          <TreeStateContext.Provider value={store}>
            <EvalChart isAnalysing={false} {...props} />
          </TreeStateContext.Provider>
        </Provider>
      </MantineProvider>,
    ),
  );
}

function referenceLines() {
  return [...host.querySelectorAll("[data-reference-line]")].map((line) => ({
    x: line.getAttribute("data-x"),
    y: line.getAttribute("data-y"),
    label: line.getAttribute("data-label"),
    labelPosition: line.getAttribute("data-label-position"),
  }));
}

const expectedSharedReferenceLines = [
  { x: "1... e5", y: null, label: null, labelPosition: null },
  { x: "1. e4!", y: null, label: "Board.Analysis.Middlegame", labelPosition: "insideTopLeft" },
  { x: "1... e5", y: null, label: "Board.Analysis.Endgame", labelPosition: "insideTopLeft" },
];

const expectedCpReferenceLines = [
  { x: null, y: "0", label: null, labelPosition: null },
  ...expectedSharedReferenceLines,
];

test("CP renders zero line, both phase labels inside the chart and one annotation dot per layer", async () => {
  await renderChart();
  expect(host.querySelector("[data-chart-type]")?.getAttribute("data-chart-type")).toBe("split");
  expect(referenceLines()).toEqual(expectedCpReferenceLines);
  expect(host.querySelectorAll("svg circle")).toHaveLength(2);
  const layers = [...host.querySelectorAll('[data-series="yValue"] [data-layer]')];
  expect(layers.map((layer) => layer.getAttribute("data-layer"))).toEqual(["area", "dots"]);
  for (const layer of layers) {
    expect(layer.querySelectorAll("circle")).toHaveLength(1);
    expect(layer.querySelectorAll('[data-point="1. e4!"] circle')).toHaveLength(1);
  }
});

test("switching to WDL omits the zero line and preserves the current, middlegame and endgame reference lines", async () => {
  await renderChart();
  expect(referenceLines()).toEqual(expectedCpReferenceLines);
  await act(async () => atoms.set(reportTypeAtom, "WDL"));
  expect(host.querySelector("[data-chart-type]")?.getAttribute("data-chart-type")).toBe("percent");
  expect(referenceLines()).toEqual(expectedSharedReferenceLines);
});

test("a live engine score is plotted ahead of the saved score", async () => {
  store.setState((state) => {
    const first = state.root.children[0];
    return {
      root: {
        ...state.root,
        children: [{ ...first, engineScore: { value: { type: "mate", value: -2 }, wdl: null } }],
      },
    };
  });
  await renderChart();
  expect(host.querySelector('[data-point="1. e4!"]')?.getAttribute("data-y-value")).toBe("-1");
});

test("dtz tablebase scores plot as decisive wins and losses", async () => {
  store.getState().makeMove({ payload: "d4" });
  store.setState((state) => {
    const first = state.root.children[0];
    const second = first.children[0];
    const third = second.children[0];
    return {
      root: {
        ...state.root,
        children: [
          {
            ...first,
            score: { value: { type: "dtz", value: 12 }, wdl: null },
            children: [
              {
                ...second,
                score: { value: { type: "dtz", value: -5 }, wdl: null },
                children: [
                  {
                    ...third,
                    score: { value: { type: "dtz", value: 0 }, wdl: null },
                  },
                ],
              },
            ],
          },
        ],
      },
    };
  });
  await renderChart();
  expect(host.querySelector('[data-point="1. e4!"]')?.getAttribute("data-y-value")).toBe("1");
  expect(host.querySelector('[data-point="1... e5"]')?.getAttribute("data-y-value")).toBe("-1");
  expect(host.querySelector('[data-point="2. d4"]')?.getAttribute("data-y-value")).toBe("0");
});

test("WDL disables animation on every layer and renders annotation dots on White only", async () => {
  await renderChart();
  await act(async () => atoms.set(reportTypeAtom, "WDL"));
  const series = [...host.querySelectorAll("[data-series]")];
  expect(series.map((area) => area.getAttribute("data-series"))).toEqual([
    "White",
    "Draw",
    "Black",
  ]);
  for (const area of series) {
    const layers = [...area.querySelectorAll("[data-layer]")];
    expect(layers.map((layer) => layer.getAttribute("data-layer"))).toEqual(["area", "dots"]);
    for (const layer of layers) {
      expect(layer.getAttribute("data-animation-active")).toBe("false");
      const dotCount = area.getAttribute("data-series") === "White" ? 1 : 0;
      expect(layer.querySelectorAll("circle")).toHaveLength(dotCount);
      expect(layer.querySelectorAll('[data-point="1. e4!"] circle')).toHaveLength(dotCount);
    }
  }
  expect(host.querySelectorAll("svg circle")).toHaveLength(2);
  expect(
    host.querySelectorAll('[data-series="Draw"] circle, [data-series="Black"] circle'),
  ).toHaveLength(0);
});

function tooltipLines() {
  return [...host.querySelectorAll("[data-tooltip] p")].map((line) => line.textContent);
}

test("the WDL tooltip shows one translated, locale-formatted line per outcome", async () => {
  const translator = await catalogueI18n("de-DE");
  i18nMock.language = "de-DE";
  i18nMock.t = (key, options) => translator.t(key, options);
  const score: Score = { value: { type: "cp", value: 30 }, wdl: [453, 300, 247] };
  store.setState((state) => ({
    root: { ...state.root, children: [{ ...state.root.children[0], score }] },
  }));
  await renderChart();
  await act(async () => atoms.set(reportTypeAtom, "WDL"));
  const percent = (value: number) =>
    new Intl.NumberFormat("de-DE", { style: "percent", maximumFractionDigits: 1 }).format(value);
  expect(tooltipLines()).toEqual([
    "1. e4!",
    `Weiß: ${percent(0.453)}`,
    `Remis: ${percent(0.3)}`,
    `Schwarz: ${percent(0.247)}`,
  ]);
});

test("the Evaluation / Win chance control keeps CP/WDL stored values and shows O8 explanations on hover and focus", async () => {
  await renderChart();
  const control = host.querySelector('[aria-label="Board.Analysis.Report.ChartType"]');
  expect(control).not.toBeNull();
  expect(control!.textContent).toContain("Board.Analysis.Report.Evaluation");
  expect(control!.textContent).toContain("Board.Analysis.Report.WinChance");

  const radios = [...host.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
  expect(radios.map((radio) => radio.value)).toEqual(["CP", "WDL"]);

  await act(async () => radios[1].click());
  expect(atoms.get(reportTypeAtom)).toBe("WDL");
  await act(async () => radios[0].click());
  expect(atoms.get(reportTypeAtom)).toBe("CP");

  const tooltips = () =>
    [...document.querySelectorAll('[role="tooltip"]')].map((node) => node.textContent);

  // Hover on Evaluation label, then verify mouseleave closes it.
  const cpLabel = host.querySelector<HTMLElement>('[data-chart-toggle="CP"]')!;
  await act(async () => {
    cpLabel.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    cpLabel.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
  });
  await vi.waitFor(() => expect(tooltips()).toContain("Board.Analysis.Report.EvaluationDesc"));
  await act(async () => {
    cpLabel.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
    cpLabel.dispatchEvent(new MouseEvent("mouseleave", { bubbles: true }));
  });
  await vi.waitFor(() => expect(tooltips()).not.toContain("Board.Analysis.Report.EvaluationDesc"));

  // Focus on Win chance radio, dismiss with Escape on the radio (bubbles to SegmentedControl onKeyDownCapture),
  // then blur + re-focus to verify it re-opens.
  await act(async () => radios[1].focus());
  await vi.waitFor(() => expect(tooltips()).toContain("Board.Analysis.Report.WinChanceDesc"));
  await act(async () => {
    radios[1].dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  await vi.waitFor(() => expect(tooltips()).not.toContain("Board.Analysis.Report.WinChanceDesc"));
  await act(async () => radios[1].blur());
  await act(async () => radios[1].focus());
  await vi.waitFor(() => expect(tooltips()).toContain("Board.Analysis.Report.WinChanceDesc"));

  // Focusing the Evaluation (CP) radio while Win chance is focus-open switches to EvaluationDesc and closes WinChanceDesc.
  await act(async () => radios[0].focus());
  await vi.waitFor(() => {
    expect(tooltips()).toContain("Board.Analysis.Report.EvaluationDesc");
    expect(tooltips()).not.toContain("Board.Analysis.Report.WinChanceDesc");
  });
  await act(async () => radios[0].blur());
  await vi.waitFor(() => expect(tooltips()).not.toContain("Board.Analysis.Report.EvaluationDesc"));

  // Hover-open Evaluation, Escape on window closes it, then mouseleave + new mouseenter re-opens it.
  await act(async () => {
    cpLabel.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    cpLabel.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
  });
  await vi.waitFor(() => expect(tooltips()).toContain("Board.Analysis.Report.EvaluationDesc"));
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  });
  await vi.waitFor(() => expect(tooltips()).not.toContain("Board.Analysis.Report.EvaluationDesc"));
  await act(async () => {
    cpLabel.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
    cpLabel.dispatchEvent(new MouseEvent("mouseleave", { bubbles: true }));
  });
  await act(async () => {
    cpLabel.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    cpLabel.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
  });
  await vi.waitFor(() => expect(tooltips()).toContain("Board.Analysis.Report.EvaluationDesc"));
  await act(async () => {
    cpLabel.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
    cpLabel.dispatchEvent(new MouseEvent("mouseleave", { bubbles: true }));
  });
});

test("highlightedMovePath highlights an unannotated move in CP and WDL modes and onHoverMove deduplicates and clears", async () => {
  const onHoverMove = vi.fn();
  // [0, 0] is "1... e5", which has no NAG annotations.
  await renderChart({ highlightedMovePath: [0, 0], onHoverMove });

  expect(referenceLines().some((line) => line.x === "1... e5")).toBe(true);
  expect(
    host.querySelectorAll('[data-point="1... e5"] circle[data-highlighted="true"]'),
  ).toHaveLength(2);

  // Same highlight works in WDL mode.
  await act(async () => atoms.set(reportTypeAtom, "WDL"));
  expect(referenceLines().some((line) => line.x === "1... e5")).toBe(true);
  expect(
    host.querySelectorAll(
      '[data-series="White"] [data-point="1... e5"] circle[data-highlighted="true"]',
    ),
  ).toHaveLength(2);

  // Hover on a non-first point ("1... e5"), repeat same point (deduped), then non-matching label -> null.
  const e5Point = host.querySelector<HTMLElement>('[data-series="White"] [data-point="1... e5"]')!;
  e5Point.setAttribute("data-hover-label", "1... e5");
  await act(async () => {
    e5Point.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
  });
  expect(onHoverMove).toHaveBeenCalledTimes(1);
  expect(onHoverMove).toHaveBeenCalledWith([0, 0]);

  await act(async () => {
    e5Point.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
  });
  expect(onHoverMove).toHaveBeenCalledTimes(1);

  e5Point.setAttribute("data-hover-label", "nonexistent move");
  await act(async () => {
    e5Point.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
  });
  expect(onHoverMove).toHaveBeenCalledTimes(2);
  expect(onHoverMove).toHaveBeenLastCalledWith(null);

  // Moving back to a point then leaving the chart also clears hovered move.
  e5Point.setAttribute("data-hover-label", "1. e4!");
  await act(async () => {
    e5Point.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
  });
  expect(onHoverMove).toHaveBeenCalledTimes(3);
  expect(onHoverMove).toHaveBeenLastCalledWith([0]);

  const chart = host.querySelector("[data-chart-type]")!;
  await act(async () => {
    chart.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
    chart.dispatchEvent(new MouseEvent("mouseleave", { bubbles: true }));
  });
  expect(onHoverMove).toHaveBeenCalledTimes(4);
  expect(onHoverMove).toHaveBeenLastCalledWith(null);
});
