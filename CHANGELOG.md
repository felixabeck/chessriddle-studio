# Changelog

What changed in each ChessRiddle Studio release. The release workflow copies a version's section into its GitHub release, so keep each section plain Markdown: headings, lists and links.

## Unreleased

### Improved

- Opponent preparation: the Moves and Uncovered move columns show move numbers ("1. e4 c6 2. d4 d5", "3... g6"), counted from where each chapter starts, with piece letters or symbols as set for the notation. A gap at the starting position is labelled "Start position" instead of a chapter that happens to contain it.
- Player cards: "Prepare on board" now sits only on Openings and Preparation, always as the last button on the right; Preparation's Refresh is an icon beside it. The "Online accounts" row is gone: a small "+ Online account" button sits beside the player's name, and linked accounts show as chips under it. The database view's Enlarge table and Enlarge preview arrows are gone; drag the divider to resize.
- Repertoire colour: a game added to a repertoire, with "+ New game" or by saving into the file, takes the colour the file's chapters share, so new chapters of a Black repertoire are trained and prepared as Black. "+ New game" opens the board from that side.
- Chapters without a colour: Preparation names each repertoire file whose chapters have no colour (they count as White) with a "Set color…" button, and Practice offers "Train as White" or "Train as Black" for such a chapter.

## 1.5.0

### New

- Game review: the Report panel is now a guided review with one scoreboard and explained numbers, a one-sentence summary, key moments you can step through with board arrows, kinds of mistake, time usage and time-trouble tags, opening, novelty and repertoire notes, and an optional Coach Explain button that is hidden without an AI connection.
- Library sync: game databases now appear beside your PGN files in "Sync with ChessRiddle". Selected databases within the limits (up to 5,000 games and 5 MB) sync to your private Library on chessriddle.com automatically; larger or empty databases stay unselected and local. Downloaded game histories stay local.
- Edit game data: the pencil on a database game's card, or F2, opens a dialog to change White, Black, both Elo, Event, Site, Round, Date, Result and Time control. Games from linked online accounts stay read-only. The shortcut can be changed under Settings → Shortcuts.
- Clock times: the Annotate panel has a Clock field for the current move. A plain number is minutes (86 means 1:26:00), h:mm and h:mm:ss work too, and Enter or Tab saves and moves on to the next move. The board shows clocks whenever moves carry clock times.
- Time control: the Info panel has a Time control row with None, four club presets and a Custom form, and shows the control in plain words. The board clocks show it as a tooltip.
- Scoresheet import reads the clock times written next to the moves and keeps them with the game.
- New analysis: the first item in the board bar's More menu, Ctrl/Cmd+N or File → New Analysis Board turns the current analysis board into an empty one in the same place. Database sources and engine settings carry over.
- Database panel: move statistics now sit above the matching games, with a draggable divider between them, instead of a switch between Statistics and Games. A collapse button hides the games. The games table has a Notation column with the next eight half-moves from the board position.
- Database lists: the games and tournament lists have a sortable Round column.
- Close a tab with a middle click.

### Improved

- Notation: stepping through moves no longer re-centres the list on every move. The list stays still and turns the page when the current move comes within three rows of the edge.
- Online downloads: the account card, the opponent download dialog and the player card show "1,234 of 5,678 games loaded" while games load.
- Player cards: "Prepare on board" is now available on Overview, Ratings and Preparation as well. Overview and Ratings open the start position as White with all games, Preparation uses that tab's colour and Since.
- Saving: "Save a copy…" adds the game as a new one. Saving an open game to the file or database it came from updates it in place ("Update this game") instead of adding a duplicate. Autosave shows a quiet "Saved" mark in the board bar.
- Converting a Library file to a repertoire asks for the colour you train.
- Settings keeps its category, search and scroll position while the Settings tab stays open.
- Readability: dimmed text is no longer faded with transparency, the Dim theme's active tabs, clocks and selected items are easier to read, and the current move and open variations are easier to find in the dark notation.
- Coach: a provider that takes too long now gets its own message instead of "The service gave an unexpected answer", and a ChatGPT sign-in refused because of account eligibility or limits now says so.

### Fixed

