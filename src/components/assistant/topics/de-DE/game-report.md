---
id: game-report
title: Partieauswertung und Bericht
summary: Eine Partie mit einer lokalen Engine analysieren, um Genauigkeit, Bewertungs- und Zeitdiagramme, Eröffnungs- und Repertoirehinweise sowie Schlüsselmomente auf dem Brett zu prüfen.
source: d1a4339820f36de2
---

Der Partiebericht analysiert jeden Zug der Hauptvariante mit einer lokalen Schach-Engine und fasst die Ergebnisse zu einer geführten Partieauswertung zusammen.

Um einen Bericht zu erstellen, öffne eine Partie auf dem Analysebrett, wechsle zum Tab {{label:Board.Analysis.Report}} und klicke auf {{label:Board.Analysis.GenerateReport}} (oder drücke das Tastenkürzel {{label:Settings.Keybinds.Actions.GENERATE_REPORT}}).

Im Dialog {{label:Board.Analysis.GenerateReport}}:
- Wähle eine lokale {{label:Common.Engine}}. Falls keine installiert ist, füge unter [[page:engines]] eine hinzu.
- Lege das Suchlimit pro Zug fest (Tiefe, Zeit oder Knoten).
- Aktiviere {{label:Board.Analysis.MarkMoves}}, um Züge mit Qualitätssymbolen (`!!`, `!`, `!?`, `?!`, `?`, `??`) zu versehen.
- Aktiviere {{label:Board.Analysis.ShowVariations}}, um bessere Zugvarianten in die Notation einzufügen.
- Aktiviere {{label:Board.Analysis.AnnotateNovelties}}, um den ersten Zug mit `N` zu markieren, der deine Referenzdatenbank verlässt. Diese Option erfordert eine bereite Referenzdatenbank, die in [[page:library]] ausgewählt ist.
- Klicke zum Starten auf {{label:Board.Analysis.Analyze}}.

Während ein Bericht läuft, kannst du ihn über die Fortschrittsschaltfläche abbrechen. Änderungen an der Hauptvariante brechen einen laufenden Bericht ebenfalls ab.

Nach Abschluss zeigt {{label:Board.Analysis.Report}}:
- Eine ruhige Kopfzeile mit Engine, Suchlimit und Datum sowie daneben eine kleine Schaltfläche {{label:Board.Analysis.Report.Regenerate}}. Die breite Schaltfläche {{label:Board.Analysis.GenerateReport}} erscheint nur, wenn noch kein aktueller Bericht vorliegt.
- Einen einzeiligen Zusammenfassungssatz über der Wertungstafel, wenn die Partie aus einer ausgeglichenen Stellung begonnen hat; bei unausgeglichenem Start erscheint kein Zusammenfassungssatz.
- Eine gemeinsame Wertungstafel mit Spielernamen und Wertungszahlen, {{label:Board.Analysis.Accuracy}} als Hauptzahl, {{label:Board.Analysis.Report.AverageLoss}}, Genauigkeit nach Partiephase sowie den sechs Zugqualitätszeilen mit abgeblendeten Nullwerten. Ein Klick auf eine Zahl größer null springt zu diesen Zügen; beim Zeigen oder Fokussieren per Tastatur erklärt jede Beschriftung ihre Bedeutung.
- Ein Diagramm, das zwischen {{label:Board.Analysis.Report.Evaluation}} (mit Nulllinie) und {{label:Board.Analysis.Report.WinChance}} umschaltet, jeweils mit Erklärung beim Zeigen oder Fokussieren. Wenn mindestens die Hälfte der Züge Uhrzeiten enthält, erscheint darunter eine Leiste für {{label:Board.Analysis.Report.TimeUsage}}; klicke auf einen Balken, um zu diesem Zug zu springen.
- Einen Eröffnungs- und Repertoireblock mit dem Eröffnungsnamen, der Neuerung (`N`), falls vorhanden, und einem Repertoirehinweis nur für deine Seite — ermittelt über den Spielernamen im Abgleich mit deinen verbundenen Lichess-, Chess.com- oder Alias-Konten unter [[page:accounts]], oder über die Seite unten am Brett, wenn kein Name passt (Brett drehen wechselt diese Seite). Er zeigt an, wo du vom Repertoire abgewichen bist (ein Klick fokussiert die Stellung mit Pfeilen) oder bis wohin du ihm gefolgt bist. Konnten die Repertoire-Dateien nicht vollständig gelesen werden, erscheint eine einzige gedimmte Zeile: {{label:Board.Analysis.Report.RepertoireIncomplete}}
- {{label:Board.Analysis.Report.KeyMoments}}: Klicke auf eine Zeile, um zur Stellung vor dem Zug zu springen, sodass beide Brett-Pfeile (gespielter Zug und besserer Zug) von diesem Feld ausgehen. Nutze {{label:Board.Analysis.Report.PreviousMoment}} und {{label:Board.Analysis.Report.NextMoment}} zum Durchgehen oder filtere nach {{label:Board.Analysis.Report.FilterBoth}}, {{label:Board.Analysis.Report.FilterWhite}} oder {{label:Board.Analysis.Report.FilterBlack}}. Momente zeigen außerdem Markierungen wie {{label:Board.Analysis.Report.Tag.TurningPoint}} oder {{label:Board.Analysis.Report.Tag.TimeTrouble}} sowie die Art des Fehlers, wenn die Engine-Varianten sie belegen.
- Klicke bei `?!`-, `?`- und `??`-Momenten auf {{label:Board.Analysis.Report.Explain}}, um diese Stellung zu fokussieren und {{label:Board.Tabs.Coach}} mit einer Frage zu diesem Moment zu öffnen. Diese Schaltfläche ist ausgeblendet, wenn keine KI-Verbindung eingerichtet ist.

Wenn du die Partie nachträglich bearbeitest, erstelle den Bericht mit {{label:Board.Analysis.GenerateReport}} oder {{label:Board.Analysis.Report.Regenerate}} neu, um die Auswertung zu aktualisieren.
