---
id: analysis-board
title: Analysebrett, Varianten, Kommentare und Pfeile
summary: Züge eingeben, Stellungen bearbeiten, Varianten verwalten, Kommentare schreiben, Annotationen setzen und Pfeile auf dem Brett zeichnen.
source: f49e0c9098ffc5cf
---

Öffne ein Analysebrett über [[page:new-tab]] mit einem Klick auf {{label:Home.Card.AnalysisBoard.Title}} oder indem du eine gespeicherte Partie oder ein Repertoire aus [[page:library]] öffnest.

Führe Züge durch Ziehen oder Klicken der Figuren aus (einstellbar unter [[setting:move-method]]). Du kannst auch [[setting:text-input]] ({{label:Settings.Inputs.TextInput}}) aktivieren, um Züge in SAN-Notation einzutippen. Nutze die Zugsteuerung unter der Notation, die Pfeiltasten oder das Mausrad (wenn [[setting:scroll-moves]] aktiv ist), um durch die Züge zu blättern.

Die obere Leiste über dem Brett bietet folgende Brett-Aktionen:
- {{label:Board.Action.PlayFromHere}}: Eine Partie ab der aktuellen Stellung starten.
- Brett drehen (`F`): Weiß und Schwarz am unteren Brettrand tauschen.
- Speichern: Erscheint, wenn eine Partie ungespeicherte Änderungen hat und automatisches Speichern ausgeschaltet, nicht verfügbar (etwa bei einem Entwurf) oder fehlgeschlagen ist.
- {{label:Board.Action.More}}: Öffnet das Menü für {{label:Board.Action.NewAnalysis}} (das Brett im selben Tab durch ein leeres ersetzen; bei ungespeicherten Änderungen fragt Studio vorher nach), {{label:Board.Database.Save}} (die Partie in einer Bibliotheksdatei oder Datenbank speichern), {{label:Board.Action.TakeSnapshot}} (ein Bild der aktuellen Stellung sichern) und {{label:Board.Action.EditPosition}} (eine eigene Stellung durch Setzen von Figuren oder Bearbeiten der FEN aufbauen).
- Rückgängig, Wiederholen sowie das Entfernen gezeichneter Pfeile oder Feldmarkierungen (wenn [[setting:erase-drawables]] deaktiviert ist) nutzen ihre Tastenkürzel unter [[settings-category:keybinds]].

Wenn du in einer früheren Stellung einen anderen Zug spielst, entsteht eine Variante. Klicke mit der rechten Maustaste auf einen Zug in der Notation für {{label:Menu.PromoteVariation}}, {{label:Menu.PromoteToMainLine}}, {{label:Menu.CopyVariationPGN}}, {{label:Menu.DeleteMove}}, {{label:Menu.DeleteVariation}}, {{label:Menu.DeleteMovesAfter}}, {{label:Board.Action.PlayFromHere}}, {{label:Notation.AddDiagram}} oder {{label:Notation.MarkGameEndHere}}. Nutze das Augensymbol in der Notationskopfzeile für {{label:Notation.HideMoves}} und das Menü {{label:Notation.ViewOptions}}, um {{label:Notation.TableView}}, {{label:Notation.ShowComments}}, {{label:Notation.ShowDiagrams}} und {{label:Notation.ShowVariations}} umzuschalten.

Um Züge zu bewerten und Kommentare zu schreiben, öffne den Tab {{label:Board.Tabs.Annotate}}. Klicke auf ein Zugbewertungssymbol (oder drücke die Tasten 1 bis 6), um `!!`, `!`, `!?`, `?!`, `?` oder `??` umzuschalten, oder klicke auf {{label:Annotate.ShowMore}} für Stellungs- und Bewertungssymbole. Darunter kannst du mit dem Rich-Text-Editor formatierte Kommentare verfassen und Inline-Brettdiagramme einfügen.

