import { MantineProvider, Tabs } from "@mantine/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { GameOrigin, Tab } from "@/utils/tabs";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { BoardTab } from "./BoardTab";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  installMatchMediaStub();
  vi.useRealTimers();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const file = {
  type: "file" as const,
  name: "White Moragambit.PGN",
  handle: { kind: "fileWorkspace" as const, id: { id: "morra" } },
  numGames: 3,
  metadata: { type: "repertoire" as const, tags: [] },
  lastModified: 1,
};

test.each([
  { kind: "file", truncated: false, expected: "White Moragambit › Morra" },
  { kind: "temp_file", truncated: false, expected: "White Moragambit › Morra" },
  { kind: "file", truncated: true, expected: "White Moragambit › Morra" },
  { kind: "none", truncated: false, expected: null },
  { kind: "none", truncated: true, expected: "Morra" },
] as const)(
  "$kind tab tooltip with truncated=$truncated",
  async ({ kind, truncated, expected }) => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(100);
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(truncated ? 200 : 100);
    const gameOrigin: GameOrigin = kind === "none" ? { kind } : { kind, file, gameNumber: 1 };
    const tab: Tab = { value: "tab", name: "Morra", type: "analysis", gameOrigin };
    await act(async () =>
      root.render(
        <MantineProvider>
          <Tabs value="tab">
            <Tabs.List>
              <BoardTab
                tab={tab}
                tabType="analysis"
                selected
                setActiveTab={() => {}}
                dragHandleProps={null}
                onContextMenu={() => {}}
              />
            </Tabs.List>
          </Tabs>
        </MantineProvider>,
      ),
    );
    await act(async () => {
      const target = container.querySelector('[role="tab"]')!;
      target.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      target.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    });
    if (expected === null) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 600));
      });
    }
    await vi.waitFor(
      () =>
        expect(
          [...document.querySelectorAll('[role="tooltip"]')].map((node) => node.textContent),
        ).toEqual(expected === null ? [] : [expected]),
      { timeout: 1500 },
    );
  },
);
