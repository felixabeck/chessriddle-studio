---
id: import-game
title: Importare una partita
summary: Importa una partita da un file PGN, da testo PGN incollato, da un URL di Lichess o Chess.com, da una posizione FEN oppure da foto o scansioni PDF di un formulario manoscritto.
source: 85ee9b055c7abe34
---

Per importare una partita o una posizione, apri [[page:new-tab]] e fai clic su {{label:Home.Card.ImportGame.Button}} per aprire la finestra {{label:Home.Card.ImportGame.Title}}. Puoi anche aprire un file PGN direttamente da {{label:Menu.File}} -> {{label:Menu.File.OpenFile}} (o con la scorciatoia {{label:Settings.Keybinds.Actions.OPEN_FILE}}).

Nella finestra {{label:Home.Card.ImportGame.Title}}, scegli una delle opzioni:
- **PGN**: scegli un {{label:Common.PGNFile}} dal tuo computer o incolla il testo in {{label:Common.PGNGame}}. Seleziona {{label:Import.SaveToCollection}} per salvare una copia nella tua cartella di lavoro in [[page:library]], poi inserisci un {{label:Common.Name}} e scegli un {{label:Files.FileType}}.
- **{{label:Import.Online}}**: incolla un {{label:Import.GameURL}} di Lichess o Chess.com per scaricare la partita e aprirla su una scacchiera di analisi.
- **FEN**: incolla una stringa FEN per aprire una scacchiera di analisi da quella posizione.
- **{{label:Import.FromPhoto}}** (quando le funzioni IA sono disponibili): trascrivi da 1 a 4 foto o pagine PDF di un formulario manoscritto in una nuova partita. Richiede almeno una connessione IA in [[settings-category:coach]] ({{label:Settings.AI}}).

Per PGN, {{label:Import.Online}} e FEN, fai clic su {{label:Home.Card.ImportGame.Button}} per caricare la partita nella scheda corrente.

Per importare con **{{label:Import.FromPhoto}}**:
- Aggiungi fino a 4 foto JPEG, PNG o WebP o pagine PDF tramite {{label:Scoresheet.Intake.ChoosePhotos}}, {{label:Scoresheet.Intake.PasteFromClipboard}} (oppure Ctrl+V / Cmd+V mentre il pannello è aperto) o trascinando e rilasciando le foto o i file PDF sul pannello aperto. Incollare funziona solo con le foto. Ogni pagina PDF conta come una foto; di un PDF più lungo vengono usate le prime pagine.
- Scegli la connessione IA e un modello compatibile con le immagini dal pulsante del modello o in [[setting:coach-model]] ({{label:Settings.Coach.Model}}).
- Fai clic su {{label:Scoresheet.Read.Button}} per iniziare. Prima della prima lettura su una connessione, {{label:Scoresheet.Notice.Title}} spiega che le foto selezionate (inclusi i nomi dei giocatori e tutto ciò che è scritto sul formulario) vengono inviate a quel fornitore, che i metadati come la posizione della fotocamera vengono prima rimossi e che non vengono inviati altri dati.
- Studio controlla ogni mossa secondo le regole standard degli scacchi dalla posizione iniziale e apre la partita in una nuova scheda di analisi non salvata con il pannello {{label:Board.Tabs.Photo}} accanto alla scacchiera.
- Le mosse incerte o corrette vengono segnalate nella notazione. Scorrile nel pannello {{label:Board.Tabs.Photo}} e fai clic su {{label:Scoresheet.MarkAsChecked}} dopo averle verificate. Se correggi una mossa nel mezzo o prosegui dopo un punto di arresto, fai clic su {{label:Scoresheet.ContinueWithSheet}} per riprodurre le successive mosse legali del formulario. I contrassegni restano finché ogni mossa non viene corretta o segnata come verificata, e il pannello {{label:Board.Tabs.Photo}} può essere trascinato fuori dalle schede e posizionato come gli altri pannelli.
- Salva la partita in un file o database con il normale flusso di salvataggio ({{label:Menu.File}} -> {{label:Common.Save}}, il pulsante di salvataggio o {{label:Board.Database.Save}}).
- Le foto restano solo in memoria (fino a 4 schede aperte) e non vengono salvate su disco; dopo un ricaricamento o un riavvio la partita e i contrassegni restano, e puoi usare {{label:Scoresheet.LoadPhotoAgain}} nel pannello {{label:Board.Tabs.Photo}} per rivedere la foto senza inviarla.
