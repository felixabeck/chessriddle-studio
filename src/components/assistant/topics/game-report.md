---
id: game-report
title: Game review and report
summary: Analyze a game with a local engine to review accuracy, evaluation and time charts, opening and repertoire notes, and key moments on the board.
---

The game report analyzes every move of the mainline with a local chess engine and turns the results into a guided review of the game.

To generate a report, open a game on the analysis board, switch to the {{label:Board.Analysis.Report}} tab, and click {{label:Board.Analysis.GenerateReport}} (or press the {{label:Settings.Keybinds.Actions.GENERATE_REPORT}} shortcut).

In the {{label:Board.Analysis.GenerateReport}} dialog:
- Choose a local {{label:Common.Engine}}. If none is installed, add one on [[page:engines]].
- Set the per-move search limit (depth, time, or nodes).
- Toggle {{label:Board.Analysis.MarkMoves}} to annotate moves with quality symbols (`!!`, `!`, `!?`, `?!`, `?`, `??`).
- Toggle {{label:Board.Analysis.ShowVariations}} to insert better-move variations into the notation.
- Toggle {{label:Board.Analysis.AnnotateNovelties}} to mark the first move leaving your reference database with `N`. This option requires a ready reference database selected in [[page:library]].
- Click {{label:Board.Analysis.Analyze}} to start.

While a report runs, you can cancel it from the progress button. Editing the mainline cancels an in-progress report.

Once finished, {{label:Board.Analysis.Report}} shows:
- A quiet header with the engine, search limit, and date, plus a small {{label:Board.Analysis.Report.Regenerate}} button beside it. The full-width {{label:Board.Analysis.GenerateReport}} button appears only when there is no current report.
- A one-sentence summary above the scoreboard when the game started from a balanced position; no summary sentence is shown from an unbalanced start.
- One scoreboard with player names and ratings, {{label:Board.Analysis.Accuracy}} as the main number, {{label:Board.Analysis.Report.AverageLoss}}, accuracy by game phase, and the six move-quality rows with zero counts dimmed. Clicking a non-zero count jumps to those moves, and hovering or focusing any metric label explains what it measures.
- A chart switching between {{label:Board.Analysis.Report.Evaluation}} (with a zero line) and {{label:Board.Analysis.Report.WinChance}}, each explained on hover or keyboard focus. When at least half of the moves have clock times, a {{label:Board.Analysis.Report.TimeUsage}} strip appears below the chart; click any bar to jump to that move.
- An opening and repertoire block showing the opening name, the novelty move (`N`) when present, and a repertoire note for your side only—matched by player name against your connected Lichess, Chess.com, or alias accounts in [[page:accounts]], or whichever side is at the bottom of the board if no name matches (flipping the board changes that side). It shows where you left your repertoire (clicking focuses that position with arrows) or how far you followed it. If the repertoire files could not be read completely, it shows one muted line: {{label:Board.Analysis.Report.RepertoireIncomplete}}
- {{label:Board.Analysis.Report.KeyMoments}}: click any row to jump to the position before the move so both board arrows (the played move and the better move) start from that square. Use {{label:Board.Analysis.Report.PreviousMoment}} and {{label:Board.Analysis.Report.NextMoment}} to step through them, or filter by {{label:Board.Analysis.Report.FilterBoth}}, {{label:Board.Analysis.Report.FilterWhite}}, or {{label:Board.Analysis.Report.FilterBlack}}. Moments also show tags such as {{label:Board.Analysis.Report.Tag.TurningPoint}} or {{label:Board.Analysis.Report.Tag.TimeTrouble}}, and the kind of mistake when the engine lines prove it.
- On `?!`, `?`, and `??` moments, click {{label:Board.Analysis.Report.Explain}} to focus that position and open {{label:Board.Tabs.Coach}} with a question about that moment. This button is hidden when no AI connection is configured.

If you edit the game afterward, regenerate the report with {{label:Board.Analysis.GenerateReport}} or {{label:Board.Analysis.Report.Regenerate}} to update the review.
