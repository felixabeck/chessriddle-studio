import { platform } from "@/platform/native";
import { notifyListenerError } from "@/components/files/notifyError";
import { i18nKey } from "@/utils/i18nKey";
import type { TFunction } from "i18next";
import { atomWithStorage } from "jotai/utils";
import type { SyncStorage, SyncStringStorage } from "jotai/vanilla/utils/atomWithStorage";
import { z } from "zod";

// react-hotkeys-hook knows the Command key only as "meta"; it reads "cmd" as a plain key that
// never matches, so a "cmd+…" binding never fires. The native menu wants "cmd" instead
// (`nativeMenuAccelerator`).
const meta = platform() === "macos" ? "meta" : "ctrl";

/** One modifier token rewritten in a "+"-joined key list, leaving every other token alone. */
function replaceKeyToken(keys: string, from: string, to: string): string {
    return keys
        .split("+")
        .map((key) => (key === from ? to : key))
        .join("+");
}

/**
 * Whether a binding holds Ctrl, Cmd or Alt, so pressing it can never be typing. Only such a
 * binding may act while a text field or editor has focus.
 */
export function hasCommandModifier(keys: string): boolean {
    return keys
        .toLowerCase()
        .split("+")
        .some((key) => ["ctrl", "control", "meta", "cmd", "mod", "alt", "option"].includes(key));
}

/** A stored binding as a native menu accelerator, whose parser accepts "cmd" but not "meta". */
export function nativeMenuAccelerator(keys: string): string {
    return replaceKeyToken(keys, "meta", "cmd");
}

type Keybind = {
    name: string;
    keys: string;
};

type KeyMap = { [key: string]: Keybind };

/** `name` is the English label older builds persisted and still validate; the UI shows `labelKey`. */
type KeybindDefinition = Keybind & { labelKey: Parameters<typeof i18nKey>[0] };

