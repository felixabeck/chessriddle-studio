import { MantineProvider, Tooltip } from "@mantine/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { ResultBar } from "./ResultBar";

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

test("renders labels only for segments that provide one", async () => {
  await act(async () =>
    root.render(
      <MantineProvider>
        <ResultBar
          size="xl"
          w={100}
          segments={[
            { value: 60, color: "success", label: "60%" },
            { value: 25, color: "gray" },
            { value: 15, color: "danger", label: "15%" },
          ]}
        />
      </MantineProvider>,
    ),
  );

  const sections = container.querySelectorAll(".mantine-Progress-section");
  expect(sections).toHaveLength(3);
  expect(sections[0].querySelector(".mantine-Progress-label")?.textContent).toBe("60%");
  expect(sections[1].querySelector(".mantine-Progress-label")).toBeNull();
  expect(sections[2].querySelector(".mantine-Progress-label")?.textContent).toBe("15%");
});

test("renders a per-segment tooltip when tooltip text is provided", async () => {
  await act(async () =>
    root.render(
      <MantineProvider>
        <ResultBar
          size="lg"
          segments={[
            { value: 50, color: "success", label: "50%", tooltip: "5 Wins" },
            { value: 30, color: "gray", label: "30%" },
            { value: 20, color: "danger", label: "20%", tooltip: "2 Losses" },
          ]}
        />
      </MantineProvider>,
    ),
  );

  const sections = container.querySelectorAll(".mantine-Progress-section");
  await act(async () => {
    sections[1].dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    sections[1].dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
  });
  expect(document.querySelectorAll('[role="tooltip"]')).toHaveLength(0);

  await act(async () => {
    sections[0].dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    sections[0].dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
  });
  await vi.waitFor(() => {
    const tooltips = Array.from(
      document.querySelectorAll('[role="tooltip"]'),
      (node) => node.textContent,
    );
    expect(tooltips).toContain("5 Wins");
  });
  await act(async () => {
    sections[0].dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
    sections[0].dispatchEvent(new MouseEvent("mouseleave", { bubbles: true }));
  });
});

test("a Tooltip wrapping the whole bar opens on hover", async () => {
  await act(async () =>
    root.render(
      <MantineProvider>
        <Tooltip label="whole bar">
          <ResultBar
            size="xl"
            w={100}
            segments={[
              { value: 50, color: "success" },
              { value: 30, color: "gray" },
              { value: 20, color: "danger" },
            ]}
          />
        </Tooltip>
      </MantineProvider>,
    ),
  );

  const bar = container.querySelector(".mantine-Progress-root")!;
  await act(async () => {
    bar.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    bar.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
  });
  await vi.waitFor(() => {
    const tooltips = Array.from(
      document.querySelectorAll('[role="tooltip"]'),
      (node) => node.textContent,
    );
    expect(tooltips).toContain("whole bar");
  });
});

test("forwards root and segment props to the rendered DOM", async () => {
  await act(async () =>
    root.render(
      <MantineProvider>
        <ResultBar
          size="xl"
          w={100}
          className="custom-result-bar"
          segments={[
            {
              value: 55,
              color: "var(--cf-eval-bar-light)",
              className: "white-segment",
              label: "55%",
              labelColor: "var(--cf-eval-bar-dark)",
              labelStyle: { textOverflow: "clip" },
            },
            { value: 20, color: "gray", label: "20%" },
            { value: 25, color: "danger", label: "25%" },
          ]}
        />
      </MantineProvider>,
    ),
  );

  const bar = container.querySelector<HTMLElement>(".mantine-Progress-root")!;
  expect(bar.classList.contains("custom-result-bar")).toBe(true);
  expect(bar.style.width).toBe("calc(6.25rem * var(--mantine-scale))");

  const sections = container.querySelectorAll<HTMLElement>(".mantine-Progress-section");
  expect(sections).toHaveLength(3);
  expect(Array.from(sections, (section) => section.getAttribute("aria-valuenow"))).toEqual([
    "55",
    "20",
    "25",
  ]);
  expect(
    Array.from(sections, (section) => section.style.getPropertyValue("--progress-section-color")),
  ).toEqual(["var(--cf-eval-bar-light)", "var(--mantine-color-gray-filled)", "danger"]);
  expect(sections[0].classList.contains("white-segment")).toBe(true);

  const firstLabel = sections[0].querySelector<HTMLElement>(".mantine-Progress-label")!;
  expect(firstLabel.style.color).toBe("var(--cf-eval-bar-dark)");
  expect(firstLabel.style.textOverflow).toBe("clip");
});

test("names each progressbar from ariaLabel, falling back to tooltip", async () => {
  await act(async () =>
    root.render(
      <MantineProvider>
        <ResultBar
          size="xl"
          w={100}
          segments={[
            { value: 50, color: "success", tooltip: "5 Wins" },
            { value: 30, color: "gray", ariaLabel: "Draws", tooltip: "3 Draws" },
            { value: 20, color: "danger" },
          ]}
        />
      </MantineProvider>,
    ),
  );

  const sections = container.querySelectorAll(".mantine-Progress-section");
  expect(Array.from(sections, (section) => section.getAttribute("aria-label"))).toEqual([
    "5 Wins",
    "Draws",
    null,
  ]);
});
