---
id: repertoires
title: Opening repertoires
summary: Create a repertoire, import PGNs, build coverage against a reference database, practise with spaced repetition, and track open variations, transpositions and review marks.
---

Repertoires are PGN files with type Repertoire that add the {{label:Board.Tabs.Practice}} tab to the analysis board.

To create a repertoire, open [[page:new-tab]] and click {{label:Home.Card.NewRepertoire.Title}} (or create a repertoire file in [[page:library]]). Enter a {{label:Common.Name}}, choose {{label:Common.WHITE}} or {{label:Common.BLACK}}, optionally pick or paste a PGN under {{label:Home.Card.NewRepertoire.FromPgn}}, and click {{label:Common.Create}}. You can also import a PGN from {{label:Home.Card.ImportGame.Title}} with {{label:Import.SaveToCollection}} enabled and file type {{label:Files.FileType.Repertoire}}.

Build your repertoire in {{label:Board.Tabs.Practice}} -> {{label:Board.Practice.Build}}:
- Click {{label:Board.Practice.Build.ImportPgn}} to merge a PGN file or pasted games into the open repertoire (works with or without a reference database).
- Set a {{label:Databases.Settings.ReferenceDatabase}} in [[page:library]] so the builder can show move frequencies and coverage.
- On an empty repertoire, you can start from one of the built-in {{label:Board.Practice.Build.Presets}} or enter moves on the board.
- Mark the starting position of your repertoire using {{label:Board.Practice.Build.SetAsStart}} (or right-click a move in the notation and choose {{label:Menu.MarkAsStart}}).
- Click moves in {{label:Board.Practice.Build.OpponentMoves}} or {{label:Board.Practice.Build.YourResponse}} to add or follow lines. Use {{label:Board.Practice.Build.NextGap}} and {{label:Board.Practice.Build.BiggestGap}} to jump to uncovered opponent replies above the minimum game count set in [[setting:repertoire-depth]].

Practise your repertoire in {{label:Board.Tabs.Practice}} -> {{label:Board.Practice.Train}}:
- Click {{label:Board.Practice.StartPractice}} to drill due and new positions using spaced repetition, or {{label:Board.Practice.PracticeFullRepertoire}} to drill every position in the repertoire.
- Play your prepared move on the board. If you get stuck after a wrong move, click {{label:Board.Practice.ShowMove}}.
- Inspect all cards with {{label:Board.Practice.ShowAll}}, review history with {{label:Board.Practice.ShowLogs}}, or reset progress with {{label:Common.Reset}}.
- Repertoires with due cards also appear under {{label:Home.Library.Due}} on [[page:new-tab]].
- Configure spaced-repetition grading and new-card limits in [[settings-category:repertoire]] ([[setting:practice-grading]], [[setting:practice-new-per-session]]).

In the notation on the analysis board:
- A side line that is only one move long is framed with a dashed border as an {{label:Notation.OpenVariation}} so you can spot unfinished branches. Press the {{label:Settings.Keybinds.Actions.NEXT_OPEN_VARIATION}} shortcut to jump to the next one.
- When a position appears in another branch of the same repertoire, a {{label:Notation.Transposition}} icon appears beside the move; click it to jump to the other branch.
- When an imported PGN contains a different reply for your side, the imported move is appended as a variation and flagged as {{label:Notation.ReviewMove}}. Right-click the move and choose {{label:Menu.MarkAsReviewed}} to clear the mark.
