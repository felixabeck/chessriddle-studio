import { emojiOf } from "@/components/common/iconCatalog";

/** Tab order of the settings browser; titles come from `settingCategoryTitle` below; category descriptions live in SettingsPage `categoryInfo`; emoji come from the icon catalogue. */
export const SETTING_CATEGORIES = [
    "board",
    "analysis",
    "repertoire",
    "coach",
    "general",
    "sound",
    "keybinds",
    "directories",
    "advanced",
] as const;

export type SettingCategory = (typeof SETTING_CATEGORIES)[number];

export const SETTING_CATEGORY_GROUPS = [
    {
        id: "chess",
        accent: "chart-2",
        categories: ["board", "analysis", "repertoire", "coach"],
    },
    {
        id: "app",
        accent: "chart-4",
        categories: ["general", "sound", "keybinds", "directories", "advanced"],
    },
] as const;

export type SettingCategoryGroupId = (typeof SETTING_CATEGORY_GROUPS)[number]["id"];

export const SETTING_CONTENT_GROUPS = [
    "look",
    "highlights",
    "movingPieces",
    "arrowsDrawing",
    "notation",
    "navigating",
    "layoutSaving",
] as const;

export type SettingContentGroup = (typeof SETTING_CONTENT_GROUPS)[number];

export const SETTING_CATEGORY_EMOJI: Record<SettingCategory, string> = {
    board: emojiOf("board"),
    analysis: emojiOf("analysis"),
    repertoire: emojiOf("repertoire"),
    coach: emojiOf("coach"),
    general: emojiOf("settings"),
    sound: emojiOf("sound"),
    keybinds: emojiOf("keyboard"),
    directories: emojiOf("library"),
    advanced: emojiOf("advanced"),
};

export const SETTING_CONTENT_GROUP_EMOJI: Record<SettingContentGroup, string> = {
    look: emojiOf("look"),
    highlights: emojiOf("highlights"),
    movingPieces: emojiOf("movingPieces"),
    arrowsDrawing: emojiOf("arrowsDrawing"),
    notation: emojiOf("notation"),
    navigating: emojiOf("navigating"),
    layoutSaving: emojiOf("layoutSaving"),
};

/** Last-move highlight colour and opacity nest under the highlight switch. */
export const LAST_MOVE_HIGHLIGHT_CHILD_IDS = [
    "move-highlight-color",
    "move-highlight-opacity",
] as const;

export type LastMoveHighlightChildId = (typeof LAST_MOVE_HIGHLIGHT_CHILD_IDS)[number];

export function isLastMoveHighlightChild(id: string): id is LastMoveHighlightChildId {
    return (LAST_MOVE_HIGHLIGHT_CHILD_IDS as readonly string[]).includes(id);
}

export interface SettingsBuildFacts {
    /** Build target platform (`import.meta.env.VITE_PLATFORM`), e.g. `"win32"`, `"linux"`, `"darwin"`. */
    platform: string | undefined;
    /** Whether the Coach feature is available in this build. */
    coachEnabled: boolean;
}

export type SettingsTranslator = (key: string) => string;

export interface SettingDescription<Id extends string = SettingId> {
    readonly id: Id;
    readonly category: SettingCategory;
    readonly group?: SettingContentGroup;
    readonly title: string;
    readonly description: string;
    readonly keywords: readonly string[];
    readonly shown: boolean;
}

/** Returns the settings categories shown in this build, in display order. */
export function visibleSettingCategories(
    facts: Pick<SettingsBuildFacts, "coachEnabled">,
): SettingCategory[] {
    return SETTING_CATEGORIES.filter((category) => category !== "coach" || facts.coachEnabled);
}

/** Sidebar groups with hidden categories (Coach when disabled) removed. */
export function visibleSettingCategoryGroups(facts: Pick<SettingsBuildFacts, "coachEnabled">): {
    readonly id: SettingCategoryGroupId;
    readonly accent: (typeof SETTING_CATEGORY_GROUPS)[number]["accent"];
    readonly categories: SettingCategory[];
}[] {
    const visible = new Set(visibleSettingCategories(facts));
    return SETTING_CATEGORY_GROUPS.map((group) => ({
        id: group.id,
        accent: group.accent,
        categories: group.categories.filter((category) => visible.has(category)),
    })).filter((group) => group.categories.length > 0);
}

