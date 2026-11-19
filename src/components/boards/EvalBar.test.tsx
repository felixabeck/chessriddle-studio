import { act } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Score } from "@/bindings";
import { engineDisplayHarness } from "@/tests/engineDisplay";
import EvalBar from "./EvalBar";

let h: ReturnType<typeof engineDisplayHarness>;
beforeEach(() => {
  h = engineDisplayHarness();
});
afterEach(async () => {
  await h.close();
});

const score: Score = { value: { type: "cp", value: 94 }, wdl: null };

async function tooltipText(engineName: string | null) {
  await h.render(<EvalBar score={score} engineName={engineName} orientation="white" />);
  const bar = h.host.querySelector("div")!;
  await act(async () => {
    bar.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    bar.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
  });
  let text = "";
  await vi.waitFor(() => {
    text = document.querySelector('[role="tooltip"]')?.textContent ?? "";
    expect(text).not.toBe("");
  });
  return text;
}

test("the tooltip names the engine the score comes from", async () => {
  expect(await tooltipText("ChessDB")).toBe("+0.94 · ChessDB");
});

test("a score no running engine gives shows without a source", async () => {
  expect(await tooltipText(null)).toBe("+0.94");
});
