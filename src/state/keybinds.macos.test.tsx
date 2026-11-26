import { act } from "react";
import { createRoot } from "react-dom/client";
import { useHotkeys } from "react-hotkeys-hook";
import { expect, test, vi } from "vitest";
vi.mock("@/platform/native", () => ({ platform: () => "macos" }));
vi.mock("@/components/files/notifyError", () => ({ notifyListenerError: vi.fn() }));
import { createStore } from "jotai";
import {
  createKeybindStorage,
  firedByNativeMenu,
  keyMapAtom,
  nativeMenuAccelerator,
} from "./keybinds";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function Listener({ keys, onFire }: { keys: string; onFire: () => void }) {
  useHotkeys(keys, onFire);
  return null;
}

test("macOS Command defaults are stored as meta and fire on a Command press", () => {
  localStorage.removeItem("keybinds");
  const map = createStore().get(keyMapAtom);
  expect(map.UNDO.keys).toBe("meta+z");
  expect(map.PROMOTE_VARIATION.keys).toBe("meta+arrowup");
  expect(map.DELETE_VARIATION.keys).toBe("meta+delete");

  const onFire = vi.fn();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(<Listener keys={map.PROMOTE_VARIATION.keys} onFire={onFire} />));
  for (const type of ["keydown", "keyup"] as const)
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent(type, {
          key: "ArrowUp",
          code: "ArrowUp",
          metaKey: type === "keydown",
          bubbles: true,
        }),
      );
    });
  act(() => root.unmount());
  host.remove();

  expect(onFire).toHaveBeenCalledOnce();
});

test("stored macOS cmd bindings are repaired to meta and written back", () => {
  sessionStorage.clear();
  const defaults = { UNDO: { name: "Undo", keys: "meta+z" } };
  const storage = createKeybindStorage(defaults, sessionStorage);
  sessionStorage.setItem(
    "keybinds",
    JSON.stringify({ UNDO: { name: "Undo", keys: "cmd+shift+u" } }),
  );

  expect(storage.getItem("keybinds", defaults).UNDO.keys).toBe("meta+shift+u");
  expect(JSON.parse(sessionStorage.getItem("keybinds")!).UNDO.keys).toBe("meta+shift+u");
});

test("native menu accelerators name the Command key cmd", () => {
  expect(nativeMenuAccelerator("meta+t")).toBe("cmd+t");
  expect(nativeMenuAccelerator("cmd+,")).toBe("cmd+,");
  expect(nativeMenuAccelerator("ctrl+shift+tab")).toBe("ctrl+shift+tab");
});

test("only the shortcuts the native macOS menu carries are left to it", () => {
  expect(
    ["NEW_TAB", "NEW_ANALYSIS", "OPEN_FILE", "SAVE_FILE", "TOGGLE_FOCUS_MODE"].every((id) =>
      firedByNativeMenu(id as never),
    ),
  ).toBe(true);
  expect(firedByNativeMenu("UNDO")).toBe(false);
  expect(firedByNativeMenu("PROMOTE_VARIATION")).toBe(false);
  expect(firedByNativeMenu("APPLY_LAYOUT_1")).toBe(false);
  expect(firedByNativeMenu("APPLY_LAYOUT_2")).toBe(false);
  expect(firedByNativeMenu("APPLY_LAYOUT_3")).toBe(false);
});

test("Apply layout 1/2/3 defaults use meta+alt on macOS", () => {
  localStorage.removeItem("keybinds");
  const map = createStore().get(keyMapAtom);
  expect(map.APPLY_LAYOUT_1.keys).toBe("meta+alt+1");
  expect(map.APPLY_LAYOUT_2.keys).toBe("meta+alt+2");
  expect(map.APPLY_LAYOUT_3.keys).toBe("meta+alt+3");
});
