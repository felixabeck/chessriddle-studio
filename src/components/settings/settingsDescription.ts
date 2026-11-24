/** Tab order of the settings browser; titles come from `settingCategoryTitle` below, descriptions and icons live in `SettingsPage`. */
export const SETTING_CATEGORIES = [
    "board",
    "inputs",
    "appearance",
    "sound",
    "keybinds",
    "directories",
    "repertoire",
    "coach",
    "advanced",
] as const;

export type SettingCategory = (typeof SETTING_CATEGORIES)[number];

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

/**
 * Localized title for a settings category. Every key is a literal `t` call so i18next extraction
 * retains every key.
 */
export function settingCategoryTitle(t: SettingsTranslator, category: SettingCategory): string {
    switch (category) {
        case "board":
            return t("Settings.Board");
        case "inputs":
            return t("Settings.Inputs");
        case "appearance":
            return t("Settings.Appearance");
        case "sound":
            return t("Settings.Sound");
        case "keybinds":
            return t("Settings.Keybinds");
        case "directories":
            return t("Settings.Directories");
        case "repertoire":
            return t("Settings.Repertoire");
        case "coach":
            return t("Settings.AI");
        case "advanced":
            return t("Settings.Advanced");
    }
}

/**
 * Pure description of every setting row in the Settings page.
 * Every title and description uses a literal `t` call so i18next extraction retains every key.
 */
