---
id: import-game
title: Partie importieren
summary: Importiere eine Partie aus einer PGN-Datei, eingefügtem PGN-Text, einer Lichess- oder Chess.com-URL, einer FEN-Stellung oder Fotos oder PDF-Scans eines handgeschriebenen Partieformulars.
source: 2a3b47d982e0f514
---

Um eine Partie oder Stellung zu importieren, öffne [[page:new-tab]] und klicke auf {{label:Home.Card.ImportGame.Button}}, um den Dialog {{label:Home.Card.ImportGame.Title}} zu öffnen. Du kannst eine PGN-Datei auch direkt über {{label:Menu.File}} -> {{label:Menu.File.OpenFile}} (oder das Tastenkürzel {{label:Settings.Keybinds.Actions.OPEN_FILE}}) öffnen.

Wähle im Dialog {{label:Home.Card.ImportGame.Title}} eine der Optionen:
- **PGN**: Wähle eine {{label:Common.PGNFile}} von deinem Computer oder füge Text in {{label:Common.PGNGame}} ein. Aktiviere {{label:Import.SaveToCollection}}, um eine Kopie in deinem Workspace-Ordner in [[page:library]] zu sichern, gib dann einen {{label:Common.Name}} ein und wähle einen {{label:Files.FileType}}.
- **{{label:Import.Online}}**: Füge eine Lichess- oder Chess.com-{{label:Import.GameURL}} ein, um die Partie abzurufen und auf einem Analysebrett zu öffnen.
- **FEN**: Füge einen FEN-String ein, um ein Analysebrett ab dieser Stellung zu öffnen.
- **{{label:Import.FromPhoto}}** (wenn KI-Funktionen verfügbar sind): Lasse 1 bis 4 Fotos oder PDF-Seiten eines handgeschriebenen Partieformulars in eine neue Partie übertragen. Dafür ist mindestens eine KI-Verbindung unter [[settings-category:coach]] ({{label:Settings.AI}}) nötig.

Für PGN, {{label:Import.Online}} und FEN klicke auf {{label:Home.Card.ImportGame.Button}}, um die Partie in den aktuellen Tab zu laden.

So importierst du mit **{{label:Import.FromPhoto}}**:
- Füge bis zu 4 JPEG-, PNG- oder WebP-Fotos oder PDF-Seiten über {{label:Scoresheet.Intake.ChoosePhotos}}, {{label:Scoresheet.Intake.PasteFromClipboard}} (oder Strg+V / Cmd+V bei geöffnetem Bereich) hinzu oder ziehe Fotos oder PDF-Dateien per Drag-and-drop in den geöffneten Bereich. Einfügen funktioniert nur mit Fotos. Jede PDF-Seite zählt als ein Foto; bei einer längeren PDF werden die ersten Seiten verwendet.
- Wähle die KI-Verbindung und ein bildfähiges Modell über die Modell-Schaltfläche oder unter [[setting:coach-model]] ({{label:Settings.Coach.Model}}).
- Klicke auf {{label:Scoresheet.Read.Button}}, um zu starten. Vor dem ersten Einlesen über eine Verbindung erklärt {{label:Scoresheet.Notice.Title}}, dass die ausgewählten Fotos (einschließlich Spielernamen und allem Weiteren auf dem Formular) an diesen Anbieter gesendet werden, Metadaten wie der Kamerastandort zuvor entfernt werden und keine weiteren Daten gesendet wurden.
- Studio prüft jeden Zug ab der Grundstellung nach den Standard-Schachregeln und öffnet die Partie in einem neuen, ungesicherten Analyse-Tab mit dem Bereich {{label:Board.Tabs.Photo}} neben dem Brett.
- Unsichere oder korrigierte Züge sind in der Notation markiert. Springe im Bereich {{label:Board.Tabs.Photo}} durch diese Züge und klicke nach der Prüfung jeweils auf {{label:Scoresheet.MarkAsChecked}}. Wenn du einen Zug mittendrin korrigierst oder nach einem Stopp weitermachst, spiele die folgenden legalen Züge des Formulars mit {{label:Scoresheet.ContinueWithSheet}} nach. Klicke am Ende auf {{label:Scoresheet.FinishReview}}, um übrige Markierungen zu entfernen.
- Sichere die Partie über den normalen Speicherweg in eine Datei oder Datenbank ({{label:Menu.File}} -> {{label:Common.Save}}, die Speichern-Schaltfläche oder {{label:Board.Database.Save}}).
- Fotos bleiben nur im Arbeitsspeicher (für bis zu 4 geöffnete Tabs) und werden nicht auf der Festplatte gespeichert; nach einem Neuladen oder Neustart bleiben Partie und Prüfmarkierungen erhalten, und du kannst das Foto über {{label:Scoresheet.LoadPhotoAgain}} im Bereich {{label:Board.Tabs.Photo}} erneut anzeigen, ohne es zu senden.
