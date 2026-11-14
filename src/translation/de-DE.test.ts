import { expect, test } from "vitest";
import deDECatalogue from "@/translation/de-DE.json";

const de = deDECatalogue.translation;

test("de-DE catalogue no longer carries placeholder or wrong-meaning values", () => {
    expect(de["Home.Accounts.Empty.Description"]).not.toBe("Beschreibung");
    expect(de["Home.Accounts.Empty.Description"]).toContain("Lichess");
    expect(de["Home.Accounts.PlayerName.Desc"]).not.toMatch(/absteigend/i);
    expect(de["Home.Accounts.LoginWithBrowser.Desc"]).not.toMatch(/absteigend/i);
    expect(de["Board.Analysis.ShowVariations.Desc"]).not.toMatch(/absteigend/i);
    expect(de["Databases.FIDE.Title"]).not.toBe("Titel");
    expect(de["Databases.FIDE.Title"]).toContain("FIDE");
    expect(de["Board.Practice.AgainHint"]).not.toBe("Hinweis erneut zeigen");
    expect(de["Settings.Directories.Puzzles.Desc"]).not.toMatch(/Spiele/);
});

test("de-DE practice empty state names the visible Build tab label", () => {
    expect(de["Board.Practice.NoPositionForTrain1"]).toContain(de["Board.Practice.Build"]);
});

test("de-DE catalogue uses Stellung and Partie for chess positions and games", () => {
    const wrongTerms = /\b(Spiel|Spiels|Position|Positionen)\b/;
    const disallowedSpiele = /(?<!^|[.!?]\s)\bSpiele\b/;
    const offenders = Object.entries(de).filter(
        ([, value]) => wrongTerms.test(value) || disallowedSpiele.test(value),
    );
    expect(offenders).toEqual([]);
});
