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

test("renders player-perspective Wins and Losses tooltips", async () => {
  await render(4, 2, 1);
  const sections = container.querySelectorAll(".mantine-Progress-section");
  expect(sections).toHaveLength(3);
  expect(Array.from(sections, (section) => section.getAttribute("aria-label"))).toEqual([
    "4 Databases.OpeningTree.Wins",
    "2 Board.Analysis.Tablebase.Draw",
    "1 Databases.OpeningTree.Losses",
  ]);

  for (const [index, expected] of [
    [0, "4 Databases.OpeningTree.Wins"],
    [1, "2 Board.Analysis.Tablebase.Draw"],
    [2, "1 Databases.OpeningTree.Losses"],
  ] as const) {
    await act(async () => {
      sections[index].dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      sections[index].dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    });
    await vi.waitFor(() => {
      const tooltips = Array.from(
        document.querySelectorAll('[role="tooltip"]'),
        (node) => node.textContent,
      );
      expect(tooltips).toContain(expected);
    });
    await act(async () => {
      sections[index].dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
      sections[index].dispatchEvent(new MouseEvent("mouseleave", { bubbles: true }));
    });
  }
});

test("paints win labels black and draw labels for the active scheme's gray fill", async () => {
  const colorAt = (index: number) =>
    container
      .querySelectorAll<HTMLElement>(".mantine-Progress-section")
      [index].querySelector<HTMLElement>(".mantine-Progress-label")!.style.color;

  await render(4, 2, 1);
  expect(colorAt(0)).toBe("var(--mantine-color-black)");
  expect(colorAt(1)).toBe("var(--mantine-color-white)");

  await act(async () =>
    root.render(
      <MantineProvider forceColorScheme="dark">
        <ResultsChart won={4} draw={2} lost={1} size="1.125rem" />
      </MantineProvider>,
    ),
  );
  expect(colorAt(0)).toBe("var(--mantine-color-black)");
  expect(colorAt(1)).toBe("var(--mantine-color-black)");
});

test("renders an empty progress root when total is zero", async () => {
  await render(0, 0, 0);
  expect(container.querySelector(".mantine-Progress-root")).not.toBeNull();
  expect(container.querySelectorAll(".mantine-Progress-section")).toHaveLength(0);
});
