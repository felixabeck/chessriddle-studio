import { expect, test } from "vitest";
import deDECatalogue from "@/translation/de-DE.json";
import enUSCatalogue from "@/translation/en-US.json";

const de = deDECatalogue.translation;
const en = enUSCatalogue.translation;

test("de-DE and en-US catalogues ship the save-copy, origin-update, and save-status strings", () => {
    expect(en["Board.Database.Save"]).toBe("Save a copy…");
    expect(en["Settings.Keybinds.Actions.SAVE_TO_DATABASE"]).toBe("Save a copy");
    expect(en["Board.Database.UpdateThisGame"]).toBe("Update this game");
    expect(en["Board.Database.UpdateThisGameHint"]).toBe(
        "This is the current game. Saving will update it.",
    );
    expect(en["Board.SaveStatus.Saved"]).toBe("Saved");
    expect(en["Board.SaveStatus.Saving"]).toBe("Saving…");

    expect(de["Board.Database.Save"]).toBe("Als Kopie speichern…");
    expect(de["Settings.Keybinds.Actions.SAVE_TO_DATABASE"]).toBe("Als Kopie speichern");
    expect(de["Board.Database.UpdateThisGame"]).toBe("Diese Partie aktualisieren");
    expect(de["Board.Database.UpdateThisGameHint"]).toBe(
        "Das ist die aktuelle Partie. Speichern überschreibt sie.",
    );
    expect(de["Board.SaveStatus.Saved"]).toBe("Gespeichert");
    expect(de["Board.SaveStatus.Saving"]).toBe("Speichern…");
});

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
    // Candidates: Spiel, Spiele, Spiels and compounds such as Spieldatei. Spieler… compounds
    // (Spielerin, Spielerinfo) and the verb spielen are never candidates.
    const suspectTerm = /Spiel(?!er|en\b)|\bPosition(en)?\b/;
    // Forms of the verb spielen, plus Spielstärke/Spielphase compounds.
    const legitimateSpielUses: Record<string, string> = {
        "Board.Action.PlayFromHere": "Spiele von hier",
        "Board.Analysis.Report.NeedsMoves":
            "Ein Bericht braucht Züge. Spiele oder lade zuerst eine Partie.",
        "Board.Database.Local.PlaysAs": "Spielt mit",
        "Board.Practice.Alternative": "Der Zug gehört zu deinem Repertoire. Spiele den Hauptzug.",
        "Board.Practice.MarkStart":
            "Spiele einige Züge und markiere Start, sobald du die Ausgangsstellung der gewünschten Eröffnung erreichst.",
        "Board.Practice.PlayRevealedMove":
            "Spiele {{move}} auf dem Brett oder drücke die Leertaste",
        "Engines.Options.SkillLevel.Label": "Spielstärke-Stufe",
        "Engines.Options.UCI_Elo.Description":
            "Die Spielstärke, die die Engine bei aktiver Begrenzung anstrebt.",
        "Engines.Options.UCI_LimitStrength.Label": "Spielstärke auf eine Elo-Zahl begrenzen",
        "Training.Settings.Categories.Phases": "Spielphase",
    };
    const offenders = Object.entries(de).filter(
        ([key, value]) => suspectTerm.test(value) && legitimateSpielUses[key] !== value,
    );
    expect(offenders).toEqual([]);
});
