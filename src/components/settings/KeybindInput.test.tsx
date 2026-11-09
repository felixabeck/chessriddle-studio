import { MantineProvider } from "@mantine/core";
import { Provider, createStore } from "jotai";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { platform } from "@/platform/native";
import { keyMapAtom } from "@/state/keybinds";
import { installMatchMediaStub } from "@/tests/matchMedia";
import KeybindInput from "./KeybindInput";

vi.mock("@/platform/native", () => ({ platform: vi.fn(() => "linux") }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  installMatchMediaStub();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

test.each([
  { os: "macos", expected: ["⌘", "⇧", "k"] },
  { os: "linux", expected: ["ctrl", "shift", "k"] },
] as const)("renders formatted keycaps in the settings button on $os", async ({ os, expected }) => {
  vi.mocked(platform).mockReturnValue(os);
  await act(async () => {
    root.render(
      <MantineProvider>
        <Provider store={createStore()}>
          <KeybindInput action="COPY_PGN" keybind={{ name: "Copy PGN", keys: "meta+shift+k" }} />
        </Provider>
      </MantineProvider>,
    );
  });

  const button = host.querySelector<HTMLButtonElement>('button[aria-label="Copy PGN"]');
  expect(button).not.toBeNull();
  expect([...button!.querySelectorAll("kbd")].map((keycap) => keycap.textContent)).toEqual(
    expected,
  );
});

test("Escape cancels shortcut recording without changing the stored keybind", async () => {
  const store = createStore();
  await act(async () => {
    root.render(
      <MantineProvider>
        <Provider store={store}>
          <KeybindInput action="COPY_PGN" keybind={store.get(keyMapAtom).COPY_PGN} />
        </Provider>
      </MantineProvider>,
    );
  });
  const original = { ...store.get(keyMapAtom).COPY_PGN };
  const shortcutSelector = `button[aria-label="${original.name}"]`;

  await act(async () => {
    host.querySelector<HTMLButtonElement>(shortcutSelector)!.click();
  });
  expect(host.querySelector('button[aria-label="Common.Cancel"]')).not.toBeNull();
  expect(host.querySelector('button[aria-label="Common.Save"]')).not.toBeNull();
  expect(host.querySelector("kbd")?.textContent).toBe("Settings.Keybinds.PressAnyKey");

  await act(async () => {
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }),
    );
  });

  expect(host.querySelector(shortcutSelector)).not.toBeNull();
  expect(host.querySelector('button[aria-label="Common.Cancel"]')).toBeNull();
  expect(host.querySelector('button[aria-label="Common.Save"]')).toBeNull();
  expect(
    [...host.querySelectorAll("kbd")].some((keycap) =>
      /^esc(?:ape)?$/i.test(keycap.textContent ?? ""),
    ),
  ).toBe(false);
  expect(store.get(keyMapAtom).COPY_PGN).toEqual(original);
});

test("non-Escape keys are still recorded", async () => {
  const store = createStore();
  const keybind = store.get(keyMapAtom).COPY_PGN;
  await act(async () => {
    root.render(
      <MantineProvider>
        <Provider store={store}>
          <KeybindInput action="COPY_PGN" keybind={keybind} />
        </Provider>
      </MantineProvider>,
    );
  });

  await act(async () => {
    host.querySelector<HTMLButtonElement>(`button[aria-label="${keybind.name}"]`)!.click();
  });
  expect(host.querySelector("kbd")?.textContent).toBe("Settings.Keybinds.PressAnyKey");

  await act(async () => {
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { key: "k", code: "KeyK", bubbles: true }),
    );
  });

  expect([...host.querySelectorAll("kbd")].map((keycap) => keycap.textContent)).toEqual(["k"]);
  expect(host.querySelector('button[aria-label="Common.Cancel"]')).not.toBeNull();
  expect(host.querySelector<HTMLButtonElement>('button[aria-label="Common.Save"]')?.disabled).toBe(
    false,
  );
});

test("unmounting while recording releases the keyboard", async () => {
  const store = createStore();
  const keybind = store.get(keyMapAtom).COPY_PGN;
  await act(async () => {
    root.render(
      <MantineProvider>
        <Provider store={store}>
          <KeybindInput action="COPY_PGN" keybind={keybind} />
        </Provider>
      </MantineProvider>,
    );
  });

  await act(async () => {
    host.querySelector<HTMLButtonElement>(`button[aria-label="${keybind.name}"]`)!.click();
  });
  expect(host.querySelector("kbd")?.textContent).toBe("Settings.Keybinds.PressAnyKey");

  await act(async () => root.unmount());

  const event = new KeyboardEvent("keydown", {
    key: "a",
    code: "KeyA",
    bubbles: true,
    cancelable: true,
  });
  document.body.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(false);
});
