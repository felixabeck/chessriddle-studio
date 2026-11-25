import { hoverSelectOption } from "@/tests/select";
import { act, type ReactNode, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test } from "vitest";
import { DEFAULT_THEME, MantineProvider, mergeMantineTheme } from "@mantine/core";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { installResizeObserverStub } from "@/tests/resizeObserver";
import { stubScrollIntoView } from "@/tests/scrollIntoView";
import { createAppTheme } from "@/styles/theme";
import { SettingRow } from "./SettingsLayout";
import SettingsSelect from "./SettingsSelect";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
installMatchMediaStub();
installResizeObserverStub();

const theme = mergeMantineTheme(DEFAULT_THEME, createAppTheme({ spellCheck: true, fontSize: 100 }));

const notation = [
  { value: "letters", label: "Letters" },
  { value: "symbols", label: "Symbols" },
];

const pieces = [
  { value: "staunty", label: "Staunty" },
  { value: "merida", label: "Merida" },
  { value: "alpha", label: "Alpha" },
];

// Mirrors PiecesSelect: value, onPreview and onChange all feed the same persisted atom.
function PreviewHarness() {
  const [value, setValue] = useState("staunty");
  return (
    <div>
      <span data-testid="value">{value}</span>
      <SettingRow title="Pieces" description="d">
        <SettingsSelect
          allowDeselect={false}
          data={pieces}
          value={value}
          onPreview={setValue}
          onChange={(next) => {
            if (next != null) setValue(next);
          }}
        />
      </SettingRow>
      <button type="button" data-testid="external" onClick={() => setValue("alpha")}>
        external
      </button>
      <div data-testid="outside">outside</div>
    </div>
  );
}

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

async function renderSelect(node: ReactNode) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<MantineProvider theme={theme}>{node}</MantineProvider>));
}

function selectInput() {
  const input = host!.querySelector<HTMLInputElement>("input.mantine-Select-input");
  if (!input) throw new Error("SettingsSelect input is not rendered");
  return input;
}

const currentValue = () => host!.querySelector("[data-testid=value]")!.textContent;

async function open() {
  restoreScrollIntoView ??= stubScrollIntoView();
  await act(async () => selectInput().click());
}

function option(label: string) {
  const found = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((item) =>
    item.textContent?.includes(label),
  );
  if (!found) throw new Error(`option ${label} is not rendered`);
  return found;
}

async function pressEscape() {
  await act(async () => {
    selectInput().dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }),
    );
  });
}

async function clickOutside() {
  await act(async () => {
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  });
}

test("inherits the SettingRow title as its accessible name", async () => {
  await renderSelect(
    <SettingRow title="Move notation" description="d">
      <SettingsSelect data={notation} value="letters" allowDeselect={false} />
    </SettingRow>,
  );

  expect(selectInput().getAttribute("aria-label")).toBe("Move notation");
});

test("an explicit aria-label wins over the SettingRow title", async () => {
  await renderSelect(
    <SettingRow title="Move notation" description="d">
      <SettingsSelect
        data={notation}
        value="letters"
        allowDeselect={false}
        aria-label="Piece letters"
      />
    </SettingRow>,
  );

  expect(selectInput().getAttribute("aria-label")).toBe("Piece letters");
});

test("names the input by its field and shows the selected label as its value", async () => {
  await renderSelect(<PreviewHarness />);

  expect(selectInput().getAttribute("aria-label")).toBe("Pieces");
  expect(selectInput().value).toBe("Staunty");

  await open();
  await hoverSelectOption("Merida");
  await act(async () => option("Merida").click());

  expect(selectInput().getAttribute("aria-label")).toBe("Pieces");
  expect(selectInput().value).toBe("Merida");
});

test("previews a hovered option and restores the committed value on Escape", async () => {
  await renderSelect(<PreviewHarness />);
  await open();

  await hoverSelectOption("Merida");
  expect(currentValue()).toBe("merida");

  await pressEscape();
  expect(currentValue()).toBe("staunty");
});

test("restores the committed value on an outside click", async () => {
  await renderSelect(<PreviewHarness />);
  await open();

  await hoverSelectOption("Merida");
  expect(currentValue()).toBe("merida");

  await clickOutside();
  expect(currentValue()).toBe("staunty");
});

test("keeps the option that is clicked after previewing it", async () => {
  await renderSelect(<PreviewHarness />);
  await open();

  await hoverSelectOption("Merida");
  await act(async () => option("Merida").click());

  expect(currentValue()).toBe("merida");
});

test("restores to the option last committed, not to the value before opening", async () => {
  await renderSelect(<PreviewHarness />);
  await open();
  await hoverSelectOption("Merida");
  await act(async () => option("Merida").click());
  expect(currentValue()).toBe("merida");

  await open();
  await hoverSelectOption("Alpha");
  expect(currentValue()).toBe("alpha");

  await pressEscape();
  expect(currentValue()).toBe("merida");
});

test("restores a value changed from outside while the dropdown was closed", async () => {
  await renderSelect(<PreviewHarness />);
  await act(async () => host!.querySelector<HTMLElement>("[data-testid=external]")!.click());
  expect(currentValue()).toBe("alpha");

  await open();
  await hoverSelectOption("Merida");
  expect(currentValue()).toBe("merida");

  await pressEscape();
  expect(currentValue()).toBe("alpha");
});
