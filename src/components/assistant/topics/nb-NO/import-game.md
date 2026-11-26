---
id: import-game
title: Importere et parti
summary: Importer et parti fra en PGN-fil, innlimt PGN-tekst, en Lichess- eller Chess.com-URL, en FEN-stilling eller bilder eller PDF-skanninger av et håndskrevet noteringsskjema.
source: 2a3b47d982e0f514
---

For å importere et parti eller en stilling åpner du [[page:new-tab]] og klikker {{label:Home.Card.ImportGame.Button}} for å åpne dialogen {{label:Home.Card.ImportGame.Title}}. Du kan også åpne en PGN-fil direkte fra {{label:Menu.File}} -> {{label:Menu.File.OpenFile}} (eller hurtigtasten {{label:Settings.Keybinds.Actions.OPEN_FILE}}).

Velg ett av alternativene i dialogen {{label:Home.Card.ImportGame.Title}}:
- **PGN**: Velg en {{label:Common.PGNFile}} fra datamaskinen eller lim inn tekst i {{label:Common.PGNGame}}. Kryss av for {{label:Import.SaveToCollection}} for å lagre en kopi i arbeidsmappen i [[page:library]], skriv inn et {{label:Common.Name}} og velg en {{label:Files.FileType}}.
- **{{label:Import.Online}}**: Lim inn en {{label:Import.GameURL}} fra Lichess eller Chess.com for å hente partiet og åpne det på et analysebrett.
- **FEN**: Lim inn en FEN-streng for å åpne et analysebrett fra den stillingen.
- **{{label:Import.FromPhoto}}** (når KI-funksjoner er tilgjengelige): Tolk 1 til 4 bilder eller PDF-sider av et håndskrevet noteringsskjema til et nytt parti. Dette krever minst én KI-tilkobling i [[settings-category:coach]] ({{label:Settings.AI}}).

For PGN, {{label:Import.Online}} og FEN klikker du {{label:Home.Card.ImportGame.Button}} for å laste inn partiet i den gjeldende fanen.

Slik importerer du med **{{label:Import.FromPhoto}}**:
- Legg til opptil 4 JPEG-, PNG- eller WebP-bilder eller PDF-sider med {{label:Scoresheet.Intake.ChoosePhotos}}, {{label:Scoresheet.Intake.PasteFromClipboard}} (eller Ctrl+V / Cmd+V mens panelet er åpent), eller ved å dra og slippe bilder eller PDF-filer inn i det åpne panelet. Innliming fungerer bare med bilder. Hver PDF-side teller som ett bilde; fra en lengre PDF brukes de første sidene.
- Velg KI-tilkobling og en modell som kan lese bilder med modellknappen eller i [[setting:coach-model]] ({{label:Settings.Coach.Model}}).
- Klikk {{label:Scoresheet.Read.Button}} for å starte. Før første avlesning på en tilkobling forklarer {{label:Scoresheet.Notice.Title}} at de valgte bildene (inkludert spillernavn og alt annet som står på skjemaet) sendes til den leverandøren, at metadata som kameraplassering fjernes først, og at ingen andre data sendes.
- Studio kontrollerer hvert trekk mot vanlige sjakkregler fra utgangsstillingen og åpner partiet i en ny ulagret analysefane med panelet {{label:Board.Tabs.Photo}} ved siden av brettet.
- Usikre eller rettede trekk markeres som usikre i notasjonen. Gå gjennom dem i {{label:Board.Tabs.Photo}}-panelet og klikk {{label:Scoresheet.MarkAsChecked}} etter hvert som du bekrefter hvert trekk. Hvis du retter et trekk underveis eller vil fortsette etter et stopp-punkt, klikker du {{label:Scoresheet.ContinueWithSheet}} for å spille inn de neste lovlige trekkene fra skjemaet. Klikk {{label:Scoresheet.FinishReview}} når du er ferdig for å fjerne gjenværende markeringer.
- Lagre partiet i en fil eller database med vanlig lagring ({{label:Menu.File}} -> {{label:Common.Save}}, lagre-knappen eller {{label:Board.Database.Save}}).
- Bilder lagres bare i minnet (for opptil 4 åpne faner) og skrives ikke til disk; etter ny innlasting eller omstart beholdes partiet og gjennomgangsmarkeringene, og du kan bruke {{label:Scoresheet.LoadPhotoAgain}} i {{label:Board.Tabs.Photo}}-panelet for å vise bildet igjen uten å sende det.
