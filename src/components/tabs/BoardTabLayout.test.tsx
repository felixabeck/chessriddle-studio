import { act, useContext, useEffect, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MantineProvider, Portal } from "@mantine/core";
import { createStore, Provider, type PrimitiveAtom } from "jotai";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { MosaicNode } from "react-mosaic-component";
import { installMatchMediaStub } from "@/tests/matchMedia";

const measured = vi.hoisted(() => ({ width: 1000, mounts: 0 }));
/** Each rendered split's change handler, by its tiles, so a test can drag a divider. */
const dividers = vi.hoisted(() => new Map<string, (node: unknown) => void>());
vi.mock("@mantine/hooks", async () => {
  const { useRef } = await import("react");
  return {
    ...(await vi.importActual<typeof import("@mantine/hooks")>("@mantine/hooks")),
    useElementSize: () => ({ ref: useRef(null), width: measured.width, height: 720 }),
  };
});
const enginesMock = vi.hoisted(() => ({
  atom: null as PrimitiveAtom<{ id: string; name: string; loaded?: boolean }[] | undefined> | null,
}));
vi.mock("@/state/atoms", async () => {
  const { atom } = await import("jotai");
  enginesMock.atom = atom<{ id: string; name: string; loaded?: boolean }[] | undefined>([]);
  return { fontSizeAtom: atom(100), enginesAtom: enginesMock.atom };
});
const coachMock = vi.hoisted(() => ({ atom: null as PrimitiveAtom<boolean> | null }));
vi.mock("@/state/coach", async () => {
  const { atom } = await import("jotai");
  coachMock.atom = atom(false);
  return { coachEnabledAtom: coachMock.atom };
});
vi.mock("@/platform/native", () => ({ warn: vi.fn() }));
vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));
vi.mock("react-mosaic-component", () => {
  const tiles = (node: MosaicNode<string> | null): string[] =>
    node === null
      ? []
      : typeof node === "string"
        ? [node]
        : [...tiles(node.first), ...tiles(node.second)];
  const Mosaic = ({
    value,
    renderTile,
    onChange,
  }: {
    value: MosaicNode<string> | null;
    renderTile: (id: string) => ReactNode;
    onChange: (node: unknown) => void;
  }) => {
    dividers.set(tiles(value).join("+"), onChange);
    const render = (node: MosaicNode<string> | null): ReactNode =>
      node === null ? null : typeof node === "string" ? (
        <div key={node}>{renderTile(node)}</div>
      ) : (
        <>
          {render(node.first)}
          {render(node.second)}
        </>
      );
    return <div data-mosaic-tree={JSON.stringify(value)}>{render(value)}</div>;
  };
  return { Mosaic };
});

import { createStore as createZustandStore } from "zustand";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import type { TreeStore, TreeStoreState } from "@/state/store/tree";
import BoardTabLayout, { BoardArrangementContext, boardAreaTargetId } from "./BoardTabLayout";
import { fontSizeAtom } from "@/state/atoms";
import { isHotkeySuppressed } from "@/utils/keyboardOwnership";
import {
  ANALYSIS_BOARD_LAYOUTS_KEY,
  boardLayoutFamily,
  defaultBoardLayoutsState,
  WINDOWS_STATE_KEY,
} from "@/state/layoutStorage";
import type { BoardLayoutKind } from "@/state/layoutPresets";
import {
  arrangementEngineAreas,
  defaultBoardArrangement,
  engineAreaId,
  enginePlaceholderAreaId,
  placeArea,
  type BoardArrangement,
  type PanelAreaId,
} from "@/state/boardArrangement";

function StatefulConsumer() {
  const [count, setCount] = useState(0);
  useEffect(() => {
    measured.mounts++;
  }, []);
  return (
    <>
      {(["left", "topRight", "bottomRight"] as const).map((id) => (
        <Portal key={id} target={`#${id}`}>
          <button onClick={() => setCount(count + 1)}>
            {id}:{count}
          </button>
        </Portal>
      ))}
    </>
  );
}

/** The arrangement context as the board inside the layout reads it. */
let latestContext: React.ContextType<typeof BoardArrangementContext> | null = null;
function ArrangementProbe() {
  const ctx = useContext(BoardArrangementContext);
  latestContext = ctx;
  return (
    <output
      data-testid="arrangement-ctx"
      data-arranging={String(ctx.arrangingAvailable)}
      data-panels={[...ctx.shownPanelAreas].join(",")}
    />
  );
}

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let container: HTMLDivElement;
let root: Root;
let store: ReturnType<typeof createStore>;
beforeEach(() => {
  installMatchMediaStub();
  localStorage.clear();
  measured.width = 1000;
  measured.mounts = 0;
  dividers.clear();
  document.documentElement.style.fontSize = "16px";
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  store = createStore();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.documentElement.style.fontSize = "";
  vi.restoreAllMocks();
});
function seedGameLayout(arrangement: BoardArrangement, tabsHidden = false) {
  const state = defaultBoardLayoutsState();
  state.kinds.game = { arrangement, tabsHidden };
  localStorage.setItem(ANALYSIS_BOARD_LAYOUTS_KEY, JSON.stringify(state));
}
function readStoredGameLayout() {
  return JSON.parse(localStorage.getItem(ANALYSIS_BOARD_LAYOUTS_KEY)!).kinds.game as {
    arrangement: BoardArrangement;
    tabsHidden: boolean;
  };
}
function getGameArrangement() {
  return store.get(boardLayoutFamily("game")).arrangement;
}
function setGameArrangement(arrangement: BoardArrangement) {
  store.set(boardLayoutFamily("game"), (prev) => ({ ...prev, arrangement }));
}

async function renderAt(width: number, arrangeable = false, kind: BoardLayoutKind = "game") {
  measured.width = width;
  await act(async () =>
    root.render(
      <Provider store={store}>
        <MantineProvider>
          {arrangeable ? (
            <BoardTabLayout arrangeable kind={kind}>
              <StatefulConsumer />
              <ArrangementProbe />
            </BoardTabLayout>
          ) : (
            <BoardTabLayout>
              <StatefulConsumer />
              <ArrangementProbe />
            </BoardTabLayout>
          )}
        </MantineProvider>
      </Provider>,
    ),
  );
}
const ids = ["left", "topRight", "bottomRight"];

test("narrow round trips preserve real portal state, attached target identity and exact saved tree", async () => {
  const saved =
    '{"currentNode":{"direction":"column","first":"bottomRight","second":{"direction":"row","first":"topRight","second":"left","splitPercentage":31},"splitPercentage":72}}';
  localStorage.setItem("windowsState", saved);
  const writes = vi.spyOn(Storage.prototype, "setItem");
  await renderAt(1000);
  const targets = ids.map((id) => document.getElementById(id)!);
  await act(async () => targets[0].querySelector("button")!.click());
  for (const width of [320, 1000, 400, 1200]) {
    await renderAt(width);
    expect(container.querySelector("[data-board-layout]")?.getAttribute("data-board-layout")).toBe(
      width < 646 ? "stacked" : "mosaic",
    );
    for (const [index, id] of ids.entries()) {
      expect(document.getElementById(id)).toBe(targets[index]);
      expect(targets[index].isConnected).toBe(true);
      expect(targets[index].closest("[hidden]")).toBeNull();
      expect(targets[index].textContent).toBe(`${id}:1`);
    }
    expect(measured.mounts).toBe(1);
    expect(localStorage.getItem("windowsState")).toBe(saved);
    expect(writes.mock.calls.filter(([key]) => key === "windowsState")).toEqual([]);
    const composition =
      width >= 646
        ? container.querySelector("[data-mosaic-tree]")?.getAttribute("data-mosaic-tree")
        : // Hidden panel-area slots are parked out of sight and are no part of the stack.
          [...container.querySelectorAll("[data-board-slot]")]
            .filter((slot) => !slot.closest("[hidden]"))
            .map((slot) => slot.getAttribute("data-board-slot"));
    expect(composition).toEqual(width >= 646 ? JSON.stringify(JSON.parse(saved).currentNode) : ids);
  }
});

test.each([null, "left"] as const)(
  "missing panes in %s remain attached and become visible in narrow mode",
  async (node) => {
    const saved = JSON.stringify({ currentNode: node });
    localStorage.setItem("windowsState", saved);
    await renderAt(1000);
    const targets = ids.map((id) => document.getElementById(id)!);
    for (const target of targets) {
      expect(target.isConnected).toBe(true);
      expect(!!target.closest("[hidden]")).toBe(target.id !== node);
      expect(target.querySelector("button")).not.toBeNull();
    }
    await renderAt(320);
    for (const target of targets) {
      expect(document.getElementById(target.id)).toBe(target);
      expect(target.closest("[hidden]")).toBeNull();
    }
    await renderAt(1000);
    expect(container.querySelector("[data-mosaic-tree]")?.getAttribute("data-mosaic-tree")).toBe(
      JSON.stringify(node),
    );
    expect(localStorage.getItem("windowsState")).toBe(saved);
    expect(measured.mounts).toBe(1);
  },
);

test("container threshold follows a live root font scale change", async () => {
  await renderAt(1000);
  expect(container.querySelector('[data-board-layout="mosaic"]')).not.toBeNull();
  document.documentElement.style.fontSize = "32px";
  await act(async () => store.set(fontSizeAtom, 200));
  expect(container.querySelector('[data-board-layout="stacked"]')).not.toBeNull();
  await renderAt(1286);
  expect(container.querySelector('[data-board-layout="mosaic"]')).not.toBeNull();
});

test("stateful portal consumer mounts once from an initial narrow layout across repeated switches", async () => {
  await renderAt(320);
  await act(async () => document.querySelector<HTMLButtonElement>("#left button")!.click());
  for (const width of [1000, 320, 1200, 400]) {
    await renderAt(width);
    expect(ids.map((id) => document.getElementById(id)?.textContent)).toEqual(
      ids.map((id) => `${id}:1`),
    );
    expect(measured.mounts).toBe(1);
  }
});

test("initial container measurement selects desktop before an observer animation frame", async () => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    width: 1000,
    height: 720,
    top: 0,
    left: 0,
    right: 1000,
    bottom: 720,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
  await renderAt(0);
  expect(container.querySelector('[data-board-layout="mosaic"]')).not.toBeNull();
  expect(measured.mounts).toBe(1);
  expect(ids.map((id) => document.getElementById(id)?.textContent)).toEqual(
    ids.map((id) => `${id}:0`),
  );
});

const layoutMode = () =>
  container.querySelector("[data-board-layout]")?.getAttribute("data-board-layout");
