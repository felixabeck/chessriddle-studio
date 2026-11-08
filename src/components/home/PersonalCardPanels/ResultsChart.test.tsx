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

test("the default 15% label threshold is preserved and callers can raise it", async () => {
  const render = async (labelThreshold?: number) =>
    act(async () =>
      root.render(
        <MantineProvider>
          <ResultsChart
            won={30}
            draw={31}
            lost={39}
            size="1.125rem"
            labelThreshold={labelThreshold}
          />
        </MantineProvider>,
      ),
    );
  const labels = () =>
    [...container.querySelectorAll(".mantine-Progress-label")].map((label) => label.textContent);
  await render();
  expect(labels()).toEqual(["30.0%", "31.0%", "39.0%"]);
  await render(0.3);
  expect(labels()).toEqual(["", "31.0%", "39.0%"]);
});

test("a 25% label remains available by default and is omitted at the tree's threshold", async () => {
  const render = async (labelThreshold?: number) =>
    act(async () =>
      root.render(
        <MantineProvider>
          <ResultsChart won={5} draw={2} lost={1} size="1.125rem" labelThreshold={labelThreshold} />
        </MantineProvider>,
      ),
    );
  await render();
  expect(container.textContent).toContain("25.0%");
  await render(0.3);
  expect(container.textContent).not.toContain("25.0%");
  expect(container.textContent).toContain("62.5%");
});
