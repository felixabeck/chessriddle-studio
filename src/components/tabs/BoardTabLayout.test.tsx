import { act, useContext, useEffect, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MantineProvider, Portal } from "@mantine/core";
import { createStore, Provider } from "jotai";
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
vi.mock("@/state/atoms", async () => {
  const { atom } = await import("jotai");
  return { fontSizeAtom: atom(100) };
});
const coachMock = vi.hoisted(() => ({ atom: null as any }));
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

import BoardTabLayout, { BoardArrangementContext, boardAreaTargetId } from "./BoardTabLayout";
import { fontSizeAtom } from "@/state/atoms";
import {
  ANALYSIS_BOARD_LAYOUT_KEY,
  boardArrangementAtom,
  WINDOWS_STATE_KEY,
} from "@/state/layoutStorage";
import {
  defaultBoardArrangement,
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
async function renderAt(width: number, arrangeable = false) {
  measured.width = width;
  await act(async () =>
    root.render(
      <Provider store={store}>
        <MantineProvider>
          <BoardTabLayout arrangeable={arrangeable}>
            <StatefulConsumer />
            <ArrangementProbe />
          </BoardTabLayout>
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
  localStorage.setItem(ANALYSIS_BOARD_LAYOUT_KEY, JSON.stringify(THREE_PANE_ARRANGEMENT));
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
    writes.mock.calls.filter(([k]) => k === ANALYSIS_BOARD_LAYOUT_KEY || k === WINDOWS_STATE_KEY),
  ).toEqual([]);
  expect(JSON.parse(localStorage.getItem(ANALYSIS_BOARD_LAYOUT_KEY)!)).toEqual(
    THREE_PANE_ARRANGEMENT,
  );
});

test("arrangement width threshold follows the root font scale", async () => {
  localStorage.setItem(ANALYSIS_BOARD_LAYOUT_KEY, JSON.stringify(THREE_PANE_ARRANGEMENT));
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

test("divider drag in case 2 updates analysis-board-layout only; in case 3 updates windowsState only", async () => {
  localStorage.setItem(ANALYSIS_BOARD_LAYOUT_KEY, JSON.stringify(THREE_PANE_ARRANGEMENT));
  await renderAt(1400, true);
  const writes = vi.spyOn(Storage.prototype, "setItem");

  // Case 2 drag: updates analysis-board-layout, never windowsState.
  const resized = { ...THREE_PANE_ARRANGEMENT, splitPercentage: 48 };
  await act(async () => dividers.get("left+database+bottomRight+topRight")!(resized));
  expect(JSON.parse(localStorage.getItem(ANALYSIS_BOARD_LAYOUT_KEY)!).splitPercentage).toBe(48);
  expect(writes.mock.calls.filter(([k]) => k === WINDOWS_STATE_KEY)).toEqual([]);

  // Case 3 drag: updates windowsState, never analysis-board-layout.
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
  expect(writes.mock.calls.filter(([k]) => k === ANALYSIS_BOARD_LAYOUT_KEY)).toEqual([]);
  expect(JSON.parse(localStorage.getItem(ANALYSIS_BOARD_LAYOUT_KEY)!).splitPercentage).toBe(48);
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
  localStorage.setItem(ANALYSIS_BOARD_LAYOUT_KEY, JSON.stringify(withCoach));
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
  const stored = JSON.parse(localStorage.getItem(ANALYSIS_BOARD_LAYOUT_KEY)!);
  expect(stored).toEqual({
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
  await act(async () => store.set(coachMock.atom, true));
  expect([...(latestContext?.shownPanelAreas ?? [])]).toEqual(["coach"]);
});

test("returnPanel removes the panel area from analysis-board-layout", async () => {
  localStorage.setItem(ANALYSIS_BOARD_LAYOUT_KEY, JSON.stringify(THREE_PANE_ARRANGEMENT));
  await renderAt(1400, true);
  expect([...(latestContext?.shownPanelAreas ?? [])]).toEqual(["database"]);

  await act(async () => latestContext!.returnPanel("database" as PanelAreaId));
  expect([...(latestContext?.shownPanelAreas ?? [])]).toEqual([]);
  expect(store.get(boardArrangementAtom)).toEqual({
    direction: "row",
    first: "left",
    splitPercentage: 40,
    second: { direction: "row", first: "bottomRight", second: "topRight", splitPercentage: 55 },
  });
});

test("non-arrangeable boards (play, puzzles) ignore analysis-board-layout and stay on windowsState", async () => {
  localStorage.setItem(ANALYSIS_BOARD_LAYOUT_KEY, JSON.stringify(THREE_PANE_ARRANGEMENT));
  await renderAt(1400, false);
  expect(layoutMode()).toBe("mosaic");
  expect(latestContext?.arrangingAvailable).toBe(false);
  expect([...(latestContext?.shownPanelAreas ?? [])]).toEqual([]);
  expect(mosaicTree()).toEqual(defaultBoardArrangement());
});
