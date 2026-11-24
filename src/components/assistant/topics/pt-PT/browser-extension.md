---
id: browser-extension
title: Extensão do navegador e ligações de partidas
summary: Abra partidas do Lichess e do Chess.com diretamente no Studio usando ligações chessriddle-studio://.
source: 7059f7f7afa1559d
---

O ChessRiddle Studio processa ligações de partidas `chessriddle-studio://` enviadas pela extensão do navegador ou pelo sistema operativo.

Quando uma ligação `chessriddle-studio://import?url=<game URL>` de uma partida do Lichess ou do Chess.com é aberta:
- O Studio obtém o PGN da partida a partir do Lichess ou do Chess.com.
- A partida abre-se num novo separador de análise e coloca a janela no tabuleiro.
- Enquanto a partida está a carregar, uma notificação mostra o progresso e indica qualquer erro se não for possível obter a partida.

No macOS e no Windows, o instalador regista automaticamente o esquema de URL `chessriddle-studio://`. Nas compilações AppImage para Linux, o Studio regista ao iniciar um gestor de ambiente de trabalho para `chessriddle-studio://` para que o navegador possa passar as ligações à aplicação.

Também pode importar manualmente qualquer URL de partida do Lichess ou do Chess.com sem a extensão abrindo [[page:new-tab]], clicando em {{label:Home.Card.ImportGame.Button}}, escolhendo {{label:Import.Online}} e colando o {{label:Import.GameURL}}.
