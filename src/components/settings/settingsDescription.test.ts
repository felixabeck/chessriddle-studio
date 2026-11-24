import { expect, test } from "vitest";
import { catalogueI18n } from "@/tests/catalogues";
import {
    describeSettings,
    SETTING_CATEGORIES,
    visibleSettingCategories,
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
    expect(visibleSettingCategories({ coachEnabled: true }).slice(-2)).toEqual([
        "coach",
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