- The database preview board no longer jumps up and down while you step through the moves.
- After a Library file's type or name changes, open tabs and Recent files pick up the change immediately.
- "Train these lines" no longer leaves an empty New Tab behind.
- Long player names no longer push the board bar's buttons out of view.

## 1.4.0

### New

- Arrange the analysis board: drag Analysis, Report, Database, Annotate, Coach or Info out of the tab strip and drop it to the left, right, above or below the board, the notation, the tabs or another panel; a preview shows where it lands. The notation and the tabs move the same way, every move also works from a grip button with named places, "Return to the tabs" puts a panel back, and Settings → Analysis & notation → "Reset layout" restores the default. This replaces the Database panel's Pin menu and the setting "Panels beside the notation"; a pinned Database or a beside arrangement is carried over. When the window is too narrow for your arrangement, the board shows the plain tab layout until there is room again.
- Saved layouts: repertoire, game and opponent-preparation boards each keep their own arrangement. The board's More menu lists three ready-made layouts (Repertoire, Game review and Preparation) and your own saved layouts, with "Save layout as…" and "Manage layouts…" to save, rename and delete them; the View menu has "Save layout as…" and "Layouts…". Ctrl/Cmd+Alt+1 to 3 apply the first three layouts.
- Hide the tabs: the × on the analysis board's tab area hides it and gives its space to the other areas. "Show the tabs" in the notation header, the More menu or the View menu brings it back in the same place.
- Pull out individual engines on the analysis board: every engine uses one compact card with a six-dot grip on the left, start/pause, name, depth, position symbol, 1–5 line selector, threat check, settings and collapse. Drag the grip to reorder engines in the Analysis panel or pull any engine out onto the board as its own window (up to four at once), or click the grip to place it by keyboard; × or dragging it back over the tab list or Analysis header returns it. This replaces the pinned engine bar and its position menu; an existing pinned engine is carried over to the same spot.
- Report is now its own panel tab on the analysis board, alongside Analysis and Database, and can be pulled out as its own area; the Analysis panel shows the engine list directly without inner tabs or score pills.
- Focus mode: Ctrl/Cmd+Shift+F or View → "Hide the header" hides the top row with the tabs and menus, so the board gets more room. Move the pointer to the window's top edge to show the header again for a moment. Full screen (F11) is unchanged.
- Repertoire PGN import: start a new repertoire from a PGN file or pasted text, or merge a PGN into an open repertoire with "Import PGN" under Practice → Build. All games become one tree with the colour you choose. A reply for your side that differs from the repertoire is kept as a variation and marked, and "Mark as reviewed" in the move menu clears the mark.
- Variation shortcuts: Ctrl/Cmd+Up promotes a variation, Ctrl/Cmd+Delete deletes the variation you are in, and Shift+Delete deletes the moves after the current one. All three can be changed under Settings → Shortcuts → Editing, and the two deletions are also in the move menu.
- Scoresheet photos stay with the game: an imported game keeps its scoresheet photos, also after you save it to a PGN file and open it again on this computer. The Photo panel can be pulled out like the other panels and its controls fit in one row; a move's mark disappears once you correct it or choose "Mark as checked", so "Finish review" is gone.
- Files & folders: when you choose a new folder for databases, puzzles or engines and the old one has content, Studio asks whether to "Move files to new folder", "Use new folder only" or cancel. Moving keeps your databases, puzzles and engines working from the new place; if anything goes wrong, the old folder stays active and untouched, and a move interrupted by a crash is finished or undone at the next start.

### Improved

