---
id: repertoires
title: Repertori di apertura
summary: Crea un repertorio, costruisci la copertura rispetto a un database di riferimento, allenati con la ripetizione dilazionata e monitora varianti aperte e trasposizioni.
source: 62b7ff51627518a7
---

I repertori sono file PGN di tipo Repertorio che aggiungono la scheda {{label:Board.Tabs.Practice}} alla scacchiera di analisi.

Per creare un repertorio, apri [[page:new-tab]] e fai clic su {{label:Home.Card.NewRepertoire.Title}} (oppure crea un file di repertorio in [[page:library]]). Inserisci un {{label:Common.Name}}, scegli {{label:Common.WHITE}} o {{label:Common.BLACK}} e fai clic su {{label:Common.Create}}.

Costruisci il tuo repertorio in {{label:Board.Tabs.Practice}} -> {{label:Board.Practice.Build}}:
- Imposta un {{label:Databases.Settings.ReferenceDatabase}} in [[page:library]] così il costruttore può mostrare frequenze di mossa e copertura.
- Su un repertorio vuoto puoi partire da uno dei modelli integrati di {{label:Board.Practice.Build.Presets}} oppure inserire mosse sulla scacchiera.
- Imposta la posizione iniziale del repertorio usando {{label:Board.Practice.Build.SetAsStart}} (oppure fai clic destro su una mossa nella notazione e scegli {{label:Menu.MarkAsStart}}).
- Fai clic sulle mosse in {{label:Board.Practice.Build.OpponentMoves}} o {{label:Board.Practice.Build.YourResponse}} per aggiungere o seguire linee. Usa {{label:Board.Practice.Build.NextGap}} e {{label:Board.Practice.Build.BiggestGap}} per passare alle risposte avversarie scoperte sopra il numero minimo di partite impostato in [[setting:repertoire-depth]].

Allenati con il repertorio in {{label:Board.Tabs.Practice}} -> {{label:Board.Practice.Train}}:
- Fai clic su {{label:Board.Practice.StartPractice}} per ripassare le posizioni in scadenza e nuove con la ripetizione dilazionata, oppure su {{label:Board.Practice.PracticeFullRepertoire}} per allenare ogni posizione del repertorio.
- Gioca la tua mossa preparata sulla scacchiera. Se resti bloccato dopo una mossa sbagliata, fai clic su {{label:Board.Practice.ShowMove}}.
- Esamina tutte le schede con {{label:Board.Practice.ShowAll}}, consulta la cronologia con {{label:Board.Practice.ShowLogs}} oppure azzera i progressi con {{label:Common.Reset}}.
- I repertori con posizioni da ripassare compaiono anche sotto {{label:Home.Library.Due}} su [[page:new-tab]].
- Configura la valutazione della ripetizione dilazionata e il limite di nuove posizioni in [[settings-category:repertoire]] ([[setting:practice-grading]], [[setting:practice-new-per-session]]).

Nella notazione sulla scacchiera di analisi:
- Una linea secondaria lunga una sola mossa viene incorniciata con bordo tratteggiato come {{label:Notation.OpenVariation}} per aiutarti a individuare rami incompleti. Premi la scorciatoia {{label:Settings.Keybinds.Actions.NEXT_OPEN_VARIATION}} per passare alla successiva.
- Quando una posizione compare in un altro ramo dello stesso repertorio, accanto alla mossa compare l’icona {{label:Notation.Transposition}}; facci clic sopra per passare all’altro ramo.