Um Pfeile zu zeichnen und Felder hervorzuheben, ziehe mit gedrückter rechter Maustaste auf dem Brett (oder rechtsklicke ein Feld für einen Kreis). Halte Zusatztasten für weitere Farben gedrückt: Umschalttaste für {{label:Settings.Drawing.Red}}, Alt für {{label:Settings.Drawing.Blue}}, Umschalt+Alt für {{label:Settings.Drawing.Yellow}}, Strg (Cmd unter macOS) für {{label:Settings.Drawing.Orange}} und Strg+Alt (Cmd+Alt unter macOS) für {{label:Settings.Drawing.Cyan}}. Die vollständige Zeichenliste findest du unter [[settings-category:keybinds]].

Der Tab {{label:Board.Tabs.Info}} zeigt Partieköpfe, FEN, PGN-Text und Baumstatistiken und lässt dich zwischen Partien einer Mehrpartien-PGN-Datei wechseln.

Um das Analysebrett anzuordnen, ziehe einen Panel-Tab ({{label:Board.Tabs.Analysis}}, {{label:Board.Analysis.Report}}, {{label:Board.Tabs.Database}}, {{label:Board.Tabs.Annotate}}, {{label:Board.Tabs.Coach}} oder {{label:Board.Tabs.Info}}) oder den Sechs-Punkte-Griff einer Engine-Karte oder nutze die Griff-Schaltflächen in der Tab-Leiste, in der Notationskopfzeile oder im Kopf eines Panel-Bereichs, um Bereiche mit Vorschau oder per Tastatur neben, über oder unter einem anderen Bereich zu platzieren. Um ein Panel über zwei Bereiche zu spannen (etwa {{label:Board.Tabs.Database}} über Notation und Tabs), platziere das Panel zuerst über einem der beiden und verschiebe dann den anderen daneben. Mit {{label:Board.Area.ReturnToTabs}} (oder {{label:Board.Area.ReturnToEngines}} für ein Engine-Fenster) oder durch Zurückziehen auf die Tab-Leiste gibst du einen Bereich zurück.

Repertoire-, Partie- und Gegnervorbereitungs-Tabs behalten jeweils ihr eigenes aktives Layout. Drei fertige Vorlagen sind enthalten ({{label:Board.Layout.Preset.Repertoire}}, {{label:Board.Layout.Preset.GameReview}} und {{label:Board.Layout.Preset.Preparation}}), und du kannst eigene Layouts speichern, zwischen ihnen wechseln sowie gespeicherte Layouts über {{label:Board.Action.More}} ({{label:Board.Layout.SaveAs}} und {{label:Board.Layout.Manage}}) oder über {{label:Menu.View}} ({{label:Board.Layout.SaveAs}} und {{label:Board.Layout.LayoutsMenu}}) umbenennen und löschen. Mit [[setting:board-layout]] ({{label:Settings.BoardLayout.Reset}}) stellst du die voreingestellten Layouts für alle drei Tab-Arten wieder her; deine gespeicherten Layouts bleiben dabei erhalten.

Um die Tabs auszublenden, etwa wenn jedes genutzte Panel als eigener Bereich angezeigt wird, klicke auf {{label:Board.Area.HideTabs}} unter dem Griff am Ende der Tab-Leiste; die benachbarten Bereiche übernehmen ihren Platz. Die Tabs behalten Position und Größe: Du blendest sie mit der Schaltfläche {{label:Board.Arrange.ShowTabs}}, die bei ausgeblendeten Tabs in der Notationskopfzeile erscheint, mit einem Tab-Tastenkürzel oder mit „Bericht erstellen“ wieder ein. Ein Panel, das du bei ausgeblendeten Tabs zurückgibst, landet in den ausgeblendeten Tabs. Solange die Tabs ausgeblendet sind, findest du {{label:Board.Arrange.ShowTabs}} auch unter {{label:Board.Action.More}} und im Menü {{label:Menu.View}}.
