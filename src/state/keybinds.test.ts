import { expect, test, vi } from "vitest";
vi.mock("@/platform/native", () => ({ platform: () => "linux" }));
vi.mock("@/components/files/notifyError", () => ({ notifyListenerError: vi.fn() }));
import { notifyListenerError } from "@/components/files/notifyError";
import { createKeybindStorage } from "./keybinds";
import { createStore } from "jotai";
import { firedByNativeMenu, hasCommandModifier, keybindLabel, keyMapAtom } from "./keybinds";
import type { TFunction } from "i18next";

const defaults = {
    OPEN: { name: "Open", keys: "ctrl+o" },
    CLOSE: { name: "Close", keys: "ctrl+w" },
};

test("shipped GO_TO_END and GO_TO_START defaults use arrow tokens", () => {
    localStorage.removeItem("keybinds");
    const map = createStore().get(keyMapAtom);
    expect(map.GO_TO_END.keys).toBe("shift+arrowdown");
    expect(map.GO_TO_START.keys).toBe("shift+arrowup");
});

test("shipped UNDO and REDO defaults are the platform modifier with z and shift+z", () => {
    localStorage.removeItem("keybinds");
    const map = createStore().get(keyMapAtom);
    expect(map.UNDO.keys).toBe("ctrl+z");
    expect(map.REDO.keys).toBe("ctrl+shift+z");
});

test("refused storage read reports the error and returns defaults without writing", () => {
    const refused = new DOMException("Storage unavailable", "SecurityError");
    const backing = {
        getItem: vi.fn(() => {
            throw refused;
        }),
        setItem: vi.fn(),
        removeItem: vi.fn(),
    };
    const storage = createKeybindStorage(defaults, backing);

    expect(storage.getItem("keybinds", defaults)).toBe(defaults);
    expect(backing.getItem).toHaveBeenCalledWith("keybinds");
    expect(backing.setItem).not.toHaveBeenCalled();
    expect(backing.removeItem).not.toHaveBeenCalled();
    expect(notifyListenerError).toHaveBeenCalledWith(refused);
});

test("keybind storage repairs malformed and stale records without throwing", () => {
    sessionStorage.clear();
    const storage = createKeybindStorage(defaults, sessionStorage);
    sessionStorage.setItem("keybinds", JSON.stringify({ OPEN: { name: "Wrong", keys: "" } }));

    expect(storage.getItem("keybinds", defaults)).toEqual(defaults);
    expect(JSON.parse(sessionStorage.getItem("keybinds")!)).toEqual(defaults);
});

test("older keymaps gain editor navigation defaults and preserve custom bindings", () => {
    const current = createStore().get(keyMapAtom);
    const { ANNOTATION_NEXT_MOVE: next, ANNOTATION_PREVIOUS_MOVE: previous, ...older } = current;
    older.NEXT_MOVE = { ...older.NEXT_MOVE, keys: "ctrl+n" };
    sessionStorage.setItem("keybinds", JSON.stringify(older));
    const repaired = createKeybindStorage(current, sessionStorage).getItem("keybinds", current);
    expect(repaired).toEqual({
        ...older,
        ANNOTATION_NEXT_MOVE: next,
        ANNOTATION_PREVIOUS_MOVE: previous,
    });
    expect(next).toEqual({ name: "Annotation editor: next move", keys: "tab" });
    expect(previous).toEqual({ name: "Annotation editor: previous move", keys: "shift+tab" });
});

test.each([
    ["x", false, "shift+c"],
    ["ctrl+p", false, "ctrl+p"],
    ["x", true, "x"],
] as const)("previous branch %s, migrated=%s hydrates as %s", (binding, migrated, expected) => {
    const current = createStore().get(keyMapAtom);
    const persisted: typeof current = {
        ...current,
        PREVIOUS_BRANCH: { name: "Previous branch", keys: binding },
    };
    if (!migrated) delete persisted.TOGGLE_THREAT_MODE;
    sessionStorage.setItem("keybinds", JSON.stringify(persisted));
    const storage = createKeybindStorage(current, sessionStorage);
    const repaired = storage.getItem("keybinds", current);
    expect(repaired.PREVIOUS_BRANCH.keys).toBe(expected);
    expect(repaired.PLAY_BEST_ENGINE_MOVE.keys).toBe("space");
    expect(repaired.TOGGLE_THREAT_MODE.keys).toBe("x");
    expect(storage.getItem("keybinds", current)).toEqual(repaired);
    expect(JSON.parse(sessionStorage.getItem("keybinds")!)).toEqual(repaired);
});

