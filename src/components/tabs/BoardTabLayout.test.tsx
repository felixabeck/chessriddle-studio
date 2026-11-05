import { act, useEffect, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MantineProvider, Portal } from "@mantine/core";
import { createStore, Provider } from "jotai";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { MosaicNode } from "react-mosaic-component";
import type { ViewId } from "@/state/layoutStorage";
import { installMatchMediaStub } from "@/tests/matchMedia";

const measured = vi.hoisted(() => ({ width: 1000, mounts: 0 }));
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
vi.mock("react-mosaic-component", () => ({
  Mosaic: ({
    value,
    renderTile,
  }: {
    value: MosaicNode<ViewId> | null;
    renderTile: (id: ViewId) => ReactNode;
  }) => {
    const render = (node: MosaicNode<ViewId> | null): ReactNode =>
      node === null ? null : typeof node === "string" ? (
        <div key={node}>{renderTile(node)}</div>
      ) : (
        <>
          {render(node.first)}
          {render(node.second)}
        </>
      );
    return <div data-mosaic-tree={JSON.stringify(value)}>{render(value)}</div>;
  },
}));

import BoardTabLayout from "./BoardTabLayout";
import { fontSizeAtom } from "@/state/atoms";

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

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let container: HTMLDivElement;
let root: Root;
let store: ReturnType<typeof createStore>;
beforeEach(() => {
  installMatchMediaStub();
  localStorage.clear();
  measured.width = 1000;
  measured.mounts = 0;
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
async function renderAt(width: number) {
  measured.width = width;
  await act(async () =>
    root.render(
      <Provider store={store}>
        <MantineProvider>
          <BoardTabLayout>
            <StatefulConsumer />
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
        : [...container.querySelectorAll("[data-board-slot]")].map((slot) =>
            slot.getAttribute("data-board-slot"),
          );
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
