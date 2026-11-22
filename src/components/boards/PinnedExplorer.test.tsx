import { MantineProvider } from "@mantine/core";
import { createStore, Provider } from "jotai";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  explorerDetachedAtom,
  explorerPlacementAtom,
  explorerStripHeightsAtom,
  PINNED_PLACEMENTS,
  type PinnedPlacement,
} from "@/state/atoms";
import { installMatchMediaStub } from "@/tests/matchMedia";
import PinnedExplorer, { AUTO_MAX_SHARE, NEIGHBOUR_MIN_PX, STRIP_MIN_PX } from "./PinnedExplorer";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/platform/native", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/platform/native")>()),
  warn: vi.fn(),
}));
vi.mock("../panels/database/DatabasePanel", () => ({
  default: () => <span data-testid="database-panel" />,
}));

const HEIGHTS_KEY = "detached-explorer-heights";
const PANE_PX = 600;
const MAX_PX = PANE_PX - NEIGHBOUR_MIN_PX;

let host: HTMLDivElement;
let root: Root;
let store: ReturnType<typeof createStore>;
/** The strip's rendered height as the drag and keyboard handlers read it. */
let stripRect = 200;
/** A pinned engine bar's rendered height. */
let enginePx = 100;
const ENGINE_PX = 100;
/** The gap between a pane's children. */
const GAP_PX = 10;
/** Each pane's height; tests change it and then report a resize. */
let paneHeight = PANE_PX;

/** What each live observer watches; `resize()` reports a size change of one or every target. */
const observed = new Map<ResizeObserverCallback, Set<Element>>();
class ManualResizeObserver {
  constructor(private callback: ResizeObserverCallback) {}
  observe(target: Element) {
    observed.set(this.callback, (observed.get(this.callback) ?? new Set()).add(target));
  }
  unobserve(target: Element) {
    observed.get(this.callback)?.delete(target);
  }
  disconnect() {
    observed.delete(this.callback);
  }
}
/** Reports a size change to the observers watching `target` (any target when omitted);
 * Mantine's element size reads `height` from it. */
const resize = (height = stripRect, target?: Element) =>
  act(async () => {
    const entry = { contentRect: { height, width: 300 } } as unknown as ResizeObserverEntry;
    for (const [callback, targets] of [...observed]) {
      if (!target || targets.has(target)) callback([entry], {} as ResizeObserver);
    }
    await new Promise((resolve) => requestAnimationFrame(resolve));
  });

beforeEach(() => {
  localStorage.clear();
  observed.clear();
  enginePx = ENGINE_PX;
  Object.defineProperty(window, "ResizeObserver", { writable: true, value: ManualResizeObserver });
  installMatchMediaStub();
  Element.prototype.setPointerCapture = vi.fn();
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      return {
        height: this.getAttribute("data-testid") === "pinned-engine" ? enginePx : stripRect,
      } as DOMRect;
    },
  );
  stripRect = 200;
  paneHeight = PANE_PX;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  store = createStore();
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  localStorage.clear();
});

/** Every place inside its own pane, as the analysis board mounts them; `engineIn` also holds a
 * pinned engine bar. */
async function renderPanes({
  stacked = false,
  engineIn,
}: { stacked?: boolean; engineIn?: PinnedPlacement } = {}) {
  // Below the board the strip and the engine bar share a slot inside the pane, as on the board.
  await act(async () =>
    root.render(
      <Provider store={store}>
        <MantineProvider env="test">
          <div data-board-layout={stacked ? "stacked" : "mosaic"} data-testid="layout">
            {PINNED_PLACEMENTS.map((placement) => (
              <div
                key={placement}
                data-pinned-pane
                data-pinned-pane-grows={placement === "board" || undefined}
                data-pane={placement}
                ref={(node) => {
                  if (node)
                    Object.defineProperty(node, "clientHeight", {
                      configurable: true,
                      get: () => paneHeight,
                    });
                }}
              >
                {placement === "board" ? (
                  <div data-slot="below-board">
                    <PinnedExplorer placement={placement} />
                    {engineIn === placement && <div data-testid="pinned-engine" />}
                  </div>
                ) : (
                  <>
                    {engineIn === placement && <div data-testid="pinned-engine" />}
                    <PinnedExplorer placement={placement} />
                  </>
                )}
              </div>
            ))}
          </div>
        </MantineProvider>
      </Provider>,
    ),
  );
}