const mosaicTree = () => {
  const raw = container.querySelector("[data-mosaic-tree]")?.getAttribute("data-mosaic-tree");
  return raw ? JSON.parse(raw) : null;
};

const THREE_PANE_ARRANGEMENT: BoardArrangement = {
  direction: "row",
  first: "left",
  splitPercentage: 40,
  second: {
    direction: "column",
    first: "database",
    splitPercentage: 30,
    second: {
      direction: "row",
      first: "bottomRight",
      second: "topRight",
      splitPercentage: 55,
    },
  },
};

test("analysis board switches cleanly across stacked, fallback windowsState and shown arrangement by width", async () => {
  const savedWindows = {
    currentNode: {
      direction: "row" as const,
      first: "left" as const,
      second: {
        direction: "column" as const,
        first: "topRight" as const,
        second: "bottomRight" as const,
      },
      splitPercentage: 62,
    },
  };
  localStorage.setItem(WINDOWS_STATE_KEY, JSON.stringify(savedWindows));
  seedGameLayout(THREE_PANE_ARRANGEMENT);
  const writes = vi.spyOn(Storage.prototype, "setItem");

  // Case 1: narrower than two pane floors -> stacked, no panel areas, arranging unavailable.
  await renderAt(645, true);
  expect(layoutMode()).toBe("stacked");
  expect(latestContext?.arrangingAvailable).toBe(false);
  expect([...(latestContext?.shownPanelAreas ?? [])]).toEqual([]);
  expect(
    document.getElementById(boardAreaTargetId("database"))?.closest("[hidden]"),
  ).not.toBeNull();

  // Case 3: fits two panes but not three -> shared windowsState layout, stored arrangement untouched.
  await renderAt(971, true);
  expect(layoutMode()).toBe("mosaic");
  expect(mosaicTree()).toEqual(savedWindows.currentNode);
  expect(latestContext?.arrangingAvailable).toBe(false);
  expect([...(latestContext?.shownPanelAreas ?? [])]).toEqual([]);
  expect(
    document.getElementById(boardAreaTargetId("database"))?.closest("[hidden]"),
  ).not.toBeNull();

  // Case 2: fits three panes -> shown arrangement with database panel area.
  await renderAt(972, true);
  expect(layoutMode()).toBe("mosaic");
  expect(mosaicTree()).toEqual(THREE_PANE_ARRANGEMENT);
  expect(latestContext?.arrangingAvailable).toBe(true);
  expect([...(latestContext?.shownPanelAreas ?? [])]).toEqual(["database"]);
  expect(document.getElementById(boardAreaTargetId("database"))?.closest("[hidden]")).toBeNull();

  // Switching across modes never rewrote either stored key.
  expect(
    writes.mock.calls.filter(([k]) => k === ANALYSIS_BOARD_LAYOUTS_KEY || k === WINDOWS_STATE_KEY),
  ).toEqual([]);
  expect(readStoredGameLayout().arrangement).toEqual(THREE_PANE_ARRANGEMENT);
});

test("arrangement width threshold follows the root font scale", async () => {
  seedGameLayout(THREE_PANE_ARRANGEMENT);
  document.documentElement.style.fontSize = "32px";
  await act(async () => store.set(fontSizeAtom, 200));

  await renderAt(1931, true);
  expect(layoutMode()).toBe("mosaic");
  expect(latestContext?.arrangingAvailable).toBe(false);

  await renderAt(1932, true);
  expect(layoutMode()).toBe("mosaic");
  expect(latestContext?.arrangingAvailable).toBe(true);
  expect(mosaicTree()).toEqual(THREE_PANE_ARRANGEMENT);
});

test("divider drag in case 2 updates analysis-board-layouts only; in case 3 updates windowsState only", async () => {
  seedGameLayout(THREE_PANE_ARRANGEMENT);
  await renderAt(1400, true);
  const writes = vi.spyOn(Storage.prototype, "setItem");

  // Case 2 drag: updates analysis-board-layouts, never windowsState.
  const resized = { ...THREE_PANE_ARRANGEMENT, splitPercentage: 48 };
  await act(async () => dividers.get("left+database+bottomRight+topRight")!(resized));
  expect((readStoredGameLayout().arrangement as { splitPercentage?: number }).splitPercentage).toBe(
    48,
  );
  expect(writes.mock.calls.filter(([k]) => k === WINDOWS_STATE_KEY)).toEqual([]);

  // Case 3 drag: updates windowsState, never analysis-board-layouts.
  writes.mockClear();
  await renderAt(800, true);
  const nextWindows = {
    direction: "row" as const,
    first: "left" as const,
    second: {
      direction: "column" as const,
      first: "topRight" as const,
      second: "bottomRight" as const,
    },
    splitPercentage: 58,
  };
  await act(async () => dividers.get("left+topRight+bottomRight")!(nextWindows));
  expect(JSON.parse(localStorage.getItem(WINDOWS_STATE_KEY)!)).toEqual({
    currentNode: nextWindows,
  });
  expect(writes.mock.calls.filter(([k]) => k === ANALYSIS_BOARD_LAYOUTS_KEY)).toEqual([]);
  expect((readStoredGameLayout().arrangement as { splitPercentage?: number }).splitPercentage).toBe(
    48,
  );
});

test("hidden coach panel area is omitted while Coach is off and kept across divider drags", async () => {
  const withCoach: BoardArrangement = {
    direction: "row",
    first: "left",
    splitPercentage: 45,
    second: {
      direction: "column",
      first: "coach",
      splitPercentage: 35,
      second: {
        direction: "column",
        first: "topRight",
        second: "bottomRight",
        splitPercentage: 50,
      },
    },
  };
  seedGameLayout(withCoach);
  await renderAt(1400, true);
  expect(mosaicTree()).toEqual({
    direction: "row",
    first: "left",
    splitPercentage: 45,
    second: { direction: "column", first: "topRight", second: "bottomRight", splitPercentage: 50 },
  });
  expect([...(latestContext?.shownPanelAreas ?? [])]).toEqual([]);

  // Dragging a divider writes back past the hidden coach node.
  await act(async () =>
    dividers.get("left+topRight+bottomRight")!({
      direction: "row",
      first: "left",
      splitPercentage: 55,
      second: {
        direction: "column",
        first: "topRight",
        second: "bottomRight",
        splitPercentage: 65,
      },
    }),
  );
  expect(readStoredGameLayout().arrangement).toEqual({
    direction: "row",
    first: "left",
    splitPercentage: 55,
    second: {
      direction: "column",
      first: "coach",
      splitPercentage: 35,
      second: {
        direction: "column",
        first: "topRight",
        second: "bottomRight",
        splitPercentage: 65,
      },
    },
  });

  // Turning Coach on reveals the coach area in its preserved position.
  await act(async () => store.set(coachMock.atom!, true));
  expect([...(latestContext?.shownPanelAreas ?? [])]).toEqual(["coach"]);
});

test("hidden tabs leave the shown arrangement only; stacked, fallback and other boards still show them", async () => {
  const stored: BoardArrangement = {
    direction: "row",
    first: "left",
    splitPercentage: 45,
    second: {
      direction: "column",
      first: "topRight",
      splitPercentage: 30,
      second: "bottomRight",
    },
  };
  seedGameLayout(stored, true);
  const stripHidden = () => document.getElementById("topRight")?.closest("[hidden]") != null;

  await renderAt(1400, true);
  expect(mosaicTree()).toEqual({
    direction: "row",
    first: "left",
    splitPercentage: 45,
    second: "bottomRight",
  });
  expect(latestContext?.tabsHidden).toBe(true);
  expect(stripHidden()).toBe(true);

  // A divider drag while hidden keeps the strip's own split.
  await act(async () =>
    dividers.get("left+bottomRight")!({
      direction: "row",
      first: "left",
      splitPercentage: 60,
      second: "bottomRight",
    }),
  );
  expect(readStoredGameLayout().arrangement).toEqual({
    ...stored,
    splitPercentage: 60,
  });

  // Stacked and other boards ignore the flag.
  await renderAt(645, true);
  expect(latestContext?.tabsHidden).toBe(false);
  expect(stripHidden()).toBe(false);
  await renderAt(1400, false);
  expect(latestContext?.tabsHidden).toBe(false);
  expect(stripHidden()).toBe(false);

  // Showing again restores the strip at its place and size.
  await renderAt(1400, true);
  await act(async () => latestContext!.setTabsHidden(false));
  expect(readStoredGameLayout().tabsHidden).toBe(false);
  expect(mosaicTree()).toEqual({ ...stored, splitPercentage: 60 });
  expect(stripHidden()).toBe(false);
});

test("hidden tabs: the too-narrow fallback shows them, and a keyboard return focuses the notation grip", async () => {
  // Four columns: without the tabs three remain, which need 972px.
  const fourColumns: BoardArrangement = {
    direction: "row",
    first: "left",
    second: {
      direction: "row",
      first: "bottomRight",
      second: { direction: "row", first: "database", second: "topRight" },
    },
  };
  seedGameLayout(fourColumns, true);
  const stripHidden = () => document.getElementById("topRight")?.closest("[hidden]") != null;

  await renderAt(971, true);
  expect(latestContext?.arrangingAvailable).toBe(false);
  expect(latestContext?.tabsHidden).toBe(false);
  expect(stripHidden()).toBe(false);

  await renderAt(1100, true);
  expect(latestContext?.tabsHidden).toBe(true);
  expect(stripHidden()).toBe(true);
  const notationGrip = document.createElement("button");
  notationGrip.setAttribute("data-arrange-grip", "bottomRight");
  document.getElementById("bottomRight")!.appendChild(notationGrip);
  const hiddenDbTab = document.createElement("button");
  hiddenDbTab.setAttribute("role", "tab");
  hiddenDbTab.setAttribute("data-panel-tab", "database");
  document.getElementById("topRight")!.appendChild(hiddenDbTab);

  await act(async () => latestContext!.startPlacing("database"));
  const dialog = container.querySelector<HTMLElement>('[data-testid="board-arrange-placing"]')!;
  const back = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent === "Board.Arrange.BackIntoTabs",
  )!;
  await act(async () => back.click());
  expect(document.activeElement).toBe(notationGrip);
  expect(readStoredGameLayout().tabsHidden).toBe(true);
  expect(getGameArrangement()).toEqual({
    direction: "row",
    first: "left",
    second: { direction: "row", first: "bottomRight", second: "topRight" },
  });
});

