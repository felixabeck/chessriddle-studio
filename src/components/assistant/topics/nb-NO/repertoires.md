---
id: repertoires
title: Åpningsrepertoarer
summary: Opprett et repertoar, bygg dekning mot en referansedatabase, øv med tidsfordelt repetisjon og hold oversikt over åpne varianter og transponeringer.
source: 62b7ff51627518a7
---

Repertoarer er PGN-filer av typen Repertoar som legger til fanen {{label:Board.Tabs.Practice}} på analysebrettet.

For å opprette et repertoar åpner du [[page:new-tab]] og klikker {{label:Home.Card.NewRepertoire.Title}} (eller oppretter en repertoarfil i [[page:library]]). Skriv inn et {{label:Common.Name}}, velg {{label:Common.WHITE}} eller {{label:Common.BLACK}} og klikk {{label:Common.Create}}.

Bygg repertoaret ditt i {{label:Board.Tabs.Practice}} -> {{label:Board.Practice.Build}}:
- Angi en {{label:Databases.Settings.ReferenceDatabase}} i [[page:library]] slik at byggeren kan vise trekkfrekvenser og dekning.
- På et tomt repertoar kan du starte fra en av de innebygde malene i {{label:Board.Practice.Build.Presets}} eller legge inn trekk på brettet.
- Marker startstillingen for repertoaret med {{label:Board.Practice.Build.SetAsStart}} (eller høyreklikk et trekk i notasjonen og velg {{label:Menu.MarkAsStart}}).
- Klikk på trekk i {{label:Board.Practice.Build.OpponentMoves}} eller {{label:Board.Practice.Build.YourResponse}} for å legge til eller følge linjer. Bruk {{label:Board.Practice.Build.NextGap}} og {{label:Board.Practice.Build.BiggestGap}} for å hoppe til udekkede motstandersvar over minste antall partier satt i [[setting:repertoire-depth]].

Øv på repertoaret i {{label:Board.Tabs.Practice}} -> {{label:Board.Practice.Train}}:
- Klikk {{label:Board.Practice.StartPractice}} for å øve på forfalte og nye stillinger med tidsfordelt repetisjon, eller {{label:Board.Practice.PracticeFullRepertoire}} for å gå gjennom hver stilling i repertoaret.
- Spill det forberedte trekket ditt på brettet. Hvis du står fast etter et feiltrekk, klikker du {{label:Board.Practice.ShowMove}}.
- Se over alle kort med {{label:Board.Practice.ShowAll}}, sjekk historikken med {{label:Board.Practice.ShowLogs}} eller nullstill fremdriften med {{label:Common.Reset}}.
- Repertoarer med kort til repetisjon vises også under {{label:Home.Library.Due}} på [[page:new-tab]].
- Konfigurer vurdering av tidsfordelt repetisjon og grenser for nye kort i [[settings-category:repertoire]] ([[setting:practice-grading]], [[setting:practice-new-per-session]]).

I notasjonen på analysebrettet:
- En sidevariant som bare er ett trekk lang får en stiplet ramme som {{label:Notation.OpenVariation}} slik at du ser uferdige grener. Trykk hurtigtasten {{label:Settings.Keybinds.Actions.NEXT_OPEN_VARIATION}} for å hoppe til den neste.
- Når en stilling dukker opp i en annen gren av det samme repertoaret, vises et {{label:Notation.Transposition}}-ikon ved siden av trekket; klikk på det for å hoppe til den andre grenen.