async function pin(
  placement: PinnedPlacement,
  heights: Partial<Record<PinnedPlacement, number>> = {},
) {
  await act(async () => {
    store.set(explorerStripHeightsAtom, heights);
    store.set(explorerPlacementAtom, placement);
    store.set(explorerDetachedAtom, true);
  });
}

const strip = () => host.querySelector<HTMLElement>('[data-testid="pinned-explorer-strip"]')!;
const handle = () => host.querySelector<HTMLElement>('[role="separator"]')!;
const pointer = (type: string, clientY: number, { button = 0, pointerId = 1 } = {}) =>
  act(async () => {
    const event = new MouseEvent(type, { bubbles: true, button, clientY });
    Object.defineProperty(event, "pointerId", { value: pointerId });
    handle().dispatchEvent(event);
  });
const key = (key: string) =>
  act(async () => {
    handle().dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key }));
  });

test("the strip renders once, in the stored place, and only while pinned", async () => {
  await renderPanes();
  expect(host.querySelectorAll('[data-testid="database-panel"]')).toHaveLength(0);
  for (const placement of PINNED_PLACEMENTS) {
    await pin(placement);
    expect(host.querySelectorAll('[data-testid="database-panel"]')).toHaveLength(1);
    expect(
      host.querySelector(`[data-pane="${placement}"] [data-testid="database-panel"]`),
    ).not.toBeNull();
  }
  await act(async () => store.set(explorerDetachedAtom, false));
  expect(host.querySelectorAll('[data-testid="database-panel"]')).toHaveLength(0);
});

test("without a stored height the strip follows its content, up to a share of the window", async () => {
  await renderPanes();
  await pin("tabs");
  expect(strip().style.height).toBe("");
  const cap = `${window.innerHeight * AUTO_MAX_SHARE}px`;
  expect(strip().style.maxHeight).toBe(cap);
  // Moving the pane divider leaves the cap alone.
  paneHeight = 800;
  await resize();
  expect(strip().style.maxHeight).toBe(cap);
});

test.each([
  [300, 300],
  [900, MAX_PX],
  [50, STRIP_MIN_PX],
])("a stored height of %spx sizes the strip to %spx", async (stored, px) => {
  await renderPanes();
  await pin("notation", { notation: stored });
  expect(strip().style.height).toBe(`${px}px`);
  // It still yields, down to its minimum, when the neighbour needs its least room.
  expect(strip().style.flexShrink).toBe("1");
  expect(strip().style.minHeight).toBe(`${STRIP_MIN_PX}px`);
});

test("the divider below a strip above its neighbour grows it when dragged down, and stores the height once at the end", async () => {
  await renderPanes();
  await pin("tabs");
  expect(handle().getAttribute("data-edge")).toBe("end");
  const setItem = vi.spyOn(Storage.prototype, "setItem");

  await pointer("pointerdown", 100);
  await pointer("pointermove", 150);
  expect(strip().style.height).toBe("250px");
  expect(setItem.mock.calls.filter(([stored]) => stored === HEIGHTS_KEY)).toEqual([]);

  await pointer("pointerup", 150);
  expect(store.get(explorerStripHeightsAtom)).toEqual({ tabs: 250 });
  expect(strip().style.height).toBe("250px");
  // A late lost-capture after the release changes nothing.
  await pointer("lostpointercapture", 400);
  expect(store.get(explorerStripHeightsAtom)).toEqual({ tabs: 250 });
});

