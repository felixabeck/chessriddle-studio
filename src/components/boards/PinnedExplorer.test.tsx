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
import { installResizeObserverStub } from "@/tests/resizeObserver";
import PinnedExplorer, { AUTO_MAX_SHARE, NEIGHBOUR_MIN_PX, STRIP_MIN_PX } from "./PinnedExplorer";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
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

beforeEach(() => {
  localStorage.clear();
  installResizeObserverStub();
  installMatchMediaStub();
  Element.prototype.setPointerCapture = vi.fn();
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    () => ({ height: stripRect }) as DOMRect,
  );
  stripRect = 200;
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

/** Every place inside its own pane of PANE_PX, as the analysis board mounts them. */
async function renderPanes({ stacked = false } = {}) {
  await act(async () =>
    root.render(
      <Provider store={store}>
        <MantineProvider env="test">
          <div data-board-layout={stacked ? "stacked" : "mosaic"}>
            {PINNED_PLACEMENTS.map((placement) => (
              <div
                key={placement}
                data-pinned-pane
                data-pinned-pane-grows={placement === "board" || undefined}
                data-pane={placement}
                ref={(node) => {
                  if (node) Object.defineProperty(node, "clientHeight", { value: PANE_PX });
                }}
              >
                <PinnedExplorer placement={placement} />
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
const pointer = (type: string, clientY: number) =>
  act(async () => {
    handle().dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, clientY }));
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

test("without a stored height the strip follows its content, up to half its pane", async () => {
  await renderPanes();
  await pin("tabs");
  expect(strip().style.height).toBe("");
  expect(strip().style.maxHeight).toBe(`${PANE_PX * AUTO_MAX_SHARE}px`);
});

test.each([
  [0.5, PANE_PX * 0.5],
  [0.95, MAX_PX],
  [0.05, STRIP_MIN_PX],
])("a stored share of %s sizes the strip to %spx of its pane", async (share, px) => {
  await renderPanes();
  await pin("notation", { notation: share });
  expect(strip().style.height).toBe(`${px}px`);
  // It still yields, down to its minimum, when the neighbour needs its least room.
  expect(strip().style.flexShrink).toBe("1");
  expect(strip().style.minHeight).toBe(`${STRIP_MIN_PX}px`);
});

test("the divider below a strip above its neighbour grows it when dragged down, and stores the share once at the end", async () => {
  await renderPanes();
  await pin("tabs");
  expect(handle().getAttribute("data-edge")).toBe("end");
  const setItem = vi.spyOn(Storage.prototype, "setItem");

  await pointer("pointerdown", 100);
  await pointer("pointermove", 150);
  expect(strip().style.height).toBe("250px");
  expect(setItem.mock.calls.filter(([stored]) => stored === HEIGHTS_KEY)).toEqual([]);

  await pointer("pointerup", 150);
  expect(store.get(explorerStripHeightsAtom)).toEqual({ tabs: 250 / PANE_PX });
  expect(strip().style.height).toBe("250px");
  // A late lost-capture after the release changes nothing.
  await pointer("lostpointercapture", 400);
  expect(store.get(explorerStripHeightsAtom)).toEqual({ tabs: 250 / PANE_PX });
});

test("the divider above a strip below its neighbour grows it when dragged up, clamped to the pane", async () => {
  await renderPanes();
  await pin("belowNotation", { tabs: 0.3 });
  expect(handle().getAttribute("data-edge")).toBe("start");

  await pointer("pointerdown", 300);
  await pointer("pointermove", 250);
  expect(strip().style.height).toBe("250px");
  await pointer("pointermove", -500);
  expect(strip().style.height).toBe(`${MAX_PX}px`);
  // A cancelled drag keeps the height it reached.
  await pointer("pointercancel", -500);
  expect(store.get(explorerStripHeightsAtom)).toEqual({
    tabs: 0.3,
    belowNotation: MAX_PX / PANE_PX,
  });
});

test("a lost pointer capture ends the drag and stores its height", async () => {
  await renderPanes();
  await pin("board");
  await pointer("pointerdown", 300);
  await pointer("lostpointercapture", 350);
  // Below the board the divider is the upper edge: 50px down leaves 150px.
  expect(store.get(explorerStripHeightsAtom)).toEqual({ board: 150 / PANE_PX });
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
  expect(store.get(explorerStripHeightsAtom)).toEqual({ [placement]: px / PANE_PX });
  expect(strip().style.height).toBe(`${px}px`);
});

test("a double-click returns only this place to its content height", async () => {
  await renderPanes();
  await pin("notation", { notation: 0.5, board: 0.4 });
  await act(async () => {
    handle().dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  });
  expect(store.get(explorerStripHeightsAtom)).toEqual({ board: 0.4 });
  expect(strip().style.height).toBe("");
});

test("the divider reports the strip's share of its pane", async () => {
  await renderPanes();
  await pin("tabs", { tabs: 0.5 });
  expect(handle().getAttribute("aria-valuemin")).toBe(
    String(Math.round((STRIP_MIN_PX / PANE_PX) * 100)),
  );
  expect(handle().getAttribute("aria-valuemax")).toBe(String(Math.round((MAX_PX / PANE_PX) * 100)));
  expect(handle().getAttribute("aria-valuenow")).toBe("50");
  expect(handle().getAttribute("aria-label")).toBe("Board.Database.Resize");
});

test("below the board in the stacked layout the share is taken of the window", async () => {
  await renderPanes({ stacked: true });
  await pin("board", { board: 0.5 });
  expect(strip().style.height).toBe(
    `${Math.max(STRIP_MIN_PX, Math.min(window.innerHeight - NEIGHBOUR_MIN_PX, window.innerHeight * 0.5))}px`,
  );
  // The right-hand panes keep their own fixed height there.
  await pin("tabs", { tabs: 0.5 });
  expect(strip().style.height).toBe(`${PANE_PX * 0.5}px`);
});

test("stored heights hydrate per place, dropping only the unreadable ones", async () => {
  localStorage.setItem(
    HEIGHTS_KEY,
    JSON.stringify({ tabs: 0.5, notation: "half", board: 7, belowNotation: 0.25, other: 1 }),
  );
  const fresh = createStore();
  // Stored values load when the atom is first used.
  const unsubscribe = fresh.sub(explorerStripHeightsAtom, () => {});
  expect(fresh.get(explorerStripHeightsAtom)).toEqual({ tabs: 0.5, belowNotation: 0.25 });
  unsubscribe();
});
