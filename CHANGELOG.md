# Changelog

What changed in each ChessRiddle Studio release. The release workflow copies a version's section into its GitHub release, so keep each section plain Markdown: headings, lists and links.

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
