import { MantineProvider } from "@mantine/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { installMatchMediaStub } from "@/tests/matchMedia";

const { nativeWindow, notifyUnlessCancelled } = vi.hoisted(() => ({
  nativeWindow: {
    isMaximized: vi.fn<() => Promise<boolean>>(),
    isFullscreen: vi.fn<() => Promise<boolean>>(),
    onResized: vi.fn<(handler: () => void) => Promise<() => void>>(),
    startResizeDragging: vi.fn<(direction: string) => Promise<void>>(),
  },
  notifyUnlessCancelled: vi.fn(),
}));

vi.mock("@/platform/native", () => ({ getCurrentWebviewWindow: () => nativeWindow }));
vi.mock("@/components/files/notifyError", () => ({ notifyUnlessCancelled }));
vi.mock("react-i18next", () => {
  const t = (key: string) => key;
  return { useTranslation: () => ({ t }) };
});

import { WindowResizeHandles } from "./WindowResizeHandles";

let root: Root;
let host: HTMLDivElement;
let resized: () => void;

const handle = (direction: string) =>
  host.querySelector<HTMLElement>(`[data-resize-direction="${direction}"]`);

const press = async (element: HTMLElement | null, button = 0) => {
  await act(async () => {
    element?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button }));
  });
};

const render = async () => {
  await act(async () => {
    root.render(
      <MantineProvider>
        <WindowResizeHandles />
      </MantineProvider>,
    );
  });
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  installMatchMediaStub({ matches: () => false });
  nativeWindow.isMaximized.mockResolvedValue(false);
  nativeWindow.isFullscreen.mockResolvedValue(false);
  nativeWindow.startResizeDragging.mockResolvedValue(undefined);
  nativeWindow.onResized.mockImplementation(async (handler) => {
    resized = handler;
    return () => undefined;
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

test.each(["North", "East", "South", "West", "NorthEast", "SouthEast", "SouthWest", "NorthWest"])(
  "a primary press on the %s zone starts that native resize",
  async (direction) => {
    await render();
    await press(handle(direction));
    expect(nativeWindow.startResizeDragging.mock.calls).toEqual([[direction]]);
  },
);

test("a non-primary press does not start a resize", async () => {
  await render();
  await press(handle("East"), 2);
  expect(nativeWindow.startResizeDragging).not.toHaveBeenCalled();
});

test("a refused resize is reported", async () => {
  const failure = new Error("refused");
  nativeWindow.startResizeDragging.mockRejectedValue(failure);
  await render();
  await press(handle("South"));
  expect(notifyUnlessCancelled).toHaveBeenCalledWith("Common.Error", failure);
});

test.each([
  ["maximized", nativeWindow.isMaximized],
  ["fullscreen", nativeWindow.isFullscreen],
])("the zones are removed while %s and return afterwards", async (_state, query) => {
  await render();
  expect(handle("North")).not.toBeNull();

  query.mockResolvedValue(true);
  await act(async () => resized());
  expect(handle("North")).toBeNull();

  query.mockResolvedValue(false);
  await act(async () => resized());
  expect(handle("North")).not.toBeNull();
});