test("returnPanel removes the panel area from the kind's stored arrangement", async () => {
  seedGameLayout(THREE_PANE_ARRANGEMENT);
  await renderAt(1400, true);
  expect([...(latestContext?.shownPanelAreas ?? [])]).toEqual(["database"]);

  await act(async () => latestContext!.returnPanel("database" as PanelAreaId));
  expect([...(latestContext?.shownPanelAreas ?? [])]).toEqual([]);
  expect(getGameArrangement()).toEqual({
    direction: "row",
    first: "left",
    splitPercentage: 40,
    second: { direction: "row", first: "bottomRight", second: "topRight", splitPercentage: 55 },
  });
});

test("non-arrangeable boards (play, puzzles) ignore analysis layouts and stay on windowsState", async () => {
  seedGameLayout(THREE_PANE_ARRANGEMENT);
  await renderAt(1400, false);
  expect(layoutMode()).toBe("mosaic");
  expect(latestContext?.arrangingAvailable).toBe(false);
  expect([...(latestContext?.shownPanelAreas ?? [])]).toEqual([]);
  expect(mosaicTree()).toEqual(defaultBoardArrangement());
});

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    x: left,
    y: top,
    toJSON: () => ({}),
  };
}

function mockLayoutGeometry(layoutEl: HTMLElement) {
  vi.spyOn(layoutEl, "getBoundingClientRect").mockReturnValue(rect(0, 0, 1400, 800));
  const left = document.getElementById("left")!;
  const topRight = document.getElementById("topRight")!;
  const bottomRight = document.getElementById("bottomRight")!;
  const db = document.getElementById(boardAreaTargetId("database"))!;
  vi.spyOn(left, "getBoundingClientRect").mockReturnValue(rect(0, 0, 700, 800));
  vi.spyOn(topRight, "getBoundingClientRect").mockReturnValue(rect(700, 0, 700, 400));
  vi.spyOn(bottomRight, "getBoundingClientRect").mockReturnValue(rect(700, 400, 700, 400));
  vi.spyOn(db, "getBoundingClientRect").mockReturnValue(rect(0, 560, 700, 240));
}

function makePointerEvent(
  type: string,
  init: { clientX?: number; clientY?: number; button?: number; pointerId?: number } = {},
) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: init.clientX ?? 0,
    clientY: init.clientY ?? 0,
    button: init.button ?? 0,
  });
  Object.defineProperty(event, "pointerId", { value: init.pointerId ?? 1 });
  return event;
}

test("pointer drag previews each side and applies placement; return over tab list notifies listener", async () => {
  setGameArrangement(defaultBoardArrangement());
  await renderAt(1400, true);
  const layoutEl = container.querySelector<HTMLElement>("[data-board-layout]")!;
  mockLayoutGeometry(layoutEl);

  const tabList = document.createElement("div");
  tabList.setAttribute("data-board-tab-list", "true");
  vi.spyOn(tabList, "getBoundingClientRect").mockReturnValue(rect(704, 4, 692, 40));
  const dbTab = document.createElement("button");
  dbTab.setAttribute("role", "tab");
  dbTab.setAttribute("data-panel-tab", "database");
  tabList.appendChild(dbTab);
  document.getElementById("topRight")!.appendChild(tabList);

  const captureSpy = vi.fn();
  const releaseSpy = vi.fn();
  let captured = false;
  dbTab.setPointerCapture = (id: number) => {
    captured = true;
    captureSpy(id);
  };
  dbTab.hasPointerCapture = () => captured;
  dbTab.releasePointerCapture = (id: number) => {
    captured = false;
    releaseSpy(id);
  };

  // Drag database tab to the bottom edge of the board.
  await act(async () => {
    latestContext!.beginDrag("database", {
      button: 0,
      pointerId: 7,
      clientX: 750,
      clientY: 20,
      currentTarget: dbTab,
      target: dbTab,
    } as unknown as React.PointerEvent<HTMLElement>);
  });

  // Move over bottom edge of the board -> acquires pointer capture and shows bottom preview.
  await act(async () => {
    window.dispatchEvent(
      makePointerEvent("pointermove", { pointerId: 7, clientX: 350, clientY: 780 }),
    );
  });
  expect(captureSpy).toHaveBeenCalledWith(7);
  const preview = container.querySelector('[data-testid="board-arrange-preview"]');
  expect(preview?.getAttribute("data-arrange-target")).toBe("left");
  expect(preview?.getAttribute("data-arrange-side")).toBe("bottom");

  // Release applies placement and releases pointer capture.
  await act(async () => {
    window.dispatchEvent(
      makePointerEvent("pointerup", { pointerId: 7, clientX: 350, clientY: 780 }),
    );
  });
  expect(releaseSpy).toHaveBeenCalledWith(7);
  expect(container.querySelector('[data-testid="board-arrange-preview"]')).toBeNull();
  expect([...(latestContext?.shownPanelAreas ?? [])]).toEqual(["database"]);
  expect(getGameArrangement()).toEqual({
    direction: "row",
    first: { direction: "column", first: "left", second: "database", splitPercentage: 50 },
    second: { direction: "column", first: "topRight", second: "bottomRight" },
  });

  // Drag database area back over the tab list -> "return" preview, release returns and notifies listener.
  const onReturned = vi.fn();
  latestContext!.registerReturnListener(onReturned);
  const dbHeader = document.createElement("div");
  let headerCaptured = false;
  dbHeader.setPointerCapture = () => {
    headerCaptured = true;
  };
  dbHeader.hasPointerCapture = () => headerCaptured;
  dbHeader.releasePointerCapture = () => {
    headerCaptured = false;
  };
  await act(async () => {
    latestContext!.beginDrag("database", {
      button: 0,
      pointerId: 8,
      clientX: 200,
      clientY: 600,
      currentTarget: dbHeader,
      target: dbHeader,
    } as unknown as React.PointerEvent<HTMLElement>);
    window.dispatchEvent(
      makePointerEvent("pointermove", { pointerId: 8, clientX: 800, clientY: 24 }),
    );
  });
  expect(
    container
      .querySelector('[data-testid="board-arrange-preview"]')
      ?.getAttribute("data-arrange-kind"),
  ).toBe("return");
  await act(async () => {
    window.dispatchEvent(
      makePointerEvent("pointerup", { pointerId: 8, clientX: 800, clientY: 24 }),
    );
  });
  expect(onReturned).toHaveBeenCalledExactlyOnceWith("database");
  expect([...(latestContext?.shownPanelAreas ?? [])]).toEqual([]);
  expect(headerCaptured).toBe(false);
});

test.each(["outside", "escape", "pointercancel", "lostcapture", "blur", "leave-case-2"] as const)(
  "ending drag without a change (%s) cleans up preview, capture and leaves arrangement untouched",
  async (ending) => {
    await renderAt(1400, true);
    const layoutEl = container.querySelector<HTMLElement>("[data-board-layout]")!;
    mockLayoutGeometry(layoutEl);
    const before = getGameArrangement();

    const handle = document.createElement("button");
    let captured = false;
    handle.setPointerCapture = () => {
      captured = true;
    };
    handle.hasPointerCapture = () => captured;
    handle.releasePointerCapture = () => {
      captured = false;
    };

    await act(async () => {
      latestContext!.beginDrag("database", {
        button: 0,
        pointerId: 3,
        clientX: 750,
        clientY: 20,
        currentTarget: handle,
        target: handle,
      } as unknown as React.PointerEvent<HTMLElement>);
      window.dispatchEvent(
        makePointerEvent("pointermove", { pointerId: 3, clientX: 350, clientY: 780 }),
      );
    });
    expect(container.querySelector('[data-testid="board-arrange-preview"]')).not.toBeNull();

    await act(async () => {
      if (ending === "outside") {
        window.dispatchEvent(
          makePointerEvent("pointermove", { pointerId: 3, clientX: 2000, clientY: 2000 }),
        );
        window.dispatchEvent(
          makePointerEvent("pointerup", { pointerId: 3, clientX: 2000, clientY: 2000 }),
        );
      } else if (ending === "escape") {
        window.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
        );
      } else if (ending === "pointercancel") {
        window.dispatchEvent(makePointerEvent("pointercancel", { pointerId: 3 }));
      } else if (ending === "lostcapture") {
        captured = false;
        handle.dispatchEvent(makePointerEvent("lostpointercapture", { pointerId: 3 }));
      } else if (ending === "blur") {
        window.dispatchEvent(new Event("blur"));
      } else if (ending === "leave-case-2") {
        await renderAt(500, true);
      }
    });

    expect(container.querySelector('[data-testid="board-arrange-preview"]')).toBeNull();
    expect(captured).toBe(false);
    expect(getGameArrangement()).toEqual(before);
  },
);

