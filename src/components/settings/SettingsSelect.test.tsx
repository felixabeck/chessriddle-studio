import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test } from "vitest";
import { DEFAULT_THEME, MantineProvider, mergeMantineTheme } from "@mantine/core";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { installResizeObserverStub } from "@/tests/resizeObserver";
import { createAppTheme } from "@/styles/theme";
import { SettingRow } from "./SettingsLayout";
import SettingsSelect from "./SettingsSelect";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
installMatchMediaStub();
installResizeObserverStub();

const theme = mergeMantineTheme(DEFAULT_THEME, createAppTheme({ spellCheck: true, fontSize: 100 }));

const data = [
  { value: "letters", label: "Letters" },
  { value: "symbols", label: "Symbols" },
];

let root: Root | undefined;
let host: HTMLDivElement | undefined;

afterEach(() => {
  if (root) act(() => root?.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
});

async function renderSelect(node: ReactNode) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<MantineProvider theme={theme}>{node}</MantineProvider>));
}

function selectInput() {
  const input = host!.querySelector<HTMLInputElement>("input");
  if (!input) throw new Error("SettingsSelect input is not rendered");
  return input;
}

test("inherits the SettingRow title as its accessible name", async () => {
  await renderSelect(
    <SettingRow title="Move notation" description="d">
      <SettingsSelect data={data} value="letters" allowDeselect={false} />
    </SettingRow>,
  );

  expect(selectInput().getAttribute("aria-label")).toBe("Move notation");
});

test("an explicit aria-label wins over the SettingRow title", async () => {
  await renderSelect(
    <SettingRow title="Move notation" description="d">
      <SettingsSelect
        data={data}
        value="letters"
        allowDeselect={false}
        aria-label="Piece letters"
      />
    </SettingRow>,
  );

  expect(selectInput().getAttribute("aria-label")).toBe("Piece letters");
});
