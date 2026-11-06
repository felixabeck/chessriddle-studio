import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { DEFAULT_THEME, MantineProvider, mergeMantineTheme } from "@mantine/core";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { installResizeObserverStub } from "@/tests/resizeObserver";
import { createAppTheme } from "@/styles/theme";
import { SettingsCombobox } from "./SettingsCombobox";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
installMatchMediaStub();
installResizeObserverStub();

const theme = mergeMantineTheme(DEFAULT_THEME, createAppTheme({ spellCheck: true, fontSize: 100 }));

const data = [
  { value: "staunty", label: "Staunty" },
  { value: "merida", label: "Merida" },
  { value: "alpha", label: "Alpha" },
];

// Mirrors PiecesSelect: value, onPreview and onCommit all feed the same persisted atom.
function Harness() {
  const [value, setValue] = useState("staunty");
  return (
    <div>
      <span data-testid="value">{value}</span>
      <SettingsCombobox
        value={value}
        data={data}
        onPreview={setValue}
        onCommit={setValue}
        ariaLabel="Pieces"
      />
      <button type="button" data-testid="external" onClick={() => setValue("alpha")}>
        external
      </button>
      <div data-testid="outside">outside</div>
    </div>
  );
}

let root: Root | undefined;
let host: HTMLDivElement | undefined;

afterEach(() => {
  if (root) act(() => root?.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
});

async function renderHarness() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root!.render(
      <MantineProvider theme={theme}>
        <Harness />
      </MantineProvider>,
    ),
  );
}

const currentValue = () => host!.querySelector("[data-testid=value]")!.textContent;

async function open() {
  await act(async () => host!.querySelector<HTMLElement>('button[aria-label="Pieces"]')!.click());
}

function option(label: string) {
  const found = [...host!.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (item) => item.textContent === label,
  );
  if (!found) throw new Error(`option ${label} is not rendered`);
  return found;
}

// React derives onMouseEnter from mouseover/mouseout, so dispatch a bubbling mouseover.
async function hover(label: string) {
  await act(async () => {
    option(label).dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  });
}

async function pressEscape() {
  await act(async () => {
    host!
      .querySelector('button[aria-label="Pieces"]')!
      .dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }),
      );
  });
}

async function clickOutside() {
  await act(async () => {
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  });
}

test("previews a hovered option and restores the committed value on Escape", async () => {
  await renderHarness();
  await open();

  await hover("Merida");
  expect(currentValue()).toBe("merida");

  await pressEscape();
  expect(currentValue()).toBe("staunty");
});

test("restores the committed value on an outside click", async () => {
  await renderHarness();
  await open();

  await hover("Merida");
  expect(currentValue()).toBe("merida");

  await clickOutside();
  expect(currentValue()).toBe("staunty");
});

test("keeps the option that is clicked after previewing it", async () => {
  await renderHarness();
  await open();

  await hover("Merida");
  await act(async () => option("Merida").click());

  expect(currentValue()).toBe("merida");
});

test("restores to the option last committed, not to the value before opening", async () => {
  await renderHarness();
  await open();
  await hover("Merida");
  await act(async () => option("Merida").click());
  expect(currentValue()).toBe("merida");

  await open();
  await hover("Alpha");
  expect(currentValue()).toBe("alpha");

  await pressEscape();
  expect(currentValue()).toBe("merida");
});

test("restores a value changed from outside while the dropdown was closed", async () => {
  await renderHarness();
  await act(async () => host!.querySelector<HTMLElement>("[data-testid=external]")!.click());
  expect(currentValue()).toBe("alpha");

  await open();
  await hover("Merida");
  expect(currentValue()).toBe("merida");

  await pressEscape();
  expect(currentValue()).toBe("alpha");
});