export function describeSettings(t: SettingsTranslator, facts: SettingsBuildFacts) {
    const showTitleBar = facts.platform === "win32" || facts.platform === "linux";

    return [
        // Board settings
        {
            id: "piece-dest",
            category: "board",
            title: t("Settings.PieceDest"),
            description: t("Settings.PieceDest.Desc"),
            keywords: ["destination", "moves", "highlight"],
            shown: true,
        },
        {
            id: "move-highlight",
            category: "board",
            title: t("Settings.MoveHighlight"),
            description: t("Settings.MoveHighlight.Desc"),
            keywords: ["highlight", "last move"],
            shown: true,
        },
        {
            id: "move-highlight-color",
            category: "board",
            title: t("Settings.MoveHighlightColor"),
            description: t("Settings.MoveHighlightColor.Desc"),
            keywords: ["highlight", "last move", "color", "colour"],
            shown: true,
        },
        {
            id: "move-highlight-opacity",
            category: "board",
            title: t("Settings.MoveHighlightOpacity"),
            description: t("Settings.MoveHighlightOpacity.Desc"),
            keywords: ["highlight", "last move", "opacity", "transparency"],
            shown: true,
        },
        {
            id: "arrows",
            category: "board",
            title: t("Settings.Arrows"),
            description: t("Settings.Arrows.Desc"),
            keywords: ["arrows", "analysis"],
            shown: true,
        },
        {
            id: "variation-arrows",
            category: "board",
            title: t("Settings.VariationArrows"),
            description: t("Settings.VariationArrows.Desc"),
            keywords: ["arrows", "variations", "alternative"],
            shown: true,
        },
        {
            id: "move-notation",
            category: "board",
            title: t("Settings.MoveNotation"),
            description: t("Settings.MoveNotation.Desc"),
            keywords: ["notation", "letters", "symbols", "pieces"],
            shown: true,
        },
        {
            id: "move-method",
            category: "board",
            title: t("Settings.MoveMethod"),
            description: t("Settings.MoveMethod.Desc"),
            keywords: ["drag", "click", "move", "pieces"],
            shown: true,
        },
        {
            id: "snap-arrows",
            category: "board",
            title: t("Settings.SnapArrows"),
            description: t("Settings.SnapArrows.Desc"),
            keywords: ["arrows", "snap"],
            shown: true,
        },
        {
            id: "consecutive-arrows",
            category: "board",
            title: t("Settings.ConsecutiveArrows"),
            description: t("Settings.ConsecutiveArrows.Desc"),
            keywords: ["arrows", "consecutive"],
            shown: true,
        },
        {
            id: "erase-drawables",
            category: "board",
            title: t("Settings.EraseDrawablesOnClick"),
            description: t("Settings.EraseDrawablesOnClick.Desc"),
            keywords: ["erase", "drawables", "click", "arrows"],
            shown: true,
        },
        {
            id: "auto-promote",
            category: "board",
            title: t("Settings.AutoPromition"),
            description: t("Settings.AutoPromition.Desc"),
            keywords: ["promote", "queen", "pawn"],
            shown: true,
        },
        {
            id: "coordinates",
            category: "board",
            title: t("Settings.Coordinates"),
            description: t("Settings.Coordinates.Desc"),
            keywords: ["coordinates", "a-h", "1-8"],
            shown: true,
        },
        {
            id: "animation-speed",
            category: "board",
            title: t("Settings.AnimationSpeed"),
            description: t("Settings.AnimationSpeed.Desc"),
            keywords: ["animation", "speed", "duration", "move"],
            shown: true,
        },
        {
            id: "auto-save",
            category: "board",
            title: t("Settings.AutoSave"),
            description: t("Settings.AutoSave.Desc"),
            keywords: ["save", "auto"],
            shown: true,
        },
        {
            id: "preview-board",
            category: "board",
            title: t("Settings.PreviewBoard"),
            description: t("Settings.PreviewBoard.Desc"),
            keywords: ["preview", "hover"],
            shown: true,
        },
        {
            id: "flip-board-after-move",
            category: "board",
            title: t("Settings.FlipBoardAfterMove"),
            description: t("Settings.FlipBoardAfterMove.Desc"),
            keywords: ["flip", "board", "move"],
            shown: true,
        },
        {
            id: "scroll-moves",
            category: "board",
            title: t("Settings.ScrollThroughMoves"),
            description: t("Settings.ScrollThroughMoves.Desc"),
            keywords: ["scroll", "moves", "wheel"],
            shown: true,
        },
        {
            id: "choose-variation",
            category: "board",
            title: t("Settings.ChooseVariation"),
            description: t("Settings.ChooseVariation.Desc"),
            keywords: ["variation", "branch", "arrow", "keyboard", "continuation"],
            shown: true,
        },
        {
            id: "material-display",
            category: "board",
            title: t("Settings.MaterialDisplay"),
            description: t("Settings.MaterialDisplay.Desc"),
            keywords: ["material", "captured", "pieces", "difference", "hide"],
            shown: true,
        },
        {
            id: "default-panel-tab",
            category: "board",
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
            id: "panels-beside-notation",
            category: "board",
            title: t("Settings.PanelsBesideNotation"),
            description: t("Settings.PanelsBesideNotation.Desc"),
            keywords: [
                "layout",
                "panel",
                "tabs",
                "notation",
                "beside",
                "side",
                "column",
                "annotate",
            ],
            shown: true,
        },
        // Input settings
        {
            id: "text-input",
            category: "inputs",
            title: t("Settings.Inputs.TextInput"),
            description: t("Settings.Inputs.TextInput.Desc"),
            keywords: ["text", "input", "type"],
            shown: true,
        },
        {
            id: "spell-check",
            category: "inputs",
            title: t("Settings.Inputs.SpellCheck"),
            description: t("Settings.Inputs.SpellCheck.Desc"),
            keywords: ["spell", "check", "grammar"],
            shown: true,
        },
        // Appearance settings
        {
            id: "theme",
            category: "appearance",
            title: t("Settings.Appearance.Theme"),
            description: t("Settings.Appearance.Theme.Desc"),
            keywords: ["theme", "dark", "light", "color"],
            shown: true,
        },
        {
            id: "language",
            category: "appearance",
            title: t("Settings.Appearance.Language"),
            description: t("Settings.Appearance.Language.Desc"),
            keywords: ["language", "locale", "translation"],
            shown: true,
        },
        {
            id: "title-bar",
            category: "appearance",
            title: t("Settings.Appearance.TitleBar"),
            description: t("Settings.Appearance.TitleBar.Desc"),
            keywords: ["title", "bar", "native", "custom"],
            shown: showTitleBar,
        },
        {
            id: "font-size",
            category: "appearance",
            title: t("Settings.Appearance.FontSize"),
            description: t("Settings.Appearance.FontSize.Desc"),
            keywords: ["font", "size", "text"],
            shown: true,
        },
        {
            id: "piece-set",
            category: "appearance",
            title: t("Settings.Appearance.PieceSet"),
            description: t("Settings.Appearance.PieceSet.Desc"),
            keywords: ["piece", "set", "style"],
            shown: true,
        },
        {
            id: "piece-size",
            category: "appearance",
            title: t("Settings.Appearance.PieceSize"),
            description: t("Settings.Appearance.PieceSize.Desc"),
            keywords: ["piece", "size", "scale"],
            shown: true,
        },
        {
            id: "board-image",
            category: "appearance",
            title: t("Settings.Appearance.BoardImage"),
            description: t("Settings.Appearance.BoardImage.Desc"),
            keywords: ["board", "image", "texture"],
            shown: true,
        },
        {
            id: "board-wood-texture",
            category: "appearance",
            title: t("Settings.Appearance.WoodTexture"),
            description: t("Settings.Appearance.WoodTexture.Desc"),
            keywords: ["wood", "texture", "grain", "board"],
            shown: true,
        },
        // Repertoire settings
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
        // Sound settings
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
        // Directories settings
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
        // Coach settings
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
        // Advanced settings
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
}

export type SettingId = ReturnType<typeof describeSettings>[number]["id"];
