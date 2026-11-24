---
id: browser-extension
title: Extension de navigateur et liens de partie
summary: Ouvrez des parties Lichess et Chess.com directement dans Studio grâce aux liens chessriddle-studio://.
source: 7059f7f7afa1559d
---

ChessRiddle Studio prend en charge les liens de partie `chessriddle-studio://` envoyés par l’extension de navigateur ou votre système d’exploitation.

Lorsqu’un lien `chessriddle-studio://import?url=<game URL>` vers une partie Lichess ou Chess.com est ouvert :
- Studio récupère le PGN de la partie depuis Lichess ou Chess.com.
- La partie s’ouvre dans un nouvel onglet d’analyse et place la fenêtre sur l’échiquier.
- Pendant le chargement de la partie, une notification indique la progression et signale toute erreur si la partie ne peut pas être récupérée.

Sur macOS et Windows, le programme d’installation enregistre automatiquement le schéma d’URL `chessriddle-studio://`. Sur les builds AppImage Linux, Studio enregistre au lancement un gestionnaire de bureau pour `chessriddle-studio://` afin que le navigateur puisse transmettre les liens à l’application.

Vous pouvez également importer manuellement n’importe quelle URL de partie Lichess ou Chess.com sans l’extension en ouvrant [[page:new-tab]], en cliquant sur {{label:Home.Card.ImportGame.Button}}, en choisissant {{label:Import.Online}} et en collant l’{{label:Import.GameURL}}.
