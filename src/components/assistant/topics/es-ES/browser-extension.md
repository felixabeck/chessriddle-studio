---
id: browser-extension
title: Extensión del navegador y enlaces de partidas
summary: Abre partidas de Lichess y Chess.com directamente en Studio mediante enlaces chessriddle-studio://.
source: 7059f7f7afa1559d
---

ChessRiddle Studio gestiona los enlaces `chessriddle-studio://` enviados por la extensión del navegador o por tu sistema operativo.

Cuando se abre un enlace `chessriddle-studio://import?url=<game URL>` de una partida de Lichess o Chess.com:
- Studio obtiene el PGN de la partida desde Lichess o Chess.com.
- La partida se abre en una nueva pestaña de análisis y pasa la ventana al tablero.
- Mientras la partida se carga, una notificación muestra el progreso e informa de cualquier error si no se puede obtener la partida.

En macOS y Windows, el instalador registra automáticamente el esquema de URL `chessriddle-studio://`. En las versiones AppImage de Linux, Studio registra al iniciarse un controlador de escritorio para `chessriddle-studio://` para que el navegador pueda pasar los enlaces a la aplicación.

También puedes importar manualmente cualquier URL de partida de Lichess o Chess.com sin la extensión abriendo [[page:new-tab]], haciendo clic en {{label:Home.Card.ImportGame.Button}}, eligiendo {{label:Import.Online}} y pegando la {{label:Import.GameURL}}.