- Board bar: the button column beside the notation is gone. The bar above the board shows Play from here (Analyze game on a game tab, Take back in a live game), Flip Board, Save when there is something to save, and a More menu with "Save to file or database…", "Take Snapshot" and "Edit position". Edit position (E), Take Snapshot (Ctrl/Cmd+Shift+S) and Save to database (Ctrl/Cmd+Shift+D) have their own shortcuts, and Clear drawings now also works on the game screen. The notation has the same header as the other panels, with the eye button to hide moves and "View options" for table view, comments, diagrams and variations.
- Clocks: the board clocks are smaller and no longer show a progress bar. Beside the clock of the side that just moved, a muted figure shows how long that move took.
- Chess.com: a live game opened from a Chess.com link (browser extension or pasted URL) now carries each move's clock time.
- Explorer: every source shows White's score per move (wins plus half the draws) in a Score column beside Total.
- Explorer: a "Prepare on board" tab keeps its player, comparison columns and Lichess source after a restart.
- Player cards: the board on the Openings tab takes moves like a table row, starts larger and can be resized by dragging its edge; Studio remembers the size.
- Coach and Assistant: the question field spans the full width and starts at two lines, with the model button, new conversation and Send on one line below it. A model list that failed to load now offers Retry.
- Scoresheet import: add PDF scans as well as photos. Each PDF page counts as one of the four images, and Studio reads the pages on your computer before anything is sent. While the AI reads the sheet, a full-width progress button with a spinner shows that it is working, with Cancel right below.
- Dialogs: content no longer touches the line under a dialog's title, and the Import Game cards keep the same height (the photo card is now called "Photo").
- Files & folders: each row shows its folder's name, "Show in folder" opens it in your file manager, "Restore default" switches back to Studio's own folder, and the folder picker opens in the current folder. The PGN collection now has a default folder too.
- Your databases, puzzles, engines and PGN files now live in a visible folder in your home folder, "ChessRiddle Studio", with one subfolder each, instead of hidden application data. Folders you chose yourself stay where they are; Studio's previous default folders are moved there once at the next start.
- Assistant: drag its left edge, or use the arrow keys on it, to make the docked Assistant wider or narrower (from 20rem); double-click restores the default width, and Studio remembers your choice.
- Readability: no text apart from board coordinates and switch labels is smaller than 12px at the default font size, and table scrollbars no longer cover the last column.

### Fixed

- External links in the app (for example in About, the Feedback dialog, database credits and move comments) open in your browser again.
- The Feedback dialog fits a small window at a large font size.
- The label on a running progress button, such as "Generating report", is readable again in dark mode.
- macOS: shortcuts that use the Command key work.
- The notation keeps the current move in view after switching to table view.
- Coach on Linux: a sign-in stored in KWallet is read again when the keyring briefly fails to decrypt it.

## 1.3.0

### New

- Scoresheet photo import: choose, paste, or drop up to four photos of a handwritten scoresheet in Import Game to transcribe the moves with your connected AI model, check them against the rules of chess, and review and save the game beside the photo.
- Workspace restore: Studio reopens every tab after quitting, a crash or a shutdown, with the tab order, the active tab and the current move of each game. Restored games stay linked to their file or database. Turn it off with "Restore open tabs at start" in Settings → App → Advanced; games with unsaved changes come back either way.
- Hide moves: an eye button in game previews hides the moves, so a preview does not give away a puzzle's solution. Games you open from a preview start hidden too, and "Show moves" reveals one game at a time. The same switch is in Settings → Analysis & notation.
- Dim theme: a lighter dark theme, as on the ChessRiddle website. Choose it in Settings → General → Theme.
- Databases: "All" in the records-per-page menu shows the games, players and tournaments lists as one continuous list that loads more rows as you scroll, up to 10,000 rows.
- Opponent preparation: the Openings tab on a player's card shows what the player plays now. A "Recently" column counts each move in their last 10 games in that position, and a line above the table names their recent choice over the board and online.

### Improved

- Explorer: Lichess All and Lichess Masters are now sources like your databases. Pick them in the Database panel's source drop-down or under Compare, in the "Online" group, to see a local database and Lichess side by side without downloading anything. Each Lichess column has its own filters and needs a signed-in Lichess account. The Local / Lichess All / Lichess Masters switch is gone.
- Explorer: on a board opened with "Prepare on board", "Add column" adds your reference database, Lichess All or Lichess Masters as a further column, up to three columns.
- Explorer: with two or more columns, a column whose source cannot answer is named above the table and its cells stay empty instead of showing dashes.
- Opponent preparation: the year strip in the Openings tab shades each year by the move's share of that year's games.
- Engines: the Logs tab in the Analysis panel is gone. A local engine's logs open from its engine card, and from a Logs button beside Retry when the engine fails.
- Settings: the Board settings show a live board preview with your board, pieces and highlights.
- Settings: click anywhere on a switch's row to flip it.
- All drop-down menus share one look, and features and categories are marked with icons across Studio.
- The unsaved-changes dialog has a close button.
- Add Database names the author, website and licence of the Lumbra's Gigabase and Caissabase downloads.
- Databases: sorting a large database by Date is much faster. The first time you open an existing database, Studio builds the index this needs, so that first open can take longer.