/**
 * Localized title for a settings category. Every key is a literal `t` call so i18next extraction
 * retains every key.
 */
export function settingCategoryTitle(t: SettingsTranslator, category: SettingCategory): string {
    switch (category) {
        case "board":
            return t("Settings.Board");
        case "analysis":
            return t("Settings.Analysis");
        case "repertoire":
            return t("Settings.Repertoire");
        case "coach":
            return t("Settings.AI");
        case "general":
            return t("Settings.General");
        case "sound":
            return t("Settings.Sound");
        case "keybinds":
            return t("Settings.Keybinds");
        case "directories":
            return t("Settings.Directories");
        case "advanced":
            return t("Settings.Advanced");
    }
}

export function settingCategoryGroupTitle(
    t: SettingsTranslator,
    groupId: SettingCategoryGroupId,
): string {
    switch (groupId) {
        case "chess":
            return t("Settings.Group.Chess");
        case "app":
            return t("Settings.Group.App");
    }
}

export function settingContentGroupTitle(
    t: SettingsTranslator,
    group: SettingContentGroup,
): string {
    switch (group) {
        case "look":
            return t("Settings.Group.Look");
        case "highlights":
            return t("Settings.Group.Highlights");
        case "movingPieces":
            return t("Settings.Group.MovingPieces");
        case "arrowsDrawing":
            return t("Settings.Group.ArrowsDrawing");
        case "notation":
            return t("Settings.Group.Notation");
        case "navigating":
            return t("Settings.Group.Navigating");
        case "layoutSaving":
            return t("Settings.Group.LayoutSaving");
    }
}

/** Search-result heading: `"Board · Highlights"` when the row has a content group. */
export function settingSearchGroupLabel(
    t: SettingsTranslator,
    setting: { readonly category: SettingCategory; readonly group?: SettingContentGroup },
): string {
    const category = settingCategoryTitle(t, setting.category);
    const group = setting.group;
    if (!group) return category;
    return `${category} · ${settingContentGroupTitle(t, group)}`;
}

/**
 * Pure description of every setting row in the Settings page.
 * Every title and description uses a literal `t` call so i18next extraction retains every key.
 */
