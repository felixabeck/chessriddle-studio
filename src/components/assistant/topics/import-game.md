---
id: import-game
title: Importing a game
summary: Import a game from a PGN file, pasted PGN text, a Lichess or Chess.com URL, a FEN position, or photos or PDF scans of a handwritten scoresheet.
---

To import a game or position, open [[page:new-tab]] and click {{label:Home.Card.ImportGame.Button}} to open the {{label:Home.Card.ImportGame.Title}} dialog. You can also open a PGN file directly from {{label:Menu.File}} -> {{label:Menu.File.OpenFile}} (or the {{label:Settings.Keybinds.Actions.OPEN_FILE}} shortcut).

In the {{label:Home.Card.ImportGame.Title}} dialog, choose one of the options:
- **PGN**: pick a {{label:Common.PGNFile}} from your computer or paste text into {{label:Common.PGNGame}}. Check {{label:Import.SaveToCollection}} to save a copy into your workspace folder in [[page:library]], then enter a {{label:Common.Name}} and pick a {{label:Files.FileType}}.
- **{{label:Import.Online}}**: paste a Lichess or Chess.com {{label:Import.GameURL}} to fetch the game and open it on an analysis board.
- **FEN**: paste a FEN string to open an analysis board starting from that position.
- **{{label:Import.FromPhoto}}** (when AI features are available): transcribe 1 to 4 photos or PDF pages of a handwritten scoresheet into a new game. This requires at least one AI connection in [[settings-category:coach]] ({{label:Settings.AI}}).

For PGN, {{label:Import.Online}}, and FEN, click {{label:Home.Card.ImportGame.Button}} to load the game into the current tab.

To import with **{{label:Import.FromPhoto}}**:
- Add up to 4 JPEG, PNG, or WebP photos or PDF pages using {{label:Scoresheet.Intake.ChoosePhotos}}, {{label:Scoresheet.Intake.PasteFromClipboard}} (or Ctrl+V / Cmd+V while the pane is open), or by dragging and dropping photos or PDF files onto the open pane. Pasting works for photos only. Each PDF page counts as one photo; from a longer PDF, the first pages are used.
- Choose the AI connection and vision-capable model with the model button or in [[setting:coach-model]] ({{label:Settings.Coach.Model}}).
- Click {{label:Scoresheet.Read.Button}} to start. Before the first reading on a connection, {{label:Scoresheet.Notice.Title}} explains that the selected photos (including player names and anything else written on the sheet) are sent to that provider, with metadata such as camera location removed first and no other data sent.
- Studio checks every move against standard chess rules from the starting position and opens the game in a new unsaved analysis tab with the {{label:Board.Tabs.Photo}} panel beside the board.
- Doubtful or corrected moves are marked as unsure in the notation. Step through them in the {{label:Board.Tabs.Photo}} panel and click {{label:Scoresheet.MarkAsChecked}} as you verify each move. If you correct a move in the middle or continue past a stop point, click {{label:Scoresheet.ContinueWithSheet}} to replay the following legal moves from the sheet. The marks stay until each move is corrected or marked as checked, and the {{label:Board.Tabs.Photo}} panel can be dragged out of the tabs and placed like the other panels.
- Save the game into a file or database using the normal save flow ({{label:Menu.File}} -> {{label:Common.Save}}, the save button, or {{label:Board.Database.Save}}).
- Photos are kept in memory only (for up to 4 open tabs) and are not saved to disk; after reloading or restarting, the game and its review marks remain, and you can use {{label:Scoresheet.LoadPhotoAgain}} in the {{label:Board.Tabs.Photo}} panel to view the photo again without sending it.
