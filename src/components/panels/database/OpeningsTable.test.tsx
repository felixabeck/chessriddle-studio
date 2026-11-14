import { MantineProvider } from "@mantine/core";
import type { i18n } from "i18next";
import { Provider, createStore } from "jotai";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, expect, test } from "vitest";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import { createTreeStore, type TreeStore } from "@/state/store/tree";
import { catalogueI18n } from "@/tests/catalogues";
import { installMatchMediaStub } from "@/tests/matchMedia";
import type { Opening } from "@/utils/db";
import OpeningsTable from "./OpeningsTable";

installMatchMediaStub({ matches: (query) => query === "" });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const openings: Opening[] = [
  { move: "e4", white: 10, draw: 5, black: 5 },
  { move: "d4", white: 8, draw: 4, black: 4 },
  { move: "*", white: 1, draw: 0, black: 1 },
];

let host: HTMLDivElement;
let root: Root;
let locale: i18n;
let jotai: ReturnType<typeof createStore>;
let treeStore: TreeStore;

beforeEach(async () => {
  sessionStorage.clear();
  jotai = createStore();
  treeStore = createTreeStore();
  locale = await catalogueI18n("en-US");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  treeStore.dispose();
});

async function renderTable(rows: Opening[] = openings) {
  await act(async () =>
    root.render(
      <MantineProvider env="test">
        <I18nextProvider i18n={locale}>
          <Provider store={jotai}>
            <TreeStateContext.Provider value={treeStore}>
              <OpeningsTable openings={rows} loading={false} />
            </TreeStateContext.Provider>
          </Provider>
        </I18nextProvider>
      </MantineProvider>,
    ),
  );
}

function bodyRows() {
  return [...host.querySelectorAll<HTMLTableRowElement>("tbody tr")];
}

test("move row is focusable and Enter plays the move", async () => {
  await renderTable();
  const [e4Row] = bodyRows();
  expect(e4Row.getAttribute("tabindex")).toBe("0");
  expect(e4Row.tabIndex).toBe(0);

  await act(async () =>
    e4Row.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
  );

  const state = treeStore.getState();
  expect(state.position).toEqual([0]);
  expect(state.root.children).toHaveLength(1);
  expect(state.root.children[0].san).toBe("e4");
});

test("clicking a move row plays the move", async () => {
  await renderTable();
  const [e4Row] = bodyRows();

  await act(async () => e4Row.click());

  const state = treeStore.getState();
  expect(state.position).toEqual([0]);
  expect(state.root.children).toHaveLength(1);
  expect(state.root.children[0].san).toBe("e4");
});

test("total row and game-over row have no tabindex and ignore Enter and click", async () => {
  await renderTable();
  const rows = bodyRows();
  expect(rows).toHaveLength(4);
  const gameOverRow = rows[2];
  const totalRow = rows[3];

  expect(gameOverRow.getAttribute("tabindex")).toBeNull();
  expect(totalRow.getAttribute("tabindex")).toBeNull();
  expect(totalRow.querySelector("td")?.textContent).toBe("Total");

  await act(async () => {
    totalRow.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    totalRow.click();
    gameOverRow.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    gameOverRow.click();
  });

  const state = treeStore.getState();
  expect(state.position).toEqual([]);
  expect(state.root.children).toHaveLength(0);
});

test("total row omits percentage while move rows show percentage and count", async () => {
  await renderTable();
  const rows = bodyRows();
  expect(rows).toHaveLength(4);

  const e4TotalCell = rows[0].querySelectorAll("td")[1].textContent;
  expect(e4TotalCell).toContain("53%");
  expect(e4TotalCell).toContain("20");

  const sumCell = rows[3].querySelectorAll("td")[1].textContent;
  expect(sumCell).not.toContain("%");
  expect(sumCell).toBe("38");
});