test("keyboard placing uses an aria-modal dialog, suppresses board hotkeys, traps focus, respects fit rule and restores focus", async () => {
  seedGameLayout(THREE_PANE_ARRANGEMENT);
  // 1100px fits 3 panes (972px) but not 4 (1298px).
  await renderAt(1100, true);

  // Add mock grips and a tab inside the layout so focus restoration can land on them.
  const grip = document.createElement("button");
  grip.setAttribute("data-arrange-grip", "database");
  document.getElementById(boardAreaTargetId("database"))!.appendChild(grip);
  const dbTab = document.createElement("button");
  dbTab.setAttribute("role", "tab");
  dbTab.setAttribute("data-panel-tab", "database");
  document.getElementById("topRight")!.appendChild(dbTab);

  // Start placing a panel from the strip ("analysis") at 3-pane width (1100px: 3 panes fit, 4 do not).
  // Placing sideways next to left, bottomRight or topRight would need 4 panes and is omitted;
  // only vertical targets (and sideways next to database, which spans 2 panes) fit in 3 panes.
  await act(async () => latestContext!.startPlacing("analysis", "topRight"));
  const dialog = container.querySelector<HTMLElement>('[data-testid="board-arrange-placing"]')!;
  expect(dialog).not.toBeNull();
  expect(dialog.getAttribute("role")).toBe("dialog");
  expect(dialog.getAttribute("aria-modal")).toBe("true");
  const buttons = [...dialog.querySelectorAll("button")];
  // First target button is focused (not the Cancel icon button).
  expect(document.activeElement).toBe(buttons[1]);
  // In a pure 3-column arrangement (no spanning database), NO LeftOf/RightOf target fits.
  const pureThreeColumns: BoardArrangement = {
    direction: "row",
    first: "left",
    second: { direction: "row", first: "bottomRight", second: "topRight" },
  };
  await act(async () => setGameArrangement(pureThreeColumns));
  const pureButtons = [...dialog.querySelectorAll("button")];
  const pureLabels = pureButtons.slice(1).map((b) => b.textContent);
  expect(pureLabels.some((label) => label?.includes("LeftOf") || label?.includes("RightOf"))).toBe(
    false,
  );
  // Restore THREE_PANE_ARRANGEMENT for the return-to-tabs check below.
  await act(async () => setGameArrangement(THREE_PANE_ARRANGEMENT));

  // Board hotkeys are suppressed while placing is open.
  const moveEvent = new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true });
  Object.defineProperty(moveEvent, "target", { value: document.activeElement });
  expect(isHotkeySuppressed(moveEvent, null)).toBe(true);

  // Escape cancels placing without changing the arrangement and restores focus to the origin grip.
  const stripGrip = document.createElement("button");
  stripGrip.setAttribute("data-arrange-grip", "topRight");
  document.getElementById("topRight")!.appendChild(stripGrip);
  await act(async () => {
    dialog.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
  });
  expect(container.querySelector('[data-testid="board-arrange-placing"]')).toBeNull();
  expect(document.activeElement).toBe(stripGrip);

  // Focus trap: Tab wraps from last button to first, Shift+Tab wraps from first to last.
  await act(async () => latestContext!.startPlacing("database"));
  const trapDialog = container.querySelector<HTMLElement>('[data-testid="board-arrange-placing"]')!;
  const trapButtons = [...trapDialog.querySelectorAll<HTMLButtonElement>("button")];
  expect(trapButtons.length).toBeGreaterThan(2);
  const firstBtn = trapButtons[0];
  const lastBtn = trapButtons[trapButtons.length - 1];
  lastBtn.focus();
  await act(async () => {
    trapDialog.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }),
    );
  });
  expect(document.activeElement).toBe(firstBtn);
  await act(async () => {
    trapDialog.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }),
    );
  });
  expect(document.activeElement).toBe(lastBtn);

  // Place "database" back into the tabs by keyboard: focuses returned panel's tab.
  const returnButton = trapButtons.find((b) => b.textContent === "Board.Arrange.BackIntoTabs")!;
  expect(returnButton).toBeDefined();
  await act(async () => returnButton.click());
  expect(container.querySelector('[data-testid="board-arrange-placing"]')).toBeNull();
  expect(document.activeElement).toBe(dbTab);
});

test("throwing setPointerCapture fails closed with no preview and no leaked listeners", async () => {
  await renderAt(1400, true);
  const layoutEl = container.querySelector<HTMLElement>("[data-board-layout]")!;
  mockLayoutGeometry(layoutEl);

  const addSpy = vi.spyOn(window, "addEventListener");
  const removeSpy = vi.spyOn(window, "removeEventListener");
  const before = getGameArrangement();

  const handle = document.createElement("button");
  handle.setPointerCapture = () => {
    throw new DOMException("No active pointer", "NotFoundError");
  };

  await act(async () => {
    latestContext!.beginDrag("database", {
      button: 0,
      pointerId: 11,
      clientX: 750,
      clientY: 20,
      currentTarget: handle,
      target: handle,
    } as unknown as React.PointerEvent<HTMLElement>);
    window.dispatchEvent(
      makePointerEvent("pointermove", { pointerId: 11, clientX: 350, clientY: 780 }),
    );
  });

  expect(container.querySelector('[data-testid="board-arrange-preview"]')).toBeNull();
  expect(getGameArrangement()).toEqual(before);
  const addedTypes = addSpy.mock.calls.map(([type]) => type);
  const removedTypes = removeSpy.mock.calls.map(([type]) => type);
  for (const type of ["pointermove", "pointerup", "pointercancel", "keydown", "blur"]) {
    expect(addedTypes.filter((t) => t === type).length).toBe(
      removedTypes.filter((t) => t === type).length,
    );
  }
});

test("threshold, click suppression on release and Escape, and data-no-drag guard", async () => {
  await renderAt(1400, true);
  const layoutEl = container.querySelector<HTMLElement>("[data-board-layout]")!;
  mockLayoutGeometry(layoutEl);

  const handle = document.createElement("button");
  const captureSpy = vi.fn();
  handle.setPointerCapture = captureSpy;
  handle.hasPointerCapture = () => false;
  handle.releasePointerCapture = vi.fn();

  // Sub-threshold move (< 6px): does not start a drag and lets click through.
  await act(async () => {
    latestContext!.beginDrag("database", {
      button: 0,
      pointerId: 12,
      clientX: 750,
      clientY: 20,
      currentTarget: handle,
      target: handle,
    } as unknown as React.PointerEvent<HTMLElement>);
    window.dispatchEvent(
      makePointerEvent("pointermove", { pointerId: 12, clientX: 752, clientY: 22 }),
    );
    window.dispatchEvent(
      makePointerEvent("pointerup", { pointerId: 12, clientX: 752, clientY: 22 }),
    );
  });
  expect(captureSpy).not.toHaveBeenCalled();
  expect(container.querySelector('[data-testid="board-arrange-preview"]')).toBeNull();
  const subThresholdClick = { preventDefault: vi.fn(), stopPropagation: vi.fn() };
  latestContext!.consumeSuppressedClick(subThresholdClick as unknown as React.MouseEvent);
  expect(subThresholdClick.preventDefault).not.toHaveBeenCalled();

  // Drag past threshold then release over origin: suppresses trailing click.
  const afterDragClick = { preventDefault: vi.fn(), stopPropagation: vi.fn() };
  await act(async () => {
    latestContext!.beginDrag("database", {
      button: 0,
      pointerId: 13,
      clientX: 750,
      clientY: 20,
      currentTarget: handle,
      target: handle,
    } as unknown as React.PointerEvent<HTMLElement>);
    window.dispatchEvent(
      makePointerEvent("pointermove", { pointerId: 13, clientX: 750, clientY: 40 }),
    );
    window.dispatchEvent(
      makePointerEvent("pointerup", { pointerId: 13, clientX: 750, clientY: 20 }),
    );
    latestContext!.consumeSuppressedClick(afterDragClick as unknown as React.MouseEvent);
  });
  expect(afterDragClick.preventDefault).toHaveBeenCalledOnce();
  expect(afterDragClick.stopPropagation).toHaveBeenCalledOnce();

  // Escape during an active drag keeps click suppression armed past 50 ms until that pointer
  // releases, then disarms via the short timer (even when released outside with no trailing click),
  // ignores other pointers, clears on blur/pointercancel, and cleans up one-shot listeners on unmount.
  vi.useFakeTimers();
  try {
    const startActiveDragThenEscape = async (pointerId: number) => {
      await act(async () => {
        latestContext!.beginDrag("database", {
          button: 0,
          pointerId,
          clientX: 750,
          clientY: 20,
          currentTarget: handle,
          target: handle,
        } as unknown as React.PointerEvent<HTMLElement>);
        window.dispatchEvent(
          makePointerEvent("pointermove", { pointerId, clientX: 750, clientY: 40 }),
        );
        window.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
        );
      });
    };

    // 1. Release over origin after 50 ms: trailing click is suppressed; mismatched pointerId does not disarm early.
    await startActiveDragThenEscape(14);
    await act(async () => {
      vi.advanceTimersByTime(50);
      window.dispatchEvent(
        makePointerEvent("pointerup", { pointerId: 999, clientX: 750, clientY: 20 }),
      );
      vi.advanceTimersByTime(10);
    });
    const afterEscReleaseClick = { preventDefault: vi.fn(), stopPropagation: vi.fn() };
    await act(async () => {
      window.dispatchEvent(
        makePointerEvent("pointerup", { pointerId: 14, clientX: 750, clientY: 20 }),
      );
      latestContext!.consumeSuppressedClick(afterEscReleaseClick as unknown as React.MouseEvent);
    });
    expect(afterEscReleaseClick.preventDefault).toHaveBeenCalledOnce();
    expect(afterEscReleaseClick.stopPropagation).toHaveBeenCalledOnce();

    // 2. Release outside the handle (no trailing click before the timer expires): onRelease arms the
    //    short timer and disarms suppressClickRef so a later independent click goes through.
    await startActiveDragThenEscape(16);
    await act(async () => {
      vi.advanceTimersByTime(50);
      window.dispatchEvent(
        makePointerEvent("pointerup", { pointerId: 16, clientX: 10, clientY: 10 }),
      );
      vi.advanceTimersByTime(10);
    });
    const laterClick = { preventDefault: vi.fn(), stopPropagation: vi.fn() };
    latestContext!.consumeSuppressedClick(laterClick as unknown as React.MouseEvent);
    expect(laterClick.preventDefault).not.toHaveBeenCalled();

    // 3. pointercancel for the same pointer disarms suppression via onRelease + timer.
    await startActiveDragThenEscape(17);
    await act(async () => {
      window.dispatchEvent(makePointerEvent("pointercancel", { pointerId: 17 }));
      vi.advanceTimersByTime(10);
    });
    const afterCancelClick = { preventDefault: vi.fn(), stopPropagation: vi.fn() };
    latestContext!.consumeSuppressedClick(afterCancelClick as unknown as React.MouseEvent);
    expect(afterCancelClick.preventDefault).not.toHaveBeenCalled();

    // 4. Window blur while awaiting post-Escape release immediately clears suppression and removes listeners.
    await startActiveDragThenEscape(18);
    const removeOnBlurSpy = vi.spyOn(window, "removeEventListener");
    await act(async () => {
      window.dispatchEvent(new Event("blur"));
    });
    for (const type of ["pointerup", "pointercancel", "blur"]) {
      expect(removeOnBlurSpy.mock.calls.filter(([t]) => t === type).length).toBe(1);
    }
    removeOnBlurSpy.mockRestore();
    const afterBlurClick = { preventDefault: vi.fn(), stopPropagation: vi.fn() };
    latestContext!.consumeSuppressedClick(afterBlurClick as unknown as React.MouseEvent);
    expect(afterBlurClick.preventDefault).not.toHaveBeenCalled();

    // 5. Unmounting while waiting for the Escape-cancelled pointer's release removes the 3 post-Escape listeners.
    await startActiveDragThenEscape(21);
    const removeOnUnmountSpy = vi.spyOn(window, "removeEventListener");
    await act(async () => root.unmount());
    for (const type of ["pointerup", "pointercancel", "blur"]) {
      expect(removeOnUnmountSpy.mock.calls.filter(([t]) => t === type).length).toBe(1);
    }
    removeOnUnmountSpy.mockRestore();
    root = createRoot(container);
    await renderAt(1400, true);
    mockLayoutGeometry(container.querySelector<HTMLElement>("[data-board-layout]")!);
  } finally {
    vi.useRealTimers();
  }

  // Pointerdown originating inside [data-no-drag="true"] never starts a drag.
  const noDragChild = document.createElement("button");
  noDragChild.setAttribute("data-no-drag", "true");
  handle.appendChild(noDragChild);
  captureSpy.mockClear();
  await act(async () => {
    latestContext!.beginDrag("database", {
      button: 0,
      pointerId: 15,
      clientX: 750,
      clientY: 20,
      currentTarget: handle,
      target: noDragChild,
    } as unknown as React.PointerEvent<HTMLElement>);
    window.dispatchEvent(
      makePointerEvent("pointermove", { pointerId: 15, clientX: 350, clientY: 780 }),
    );
  });
  expect(captureSpy).not.toHaveBeenCalled();
  expect(container.querySelector('[data-testid="board-arrange-preview"]')).toBeNull();
});

