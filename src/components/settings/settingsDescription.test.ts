import { expect, test } from "vitest";
import { catalogueI18n, shippedCatalogues } from "@/tests/catalogues";
import type { SupportedLocale } from "@/i18n";
import {
    describeSettings,
    SETTING_CATEGORIES,
    settingSearchGroupLabel,
    visibleSettingCategories,
    visibleSettingCategoryGroups,
} from "./settingsDescription";

const identity = (key: string) => key;

test("describeSettings returns unique ids in valid categories with non-empty text and keywords", () => {
    const settings = describeSettings(identity, { platform: "linux", coachEnabled: true });
    const ids = settings.map((setting) => setting.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const setting of settings) {
        expect(SETTING_CATEGORIES).toContain(setting.category);
        expect(setting.title.length).toBeGreaterThan(0);
        expect(setting.description.length).toBeGreaterThan(0);
        expect(setting.keywords.length).toBeGreaterThan(0);
    }
});

test("title-bar is shown only on Windows and Linux", () => {
    const shownFor = (platform: string | undefined) =>
        describeSettings(identity, { platform, coachEnabled: false }).find(
            (setting) => setting.id === "title-bar",
        )?.shown;

    expect(shownFor("linux")).toBe(true);
    expect(shownFor("win32")).toBe(true);
    expect(shownFor("darwin")).toBe(false);
    expect(shownFor(undefined)).toBe(false);
});

test("the coach settings and the coach category follow coachEnabled", () => {
    const withoutCoach = describeSettings(identity, { platform: "linux", coachEnabled: false });
    const withCoach = describeSettings(identity, { platform: "linux", coachEnabled: true });

    for (const id of ["coach-model", "coach-engine"]) {
        expect(withoutCoach.find((setting) => setting.id === id)?.shown).toBe(false);
        expect(withCoach.find((setting) => setting.id === id)?.shown).toBe(true);
    }

    expect(visibleSettingCategories({ coachEnabled: false })).not.toContain("coach");
    expect(visibleSettingCategories({ coachEnabled: true })).toContain("coach");
    expect(visibleSettingCategories({ coachEnabled: false })).toEqual([
        "board",
        "analysis",
        "repertoire",
        "general",
        "sound",
        "keybinds",
        "directories",
        "advanced",
    ]);
    expect(visibleSettingCategories({ coachEnabled: true })).toEqual([
        "board",
        "analysis",
        "repertoire",
        "coach",
        "general",
        "sound",
        "keybinds",
        "directories",
        "advanced",
    ]);
});

test("describeSettings translates titles and descriptions with the supplied translator", async () => {
    const i18n = await catalogueI18n("de-DE");
    const settings = describeSettings((key) => i18n.t(key), {
        platform: "linux",
        coachEnabled: true,
    });
    const volume = settings.find((setting) => setting.id === "volume")!;
    expect(volume.title).toBe(i18n.t("Settings.Sound.Volume"));
    expect(volume.description).toBe(i18n.t("Settings.Sound.Volume.Desc"));
    expect(volume.title).not.toBe("Settings.Sound.Volume");
});

test("board and analysis rows keep the specified group membership and order", () => {
    const settings = describeSettings(identity, { platform: "linux", coachEnabled: true });
    const idsFor = (category: string, group: string) =>
        settings
            .filter((setting) => setting.category === category && setting.group === group)
            .map((setting) => setting.id);

    expect(idsFor("board", "look")).toEqual([
        "board-image",
        "board-wood-texture",
        "piece-set",
        "piece-size",
        "coordinates",
        "animation-speed",
    ]);
    expect(idsFor("board", "highlights")).toEqual([
        "piece-dest",
        "move-highlight",
        "move-highlight-color",
        "move-highlight-opacity",
    ]);
    expect(idsFor("board", "movingPieces")).toEqual([
        "move-method",
        "text-input",
        "auto-promote",
        "flip-board-after-move",
    ]);
    expect(idsFor("board", "arrowsDrawing")).toEqual([
        "arrows",
        "variation-arrows",
        "snap-arrows",
        "consecutive-arrows",
        "erase-drawables",
    ]);
    expect(idsFor("analysis", "notation")).toEqual([
        "move-notation",
        "material-display",
        "hide-preview-moves",
    ]);
    expect(idsFor("analysis", "navigating")).toEqual([
        "scroll-moves",
        "choose-variation",
        "preview-board",
    ]);
    expect(idsFor("analysis", "layoutSaving")).toEqual([
        "default-panel-tab",
        "board-layout",
        "auto-save",
    ]);
    expect(
        settings.filter((setting) => setting.category === "general").map((setting) => setting.id),
    ).toEqual(["language", "theme", "font-size", "title-bar", "spell-check"]);
    expect(
        settings
            .filter((setting) => setting.category === "general")
            .every((setting) => setting.group === undefined),
    ).toBe(true);
    expect(
        settings.filter((setting) => setting.category === "advanced").map((setting) => setting.id),
    ).toEqual(["restore-open-tabs", "reload", "clear-saved-data", "open-logs"]);
    expect(settings.find((setting) => setting.id === "restore-open-tabs")).toMatchObject({
        category: "advanced",
        title: "Settings.Advanced.RestoreOpenTabs",
        description: "Settings.Advanced.RestoreOpenTabs.Desc",
        shown: true,
    });
});

test("search headings include the content group when the row has one", () => {
    expect(settingSearchGroupLabel(identity, { category: "board", group: "highlights" })).toBe(
        "Settings.Board · Settings.Group.Highlights",
    );
    expect(settingSearchGroupLabel(identity, { category: "general" })).toBe("Settings.General");
});

test("sidebar groups drop Coach when it is disabled", () => {
    const withCoach = visibleSettingCategoryGroups({ coachEnabled: true });
    expect(withCoach.map((group) => group.id)).toEqual(["chess", "app"]);
    expect(withCoach[0]?.categories).toEqual(["board", "analysis", "repertoire", "coach"]);
    expect(visibleSettingCategoryGroups({ coachEnabled: false })[0]?.categories).toEqual([
        "board",
        "analysis",
        "repertoire",
    ]);
});

test("all 16 catalogues translate Restore open tabs at start and keep ChessRiddle Studio untranslated", async () => {
    const enTitle = "Restore open tabs at start";
    const enDesc =
        "Reopen your tabs, their order and each game's position when ChessRiddle Studio starts. When off, only games with unsaved changes come back.";
    for (const { locale } of shippedCatalogues()) {
        const i18n = await catalogueI18n(locale as SupportedLocale);
        const row = describeSettings((key) => i18n.t(key), {
            platform: "linux",
            coachEnabled: true,
        }).find((setting) => setting.id === "restore-open-tabs");
        expect(row).toBeDefined();
        expect(row!.title.length).toBeGreaterThan(0);
        expect(row!.description).toContain("ChessRiddle Studio");
        const english = locale === "en-US" || locale === "en-GB";
        expect({
            locale,
            title: row!.title === enTitle,
            description: row!.description === enDesc,
        }).toEqual({ locale, title: english, description: english });
    }
});
