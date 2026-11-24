---
id: chessbase-import
title: Datenbanken aus ChessBase importieren
summary: Exportiere eine ChessBase-Datenbank nach PGN und konvertiere sie in eine Studio-Datenbank.
source: d7f599a811a0afb0
---

ChessRiddle Studio liest ChessBase-`.cbh`- oder `.cbv`-Dateien nicht direkt. Exportiere deine ChessBase-Datenbank stattdessen zuerst als PGN und konvertiere die PGN-Datei anschließend in eine Studio-Datenbank.

Wenn du in einem Dateidialog eine ChessBase-Datei auswählst, öffnet Studio automatisch den Dialog {{label:ChessBaseGuide.Title}}. Du kannst ihn auch über den Hinweis-Link in {{label:Library.AddDatabase}} unter [[page:library]] öffnen.

Gehe für den Import aus ChessBase so vor:
1. Öffne die Datenbank in ChessBase und markiere die Partien, die du exportieren möchtest.
2. Exportiere oder speichere die markierten Partien in ChessBase als `.pgn`-Datei.
3. Öffne in Studio [[page:library]], klicke auf {{label:Library.AddDatabase}}, wechsle zum Tab {{label:Common.Local}}, wähle die exportierte `.pgn`-Datei, vergib einen {{label:Common.Name}} und klicke auf {{label:Databases.Add.Convert}}.

Nach der Konvertierung erscheint die Datenbank in [[page:library]], wo du Partien, Spieler und Turniere durchsuchen oder sie als deine {{label:Databases.Settings.ReferenceDatabase}} festlegen kannst.
