---
id: analysis-board
title: Scacchiera di analisi, varianti, commenti e frecce
summary: Inserisci mosse, modifica posizioni, gestisci varianti, scrivi commenti, aggiungi annotazioni e disegna frecce sulla scacchiera.
source: f49e0c9098ffc5cf
---

Apri una scacchiera di analisi da [[page:new-tab]] facendo clic su {{label:Home.Card.AnalysisBoard.Title}}, oppure aprendo una partita o un repertorio salvato da [[page:library]].

Esegui le mosse trascinando o cliccando i pezzi (configurabile in [[setting:move-method]]). Puoi anche attivare [[setting:text-input]] ({{label:Settings.Inputs.TextInput}}) per digitare le mosse in notazione SAN. Usa i controlli delle mosse sotto la notazione, i tasti freccia o la rotellina del mouse (se [[setting:scroll-moves]] è attivo) per scorrere le mosse.

La barra superiore sopra la scacchiera offre le azioni sulla scacchiera:
- {{label:Board.Action.PlayFromHere}}: inizia una partita dalla posizione corrente.
- Ruota scacchiera (`F`): scambia Bianco e Nero nella parte inferiore della scacchiera.
- Salva: appare quando la partita ha modifiche non salvate e il salvataggio automatico è disattivato, non disponibile (come in una bozza) o non è riuscito.
- {{label:Board.Action.More}}: apre il menu per {{label:Board.Action.NewAnalysis}} (sostituisce la scacchiera con una vuota nella stessa scheda; se la partita ha modifiche non salvate, ti viene chiesto prima), {{label:Board.Database.Save}} (salva la partita in un file della libreria o in un database), {{label:Board.Action.TakeSnapshot}} (salva un’immagine della scacchiera corrente) e {{label:Board.Action.EditPosition}} (imposta una posizione personalizzata posizionando i pezzi o modificando la FEN).
- Annullare, ripetere e cancellare frecce o caselle evidenziate (quando [[setting:erase-drawables]] è disattivato) usano le rispettive scorciatoie da tastiera in [[settings-category:keybinds]].

Giocare una mossa diversa da una posizione precedente crea una variante. Fai clic con il tasto destro su qualsiasi mossa nella notazione per {{label:Menu.PromoteVariation}}, {{label:Menu.PromoteToMainLine}}, {{label:Menu.CopyVariationPGN}}, {{label:Menu.DeleteMove}}, {{label:Menu.DeleteVariation}}, {{label:Menu.DeleteMovesAfter}}, {{label:Board.Action.PlayFromHere}}, {{label:Notation.AddDiagram}} o {{label:Notation.MarkGameEndHere}}. Usa il pulsante occhio nell’intestazione della notazione per {{label:Notation.HideMoves}}, e il menu {{label:Notation.ViewOptions}} per attivare o disattivare {{label:Notation.TableView}}, {{label:Notation.ShowComments}}, {{label:Notation.ShowDiagrams}} e {{label:Notation.ShowVariations}}.

Per annotare le mosse e scrivere commenti, apri la scheda {{label:Board.Tabs.Annotate}}. Fai clic su un simbolo di qualità della mossa (o premi i tasti da 1 a 6) per attivare o disattivare `!!`, `!`, `!?`, `?!`, `?` o `??`, oppure fai clic su {{label:Annotate.ShowMore}} per i simboli di valutazione e posizionali. Sotto i simboli, usa l’editor di testo formattato per scrivere commenti e inserire diagrammi della scacchiera nel testo.

Per disegnare frecce ed evidenziare caselle, fai clic con il tasto destro e trascina sulla scacchiera (oppure fai clic destro su una casella per un cerchio). Tieni premuti i tasti modificatori per usare colori diversi: Maiusc per {{label:Settings.Drawing.Red}}, Alt per {{label:Settings.Drawing.Blue}}, Maiusc+Alt per {{label:Settings.Drawing.Yellow}}, Ctrl (Cmd su macOS) per {{label:Settings.Drawing.Orange}} e Ctrl+Alt (Cmd+Alt su macOS) per {{label:Settings.Drawing.Cyan}}. Consulta l’elenco completo delle scorciatoie di disegno in [[settings-category:keybinds]].

La scheda {{label:Board.Tabs.Info}} mostra le intestazioni della partita, la FEN, il testo PGN e le statistiche dell’albero, e ti consente di passare da una partita all’altra in un file PGN multi-partita.

Per organizzare la scacchiera di analisi, trascina la scheda di un pannello ({{label:Board.Tabs.Analysis}}, {{label:Board.Analysis.Report}}, {{label:Board.Tabs.Database}}, {{label:Board.Tabs.Annotate}}, {{label:Board.Tabs.Coach}} o {{label:Board.Tabs.Info}}) o l’impugnatura a sei punti di una scheda motore oppure usa le impugnature nella barra delle schede, nell’intestazione della notazione o nell’intestazione di un’area pannello per posizionare le aree accanto, sopra o sotto un’altra area con anteprima o da tastiera. Per estendere un pannello sopra due aree (ad esempio {{label:Board.Tabs.Database}} sopra notazione e schede), posiziona prima il pannello sopra una delle due e poi sposta l’altra accanto. Usa {{label:Board.Area.ReturnToTabs}} (o {{label:Board.Area.ReturnToEngines}} per una finestra motore) oppure trascina l’area sopra la barra delle schede per riportarla indietro.

Le schede di repertorio, partita e preparazione contro l’avversario mantengono ciascuna il proprio layout attivo. Sono inclusi tre layout predefiniti ({{label:Board.Layout.Preset.Repertoire}}, {{label:Board.Layout.Preset.GameReview}} e {{label:Board.Layout.Preset.Preparation}}), e puoi salvare i tuoi layout, passare da uno all’altro oppure rinominare ed eliminare i layout salvati da {{label:Board.Action.More}} ({{label:Board.Layout.SaveAs}} e {{label:Board.Layout.Manage}}) o da {{label:Menu.View}} ({{label:Board.Layout.SaveAs}} e {{label:Board.Layout.LayoutsMenu}}). Usa [[setting:board-layout]] ({{label:Settings.BoardLayout.Reset}}) per ripristinare i layout predefiniti per tutti e tre i tipi di scheda mantenendo i tuoi layout salvati.

Per nascondere le schede, ad esempio quando ogni pannello che usi è mostrato come area propria, fai clic su {{label:Board.Area.HideTabs}} sotto la maniglia alla fine della barra delle schede; le aree vicine ne occupano lo spazio. Le schede mantengono posizione e dimensioni: mostrale di nuovo con il pulsante {{label:Board.Arrange.ShowTabs}} che compare nell’intestazione della notazione mentre sono nascoste, con una scorciatoia di scheda o generando il report. Un pannello che rimetti nelle schede mentre sono nascoste finisce nelle schede nascoste. Mentre le schede sono nascoste, {{label:Board.Arrange.ShowTabs}} si trova anche in {{label:Board.Action.More}} e in {{label:Menu.View}}.
