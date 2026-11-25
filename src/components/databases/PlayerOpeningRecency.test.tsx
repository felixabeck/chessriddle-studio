import { MantineProvider } from "@mantine/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { PositionStats } from "@/bindings";
import type { SupportedLocale } from "@/i18n";
import { catalogueI18n, shippedCatalogues } from "@/tests/catalogues";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { expectHoverTooltip } from "@/tests/tooltip";
import { sectionYearTotals } from "./openingRecency";
import PlayerOpeningRecency from "./PlayerOpeningRecency";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
installMatchMediaStub({ matches: () => false });
let container: HTMLDivElement;
let root: Root;
const base: PositionStats = {
  move: "e4",
  white: 12,
  black: 0,
  draw: 0,
  unknown: 0,
  last_played: "2026.11.08",
  year_counts: [],
  recent: [],
};
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
async function render(
  row = base,
  locale: SupportedLocale = "en-US",
  currentYear = 2026,
  sectionTotals = sectionYearTotals([row], currentYear),
) {
  const i18n = await catalogueI18n(locale);
  await act(async () =>
    root.render(
      <MantineProvider>
        <I18nextProvider i18n={i18n}>
          <PlayerOpeningRecency row={row} currentYear={currentYear} sectionTotals={sectionTotals} />
        </I18nextProvider>
      </MantineProvider>,
    ),
  );
}
function counts() {
  return [...container.querySelectorAll("[data-count]")].map((cell) =>
    Number(cell.getAttribute("data-count")),
  );
}
function summary() {
  return container.querySelector('[role="img"]')!.getAttribute("aria-label")!;
}
function cell(index: number) {
  return container.querySelectorAll<HTMLElement>("[data-count]")[index];
}

test("eight local calendar years, older, future and unusable dates account for every game across New Year", async () => {
  const row: PositionStats = {
    ...base,
    year_counts: [
      { year: 2000, count: 1 },
      { year: 2018, count: 2 },
      { year: 2019, count: 1 },
      { year: 2023, count: 2 },
      { year: 2026, count: 3 },
      { year: 2027, count: 2 },
    ],
  };
  await render(row, "en-US", 2026);
  expect(counts()).toEqual([3, 1, 0, 0, 0, 2, 0, 0, 3]);
  expect(summary()).toContain("Before 2019: 3 of 3 games (100%)");
  expect(summary()).toContain("2019: 1 of 1 game (100%)");
  expect(summary()).toContain("2020: no games");
  expect(summary()).not.toContain("2027:");
  expect(summary()).toContain("3 without a usable year");
  const cells = container.querySelectorAll<HTMLElement>("[data-count]");
  expect(cells[0].style.background).toBe(cells[8].style.background);
  expect(cells[1].style.background).toBe(cells[0].style.background);
  expect(cells[2].style.background).toBe("var(--cf-interactive)");

  await render(row, "en-US", 2027);
  expect(counts()).toEqual([4, 0, 0, 0, 2, 0, 0, 3, 2]);
  expect(summary()).toContain("Before 2020: 4 of 4 games (100%)");
  expect(summary()).toContain("2027: 2 of 2 games (100%)");
  expect(summary()).toContain("1 without a usable year");
});

test("cells are shaded by share of the section's games in that year and expose both hover predicates", async () => {
  const row: PositionStats = {
    ...base,
    white: 1,
    year_counts: [{ year: 2026, count: 1 }],
  };
  // Section totals: 2019-2025 empty, older bucket has 0, 2025 has 3 (0 of 3 for this row), 2026 has 14.
  const sectionTotals = [0, 0, 0, 0, 0, 0, 0, 3, 14];
  await render(row, "en-US", 2026, sectionTotals);

  const cells = container.querySelectorAll<HTMLElement>("[data-count]");
  const expectedShare = 25 + (1 / 14) * 75;
  expect(cells[8].style.background).toContain(`var(--cf-primary) ${expectedShare}%`);
  expect(cells[8].style.background).not.toContain("var(--cf-primary) 100%");
  expect(cells[7].style.background).toBe("var(--cf-interactive)");

  expect(summary()).toContain("Before 2019: no games");
  expect(summary()).toContain("2020: no games");
  expect(summary()).toContain("2025: 0 of 3 games (0%)");
  expect(summary()).toContain("2026: 1 of 14 games (7%)");

  await expectHoverTooltip(cell(0), "Before 2019: no games");
  await expectHoverTooltip(cell(2), "2020: no games");
  await expectHoverTooltip(cell(7), "2025: 0 of 3 games (0%)");
  await expectHoverTooltip(cell(8), "2026: 1 of 14 games (7%)");
});

