import { MantineProvider } from "@mantine/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { installMatchMediaStub } from "@/tests/matchMedia";
import ResultsChart from "./ResultsChart";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
installMatchMediaStub();
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function render(won: number, draw: number, lost: number, labelThreshold?: number) {
  await act(async () =>
    root.render(
      <MantineProvider>
        <ResultsChart
          won={won}
          draw={draw}
          lost={lost}
          size="1.125rem"
          labelThreshold={labelThreshold}
        />
      </MantineProvider>,
    ),
  );
}

test("the default 15% label threshold is preserved and callers can raise it", async () => {
  const labels = () =>
    [...container.querySelectorAll(".mantine-Progress-label")].map((label) => label.textContent);
  await render(15, 16, 69);
  expect(labels()).toEqual(["", "16.0%", "69.0%"]);
  await render(15, 16, 69, 0.2);
  expect(labels()).toEqual(["", "", "69.0%"]);
});

test("the tree's 20% threshold shows a 25% label and omits a 15% label", async () => {
  await render(12, 5, 3);
  expect(container.textContent).toContain("25.0%");
  await render(12, 5, 3, 0.2);
  expect(
    [...container.querySelectorAll(".mantine-Progress-label")].map((label) => label.textContent),
  ).toEqual(["60.0%", "25.0%", ""]);
});
