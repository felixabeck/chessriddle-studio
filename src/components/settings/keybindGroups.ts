import type { KeybindActionId } from "@/state/keybinds";
import { emojiOf } from "@/components/common/iconCatalog";
import type { SettingsTranslator } from "./settingsDescription";

/** Drawing-on-the-board heading; the same concept as Board → Arrows & drawing. */
export const KEYBIND_DRAWING_EMOJI = emojiOf("arrowsDrawing");

export const KEYBIND_GROUP_IDS = [
    "tabsFiles",
    "navigation",
    "editing",
    "annotations",
    "engine",
    "panels",
] as const;

export type KeybindGroupId = (typeof KEYBIND_GROUP_IDS)[number];

export const KEYBIND_GROUPS = [
    {
        id: "tabsFiles",
        emoji: emojiOf("tabsFiles"),
        actions: [
            "NEW_TAB",
            "CLOSE_TAB",
            "CYCLE_TABS",
            "REVERSE_CYCLE_TABS",
            "OPEN_FILE",
            "SAVE_FILE",
            "SAVE_TO_DATABASE",
            "COPY_PGN",
            "PREVIOUS_GAME",
            "NEXT_GAME",
        ],
    },
    {
        id: "navigation",
        emoji: emojiOf("navigating"),
        actions: [
            "NEXT_MOVE",
            "PREVIOUS_MOVE",
            "GO_TO_BRANCH_START",
            "GO_TO_BRANCH_END",
            "GO_TO_START",
            "GO_TO_END",
            "NEXT_BRANCH",
            "PREVIOUS_BRANCH",
            "NEXT_BRANCHING",
            "PREVIOUS_BRANCHING",
            "NEXT_OPEN_VARIATION",
        ],
    },
    {
        id: "editing",
        emoji: emojiOf("editing"),
        actions: [
            "UNDO",
            "REDO",
            "PROMOTE_VARIATION",
            "DELETE_MOVE",
            "DELETE_VARIATION",
            "DELETE_MOVES_AFTER",
            "CLEAR_SHAPES",
            "SWAP_ORIENTATION",
            "EDIT_POSITION",
            "TAKE_SNAPSHOT",
        ],
    },
    {
        id: "annotations",
        emoji: emojiOf("annotations"),
        actions: [
            "ANNOTATION_BRILLIANT",
            "ANNOTATION_GOOD",
            "ANNOTATION_INTERESTING",
            "ANNOTATION_DUBIOUS",
            "ANNOTATION_MISTAKE",
            "ANNOTATION_BLUNDER",
            "ANNOTATION_NEXT_MOVE",
            "ANNOTATION_PREVIOUS_MOVE",
        ],
    },
    {
        id: "engine",
        emoji: emojiOf("engine"),
        actions: [
            "PLAY_BEST_ENGINE_MOVE",
            "TOGGLE_THREAT_MODE",
            "TOGGLE_ALL_ENGINES",
            "TOGGLE_EVAL_BAR",
            "TOGGLE_BLUR",
            "GENERATE_REPORT",
        ],
    },
    {
        id: "panels",
        emoji: emojiOf("panels"),
        actions: [
            "PRACTICE_TAB",
            "ANALYSIS_TAB",
            "DATABASE_TAB",
            "ANNOTATE_TAB",
            "COACH_TAB",
            "INFO_TAB",
        ],
    },
] as const satisfies readonly {
    readonly id: KeybindGroupId;
    readonly emoji: string;
    readonly actions: readonly KeybindActionId[];
}[];

export function keybindGroupTitle(t: SettingsTranslator, groupId: KeybindGroupId): string {
    switch (groupId) {
        case "tabsFiles":
            return t("Settings.Keybinds.Group.TabsFiles");
        case "navigation":
            return t("Settings.Keybinds.Group.Navigation");
        case "editing":
            return t("Settings.Keybinds.Group.Editing");
        case "annotations":
            return t("Settings.Keybinds.Group.Annotations");
        case "engine":
            return t("Settings.Keybinds.Group.Engine");
        case "panels":
            return t("Settings.Keybinds.Group.Panels");
    }
}

export function groupedKeybindActions(
    keyMap: Record<string, unknown>,
    coachEnabled: boolean,
): {
    readonly groups: readonly {
        readonly id: KeybindGroupId;
        readonly emoji: string;
        readonly actions: readonly string[];
    }[];
    readonly extraActions: readonly string[];
} {
    const assigned = new Set<string>();
    const groups = KEYBIND_GROUPS.map((group) => ({
        id: group.id,
        emoji: group.emoji,
        actions: group.actions.filter((action) => {
            if (!Object.hasOwn(keyMap, action)) return false;
            if (!coachEnabled && action === "COACH_TAB") return false;
            assigned.add(action);
            return true;
        }),
    })).filter((group) => group.actions.length > 0);

    const extraActions = Object.keys(keyMap).filter((action) => {
        if (assigned.has(action)) return false;
        if (!coachEnabled && action === "COACH_TAB") return false;
        return true;
    });

    return { groups, extraActions };
}
