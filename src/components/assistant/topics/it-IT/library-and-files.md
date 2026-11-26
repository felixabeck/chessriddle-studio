---
id: library-and-files
title: File e Biblioteca
summary: Configura una cartella di lavoro, crea e organizza file PGN, apri e salva partite e gestisci il cestino.
source: 4417697a9a5cd025
---

[[page:library]] ({{label:SideBar.Library}}) riunisce i file PGN del tuo spazio di lavoro (partite, repertori, tornei, puzzle e altri file) e i tuoi database di partite.

Prima di creare file, scegli una cartella di lavoro. Se non è ancora impostata alcuna cartella, fai clic su {{label:Files.ChooseFolder}} in [[page:library]], oppure configura [[setting:files-directory]] ({{label:Settings.Directories.Files}}) sotto [[settings-category:directories]].

Su [[page:library]]:
- Fai clic su {{label:Files.CreateFile}} per creare un nuovo file PGN o su {{label:Files.CreateFolder}} per organizzare i file in sottocartelle.
- Usa il campo {{label:Common.Search}} e il menu {{label:Files.FileType}} per filtrare per tipo di file o {{label:Library.GamesDatabase}}.
- Seleziona un file per visualizzarne l’anteprima delle partite (l’anteprima può nascondere le mosse con il pulsante a forma di occhio, [[setting:hide-preview-moves]]), aprirlo sulla scacchiera di analisi oppure usare {{label:Files.Rename}}, {{label:Files.Move}} e {{label:Files.Trash}}.

Mentre modifichi un file sulla scacchiera di analisi:
- Salva le modifiche con il pulsante di salvataggio nella barra superiore della scacchiera (visibile quando il salvataggio automatico è disattivato, non disponibile o non è riuscito), {{label:Menu.File}} -> {{label:Common.Save}}, oppure con la scorciatoia {{label:Settings.Keybinds.Actions.SAVE_FILE}}.
- Attiva [[setting:auto-save]] ({{label:Settings.AutoSave}}) per salvare automaticamente le modifiche ai file aperti.
- Usa {{label:Menu.File}} -> {{label:Board.Database.Save}} (o {{label:Board.Action.More}} -> {{label:Board.Database.Save}} nella barra superiore della scacchiera) per salvare la partita corrente in un altro file della libreria o database.

Spostare un file in {{label:Files.Trash}} non lo elimina subito in modo definitivo. Puoi fare subito clic su {{label:Common.Undo}} nell’avviso, oppure scorrere fino alla sezione {{label:Files.Trash}} in [[page:library]] per usare {{label:Files.Restore}}, {{label:Files.DeletePermanently}} o {{label:Files.EmptyTrash}}.

Quando il tuo account ChessRiddle è collegato, fai clic su {{label:Library.Sync.Action}} su [[page:library]] per sincronizzare i file PGN selezionati con la tua libreria privata su ChessRiddle (fino a 100 file, 5 MB e 40.000 mosse per file). Modifiche, rinomine, deselezioni ed eliminazioni si aggiornano automaticamente; le cronologie delle partite scaricate e i database di partite restano in locale. Disattivando la sincronizzazione puoi scegliere se mantenere o rimuovere i file sincronizzati su ChessRiddle.
