import { expect, test, vi } from "vitest";
vi.mock("@/platform/native", () => ({ platform: () => "linux" }));
vi.mock("@/components/files/notifyError", () => ({ notifyListenerError: vi.fn() }));
import { notifyListenerError } from "@/components/files/notifyError";
import { createKeybindStorage } from "./keybinds";
import { createStore } from "jotai";
import { keyMapAtom } from "./keybinds";

const defaults = {
    OPEN: { name: "Open", keys: "ctrl+o" },
    CLOSE: { name: "Close", keys: "ctrl+w" },
};

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
