import { MantineProvider } from "@mantine/core";
import { createStore, Provider } from "jotai";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { showVariationsFamily } from "@/state/atoms";
import { deferTreeView, releaseTreeView } from "@/state/deferredTreeView";
import { createTreeStore, type TreeStore } from "@/state/store/tree";
import { WorkspaceTabScope } from "@/state/tabScope";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { getStats } from "@/utils/repertoire";
import { TreeStatsBar } from "./TreeStatsBar";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/utils/repertoire", async (original) => {
  const actual = await original<typeof import("@/utils/repertoire")>();
  return { ...actual, getStats: vi.fn(actual.getStats) };
});
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const TAB = "tree-stats-test";

let host: HTMLDivElement;
let root: Root;
let store: TreeStore;
let atoms: ReturnType<typeof createStore>;

beforeEach(() => {
  installMatchMediaStub();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  store = createTreeStore();
  atoms = createStore();
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const labels = () => Array.from(host.querySelectorAll("p"), (p) => p.textContent);

const render = () =>
  act(async () =>
    root.render(
      <Provider store={atoms}>
        <MantineProvider>
          <WorkspaceTabScope tabId={TAB}>
            <TreeStatsBar store={store} />
          </WorkspaceTabScope>
        </MantineProvider>
      </Provider>,
    ),
  );

test("shows the tree's counts under the shared keys and follows store updates", async () => {
  store.getState().makeMoves({ payload: ["e4", "e5"] });
  await render();
  expect(labels()).toEqual([
    "TreeStats.Variations: 1",
    "TreeStats.MaxDepth: 2",
    "TreeStats.TotalMoves: 2",
    "TreeStats.OpenVariations: 0",
  ]);
  expect(host.querySelector("button")).toBeNull();

  await act(async () => {
    store.getState().goToStart();
    store.getState().makeMove({ payload: "d4" });
  });
  // 1.d4 beside 1.e4 e5 is a side line one move long: its count is a control, not a label.
  expect(labels()).toEqual([
    "TreeStats.Variations: 2",
    "TreeStats.MaxDepth: 2",
    "TreeStats.TotalMoves: 3",
  ]);
  expect(host.querySelector("button")?.textContent).toBe("TreeStats.OpenVariations: 1");
});

test("the open-variation count jumps to the next one and turns hidden variations on", async () => {
  // 1.e4 (1.d4) (1.c4) e5, cursor on 1...e5, variations hidden.
  store.getState().makeMoves({ payload: ["e4", "e5"] });
  for (const move of ["d4", "c4"]) {
    store.getState().goToStart();
    store.getState().makeMove({ payload: move });
  }
  store.getState().goToMove([0, 0]);
  const showVariations = showVariationsFamily(TAB);
  atoms.set(showVariations, false);
  await render();
  const button = host.querySelector("button")!;
  expect(button.textContent).toBe("TreeStats.OpenVariations: 2");
  expect(button.title).toBe("TreeStats.NextOpenVariation");
  // The count is written in the mark's own colour, not the dimmed colour of its neighbours.
  expect(button.style.color).toBe("var(--cf-open-variation)");

  await act(async () => button.click());
  expect(store.getState().position).toEqual([1]);
  expect(atoms.get(showVariations)).toBe(true);

  await act(async () => host.querySelector("button")!.click());
  expect(store.getState().position).toEqual([2]);

  // The second move closes one of them; the last one closed turns the entry back into a label.
  await act(async () => store.getState().makeMove({ payload: "c5" }));
  expect(host.querySelector("button")?.textContent).toBe("TreeStats.OpenVariations: 1");
  await act(async () => {
    store.getState().goToMove([1]);
    store.getState().makeMove({ payload: "d5" });
  });
  expect(host.querySelector("button")).toBeNull();
  expect(labels()).toContain("TreeStats.OpenVariations: 0");
});

test("a jump the practice drill refuses leaves the cursor and the hidden variations alone", async () => {
  store.getState().makeMoves({ payload: ["e4", "e5"] });
  store.getState().goToStart();
  store.getState().makeMove({ payload: "d4" });
  store.getState().goToMove([0]);
  store.getState().setPracticePath([0, 0]);
  const showVariations = showVariationsFamily(TAB);
  atoms.set(showVariations, false);
  await render();

  await act(async () => host.querySelector("button")!.click());

  expect(store.getState().position).toEqual([0]);
  expect(atoms.get(showVariations)).toBe(false);
});

test("a deferred file install shows zero counts until release shows the installed tree", async () => {
  deferTreeView(store);
  vi.mocked(getStats).mockClear();
  await render();
  await act(async () => store.getState().makeMoves({ payload: ["e4"] }));
  // The install path defers the view precisely so this render skips the tree walk.
  expect(getStats).not.toHaveBeenCalled();
  expect(labels()).toEqual([
    "TreeStats.Variations: 0",
    "TreeStats.MaxDepth: 0",
    "TreeStats.TotalMoves: 0",
    "TreeStats.OpenVariations: 0",
  ]);

  await act(async () => releaseTreeView(store));
  expect(labels()).toEqual([
    "TreeStats.Variations: 1",
    "TreeStats.MaxDepth: 1",
    "TreeStats.TotalMoves: 1",
    "TreeStats.OpenVariations: 0",
  ]);
});
