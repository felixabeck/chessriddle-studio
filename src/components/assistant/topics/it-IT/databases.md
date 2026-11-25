---
id: databases
title: Database, esploratore, ricerca di posizione, giocatori e tornei
summary: Aggiungi o scarica database di partite, scegli un database di riferimento, cerca posizioni nell’esploratore e sfoglia partite, giocatori e tornei.
source: d3afecf524059542
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
- In {{label:Databases.Card.Players}}, seleziona un giocatore per consultare {{label:Home.Personal.Overview}}, {{label:Home.Personal.Ratings}} e {{label:Home.Personal.Openings}} (un albero delle aperture interattivo con il pulsante {{label:Databases.OpeningTree.Prepare}}), oltre alle informazioni FIDE tramite {{label:Databases.FIDE.Info}}.
- In {{label:Databases.Settings.Events}}, cerca i tornei per nome e ordina per data, giocatori, partite o Elo medio.

Nella scheda di un giocatore, apri {{label:Home.Personal.Preparation}} per confrontare le sue partite con i tuoi file di repertorio:
- Scegli il colore dell’avversario, il periodo {{label:Databases.OpeningTree.Since}} e (con account online collegati) {{label:Databases.OpeningTree.OverTheBoard}}, {{label:Databases.OpeningTree.Online}} oppure {{label:Databases.Preparation.Both}}. Fai clic su {{label:Databases.Preparation.Refresh}} per ripetere il confronto.
- Aumenta {{label:Databases.Preparation.MinGames}} per nascondere le linee e le lacune che l’avversario ha giocato solo raramente; il tuo file comprime quelle linee e l'allenamento le esclude.
- Esamina le varianti giocate dall’avversario e {{label:Databases.Preparation.GapsTitle}}. Fai clic su una riga per aprire il tuo file di repertorio in quella posizione con le altre varianti secondarie nascoste; nell’intestazione della notazione passa tra {{label:Notation.PreparationOpponentLines}} e {{label:Notation.PreparationAllLines}}.
- Fai clic su {{label:Databases.Preparation.TrainLines}} per avviare una sessione a tempo su quelle varianti; le tue risposte aggiornano la normale pianificazione a ripetizione dilazionata.
- Per prepararti contro un avversario che ha solo un account Lichess o Chess.com, fai clic su {{label:Library.OnlineOpponent}} in [[page:library]] per cercare il suo account, scaricare le sue partite e aprire la sua scheda direttamente nella scheda {{label:Home.Personal.Preparation}} (inserendo di nuovo lo stesso account si riapre senza scaricare nuovamente).

Sulla scacchiera di analisi, apri {{label:Board.Tabs.Database}} per usare l’esploratore delle aperture:
- Passa tra {{label:Board.Database.Local}}, {{label:Board.Database.LichessAll}} e {{label:Board.Database.LichessMaster}} (gli esploratori online di Lichess richiedono un account Lichess connesso su [[page:accounts]]).
- Passa tra {{label:Board.Database.Stats}} (statistiche delle mosse) e {{label:Board.Database.Games}} (partite corrispondenti).
- Per i database locali, fai clic su {{label:Board.Database.Compare}} per affiancare due database, oppure apri {{label:Board.Database.Local.Position}} per passare dalla ricerca di posizione {{label:Board.Database.Local.Exact}} a {{label:Board.Database.Local.Partial}} (inclusa {{label:Board.Database.Local.SimilarStructure}} per la ricerca per struttura pedonale e {{label:Fen.Empty}} per schemi personalizzati).
- Usa {{label:Board.Database.Pin}} per fissare l’esploratore sopra o sotto la scacchiera o la notazione, e {{label:Board.Database.Unpin}} per riportarlo tra le schede.
- Quando {{label:Databases.OpeningTree.Prepare}} apre una scacchiera per un giocatore del database, l’esploratore aggiunge il tuo database di riferimento come ulteriore colonna accanto alle partite dell’avversario; fai clic su {{label:Board.Database.RemoveReference}} per nasconderla o su {{label:Board.Database.ShowReference}} per ripristinarla.
