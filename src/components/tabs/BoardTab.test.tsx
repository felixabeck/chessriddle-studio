import { MantineProvider } from "@mantine/core";
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
          <BoardTab
            tab={tab}
            selected
            tabStop
            panelMounted
            overflowing={false}
            onSelect={() => {}}
            dragHandleProps={null}
            onContextMenu={() => {}}
            onClose={() => {}}
          />
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

test("a fileDraft analysis tab uses the file icon", async () => {
  const tab: Tab = {
    value: "tab",
    name: "Caro",
    type: "analysis",
    gameOrigin: { kind: "fileDraft", file },
  };
  await act(async () =>
    root.render(
      <MantineProvider>
        <BoardTab
          tab={tab}
          selected
          tabStop
          panelMounted
          overflowing={false}
          onSelect={() => {}}
          dragHandleProps={null}
          onContextMenu={() => {}}
          onClose={() => {}}
        />
      </MantineProvider>,
    ),
  );
  expect(container.querySelector(".lucide-book-bookmark")).not.toBeNull();
  expect(container.querySelector(".lucide-database")).toBeNull();
  expect(container.querySelector(".lucide-scan-search")).toBeNull();
});

function renderBoardTab() {
  const onSelect = vi.fn();
  const onClose = vi.fn();
  const tab: Tab = {
    value: "tab",
    name: "Morra",
    type: "analysis",
    gameOrigin: { kind: "none" },
  };
  return {
    onSelect,
    onClose,
    render: () =>
      root.render(
        <MantineProvider>
          <BoardTab
            tab={tab}
            selected
            tabStop
            panelMounted
            overflowing={false}
            onSelect={onSelect}
            dragHandleProps={null}
            onContextMenu={() => {}}
            onClose={onClose}
          />
        </MantineProvider>,
      ),
  };
}

test("middle click closes the tab without selecting it", async () => {
  const { onSelect, onClose, render } = renderBoardTab();
  await act(async () => {
    render();
  });
  const tab = container.querySelector('[role="tab"]')!;
  await act(async () => {
    tab.dispatchEvent(new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 }));
  });
  expect(onClose).toHaveBeenCalledExactlyOnceWith("tab");
  expect(onSelect).not.toHaveBeenCalled();
});

test("right click does not close the tab", async () => {
  const { onClose, render } = renderBoardTab();
  await act(async () => {
    render();
  });
  const tab = container.querySelector('[role="tab"]')!;
  await act(async () => {
    tab.dispatchEvent(new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 2 }));
  });
  expect(onClose).not.toHaveBeenCalled();
});

test("a middle-mouse press on the tab cancels the default autoscroll", async () => {
  const { render } = renderBoardTab();
  await act(async () => {
    render();
  });
  const tab = container.querySelector('[role="tab"]')!;
  const press = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 1 });
  await act(async () => {
    tab.dispatchEvent(press);
  });
  expect(press.defaultPrevented).toBe(true);
});
