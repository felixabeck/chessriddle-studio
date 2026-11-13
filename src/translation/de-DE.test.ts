import { expect, test } from "vitest";
import deDECatalogue from "@/translation/de-DE.json";

const de = deDECatalogue.translation;

test("de-DE catalogue uses real German copy for previously untranslated keys", () => {
    expect(de["Home.Accounts.Empty.Description"]).not.toBe("Beschreibung");
    expect(de["Home.Accounts.Empty.Description"]).toContain("Lichess");
    expect(de["Home.Accounts.PlayerName.Desc"]).not.toMatch(/absteigend/i);
    expect(de["Home.Accounts.LoginWithBrowser.Desc"]).not.toMatch(/absteigend/i);
    expect(de["Board.Analysis.ShowVariations.Desc"]).not.toMatch(/absteigend/i);
    expect(de["Databases.FIDE.Title"]).not.toBe("Titel");
    expect(de["Databases.FIDE.Title"]).toContain("FIDE");
    expect(de["Board.Practice.AgainHint"]).not.toContain("Hinweis");
    expect(de["Board.Practice.NoPositionForTrain1"]).toContain(de["Board.Practice.Build"]);
});
