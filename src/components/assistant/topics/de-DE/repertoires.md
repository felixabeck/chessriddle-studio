---
id: repertoires
title: Eröffnungsrepertoires
summary: Repertoire anlegen, Abdeckung anhand einer Referenzdatenbank aufbauen, mit verteilter Wiederholung üben und offene Varianten sowie Zugumstellungen verfolgen.
source: 62b7ff51627518a7
---

Repertoires sind PGN-Dateien vom Typ Repertoire, die auf dem Analysebrett den Tab {{label:Board.Tabs.Practice}} hinzufügen.

Um ein Repertoire anzulegen, öffne [[page:new-tab]] und klicke auf {{label:Home.Card.NewRepertoire.Title}} (oder erstelle eine Repertoire-Datei in [[page:library]]). Gib einen {{label:Common.Name}} ein, wähle {{label:Common.WHITE}} oder {{label:Common.BLACK}} und klicke auf {{label:Common.Create}}.

Baue dein Repertoire unter {{label:Board.Tabs.Practice}} -> {{label:Board.Practice.Build}} auf:
- Wähle in [[page:library]] eine {{label:Databases.Settings.ReferenceDatabase}}, damit der Builder Zughäufigkeiten und Abdeckung anzeigen kann.
- Bei einem leeren Repertoire kannst du mit einer der integrierten Vorlagen unter {{label:Board.Practice.Build.Presets}} beginnen oder Züge auf dem Brett eingeben.
- Lege die Ausgangsstellung deines Repertoires über {{label:Board.Practice.Build.SetAsStart}} fest (oder rechtsklicke einen Zug in der Notation und wähle {{label:Menu.MarkAsStart}}).
- Klicke auf Züge unter {{label:Board.Practice.Build.OpponentMoves}} oder {{label:Board.Practice.Build.YourResponse}}, um Varianten hinzuzufügen oder zu verfolgen. Nutze {{label:Board.Practice.Build.NextGap}} und {{label:Board.Practice.Build.BiggestGap}}, um zu ungedeckten gegnerischen Antworten oberhalb der in [[setting:repertoire-depth]] eingestellten Mindestpartienzahl zu springen.

Übe dein Repertoire unter {{label:Board.Tabs.Practice}} -> {{label:Board.Practice.Train}}:
- Klicke auf {{label:Board.Practice.StartPractice}}, um fällige und neue Stellungen per verteilter Wiederholung zu trainieren, oder auf {{label:Board.Practice.PracticeFullRepertoire}}, um jede Stellung im Repertoire durchzugehen.
- Spiele deinen vorbereiteten Zug auf dem Brett. Wenn du nach einem falschen Zug nicht weiterkommst, klicke auf {{label:Board.Practice.ShowMove}}.
- Prüfe alle Lernkarten mit {{label:Board.Practice.ShowAll}}, sieh dir den Verlauf mit {{label:Board.Practice.ShowLogs}} an oder setze den Fortschritt mit {{label:Common.Reset}} zurück.
- Repertoires mit fälligen Karten erscheinen auch unter {{label:Home.Library.Due}} auf [[page:new-tab]].
- Stelle die Bewertung der verteilten Wiederholung und das Limit neuer Karten unter [[settings-category:repertoire]] ein ([[setting:practice-grading]], [[setting:practice-new-per-session]]).

In der Notation auf dem Analysebrett:
- Eine Nebenvariante, die nur einen Zug lang ist, wird mit gestricheltem Rahmen als {{label:Notation.OpenVariation}} markiert, damit du unfertige Zweige erkennst. Drücke das Tastenkürzel {{label:Settings.Keybinds.Actions.NEXT_OPEN_VARIATION}}, um zur nächsten zu springen.
- Taucht eine Stellung in einem anderen Zweig desselben Repertoires auf, erscheint neben dem Zug ein {{label:Notation.Transposition}}-Symbol; klicke darauf, um zum anderen Zweig zu wechseln.
