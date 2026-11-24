---
id: browser-extension
title: Browser-Erweiterung und Partielinks
summary: Öffne Partien von Lichess und Chess.com über chessriddle-studio://-Partielinks direkt in Studio.
source: 7059f7f7afa1559d
---

ChessRiddle Studio verarbeitet `chessriddle-studio://`-Partielinks, die von der Browser-Erweiterung oder deinem Betriebssystem gesendet werden.

Wenn ein Link `chessriddle-studio://import?url=<game URL>` für eine Partie auf Lichess oder Chess.com geöffnet wird:
- Studio ruft das PGN der Partie von Lichess oder Chess.com ab.
- Die Partie öffnet sich in einem neuen Analyse-Tab und holt das Studio-Fenster in den Vordergrund.
- Während die Partie geladen wird, zeigt eine Benachrichtigung den Fortschritt an und meldet Fehler, falls die Partie nicht abgerufen werden kann.

Unter macOS und Windows registriert das Installationsprogramm das URL-Schema `chessriddle-studio://` automatisch. Bei Linux-AppImage-Builds registriert Studio beim Start einen Desktop-Handler für `chessriddle-studio://`, damit der Browser Links an die App übergeben kann.

Du kannst jede Lichess- oder Chess.com-Partie-URL auch manuell ohne Erweiterung importieren: Öffne [[page:new-tab]], klicke auf {{label:Home.Card.ImportGame.Button}}, wähle {{label:Import.Online}} und füge die {{label:Import.GameURL}} ein.