### Fixed

- Chess.com: adding an account no longer fails when its archive lists a month without games.
- Coach: a Grok account without credits now says so instead of reporting that the subscription cannot be used.
- New Tab, Guide and Settings stay centred in wide windows.
- Feedback: the type choices wrap onto a second row instead of being cut off in some languages.

## 1.2.0

### New

- Library sync: "Sync with ChessRiddle" in the Library keeps your PGN files in your private Library on chessriddle.com. Every file is selected, also files you add later, and you can deselect single files. Saving a file updates its website copy. It needs a connected ChessRiddle account.
- Guide: Help → Guide explains every feature of Studio, in every interface language.
- Opponent preparation: open the new Preparation tab on a player's card to compare their over-the-board and online games with your repertoire, list the lines they play and your uncovered gaps, open a line with only their variations shown, and train those lines in a timed session.
- Opponent preparation: a "Minimum games" choice hides lines and gaps the opponent played only rarely, in the lists, in the opened file and in the training.
- Opponent preparation: use "Online opponent" in the Library to look up a Lichess or Chess.com account, download their games, and open their player card on the Preparation tab without needing a game in a database first; entering the same account again opens the card without downloading a second copy.
- Explorer: when you open a board from a database player's "Prepare on board" button, your reference database appears as an extra column beside the opponent's games and can be removed and restored.

### Improved

- Settings: the categories are grouped, and each page is divided into titled sections.
- Databases: sort the game list by White, Black, Result, Event and Site, not only by Date and Plies.
- Coach: choose the AI model in Settings → AI or with the model button beside Send.

### Fixed

- Windows: editing games in PGN files, deleting and moving them, PGN export and Lichess browser sign-in work again.
- A refused autosave no longer repeats on every board refresh with a stack of error messages.

## 1.1.0

### New

- Coach: ask an AI about the position on the board. It checks its answers with your own engine and can draw on your reference database and your repertoire. Sign in with ChatGPT or Grok, use an API key (OpenAI, Google Gemini, DeepSeek, Qwen, OpenRouter), or run a local model (Ollama, LM Studio).
- Assistant: an AI helper that explains Studio, takes you straight to the right setting and helps you write feedback. It needs a connected AI.
- Opponent preparation: link an opponent's Lichess and Chess.com accounts to their player card, import their online games in one step and see them beside their over-the-board games.
- Opening training: train all your repertoires for a set number of minutes. Lines that come up often in real games come first and are repeated more.
- Browser extension: an "Analyze in ChessRiddle Studio" button on Lichess and Chess.com opens a finished game in Studio. Get it for [Chrome](https://chromewebstore.google.com/detail/jjacoekjgdobdagnphpghaaecehnkaga) or [Firefox](https://addons.mozilla.org/firefox/addon/analyze-in-chessriddle-studio/); the Safari version is included in the Mac app.
- Notation: open variations are marked and counted, transpositions into other chapters are marked, and ChessBase diagram markers are shown.
- Undo and redo for every edit on the analysis board.
- Unsaved games survive quitting and crashes, and quitting offers to save them.
- Explorer: compare two databases side by side, merge several sources in the opening tree, pin the database panel, filter position search by time control. Filters are saved per database.

### Improved

- A new navigation row replaces the title row, the sidebar and the tab strip. Accounts, Engines and Settings open as tabs.
- Stronger last-move highlight with its own colour setting, arrows in six colours, and any engine can drive the evaluation bar.
- Game reports explain themselves, and a new report replaces the previous one.
- Settings can open directly at a setting, and a new Advanced section offers Reload, Clear saved data and Open logs.
- Windows and macOS installers are now signed (macOS also notarized), so the system no longer warns about an unknown developer.

### Fixed

- Many bug fixes across databases, analysis, engines and saving.
