---
id: game-report
title: Revisione della partita e report
summary: Analizza una partita con un motore locale per vedere precisione, grafici di valutazione e tempo, note su apertura e repertorio e momenti chiave sulla scacchiera.
source: d1a4339820f36de2
---

Il report della partita analizza ogni mossa della linea principale con un motore scacchistico locale e trasforma i risultati in una revisione guidata della partita.

Per generare un report, apri una partita sulla scacchiera di analisi, passa alla scheda {{label:Board.Analysis.Report}} e fai clic su {{label:Board.Analysis.GenerateReport}} (oppure premi la scorciatoia {{label:Settings.Keybinds.Actions.GENERATE_REPORT}}).

Nella finestra {{label:Board.Analysis.GenerateReport}}:
- Scegli un {{label:Common.Engine}} locale. Se non ce n'è nessuno installato, aggiungine uno in [[page:engines]].
- Imposta il limite di ricerca per mossa (profondità, tempo o nodi).
- Attiva {{label:Board.Analysis.MarkMoves}} per annotare le mosse con i simboli di qualità (`!!`, `!`, `!?`, `?!`, `?`, `??`).
- Attiva {{label:Board.Analysis.ShowVariations}} per inserire nella notazione le varianti migliori.
- Attiva {{label:Board.Analysis.AnnotateNovelties}} per contrassegnare con `N` la prima mossa che esce dal tuo database di riferimento. Questa opzione richiede un database di riferimento pronto selezionato in [[page:library]].
- Fai clic su {{label:Board.Analysis.Analyze}} per iniziare.

Mentre il report è in esecuzione, puoi annullarlo dal pulsante di avanzamento. Anche la modifica della linea principale annulla un report in corso.

Al termine, {{label:Board.Analysis.Report}} mostra:
- Un'intestazione discreta con motore, limite di ricerca e data, oltre a un piccolo pulsante {{label:Board.Analysis.Report.Regenerate}} accanto. Il pulsante a tutta larghezza {{label:Board.Analysis.GenerateReport}} appare solo quando non c'è un report aggiornato.
- Una frase di riepilogo sopra il tabellone quando la partita è iniziata da una posizione equilibrata; da una posizione iniziale sbilanciata non viene mostrata alcuna frase.
- Un unico tabellone con nomi e punteggi Elo dei giocatori, {{label:Board.Analysis.Accuracy}} come valore principale, {{label:Board.Analysis.Report.AverageLoss}}, precisione per fase di gioco e le sei righe di qualità delle mosse con gli zeri attenuati. Facendo clic su un conteggio diverso da zero si salta a quelle mosse, e passando il puntatore o portando il focus da tastiera su qualsiasi etichetta se ne legge la spiegazione.
- Un grafico che commuta tra {{label:Board.Analysis.Report.Evaluation}} (con linea dello zero) e {{label:Board.Analysis.Report.WinChance}}, ciascuna spiegata al passaggio del puntatore o al focus da tastiera. Quando almeno la metà delle mosse include i tempi dell'orologio, sotto il grafico appare una barra {{label:Board.Analysis.Report.TimeUsage}}; fai clic su qualsiasi barra per andare a quella mossa.
- Un riquadro di apertura e repertorio con il nome dell'apertura, la novità (`N`) quando presente e una nota sul repertorio solo per il tuo lato — abbinato per nome del giocatore ai tuoi account Lichess, Chess.com o alias collegati in [[page:accounts]], oppure al lato in basso sulla scacchiera se nessun nome corrisponde (capovolgere la scacchiera cambia quel lato). Mostra dove sei uscito dal repertorio (un clic mette a fuoco la posizione con le frecce) o fino a che punto lo hai seguito. Se non è stato possibile leggere completamente i file del repertorio, mostra una sola riga attenuata: {{label:Board.Analysis.Report.RepertoireIncomplete}}
- {{label:Board.Analysis.Report.KeyMoments}}: fai clic su una riga per andare alla posizione prima della mossa, così entrambe le frecce sulla scacchiera (la mossa giocata e la mossa migliore) partono da quella casa. Usa {{label:Board.Analysis.Report.PreviousMoment}} e {{label:Board.Analysis.Report.NextMoment}} per scorrerli, oppure filtra per {{label:Board.Analysis.Report.FilterBoth}}, {{label:Board.Analysis.Report.FilterWhite}} o {{label:Board.Analysis.Report.FilterBlack}}. I momenti mostrano anche etichette come {{label:Board.Analysis.Report.Tag.TurningPoint}} o {{label:Board.Analysis.Report.Tag.TimeTrouble}} e il tipo di errore quando le linee del motore lo dimostrano.
- Sui momenti `?!`, `?` e `??`, fai clic su {{label:Board.Analysis.Report.Explain}} per mettere a fuoco quella posizione e aprire {{label:Board.Tabs.Coach}} con una domanda su quel momento. Questo pulsante è nascosto quando non è configurata alcuna connessione IA.

Se modifichi la partita in seguito, rigenera il report con {{label:Board.Analysis.GenerateReport}} o {{label:Board.Analysis.Report.Regenerate}} per aggiornare la revisione.