test("the divider above a strip below its neighbour grows it when dragged up, clamped to the pane", async () => {
  await renderPanes();
  await pin("belowNotation", { tabs: 180 });
  expect(handle().getAttribute("data-edge")).toBe("start");

  await pointer("pointerdown", 300);
  await pointer("pointermove", 250);
  expect(strip().style.height).toBe("250px");
  await pointer("pointermove", -500);
  expect(strip().style.height).toBe(`${MAX_PX}px`);
  // A cancelled drag keeps the height it reached.
  await pointer("pointercancel", -500);
  expect(store.get(explorerStripHeightsAtom)).toEqual({
    tabs: 180,
    belowNotation: MAX_PX,
  });
});

test("a lost pointer capture ends the drag and stores its height", async () => {
  await renderPanes();
  await pin("board");
  await pointer("pointerdown", 300);
  await pointer("lostpointercapture", 350);
  // Below the board the divider is the upper edge: 50px down leaves 150px.
  expect(store.get(explorerStripHeightsAtom)).toEqual({ board: 150 });
});

test.each([
  ["tabs", "ArrowDown", 224],
  ["tabs", "ArrowUp", 176],
  ["board", "ArrowUp", 224],
  ["board", "ArrowDown", 176],
] as const)("in %s, %s moves the divider one step", async (placement, arrow, px) => {
  await renderPanes();
  await pin(placement);
  await key(arrow);
  expect(store.get(explorerStripHeightsAtom)).toEqual({ [placement]: px });
  expect(strip().style.height).toBe(`${px}px`);
});

test("a double-click returns only this place to its content height", async () => {
  await renderPanes();
  await pin("notation", { notation: 300, board: 240 });
  await act(async () => {
    handle().dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  });
  expect(store.get(explorerStripHeightsAtom)).toEqual({ board: 240 });
  expect(strip().style.height).toBe("");
});

test("the divider reports the strip's share of its pane", async () => {
  await renderPanes();
  await pin("tabs", { tabs: 300 });
  expect(handle().getAttribute("aria-valuemin")).toBe(
    String(Math.round((STRIP_MIN_PX / PANE_PX) * 100)),
  );
  expect(handle().getAttribute("aria-valuemax")).toBe(String(Math.round((MAX_PX / PANE_PX) * 100)));
  expect(handle().getAttribute("aria-valuenow")).toBe("50");
  expect(handle().getAttribute("aria-label")).toBe("Board.Database.Resize");
});

test("below the board in the stacked layout the strip fits the window instead of its pane", async () => {
  await renderPanes({ stacked: true });
  await pin("board", { board: 5000 });
  expect(strip().style.height).toBe(`${window.innerHeight - NEIGHBOUR_MIN_PX}px`);
  // The right-hand panes keep their own fixed height there.
  await pin("tabs", { tabs: 5000 });
  expect(strip().style.height).toBe(`${MAX_PX}px`);
});

test("stored heights hydrate per place, dropping only the unreadable ones", async () => {
  localStorage.setItem(
    HEIGHTS_KEY,
    JSON.stringify({ tabs: 300, notation: "half", board: 7, belowNotation: null, other: 1 }),
  );
  const fresh = createStore();
  // Stored values load when the atom is first used.
  const unsubscribe = fresh.sub(explorerStripHeightsAtom, () => {});
  expect(fresh.get(explorerStripHeightsAtom)).toEqual({ tabs: 300, board: 7 });
  unsubscribe();
});

// 0.4 and 1 are shares of the pane, as heights were stored before they were kept in pixels.
test.each([0, -0.5, 0.4, 1])("a stored height of %s is dropped", async (stored) => {
  localStorage.setItem(HEIGHTS_KEY, JSON.stringify({ tabs: stored, board: 240 }));
  const fresh = createStore();
  const unsubscribe = fresh.sub(explorerStripHeightsAtom, () => {});
  expect(fresh.get(explorerStripHeightsAtom)).toEqual({ board: 240 });
  unsubscribe();
});

