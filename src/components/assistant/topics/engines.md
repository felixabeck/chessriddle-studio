---
id: engines
title: Chess engines and the analysis panel
summary: Install or add local and cloud engines, configure UCI options, and use live analysis on the board.
---

Manage your chess engines on [[page:engines]] ({{label:SideBar.Engines}}).

To add an engine, click {{label:Common.AddNew}} on [[page:engines]] to open {{label:Engines.Add.Title}}:
- {{label:Common.Download}}: install a preconfigured engine (such as Stockfish) from the catalog with {{label:Common.Install}}.
- {{label:Engines.Add.Cloud}}: add online analysis engines (ChessDB or Lichess Cloud) with {{label:Common.Add}}.
- {{label:Common.Local}}: register a UCI engine binary already on your computer.

Select any engine on [[page:engines]] to configure it. For local engines you can edit general details, set default UCI options (such as Threads, Hash, and MultiPV), attach resource files like Syzygy tablebases, click {{label:Engines.Settings.Reset}} to restore defaults, {{label:Common.Duplicate}} to copy the configuration, or {{label:Common.Remove}} to remove it. For cloud engines you can edit the name and {{label:Engines.Settings.NumOfLines}}.

On the analysis board, open the {{label:Board.Tabs.Analysis}} tab and select {{label:Board.Analysis.Engines}}:
- Click {{label:Board.Analysis.SelectEngines}} to choose which installed engines are loaded in the panel, or {{label:Board.Analysis.ManageEngines}} to jump to [[page:engines]].
- Click {{label:Board.Analysis.EnableEngine}} or {{label:Board.Analysis.DisableEngine}} on an engine card to start or pause analysis, or use {{label:Board.Analysis.EnableAllEngines}} when multiple engines are loaded.
- Click {{label:Board.Analysis.CheckThreat}} (or press the {{label:Settings.Keybinds.Actions.TOGGLE_THREAT_MODE}} shortcut) to analyze the opponent's threat.
- Click {{label:Board.Analysis.Pin}} to pin an engine evaluation bar outside the tab, or {{label:Board.Analysis.EngineSettings}} to adjust per-tab settings like search limit and lines.
- Drag engine cards by {{label:Board.Analysis.ReorderEngine}} to change their order.
- When an engine fails, click {{label:Board.Analysis.Logs}} beside {{label:Board.Analysis.RetryEngine}} to inspect its UCI communication. For a running engine, the same button is under {{label:Board.Analysis.EngineSettings}} on its card.

Control engine arrows on the board with [[setting:arrows]] ({{label:Settings.Arrows}}). Local engines are stored in the folder set at [[setting:engines-directory]].
