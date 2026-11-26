---
id: game-report
title: Game report
summary: Run an automated engine review of a game to see accuracy, evaluation graph, key moments, and move classifications.
---

The game report analyzes every move of the mainline with a local chess engine and summarizes the game's accuracy and mistakes.

To generate a report, open a game on the analysis board, switch to the {{label:Board.Analysis.Report}} tab, and click {{label:Board.Analysis.GenerateReport}} (or press the {{label:Settings.Keybinds.Actions.GENERATE_REPORT}} shortcut).

In the {{label:Board.Analysis.GenerateReport}} dialog:
- Choose a local {{label:Common.Engine}}. If none is installed, add one on [[page:engines]].
- Set the per-move search limit (depth, time, or nodes).
- Toggle {{label:Board.Analysis.MarkMoves}} to annotate moves with quality symbols.
- Toggle {{label:Board.Analysis.ShowVariations}} to insert better-move variations into the notation.
- Toggle {{label:Board.Analysis.AnnotateNovelties}} to mark the first move leaving your reference database. This option requires a ready reference database selected in [[page:library]].
- Click {{label:Board.Analysis.Analyze}} to start.

While a report runs, you can cancel it from the progress button. Editing the mainline cancels an in-progress report.

Once finished, {{label:Board.Analysis.Report}} displays:
- Accuracy percentages and average centipawn loss (ACPL) for {{label:Common.WHITE}} and {{label:Common.BLACK}}.
- An evaluation chart across the game.
- {{label:Board.Analysis.Report.KeyMoments}}: clickable list of marked moves showing evaluation swings and better moves.
- A move-quality breakdown table where clicking a count jumps to those moves.

If you edit the game afterward, click {{label:Board.Analysis.RegenerateReport}} to run a fresh analysis.