test("unmount during active drag cleans up listeners and capture; placing ends on blur, leaving case 2 and unmount", async () => {
  await renderAt(1400, true);
  const layoutEl = container.querySelector<HTMLElement>("[data-board-layout]")!;
  mockLayoutGeometry(layoutEl);

  // Placing closes on window blur and removes its blur listener.
  const addSpy = vi.spyOn(window, "addEventListener");
  const removeSpy = vi.spyOn(window, "removeEventListener");
  await act(async () => latestContext!.startPlacing("database"));
  expect(container.querySelector('[data-testid="board-arrange-placing"]')).not.toBeNull();
  await act(async () => window.dispatchEvent(new Event("blur")));
  expect(container.querySelector('[data-testid="board-arrange-placing"]')).toBeNull();
  expect(addSpy.mock.calls.filter(([t]) => t === "blur").length).toBe(
    removeSpy.mock.calls.filter(([t]) => t === "blur").length,
  );

  // Placing closes when leaving case 2 (narrowing to stacked).
  await act(async () => latestContext!.startPlacing("database"));
  expect(container.querySelector('[data-testid="board-arrange-placing"]')).not.toBeNull();
  await renderAt(500, true);
  expect(container.querySelector('[data-testid="board-arrange-placing"]')).toBeNull();

  // Unmount during active drag removes all window listeners and releases pointer capture.
  await renderAt(1400, true);
  mockLayoutGeometry(container.querySelector<HTMLElement>("[data-board-layout]")!);
  addSpy.mockClear();
  removeSpy.mockClear();
  const handle = document.createElement("button");
  let captured = false;
  const releaseSpy = vi.fn(() => {
    captured = false;
  });
  handle.setPointerCapture = () => {
    captured = true;
  };
  handle.hasPointerCapture = () => captured;
  handle.releasePointerCapture = releaseSpy;

  await act(async () => {
    latestContext!.beginDrag("database", {
      button: 0,
      pointerId: 19,
      clientX: 750,
      clientY: 20,
      currentTarget: handle,
      target: handle,
    } as unknown as React.PointerEvent<HTMLElement>);
    window.dispatchEvent(
      makePointerEvent("pointermove", { pointerId: 19, clientX: 350, clientY: 780 }),
    );
  });
  expect(captured).toBe(true);
  await act(async () => root.unmount());
  expect(releaseSpy).toHaveBeenCalledWith(19);
  for (const type of ["pointermove", "pointerup", "pointercancel", "keydown", "blur"]) {
    expect(addSpy.mock.calls.filter(([t]) => t === type).length).toBe(
      removeSpy.mock.calls.filter(([t]) => t === type).length,
    );
  }
  // Recreate root for afterEach cleanup.
  root = createRoot(container);
});

test("pending focus whose target never mounts does not steal focus later; zero-targets renders Board.Arrange.NoTargets", async () => {
  const fourTakenOut: BoardArrangement = {
    direction: "row",
    first: "left",
    second: {
      direction: "column",
      first: "analysis",
      second: {
        direction: "column",
        first: "report",
        second: {
          direction: "column",
          first: "database",
          second: {
            direction: "column",
            first: "annotate",
            second: { direction: "column", first: "topRight", second: "bottomRight" },
          },
        },
      },
    },
  };
  seedGameLayout(fourTakenOut);
  await renderAt(1400, true);

  // Zero-targets branch: placing "info" violates the strip rule so 0 targets are offered.
  await act(async () => latestContext!.startPlacing("info", "topRight"));
  const dialog = container.querySelector('[data-testid="board-arrange-placing"]')!;
  expect(dialog.textContent).toContain("Board.Arrange.NoTargets");

  // Cancel when origin grip ("topRight") never mounts: after rAF retry, pending focus is cleared
  // so mounting the grip later and changing displayedArrangement does NOT steal focus.
  const rafQueue: FrameRequestCallback[] = [];
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    rafQueue.push(cb);
    return rafQueue.length;
  });
  const elsewhere = document.createElement("button");
  container.appendChild(elsewhere);
  elsewhere.focus();
  await act(async () => {
    dialog.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
  });
  // Flush the one rAF retry while grip is still absent.
  await act(async () => {
    for (const cb of rafQueue.splice(0)) cb(0);
  });
  // Now mount the grip and trigger a displayedArrangement change.
  const lateGrip = document.createElement("button");
  lateGrip.setAttribute("data-arrange-grip", "topRight");
  document.getElementById("topRight")!.appendChild(lateGrip);
  elsewhere.focus();
  await act(async () => latestContext!.returnPanel("analysis"));
  expect(document.activeElement).toBe(elsewhere);
});

test("placing Escape cancels when focus is on body, and does not steal Escape from a higher aria-modal dialog", async () => {
  await renderAt(1400, true);
  const stripGrip = document.createElement("button");
  stripGrip.setAttribute("data-arrange-grip", "topRight");
  document.getElementById("topRight")!.appendChild(stripGrip);

  await act(async () => latestContext!.startPlacing("database", "topRight"));
  expect(container.querySelector('[data-testid="board-arrange-placing"]')).not.toBeNull();

  // Higher aria-modal dialog owning focus: Escape must NOT close placing.
  const higherModal = document.createElement("div");
  higherModal.setAttribute("role", "dialog");
  higherModal.setAttribute("aria-modal", "true");
  const higherBtn = document.createElement("button");
  higherModal.appendChild(higherBtn);
  document.body.appendChild(higherModal);
  higherBtn.focus();
  await act(async () => {
    higherBtn.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
  });
  expect(container.querySelector('[data-testid="board-arrange-placing"]')).not.toBeNull();
  higherModal.remove();

  // Focus on body with placing topmost: bubble-phase Escape cancels placing and restores focus to origin grip.
  document.body.focus();
  await act(async () => {
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
  });
  expect(container.querySelector('[data-testid="board-arrange-placing"]')).toBeNull();
  expect(document.activeElement).toBe(stripGrip);
});

test("exposes element portal targets for base, panel and special-char engine leaves, restores focus safely, and drops removed engine targets in the same render", async () => {
  const specialEngineId = 'legacy-engine-identity:sf"16\\x';
  const specialEngine = engineAreaId(specialEngineId);
  store.set(enginesMock.atom!, [{ id: specialEngineId, name: "Stockfish", loaded: true }]);
  const withEngine = placeArea(defaultBoardArrangement(), specialEngine, "left", "bottom");
  seedGameLayout(withEngine);

  let observedTargetInRender: HTMLElement | undefined;
  function EnginePortalConsumer() {
    const ctx = useContext(BoardArrangementContext);
    const engineTarget = ctx.getAreaTarget(specialEngine);
    observedTargetInRender = engineTarget;
    return engineTarget ? (
      <Portal target={engineTarget}>
        <button type="button" data-arrange-grip={specialEngine}>
          engine-grip
        </button>
      </Portal>
    ) : null;
  }

  measured.width = 1400;
  await act(async () =>
    root.render(
      <Provider store={store}>
        <MantineProvider>
          <BoardTabLayout arrangeable kind="game">
            <StatefulConsumer />
            <ArrangementProbe />
            <EnginePortalConsumer />
          </BoardTabLayout>
        </MantineProvider>
      </Provider>,
    ),
  );

  const engineTarget = latestContext!.getAreaTarget(specialEngine);
  expect(engineTarget).toBeInstanceOf(HTMLDivElement);
  expect(engineTarget?.id).toBe("");
  expect(engineTarget?.dataset.boardArea).toBe(specialEngine);
  expect(observedTargetInRender).toBe(engineTarget);
  expect(latestContext!.getAreaTarget("left")).toBe(document.getElementById("left"));
  expect(latestContext!.getAreaTarget("database")).toBe(
    document.getElementById(boardAreaTargetId("database")),
  );

  const grip = engineTarget!.querySelector<HTMLButtonElement>("button")!;
  expect(grip).not.toBeNull();
  expect(grip.textContent).toBe("engine-grip");

  // Cancelling keyboard placing on an engine area whose id contains `:`, `"` and `\` restores focus without selector errors.
  await act(async () => latestContext!.startPlacing(specialEngine, specialEngine));
  expect(container.querySelector('[data-testid="board-arrange-placing"]')).not.toBeNull();
  await act(async () => {
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
  });
  expect(document.activeElement).toBe(grip);

  // Removing the engine leaf drops its target during that same render and leaves no hidden host for it.
  await act(async () => setGameArrangement(defaultBoardArrangement()));
  expect(observedTargetInRender).toBeUndefined();
  expect(latestContext!.getAreaTarget(specialEngine)).toBeUndefined();
  const hiddenHostSlots = [...container.querySelectorAll("[hidden] [data-board-slot]")].map((el) =>
    el.getAttribute("data-board-slot"),
  );
  expect(hiddenHostSlots).not.toContain(specialEngine);
  const remainingEngineTargets = [
    ...container.querySelectorAll<HTMLElement>("[data-board-area]"),
  ].filter((el) => el.dataset.boardArea === specialEngine);
  expect(remainingEngineTargets).toEqual([]);
});

