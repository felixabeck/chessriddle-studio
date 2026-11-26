---
id: engines
title: Motori scacchistici e pannello di analisi
summary: Installa o aggiungi motori locali e cloud, configura le opzioni UCI e usa l’analisi in tempo reale sulla scacchiera.
source: f40b5fdf8e5c15a0
---

Gestisci i tuoi motori scacchistici su [[page:engines]] ({{label:SideBar.Engines}}).

Per aggiungere un motore, fai clic su {{label:Common.AddNew}} su [[page:engines]] per aprire {{label:Engines.Add.Title}}:
- {{label:Common.Download}}: installa un motore preconfigurato (come Stockfish) dal catalogo con {{label:Common.Install}}.
- {{label:Engines.Add.Cloud}}: aggiungi motori di analisi online (ChessDB o Lichess Cloud) con {{label:Common.Add}}.
- {{label:Common.Local}}: registra un file eseguibile UCI già presente sul tuo computer.

Seleziona un motore su [[page:engines]] per configurarlo. Per i motori locali puoi modificare i dettagli generali, impostare le opzioni UCI predefinite (come Threads, Hash e MultiPV), collegare file di risorse come le tablebase Syzygy, fare clic su {{label:Engines.Settings.Reset}} per ripristinare i valori predefiniti, {{label:Common.Duplicate}} per copiare la configurazione o {{label:Common.Remove}} per rimuoverlo. Per i motori cloud puoi modificare il nome e {{label:Engines.Settings.NumOfLines}}.

Sulla scacchiera di analisi, apri la scheda {{label:Board.Tabs.Analysis}}:
- Fai clic su {{label:Board.Analysis.SelectEngines}} per scegliere quali motori installati caricare nel pannello, oppure su {{label:Board.Analysis.ManageEngines}} per passare a [[page:engines]].
- Fai clic su {{label:Board.Analysis.EnableEngine}} o {{label:Board.Analysis.DisableEngine}} sulla scheda di un motore per avviare o mettere in pausa l’analisi, oppure usa {{label:Board.Analysis.EnableAllEngines}} nella riga inferiore.
- Fai clic su {{label:Board.Analysis.CheckThreat}} (o premi la scorciatoia {{label:Settings.Keybinds.Actions.TOGGLE_THREAT_MODE}}) per analizzare la minaccia dell’avversario.
- Usa il selettore delle linee sulla scheda per scegliere da 1 a 5 linee, oppure fai clic su {{label:Board.Analysis.EngineSettings}} per regolare le impostazioni per scheda come il limite di ricerca e le opzioni UCI.
- Trascina una scheda motore dalla sua impugnatura a sei punti ({{label:Board.Analysis.ReorderEngine}}) per riordinarla o portarla sulla scacchiera come finestra propria, oppure fai clic sull’impugnatura per spostarla da tastiera. Fai clic su {{label:Board.Area.ReturnToEngines}} o trascina la finestra sulla barra delle schede (o sull’intestazione di {{label:Board.Tabs.Analysis}}) per riportarla indietro.
- Se un motore si interrompe, fai clic su {{label:Board.Analysis.Logs}} accanto a {{label:Board.Analysis.RetryEngine}} per consultare la sua comunicazione UCI. Per un motore in funzione, lo stesso pulsante si trova in {{label:Board.Analysis.EngineSettings}} sulla sua scheda.

Controlla le frecce del motore sulla scacchiera con [[setting:arrows]] ({{label:Settings.Arrows}}). I motori locali sono archiviati nella cartella impostata in [[setting:engines-directory]].
