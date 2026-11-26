---
id: game-report
title: Partiebericht
summary: Eine automatische Engine-Auswertung einer Partie erstellen, um Genauigkeit, Bewertungsverlauf, Schlüsselmomente und Zugklassifikationen zu sehen.
source: b69aae8a4fe0f417
---

Der Partiebericht analysiert jeden Zug der Hauptvariante mit einer lokalen Schach-Engine und fasst die Genauigkeit sowie Fehler der Partie zusammen.

Um einen Bericht zu erstellen, öffne eine Partie auf dem Analysebrett, wechsle zum Tab {{label:Board.Analysis.Report}} und klicke auf {{label:Board.Analysis.GenerateReport}} (oder drücke das Tastenkürzel {{label:Settings.Keybinds.Actions.GENERATE_REPORT}}).

Im Dialog {{label:Board.Analysis.GenerateReport}}:
- Wähle eine lokale {{label:Common.Engine}}. Falls keine installiert ist, füge unter [[page:engines]] eine hinzu.
- Lege das Suchlimit pro Zug fest (Tiefe, Zeit oder Knoten).
- Aktiviere {{label:Board.Analysis.MarkMoves}}, um Züge mit Bewertungssymbolen zu versehen.
- Aktiviere {{label:Board.Analysis.ShowVariations}}, um bessere Zugvarianten in die Notation einzufügen.
- Aktiviere {{label:Board.Analysis.AnnotateNovelties}}, um den ersten Zug zu markieren, der deine Referenzdatenbank verlässt. Diese Option erfordert eine bereite Referenzdatenbank, die in [[page:library]] ausgewählt ist.
- Klicke zum Starten auf {{label:Board.Analysis.Analyze}}.

Während ein Bericht läuft, kannst du ihn über die Fortschrittsschaltfläche abbrechen. Änderungen an der Hauptvariante brechen einen laufenden Bericht ab.

Nach Abschluss zeigt {{label:Board.Analysis.Report}}:
- Genauigkeitswerte in Prozent und durchschnittlichen Centipawn-Verlust (ACPL) für {{label:Common.WHITE}} und {{label:Common.BLACK}}.
- Ein Bewertungsdiagramm über die gesamte Partie.
- {{label:Board.Analysis.Report.KeyMoments}}: Eine anklickbare Liste markierter Züge mit Bewertungssprüngen und besseren Zügen.
- Eine Übersichtstabelle der Zugqualitäten, bei der ein Klick auf eine Anzahl direkt zu den entsprechenden Zügen springt.

Wenn du die Partie nachträglich bearbeitest, klicke auf {{label:Board.Analysis.RegenerateReport}}, um eine neue Analyse zu starten.
