import { MantineProvider } from "@mantine/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { deferTreeView, releaseTreeView } from "@/state/deferredTreeView";
import { createTreeStore, type TreeStore } from "@/state/store/tree";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { getStats } from "@/utils/repertoire";
import { TreeStatsBar } from "./TreeStatsBar";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/utils/repertoire", async (original) => {
  const actual = await original<typeof import("@/utils/repertoire")>();
  return { ...actual, getStats: vi.fn(actual.getStats) };
});
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let host: HTMLDivElement;
let root: Root;
let store: TreeStore;

beforeEach(() => {
  installMatchMediaStub();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  store = createTreeStore();
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const labels = () => Array.from(host.querySelectorAll("p"), (p) => p.textContent);

const render = () =>
  act(async () =>
    root.render(
      <MantineProvider>
        <TreeStatsBar store={store} />
      </MantineProvider>,
    ),
  );

test("shows the tree's counts under the shared keys and follows store updates", async () => {
  store.getState().makeMoves({ payload: ["e4", "e5"] });
  await render();
  expect(labels()).toEqual([
    "TreeStats.Variations: 1",
    "TreeStats.MaxDepth: 2",
    "TreeStats.TotalMoves: 2",
  ]);

  await act(async () => {
    store.getState().goToStart();
    store.getState().makeMove({ payload: "d4" });
  });
  expect(labels()).toEqual([
    "TreeStats.Variations: 2",
    "TreeStats.MaxDepth: 2",
    "TreeStats.TotalMoves: 3",
  ]);
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
  ]);

  await act(async () => releaseTreeView(store));
  expect(labels()).toEqual([
    "TreeStats.Variations: 1",
    "TreeStats.MaxDepth: 1",
    "TreeStats.TotalMoves: 1",
  ]);
});
