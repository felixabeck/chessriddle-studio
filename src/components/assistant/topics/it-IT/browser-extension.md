---
id: browser-extension
title: Estensione del browser e collegamenti alle partite
summary: Apri le partite di Lichess e Chess.com direttamente in Studio tramite i collegamenti chessriddle-studio://.
source: 7059f7f7afa1559d
---

ChessRiddle Studio gestisce i collegamenti `chessriddle-studio://` inviati dall’estensione del browser o dal tuo sistema operativo.

Quando viene aperto un collegamento `chessriddle-studio://import?url=<game URL>` per una partita su Lichess o Chess.com:
- Studio recupera il PGN della partita da Lichess o Chess.com.
- La partita si apre in una nuova scheda di analisi e porta la finestra sulla scacchiera.
- Durante il caricamento della partita, una notifica mostra l’avanzamento e segnala eventuali errori se non è possibile recuperare la partita.

Su macOS e Windows, il programma di installazione registra automaticamente lo schema URL `chessriddle-studio://`. Nelle build AppImage per Linux, Studio registra all’avvio un gestore desktop per `chessriddle-studio://` in modo che il browser possa passare i collegamenti all’app.

Puoi anche importare manualmente qualsiasi URL di partita Lichess o Chess.com senza l’estensione aprendo [[page:new-tab]], facendo clic su {{label:Home.Card.ImportGame.Button}}, scegliendo {{label:Import.Online}} e incollando l’{{label:Import.GameURL}}.