test.each([
  ["2026.11.08", "2026-11"],
  ["2026.03.??", "2026-03"],
  ["2026.??.??", "2026"],
  ["2026", "2026"],
  ["2026.00.00", "2026"],
  [null, "–"],
  ["2030.01.01", "2030-01"],
])("last played %s displays %s", async (date, display) => {
  await render({ ...base, last_played: date });
  expect(container.querySelector("[data-opening-last-played]")?.textContent).toBe(
    `Last played ${display}`,
  );
});

test("a fully dated move has no missing-year suffix and an undated move has nine empty cells", async () => {
  await render({ ...base, year_counts: [{ year: 2026, count: 12 }] });
  expect(summary()).not.toContain("without a usable year");
  await render({ ...base, last_played: null });
  expect(counts()).toEqual(Array(9).fill(0));
  expect(summary()).toContain("Before 2019: no games");
  expect(summary()).toContain("12 without a usable year");
});

test.each(shippedCatalogues())(
  "$locale translates recency and recent copy with every plural form without fallback",
  async ({ locale, translation }) => {
    const i18n = await catalogueI18n(locale as SupportedLocale);
    for (const key of Object.keys(translation).filter(
      (key) =>
        key.includes("OpeningTree.Recency.") ||
        key.includes("OpeningTree.Recent.") ||
        key === "Databases.OpeningTree.LastPlayed",
    )) {
      expect(translation[key].trim()).not.toBe("");
      expect(i18n.t(key)).not.toBe(key);
    }
    const summaryTemplate = translation["Databases.OpeningTree.Recent.Summary"];
    expect(summaryTemplate.match(/<parts\s*\/>/g)).toHaveLength(1);
    expect(summaryTemplate.match(/<\/?parts\b/g)).toHaveLength(1);
    for (const key of [
      "Databases.OpeningTree.Recent.SummaryMove",
      "Databases.OpeningTree.Recent.SummaryTie",
      "Databases.OpeningTree.Recent.SummarySourceMove",
      "Databases.OpeningTree.Recent.SummarySourceTie",
    ] as const) {
      const template = translation[key];
      expect(template.match(/<move>\{\{move\}\}<\/move>/g)).toHaveLength(1);
      expect(template.match(/<\/?move\b[^>]*>/g)).toHaveLength(2);
    }
    for (const key of [
      "Databases.OpeningTree.Recent.SummarySourceMove",
      "Databases.OpeningTree.Recent.SummarySourceTie",
    ] as const) {
      expect(translation[key].match(/\{\{source\}\}/g)).toHaveLength(1);
    }
    for (const count of [0, 1, 2, 5, 21]) {
      for (const [key, params] of [
        ["Databases.OpeningTree.Recency.Year", { year: 2026, played: 1, count, percent: 50 }],
        ["Databases.OpeningTree.Recency.Older", { year: 2026, played: 1, count, percent: 50 }],
        ["Databases.OpeningTree.Recency.Unplaced", { count }],
        ["Databases.OpeningTree.Recent.HeaderCount", { count }],
        ["Databases.OpeningTree.Recent.Tooltip", { percent: 90, count }],
      ] as const) {
        const text = i18n.t(key, params);
        expect(text).not.toBe(key);
        expect(text).not.toContain("{{");
        expect(text).toContain(String(count));
      }
    }
    for (const [key, params, expectedTokens] of [
      ["Databases.OpeningTree.Recency.YearEmpty", { year: 2026 }, ["2026"]],
      ["Databases.OpeningTree.Recency.OlderEmpty", { year: 2026 }, ["2026"]],
      ["Databases.OpeningTree.Recency.Summary", { years: "2026: 1 of 2 games (50%)" }, ["2026"]],
      ["Databases.OpeningTree.Recent.HeaderEmpty", {}, []],
      ["Databases.OpeningTree.Recent.HeaderSince", { date: "2023-09" }, ["2023-09"]],
      ["Databases.OpeningTree.Recent.Cell", { played: 9, total: 10 }, ["9", "10"]],
      ["Databases.OpeningTree.Recent.Summary", {}, []],
      [
        "Databases.OpeningTree.Recent.SummaryMove",
        { move: "c5", played: 3, total: 4 },
        ["c5", "3", "4"],
      ],
      [
        "Databases.OpeningTree.Recent.SummaryTie",
        { move: "c5 / e4", played: 4, total: 10 },
        ["c5 / e4", "4", "10"],
      ],
      [
        "Databases.OpeningTree.Recent.SummarySourceMove",
        { source: "Over the board", move: "c5", played: 3, total: 4 },
        ["Over the board", "c5", "3", "4"],
      ],
      [
        "Databases.OpeningTree.Recent.SummarySourceTie",
        { source: "Over the board", move: "c5 / e4", played: 4, total: 10 },
        ["Over the board", "c5 / e4", "4", "10"],
      ],
    ] as const) {
      const text = i18n.t(key, params);
      expect(text).not.toBe(key);
      expect(text).not.toContain("{{");
      for (const token of expectedTokens) {
        expect(text).toContain(token);
      }
    }
  },
);
