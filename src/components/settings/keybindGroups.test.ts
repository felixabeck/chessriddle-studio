import { expect, test, vi } from "vitest";

vi.mock("@/platform/native", () => ({
    platform: () => "linux",
    warn: vi.fn(),
    error: vi.fn(),
}));

import { KEYBIND_ACTION_IDS } from "@/state/keybinds";
import { groupedKeybindActions, KEYBIND_GROUPS } from "./keybindGroups";

test("every default keymap action is in exactly one keybind group and no group names an unknown action", () => {
    const seen = new Map<string, string>();
    const unknown: string[] = [];
    const duplicates: string[] = [];

    for (const group of KEYBIND_GROUPS) {
        for (const action of group.actions) {
            if (!(KEYBIND_ACTION_IDS as readonly string[]).includes(action)) {
                unknown.push(`${group.id}:${action}`);
            }
            const previous = seen.get(action);
            if (previous) duplicates.push(`${action} in ${previous} and ${group.id}`);
            else seen.set(action, group.id);
        }
    }

    const missing = KEYBIND_ACTION_IDS.filter((action) => !seen.has(action));
    expect({ unknown, duplicates, missing }).toEqual({ unknown: [], duplicates: [], missing: [] });
    expect(seen.size).toBe(KEYBIND_ACTION_IDS.length);
});

test("groupedKeybindActions hides COACH_TAB when the Coach is disabled and keeps extra persisted actions", () => {
    const keyMap = Object.fromEntries(KEYBIND_ACTION_IDS.map((action) => [action, true]));
    keyMap.LEGACY_CUSTOM = true;

    const withCoach = groupedKeybindActions(keyMap, true);
    expect(withCoach.groups.find((group) => group.id === "panels")?.actions).toContain("COACH_TAB");
    expect(withCoach.extraActions).toEqual(["LEGACY_CUSTOM"]);

    const withoutCoach = groupedKeybindActions(keyMap, false);
    expect(withoutCoach.groups.find((group) => group.id === "panels")?.actions).not.toContain(
        "COACH_TAB",
    );
    expect(withoutCoach.extraActions).toEqual(["LEGACY_CUSTOM"]);
});