test("engine return via keyboard placing focuses returned card grip, or Analysis tab, or notation grip when strip is hidden", async () => {
  const engId = "sf:1";
  const engArea = engineAreaId(engId);
  store.set(enginesMock.atom!, [{ id: engId, name: "Stockfish", loaded: true }]);

  // Case 1: returned card grip is rendered -> focuses returned card grip.
  const withEngine = placeArea(defaultBoardArrangement(), engArea, "left", "bottom");
  seedGameLayout(withEngine);
  let showCardInPanel = true;
  function FocusProbe() {
    const ctx = useContext(BoardArrangementContext);
    return (
      <>
        <Portal target={ctx.getAreaTarget("topRight")}>
          <button type="button" role="tab" data-panel-tab="analysis">
            Analysis
          </button>
          {showCardInPanel && !ctx.shownEngineAreas.has(engArea) && (
            <button type="button" data-arrange-grip={engArea}>
              panel-card-grip
            </button>
          )}
        </Portal>
        <Portal target={ctx.getAreaTarget("bottomRight")}>
          <button type="button" data-arrange-grip="bottomRight">
            notation-grip
          </button>
        </Portal>
      </>
    );
  }
  measured.width = 1400;
  await act(async () =>
    root.render(
      <Provider store={store}>
        <MantineProvider>
          <BoardTabLayout arrangeable kind="game">
            <ArrangementProbe />
            <FocusProbe />
          </BoardTabLayout>
        </MantineProvider>
      </Provider>,
    ),
  );
  await act(async () => latestContext!.startPlacing(engArea, engArea));
  const returnBtn = [
    ...container.querySelectorAll<HTMLButtonElement>(
      '[data-testid="board-arrange-placing"] button',
    ),
  ].find((btn) => btn.textContent === "Board.Arrange.BackIntoEngines")!;
  expect(returnBtn).toBeDefined();
  await act(async () => returnBtn.click());
  expect(document.activeElement?.textContent).toBe("panel-card-grip");

  // Case 2: card not rendered (another tab active), strip visible -> focuses Analysis strip tab.
  showCardInPanel = false;
  await act(async () => setGameArrangement(withEngine));
  await act(async () => latestContext!.startPlacing(engArea, engArea));
  const returnBtn2 = [
    ...container.querySelectorAll<HTMLButtonElement>(
      '[data-testid="board-arrange-placing"] button',
    ),
  ].find((btn) => btn.textContent === "Board.Arrange.BackIntoEngines")!;
  await act(async () => returnBtn2.click());
  await act(async () => {
    await new Promise((r) => requestAnimationFrame(r));
  });
  expect(document.activeElement?.textContent).toBe("Analysis");

  // Case 3: strip hidden with Analysis selected (card grip mounted inside `<div hidden>`) ->
  // both keyboard return and × (`returnEngine`) skip the hidden subtree and focus the notation grip.
  showCardInPanel = true;
  await act(async () => {
    latestContext!.setTabsHidden(true);
    setGameArrangement(withEngine);
  });
  await act(async () => latestContext!.startPlacing(engArea, engArea));
  const returnBtn3 = [
    ...container.querySelectorAll<HTMLButtonElement>(
      '[data-testid="board-arrange-placing"] button',
    ),
  ].find((btn) => btn.textContent === "Board.Arrange.BackIntoEngines")!;
  await act(async () => returnBtn3.click());
  await act(async () => {
    await new Promise((r) => requestAnimationFrame(r));
  });
  expect(document.activeElement?.textContent).toBe("notation-grip");

  // Clicking × (`returnEngine`) on an engine window while the strip is hidden also removes the leaf
  // and lands focus on the notation grip rather than the hidden panel card grip.
  await act(async () => setGameArrangement(withEngine));
  (document.activeElement as HTMLElement | null)?.blur();
  await act(async () => latestContext!.returnEngine(engArea));
  await act(async () => {
    await new Promise((r) => requestAnimationFrame(r));
  });
  expect(latestContext!.shownEngineAreas.has(engArea)).toBe(false);
  expect(getGameArrangement()).toEqual(defaultBoardArrangement());
  expect(document.activeElement?.textContent).toBe("notation-grip");
});

test("engine card grip drag reorders even in stacked (non-arranged) mode", async () => {
  store.set(enginesMock.atom!, [
    { id: "e1", name: "One", loaded: true },
    { id: "e2", name: "Two", loaded: true },
  ]);
  const onReorder = vi.fn();
  let listEl: HTMLDivElement | null = null;
  function StackedEngineList() {
    const ctx = useContext(BoardArrangementContext);
    return (
      <Portal target={ctx.getAreaTarget("topRight")}>
        <div
          ref={(el) => {
            listEl = el;
          }}
        >
          {["e1", "e2"].map((id) => (
            <div key={id} data-engine-card-id={id}>
              <button
                type="button"
                data-arrange-grip={engineAreaId(id)}
                onPointerDown={(e) =>
                  ctx.beginDrag(engineAreaId(id), e, {
                    listContainer: listEl,
                    reorderIds: ["e1", "e2"],
                    onReorder,
                  })
                }
              >
                {id}
              </button>
            </div>
          ))}
        </div>
      </Portal>
    );
  }
  measured.width = 500; // stacked mode -> arrangingAvailable is false
  await act(async () =>
    root.render(
      <Provider store={store}>
        <MantineProvider>
          <BoardTabLayout arrangeable kind="game">
            <ArrangementProbe />
            <StackedEngineList />
          </BoardTabLayout>
        </MantineProvider>
      </Provider>,
    ),
  );
  expect(latestContext!.arrangingAvailable).toBe(false);
  const layoutEl = container.querySelector<HTMLElement>("[data-board-layout]")!;
  vi.spyOn(layoutEl, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 500, 700));
  vi.spyOn(listEl!, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 100, 400, 120));
  const cards = [...listEl!.querySelectorAll<HTMLElement>("[data-engine-card-id]")];
  vi.spyOn(cards[0], "getBoundingClientRect").mockReturnValue(new DOMRect(0, 100, 400, 50));
  vi.spyOn(cards[1], "getBoundingClientRect").mockReturnValue(new DOMRect(0, 160, 400, 50));

  const grip0 = cards[0].querySelector<HTMLButtonElement>("button")!;
  grip0.setPointerCapture = vi.fn();
  grip0.releasePointerCapture = vi.fn();
  await act(async () => {
    grip0.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        button: 0,
        pointerId: 1,
        clientX: 20,
        clientY: 120,
      }),
    );
    window.dispatchEvent(
      new PointerEvent("pointermove", { bubbles: true, pointerId: 1, clientX: 20, clientY: 205 }),
    );
    window.dispatchEvent(
      new PointerEvent("pointerup", { bubbles: true, pointerId: 1, clientX: 20, clientY: 205 }),
    );
  });
  expect(onReorder).toHaveBeenCalledWith(0, 1);

  // Upward reorder: dragging card 1 above card 0's midpoint calls onReorder(1, 0).
  onReorder.mockClear();
  const grip1 = cards[1].querySelector<HTMLButtonElement>("button")!;
  grip1.setPointerCapture = vi.fn();
  grip1.releasePointerCapture = vi.fn();
  await act(async () => {
    grip1.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        button: 0,
        pointerId: 2,
        clientX: 20,
        clientY: 180,
      }),
    );
    window.dispatchEvent(
      new PointerEvent("pointermove", { bubbles: true, pointerId: 2, clientX: 20, clientY: 105 }),
    );
    window.dispatchEvent(
      new PointerEvent("pointerup", { bubbles: true, pointerId: 2, clientX: 20, clientY: 105 }),
    );
  });
  expect(onReorder).toHaveBeenCalledWith(1, 0);
});

test("overflowed engine list clips reorder hit-testing to its scroll viewport, suppresses preview on own slot, and places on the board outside", async () => {
  store.set(enginesMock.atom!, [
    { id: "e1", name: "One", loaded: true },
    { id: "e2", name: "Two", loaded: true },
  ]);
  const onReorder = vi.fn();
  let viewportEl: HTMLDivElement | null = null;
  let listEl: HTMLDivElement | null = null;
  function OverflowedEngineList() {
    const ctx = useContext(BoardArrangementContext);
    return (
      <Portal target={ctx.getAreaTarget("topRight")}>
        <div
          ref={(el) => {
            viewportEl = el;
          }}
          style={{ overflowY: "auto" }}
        >
          <div
            ref={(el) => {
              listEl = el;
            }}
          >
            {["e1", "e2"].map((id) => (
              <div key={id} data-engine-card-id={id}>
                <button
                  type="button"
                  data-arrange-grip={engineAreaId(id)}
                  onPointerDown={(e) =>
                    ctx.beginDrag(engineAreaId(id), e, {
                      listContainer: listEl,
                      reorderIds: ["e1", "e2"],
                      onReorder,
                    })
                  }
                >
                  {id}
                </button>
              </div>
            ))}
          </div>
        </div>
      </Portal>
    );
  }
  measured.width = 1400;
  await act(async () =>
    root.render(
      <Provider store={store}>
        <MantineProvider>
          <BoardTabLayout arrangeable kind="game">
            <ArrangementProbe />
            <OverflowedEngineList />
          </BoardTabLayout>
        </MantineProvider>
      </Provider>,
    ),
  );
  const layoutEl = container.querySelector<HTMLElement>("[data-board-layout]")!;
  vi.spyOn(layoutEl, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 1400, 800));
  const leftTile = latestContext!.getAreaTarget("left")!;
  const topRightTile = latestContext!.getAreaTarget("topRight")!;
  const bottomRightTile = latestContext!.getAreaTarget("bottomRight")!;
  vi.spyOn(leftTile, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 700, 800));
  vi.spyOn(topRightTile, "getBoundingClientRect").mockReturnValue(new DOMRect(700, 0, 700, 300));
  vi.spyOn(bottomRightTile, "getBoundingClientRect").mockReturnValue(
    new DOMRect(700, 300, 700, 500),
  );

  // Scroll viewport ends at y=280, while the list overflows down to y=500 over the notation tile.
  vi.spyOn(viewportEl!, "getBoundingClientRect").mockReturnValue(new DOMRect(700, 40, 680, 240));
  vi.spyOn(listEl!, "getBoundingClientRect").mockReturnValue(new DOMRect(700, 40, 680, 460));
  const cards = [...listEl!.querySelectorAll<HTMLElement>("[data-engine-card-id]")];
  vi.spyOn(cards[0], "getBoundingClientRect").mockReturnValue(new DOMRect(700, 40, 680, 200));
  vi.spyOn(cards[1], "getBoundingClientRect").mockReturnValue(new DOMRect(700, 250, 680, 250));

  const grip0 = cards[0].querySelector<HTMLButtonElement>("button")!;
  grip0.setPointerCapture = vi.fn();
  grip0.releasePointerCapture = vi.fn();

  await act(async () => {
    grip0.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        button: 0,
        pointerId: 1,
        clientX: 720,
        clientY: 60,
      }),
    );
    // Hovering over the card's own slot inside the visible viewport shows no preview at all.
    window.dispatchEvent(
      new PointerEvent("pointermove", { bubbles: true, pointerId: 1, clientX: 720, clientY: 120 }),
    );
  });
  expect(container.querySelector('[data-testid="board-arrange-preview"]')).toBeNull();

  // Moving below the visible scroll viewport (y=420, inside the unclipped listEl 40..500!) hits
  // the notation tile (300..800) below rather than reorder, and releasing places the engine on bottomRight.
  await act(async () => {
    window.dispatchEvent(
      new PointerEvent("pointermove", { bubbles: true, pointerId: 1, clientX: 900, clientY: 420 }),
    );
  });
  const preview = container.querySelector('[data-testid="board-arrange-preview"]')!;
  expect(preview).not.toBeNull();
  expect(preview.getAttribute("data-arrange-kind")).toBe("place");
  expect(preview.getAttribute("data-arrange-target")).toBe("bottomRight");

  await act(async () => {
    window.dispatchEvent(
      new PointerEvent("pointerup", { bubbles: true, pointerId: 1, clientX: 900, clientY: 420 }),
    );
  });
  expect(onReorder).not.toHaveBeenCalled();
  expect(latestContext!.shownEngineAreas.has(engineAreaId("e1"))).toBe(true);
});

