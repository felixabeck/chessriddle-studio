import { DEFAULT_THEME, MantineProvider, mergeMantineTheme } from "@mantine/core";
import { atom, createStore, Provider } from "jotai";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { installResizeObserverStub } from "@/tests/resizeObserver";
import { createAppTheme } from "@/styles/theme";
import { SettingRow } from "./SettingsLayout";
import SettingsSwitch from "./SettingsSwitch";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
installMatchMediaStub();
installResizeObserverStub();

const theme = mergeMantineTheme(DEFAULT_THEME, createAppTheme({ spellCheck: true, fontSize: 100 }));

let root: Root | undefined;
let host: HTMLDivElement | undefined;

afterEach(() => {
  if (root) act(() => root?.unmount());
  host?.remove();
  window.getSelection()?.removeAllRanges();
  root = undefined;
  host = undefined;
});

async function render(node: ReactNode) {
  const store = createStore();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root!.render(
      <Provider store={store}>
        <MantineProvider theme={theme}>{node}</MantineProvider>
      </Provider>,
    ),
  );
  return store;
}

function click(element: Element) {
  act(() => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

function row() {
  const element = host!.querySelector("[data-setting-id]");
  if (!element) throw new Error("SettingRow is not rendered");
  return element;
}

function byText(text: string) {
  const element = [...host!.querySelectorAll("p")].find((node) => node.textContent === text);
  if (!element) throw new Error(`text ${text} is not rendered`);
  return element;
}

test("clicking a switch row's title or description flips the switch", async () => {
  const flag = atom(false);
  const store = await render(
    <SettingRow id="flag" title="Auto Promotion" description="Promote to a queen">
      <SettingsSwitch atom={flag} />
    </SettingRow>,
  );

  expect(row().hasAttribute("data-toggle-row")).toBe(true);
  click(byText("Auto Promotion"));
  expect(store.get(flag)).toBe(true);
  click(byText("Promote to a queen"));
  expect(store.get(flag)).toBe(false);
  click(row());
  expect(store.get(flag)).toBe(true);
});

test("clicking the switch itself flips it exactly once", async () => {
  const flag = atom(false);
  const store = await render(
    <SettingRow id="flag" title="Arrows" description="Show arrows">
      <SettingsSwitch atom={flag} />
    </SettingRow>,
  );

  click(host!.querySelector("input")!);
  expect(store.get(flag)).toBe(true);
});

test("a text selection in the row does not flip the switch", async () => {
  const flag = atom(false);
  const store = await render(
    <SettingRow id="flag" title="Arrows" description="Show best move arrows">
      <SettingsSwitch atom={flag} />
    </SettingRow>,
  );

  const description = byText("Show best move arrows");
  const range = document.createRange();
  range.selectNodeContents(description);
  window.getSelection()!.addRange(range);
  click(description);
  expect(store.get(flag)).toBe(false);
});

test("a row with any other control is not clickable", async () => {
  await render(
    <SettingRow id="other" title="Opacity" description="How strongly">
      <input type="checkbox" aria-label="plain checkbox" />
    </SettingRow>,
  );

  expect(row().hasAttribute("data-toggle-row")).toBe(false);
  click(byText("Opacity"));
  click(row());
  expect(host!.querySelector<HTMLInputElement>("input")!.checked).toBe(false);
});
