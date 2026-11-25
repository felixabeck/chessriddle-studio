import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { DEFAULT_THEME, MantineProvider, mergeMantineTheme } from "@mantine/core";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { installResizeObserverStub } from "@/tests/resizeObserver";
import { createAppTheme } from "@/styles/theme";
import { stubScrollIntoView } from "@/tests/scrollIntoView";
import { chooseSelectOption, hoverSelectOption } from "@/tests/select";
import { SettingRow } from "./SettingsLayout";
import PiecesSelect from "./PiecesSelect";

vi.mock("jotai", async () => {
  const { useState: useReactState } = await import("react");
  return {
    useAtom: () => {
      const [value, setValue] = useReactState("staunty");
      return [value, setValue];
    },
  };
});
vi.mock("@/state/atoms", () => ({ pieceSetAtom: {} }));

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

async function renderPieces(node: ReactNode) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<MantineProvider theme={theme}>{node}</MantineProvider>));
}

function selectInput() {
  const input = host!.querySelector<HTMLInputElement>("input.mantine-Select-input");
  if (!input) throw new Error("PiecesSelect input is not rendered");
  return input;
}

test("inherits Piece Set from SettingRow and shows the selected set as its value", async () => {
  await renderPieces(
    <SettingRow title="Piece Set" description="d">
      <PiecesSelect />
    </SettingRow>,
  );

  expect(selectInput().getAttribute("aria-label")).toBe("Piece Set");
  expect(selectInput().value).toBe("Staunty");
  expect(host!.querySelector(".white.rook")).not.toBeNull();
});

test("hovering a piece set previews it, choosing commits, and Escape restores", async () => {
  restoreScrollIntoView = stubScrollIntoView();
  await renderPieces(
    <SettingRow title="Piece Set" description="d">
      <PiecesSelect />
    </SettingRow>,
  );

  expect(selectInput().value).toBe("Staunty");

  await act(async () => selectInput().click());
  await hoverSelectOption("Merida");
  expect(selectInput().value).toBe("Merida");

  await act(async () => {
    selectInput().dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }),
    );
  });
  expect(selectInput().value).toBe("Staunty");

  await chooseSelectOption(selectInput(), "merida");
  expect(selectInput().value).toBe("Merida");
});