const definitions = {
    NEW_TAB: {
        labelKey: i18nKey("Settings.Keybinds.Actions.NEW_TAB"),
        name: "New tab",
        keys: `${meta}+t`,
    },
    CLOSE_TAB: {
        labelKey: i18nKey("Settings.Keybinds.Actions.CLOSE_TAB"),
        name: "Close tab",
        keys: `${meta}+w`,
    },
    OPEN_FILE: {
        labelKey: i18nKey("Settings.Keybinds.Actions.OPEN_FILE"),
        name: "Open File",
        keys: `${meta}+o`,
    },
    SAVE_FILE: {
        labelKey: i18nKey("Settings.Keybinds.Actions.SAVE_FILE"),
        name: "Save File",
        keys: `${meta}+s`,
    },
    SAVE_TO_DATABASE: {
        labelKey: i18nKey("Settings.Keybinds.Actions.SAVE_TO_DATABASE"),
        name: "Save to database",
        keys: `${meta}+shift+d`,
    },
    EDIT_POSITION: {
        labelKey: i18nKey("Settings.Keybinds.Actions.EDIT_POSITION"),
        name: "Edit position",
        keys: "e",
    },
    TAKE_SNAPSHOT: {
        labelKey: i18nKey("Settings.Keybinds.Actions.TAKE_SNAPSHOT"),
        name: "Take snapshot",
        keys: `${meta}+shift+s`,
    },
    COPY_PGN: {
        labelKey: i18nKey("Settings.Keybinds.Actions.COPY_PGN"),
        name: "Copy PGN",
        keys: `${meta}+k`,
    },
    SWAP_ORIENTATION: {
        labelKey: i18nKey("Settings.Keybinds.Actions.SWAP_ORIENTATION"),
        name: "Swap orientation",
        keys: "f",
    },
    UNDO: {
        labelKey: i18nKey("Settings.Keybinds.Actions.UNDO"),
        name: "Undo",
        keys: `${meta}+z`,
    },
    REDO: {
        labelKey: i18nKey("Settings.Keybinds.Actions.REDO"),
        name: "Redo",
        keys: `${meta}+shift+z`,
    },
    CLEAR_SHAPES: {
        labelKey: i18nKey("Settings.Keybinds.Actions.CLEAR_SHAPES"),
        name: "Clear shapes",
        keys: "ctrl+l",
    },
    NEXT_MOVE: {
        labelKey: i18nKey("Settings.Keybinds.Actions.NEXT_MOVE"),
        name: "Next move",
        keys: "arrowright",
    },
    PREVIOUS_MOVE: {
        labelKey: i18nKey("Settings.Keybinds.Actions.PREVIOUS_MOVE"),
        name: "Previous move",
        keys: "arrowleft",
    },
    GO_TO_BRANCH_START: {
        labelKey: i18nKey("Settings.Keybinds.Actions.GO_TO_BRANCH_START"),
        name: "Go to start of branch",
        keys: "arrowup",
    },
    GO_TO_BRANCH_END: {
        labelKey: i18nKey("Settings.Keybinds.Actions.GO_TO_BRANCH_END"),
        name: "Go to end of branch",
        keys: "arrowdown",
    },
    GO_TO_START: {
        labelKey: i18nKey("Settings.Keybinds.Actions.GO_TO_START"),
        name: "Go to start of game",
        keys: "shift+arrowup",
    },
    GO_TO_END: {
        labelKey: i18nKey("Settings.Keybinds.Actions.GO_TO_END"),
        name: "Go to end of game",
        keys: "shift+arrowdown",
    },
    NEXT_BRANCH: {
        labelKey: i18nKey("Settings.Keybinds.Actions.NEXT_BRANCH"),
        name: "Next branch",
        keys: "c",
    },
    PREVIOUS_BRANCH: {
        labelKey: i18nKey("Settings.Keybinds.Actions.PREVIOUS_BRANCH"),
        name: "Previous branch",
        keys: "shift+c",
    },
    PLAY_BEST_ENGINE_MOVE: {
        labelKey: i18nKey("Settings.Keybinds.Actions.PLAY_BEST_ENGINE_MOVE"),
        name: "Play best engine move",
        keys: "space",
    },
    TOGGLE_THREAT_MODE: {
        labelKey: i18nKey("Settings.Keybinds.Actions.TOGGLE_THREAT_MODE"),
        name: "Toggle threat mode",
        keys: "x",
    },
    NEXT_BRANCHING: {
        labelKey: i18nKey("Settings.Keybinds.Actions.NEXT_BRANCHING"),
        name: "Next branching point",
        keys: "shift+arrowright",
    },
    PREVIOUS_BRANCHING: {
        labelKey: i18nKey("Settings.Keybinds.Actions.PREVIOUS_BRANCHING"),
        name: "Previous branching point",
        keys: "shift+arrowleft",
    },
    NEXT_OPEN_VARIATION: {
        labelKey: i18nKey("Settings.Keybinds.Actions.NEXT_OPEN_VARIATION"),
        name: "Next open variation",
        keys: "u",
    },
    DELETE_MOVE: {
        labelKey: i18nKey("Settings.Keybinds.Actions.DELETE_MOVE"),
        name: "Delete move",
        keys: "delete",
    },
    DELETE_VARIATION: {
        labelKey: i18nKey("Settings.Keybinds.Actions.DELETE_VARIATION"),
        name: "Delete variation",
        keys: `${meta}+delete`,
    },
    DELETE_MOVES_AFTER: {
        labelKey: i18nKey("Settings.Keybinds.Actions.DELETE_MOVES_AFTER"),
        name: "Delete moves after this move",
        keys: "shift+delete",
    },
    PROMOTE_VARIATION: {
        labelKey: i18nKey("Settings.Keybinds.Actions.PROMOTE_VARIATION"),
        name: "Promote variation",
        keys: `${meta}+arrowup`,
    },
    CYCLE_TABS: {
        labelKey: i18nKey("Settings.Keybinds.Actions.CYCLE_TABS"),
        name: "Cycle tabs",
        keys: "ctrl+tab",
    },
    TOGGLE_FOCUS_MODE: {
        labelKey: i18nKey("Settings.Keybinds.Actions.TOGGLE_FOCUS_MODE"),
        name: "Toggle focus mode",
        keys: `${meta}+shift+f`,
    },
    REVERSE_CYCLE_TABS: {
        labelKey: i18nKey("Settings.Keybinds.Actions.REVERSE_CYCLE_TABS"),
        name: "Reverse cycle tabs",
        keys: "ctrl+shift+tab",
    },
    TOGGLE_EVAL_BAR: {
        labelKey: i18nKey("Settings.Keybinds.Actions.TOGGLE_EVAL_BAR"),
        name: "Toggle Eval Bar and Arrows",
        keys: "z",
    },
    PRACTICE_TAB: {
        labelKey: i18nKey("Settings.Keybinds.Actions.PRACTICE_TAB"),
        name: "Go to practice tab",
        keys: "p",
    },
    ANALYSIS_TAB: {
        labelKey: i18nKey("Settings.Keybinds.Actions.ANALYSIS_TAB"),
        name: "Go to analysis tab",
        keys: "a",
    },
    DATABASE_TAB: {
        labelKey: i18nKey("Settings.Keybinds.Actions.DATABASE_TAB"),
        name: "Go to database tab",
        keys: "b",
    },
    ANNOTATE_TAB: {
        labelKey: i18nKey("Settings.Keybinds.Actions.ANNOTATE_TAB"),
        name: "Go to annotate tab",
        keys: "d",
    },
    COACH_TAB: {
        labelKey: i18nKey("Settings.Keybinds.Actions.COACH_TAB"),
        name: "Go to Coach tab",
        keys: "o",
    },
    ANNOTATION_NEXT_MOVE: {
        labelKey: i18nKey("Settings.Keybinds.Actions.ANNOTATION_NEXT_MOVE"),
        name: "Annotation editor: next move",
        keys: "tab",
    },
    ANNOTATION_PREVIOUS_MOVE: {
        labelKey: i18nKey("Settings.Keybinds.Actions.ANNOTATION_PREVIOUS_MOVE"),
        name: "Annotation editor: previous move",
        keys: "shift+tab",
    },
    INFO_TAB: {
        labelKey: i18nKey("Settings.Keybinds.Actions.INFO_TAB"),
        name: "Go to info tab",
        keys: "i",
    },
    ANNOTATION_BRILLIANT: {
        labelKey: i18nKey("Settings.Keybinds.Actions.ANNOTATION_BRILLIANT"),
        name: "Toggle brilliant move annotation",
        keys: "1",
    },
    ANNOTATION_GOOD: {
        labelKey: i18nKey("Settings.Keybinds.Actions.ANNOTATION_GOOD"),
        name: "Toggle good move annotation",
        keys: "2",
    },
    ANNOTATION_INTERESTING: {
        labelKey: i18nKey("Settings.Keybinds.Actions.ANNOTATION_INTERESTING"),
        name: "Toggle interesting move annotation",
        keys: "3",
    },
    ANNOTATION_DUBIOUS: {
        labelKey: i18nKey("Settings.Keybinds.Actions.ANNOTATION_DUBIOUS"),
        name: "Toggle dubious move annotation",
        keys: "4",
    },
    ANNOTATION_MISTAKE: {
        labelKey: i18nKey("Settings.Keybinds.Actions.ANNOTATION_MISTAKE"),
        name: "Toggle mistake move annotation",
        keys: "5",
    },
    ANNOTATION_BLUNDER: {
        labelKey: i18nKey("Settings.Keybinds.Actions.ANNOTATION_BLUNDER"),
        name: "Toggle blunder move annotation",
        keys: "6",
    },
    TOGGLE_ALL_ENGINES: {
        labelKey: i18nKey("Settings.Keybinds.Actions.TOGGLE_ALL_ENGINES"),
        name: "Toggle all engines",
        keys: "ctrl+a",
    },
    TOGGLE_BLUR: {
        labelKey: i18nKey("Settings.Keybinds.Actions.TOGGLE_BLUR"),
        name: "Toggle blur",
        keys: "ctrl+b",
    },
    GENERATE_REPORT: {
        labelKey: i18nKey("Settings.Keybinds.Actions.GENERATE_REPORT"),
        name: "Generate game report",
        keys: "f12",
    },
    PREVIOUS_GAME: {
        labelKey: i18nKey("Settings.Keybinds.Actions.PREVIOUS_GAME"),
        name: "Previous game",
        keys: "pageup",
    },
    NEXT_GAME: {
        labelKey: i18nKey("Settings.Keybinds.Actions.NEXT_GAME"),
        name: "Next game",
        keys: "pagedown",
    },
} satisfies Record<string, KeybindDefinition>;

