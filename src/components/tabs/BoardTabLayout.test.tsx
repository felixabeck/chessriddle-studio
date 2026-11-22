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
  // The beside arrangement nests a split without its own drag-and-drop context.
  return { Mosaic, MosaicWithoutDragDropContext: Mosaic };
});

import BoardTabLayout from "./BoardTabLayout";
import { fontSizeAtom } from "@/state/atoms";
import { BoardLayoutModeContext } from "@/state/paneLayout";

function StatefulConsumer() {
  const [count, setCount] = useState(0);
  useEffect(() => {
    measured.mounts++;
  }, []);
  return (
    <>
      {(["left", "topRight", "bottomRight", "rightTop"] as const).map((id) => (
        <Portal key={id} target={`#${id}`}>
          <button onClick={() => setCount(count + 1)}>
            {id}:{count}
          </button>
        </Portal>
      ))}
    </>
  );
}

/** The layout mode as the board inside the layout reads it. */
function ShownMode() {
  return <output data-testid="mode">{useContext(BoardLayoutModeContext)}</output>;
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
async function renderAt(width: number, besideCapable = false) {
  measured.width = width;
  await act(async () =>
    root.render(
      <Provider store={store}>
        <MantineProvider>
          <BoardTabLayout besideCapable={besideCapable}>
            <StatefulConsumer />
            <ShownMode />
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
        : // The slot of the beside arrangement is kept out of sight and is no part of the stack.
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
const trees = () =>
  [...container.querySelectorAll("[data-mosaic-tree]")].map((mosaic) =>
    JSON.parse(mosaic.getAttribute("data-mosaic-tree")!),
  );
const BESIDE_KEY = "panels-beside-notation";
const SPLITS_KEY = "board-beside-splits";

test("an analysis board that wants its panels beside the notation gets the notation and the panels side by side below the slot across both", async () => {
  const saved =
    '{"currentNode":{"direction":"row","first":"left","second":{"direction":"column","first":"topRight","second":"bottomRight"},"splitPercentage":60}}';
  localStorage.setItem("windowsState", saved);
  localStorage.setItem(BESIDE_KEY, "true");
  const writes = vi.spyOn(Storage.prototype, "setItem");
  await renderAt(2000, true);
  expect(layoutMode()).toBe("beside");
  expect(container.querySelector('[data-testid="mode"]')?.textContent).toBe("beside");
  // The board keeps the edge it has with the panels above; the right side starts halved.
  expect(trees()).toEqual([
    { direction: "row", first: "left", second: "right", splitPercentage: 60 },
    { direction: "row", first: "bottomRight", second: "topRight", splitPercentage: 50 },
  ]);
  for (const id of [...ids, "rightTop"]) {
    const target = document.getElementById(id)!;
    expect(target.isConnected).toBe(true);
    expect(target.closest("[hidden]")).toBeNull();
    expect(target.textContent).toBe(`${id}:0`);
  }
  // One pane holds the slot across the top and, after it, the notation then the panels.
  const pane = document.getElementById("rightTop")!.closest("[data-pinned-pane]")!;
  expect(pane.firstElementChild?.getAttribute("data-board-slot")).toBe("rightTop");
  const below = pane.lastElementChild!;
  expect(below).not.toBe(pane.firstElementChild);
  expect([...below.querySelectorAll("#bottomRight, #topRight")].map((tile) => tile.id)).toEqual([
    "bottomRight",
    "topRight",
  ]);
  expect(pane.contains(document.getElementById("left"))).toBe(false);
  expect(localStorage.getItem("windowsState")).toBe(saved);
  expect(writes.mock.calls.filter(([key]) => key === "windowsState")).toEqual([]);
});

test.each([
  [645, "stacked"],
  [646, "mosaic"],
  [971, "mosaic"],
  [972, "beside"],
] as const)(
  "at %ipx a board that wants its panels beside the notation is %s",
  async (width, mode) => {
    localStorage.setItem(BESIDE_KEY, "true");
    await renderAt(width, true);
    expect(layoutMode()).toBe(mode);
    expect(container.querySelector('[data-testid="mode"]')?.textContent).toBe(mode);
    // Outside the beside arrangement the slot across the top is kept, out of sight.
    const slot = document.getElementById("rightTop")!;
    expect(slot.isConnected).toBe(true);
    expect(!!slot.closest("[hidden]")).toBe(mode !== "beside");
    expect(localStorage.getItem(BESIDE_KEY)).toBe("true");
  },
);

test("the beside threshold follows the root font scale", async () => {
  localStorage.setItem(BESIDE_KEY, "true");
  document.documentElement.style.fontSize = "32px";
  await act(async () => store.set(fontSizeAtom, 200));
  await renderAt(1931, true);
  expect(layoutMode()).toBe("mosaic");
  await renderAt(1932, true);
  expect(layoutMode()).toBe("beside");
});

test("only a board that can show its panels beside the notation does, and only when asked to", async () => {
  await renderAt(2000, true);
  expect(layoutMode()).toBe("mosaic");
  localStorage.setItem(BESIDE_KEY, "true");
  await act(async () => root.unmount());
  root = createRoot(container);
  store = createStore();
  await renderAt(2000);
  expect(layoutMode()).toBe("mosaic");
  await renderAt(2000, true);
  expect(layoutMode()).toBe("beside");
});

test("an unreadable beside choice shows the panels above the notation", async () => {
  localStorage.setItem(BESIDE_KEY, '"yes"');
  await renderAt(2000, true);
  expect(layoutMode()).toBe("mosaic");
});

test("portal state and target identity survive every switch into and out of the beside arrangement", async () => {
  localStorage.setItem(BESIDE_KEY, "true");
  await renderAt(2000, true);
  const all = [...ids, "rightTop"];
  const targets = all.map((id) => document.getElementById(id)!);
  // The four portals share one consumer's count.
  await act(async () => targets[0].querySelector("button")!.click());
  for (const width of [800, 2000, 320, 2000, 971, 972]) {
    await renderAt(width, true);
    for (const [index, id] of all.entries()) {
      expect(document.getElementById(id)).toBe(targets[index]);
      expect(targets[index].isConnected).toBe(true);
      expect(targets[index].textContent).toBe(`${id}:1`);
    }
    expect(measured.mounts).toBe(1);
  }
});

test("dragging a beside divider stores the position it reached, and never the panels-above layout", async () => {
  localStorage.setItem(BESIDE_KEY, "true");
  const writes = vi.spyOn(Storage.prototype, "setItem");
  await renderAt(2000, true);
  const drag = (tiles: string, splitPercentage: number) =>
    act(async () => dividers.get(tiles)!({ direction: "row", splitPercentage }));
  await drag("left+right", 40);
  expect(JSON.parse(localStorage.getItem(SPLITS_KEY)!)).toEqual({ board: 40 });
  expect(trees()[0].splitPercentage).toBe(40);
  // Of the 1200px right side the notation keeps its 326px floor.
  await drag("bottomRight+topRight", 5);
  const stored = JSON.parse(localStorage.getItem(SPLITS_KEY)!);
  expect(stored.board).toBe(40);
  expect(stored.notation).toBeCloseTo((326 / 1200) * 100, 5);
  expect(trees()[1].splitPercentage).toBe(stored.notation);
  // Dragged past the right side's floor, the board divider stops where both panes still fit.
  await drag("left+right", 99);
  expect(JSON.parse(localStorage.getItem(SPLITS_KEY)!).board).toBeCloseTo(67.55, 5);
  // A change that carries no divider position (a tile, or nothing) stores nothing.
  const before = localStorage.getItem(SPLITS_KEY);
  await act(async () => dividers.get("left+right")!("left"));
  await act(async () => dividers.get("left+right")!(null));
  expect(localStorage.getItem(SPLITS_KEY)).toBe(before);
  expect(writes.mock.calls.filter(([key]) => key === "windowsState")).toEqual([]);
});

test("a window too narrow for the stored beside dividers moves only the dividers shown", async () => {
  const saved = JSON.stringify({ board: 60, notation: 30 });
  localStorage.setItem(BESIDE_KEY, "true");
  localStorage.setItem(SPLITS_KEY, saved);
  const writes = vi.spyOn(Storage.prototype, "setItem");
  await renderAt(1000, true);
  const [board, right] = trees();
  expect(board.splitPercentage).toBeCloseTo(35.1, 5);
  expect(right.splitPercentage).toBeCloseTo((326 / 649) * 100, 5);
  await renderAt(2000, true);
  expect(trees().map((tree) => tree.splitPercentage)).toEqual([60, 40.75]);
  await renderAt(3000, true);
  expect(trees().map((tree) => tree.splitPercentage)).toEqual([60, 30]);
  expect(localStorage.getItem(SPLITS_KEY)).toBe(saved);
  expect(writes.mock.calls.filter(([key]) => key === SPLITS_KEY)).toEqual([]);
});

test.each([
  [
    '{"currentNode":{"direction":"column","first":"left","second":"topRight","splitPercentage":70}}',
  ],
  ['{"currentNode":{"direction":"row","first":"topRight","second":"left","splitPercentage":70}}'],
  ['{"currentNode":"left"}'],
  ['{"currentNode":null}'],
])(
  "without a board edge to take over from %s the beside board divider starts in the middle",
  async (saved) => {
    localStorage.setItem("windowsState", saved);
    localStorage.setItem(BESIDE_KEY, "true");
    await renderAt(2000, true);
    expect(trees()[0].splitPercentage).toBe(50);
  },
);

test("unreadable beside dividers start over from the middle", async () => {
  localStorage.setItem(BESIDE_KEY, "true");
  localStorage.setItem(SPLITS_KEY, '{"board":"wide","notation":140}');
  await renderAt(2000, true);
  expect(trees().map((tree) => tree.splitPercentage)).toEqual([50, 50]);
});
