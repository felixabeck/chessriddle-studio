# Changelog

What changed in each ChessRiddle Studio release. The release workflow copies a version's section into its GitHub release, so keep each section plain Markdown: headings, lists and links.

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
