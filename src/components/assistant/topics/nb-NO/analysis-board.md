---
id: analysis-board
title: Analysebrett, varianter, kommentarer og piler
summary: Legg inn trekk, rediger stillinger, håndter varianter, skriv kommentarer, legg til annotasjoner og tegn piler på brettet.
source: 332d035e7fda54c8
---

Åpne et analysebrett fra [[page:new-tab]] ved å klikke {{label:Home.Card.AnalysisBoard.Title}}, eller ved å åpne et lagret parti eller repertoar fra [[page:library]].

Utfør trekk ved å dra eller klikke på brikker (stilles inn i [[setting:move-method]]). Du kan også slå på [[setting:text-input]] ({{label:Settings.Inputs.TextInput}}) for å skrive inn trekk i SAN-notasjon. Bruk trekkontrollene under notasjonen, piltastene eller mushjulet (hvis [[setting:scroll-moves]] er aktivert) for å bla gjennom trekkene.

Topplinjen over brettet gir tilgang til bretthandlinger:
- {{label:Board.Action.PlayFromHere}}: start et parti fra den gjeldende stillingen.
- Snu brettet (`F`): bytt mellom hvit og svart nederst på brettet.
- Lagre: vises når et parti har ulagrede endringer og automatisk lagring er slått av, utilgjengelig (som et utkast) eller mislyktes.
- {{label:Board.Action.More}}: åpner menyen for {{label:Board.Database.Save}} (lagre partiet i en biblioteksfil eller database), {{label:Board.Action.TakeSnapshot}} (lagre et bilde av det gjeldende brettet) og {{label:Board.Action.EditPosition}} (sett opp en egendefinert stilling ved å plassere brikker eller redigere FEN).
- Angre, gjøre om og fjerning av tegnede piler eller feltmarkeringer (når [[setting:erase-drawables]] er av) bruker sine hurtigtaster i [[settings-category:keybinds]].

Å spille et annet trekk fra en tidligere stilling oppretter en variant. Høyreklikk på et hvilket som helst trekk i notasjonen for å velge {{label:Menu.PromoteVariation}}, {{label:Menu.PromoteToMainLine}}, {{label:Menu.CopyVariationPGN}}, {{label:Menu.DeleteMove}}, {{label:Menu.DeleteVariation}}, {{label:Menu.DeleteMovesAfter}}, {{label:Board.Action.PlayFromHere}}, {{label:Notation.AddDiagram}} eller {{label:Notation.MarkGameEndHere}}. Bruk øyeknappen i notasjonens overskrift for {{label:Notation.HideMoves}}, og menyen {{label:Notation.ViewOptions}} for å slå av/på {{label:Notation.TableView}}, {{label:Notation.ShowComments}}, {{label:Notation.ShowDiagrams}} og {{label:Notation.ShowVariations}}.

For å annotere trekk og skrive kommentarer åpner du fanen {{label:Board.Tabs.Annotate}}. Klikk et trekkvurderingssymbol (eller trykk tastene 1 til 6) for å slå `!!`, `!`, `!?`, `?!`, `?` eller `??` av/på, eller klikk {{label:Annotate.ShowMore}} for vurderings- og stillingssymboler. Under symbolene bruker du tekstbehandleren til å skrive formaterte kommentarer og slå av/på innebygde brettdiagrammer.

For å tegne piler og markere felter holder du nede høyre museknapp og drar over brettet (eller høyreklikker på et felt for å tegne en sirkel). Hold nede modifikatortaster for ulike farger: Shift for {{label:Settings.Drawing.Red}}, Alt for {{label:Settings.Drawing.Blue}}, Shift+Alt for {{label:Settings.Drawing.Yellow}}, Ctrl (Cmd på macOS) for {{label:Settings.Drawing.Orange}} og Ctrl+Alt (Cmd+Alt på macOS) for {{label:Settings.Drawing.Cyan}}. Se hele tegnelisten i [[settings-category:keybinds]].

Fanen {{label:Board.Tabs.Info}} viser partihoder, FEN, PGN-tekst og trestatistikk, og lar deg bytte mellom partier i en PGN-fil med flere partier.

For å ordne analysebrettet drar du en panelfane ({{label:Board.Tabs.Analysis}}, {{label:Board.Analysis.Report}}, {{label:Board.Tabs.Database}}, {{label:Board.Tabs.Annotate}}, {{label:Board.Tabs.Coach}} eller {{label:Board.Tabs.Info}}) eller sekspunktsgrepet på et motorkort eller bruker grepsknappene i fanelinjen, notasjonshodet eller topplinjen til et panelområde for å plassere områder ved siden av, over eller under et annet område med forhåndsvisning eller tastatur. For å la et panel strekke seg over to områder (for eksempel {{label:Board.Tabs.Database}} over både notasjonen og fanene) plasserer du først panelet over ett av dem og flytter deretter det andre ved siden av. Bruk {{label:Board.Area.ReturnToTabs}} (eller {{label:Board.Area.ReturnToEngines}} for et motorvindu) eller dra området tilbake over fanelisten for å sende det tilbake.

Repertoar-, parti- og motstanderforberedelsesfaner beholder hvert sitt aktive oppsett. Tre forhåndsvalgte oppsett følger med ({{label:Board.Layout.Preset.Repertoire}}, {{label:Board.Layout.Preset.GameReview}} og {{label:Board.Layout.Preset.Preparation}}), og du kan lagre egne oppsett, bytte mellom dem eller gi nytt navn til og slette lagrede oppsett fra {{label:Board.Action.More}} ({{label:Board.Layout.SaveAs}} og {{label:Board.Layout.Manage}}) eller fra {{label:Menu.View}} ({{label:Board.Layout.SaveAs}} og {{label:Board.Layout.LayoutsMenu}}). Bruk [[setting:board-layout]] ({{label:Settings.BoardLayout.Reset}}) for å gjenopprette forhåndsoppsettene for alle tre fanetypene mens dine lagrede oppsett beholdes.

For å skjule fanene, for eksempel når hvert panel du bruker vises som et eget område, klikker du {{label:Board.Area.HideTabs}} under håndtaket på slutten av fanelinjen; naboområdene tar plassen. Fanene beholder plassering og størrelse: vis dem igjen med knappen {{label:Board.Arrange.ShowTabs}} som vises i notasjonsoverskriften mens de er skjult, med en fanesnarvei eller ved å lage rapporten. Et panel du returnerer mens fanene er skjult, havner i de skjulte fanene.
