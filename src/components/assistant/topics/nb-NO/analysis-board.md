---
id: analysis-board
title: Analysebrett, varianter, kommentarer og piler
summary: Legg inn trekk, rediger stillinger, håndter varianter, skriv kommentarer, legg til annotasjoner og tegn piler på brettet.
source: 14ba83ba3068d6ed
---

Åpne et analysebrett fra [[page:new-tab]] ved å klikke {{label:Home.Card.AnalysisBoard.Title}}, eller ved å åpne et lagret parti eller repertoar fra [[page:library]].

Utfør trekk ved å dra eller klikke på brikker (stilles inn i [[setting:move-method]]). Du kan også slå på [[setting:text-input]] ({{label:Settings.Inputs.TextInput}}) for å skrive inn trekk i SAN-notasjon. Bruk trekkontrollene under notasjonen, piltastene eller mushjulet (hvis [[setting:scroll-moves]] er aktivert) for å bla gjennom trekkene.

Verktøylinjen ved siden av notasjonen gir tilgang til bretthandlinger:
- {{label:Board.Action.TakeSnapshot}}: lagre et bilde av det gjeldende brettet.
- {{label:Board.Action.EditPosition}}: sett opp en egendefinert stilling ved å plassere brikker eller redigere FEN.
- {{label:Board.Action.PlayFromHere}}: start et parti fra den gjeldende stillingen.
- {{label:Board.Action.ClearDrawings}}: fjern piler og markerte felter (vises når [[setting:erase-drawables]] er av).
- {{label:Board.Database.Save}}: lagre partiet i en biblioteksfil eller database.
- Kontroller for å angre, gjøre om, lagre og snu brettet.

Å spille et annet trekk fra en tidligere stilling oppretter en variant. Høyreklikk på et hvilket som helst trekk i notasjonen for å velge {{label:Menu.PromoteVariation}}, {{label:Menu.PromoteToMainLine}}, {{label:Menu.CopyVariationPGN}}, {{label:Menu.DeleteMove}}, {{label:Board.Action.PlayFromHere}}, {{label:Notation.AddDiagram}} eller {{label:Notation.MarkGameEndHere}}. Bruk knappene i overskriften til notasjonen for å slå av/på {{label:Notation.HideMoves}}, {{label:Notation.TableView}}, {{label:Notation.HideComments}}, {{label:Notation.HideDiagrams}} og {{label:Notation.HideVariations}}.

For å annotere trekk og skrive kommentarer åpner du fanen {{label:Board.Tabs.Annotate}}. Klikk et trekkvurderingssymbol (eller trykk tastene 1 til 6) for å slå `!!`, `!`, `!?`, `?!`, `?` eller `??` av/på, eller klikk {{label:Annotate.ShowMore}} for vurderings- og stillingssymboler. Under symbolene bruker du tekstbehandleren til å skrive formaterte kommentarer og slå av/på innebygde brettdiagrammer.

For å tegne piler og markere felter holder du nede høyre museknapp og drar over brettet (eller høyreklikker på et felt for å tegne en sirkel). Hold nede modifikatortaster for ulike farger: Shift for {{label:Settings.Drawing.Red}}, Alt for {{label:Settings.Drawing.Blue}}, Shift+Alt for {{label:Settings.Drawing.Yellow}}, Ctrl (Cmd på macOS) for {{label:Settings.Drawing.Orange}} og Ctrl+Alt (Cmd+Alt på macOS) for {{label:Settings.Drawing.Cyan}}. Se hele tegnelisten i [[settings-category:keybinds]].

Fanen {{label:Board.Tabs.Info}} viser partihoder, FEN, PGN-tekst og trestatistikk, og lar deg bytte mellom partier i en PGN-fil med flere partier.
