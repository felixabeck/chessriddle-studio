import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import {
  dateColumn,
  formatEventDateRange,
  numericColumn,
  truncatedTextColumn,
} from "./databaseColumns";

test("numeric and date presets leave widths to browser auto layout", () => {
  expect(numericColumn.textAlign).toBe("right");
  expect(numericColumn.noWrap).toBe(true);
  expect(numericColumn.cellsStyle()).toEqual({ fontVariantNumeric: "tabular-nums" });
  expect(dateColumn.noWrap).toBe(true);
  for (const preset of [numericColumn, dateColumn]) {
    expect(preset).not.toHaveProperty("width");
    expect(preset).not.toHaveProperty("resizable");
  }
});

test("truncated text caps only its content and preserves the full value in a native tooltip", () => {
  const preset = truncatedTextColumn<{ site: string | null }>((record) => record.site);
  const host = document.createElement("div");
  const fullValue = 'A long site name with <markup> & "quotes"';
  host.innerHTML = renderToStaticMarkup(preset.render({ site: fullValue }));
  const text = host.querySelector("span")!;
  expect(text.textContent).toBe(fullValue);
  expect(text.title).toBe(fullValue);
  expect(text.style.maxWidth).toBe("16rem");
  expect(text.style.whiteSpace).toBe("nowrap");
  expect(text.style.overflow).toBe("hidden");
  expect(text.style.textOverflow).toBe("ellipsis");
  expect(preset).not.toHaveProperty("width");
  host.innerHTML = renderToStaticMarkup(preset.render({ site: null }));
  expect(host.querySelector("span")!.textContent).toBe("");
  expect(host.querySelector("span")!.title).toBe("");
});

test.each([
  [null, null, ""],
  [undefined, undefined, ""],
  [null, "2025.01.01", ""],
  ["2016.??.??", null, "2016"],
  ["2016.08.??", null, "2016.08"],
  ["2016.08.01", null, "2016.08.01"],
  ["2016.08.01", "2016.08.01", "2016.08.01"],
  ["2016.??.??", "2016", "2016"],
  ["2025.01.17", "2025.02.02", "2025.01.17 – 02.02"],
  ["2025.01.??", "2025.02.??", "2025.01 – 02"],
  ["2016.08.01", "2016.??.??", "2016.08.01 – 2016"],
  ["2024.12.31", "2025.01.01", "2024.12.31 – 2025.01.01"],
  ["2016.??.??", "2017.??.??", "2016 – 2017"],
])("event date %s to %s displays %s", (start, end, expected) => {
  expect(formatEventDateRange(start, end)).toBe(expected);
});
