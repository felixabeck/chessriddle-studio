import { expect, test } from "vitest";
import i18n, { initializeI18n } from "./i18n";

test("installs the unwrapped en-US catalogue for runtime translations", async () => {
    await initializeI18n();
    await i18n.changeLanguage("en-US");

    expect(i18n.t("Home.Card.AnalysisBoard.Title")).toBe("Analysis Board");
});
