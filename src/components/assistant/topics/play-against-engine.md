---
id: play-against-engine
title: Playing against an engine
summary: Configure a game against a local engine or another human, set time controls and opening books, and play from any position.
---

To start a game, open [[page:new-tab]] and click {{label:Home.Card.PlayChess.Button}}. You can also play from any position on an analysis board by clicking {{label:Board.Action.PlayFromHere}} in the board's top bar or right-clicking a move in the notation.

Before starting the game:
- For each side, choose {{label:Board.Opponent.Human}} (with a name) or {{label:Common.Engine}} (pick an installed engine from [[page:engines]] and adjust its per-game UCI options).
- Click {{label:Board.Action.ChangeColors}} to swap White and Black.
- Under {{label:Board.Opponent.TimeSettings}}, choose {{label:GoMode.Time}} (with {{label:GoMode.Time}} and {{label:Board.Opponent.Increment}}) or {{label:Board.Opponent.Unlimited}}. Check {{label:Board.Opponent.SameTimeControl}} to share the same clock settings on both sides.
- Optionally check {{label:Board.Opponent.EnableOpeningBook}}, choose an {{label:Board.Opponent.OpeningBookFile}}, and set {{label:Board.Opponent.OpeningBookMaxPlies}}.
- Use {{label:Board.Action.EditPosition}} in the {{label:Board.Action.More}} menu of the board's top bar (or press `E`) before starting if you want to play from a custom position.
- Click {{label:Board.Opponent.StartGame}} to begin.

During a game:
- Premoves are enabled when playing as a human against an engine.
- Use {{label:Board.Action.TakeBack}} in the board's top bar to take back your last move.
- Click {{label:Board.Opponent.Resign}} (or {{label:Board.Opponent.Abort}} in an engine-vs-engine match) to end the game.
- Click {{label:Board.Analysis.Analyze}} at any time to switch the tab to analysis mode, or {{label:Board.Analysis.Logs}} to inspect engine logs.
- When a game finishes, click {{label:Home.NewGame}} to set up another game.
