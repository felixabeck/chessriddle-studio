import { beforeEach, describe, expect, test, vi } from "vitest";
import { resolveSupportedLocale } from "./i18n";

const { init, changeLanguage, addResourceBundle, hasResourceBundle } = vi.hoisted(() => ({
    init: vi.fn().mockResolvedValue(undefined),
    changeLanguage: vi.fn().mockResolvedValue(undefined),
    addResourceBundle: vi.fn(),
    hasResourceBundle: vi.fn().mockReturnValue(false),
}));

vi.mock("i18next", () => ({
    default: {
        use: vi.fn().mockReturnThis(),
        init,
        changeLanguage,
        addResourceBundle,
        hasResourceBundle,
    },
}));

describe("i18n catalogue loading", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        hasResourceBundle.mockReturnValue(false);
        window.localStorage.clear();
        vi.resetModules();
    });

    test("loads the selected catalogue and en-US fallback only", async () => {
        const { changeLocale } = await import("./i18n");

        await expect(changeLocale("de-DE")).resolves.toBe("de-DE");

        expect(addResourceBundle).toHaveBeenCalledTimes(2);
        expect(addResourceBundle.mock.calls.map(([locale]) => locale).sort()).toEqual([
            "de-DE",
            "en-US",
        ]);
        expect(
            addResourceBundle.mock.calls.every(
                ([, , catalogue]) => "Home.Card.AnalysisBoard.Title" in catalogue,
            ),
        ).toBe(true);
        expect(changeLanguage).toHaveBeenCalledWith("de-DE");
    });

    test("normalizes aliases and falls back deterministically", async () => {
        expect(resolveSupportedLocale("de_DE")).toBe("de-DE");
        expect(resolveSupportedLocale("fr-CA")).toBe("fr-FR");
        expect(resolveSupportedLocale("unsupported")).toBe("en-US");
    });

    test("initialization honors the persisted language", async () => {
        window.localStorage.setItem("i18nextLng", "zh-TW");
        const { initializeI18n } = await import("./i18n");

        await initializeI18n();

        expect(init).toHaveBeenCalledTimes(1);
        expect(changeLanguage).toHaveBeenCalledWith("zh-TW");
    });
});