export type KeybindActionId = keyof typeof definitions;

export const KEYBIND_ACTION_IDS = Object.keys(definitions) as KeybindActionId[];

const NATIVE_MENU_ACTIONS: ReadonlySet<KeybindActionId> = new Set([
    "NEW_TAB",
    "OPEN_FILE",
    "SAVE_FILE",
    "TOGGLE_FOCUS_MODE",
]);

/**
 * Whether the native macOS menu fires this shortcut as its own accelerator, so a renderer hook
 * for it would run the action a second time.
 */
export function firedByNativeMenu(action: KeybindActionId): boolean {
    return platform() === "macos" && NATIVE_MENU_ACTIONS.has(action);
}

// Stored keymaps stay `{ [action]: { name, keys } }`; the label key is never persisted.
const keys: KeyMap = Object.fromEntries(
    Object.entries(definitions).map(([action, { name, keys }]) => [action, { name, keys }]),
);

/** The translated label of an action; an action this build does not define keeps its stored name. */
export function keybindLabel(t: TFunction, action: string, keybind: Keybind): string {
    return Object.hasOwn(definitions, action)
        ? t(definitions[action as keyof typeof definitions].labelKey)
        : keybind.name;
}

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
            Object.entries(defaults).map(([id, fallback]) => {
                const stored = persisted[id];
                if (!stored) return [id, { ...fallback }];
                // Earlier builds stored macOS Command bindings as "cmd", which never matched.
                return [
                    id,
                    { ...fallback, ...stored, keys: replaceKeyToken(stored.keys, "cmd", meta) },
                ];
            }),
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
                    { ...binding, keys: replaceKeyToken(binding.keys, "meta", meta) },
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