test.each([
  ['"belowNotation"', "belowNotation"],
  ['"sideways"', "tabs"],
  ["not json", "tabs"],
])("the stored place %s hydrates as %s", async (stored, expected) => {
  localStorage.setItem("detached-explorer-placement", stored);
  const fresh = createStore();
  const unsubscribe = fresh.sub(explorerPlacementAtom, () => {});
  expect(fresh.get(explorerPlacementAtom)).toBe(expected);
  unsubscribe();
});

test("above the notation the divider is the strip's lower edge too", async () => {
  await renderPanes();
  await pin("notation");
  expect(handle().getAttribute("data-edge")).toBe("end");
  await pointer("pointerdown", 100);
  await pointer("pointerup", 140);
  expect(store.get(explorerStripHeightsAtom)).toEqual({ notation: 240 });
});

test("a press without movement keeps the content height", async () => {
  await renderPanes();
  await pin("tabs");
  await pointer("pointerdown", 100);
  await pointer("pointerup", 100);
  expect(store.get(explorerStripHeightsAtom)).toEqual({});
  expect(strip().style.height).toBe("");
});

test("only a primary press starts a drag, and only that pointer moves and ends it", async () => {
  await renderPanes();
  await pin("tabs");
  await pointer("pointerdown", 100, { button: 2 });
  await pointer("pointerup", 160, { button: 2 });
  expect(store.get(explorerStripHeightsAtom)).toEqual({});

  await pointer("pointerdown", 100, { pointerId: 1 });
  await pointer("pointermove", 400, { pointerId: 2 });
  expect(strip().style.height).toBe("200px");
  await pointer("pointerup", 400, { pointerId: 2 });
  expect(store.get(explorerStripHeightsAtom)).toEqual({});
  await pointer("pointerup", 130, { pointerId: 1 });
  expect(store.get(explorerStripHeightsAtom)).toEqual({ tabs: 230 });
});

test("a drag stops at the strip's minimum", async () => {
  await renderPanes();
  await pin("tabs");
  await pointer("pointerdown", 300);
  await pointer("pointermove", -300);
  expect(strip().style.height).toBe(`${STRIP_MIN_PX}px`);
  await pointer("pointerup", -300);
  expect(store.get(explorerStripHeightsAtom)).toEqual({ tabs: STRIP_MIN_PX });
});

test("a resized pane keeps a dragged strip's height until the neighbour needs the room", async () => {
  await renderPanes();
  await pin("tabs", { tabs: 300 });
  expect(strip().style.height).toBe("300px");
  paneHeight = 800;
  await resize();
  expect(strip().style.height).toBe("300px");
  // Shrunk below the strip plus the neighbour's least room, the strip gives way...
  paneHeight = 400;
  await resize();
  expect(strip().style.height).toBe(`${400 - NEIGHBOUR_MIN_PX}px`);
  // ...and grows back to its dragged height when the pane does.
  paneHeight = PANE_PX;
  await resize();
  expect(strip().style.height).toBe("300px");
  expect(store.get(explorerStripHeightsAtom)).toEqual({ tabs: 300 });
});

test("a pinned engine bar in the same pane counts against the strip's largest height", async () => {
  await renderPanes({ engineIn: "tabs" });
  await pin("tabs", { tabs: PANE_PX });
  expect(strip().style.height).toBe(`${PANE_PX - ENGINE_PX - NEIGHBOUR_MIN_PX}px`);
});

test("switching between the stacked and the pane layout measures below the board against the right height", async () => {
  await renderPanes();
  await pin("board", { board: 5000 });
  expect(strip().style.height).toBe(`${MAX_PX}px`);
  const layout = host.querySelector('[data-testid="layout"]')!;
  layout.setAttribute("data-board-layout", "stacked");
  await act(async () => window.dispatchEvent(new Event("resize")));
  expect(strip().style.height).toBe(`${window.innerHeight - NEIGHBOUR_MIN_PX}px`);
  layout.setAttribute("data-board-layout", "mosaic");
  await act(async () => window.dispatchEvent(new Event("resize")));
  expect(strip().style.height).toBe(`${MAX_PX}px`);
});

