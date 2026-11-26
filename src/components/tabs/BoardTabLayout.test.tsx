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
import { isHotkeySuppressed } from "@/utils/keyboardOwnership";
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
  expect(store.get(boardArrangementAtom)).toEqual({
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
    const before = store.get(boardArrangementAtom);

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
    expect(store.get(boardArrangementAtom)).toEqual(before);
  },
);

test("keyboard placing uses an aria-modal dialog, suppresses board hotkeys, traps focus, respects fit rule and restores focus", async () => {
  localStorage.setItem(ANALYSIS_BOARD_LAYOUT_KEY, JSON.stringify(THREE_PANE_ARRANGEMENT));
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
  await act(async () => store.set(boardArrangementAtom, pureThreeColumns));
  const pureButtons = [...dialog.querySelectorAll("button")];
  const pureLabels = pureButtons.slice(1).map((b) => b.textContent);
  expect(pureLabels.some((label) => label?.includes("LeftOf") || label?.includes("RightOf"))).toBe(
    false,
  );
  // Restore THREE_PANE_ARRANGEMENT for the return-to-tabs check below.
  await act(async () => store.set(boardArrangementAtom, THREE_PANE_ARRANGEMENT));

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
  const before = store.get(boardArrangementAtom);

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
  expect(store.get(boardArrangementAtom)).toEqual(before);
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
  const threeTakenOut: BoardArrangement = {
    direction: "row",
    first: "left",
    second: {
      direction: "column",
      first: "analysis",
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
  };
  localStorage.setItem(ANALYSIS_BOARD_LAYOUT_KEY, JSON.stringify(threeTakenOut));
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
