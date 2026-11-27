---
id: databases
title: Database, esploratore, ricerca di posizione, giocatori e tornei
summary: Aggiungi o scarica database di partite, scegli un database di riferimento, cerca posizioni nell’esploratore e sfoglia partite, giocatori e tornei.
source: 9d4f20d7213a7cbb
---

I database si trovano in [[page:library]] ({{label:SideBar.Library}}) insieme ai tuoi file PGN e sono archiviati in [[setting:databases-directory]].

Per aggiungere un database, apri [[page:library]] e fai clic su {{label:Library.AddDatabase}}:
- {{label:Databases.Add.Web}}: scarica database selezionati dal catalogo.
- {{label:Common.Local}}: scegli un file PGN locale (inclusi `.pgn.zst` o `.pgn.bz2`), inserisci un {{label:Common.Name}} e una {{label:Common.Description}} facoltativa, quindi fai clic su {{label:Databases.Add.Convert}}.

Seleziona un database in [[page:library]] per gestirlo:
- Seleziona {{label:Databases.Settings.ReferenceDatabase}} per renderlo il database di riferimento predefinito per l’esploratore, la creazione del repertorio, le novità del report della partita e il Coach.
- Seleziona {{label:Databases.Settings.Indexed}} per creare o rimuovere gli indici di ricerca e velocizzare le ricerche.
- Fai clic su {{label:Databases.Settings.Explore}} per aprire la vista tabellare del database.
- Sotto {{label:Databases.Settings.Actions}}, usa {{label:Databases.Settings.AddGames}} per accodare file PGN, {{label:Databases.Settings.ExportPGN}} per esportare in PGN oppure {{label:Common.Delete}} per eliminare il database.
- Sotto {{label:Databases.Settings.AdvancedTools}}, usa {{label:Databases.Settings.MergePlayers}} per unire voci giocatore duplicate, oppure {{label:Databases.Settings.RemoveDup}} e {{label:Databases.Settings.RemoveEmpty}} per ripulire le partite.

All’interno della vista tabellare del database, passa tra {{label:Common.Games}}, {{label:Databases.Card.Players}} e {{label:Databases.Settings.Events}} (tornei):
- Cerca e ordina le partite, visualizza un’anteprima (l’anteprima può nascondere le mosse con il pulsante a forma di occhio, [[setting:hide-preview-moves]]) o apri una partita sulla scacchiera di analisi.
- In {{label:Databases.Card.Players}}, seleziona un giocatore per consultare {{label:Home.Personal.Overview}}, {{label:Home.Personal.Ratings}} e {{label:Home.Personal.Openings}} (un albero delle aperture interattivo), oltre alle informazioni FIDE tramite {{label:Databases.FIDE.Info}}. Usa {{label:Databases.OpeningTree.Prepare}} in {{label:Home.Personal.Overview}} e {{label:Home.Personal.Ratings}} per aprire la posizione iniziale con il Bianco e tutte le partite, oppure in {{label:Home.Personal.Openings}} per mantenere la variante, il colore e il periodo {{label:Databases.OpeningTree.Since}} selezionati.
- In {{label:Databases.Settings.Events}}, cerca i tornei per nome e ordina per data, giocatori, partite o Elo medio.

Nella scheda di un giocatore, apri {{label:Home.Personal.Preparation}} per confrontare le sue partite con i tuoi file di repertorio:
- Scegli il colore dell’avversario, il periodo {{label:Databases.OpeningTree.Since}} e (con account online collegati) {{label:Databases.OpeningTree.OverTheBoard}}, {{label:Databases.OpeningTree.Online}} oppure {{label:Databases.Preparation.Both}}. Fai clic su {{label:Databases.Preparation.Refresh}} per ripetere il confronto, oppure fai clic su {{label:Databases.OpeningTree.Prepare}} per aprire la posizione iniziale su una scacchiera di analisi usando il colore e il periodo {{label:Databases.OpeningTree.Since}} di quella scheda.
- Aumenta {{label:Databases.Preparation.MinGames}} per nascondere le linee e le lacune che l’avversario ha giocato solo raramente; il tuo file comprime quelle linee e l'allenamento le esclude.
- Esamina le varianti giocate dall’avversario e {{label:Databases.Preparation.GapsTitle}}. Fai clic su una riga per aprire il tuo file di repertorio in quella posizione con le altre varianti secondarie nascoste; nell’intestazione della notazione passa tra {{label:Notation.PreparationOpponentLines}} e {{label:Notation.PreparationAllLines}}.
- Fai clic su {{label:Databases.Preparation.TrainLines}} per avviare una sessione a tempo su quelle varianti; le tue risposte aggiornano la normale pianificazione a ripetizione dilazionata.
- Per prepararti contro un avversario che ha solo un account Lichess o Chess.com, fai clic su {{label:Library.OnlineOpponent}} in [[page:library]] per cercare il suo account, scaricare le sue partite e aprire la sua scheda direttamente nella scheda {{label:Home.Personal.Preparation}} (inserendo di nuovo lo stesso account si riapre senza scaricare nuovamente).

Sulla scacchiera di analisi, apri {{label:Board.Tabs.Database}} per usare l’esploratore delle aperture:
- Scegli {{label:Board.Database.LichessAll}} o {{label:Board.Database.LichessMaster}} nel menu delle fonti e in {{label:Board.Database.Compare}} (gli esploratori online di Lichess richiedono un account Lichess connesso su [[page:accounts]]).
- {{label:Board.Database.Stats}} (statistiche delle mosse) appare in alto e {{label:Board.Database.Games}} (partite corrispondenti) in basso; mentre entrambe le aree sono visibili, trascina il divisore tra di esse per ripartire l’altezza. Usa {{label:Board.Database.HideGames}} o {{label:Board.Database.ShowGames}} per nascondere o mostrare l’elenco delle partite e l’ingranaggio delle impostazioni per aprire o comprimere i controlli delle fonti — entrambi si trovano nell’intestazione del pannello quando è un riquadro separato e nella riga superiore dei controlli quando è nelle schede. La colonna {{label:Board.Area.Notation}} mostra le mosse dalla posizione sulla scacchiera, con la mossa successiva in grassetto.
- Fai clic su {{label:Board.Database.Compare}} per affiancare due fonti, oppure apri {{label:Board.Database.Local.Position}} per passare dalla ricerca di posizione {{label:Board.Database.Local.Exact}} a {{label:Board.Database.Local.Partial}} (inclusa {{label:Board.Database.Local.SimilarStructure}} per la ricerca per struttura pedonale e {{label:Fen.Empty}} per schemi personalizzati).
- Puoi anche mostrare {{label:Board.Tabs.Database}} come area dedicata sulla scacchiera di analisi e usare {{label:Board.Area.ReturnToTabs}} per riportarla tra le schede.
- Quando {{label:Databases.OpeningTree.Prepare}} apre una scacchiera per un giocatore del database, l’esploratore parte dal database di riferimento come ulteriore colonna accanto alle partite dell’avversario; fai clic su {{label:Board.Database.RemoveReference}} per nascondere una colonna o su {{label:Board.Database.AddColumn}} per aggiungerne un’altra.