test.each(["repair", "migration", "invalid"])(
    "refused %s write preserves stored bytes and in-memory bindings",
    (kind) => {
        const current = createStore().get(keyMapAtom);
        const persisted: typeof current = {
            ...current,
            NEXT_MOVE: { name: "Next move", keys: "ctrl+n" },
        };
        if (kind === "repair") delete persisted.PLAY_BEST_ENGINE_MOVE;
        if (kind === "migration") {
            delete persisted.TOGGLE_THREAT_MODE;
            persisted.PREVIOUS_BRANCH = { name: "Previous branch", keys: "x" };
        }
        const bytes = kind === "invalid" ? "broken JSON" : JSON.stringify(persisted);
        const refused = new DOMException("Storage full", "QuotaExceededError");
        const backing = {
            getItem: () => bytes,
            setItem: vi.fn(() => {
                throw refused;
            }),
            removeItem: vi.fn(),
        };
        const storage = createKeybindStorage(current, backing);
        const repaired = storage.getItem("keybinds", current);
        expect(repaired.NEXT_MOVE.keys).toBe(
            kind === "invalid" ? current.NEXT_MOVE.keys : "ctrl+n",
        );
        expect(repaired.PREVIOUS_BRANCH.keys).toBe("shift+c");
        expect(backing.getItem()).toBe(bytes);
        expect(backing.setItem).toHaveBeenCalledOnce();
        expect(notifyListenerError).toHaveBeenCalledWith(refused);
    },
);

const translate = ((key: string) => `translated:${key}`) as unknown as TFunction;

test("a known action is labelled through its translation key", () => {
    expect(keybindLabel(translate, "NEW_TAB", { name: "New tab", keys: "ctrl+t" })).toBe(
        "translated:Settings.Keybinds.Actions.NEW_TAB",
    );
});

test.each(["NOT_A_SHIPPED_ACTION", "toString", "constructor", "__proto__", "hasOwnProperty"])(
    "unknown or prototype action id %s falls back to its stored name",
    (action) => {
        expect(keybindLabel(translate, action, { name: "Stored label", keys: "ctrl+k" })).toBe(
            "Stored label",
        );
    },
);

test("a keymap saved before the open-variation shortcut gains its default and keeps overrides", () => {
    const current = createStore().get(keyMapAtom);
    expect(current.NEXT_OPEN_VARIATION).toEqual({ name: "Next open variation", keys: "u" });
    const { NEXT_OPEN_VARIATION: added, ...older } = current;
    sessionStorage.setItem("keybinds", JSON.stringify(older));
    const storage = createKeybindStorage(current, sessionStorage);
    expect(storage.getItem("keybinds", current).NEXT_OPEN_VARIATION).toEqual(added);

    sessionStorage.setItem(
        "keybinds",
        JSON.stringify({ ...current, NEXT_OPEN_VARIATION: { ...added, keys: "ctrl+u" } }),
    );
    expect(storage.getItem("keybinds", current).NEXT_OPEN_VARIATION.keys).toBe("ctrl+u");
});

test("no other default shares the open-variation shortcut's key", () => {
    const current = createStore().get(keyMapAtom);
    const sharing = Object.entries(current)
        .filter(([, binding]) => binding.keys === current.NEXT_OPEN_VARIATION.keys)
        .map(([id]) => id);
    expect(sharing).toEqual(["NEXT_OPEN_VARIATION"]);
});

test("off macOS no shortcut is left to a native menu", () => {
    expect(firedByNativeMenu("NEW_TAB")).toBe(false);
    expect(firedByNativeMenu("SAVE_FILE")).toBe(false);
});

