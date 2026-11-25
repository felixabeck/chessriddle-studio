import { MantineProvider, Tabs } from "@mantine/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test } from "vitest";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { GroupedSidebarTabs, type GroupedSidebarGroup } from "./GroupedSidebarTabs";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
installMatchMediaStub();

const groups: readonly GroupedSidebarGroup[] = [
  {
    id: "chess",
    title: "Chess",
    headingProps: { "data-settings-group": "chess" },
    tabs: [
      {
        value: "board",
        label: "Board",
        emoji: "♟️",
        accent: "var(--cf-chart-2)",
        tabProps: { "data-settings-category": "board" },
      },
      {
        value: "analysis",
        label: "Analysis",
        emoji: "🔍",
        accent: "var(--cf-chart-2)",
        tabProps: { "data-settings-category": "analysis" },
      },
    ],
  },
  {
    id: "app",
    title: "App",
    headingProps: { "data-settings-group": "app" },
    tabs: [
      {
        value: "general",
        label: "General",
        emoji: "⚙️",
        accent: "var(--cf-chart-4)",
        tabProps: { "data-settings-category": "general" },
      },
    ],
  },
];

let root: Root | undefined;
let host: HTMLDivElement | undefined;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = undefined;
});

async function renderTabs(compact: boolean) {
  await act(async () =>
    root!.render(
      <MantineProvider env="test">
        <Tabs defaultValue="board">
          <GroupedSidebarTabs groups={groups} compact={compact} />
        </Tabs>
      </MantineProvider>,
    ),
  );
  return host!;
}

test("non-compact sidebar renders group headings and every tab", async () => {
  const container = await renderTabs(false);
  expect(
    [...container.querySelectorAll("[data-settings-group]")].map((node) =>
      node.getAttribute("data-settings-group"),
    ),
  ).toEqual(["chess", "app"]);
  expect(
    [...container.querySelectorAll("[data-settings-category]")].map((node) =>
      node.getAttribute("data-settings-category"),
    ),
  ).toEqual(["board", "analysis", "general"]);
});

test("compact sidebar hides group headings and still renders every tab", async () => {
  const container = await renderTabs(true);
  expect(container.querySelectorAll("[data-settings-group]")).toHaveLength(0);
  expect(
    [...container.querySelectorAll("[data-settings-category]")].map((node) =>
      node.getAttribute("data-settings-category"),
    ),
  ).toEqual(["board", "analysis", "general"]);
});
