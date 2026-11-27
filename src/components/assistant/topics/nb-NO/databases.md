---
id: databases
title: Databaser, utforsker, stillingssøk, spillere og turneringer
summary: Legg til eller last ned partidatabaser, velg en referansedatabase, søk etter stillinger i utforskeren og bla gjennom partier, spillere og turneringer.
source: 9d4f20d7213a7cbb
---

Databaser ligger i [[page:library]] ({{label:SideBar.Library}}) sammen med PGN-filene dine, og lagres i [[setting:databases-directory]].

For å legge til en database åpner du [[page:library]] og klikker {{label:Library.AddDatabase}}:
- {{label:Databases.Add.Web}}: last ned utvalgte partidatabaser fra katalogen.
- {{label:Common.Local}}: velg en lokal PGN-fil (inkludert `.pgn.zst` eller `.pgn.bz2`), skriv inn et {{label:Common.Name}} og en valgfri {{label:Common.Description}}, og klikk {{label:Databases.Add.Convert}}.

Velg en database i [[page:library]] for å administrere den:
- Kryss av for {{label:Databases.Settings.ReferenceDatabase}} for å gjøre den til standard referansedatabase for utforskeren, repertoarbyggeren, nyheter i partirapporten og Coach.
- Kryss av for {{label:Databases.Settings.Indexed}} for å opprette eller fjerne søkeindekser for raskere oppslag.
- Klikk {{label:Databases.Settings.Explore}} for å åpne tabellvisningen av databasen.
- Under {{label:Databases.Settings.Actions}} kan du bruke {{label:Databases.Settings.AddGames}} til å legge til PGN-filer, {{label:Databases.Settings.ExportPGN}} til å eksportere til PGN, eller {{label:Common.Delete}} for å fjerne databasen.
- Under {{label:Databases.Settings.AdvancedTools}} kan du bruke {{label:Databases.Settings.MergePlayers}} til å slå sammen dupliserte spilleroppføringer, eller {{label:Databases.Settings.RemoveDup}} og {{label:Databases.Settings.RemoveEmpty}} til å rydde opp i partier.

Inne i tabellvisningen av databasen bytter du mellom {{label:Common.Games}}, {{label:Databases.Card.Players}} og {{label:Databases.Settings.Events}} (turneringer):
- Søk og sorter partier, forhåndsvis et parti (forhåndsvisningen kan skjule trekkene med øyeknappen, [[setting:hide-preview-moves]]) eller åpne det på analysebrettet.
- Under {{label:Databases.Card.Players}} velger du en spiller for å se {{label:Home.Personal.Overview}}, {{label:Home.Personal.Ratings}} og {{label:Home.Personal.Openings}} (et interaktivt åpningstre), pluss FIDE-info via {{label:Databases.FIDE.Info}}. Bruk {{label:Databases.OpeningTree.Prepare}} på {{label:Home.Personal.Overview}} og {{label:Home.Personal.Ratings}} for å åpne utgangsstillingen som hvit med alle partier, eller på {{label:Home.Personal.Openings}} for å ta med valgt linje, farge og {{label:Databases.OpeningTree.Since}}-periode.
- Under {{label:Databases.Settings.Events}} kan du søke etter turneringer på navn og sortere etter dato, spillere, partier eller gjennomsnittsrating.

På spillerkortet åpner du fanen {{label:Home.Personal.Preparation}} for å sammenligne partiene med repertoarfilene dine:
- Velg motstanderens farge, perioden {{label:Databases.OpeningTree.Since}} og (når nettkontoer er koblet til) {{label:Databases.OpeningTree.OverTheBoard}}, {{label:Databases.OpeningTree.Online}} eller {{label:Databases.Preparation.Both}}. Klikk {{label:Databases.Preparation.Refresh}} for å kjøre sammenligningen på nytt, eller klikk {{label:Databases.OpeningTree.Prepare}} for å åpne utgangsstillingen på et analysebrett med fanens farge og {{label:Databases.OpeningTree.Since}}-periode.
- Øk {{label:Databases.Preparation.MinGames}} for å skjule linjer og hull motstanderen bare sjelden har spilt; filen din folder disse linjene sammen, og treningen utelater dem.
- Gå gjennom variantene motstanderen spiller og {{label:Databases.Preparation.GapsTitle}}. Klikk en rad for å åpne repertoarfilen din i den stillingen med andre sidevarianter skjult; bytt mellom {{label:Notation.PreparationOpponentLines}} og {{label:Notation.PreparationAllLines}} i notasjonshodet.
- Klikk {{label:Databases.Preparation.TrainLines}} for å starte en tidsbegrenset økt over disse variantene; svarene dine oppdaterer den vanlige repetisjonsplanen.
- For å forberede deg mot en motstander som bare har en Lichess- eller Chess.com-konto, klikker du {{label:Library.OnlineOpponent}} i [[page:library]] for å slå opp kontoen, laste ned partiene og åpne kortet direkte på fanen {{label:Home.Personal.Preparation}} (skriver du inn den samme kontoen igjen, åpnes det på nytt uten ny nedlasting).

På analysebrettet åpner du {{label:Board.Tabs.Database}} for å bruke åpningsutforskeren:
- Velg {{label:Board.Database.LichessAll}} eller {{label:Board.Database.LichessMaster}} i kildemenyen og i {{label:Board.Database.Compare}} (nettutforskerne for Lichess krever en innlogget Lichess-konto på [[page:accounts]]).
- {{label:Board.Database.Stats}} (trekkstatistikk) vises øverst og {{label:Board.Database.Games}} (samsvarende partier) nederst; mens begge områdene vises, kan du dra skillelinjen mellom dem for å fordele høyden. Bruk {{label:Board.Database.HideGames}} eller {{label:Board.Database.ShowGames}} for å skjule eller vise partilisten, og tannhjulet for innstillinger til å åpne eller folde sammen kildekontrollene — begge ligger i panelhodet når panelet er en egen flis, og på den øverste kontrollraden når det ligger i fanene. Kolonnen {{label:Board.Area.Notation}} viser trekkene fra stillingen på brettet, med det neste trekket i fet skrift.
- Klikk {{label:Board.Database.Compare}} for å vise to kilder side ved side, eller åpne {{label:Board.Database.Local.Position}} for å bytte mellom {{label:Board.Database.Local.Exact}} og {{label:Board.Database.Local.Partial}} stillingssøk (inkludert {{label:Board.Database.Local.SimilarStructure}} for bondestruktursøk og {{label:Fen.Empty}} for egendefinerte mønstre).
- Du kan også vise {{label:Board.Tabs.Database}} som et eget område på analysebrettet og bruke {{label:Board.Area.ReturnToTabs}} for å legge den tilbake i fanene.
- Når {{label:Databases.OpeningTree.Prepare}} åpner et brett for en databasespiller, starter utforskeren med referansedatabasen din som en ekstra kolonne ved siden av motstanderens partier; klikk {{label:Board.Database.RemoveReference}} for å skjule en kolonne eller {{label:Board.Database.AddColumn}} for å legge til en til.