export function describeSettings(t: SettingsTranslator, facts: SettingsBuildFacts) {
    const showTitleBar = facts.platform === "win32" || facts.platform === "linux";

    const settings = [
        // Board · Look
        {
            id: "board-image",
            category: "board",
            group: "look",
            title: t("Settings.Appearance.BoardImage"),
            description: t("Settings.Appearance.BoardImage.Desc"),
            keywords: ["board", "image", "texture"],
            shown: true,
        },
        {
            id: "board-wood-texture",
            category: "board",
            group: "look",
            title: t("Settings.Appearance.WoodTexture"),
            description: t("Settings.Appearance.WoodTexture.Desc"),
            keywords: ["wood", "texture", "grain", "board"],
            shown: true,
        },
        {
            id: "piece-set",
            category: "board",
            group: "look",
            title: t("Settings.Appearance.PieceSet"),
            description: t("Settings.Appearance.PieceSet.Desc"),
            keywords: ["piece", "set", "style"],
            shown: true,
        },
        {
            id: "piece-size",
            category: "board",
            group: "look",
            title: t("Settings.Appearance.PieceSize"),
            description: t("Settings.Appearance.PieceSize.Desc"),
            keywords: ["piece", "size", "scale"],
            shown: true,
        },
        {
            id: "coordinates",
            category: "board",
            group: "look",
            title: t("Settings.Coordinates"),
            description: t("Settings.Coordinates.Desc"),
            keywords: ["coordinates", "a-h", "1-8"],
            shown: true,
        },
        {
            id: "animation-speed",
            category: "board",
            group: "look",
            title: t("Settings.AnimationSpeed"),
            description: t("Settings.AnimationSpeed.Desc"),
            keywords: ["animation", "speed", "duration", "move"],
            shown: true,
        },
        // Board · Highlights
        {
            id: "piece-dest",
            category: "board",
            group: "highlights",
            title: t("Settings.PieceDest"),
            description: t("Settings.PieceDest.Desc"),
            keywords: ["destination", "moves", "highlight"],
            shown: true,
        },
        {
            id: "move-highlight",
            category: "board",
            group: "highlights",
            title: t("Settings.MoveHighlight"),
            description: t("Settings.MoveHighlight.Desc"),
            keywords: ["highlight", "last move"],
            shown: true,
        },
        {
            id: "move-highlight-color",
            category: "board",
            group: "highlights",
            title: t("Settings.MoveHighlightColor"),
            description: t("Settings.MoveHighlightColor.Desc"),
            keywords: ["highlight", "last move", "color", "colour"],
            shown: true,
        },
        {
            id: "move-highlight-opacity",
            category: "board",
            group: "highlights",
            title: t("Settings.MoveHighlightOpacity"),
            description: t("Settings.MoveHighlightOpacity.Desc"),
            keywords: ["highlight", "last move", "opacity", "transparency"],
            shown: true,
        },
        // Board · Moving pieces
        {
            id: "move-method",
            category: "board",
            group: "movingPieces",
            title: t("Settings.MoveMethod"),
            description: t("Settings.MoveMethod.Desc"),
            keywords: ["drag", "click", "move", "pieces"],
            shown: true,
        },
        {
            id: "text-input",
            category: "board",
            group: "movingPieces",
            title: t("Settings.Inputs.TextInput"),
            description: t("Settings.Inputs.TextInput.Desc"),
            keywords: ["text", "input", "type"],
            shown: true,
        },
        {
            id: "auto-promote",
            category: "board",
            group: "movingPieces",
            title: t("Settings.AutoPromition"),
            description: t("Settings.AutoPromition.Desc"),
            keywords: ["promote", "queen", "pawn"],
            shown: true,
        },
        {
            id: "flip-board-after-move",
            category: "board",
            group: "movingPieces",
            title: t("Settings.FlipBoardAfterMove"),
            description: t("Settings.FlipBoardAfterMove.Desc"),
            keywords: ["flip", "board", "move"],
            shown: true,
        },
        // Board · Arrows & drawing
        {
            id: "arrows",
            category: "board",
            group: "arrowsDrawing",
            title: t("Settings.Arrows"),
            description: t("Settings.Arrows.Desc"),
            keywords: ["arrows", "analysis"],
            shown: true,
        },
        {
            id: "variation-arrows",
            category: "board",
            group: "arrowsDrawing",
            title: t("Settings.VariationArrows"),
            description: t("Settings.VariationArrows.Desc"),
            keywords: ["arrows", "variations", "alternative"],
            shown: true,
        },
        {
            id: "snap-arrows",
            category: "board",
            group: "arrowsDrawing",
            title: t("Settings.SnapArrows"),
            description: t("Settings.SnapArrows.Desc"),
            keywords: ["arrows", "snap"],
            shown: true,
        },
        {
            id: "consecutive-arrows",
            category: "board",
            group: "arrowsDrawing",
            title: t("Settings.ConsecutiveArrows"),
            description: t("Settings.ConsecutiveArrows.Desc"),
            keywords: ["arrows", "consecutive"],
            shown: true,
        },
        {
            id: "erase-drawables",
            category: "board",
            group: "arrowsDrawing",
            title: t("Settings.EraseDrawablesOnClick"),
            description: t("Settings.EraseDrawablesOnClick.Desc"),
            keywords: ["erase", "drawables", "click", "arrows"],
            shown: true,
        },
        // Analysis · Notation
        {
            id: "move-notation",
            category: "analysis",
            group: "notation",
            title: t("Settings.MoveNotation"),
            description: t("Settings.MoveNotation.Desc"),
            keywords: ["notation", "letters", "symbols", "pieces"],
            shown: true,
        },
        {
            id: "material-display",
            category: "analysis",
            group: "notation",
            title: t("Settings.MaterialDisplay"),
            description: t("Settings.MaterialDisplay.Desc"),
            keywords: ["material", "captured", "pieces", "difference", "hide"],
            shown: true,
        },
        {
            id: "hide-preview-moves",
            category: "analysis",
            group: "notation",
            title: t("Settings.HidePreviewMoves"),
            description: t("Settings.HidePreviewMoves.Desc"),
            keywords: ["hide", "moves", "notation", "preview", "puzzle", "solution", "training"],
            shown: true,
        },
        // Analysis · Navigating
        {
            id: "scroll-moves",
            category: "analysis",
            group: "navigating",
            title: t("Settings.ScrollThroughMoves"),
            description: t("Settings.ScrollThroughMoves.Desc"),
            keywords: ["scroll", "moves", "wheel"],
            shown: true,
        },
        {
            id: "choose-variation",
            category: "analysis",
            group: "navigating",
            title: t("Settings.ChooseVariation"),
            description: t("Settings.ChooseVariation.Desc"),
            keywords: ["variation", "branch", "arrow", "keyboard", "continuation"],
            shown: true,
        },
        {
            id: "preview-board",
            category: "analysis",
            group: "navigating",
            title: t("Settings.PreviewBoard"),
            description: t("Settings.PreviewBoard.Desc"),
            keywords: ["preview", "hover"],
            shown: true,
        },
        // Analysis · Layout & saving
        {
            id: "default-panel-tab",
            category: "analysis",
            group: "layoutSaving",
            title: t("Settings.DefaultPanel"),
            description: t("Settings.DefaultPanel.Desc"),
            keywords: [
                "default",
                "panel",
                "tab",
                "open",
                "info",
                "analysis",
                "database",
                "annotate",
            ],
            shown: true,
        },
        {
            id: "board-layout",
            category: "analysis",
            group: "layoutSaving",
            title: t("Settings.BoardLayout"),
            description: t("Settings.BoardLayout.Desc"),
            keywords: [
                "layout",
                "reset",
                "arrangement",
                "panel",
                "tabs",
                "notation",
                "areas",
                "default",
            ],
            shown: true,
        },
        {
            id: "auto-save",
            category: "analysis",
            group: "layoutSaving",
            title: t("Settings.AutoSave"),
            description: t("Settings.AutoSave.Desc"),
            keywords: ["save", "auto"],
            shown: true,
        },
        // Repertoire
        {
            id: "repertoire-depth",
            category: "repertoire",
            title: t("Settings.Repertoire.Depth"),
            description: t("Settings.Repertoire.Depth.Desc"),
            keywords: ["repertoire", "depth", "games", "min"],
            shown: true,
        },
        {
            id: "practice-grading",
            category: "repertoire",
            title: t("Settings.Repertoire.Grading"),
            description: t("Settings.Repertoire.Grading.Desc"),
            keywords: ["repertoire", "auto", "difficulty", "select", "anki"],
            shown: true,
        },
        {
            id: "practice-new-per-session",
            category: "repertoire",
            title: t("Settings.Repertoire.NewPerSession"),
            description: t("Settings.Repertoire.NewPerSession.Desc"),
            keywords: ["practice", "new", "limit", "session"],
            shown: true,
        },
        // General (no groups)
        {
            id: "language",
            category: "general",
            title: t("Settings.Appearance.Language"),
            description: t("Settings.Appearance.Language.Desc"),
            keywords: ["language", "locale", "translation"],
            shown: true,
        },
        {
            id: "theme",
            category: "general",
            title: t("Settings.Appearance.Theme"),
            description: t("Settings.Appearance.Theme.Desc"),
            keywords: ["theme", "dark", "light", "color"],
            shown: true,
        },
        {
            id: "font-size",
            category: "general",
            title: t("Settings.Appearance.FontSize"),
            description: t("Settings.Appearance.FontSize.Desc"),
            keywords: ["font", "size", "text"],
            shown: true,
        },
        {
            id: "title-bar",
            category: "general",
            title: t("Settings.Appearance.TitleBar"),
            description: t("Settings.Appearance.TitleBar.Desc"),
            keywords: ["title", "bar", "native", "custom"],
            shown: showTitleBar,
        },
        {
            id: "spell-check",
            category: "general",
            title: t("Settings.Inputs.SpellCheck"),
            description: t("Settings.Inputs.SpellCheck.Desc"),
            keywords: ["spell", "check", "grammar"],
            shown: true,
        },
        // Sound
        {
            id: "volume",
            category: "sound",
            title: t("Settings.Sound.Volume"),
            description: t("Settings.Sound.Volume.Desc"),
            keywords: ["volume", "audio", "loud"],
            shown: true,
        },
        {
            id: "sound-collection",
            category: "sound",
            title: t("Settings.Sound.Collection"),
            description: t("Settings.Sound.Collection.Desc"),
            keywords: ["sound", "collection", "audio", "effects"],
            shown: true,
        },
        // Directories
        {
            id: "files-directory",
            category: "directories",
            title: t("Settings.Directories.Files"),
            description: t("Settings.Directories.Files.Desc"),
            keywords: ["files", "directory", "folder", "path", "collection", "pgn"],
            shown: true,
        },
        {
            id: "databases-directory",
            category: "directories",
            title: t("Settings.Directories.Databases"),
            description: t("Settings.Directories.Databases.Desc"),
            keywords: ["databases", "directory", "folder", "path"],
            shown: true,
        },
        {
            id: "engines-directory",
            category: "directories",
            title: t("Settings.Directories.Engines"),
            description: t("Settings.Directories.Engines.Desc"),
            keywords: ["engines", "directory", "folder", "path"],
            shown: true,
        },
        {
            id: "puzzles-directory",
            category: "directories",
            title: t("Settings.Directories.Puzzles"),
            description: t("Settings.Directories.Puzzles.Desc"),
            keywords: ["puzzles", "directory", "folder", "path"],
            shown: true,
        },
        // Coach
        {
            id: "coach-model",
            category: "coach",
            title: t("Settings.Coach.Model"),
            description: t("Settings.Coach.Model.Desc"),
            keywords: ["coach", "assistant", "ai", "model", "provider", "connection", "effort"],
            shown: facts.coachEnabled,
        },
        {
            id: "coach-engine",
            category: "coach",
            title: t("Settings.Coach.Engine"),
            description: t("Settings.Coach.Engine.Desc"),
            keywords: ["coach", "ai", "engine"],
            shown: facts.coachEnabled,
        },
        // Advanced
        {
            id: "restore-open-tabs",
            category: "advanced",
            title: t("Settings.Advanced.RestoreOpenTabs"),
            description: t("Settings.Advanced.RestoreOpenTabs.Desc"),
            keywords: ["restore", "tabs", "session", "start", "reopen", "workspace"],
            shown: true,
        },
        {
            id: "reload",
            category: "advanced",
            title: t("Menu.View.Reload"),
            description: t("Settings.Advanced.Reload.Desc"),
            keywords: ["reload", "refresh"],
            shown: true,
        },
        {
            id: "clear-saved-data",
            category: "advanced",
            title: t("Menu.Help.ClearSavedData"),
            description: t("Settings.Advanced.ClearSavedData.Desc"),
            keywords: ["clear", "data", "reset", "storage"],
            shown: true,
        },
        {
            id: "open-logs",
            category: "advanced",
            title: t("Menu.Help.OpenLogs"),
            description: t("Settings.Advanced.OpenLogs.Desc"),
            keywords: ["logs", "log", "diagnostic"],
            shown: true,
        },
    ] as const satisfies readonly SettingDescription<string>[];
    return settings as readonly ((typeof settings)[number] & {
        readonly group?: SettingContentGroup;
    })[];
}

export type SettingId = ReturnType<typeof describeSettings>[number]["id"];
