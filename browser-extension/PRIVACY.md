# Privacy policy: Analyze in ChessRiddle Studio

Analyze in ChessRiddle Studio reads the current URL and game-interface elements on
Chess.com and Lichess to add a link for the displayed game. All detection runs
locally in your browser.

The extension does not collect or store personal information, record browsing
history, use analytics, or send network requests. It has no extension servers.

When you choose **Analyze in ChessRiddle Studio**, your browser passes the game's
canonical public URL to your installed ChessRiddle Studio desktop application
through the `chessriddle-studio:` protocol. Query parameters, fragments, and
Lichess player secrets are removed. ChessRiddle Studio then retrieves the game
directly from the chess service, exactly as its own game import does.

The extension runs only on `https://chess.com`, `https://www.chess.com`, and
`https://lichess.org`. You can revoke site access or uninstall it through your
browser's extension settings.

Questions and reports: https://github.com/felixabeck/chessriddle-studio/issues
