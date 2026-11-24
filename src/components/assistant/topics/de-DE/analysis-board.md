---
id: analysis-board
title: Analysebrett, Varianten, Kommentare und Pfeile
summary: Züge eingeben, Stellungen bearbeiten, Varianten verwalten, Kommentare schreiben, Annotationen setzen und Pfeile auf dem Brett zeichnen.
source: 14ba83ba3068d6ed
---

Öffne ein Analysebrett über [[page:new-tab]] mit einem Klick auf {{label:Home.Card.AnalysisBoard.Title}} oder indem du eine gespeicherte Partie oder ein Repertoire aus [[page:library]] öffnest.

Führe Züge durch Ziehen oder Klicken der Figuren aus (einstellbar unter [[setting:move-method]]). Du kannst auch [[setting:text-input]] ({{label:Settings.Inputs.TextInput}}) aktivieren, um Züge in SAN-Notation einzutippen. Nutze die Zugsteuerung unter der Notation, die Pfeiltasten oder das Mausrad (wenn [[setting:scroll-moves]] aktiv ist), um durch die Züge zu blättern.

Die Werkzeugleiste neben der Notation bietet folgende Brett-Aktionen:
- {{label:Board.Action.TakeSnapshot}}: Ein Bild der aktuellen Stellung sichern.
- {{label:Board.Action.EditPosition}}: Eine eigene Stellung durch Setzen von Figuren oder Bearbeiten der FEN aufbauen.
- {{label:Board.Action.PlayFromHere}}: Eine Partie ab der aktuellen Stellung starten.
- {{label:Board.Action.ClearDrawings}}: Pfeile und Feldmarkierungen entfernen (sichtbar, wenn [[setting:erase-drawables]] deaktiviert ist).
- {{label:Board.Database.Save}}: Die Partie in einer Bibliotheksdatei oder Datenbank speichern.
- Steuerung für Rückgängig, Wiederholen, Speichern und Brett drehen.

Wenn du in einer früheren Stellung einen anderen Zug spielst, entsteht eine Variante. Klicke mit der rechten Maustaste auf einen Zug in der Notation für {{label:Menu.PromoteVariation}}, {{label:Menu.PromoteToMainLine}}, {{label:Menu.CopyVariationPGN}}, {{label:Menu.DeleteMove}}, {{label:Board.Action.PlayFromHere}}, {{label:Notation.AddDiagram}} oder {{label:Notation.MarkGameEndHere}}. Über die Schaltflächen in der Notationskopfzeile schaltest du {{label:Notation.HideMoves}}, {{label:Notation.TableView}}, {{label:Notation.HideComments}}, {{label:Notation.HideDiagrams}} und {{label:Notation.HideVariations}} um.

Um Züge zu bewerten und Kommentare zu schreiben, öffne den Tab {{label:Board.Tabs.Annotate}}. Klicke auf ein Zugbewertungssymbol (oder drücke die Tasten 1 bis 6), um `!!`, `!`, `!?`, `?!`, `?` oder `??` umzuschalten, oder klicke auf {{label:Annotate.ShowMore}} für Stellungs- und Bewertungssymbole. Darunter kannst du mit dem Rich-Text-Editor formatierte Kommentare verfassen und Inline-Brettdiagramme einfügen.

Um Pfeile zu zeichnen und Felder hervorzuheben, ziehe mit gedrückter rechter Maustaste auf dem Brett (oder rechtsklicke ein Feld für einen Kreis). Halte Zusatztasten für weitere Farben gedrückt: Umschalttaste für {{label:Settings.Drawing.Red}}, Alt für {{label:Settings.Drawing.Blue}}, Umschalt+Alt für {{label:Settings.Drawing.Yellow}}, Strg (Cmd unter macOS) für {{label:Settings.Drawing.Orange}} und Strg+Alt (Cmd+Alt unter macOS) für {{label:Settings.Drawing.Cyan}}. Die vollständige Zeichenliste findest du unter [[settings-category:keybinds]].

Der Tab {{label:Board.Tabs.Info}} zeigt Partieköpfe, FEN, PGN-Text und Baumstatistiken und lässt dich zwischen Partien einer Mehrpartien-PGN-Datei wechseln.
