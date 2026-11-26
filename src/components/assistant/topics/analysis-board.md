---
id: analysis-board
title: Analysis board, variations, comments, and arrows
summary: Enter moves, edit positions, manage variations, write comments, add annotations, and draw arrows on the board.
---

Open an analysis board from [[page:new-tab]] by clicking {{label:Home.Card.AnalysisBoard.Title}}, or by opening a saved game or repertoire from [[page:library]].

Make moves by dragging or clicking pieces (configured in [[setting:move-method]]). You can also enable [[setting:text-input]] ({{label:Settings.Inputs.TextInput}}) to type moves in SAN notation. Use the move controls below the notation, the arrow keys, or the mouse wheel (if [[setting:scroll-moves]] is enabled) to step through moves.

The top bar above the board provides board actions:
- {{label:Board.Action.PlayFromHere}}: start a game from the current position.
- Flip board (`F`): swap White and Black at the bottom of the board.
- Save: appears when a game has unsaved changes and auto-save is off, unavailable (such as a draft), or failed.
- {{label:Board.Action.More}}: open the menu for {{label:Board.Database.Save}} (save the game to a library file or database), {{label:Board.Action.TakeSnapshot}} (save an image of the current board), and {{label:Board.Action.EditPosition}} (set up a custom position by placing pieces or editing the FEN).
- Undo, redo, and clearing drawn arrows or highlights (when [[setting:erase-drawables]] is off) use their keyboard shortcuts in [[settings-category:keybinds]].

Playing a different move from an earlier position creates a variation. Right-click any move in the notation to {{label:Menu.PromoteVariation}}, {{label:Menu.PromoteToMainLine}}, {{label:Menu.CopyVariationPGN}}, {{label:Menu.DeleteMove}}, {{label:Menu.DeleteVariation}}, {{label:Menu.DeleteMovesAfter}}, {{label:Board.Action.PlayFromHere}}, {{label:Notation.AddDiagram}}, or {{label:Notation.MarkGameEndHere}}. Use the eye button in the notation header for {{label:Notation.HideMoves}}, and the {{label:Notation.ViewOptions}} menu to toggle {{label:Notation.TableView}}, {{label:Notation.ShowComments}}, {{label:Notation.ShowDiagrams}}, and {{label:Notation.ShowVariations}}.

To annotate moves and write comments, open the {{label:Board.Tabs.Annotate}} tab. Click a move-quality symbol (or press keys 1 through 6) to toggle `!!`, `!`, `!?`, `?!`, `?`, or `??`, or click {{label:Annotate.ShowMore}} for evaluation and positional symbols. Below the symbols, use the rich-text editor to write formatted comments and toggle inline board diagrams.

To draw arrows and highlight squares, right-click and drag on the board (or right-click a square for a circle). Hold modifier keys for different colors: Shift for {{label:Settings.Drawing.Red}}, Alt for {{label:Settings.Drawing.Blue}}, Shift+Alt for {{label:Settings.Drawing.Yellow}}, Ctrl (Cmd on macOS) for {{label:Settings.Drawing.Orange}}, and Ctrl+Alt (Cmd+Alt on macOS) for {{label:Settings.Drawing.Cyan}}. See the full drawing list in [[settings-category:keybinds]].

The {{label:Board.Tabs.Info}} tab shows game headers, FEN, PGN text, and tree statistics, and lets you switch between games in a multi-game PGN file.

To arrange the analysis board, drag a panel tab ({{label:Board.Tabs.Analysis}}, {{label:Board.Analysis.Report}}, {{label:Board.Tabs.Database}}, {{label:Board.Tabs.Annotate}}, {{label:Board.Tabs.Coach}}, or {{label:Board.Tabs.Info}}) or an engine card's six-dot grip, or use the grip buttons on the tab strip, the notation header, or a panel area's header to place areas beside, above, or below another area with a preview or by keyboard. To span a panel across two areas (such as {{label:Board.Tabs.Database}} above both the notation and the tabs), place the panel above one of them first and then move the other beside it. Use {{label:Board.Area.ReturnToTabs}} (or {{label:Board.Area.ReturnToEngines}} for an engine window) or drag the area back over the tab list to return it, and use [[setting:board-layout]] ({{label:Settings.BoardLayout.Reset}}) to restore the default arrangement.

To hide the tabs, for example when every panel you use is shown as its own area, click {{label:Board.Area.HideTabs}} below the grip at the end of the tab strip; the neighbouring areas take their space. The tabs keep their place and size: show them again with the {{label:Board.Arrange.ShowTabs}} button that appears in the notation header while they are hidden, with a tab shortcut, or with Generate Report. A panel you return while the tabs are hidden goes into the hidden tabs.
