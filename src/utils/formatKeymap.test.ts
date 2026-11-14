import { expect, test, vi } from "vitest";
import { platform } from "@/platform/native";
import { formatKeymap } from "./formatKeymap";

vi.mock("@/platform/native", () => ({ platform: vi.fn() }));

test.each([
    ["macos", "meta+ctrl+shift+alt+tab", "⌘+⌃+⇧+⌥+tab"],
    ["macos", "cmd+a", "⌘+a"],
    ["macos", "tab", "tab"],
    ["macos", "shift+tab", "⇧+tab"],
    ["linux", "meta+ctrl+shift+alt+tab", "ctrl+ctrl+shift+alt+tab"],
    ["linux", "cmd+a", "cmd+a"],
    ["linux", "tab", "tab"],
    ["linux", "shift+tab", "shift+tab"],
    ["linux", "", ""],
    ["linux", "arrowleft", "←"],
    ["linux", "arrowright", "→"],
    ["linux", "ctrl+ArrowUp", "ctrl+↑"],
    ["macos", "shift+arrowdown", "⇧+↓"],
    ["linux", "shift+down", "shift+↓"],
    ["macos", "shift+down", "⇧+↓"],
    ["linux", "left", "←"],
    ["linux", "ctrl+up", "ctrl+↑"],
    ["macos", "shift+right", "⇧+→"],
] as const)("formats %s keymap %s as %s", (os, keys, expected) => {
    vi.mocked(platform).mockReturnValue(os);
    expect(formatKeymap(keys)).toBe(expected);
});
