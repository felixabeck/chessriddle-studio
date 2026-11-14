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
});

test("de-DE practice empty state and its button name the visible Build tab label", () => {
    expect(de["Board.Practice.NoPositionForTrain1"]).toContain(de["Board.Practice.Build"]);
    expect(de["Board.Practice.GoToBuild"]).toContain(de["Board.Practice.Build"]);
});

test("de-DE catalogue never says Spiel or Position for a chess game or position", () => {
    // Catches Spiel, Spiele, Spiels and compounds such as Spieldatei while leaving Spieler and the verb spielen alone.
    const wrongTerm = /Spiel(?!er|en\b)|\bPosition(en)?\b/;
    // Imperative of spielen, plus Spielstärke/Spielphase/Spielsteuerung compounds.
    const legitimateSpielUses: Record<string, string> = {
        "Board.Action.PlayFromHere": "Spiele von hier",
        "Board.Practice.Alternative": "Der Zug gehört zu deinem Repertoire. Spiele den Hauptzug.",
        "Board.Practice.MarkStart":
            "Spiele einige Züge und markiere Start, sobald du die Ausgangsstellung der gewünschten Eröffnung erreichst.",
        "Board.Practice.PlayRevealedMove":
            "Spiele {{move}} auf dem Brett oder drücke die Leertaste",
        "Engines.Options.SkillLevel.Label": "Spielstärke-Stufe",
        "Engines.Options.UCI_Elo.Description":
            "Die Spielstärke, die die Engine bei aktiver Begrenzung anstrebt.",
        "Engines.Options.UCI_LimitStrength.Label": "Spielstärke auf eine Elo-Zahl begrenzen",
        "Settings.Board.Desc": "Passe das Analysebrett und die Spielsteuerung an",
        "Training.Settings.Categories.Phases": "Spielphase",
    };
    const offenders = Object.entries(de).filter(
        ([key, value]) => wrongTerm.test(value) && legitimateSpielUses[key] !== value,
    );
    expect(offenders).toEqual([]);
});
