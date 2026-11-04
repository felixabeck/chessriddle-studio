import { MantineProvider } from "@mantine/core";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test } from "vitest";
import { changeLocale, initializeI18n } from "@/i18n";
import { installMatchMediaStub } from "@/tests/matchMedia";
import ScoreBubble from "./ScoreBubble";
import classes from "./ScoreBubble.module.css";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let host: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  await initializeI18n();
  await changeLocale("en-US");
  installMatchMediaStub();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

function ScoreToggle() {
  const [evalDisplay, setEvalDisplay] = useState<"cp" | "wdl">("cp");
  return (
    <MantineProvider env="test">
      <ScoreBubble
        size="md"
        score={{ value: { type: "cp", value: 34 }, wdl: [450, 300, 250] }}
        evalDisplay={evalDisplay}
        setEvalDisplay={setEvalDisplay}
      />
    </MantineProvider>
  );
}

test("toggles the centipawn chip to white, draw and black WDL segments and back", async () => {
  await act(async () => root.render(<ScoreToggle />));
  const bubble = () => host.querySelector<HTMLElement>(`.${classes.bubble}`)!;
  expect(bubble().textContent).toBe("+0.34");
  expect(host.querySelectorAll('[role="progressbar"]')).toHaveLength(0);

  await act(async () => bubble().click());

  const segments = [...host.querySelectorAll('[role="progressbar"]')];
  expect(segments).toHaveLength(3);
  expect(segments.map((segment) => segment.getAttribute("aria-valuenow"))).toEqual([
    "45",
    "30",
    "25",
  ]);
  expect(segments.map((segment) => segment.getAttribute("aria-valuetext"))).toEqual([
    "45%",
    "30%",
    "25%",
  ]);
  expect(segments.map((segment) => segment.getAttribute("aria-label"))).toEqual([
    "White wins",
    "Draw",
    "Black wins",
  ]);
  expect(segments.map((segment) => segment.textContent)).toEqual(["45", "30", "25"]);
  for (const [index, side] of [classes.white, classes.equal, classes.black].entries()) {
    expect(segments[index].classList.contains(side)).toBe(true);
  }
  expect(bubble().textContent).not.toContain("+0.34");

  await act(async () => bubble().click());

  expect(bubble().textContent).toBe("+0.34");
  expect(host.querySelectorAll('[role="progressbar"]')).toHaveLength(0);
});
