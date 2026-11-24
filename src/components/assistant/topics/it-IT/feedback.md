---
id: feedback
title: Feedback, registri, cancellazione dei dati salvati e aggiornamenti
summary: Invia feedback, apri i registri dell’applicazione, ricarica o cancella i dati salvati, controlla la versione dell’app e installa gli aggiornamenti.
source: 8b0ca5aebb70e04f
---

Usa [[feedback]] ({{label:Menu.Help.SendFeedback}}) per segnalare un errore, proporre una funzione, inviare un complimento o condividere altri commenti direttamente con lo sviluppatore.

Puoi aprire il modulo di feedback in qualsiasi momento dal pulsante {{label:Navigation.Feedback}} nella barra di navigazione oppure da {{label:Menu.Help}} -> {{label:Menu.Help.SendFeedback}}.

Nel modulo di feedback puoi scegliere una tipologia ({{label:Feedback.Type.Bug}}, {{label:Feedback.Type.Suggestion}}, {{label:Feedback.Type.Praise}} o {{label:Feedback.Type.Other}}), scrivere un messaggio (da 10 a 5.000 caratteri), inserire facoltativamente un indirizzo e-mail per ricevere risposta e allegare facoltativamente uno screenshot ({{label:Feedback.TakeScreenshot}}) o un’immagine ({{label:Feedback.ChooseImage}}). La versione dell’app e il sistema operativo vengono inviati insieme al messaggio.

Quando l’Assistant prepara una bozza di feedback per te, facendo clic su [[feedback]] si apre il modulo precompilato con quella bozza. Nulla viene inviato finché non controlli il testo e fai clic su {{label:Feedback.Submit}}.

Gli strumenti di risoluzione dei problemi si trovano in [[settings-category:advanced]] ({{label:Settings.Advanced}}):
- **Registri**: apri [[setting:open-logs]] ({{label:Menu.Help.OpenLogs}}) per aprire la cartella contenente i file di registro dell’applicazione.
- **Ricarica**: apri [[setting:reload]] ({{label:Menu.View.Reload}}) per ricaricare la finestra dell’applicazione.
- **Cancella dati salvati**: apri [[setting:clear-saved-data]] ({{label:Menu.Help.ClearSavedData}}) per ripristinare le impostazioni e i dati di sessione salvati previa conferma. Questa operazione non elimina i file PGN o i database dello spazio di lavoro, ed è bloccata se i dati di pratica non possono essere migrati in sicurezza.

**Versione dell’app e aggiornamenti**:
- Controlla la versione installata, la versione di Tauri e il sistema operativo tramite {{label:Menu.Help}} -> {{label:Menu.Help.About}} (su macOS, nel menu dell’applicazione) oppure in fondo a [[page:settings]].
- Studio verifica automaticamente gli aggiornamenti dopo l’avvio. Quando è disponibile un aggiornamento, una finestra di conferma chiede se scaricarlo e installarlo. Se hai modifiche non salvate, il riavvio viene rinviato finché non salvi o riavvii l’app.
