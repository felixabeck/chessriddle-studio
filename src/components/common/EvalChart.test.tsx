import { MantineProvider } from "@mantine/core";
import { Provider, createStore as createAtomStore } from "jotai";
import { act, cloneElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Score } from "@/bindings";
import { reportTypeAtom } from "@/state/atoms";
import { createTreeStore, type TreeStore } from "@/state/store/tree";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { installResizeObserverStub } from "@/tests/resizeObserver";
import EvalChart from "./EvalChart";
import { TreeStateContext } from "./TreeStateContext";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/platform/native", () => ({ platform: () => "linux", warn: vi.fn(), error: vi.fn() }));
vi.mock("@/utils/sound", () => ({ playSound: vi.fn() }));

// Mantine AreaChart spreads resolved areaProps into both the filled Area and the dots Area
// for each series. The dots layer is rendered because withDots defaults to true.
vi.mock("@mantine/charts", () => ({
  AreaChart: ({ data, series, referenceLines, areaProps, type }: any) => (
    <div data-chart-type={type}>
      {referenceLines.map((line: any, index: number) => (
        <div
          key={index}
          data-reference-line
          data-x={line.x}
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
  await act(async () => root.unmount());
  host.remove();
});

async function renderChart() {
  await act(async () =>
    root.render(
      <MantineProvider>
        <Provider store={atoms}>
          <TreeStateContext.Provider value={store}>
            <EvalChart isAnalysing={false} startAnalysis={vi.fn()} />
          </TreeStateContext.Provider>
        </Provider>
      </MantineProvider>,
    ),
  );
}

function referenceLines() {
  return [...host.querySelectorAll("[data-reference-line]")].map((line) => ({
    x: line.getAttribute("data-x"),
    label: line.getAttribute("data-label"),
    labelPosition: line.getAttribute("data-label-position"),
  }));
}

const expectedReferenceLines = [
  { x: "1... e5", label: null, labelPosition: null },
  { x: "1. e4!", label: "Board.Analysis.Middlegame", labelPosition: "insideTopLeft" },
  { x: "1... e5", label: "Board.Analysis.Endgame", labelPosition: "insideTopLeft" },
];

test("CP renders both phase labels inside the chart and one annotation dot per layer", async () => {
  await renderChart();
  expect(host.querySelector("[data-chart-type]")?.getAttribute("data-chart-type")).toBe("split");
  expect(referenceLines()).toEqual(expectedReferenceLines);
  expect(host.querySelectorAll("svg circle")).toHaveLength(2);
  const layers = [...host.querySelectorAll('[data-series="yValue"] [data-layer]')];
  expect(layers.map((layer) => layer.getAttribute("data-layer"))).toEqual(["area", "dots"]);
  for (const layer of layers) {
    expect(layer.querySelectorAll("circle")).toHaveLength(1);
    expect(layer.querySelectorAll('[data-point="1. e4!"] circle')).toHaveLength(1);
  }
});

test("switching to WDL preserves the current, middlegame and endgame reference lines", async () => {
  await renderChart();
  expect(referenceLines()).toEqual(expectedReferenceLines);
  await act(async () => atoms.set(reportTypeAtom, "WDL"));
  expect(host.querySelector("[data-chart-type]")?.getAttribute("data-chart-type")).toBe("percent");
  expect(referenceLines()).toEqual(expectedReferenceLines);
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
