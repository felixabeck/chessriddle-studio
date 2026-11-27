import { MantineProvider } from "@mantine/core";
import { Provider, createStore } from "jotai";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import { createTreeStore, type TreeStore } from "@/state/store/tree";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { installResizeObserverStub } from "@/tests/resizeObserver";
import AnnotationPanel from "./AnnotationPanel";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/utils/sound", () => ({ playSound: vi.fn() }));
vi.mock("./AnnotationEditor", () => ({ default: () => null }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
installMatchMediaStub();
installResizeObserverStub();

let host: HTMLDivElement;
let root: Root;
let tree: TreeStore;

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
});

async function renderPanel() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      <MantineProvider>
        <Provider store={createStore()}>
          <TreeStateContext.Provider value={tree}>
            <AnnotationPanel />
          </TreeStateContext.Provider>
        </Provider>
      </MantineProvider>,
    );
  });
}

function goodButton() {
  return host.querySelector<HTMLButtonElement>('button[aria-label="Annotate.Good"]')!;
}

test("the good-move symbol is disabled at the root and enabled after a move", async () => {
  tree = createTreeStore();
  await renderPanel();
  expect(tree.getState().position).toEqual([]);
  expect(goodButton().disabled).toBe(true);

  await act(async () => {
    tree.getState().makeMove({ payload: "e4" });
  });
  expect(tree.getState().position).toEqual([0]);
  expect(goodButton().disabled).toBe(false);
});

test("the show-more button sits outside every separator (no nested interactive control)", async () => {
  tree = createTreeStore();
  await renderPanel();
  const showMore = host.querySelector<HTMLButtonElement>('button[aria-label="Annotate.ShowMore"]')!;
  expect(showMore).not.toBeNull();
  expect(showMore.closest('[role="separator"]')).toBeNull();
  expect(host.querySelectorAll('[role="separator"] button')).toHaveLength(0);
});
