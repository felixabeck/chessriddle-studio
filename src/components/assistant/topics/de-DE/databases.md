---
id: databases
title: Datenbanken, Explorer, Stellungssuche, Spieler und Turniere
summary: Partiedatenbanken hinzufügen oder herunterladen, Referenzdatenbank wählen, Stellungen im Explorer suchen sowie Partien, Spieler und Turniere durchsuchen.
source: 48c72137fadc1768
---

Datenbanken befinden sich neben deinen PGN-Dateien in [[page:library]] ({{label:SideBar.Library}}) und werden unter [[setting:databases-directory]] gespeichert.

Um eine Datenbank hinzuzufügen, öffne [[page:library]] und klicke auf {{label:Library.AddDatabase}}:
- {{label:Databases.Add.Web}}: Kuratierte Partiedatenbanken aus dem Katalog herunterladen.
- {{label:Common.Local}}: Eine lokale PGN-Datei auswählen (einschließlich `.pgn.zst` oder `.pgn.bz2`), {{label:Common.Name}} und optional eine {{label:Common.Description}} eingeben und auf {{label:Databases.Add.Convert}} klicken.

Wähle eine Datenbank in [[page:library]] aus, um sie zu verwalten:
- Aktiviere {{label:Databases.Settings.ReferenceDatabase}}, um sie zur Standard-Referenzdatenbank für den Explorer, den Repertoire-Aufbau, Neuerungen im Partiebericht und den Coach zu machen.
- Aktiviere {{label:Databases.Settings.Indexed}}, um Suchindizes für schnellere Abfragen anzulegen oder zu entfernen.
- Klicke auf {{label:Databases.Settings.Explore}}, um die Tabellenansicht der Datenbank zu öffnen.
- Nutze unter {{label:Databases.Settings.Actions}} die Optionen {{label:Databases.Settings.AddGames}} zum Anhängen von PGN-Dateien, {{label:Databases.Settings.ExportPGN}} für den PGN-Export oder {{label:Common.Delete}}, um die Datenbank zu entfernen.
- Nutze unter {{label:Databases.Settings.AdvancedTools}} die Funktionen {{label:Databases.Settings.MergePlayers}} zum Zusammenführen doppelter Spielereinträge sowie {{label:Databases.Settings.RemoveDup}} und {{label:Databases.Settings.RemoveEmpty}} zum Bereinigen von Partien.

Wechsle in der Tabellenansicht der Datenbank zwischen {{label:Common.Games}}, {{label:Databases.Card.Players}} und {{label:Databases.Settings.Events}} (Turnieren):
- Durchsuche und sortiere Partien, sieh dir eine Vorschau an oder öffne sie auf dem Analysebrett.
- Wähle unter {{label:Databases.Card.Players}} einen Spieler aus, um {{label:Home.Personal.Overview}}, {{label:Home.Personal.Ratings}} und {{label:Home.Personal.Openings}} (einen interaktiven Eröffnungsbaum mit der Schaltfläche {{label:Databases.OpeningTree.Prepare}}) sowie FIDE-Daten über {{label:Databases.FIDE.Info}} einzusehen.
- Suche unter {{label:Databases.Settings.Events}} Turniere nach Namen und sortiere nach Datum, Spielern, Partien oder Durchschnitts-Elo.

Öffne auf dem Analysebrett {{label:Board.Tabs.Database}}, um den Eröffnungs-Explorer zu nutzen:
- Wechsle zwischen {{label:Board.Database.Local}}, {{label:Board.Database.LichessAll}} und {{label:Board.Database.LichessMaster}} (die Online-Explorer von Lichess erfordern ein angemeldetes Lichess-Konto unter [[page:accounts]]).
- Wechsle zwischen {{label:Board.Database.Stats}} (Zugstatistiken) und {{label:Board.Database.Games}} (passende Partien).
- Klicke bei lokalen Datenbanken auf {{label:Board.Database.Compare}}, um zwei Datenbanken nebeneinander anzuzeigen, oder öffne {{label:Board.Database.Local.Position}}, um zwischen {{label:Board.Database.Local.Exact}} und {{label:Board.Database.Local.Partial}} umzuschalten (einschließlich {{label:Board.Database.Local.SimilarStructure}} für die Bauernstruktursuche und {{label:Fen.Empty}} für eigene Muster).
- Nutze {{label:Board.Database.Pin}}, um den Explorer über oder unter dem Brett oder der Notation anzuheften, und {{label:Board.Database.Unpin}}, um ihn in die Tabs zurückzulegen.
