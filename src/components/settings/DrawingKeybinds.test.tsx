import { MantineProvider } from "@mantine/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { platform } from "@/platform/native";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { DrawingKeybinds } from "./DrawingKeybinds";

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

function modifierKeycaps(color: string): string[] {
  const keycaps = [...host.querySelectorAll(`[data-testid="drawing-color-${color}"] kbd`)];
  return keycaps.slice(0, -1).map((kbd) => kbd.textContent ?? "");
}

test.each([
  { os: "macos", orange: ["⌘"], cyan: ["⌘", "⌥"], yellow: ["⇧", "⌥"] },
  { os: "linux", orange: ["ctrl"], cyan: ["ctrl", "alt"], yellow: ["shift", "alt"] },
] as const)("shows the drawing modifiers for $os", async ({ os, orange, cyan, yellow }) => {
  vi.mocked(platform).mockReturnValue(os);
  await act(async () => {
    root.render(
      <MantineProvider>
        <DrawingKeybinds />
      </MantineProvider>,
    );
  });
  expect(modifierKeycaps("green")).toEqual([]);
  expect(modifierKeycaps("orange")).toEqual(orange);
  expect(modifierKeycaps("cyan")).toEqual(cyan);
  expect(modifierKeycaps("yellow")).toEqual(yellow);
  expect(host.querySelectorAll("[data-testid^='drawing-color-']")).toHaveLength(6);
});
