---
id: game-report
title: Report della partita
summary: Esegui una revisione automatica della partita con il motore per visualizzare precisione, grafico di valutazione, momenti chiave e classificazione delle mosse.
source: b69aae8a4fe0f417
---

Il report della partita analizza ogni mossa della linea principale con un motore scacchistico locale e riassume precisione ed errori della partita.

Per generare un report, apri una partita sulla scacchiera di analisi, passa alla scheda {{label:Board.Analysis.Report}} e fai clic su {{label:Board.Analysis.GenerateReport}} (oppure premi la scorciatoia {{label:Settings.Keybinds.Actions.GENERATE_REPORT}}).

Nella finestra {{label:Board.Analysis.GenerateReport}}:
- Scegli un {{label:Common.Engine}} locale. Se non ne hai nessuno installato, aggiungine uno su [[page:engines]].
- Imposta il limite di ricerca per mossa (profondità, tempo o nodi).
- Attiva {{label:Board.Analysis.MarkMoves}} per annotare le mosse con simboli di qualità.
- Attiva {{label:Board.Analysis.ShowVariations}} per inserire varianti con mosse migliori nella notazione.
- Attiva {{label:Board.Analysis.AnnotateNovelties}} per contrassegnare la prima mossa che esce dal tuo database di riferimento. Questa opzione richiede un database di riferimento pronto selezionato in [[page:library]].
- Fai clic su {{label:Board.Analysis.Analyze}} per iniziare.

Mentre un report è in esecuzione, puoi annullarlo dal pulsante di avanzamento. Modificare la linea principale annulla un report in corso.

Al termine, {{label:Board.Analysis.Report}} mostra:
- Percentuali di precisione e perdita media in centesimi di pedone (ACPL) per {{label:Common.WHITE}} e {{label:Common.BLACK}}.
- Un grafico della valutazione lungo l’intera partita.
- {{label:Board.Analysis.Report.KeyMoments}}: elenco cliccabile delle mosse evidenziate con oscillazioni di valutazione e mosse migliori.
- Una tabella riepilogativa della qualità delle mosse in cui fare clic su un conteggio porta alle mosse corrispondenti.

Se modifichi la partita in seguito, fai clic su {{label:Board.Analysis.RegenerateReport}} per eseguire una nuova analisi.
