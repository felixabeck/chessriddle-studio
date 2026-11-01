import { MantineProvider } from "@mantine/core";
import { Provider, createStore } from "jotai";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { platform } from "@/platform/native";
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
