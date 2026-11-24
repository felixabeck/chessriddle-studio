---
id: chessbase-import
title: Importare database da ChessBase
summary: Esporta un database ChessBase in formato PGN e convertilo in un database di Studio.
source: d7f599a811a0afb0
---

ChessRiddle Studio non legge direttamente i file `.cbh` o `.cbv` di ChessBase. Esporta invece prima il tuo database ChessBase in PGN e poi converti il file PGN in un database di Studio.

Se selezioni un file ChessBase in un selettore di file, Studio apre automaticamente la finestra {{label:ChessBaseGuide.Title}}. Puoi aprirla anche dal collegamento alla guida dentro {{label:Library.AddDatabase}} in [[page:library]].

Segui questi passaggi per importare da ChessBase:
1. Apri il database in ChessBase e seleziona le partite che desideri esportare.
2. Esporta o salva le partite selezionate come file `.pgn` in ChessBase.
3. In Studio, apri [[page:library]], fai clic su {{label:Library.AddDatabase}}, passa alla scheda {{label:Common.Local}}, seleziona il file `.pgn` esportato, assegna un {{label:Common.Name}} e fai clic su {{label:Databases.Add.Convert}}.

Una volta convertito, il database compare in [[page:library]], dove puoi esplorarne partite, giocatori e tornei oppure impostarlo come {{label:Databases.Settings.ReferenceDatabase}}.
