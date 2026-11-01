import { expect, test, vi } from "vitest";
vi.mock("@/platform/native", () => ({ platform: () => "linux" }));
import { createKeybindStorage } from "./keybinds";
import { createStore } from "jotai";
import { keyMapAtom } from "./keybinds";

const defaults = {
    OPEN: { name: "Open", keys: "ctrl+o" },
    CLOSE: { name: "Close", keys: "ctrl+w" },
};

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