test("older keymaps gain edit-position, snapshot, and save-to-database defaults and preserve custom overrides", () => {
    const current = createStore().get(keyMapAtom);
    expect(current.EDIT_POSITION).toEqual({ name: "Edit position", keys: "e" });
    expect(current.TAKE_SNAPSHOT).toEqual({ name: "Take snapshot", keys: "ctrl+shift+s" });
    expect(current.SAVE_TO_DATABASE).toEqual({
        name: "Save to database",
        keys: "ctrl+shift+d",
    });

    const { EDIT_POSITION, TAKE_SNAPSHOT, SAVE_TO_DATABASE, ...older } = current;
    sessionStorage.setItem("keybinds", JSON.stringify(older));
    const storage = createKeybindStorage(current, sessionStorage);
    const hydrated = storage.getItem("keybinds", current);
    expect(hydrated.EDIT_POSITION).toEqual(EDIT_POSITION);
    expect(hydrated.TAKE_SNAPSHOT).toEqual(TAKE_SNAPSHOT);
    expect(hydrated.SAVE_TO_DATABASE).toEqual(SAVE_TO_DATABASE);

    sessionStorage.setItem(
        "keybinds",
        JSON.stringify({ ...current, EDIT_POSITION: { ...EDIT_POSITION, keys: "ctrl+e" } }),
    );
    expect(storage.getItem("keybinds", current).EDIT_POSITION.keys).toBe("ctrl+e");
});

test("edit-position, snapshot, and save-to-database defaults collide with no existing default", () => {
    const current = createStore().get(keyMapAtom);
    for (const id of ["EDIT_POSITION", "TAKE_SNAPSHOT", "SAVE_TO_DATABASE"] as const) {
        const sharing = Object.entries(current)
            .filter(([, binding]) => binding.keys === current[id].keys)
            .map(([actionId]) => actionId);
        expect(sharing).toEqual([id]);
    }
});

test("only a binding with Ctrl, Cmd or Alt counts as a command that may act while typing", () => {
    for (const keys of ["ctrl+shift+f", "meta+shift+f", "Ctrl+K", "alt+h", "mod+s", "cmd+q"]) {
        expect({ keys, command: hasCommandModifier(keys) }).toEqual({ keys, command: true });
    }
    for (const keys of ["h", "shift+h", "f11", "shift+arrowup", "space"]) {
        expect({ keys, command: hasCommandModifier(keys) }).toEqual({ keys, command: false });
    }
});

test("Apply layout 1/2/3 defaults are ctrl+alt+1..3, collision-free, and hydrated into older keymaps", () => {
    const current = createStore().get(keyMapAtom);
    expect(current.APPLY_LAYOUT_1).toEqual({ name: "Apply layout 1", keys: "ctrl+alt+1" });
    expect(current.APPLY_LAYOUT_2).toEqual({ name: "Apply layout 2", keys: "ctrl+alt+2" });
    expect(current.APPLY_LAYOUT_3).toEqual({ name: "Apply layout 3", keys: "ctrl+alt+3" });

    for (const id of ["APPLY_LAYOUT_1", "APPLY_LAYOUT_2", "APPLY_LAYOUT_3"] as const) {
        const sharing = Object.entries(current)
            .filter(([, binding]) => binding.keys === current[id].keys)
            .map(([actionId]) => actionId);
        expect(sharing).toEqual([id]);
    }

    const { APPLY_LAYOUT_1, APPLY_LAYOUT_2, APPLY_LAYOUT_3, ...older } = current;
    sessionStorage.setItem("keybinds", JSON.stringify(older));
    const storage = createKeybindStorage(current, sessionStorage);
    const hydrated = storage.getItem("keybinds", current);
    expect(hydrated.APPLY_LAYOUT_1).toEqual(APPLY_LAYOUT_1);
    expect(hydrated.APPLY_LAYOUT_2).toEqual(APPLY_LAYOUT_2);
    expect(hydrated.APPLY_LAYOUT_3).toEqual(APPLY_LAYOUT_3);
});

test("EDIT_GAME_DATA default is f2, collision-free, and hydrated into older keymaps", () => {
    const current = createStore().get(keyMapAtom);
    expect(current.EDIT_GAME_DATA).toEqual({ name: "Edit game data", keys: "f2" });

    const sharing = Object.entries(current)
        .filter(([, binding]) => binding.keys === current.EDIT_GAME_DATA.keys)
        .map(([actionId]) => actionId);
    expect(sharing).toEqual(["EDIT_GAME_DATA"]);

    const { EDIT_GAME_DATA, ...older } = current;
    sessionStorage.setItem("keybinds", JSON.stringify(older));
    const storage = createKeybindStorage(current, sessionStorage);
    expect(storage.getItem("keybinds", current).EDIT_GAME_DATA).toEqual(EDIT_GAME_DATA);
});
