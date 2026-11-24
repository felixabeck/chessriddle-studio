---
id: ai-connections
title: Coach e connessioni IA
summary: Collega un provider di IA o un modello locale per abilitare il Coach sulla scacchiera di analisi e l’Assistant.
source: db8abb1b23f8812c
---

Le connessioni IA alimentano sia il Coach (sulla scacchiera di analisi) sia l’Assistant. Gestisci le tue connessioni in [[settings-category:coach]] ({{label:Settings.AI}}).

Per aggiungere una connessione, scegli una di queste opzioni in [[settings-category:coach]]:
- {{label:Settings.Coach.SignIn.ChatGpt}}: accedi con il tuo account ChatGPT nel browser.
- {{label:Settings.Coach.SignIn.Grok}}: accedi a Grok tramite un codice dispositivo (non ufficiale).
- {{label:Settings.Coach.Connections.Add}}: inserisci un indirizzo di base compatibile con OpenAI e una chiave API facoltativa. Sono disponibili impostazioni predefinite per OpenAI, Google Gemini, DeepSeek, Qwen, OpenRouter, Ollama e LM Studio.

Le chiavi e le credenziali di accesso vengono salvate nel portachiavi di sistema del tuo computer. Non appena è salvata almeno una connessione, l’Assistant compare nel menu {{label:Menu.Help}} ({{label:Menu.Help.Assistant}}) e nella barra di navigazione ({{label:Navigation.Assistant}}).

Sia il Coach sia l’Assistant condividono la stessa connessione, lo stesso modello e lo stesso livello di ragionamento selezionati. Usa {{label:Settings.Coach.Connection.Check}} su una connessione per verificarla ed elencare i modelli disponibili, oppure {{label:Settings.Coach.Connection.Remove}} per rimuoverla.

Per usare il Coach sulla scacchiera di analisi:
- Apri la scheda {{label:Board.Tabs.Coach}} (oppure premi la scorciatoia {{label:Settings.Keybinds.Actions.COACH_TAB}}).
- Il Coach richiede un motore scacchistico locale per verificare le proprie varianti di analisi. Scegli quale motore usa in [[setting:coach-engine]] ({{label:Settings.Coach.Engine}}), oppure installane uno su [[page:engines]] ({{label:SideBar.Engines}}).
- Fai domande sulla posizione corrente. Prima del primo messaggio a una connessione, Studio mostra un avviso con ciò che viene inviato (la posizione, il PGN della partita corrente, l’analisi del motore, le statistiche delle mosse del database di riferimento se selezionato e le linee corrispondenti del repertorio).
- Puoi passare il cursore o fare clic sulle sequenze di mosse nelle risposte del Coach per vederle in anteprima su una mini-scacchiera senza modificare la partita. Fai clic su {{label:Coach.InsertLine}} accanto a una linea per inserirla come variante.