test("reordering when the leading card is scrolled out of the viewport maps to the full-list index", async () => {
  store.set(enginesMock.atom!, [
    { id: "e1", name: "One", loaded: true },
    { id: "e2", name: "Two", loaded: true },
    { id: "e3", name: "Three", loaded: true },
  ]);
  const onReorder = vi.fn();
  let viewportEl: HTMLDivElement | null = null;
  let listEl: HTMLDivElement | null = null;
  function ScrolledThreeCardList() {
    const ctx = useContext(BoardArrangementContext);
    return (
      <Portal target={ctx.getAreaTarget("topRight")}>
        <div
          ref={(el) => {
            viewportEl = el;
          }}
          style={{ overflowY: "auto" }}
        >
          <div
            ref={(el) => {
              listEl = el;
            }}
          >
            {["e1", "e2", "e3"].map((id) => (
              <div key={id} data-engine-card-id={id}>
                <button
                  type="button"
                  data-arrange-grip={engineAreaId(id)}
                  onPointerDown={(e) =>
                    ctx.beginDrag(engineAreaId(id), e, {
                      listContainer: listEl,
                      reorderIds: ["e1", "e2", "e3"],
                      onReorder,
                    })
                  }
                >
                  {id}
                </button>
              </div>
            ))}
          </div>
        </div>
      </Portal>
    );
  }
  measured.width = 500;
  await act(async () =>
    root.render(
      <Provider store={store}>
        <MantineProvider>
          <BoardTabLayout arrangeable kind="game">
            <ArrangementProbe />
            <ScrolledThreeCardList />
          </BoardTabLayout>
        </MantineProvider>
      </Provider>,
    ),
  );
  const layoutEl = container.querySelector<HTMLElement>("[data-board-layout]")!;
  vi.spyOn(layoutEl, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 500, 700));
  vi.spyOn(viewportEl!, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 100, 400, 200));
  vi.spyOn(listEl!, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 400, 300));
  const cards = [...listEl!.querySelectorAll<HTMLElement>("[data-engine-card-id]")];
  // Card 0 (e1) is scrolled completely above the viewport (0..80 vs viewport 100..300).
  vi.spyOn(cards[0], "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 400, 80));
  vi.spyOn(cards[1], "getBoundingClientRect").mockReturnValue(new DOMRect(0, 100, 400, 80));
  vi.spyOn(cards[2], "getBoundingClientRect").mockReturnValue(new DOMRect(0, 190, 400, 80));

  const grip1 = cards[1].querySelector<HTMLButtonElement>("button")!;
  grip1.setPointerCapture = vi.fn();
  grip1.releasePointerCapture = vi.fn();
  await act(async () => {
    grip1.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        button: 0,
        pointerId: 1,
        clientX: 20,
        clientY: 120,
      }),
    );
    // Drop below card 2's midpoint (230): visibleSlot=2 must remap to fullSlot=3 -> onReorder(1, 2).
    window.dispatchEvent(
      new PointerEvent("pointermove", { bubbles: true, pointerId: 1, clientX: 20, clientY: 260 }),
    );
    window.dispatchEvent(
      new PointerEvent("pointerup", { bubbles: true, pointerId: 1, clientX: 20, clientY: 260 }),
    );
  });
  expect(onReorder).toHaveBeenCalledWith(1, 2);
});

test("pointer-dragging an engine window over the tab list or the Analysis area header returns it", async () => {
  const engArea = engineAreaId("sf");
  store.set(enginesMock.atom!, [{ id: "sf", name: "Stockfish", loaded: true }]);

  // (a) Analysis in the tab strip -> dropping over [data-board-tab-list="true"] returns the engine.
  const withEngine = placeArea(defaultBoardArrangement(), engArea, "left", "bottom");
  seedGameLayout(withEngine);
  setGameArrangement(withEngine);

  let headerEl: HTMLDivElement | null = null;
  let tabListEl: HTMLDivElement | null = null;
  let analysisHeaderEl: HTMLDivElement | null = null;
  function DragReturnProbe() {
    const ctx = useContext(BoardArrangementContext);
    const engineTarget = ctx.getAreaTarget(engArea);
    const analysisTarget = ctx.getAreaTarget("analysis");
    return (
      <>
        <Portal target={ctx.getAreaTarget("topRight")}>
          <div
            ref={(el) => {
              tabListEl = el;
            }}
            data-board-tab-list="true"
          />
        </Portal>
        {ctx.shownPanelAreas.has("analysis") && analysisTarget && (
          <Portal target={analysisTarget}>
            <div
              ref={(el) => {
                analysisHeaderEl = el;
              }}
              data-panel-header="analysis"
            />
          </Portal>
        )}
        {engineTarget && (
          <Portal target={engineTarget}>
            <div
              ref={(el) => {
                headerEl = el;
              }}
              onPointerDown={(e) => ctx.beginDrag(engArea, e)}
            >
              header
            </div>
          </Portal>
        )}
      </>
    );
  }

  measured.width = 1400;
  await act(async () =>
    root.render(
      <Provider store={store}>
        <MantineProvider>
          <BoardTabLayout arrangeable kind="game">
            <ArrangementProbe />
            <DragReturnProbe />
          </BoardTabLayout>
        </MantineProvider>
      </Provider>,
    ),
  );
  const layoutEl = container.querySelector<HTMLElement>("[data-board-layout]")!;
  vi.spyOn(layoutEl, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 1400, 800));
  vi.spyOn(tabListEl!, "getBoundingClientRect").mockReturnValue(new DOMRect(700, 0, 700, 40));

  headerEl!.setPointerCapture = vi.fn();
  headerEl!.releasePointerCapture = vi.fn();
  await act(async () => {
    headerEl!.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        button: 0,
        pointerId: 1,
        clientX: 100,
        clientY: 600,
      }),
    );
    window.dispatchEvent(
      new PointerEvent("pointermove", { bubbles: true, pointerId: 1, clientX: 800, clientY: 20 }),
    );
  });
  const tabReturnPreview = container.querySelector('[data-testid="board-arrange-preview"]')!;
  expect(tabReturnPreview.getAttribute("data-arrange-kind")).toBe("return");
  expect(tabReturnPreview.getAttribute("data-arrange-target")).toBe("tabs");
  await act(async () => {
    window.dispatchEvent(
      new PointerEvent("pointerup", { bubbles: true, pointerId: 1, clientX: 800, clientY: 20 }),
    );
  });
  expect(getGameArrangement()).toEqual(defaultBoardArrangement());

  // (b) Analysis as its own area -> dropping over [data-panel-header="analysis"] returns the engine.
  const withAnalysisAndEngine = placeArea(
    placeArea(defaultBoardArrangement(), "analysis", "left", "right"),
    engArea,
    "left",
    "bottom",
  );
  await act(async () => setGameArrangement(withAnalysisAndEngine));
  vi.spyOn(analysisHeaderEl!, "getBoundingClientRect").mockReturnValue(
    new DOMRect(400, 0, 300, 32),
  );
  headerEl!.setPointerCapture = vi.fn();
  headerEl!.releasePointerCapture = vi.fn();
  await act(async () => {
    headerEl!.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        button: 0,
        pointerId: 2,
        clientX: 100,
        clientY: 600,
      }),
    );
    window.dispatchEvent(
      new PointerEvent("pointermove", { bubbles: true, pointerId: 2, clientX: 500, clientY: 16 }),
    );
  });
  const enginesReturnPreview = container.querySelector('[data-testid="board-arrange-preview"]')!;
  expect(enginesReturnPreview.getAttribute("data-arrange-kind")).toBe("return");
  expect(enginesReturnPreview.getAttribute("data-arrange-target")).toBe("engines");
  await act(async () => {
    window.dispatchEvent(
      new PointerEvent("pointerup", { bubbles: true, pointerId: 2, clientX: 500, clientY: 16 }),
    );
  });
  expect(latestContext!.shownEngineAreas.has(engArea)).toBe(false);
  expect(getGameArrangement()).toEqual(
    placeArea(defaultBoardArrangement(), "analysis", "left", "right"),
  );
});

test("unloaded engine leaves stay stored without rendering a tile, and deleted engine leaves are pruned", async () => {
  const unloadedArea = engineAreaId("unloaded-eng");
  const deletedArea = engineAreaId("deleted-eng");
  const start = placeArea(
    placeArea(defaultBoardArrangement(), unloadedArea, "left", "bottom"),
    deletedArea,
    "topRight",
    "top",
  );
  seedGameLayout(start);
  store.set(enginesMock.atom!, [{ id: "unloaded-eng", name: "Unloaded", loaded: false }]);

  measured.width = 1400;
  await act(async () =>
    root.render(
      <Provider store={store}>
        <MantineProvider>
          <BoardTabLayout arrangeable kind="game">
            <ArrangementProbe />
          </BoardTabLayout>
        </MantineProvider>
      </Provider>,
    ),
  );

  // Unloaded engine is hidden from shownEngineAreas/Mosaic tiles, but kept in stored arrangement.
  // Deleted engine (absent from loaded engines list) is pruned from stored arrangement.
  expect(latestContext!.shownEngineAreas.has(unloadedArea)).toBe(false);
  expect(latestContext!.shownEngineAreas.has(deletedArea)).toBe(false);
  expect(getGameArrangement()).toEqual(
    placeArea(defaultBoardArrangement(), unloadedArea, "left", "bottom"),
  );
});

