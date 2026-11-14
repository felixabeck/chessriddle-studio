import { platform } from "@/platform/native";
import { notifyListenerError } from "@/components/files/notifyError";
import { atomWithStorage } from "jotai/utils";
import type { SyncStorage, SyncStringStorage } from "jotai/vanilla/utils/atomWithStorage";
import { z } from "zod";

const meta = platform() === "macos" ? "cmd" : "ctrl";

type Keybind = {
    name: string;
    keys: string;
};

type KeyMap = { [key: string]: Keybind };

const keys: KeyMap = {
    NEW_TAB: { name: "New tab", keys: `${meta}+t` },
    CLOSE_TAB: { name: "Close tab", keys: `${meta}+w` },
    OPEN_FILE: { name: "Open File", keys: `${meta}+o` },
    SAVE_FILE: { name: "Save File", keys: `${meta}+s` },
    COPY_PGN: { name: "Copy PGN", keys: `${meta}+k` },
    SWAP_ORIENTATION: { name: "Swap orientation", keys: "f" },
    CLEAR_SHAPES: { name: "Clear shapes", keys: "ctrl+l" },
    NEXT_MOVE: { name: "Next move", keys: "arrowright" },
    PREVIOUS_MOVE: { name: "Previous move", keys: "arrowleft" },
    GO_TO_BRANCH_START: { name: "Go to start of branch", keys: "arrowup" },
    GO_TO_BRANCH_END: { name: "Go to end of branch", keys: "arrowdown" },
    GO_TO_START: { name: "Go to start of game", keys: "shift+arrowup" },
    GO_TO_END: { name: "Go to end of game", keys: "shift+arrowdown" },
    NEXT_BRANCH: { name: "Next branch", keys: "c" },
    PREVIOUS_BRANCH: { name: "Previous branch", keys: "shift+c" },
    PLAY_BEST_ENGINE_MOVE: { name: "Play best engine move", keys: "space" },
    TOGGLE_THREAT_MODE: { name: "Toggle threat mode", keys: "x" },
    NEXT_BRANCHING: { name: "Next branching point", keys: "shift+arrowright" },
    PREVIOUS_BRANCHING: {
        name: "Previous branching point",
        keys: "shift+arrowleft",
    },
    DELETE_MOVE: { name: "Delete move", keys: "delete" },
    CYCLE_TABS: { name: "Cycle tabs", keys: "ctrl+tab" },
    REVERSE_CYCLE_TABS: { name: "Reverse cycle tabs", keys: "ctrl+shift+tab" },
    TOGGLE_EVAL_BAR: { name: "Toggle Eval Bar and Arrows", keys: "z" },
    PRACTICE_TAB: { name: "Go to practice tab", keys: "p" },
    ANALYSIS_TAB: { name: "Go to analysis tab", keys: "a" },
    DATABASE_TAB: { name: "Go to database tab", keys: "b" },
    ANNOTATE_TAB: { name: "Go to annotate tab", keys: "d" },
    ANNOTATION_NEXT_MOVE: { name: "Annotation editor: next move", keys: "tab" },
    ANNOTATION_PREVIOUS_MOVE: { name: "Annotation editor: previous move", keys: "shift+tab" },
    INFO_TAB: { name: "Go to info tab", keys: "i" },
    ANNOTATION_BRILLIANT: { name: "Toggle brilliant move annotation", keys: "1" },
    ANNOTATION_GOOD: { name: "Toggle good move annotation", keys: "2" },
    ANNOTATION_INTERESTING: {
        name: "Toggle interesting move annotation",
        keys: "3",
    },
    ANNOTATION_DUBIOUS: { name: "Toggle dubious move annotation", keys: "4" },
    ANNOTATION_MISTAKE: { name: "Toggle mistake move annotation", keys: "5" },
    ANNOTATION_BLUNDER: { name: "Toggle blunder move annotation", keys: "6" },
    TOGGLE_ALL_ENGINES: { name: "Toggle all engines", keys: "ctrl+a" },
    TOGGLE_BLUR: { name: "Toggle blur", keys: "ctrl+b" },
    GENERATE_REPORT: { name: "Generate game report", keys: "f12" },
    PREVIOUS_GAME: { name: "Previous game", keys: "pageup" },
    NEXT_GAME: { name: "Next game", keys: "pagedown" },
};

export const keyMapAtom = atomWithStorage(
    "keybinds",
    keys,
    createKeybindStorage(keys, localStorage),
);

export function createKeybindStorage(
    defaults: KeyMap,
    storage: SyncStringStorage,
): SyncStorage<KeyMap> {
    const keybindSchema = z.object({ name: z.string(), keys: z.string().min(1) });
    const keyMapSchema = z.record(keybindSchema);
    const repair = (value: unknown): KeyMap => {
        const parsed = keyMapSchema.safeParse(value);
        const persisted = parsed.success ? parsed.data : {};
        if (
            !persisted.TOGGLE_THREAT_MODE &&
            persisted.PREVIOUS_BRANCH?.keys === "x" &&
            defaults.TOGGLE_THREAT_MODE &&
            defaults.PREVIOUS_BRANCH
        ) {
            persisted.PREVIOUS_BRANCH = { ...defaults.PREVIOUS_BRANCH };
        }
        return Object.fromEntries(
            Object.entries(defaults).map(([id, fallback]) => [
                id,
                persisted[id] ? { ...fallback, ...persisted[id] } : { ...fallback },
            ]),
        );
    };

    return {
        getItem(key, initialValue) {
            let storedValue: string | null;
            try {
                storedValue = storage.getItem(key);
            } catch (error) {
                notifyListenerError(error);
                return initialValue;
            }
            if (storedValue === null) {
                return initialValue;
            }
            let repaired: KeyMap;
            try {
                repaired = repair(JSON.parse(storedValue));
            } catch {
                repaired = initialValue;
            }
            if (JSON.stringify(repaired) !== storedValue) this.setItem(key, repaired);
            return repaired;
        },
        setItem(key, value) {
            const normalized = Object.fromEntries(
                Object.entries(repair(value)).map(([id, binding]) => [
                    id,
                    { ...binding, keys: binding.keys.replace("meta", meta) },
                ]),
            );
            try {
                storage.setItem(key, JSON.stringify(normalized));
            } catch (error) {
                notifyListenerError(error);
            }
        },
        removeItem(key) {
            storage.removeItem(key);
        },
    };
}
