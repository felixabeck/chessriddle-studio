import { WorkspaceTabScope } from "@/state/tabScope";
import { DEFAULT_THEME, MantineProvider } from "@mantine/core";
import { Provider, createStore as createAtomStore } from "jotai";
import { act, cloneElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createTreeStore, type TreeStore } from "@/state/store/tree";
import { activeTabAtom, showCommentsFamily, moveNotationTypeAtom, tabsAtom } from "@/state/atoms";
import { installMatchMediaStub } from "@/tests/matchMedia";
import Board from "@/components/boards/Board";
import AnnotationPanel from "@/components/panels/annotation/AnnotationPanel";
import EvalChart from "./EvalChart";
import GameNotation from "./GameNotation";
import { TreeStateContext, VariationChooserContext } from "./TreeStateContext";
import { createVariationChooserStore } from "@/state/store/variationChooser";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/platform/native", () => ({ platform: () => "linux", warn: vi.fn(), error: vi.fn() }));
vi.mock("@/utils/sound", () => ({ playSound: vi.fn() }));
vi.mock("@/chessground/Chessground", () => ({ Chessground: () => <div data-chessground /> }));
vi.mock("@/components/common/ShowMaterial", () => ({ default: () => null }));
vi.mock("@/components/databases/FideInfo", () => ({ default: () => null }));
vi.mock("@/components/panels/analysis/BestMoves", () => ({ arrowColors: [] }));
vi.mock("@/components/boards/BoardBar", () => ({
  BoardBar: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/components/boards/Clock", () => ({ default: () => null }));
vi.mock("@/components/boards/EvalBar", () => ({ default: () => null }));
vi.mock("@/components/boards/MoveInput", () => ({ default: () => null }));
vi.mock("@/components/boards/PromotionModal", () => ({ default: () => null }));
vi.mock("@/components/panels/annotation/AnnotationEditor", () => ({ default: () => null }));
vi.mock("./OpeningName", () => ({ default: () => null }));
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 30,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ index, size: 30, start: index * 30 })),
    measureElement: () => undefined,
    getOffsetForIndex: () => undefined,
    scrollToOffset: () => undefined,
    scrollOffset: 0,
  }),
}));
// The chart adapter renders the real tooltip and dot with the data supplied by EvalChart.
vi.mock("@mantine/charts", () => ({
  AreaChart: ({ data, tooltipProps, areaProps }: any) => (
    <div>
      {data.map((point: any) => (
        <div key={point.name} data-chart-color={point.color}>
          {tooltipProps.content({ payload: [{ payload: point }], active: true })}
          <svg>
            {areaProps?.dot && cloneElement(areaProps.dot, { payload: point, cx: 10, cy: 10 })}
          </svg>
        </div>
      ))}
    </div>
  ),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
installMatchMediaStub();
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = ResizeObserverStub;

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
  atoms = createAtomStore();
  atoms.set(tabsAtom, [
    { name: "NAGs", value: "nag-test", type: "analysis", gameOrigin: { kind: "none" } },
  ]);
  atoms.set(activeTabAtom, "nag-test");
  atoms.set(showCommentsFamily("nag-test"), true);
  atoms.set(moveNotationTypeAtom, "letters");
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

async function render(child: ReactNode, nags: number[]) {
  store.setState((state) => ({
    root: { ...state.root, children: [{ ...state.root.children[0], nags }] },
  }));
  await act(async () =>
    root.render(
      <MantineProvider>
        <Provider store={atoms}>
          <TreeStateContext.Provider value={store}>
            <WorkspaceTabScope tabId={"nag-test"}>
              <VariationChooserContext.Provider value={createVariationChooserStore()}>
                {child}
              </VariationChooserContext.Provider>
            </WorkspaceTabScope>
          </TreeStateContext.Provider>
        </Provider>
      </MantineProvider>,
    ),
  );
}

test.each([
  { nags: [220], glyph: null },
  { nags: [8], glyph: "□" },
  { nags: [11], glyph: "=" },
  { nags: [220, 1], glyph: "!" },
])("Board projects NAGs $nags into hint $glyph", async ({ nags, glyph }) => {
  await render(<Board editingMode={false} boardRef={{ current: null }} />, nags);
  const title = host.querySelector("svg > title");
  expect(title?.textContent ?? null).toBe(glyph);
  expect(host.querySelector("svg g path") !== null).toBe(glyph !== null);
  const board = host.querySelector('[role="grid"]') as HTMLElement;
  expect(board.style.getPropertyValue("--light-color")).toBe(
    glyph === "!" ? DEFAULT_THEME.colors.teal[6] : "",
  );
});

test.each([
  { nags: [220], text: "e4" },
  { nags: [220, 1], text: "e4!" },
  { nags: [7, 8], text: "e4□" },
  { nags: [1, 2], text: "e4! ?" },
  { nags: [5], text: "e4!?" },
  { nags: [1, 3], text: "e4! !!" },
  { nags: [2, 4], text: "e4? ??" },
  { nags: [10, 13], text: "e4= ∞" },
])("GameNotation renders move-cell glyph text for NAGs $nags", async ({ nags, text }) => {
  await render(<GameNotation />, nags);
  const cell = host.querySelector('button[class*="cell"]');
  expect(cell?.textContent).toBe(text);
});

test.each([
  { nags: [220], label: "1. e4", color: "gray" },
  { nags: [220, 1], label: "1. e4!", color: "teal" },
  { nags: [1, 2], label: "1. e4! ?", color: "teal" },
  { nags: [5], label: "1. e4!?", color: "lime" },
  { nags: [10, 13], label: "1. e4= ∞", color: "gray" },
])(
  "EvalChart renders projected labels and primary colour for NAGs $nags",
  async ({ nags, label, color }) => {
    await render(<EvalChart isAnalysing={false} startAnalysis={vi.fn()} />, nags);
    const point = host.querySelector("[data-chart-color]")!;
    expect(point.getAttribute("data-chart-color")).toBe(color);
    expect(point.querySelector('[class*="tooltipTitle"]')?.textContent).toBe(label);
    expect(point.textContent).not.toMatch(/220|\b1,/);
    expect(point.querySelector("circle")?.getAttribute("fill") ?? null).toBe(
      color === "gray" ? null : `var(--mantine-color-${color}-7)`,
    );
  },
);

test.each([
  { nags: [8], glyph: "□", active: true, result: [] },
  { nags: [7, 8, 220], glyph: "□", active: true, result: [220] },
  { nags: [11], glyph: "=", active: true, result: [] },
  { nags: [11, 220], glyph: "±", active: false, result: [220, 16] },
  { nags: [], glyph: "□", active: false, result: [7] },
  { nags: [2, 8], glyph: "!", active: false, result: [8, 1] },
] as const)(
  "Annotate button $glyph toggles glyph classes on $nags",
  async ({ nags, glyph, active, result }) => {
    await render(<AnnotationPanel />, [...nags]);
    const button = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === glyph,
    )!;
    expect(button.getAttribute("data-variant")).toBe(active ? "filled" : "default");
    await act(async () => button.click());
    expect(store.getState().currentNode().nags).toEqual(result);
  },
);