test("renders distinct layouts per kind and updates displayed layout when kind changes without touching other kinds", async () => {
  const state = defaultBoardLayoutsState();
  state.kinds.game = { arrangement: THREE_PANE_ARRANGEMENT, tabsHidden: false };
  state.kinds.repertoire = {
    arrangement: placeArea(defaultBoardArrangement(), "annotate", "left", "bottom"),
    tabsHidden: true,
  };
  localStorage.setItem(ANALYSIS_BOARD_LAYOUTS_KEY, JSON.stringify(state));

  await renderAt(1400, true, "game");
  expect([...(latestContext?.shownPanelAreas ?? [])]).toEqual(["database"]);
  expect(latestContext?.tabsHidden).toBe(false);

  // Switching kind to repertoire renders repertoire's layout and hidden strip.
  await renderAt(1400, true, "repertoire");
  expect([...(latestContext?.shownPanelAreas ?? [])]).toEqual(["annotate"]);
  expect(latestContext?.tabsHidden).toBe(true);

  // Editing repertoire (returning annotate) leaves game's layout untouched.
  await act(async () => latestContext!.returnPanel("annotate"));
  expect([...(latestContext?.shownPanelAreas ?? [])]).toEqual([]);
  expect(store.get(boardLayoutFamily("game")).arrangement).toEqual(THREE_PANE_ARRANGEMENT);

  // Switching back to game shows game's untouched layout.
  await renderAt(1400, true, "game");
  expect([...(latestContext?.shownPanelAreas ?? [])]).toEqual(["database"]);
});

test("engine rules 1-4: drives engines from undefined to [] to disabled+enabled (placeholder kept then resolved, disabled kept, deleted pruned)", async () => {
  const placeholder = enginePlaceholderAreaId(1);
  const disabledArea = engineAreaId("disabled-eng");
  const deletedArea = engineAreaId("deleted-eng");

  // Part A: placeholder survives undefined -> [] -> disabled-only, then resolves when enabled appears.
  const withPlaceholder = placeArea(defaultBoardArrangement(), placeholder, "left", "bottom");
  seedGameLayout(withPlaceholder);
  store.set(enginesMock.atom!, undefined);

  await renderAt(1400, true, "game");
  // Rule 1: engines undefined -> placeholder kept in stored tree and hidden.
  expect(arrangementEngineAreas(getGameArrangement())).toEqual([placeholder]);
  expect(latestContext!.shownEngineAreas.size).toBe(0);

  // Rule 3 on empty list ([]): placeholder stays in stored tree and hidden (never dropped).
  await act(async () => store.set(enginesMock.atom!, []));
  expect(arrangementEngineAreas(getGameArrangement())).toEqual([placeholder]);
  expect(latestContext!.shownEngineAreas.size).toBe(0);

  // Rule 3 with only a disabled engine: placeholder still stays hidden.
  await act(async () =>
    store.set(enginesMock.atom!, [{ id: "disabled-eng", name: "Disabled", loaded: false }]),
  );
  expect(arrangementEngineAreas(getGameArrangement())).toEqual([placeholder]);
  expect(latestContext!.shownEngineAreas.size).toBe(0);

  // Rule 3 when an enabled engine appears: placeholder resolves to the enabled engine and shows.
  await act(async () =>
    store.set(enginesMock.atom!, [
      { id: "disabled-eng", name: "Disabled", loaded: false },
      { id: "enabled-eng", name: "Enabled", loaded: true },
    ]),
  );
  expect(arrangementEngineAreas(getGameArrangement())).toEqual([engineAreaId("enabled-eng")]);
  expect([...latestContext!.shownEngineAreas]).toEqual([engineAreaId("enabled-eng")]);

  // Part B: rules 1, 2, 4 with real ids (disabled kept hidden, deleted pruned only after list loads).
  const withRealIds = placeArea(
    placeArea(defaultBoardArrangement(), disabledArea, "left", "bottom"),
    deletedArea,
    "topRight",
    "top",
  );
  await act(async () => {
    store.set(enginesMock.atom!, undefined);
    setGameArrangement(withRealIds);
  });
  expect(arrangementEngineAreas(getGameArrangement())).toEqual([disabledArea, deletedArea]);
  expect(latestContext!.shownEngineAreas.size).toBe(0);

  await act(async () =>
    store.set(enginesMock.atom!, [
      { id: "disabled-eng", name: "Disabled", loaded: false },
      { id: "enabled-eng", name: "Enabled", loaded: true },
    ]),
  );
  expect(arrangementEngineAreas(getGameArrangement())).toEqual([disabledArea]);
  expect(latestContext!.shownEngineAreas.size).toBe(0);
});

test("hidden photo panel area is omitted without a review, kept across divider drags, and returns in the same spot for a review tab", async () => {
  const withPhoto: BoardArrangement = {
    direction: "row",
    first: "left",
    splitPercentage: 45,
    second: {
      direction: "column",
      first: "photo",
      splitPercentage: 35,
      second: {
        direction: "column",
        first: "topRight",
        second: "bottomRight",
        splitPercentage: 50,
      },
    },
  };
  seedGameLayout(withPhoto);
  const treeStore = createZustandStore<Pick<TreeStoreState, "scoresheetReview">>(() => ({
    scoresheetReview: undefined,
  })) as unknown as TreeStore;

  measured.width = 1400;
  await act(async () =>
    root.render(
      <Provider store={store}>
        <MantineProvider>
          <TreeStateContext.Provider value={treeStore}>
            <BoardTabLayout arrangeable kind="game">
              <ArrangementProbe />
            </BoardTabLayout>
          </TreeStateContext.Provider>
        </MantineProvider>
      </Provider>,
    ),
  );

  expect(mosaicTree()).toEqual({
    direction: "row",
    first: "left",
    splitPercentage: 45,
    second: { direction: "column", first: "topRight", second: "bottomRight", splitPercentage: 50 },
  });
  expect([...(latestContext?.shownPanelAreas ?? [])]).toEqual([]);

  // Dragging a divider on a non-review tab preserves photo and its 35 % split in storage.
  await act(async () =>
    dividers.get("left+topRight+bottomRight")!({
      direction: "row",
      first: "left",
      splitPercentage: 55,
      second: {
        direction: "column",
        first: "topRight",
        second: "bottomRight",
        splitPercentage: 65,
      },
    }),
  );
  const expectedStored: BoardArrangement = {
    direction: "row",
    first: "left",
    splitPercentage: 55,
    second: {
      direction: "column",
      first: "photo",
      splitPercentage: 35,
      second: {
        direction: "column",
        first: "topRight",
        second: "bottomRight",
        splitPercentage: 65,
      },
    },
  };
  expect(readStoredGameLayout().arrangement).toEqual(expectedStored);

  // Activating a scoresheet review reveals photo in its remembered spot.
  await act(async () => treeStore.setState({ scoresheetReview: {} }));
  expect([...(latestContext?.shownPanelAreas ?? [])]).toEqual(["photo"]);
  expect(mosaicTree()).toEqual(expectedStored);

  // Returning photo removes it from the stored arrangement.
  await act(async () => latestContext!.returnPanel("photo"));
  expect([...(latestContext?.shownPanelAreas ?? [])]).toEqual([]);
  expect(getGameArrangement()).toEqual({
    direction: "row",
    first: "left",
    splitPercentage: 55,
    second: {
      direction: "column",
      first: "topRight",
      splitPercentage: 65,
      second: "bottomRight",
    },
  });
});

test("BoardTabLayout reveals a pulled-out photo tile for a well-formed ScoresheetPhotos tag and keeps it hidden for a malformed tag", async () => {
  const arrangement = placeArea(defaultBoardArrangement(), "photo", "topRight", "top");
  setGameArrangement(arrangement);
  const treeStore = createZustandStore<TreeStoreState>(
    () =>
      ({
        scoresheetReview: undefined,
        headers: { other: { ScoresheetPhotos: "../malformed" } },
      }) as unknown as TreeStoreState,
  ) as unknown as TreeStore;

  await act(async () =>
    root.render(
      <Provider store={store}>
        <MantineProvider env="test">
          <TreeStateContext.Provider value={treeStore}>
            <BoardTabLayout arrangeable kind="game">
              <ArrangementProbe />
            </BoardTabLayout>
          </TreeStateContext.Provider>
        </MantineProvider>
      </Provider>,
    ),
  );

  // Malformed tag does not offer the photo tile.
  expect([...(latestContext?.shownPanelAreas ?? [])]).toEqual([]);

  // Well-formed tag reveals the photo tile even without an active review.
  await act(async () =>
    treeStore.setState({
      scoresheetReview: undefined,
      headers: { other: { ScoresheetPhotos: "a".repeat(64) } },
    } as unknown as Partial<TreeStoreState>),
  );
  expect([...(latestContext?.shownPanelAreas ?? [])]).toEqual(["photo"]);
});

test("pulled-out photo panel keeps its place per layout kind", async () => {
  const withPhoto: BoardArrangement = placeArea(
    defaultBoardArrangement(),
    "photo",
    "left",
    "bottom",
  );
  seedGameLayout(withPhoto);
  const treeStore = createZustandStore<TreeStoreState>(
    () =>
      ({
        scoresheetReview: {},
        headers: { other: {} },
      }) as unknown as TreeStoreState,
  ) as unknown as TreeStore;

  measured.width = 1400;
  const renderKind = (kind: BoardLayoutKind) =>
    act(async () =>
      root.render(
        <Provider store={store}>
          <MantineProvider env="test">
            <TreeStateContext.Provider value={treeStore}>
              <BoardTabLayout arrangeable kind={kind}>
                <ArrangementProbe />
              </BoardTabLayout>
            </TreeStateContext.Provider>
          </MantineProvider>
        </Provider>,
      ),
    );

  await renderKind("game");
  expect([...(latestContext?.shownPanelAreas ?? [])]).toEqual(["photo"]);
  expect(mosaicTree()).toEqual(withPhoto);

  // Switching to repertoire uses repertoire's own arrangement without pulling photo over.
  await renderKind("repertoire");
  expect([...(latestContext?.shownPanelAreas ?? [])]).not.toContain("photo");

  // Returning to game restores photo in its remembered place.
  await renderKind("game");
  expect([...(latestContext?.shownPanelAreas ?? [])]).toEqual(["photo"]);
  expect(mosaicTree()).toEqual(withPhoto);
});
