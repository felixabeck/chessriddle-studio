---
id: library-and-files
title: Dateien und die Bibliothek
summary: Workspace-Ordner einrichten, PGN-Dateien erstellen und ordnen, Partien öffnen und speichern sowie den Papierkorb verwalten.
source: 1c8e1ec37f492b22
---

[[page:library]] ({{label:SideBar.Library}}) führt deine Workspace-PGN-Dateien (Partien, Repertoires, Turniere, Puzzles und sonstige Dateien) mit deinen Partiedatenbanken zusammen.

Bevor du Dateien anlegst, wähle einen Workspace-Ordner aus. Wenn noch kein Ordner festgelegt ist, klicke in [[page:library]] auf {{label:Files.ChooseFolder}} oder richte [[setting:files-directory]] ({{label:Settings.Directories.Files}}) unter [[settings-category:directories]] ein.

In [[page:library]]:
- Klicke auf {{label:Files.CreateFile}}, um eine neue PGN-Datei anzulegen, oder auf {{label:Files.CreateFolder}}, um Dateien in Unterordner zu gliedern.
- Nutze das Eingabefeld {{label:Common.Search}} und das Auswahlmenü {{label:Files.FileType}}, um nach Dateityp oder {{label:Library.GamesDatabase}} zu filtern.
- Wähle eine Datei aus, um eine Vorschau ihrer Partien anzuzeigen (die Vorschau kann ihre Züge mit dem Auge-Button ausblenden, [[setting:hide-preview-moves]]), sie auf dem Analysebrett zu öffnen oder {{label:Files.Rename}}, {{label:Files.Move}} und {{label:Files.Trash}} zu verwenden.

Während du eine Datei auf dem Analysebrett bearbeitest:
- Speichere Änderungen über die Speichern-Schaltfläche in der Brett-Werkzeugleiste, über {{label:Menu.File}} -> {{label:Common.Save}} oder mit dem Tastenkürzel {{label:Settings.Keybinds.Actions.SAVE_FILE}}.
- Aktiviere [[setting:auto-save]] ({{label:Settings.AutoSave}}), um Änderungen an geöffneten Dateien automatisch zu sichern.
- Nutze {{label:Menu.File}} -> {{label:Board.Database.Save}} (oder die Schaltfläche {{label:Board.Database.Save}} in der Werkzeugleiste), um die aktuelle Partie in einer anderen Bibliotheksdatei oder Datenbank zu speichern.

Das Verschieben einer Datei in {{label:Files.Trash}} löscht sie nicht sofort endgültig. Du kannst im Hinweis direkt auf {{label:Common.Undo}} klicken oder in [[page:library]] zum Bereich {{label:Files.Trash}} scrollen, um eine Datei mit {{label:Files.Restore}} wiederherzustellen, sie mit {{label:Files.DeletePermanently}} zu entfernen oder {{label:Files.EmptyTrash}} auszuführen.

Wenn dein ChessRiddle-Konto verbunden ist, klicke in [[page:library]] auf {{label:Library.Sync.Action}}, um ausgewählte PGN-Dateien in deine private Bibliothek auf ChessRiddle zu synchronisieren (bis zu 100 Dateien, 5 MB und 40.000 Züge pro Datei). Änderungen, Umbenennungen, Abwahlen und Löschungen werden automatisch übernommen; heruntergeladene Partieverläufe und Partiedatenbanken bleiben lokal. Beim Ausschalten kannst du entscheiden, ob die synchronisierten Dateien auf ChessRiddle behalten oder entfernt werden.
