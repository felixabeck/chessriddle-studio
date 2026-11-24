---
id: browser-extension
title: Browser extension and game links
summary: Open Lichess and Chess.com games directly in Studio using chessriddle-studio:// game links.
---

ChessRiddle Studio handles `chessriddle-studio://` game links sent by the browser extension or your operating system.

When a `chessriddle-studio://import?url=<game URL>` link for a Lichess or Chess.com game is opened:
- Studio fetches the game's PGN from Lichess or Chess.com.
- The game opens in a new analysis tab and switches the window to the board.
- While the game is loading, a notification shows progress and reports any error if the game cannot be fetched.

On macOS and Windows, the installer registers the `chessriddle-studio://` URL scheme automatically. On Linux AppImage builds, Studio registers a desktop handler for `chessriddle-studio://` when launched so the browser can hand links to the app.

You can also import any Lichess or Chess.com game URL manually without the extension by opening [[page:new-tab]], clicking {{label:Home.Card.ImportGame.Button}}, choosing {{label:Import.Online}}, and pasting the {{label:Import.GameURL}}.