test.each(["tabs", "board"] as const)(
  "an engine bar pinned into %s after the strip is counted as soon as it mounts",
  async (placement) => {
    await renderPanes();
    await pin(placement, { [placement]: PANE_PX });
    expect(strip().style.height).toBe(`${MAX_PX}px`);
    await renderPanes({ engineIn: placement });
    expect(strip().style.height).toBe(`${PANE_PX - ENGINE_PX - NEIGHBOUR_MIN_PX}px`);
    await renderPanes();
    expect(strip().style.height).toBe(`${MAX_PX}px`);
  },
);

test("with the content height the divider reports the strip's measured share", async () => {
  await renderPanes();
  await pin("tabs");
  await resize(180);
  expect(handle().getAttribute("aria-valuenow")).toBe(String(Math.round((180 / PANE_PX) * 100)));
});

test("an engine bar that grows in the strip's pane shrinks the strip's largest height, gap included", async () => {
  await renderPanes({ engineIn: "tabs" });
  const pane = host.querySelector<HTMLElement>('[data-pane="tabs"]')!;
  pane.style.rowGap = `${GAP_PX}px`;
  await pin("tabs", { tabs: PANE_PX });
  await resize(stripRect, pane);
  expect(strip().style.height).toBe(`${PANE_PX - ENGINE_PX - GAP_PX - NEIGHBOUR_MIN_PX}px`);
  // More engine lines: only the bar reports a new size.
  enginePx = 200;
  await resize(200, pane.querySelector('[data-testid="pinned-engine"]')!);
  expect(strip().style.height).toBe(`${PANE_PX - 200 - GAP_PX - NEIGHBOUR_MIN_PX}px`);
});

test("the automatic cap also leaves room for an engine bar in the same pane", async () => {
  enginePx = 300;
  await renderPanes({ engineIn: "tabs" });
  await pin("tabs");
  // A quarter of jsdom's 768px window would be 192px; the bar and the tabs' 160px leave 140px.
  expect(strip().style.maxHeight).toBe(`${PANE_PX - 300 - NEIGHBOUR_MIN_PX}px`);
});

test("in a pane too short for both minimums the strip keeps its own", async () => {
  paneHeight = 200;
  await renderPanes();
  await pin("tabs", { tabs: PANE_PX });
  expect(strip().style.height).toBe(`${STRIP_MIN_PX}px`);
  expect(strip().style.minHeight).toBe(`${STRIP_MIN_PX}px`);
});

test("keys other than ArrowUp and ArrowDown leave the divider alone", async () => {
  await renderPanes();
  await pin("tabs");
  for (const other of ["Enter", "Tab", "ArrowLeft", "Home"]) await key(other);
  expect(store.get(explorerStripHeightsAtom)).toEqual({});
});

test("an engine bar in a pane nested inside the strip's pane does not count against the strip", async () => {
  // The right side of the beside arrangement: the strip across the top, and below it the notation
  // column, a pane of its own with its own pinned engine bar.
  const sized = (node: HTMLDivElement | null) => {
    if (node)
      Object.defineProperty(node, "clientHeight", { configurable: true, get: () => paneHeight });
  };
  await act(async () =>
    root.render(
      <Provider store={store}>
        <MantineProvider env="test">
          <div data-board-layout="beside">
            <div data-pinned-pane ref={sized}>
              <PinnedExplorer placement="tabs" />
              <div data-pinned-pane>
                <div data-testid="pinned-engine" />
              </div>
            </div>
          </div>
        </MantineProvider>
      </Provider>,
    ),
  );
  await pin("tabs");
  // Dragged as far as it goes, the strip leaves the pane only its neighbour's minimum.
  await pointer("pointerdown", 0);
  await pointer("pointermove", 2 * PANE_PX);
  expect(strip().style.height).toBe(`${MAX_PX}px`);
});
