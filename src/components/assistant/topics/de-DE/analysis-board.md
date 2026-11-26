---
id: analysis-board
title: Analysebrett, Varianten, Kommentare und Pfeile
summary: Züge eingeben, Stellungen bearbeiten, Varianten verwalten, Kommentare schreiben, Annotationen setzen und Pfeile auf dem Brett zeichnen.
source: c4040958465a3812
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

Wenn du in einer früheren Stellung einen anderen Zug spielst, entsteht eine Variante. Klicke mit der rechten Maustaste auf einen Zug in der Notation für {{label:Menu.PromoteVariation}}, {{label:Menu.PromoteToMainLine}}, {{label:Menu.CopyVariationPGN}}, {{label:Menu.DeleteMove}}, {{label:Menu.DeleteVariation}}, {{label:Menu.DeleteMovesAfter}}, {{label:Board.Action.PlayFromHere}}, {{label:Notation.AddDiagram}} oder {{label:Notation.MarkGameEndHere}}. Über die Schaltflächen in der Notationskopfzeile schaltest du {{label:Notation.HideMoves}}, {{label:Notation.TableView}}, {{label:Notation.HideComments}}, {{label:Notation.HideDiagrams}} und {{label:Notation.HideVariations}} um.

Um Züge zu bewerten und Kommentare zu schreiben, öffne den Tab {{label:Board.Tabs.Annotate}}. Klicke auf ein Zugbewertungssymbol (oder drücke die Tasten 1 bis 6), um `!!`, `!`, `!?`, `?!`, `?` oder `??` umzuschalten, oder klicke auf {{label:Annotate.ShowMore}} für Stellungs- und Bewertungssymbole. Darunter kannst du mit dem Rich-Text-Editor formatierte Kommentare verfassen und Inline-Brettdiagramme einfügen.

Um Pfeile zu zeichnen und Felder hervorzuheben, ziehe mit gedrückter rechter Maustaste auf dem Brett (oder rechtsklicke ein Feld für einen Kreis). Halte Zusatztasten für weitere Farben gedrückt: Umschalttaste für {{label:Settings.Drawing.Red}}, Alt für {{label:Settings.Drawing.Blue}}, Umschalt+Alt für {{label:Settings.Drawing.Yellow}}, Strg (Cmd unter macOS) für {{label:Settings.Drawing.Orange}} und Strg+Alt (Cmd+Alt unter macOS) für {{label:Settings.Drawing.Cyan}}. Die vollständige Zeichenliste findest du unter [[settings-category:keybinds]].

Der Tab {{label:Board.Tabs.Info}} zeigt Partieköpfe, FEN, PGN-Text und Baumstatistiken und lässt dich zwischen Partien einer Mehrpartien-PGN-Datei wechseln.

Um das Analysebrett anzuordnen, ziehe einen Panel-Tab ({{label:Board.Tabs.Analysis}}, {{label:Board.Tabs.Database}}, {{label:Board.Tabs.Annotate}}, {{label:Board.Tabs.Coach}} oder {{label:Board.Tabs.Info}}) oder nutze die Griff-Schaltflächen in der Tab-Leiste, in der Notationskopfzeile oder im Kopf eines Panel-Bereichs, um Bereiche mit Vorschau oder per Tastatur neben, über oder unter einem anderen Bereich zu platzieren. Um ein Panel über zwei Bereiche zu spannen (etwa {{label:Board.Tabs.Database}} über Notation und Tabs), platziere das Panel zuerst über einem der beiden und verschiebe dann den anderen daneben. Mit {{label:Board.Area.ReturnToTabs}} oder durch Zurückziehen auf die Tab-Leiste kehrst du einen Bereich in die Tabs zurück, und [[setting:board-layout]] ({{label:Settings.BoardLayout.Reset}}) stellt die Standardanordnung wieder her.

Um die Tabs auszublenden, etwa wenn jedes genutzte Panel als eigener Bereich angezeigt wird, klicke auf {{label:Board.Area.HideTabs}} unter dem Griff am Ende der Tab-Leiste; die benachbarten Bereiche übernehmen ihren Platz. Die Tabs behalten Position und Größe: Du blendest sie mit der Schaltfläche {{label:Board.Arrange.ShowTabs}}, die bei ausgeblendeten Tabs in der Notationskopfzeile erscheint, mit einem Tab-Tastenkürzel oder mit „Bericht erstellen“ wieder ein. Ein Panel, das du bei ausgeblendeten Tabs zurückgibst, landet in den ausgeblendeten Tabs.
