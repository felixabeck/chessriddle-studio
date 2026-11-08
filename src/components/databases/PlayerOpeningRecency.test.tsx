import { MantineProvider } from "@mantine/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { PositionStats } from "@/bindings";
import type { SupportedLocale } from "@/i18n";
import { catalogueI18n, shippedCatalogues } from "@/tests/catalogues";
import { installMatchMediaStub } from "@/tests/matchMedia";
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
};
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 11, 31, 12));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
});
async function render(row = base, locale: SupportedLocale = "en-US") {
  const i18n = await catalogueI18n(locale);
  await act(async () =>
    root.render(
      <MantineProvider>
        <I18nextProvider i18n={i18n}>
          <PlayerOpeningRecency row={row} />
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

test("eight local calendar years, older, future and unusable dates account for every game across New Year", async () => {
  const row = {
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
  vi.setSystemTime(new Date(2026, 11, 31, 23, 59, 59));
  await render(row);
  expect(counts()).toEqual([3, 1, 0, 0, 0, 2, 0, 0, 3]);
  expect(summary()).toContain("Before 2019: 3 games");
  expect(summary()).toContain("2019: 1 game");
  expect(summary()).toContain("2020: 0 games");
  expect(summary()).not.toContain("2027:");
  expect(summary()).toContain("3 without a usable year");
  const cells = container.querySelectorAll<HTMLElement>("[data-count]");
  expect(cells[0].style.background).toBe(cells[8].style.background);
  expect(cells[1].style.background).not.toBe(cells[0].style.background);
  expect(cells[2].style.background).toBe("var(--cf-interactive)");
  vi.setSystemTime(new Date(2027, 0, 1, 0, 0, 0));
  await render(row);
  expect(counts()).toEqual([4, 0, 0, 0, 2, 0, 0, 3, 2]);
  expect(summary()).toContain("Before 2020: 4 games");
  expect(summary()).toContain("2027: 2 games");
  expect(summary()).toContain("1 without a usable year");
});

test("the largest cell reaches full intensity independently of the move's total games", async () => {
  await render({
    ...base,
    year_counts: [
      { year: 2024, count: 3 },
      { year: 2025, count: 6 },
      { year: 2026, count: 3 },
    ],
  });
  const largestCellBackground = () =>
    container.querySelectorAll<HTMLElement>("[data-count]")[7].style.background;
  expect(largestCellBackground()).toContain("var(--cf-primary) 100%");

  await render({
    ...base,
    white: 18,
    year_counts: [
      { year: 2024, count: 6 },
      { year: 2025, count: 6 },
      { year: 2026, count: 6 },
    ],
  });
  expect(largestCellBackground()).toContain("var(--cf-primary) 100%");
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
  expect(summary()).toContain("12 without a usable year");
});

test.each(shippedCatalogues())(
  "$locale translates recency and its game plurals without fallback",
  async ({ locale, translation }) => {
    const i18n = await catalogueI18n(locale as SupportedLocale);
    for (const key of Object.keys(translation).filter(
      (key) => key.includes("OpeningTree.Recency.") || key === "Databases.OpeningTree.LastPlayed",
    )) {
      expect(translation[key].trim()).not.toBe("");
      expect(i18n.t(key)).not.toBe(key);
    }
    for (const count of [0, 1, 2, 5, 21]) {
      for (const key of [
        "Databases.OpeningTree.Recency.Year",
        "Databases.OpeningTree.Recency.Older",
        "Databases.OpeningTree.Recency.Unplaced",
      ]) {
        const text = i18n.t(key, { year: 2026, count });
        expect(text).not.toBe(key);
        expect(text).not.toContain("{{");
        expect(text).toContain(String(count));
      }
    }
  },
);
