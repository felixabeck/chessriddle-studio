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
import { expectHoverTooltip } from "@/tests/tooltip";
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
});

async function renderTable(rows: Opening[] = openings, total?: Opening, loading = false) {
  await act(async () =>
    root.render(
      <MantineProvider env="test">
        <I18nextProvider i18n={locale}>
          <Provider store={jotai}>
            <TreeStateContext.Provider value={treeStore}>
              <OpeningsTable openings={rows} total={total} loading={loading} />
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

test("each move and the Total row show White's score in whole percent", async () => {
  await renderTable();
  const scores = bodyRows().map((row) => row.querySelectorAll("td")[2].textContent);
  // e4 10/5/5, d4 8/4/4, game over 1/0/1, total 19/9/10.
  expect(scores).toEqual(["63%", "63%", "50%", "62%"]);
});

test("the Score header explains that it is White's score", async () => {
  await renderTable();
  const header = host.querySelectorAll("thead th")[2].querySelector("span")!;
  expect(header.textContent).toBe("Score");
  await expectHoverTooltip(header, "White's score: wins plus half the draws");
});

test("a move with only unknown results shows no score", async () => {
  await renderTable([{ move: "a3", white: 0, draw: 0, black: 0, unknown: 4 }]);
  expect(bodyRows()[0].querySelectorAll("td")[2].textContent).toBe("");
});

test("a source's position total is the Total row and every percentage's denominator", async () => {
  // The online explorers list only the common moves: 36 listed games of a 72-game position.
  await renderTable(openings.slice(0, 2), { move: "", white: 30, draw: 20, black: 22 });
  const rows = bodyRows();
  expect(rows).toHaveLength(3);
  const e4TotalCell = rows[0].querySelectorAll("td")[1].textContent;
  expect(e4TotalCell).toContain("28%");
  expect(e4TotalCell).toContain("20");
  expect(rows[2].querySelectorAll("td")[1].textContent).toBe("72");
});

test("a position with a total but no move row shows the Total row alone", async () => {
  await renderTable([], { move: "", white: 0, draw: 0, black: 4210 });
  const rows = bodyRows();
  expect(rows).toHaveLength(1);
  expect(rows[0].querySelector("td")?.textContent).toBe("Total");
  expect(rows[0].querySelectorAll("td")[1].textContent).toBe("4,210");
});

test("no move row and no game in the total keeps the empty state", async () => {
  await renderTable([], { move: "", white: 0, draw: 0, black: 0 });
  expect(bodyRows().some((row) => row.querySelector("td")?.textContent === "Total")).toBe(false);
});

const comparisonOpenings: Opening[] = [
  { move: "d4", white: 2, draw: 9, black: 1 },
  { move: "h4", white: 1, draw: 6, black: 1 },
];

async function renderCompared(
  props: Partial<React.ComponentProps<typeof OpeningsTable>> = {},
  comparison = { openings: comparisonOpenings, loading: false },
) {
  await act(async () =>
    root.render(
      <MantineProvider env="test">
        <I18nextProvider i18n={locale}>
          <Provider store={jotai}>
            <TreeStateContext.Provider value={treeStore}>
              <OpeningsTable
                openings={openings}
                loading={false}
                sources={[
                  {
                    column: "primary",
                    openings: props.openings ?? openings,
                    loading: props.loading ?? false,
                  },
                  { column: "comparison", ...comparison },
                ]}
                {...props}
              />
            </TreeStateContext.Provider>
          </Provider>
        </I18nextProvider>
      </MantineProvider>,
    ),
  );
}

const cells = (row: HTMLTableRowElement) =>
  [...row.querySelectorAll("td")].map((cell) => cell.textContent);

test("two sources render a Total, a Score and a Results column each, and one source keeps four", async () => {
  await renderCompared();
  expect([...host.querySelectorAll("thead th")].map((th) => th.textContent)).toEqual([
    "Move",
    "Total",
    "Score",
    "Results",
    "Total",
    "Score",
    "Results",
  ]);
  await renderTable();
  expect([...host.querySelectorAll("thead th")].map((th) => th.textContent)).toEqual([
    "Move",
    "Total",
    "Score",
    "Results",
  ]);
  expect(host.querySelector("thead button, thead [role='button']")).toBeNull();
});

test("rows are the union of both sources, with a dash and no bar where a source has no game", async () => {
  await renderCompared();
  const rows = bodyRows();
  expect(rows.map((row) => row.querySelector("td")?.textContent)).toEqual([
    "e4",
    "d4",
    "Game is over",
    "h4",
    "Total",
  ]);
  const [e4, d4, , h4, total] = rows;
  // e4: 20 of the primary's 38 games, none in the comparison.
  expect(cells(e4).slice(1, 2)).toEqual(["53%20"]);
  expect(cells(e4)[4]).toBe("–");
  expect(e4.querySelectorAll("td")[6].querySelector(".mantine-Progress-root")).toBeNull();
  expect(e4.querySelectorAll("td")[3].querySelector(".mantine-Progress-root")).not.toBeNull();
  // d4 is in both; each share is of its own source's total.
  expect(cells(d4)[1]).toBe("42%16");
  expect(cells(d4)[4]).toBe("60%12");
  // Each source scores its own games: 8/4/4 and 2/9/1.
  expect(cells(d4)[2]).toBe("63%");
  expect(cells(d4)[5]).toBe("54%");
  expect(cells(e4)[5]).toBe("");
  // h4 only in the comparison.
  expect(cells(h4)[1]).toBe("–");
  expect(cells(h4)[4]).toBe("40%8");
  expect(h4.querySelectorAll("td")[3].querySelector(".mantine-Progress-root")).toBeNull();
  // Each source's total, without a share, and its own score: 19/9/10 and 3/15/2.
  expect(cells(total)[1]).toBe("38");
  expect(cells(total)[4]).toBe("20");
  expect(cells(total)[2]).toBe("62%");
  expect(cells(total)[5]).toBe("53%");
  expect(host.querySelectorAll("[data-no-games]")).toHaveLength(3);
});

test("the sort follows the chosen source and a header click reports the next sort", async () => {
  const changes: unknown[] = [];
  await renderCompared({
    sort: { source: "comparison", direction: "desc" },
    onSortChange: (sort) => changes.push(sort),
  });
  expect(bodyRows().map((row) => row.querySelector("td")?.textContent)).toEqual([
    "d4",
    "h4",
    "e4",
    "Game is over",
    "Total",
  ]);
  const headers = [...host.querySelectorAll<HTMLElement>("thead th")];
  // Only the two Total columns sort, and the comparison's carries the active indicator.
  const indicator = (th: HTMLElement) =>
    th.querySelector(".mantine-datatable-header-cell-sortable-icon")
      ? "sorted"
      : th.querySelector(".mantine-datatable-header-cell-sortable-unsorted-icon")
        ? "unsorted"
        : null;
  expect(headers.map(indicator)).toEqual([null, "unsorted", null, null, "sorted", null, null]);
  await act(async () => headers[4].click());
  await act(async () => headers[1].click());
  expect(changes).toEqual([
    // The sorted column flips; another column takes over with the direction in use.
    { source: "comparison", direction: "asc" },
    { source: "primary", direction: "desc" },
  ]);
});

test("a source still searching marks its own cells while the other one is shown", async () => {
  await renderCompared({}, { openings: [], loading: true });
  const [e4, , , total] = bodyRows();
  expect(cells(e4)[1]).toBe("53%20");
  expect(cells(e4)[4]).toBe("…");
  expect(cells(e4)[5]).toBe("");
  expect(cells(total)[4]).toBe("…");
  expect(host.querySelectorAll("[data-no-games]")).toHaveLength(0);
  expect(host.querySelector(".mantine-datatable-loader-fetching")).toBeNull();
});

test("a single source shows the table-wide overlay while it searches", async () => {
  await renderTable(openings, undefined, true);
  expect(host.querySelector(".mantine-datatable-loader-fetching")).not.toBeNull();
  await renderTable();
  expect(host.querySelector(".mantine-datatable-loader-fetching")).toBeNull();
});

test("the table-wide overlay shows only while every source is searching", async () => {
  await renderCompared({ loading: true }, { openings: [], loading: true });
  expect(host.querySelector(".mantine-datatable-loader-fetching")).not.toBeNull();
  await renderCompared({ loading: true });
  expect(host.querySelector(".mantine-datatable-loader-fetching")).toBeNull();
  // The searching primary still holds its old rows, and shows no score from them.
  const d4 = bodyRows().find((row) => row.querySelector("td")?.textContent === "d4")!;
  expect(cells(d4)[2]).toBe("");
  expect(cells(d4)[5]).toBe("54%");
  expect(cells(bodyRows().at(-1)!)[2]).toBe("");
});

test("multi-source result bars carry no labels, and one source labels its wider sections", async () => {
  await renderCompared();
  const [e4, d4] = bodyRows();
  const labels = (cell: Element) =>
    [...cell.querySelectorAll(".mantine-Progress-label")].map((label) => label.textContent);
  // e4 primary: 10 / 5 / 5 of 20; d4 comparison: 2 / 9 / 1 of 12.
  expect(labels(e4.querySelectorAll("td")[3])).toEqual(["", "", ""]);
  expect(labels(d4.querySelectorAll("td")[6])).toEqual(["", "", ""]);
  await renderTable();
  expect(labels(bodyRows()[0].querySelectorAll("td")[3])).toEqual(["50.0%", "25.0%", "25.0%"]);
});

test("a source without a single counted game shows a zero total and no bar or NaN", async () => {
  await renderCompared({}, { openings: [], loading: false });
  const total = bodyRows().at(-1)!;
  expect(cells(total)[1]).toBe("38");
  expect(cells(total)[4]).toBe("0");
  expect(cells(total)[5]).toBe("");
  expect(total.querySelectorAll("td")[6].querySelector(".mantine-Progress-root")).toBeNull();
  expect(host.textContent).not.toContain("NaN");

  // Only games with an unknown result: the move exists, but no side has a counted game.
  const unknownOnly: Opening[] = [{ move: "a3", white: 0, draw: 0, black: 0, unknown: 4 }];
  await renderTable(unknownOnly);
  const [a3] = bodyRows();
  expect(cells(a3).slice(0, 2)).toEqual(["a3", "0%0"]);
  expect(a3.querySelector(".mantine-Progress-root")).toBeNull();
  expect(host.textContent).not.toContain("NaN");
});

test("a move row of the two-source table plays its move", async () => {
  await renderCompared();
  const h4 = bodyRows().find((row) => row.querySelector("td")?.textContent === "h4")!;
  await act(async () => h4.click());
  expect(treeStore.getState().currentNode().san).toBe("h4");
});

test("three sources render three Total/Score/Results groups and sort by reference", async () => {
  const referenceOpenings: Opening[] = [
    { move: "Nf3", white: 50, draw: 30, black: 20 },
    { move: "e4", white: 100, draw: 50, black: 50 },
  ];
  const changes: unknown[] = [];
  await renderCompared({
    sources: [
      { column: "primary", openings, loading: false },
      { column: "comparison", openings: comparisonOpenings, loading: false },
      { column: "reference", openings: referenceOpenings, loading: false },
    ],
    sort: { source: "reference", direction: "desc" },
    onSortChange: (sort) => changes.push(sort),
  });
  expect([...host.querySelectorAll("thead th")].map((th) => th.textContent)).toEqual([
    "Move",
    "Total",
    "Score",
    "Results",
    "Total",
    "Score",
    "Results",
    "Total",
    "Score",
    "Results",
  ]);
  expect(bodyRows().map((row) => row.querySelector("td")?.textContent)).toEqual([
    "e4",
    "♘f3",
    "d4",
    "Game is over",
    "h4",
    "Total",
  ]);
  const headers = [...host.querySelectorAll<HTMLElement>("thead th")];
  await act(async () => headers[7].click());
  expect(changes).toEqual([{ source: "reference", direction: "asc" }]);
  // Every source scores its own rows; the reference's e4 is 100/50/50 of its 150/80/70.
  const e4 = bodyRows()[0];
  expect([cells(e4)[2], cells(e4)[5], cells(e4)[8]]).toEqual(["63%", "", "63%"]);
  expect(cells(bodyRows().at(-1)!)[8]).toBe("63%");
});

test("a Lichess column's position total is the Total row and percentage denominator with two and three columns", async () => {
  const lichessTotal = { move: "", white: 30, draw: 20, black: 22 };
  await renderCompared({
    sources: [
      { column: "primary", openings, loading: false },
      {
        column: "lch_all",
        openings: openings.slice(0, 2),
        loading: false,
        total: lichessTotal,
      },
    ],
  });
  const two = bodyRows();
  expect(cells(two.at(-1)!)[1]).toBe("38");
  expect(cells(two.at(-1)!)[4]).toBe("72");
  // The reported position total scores 30/20/22.
  expect(cells(two.at(-1)!)[5]).toBe("56%");
  expect(cells(two[0])[4]).toContain("28%");
  expect(cells(two[0])[4]).toContain("20");

  await renderCompared({
    sources: [
      { column: "primary", openings, loading: false },
      { column: "comparison", openings: comparisonOpenings, loading: false },
      {
        column: "lch_master",
        openings: openings.slice(0, 2),
        loading: false,
        total: lichessTotal,
      },
    ],
  });
  const three = bodyRows();
  expect(cells(three.at(-1)!)[7]).toBe("72");
  expect(cells(three.at(-1)!)[8]).toBe("56%");
  expect(cells(three[0])[7]).toContain("28%");
});

test("a column that cannot answer has empty cells and no no-games dash", async () => {
  await renderCompared({
    sources: [
      { column: "primary", openings, loading: false },
      { column: "comparison", openings: comparisonOpenings, loading: false, unavailable: true },
    ],
  });
  const [e4, , , total] = bodyRows();
  expect(cells(e4)[1]).toBe("53%20");
  expect(cells(e4)[4]).toBe("");
  expect(cells(e4)[5]).toBe("");
  expect(e4.querySelectorAll("td")[6].querySelector(".mantine-Progress-root")).toBeNull();
  expect(cells(total)[4]).toBe("");
  expect(host.querySelectorAll("[data-no-games]")).toHaveLength(0);
});

test("a waiting column beside one that cannot answer shows the waiting table, not no games found", async () => {
  await renderCompared({
    openings: [],
    loading: true,
    sources: [
      { column: "primary", openings: [], loading: true },
      { column: "comparison", openings: [], loading: false, unavailable: true },
    ],
  });
  expect(host.querySelector(".mantine-datatable-loader-fetching")).not.toBeNull();
  expect(host.textContent).not.toContain("No games found");
});

test("a stored sort naming an absent source falls back to primary and marks primary sorted", async () => {
  await renderCompared({
    sort: { source: "reference", direction: "asc" },
  });
  expect(bodyRows().map((row) => row.querySelector("td")?.textContent)).toEqual([
    "h4",
    "Game is over",
    "d4",
    "e4",
    "Total",
  ]);
  const headers = [...host.querySelectorAll<HTMLElement>("thead th")];
  const indicator = (th: HTMLElement) =>
    th.querySelector(".mantine-datatable-header-cell-sortable-icon")
      ? "sorted"
      : th.querySelector(".mantine-datatable-header-cell-sortable-unsorted-icon")
        ? "unsorted"
        : null;
  expect(headers.map(indicator)).toEqual([null, "sorted", null, null, "unsorted", null, null]);
});

test("reserves the vertical scrollbar gutter via scrollAreaProps offsetScrollbars", async () => {
  await renderCompared();
  const viewport = host.querySelector<HTMLElement>(".mantine-ScrollArea-viewport");
  expect(viewport?.getAttribute("data-offset-scrollbars")).toBe("y");
});
