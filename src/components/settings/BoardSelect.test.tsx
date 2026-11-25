import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { DEFAULT_THEME, MantineProvider, mergeMantineTheme } from "@mantine/core";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { installResizeObserverStub } from "@/tests/resizeObserver";
import { stubScrollIntoView } from "@/tests/scrollIntoView";
import { createAppTheme } from "@/styles/theme";
import { chooseSelectOption, hoverSelectOption } from "@/tests/select";
import { SettingRow } from "./SettingsLayout";
import BoardSelect from "./BoardSelect";

vi.mock("jotai", async () => {
  const { useState: useReactState } = await import("react");
  return {
    useAtom: () => {
      const [value, setValue] = useReactState("chessriddle.svg");
      return [value, setValue];
    },
  };
});
vi.mock("@/state/atoms", () => ({ boardImageAtom: {} }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
installMatchMediaStub();
installResizeObserverStub();

const theme = mergeMantineTheme(DEFAULT_THEME, createAppTheme({ spellCheck: true, fontSize: 100 }));

let root: Root | undefined;
let host: HTMLDivElement | undefined;
let restoreScrollIntoView: (() => void) | undefined;

afterEach(() => {
  if (root) act(() => root?.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
  restoreScrollIntoView?.();
  restoreScrollIntoView = undefined;
});

async function renderBoard(node: ReactNode) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<MantineProvider theme={theme}>{node}</MantineProvider>));
}

function selectInput() {
  const input = host!.querySelector<HTMLInputElement>("input.mantine-Select-input");
  if (!input) throw new Error("BoardSelect input is not rendered");
  return input;
}

test("inherits Board Image from SettingRow and shows the board name as its value", async () => {
  await renderBoard(
    <SettingRow title="Board Image" description="d">
      <BoardSelect />
    </SettingRow>,
  );

  expect(selectInput().getAttribute("aria-label")).toBe("Board Image");
  expect(selectInput().value).toBe("chessriddle");
  expect(selectInput().parentElement?.querySelector("[style*='board/']")).toBeNull();
});

test("lists board names with thumbnails", async () => {
  restoreScrollIntoView = stubScrollIntoView();
  await renderBoard(
    <SettingRow title="Board Image" description="d">
      <BoardSelect />
    </SettingRow>,
  );

  await act(async () => selectInput().click());
  const newspaper = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((item) =>
    item.textContent?.includes("newspaper"),
  );
  if (!newspaper) throw new Error("newspaper option is not rendered");
  expect(newspaper.querySelector("[style*='board/newspaper.svg']")).not.toBeNull();
  expect(newspaper.textContent).toContain("newspaper");
});

test("hovering a board previews it, choosing commits, and Escape restores", async () => {
  restoreScrollIntoView = stubScrollIntoView();
  await renderBoard(
    <SettingRow title="Board Image" description="d">
      <BoardSelect />
    </SettingRow>,
  );

  expect(selectInput().value).toBe("chessriddle");

  await act(async () => selectInput().click());
  await hoverSelectOption("newspaper");
  expect(selectInput().value).toBe("newspaper");

  await act(async () => {
    selectInput().dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }),
    );
  });
  expect(selectInput().value).toBe("chessriddle");

  await chooseSelectOption(selectInput(), "newspaper.svg");
  expect(selectInput().value).toBe("newspaper");
});
