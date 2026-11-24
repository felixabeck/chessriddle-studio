---
id: game-report
title: Partirapport
summary: Kjør en automatisk computergjennomgang av et parti for å se nøyaktighet, evalueringsgraf, nøkkeløyeblikk og trekkklassifiseringer.
source: a5e00adfe821f3f3
---

Partirapporten analyserer hvert trekk i hovedvarianten med en lokal sjakkcomputer og oppsummerer partiets nøyaktighet og feil.

For å lage en rapport åpner du et parti på analysebrettet, bytter til {{label:Board.Tabs.Analysis}} -> {{label:Board.Analysis.Report}} og klikker {{label:Board.Analysis.GenerateReport}} (eller trykker hurtigtasten {{label:Settings.Keybinds.Actions.GENERATE_REPORT}}).

I dialogen {{label:Board.Analysis.GenerateReport}}:
- Velg en lokal {{label:Common.Engine}}. Hvis ingen er installert, legg til en på [[page:engines]].
- Angi søkegrensen per trekk (dybde, tid eller noder).
- Slå på {{label:Board.Analysis.MarkMoves}} for å annotere trekk med kvalitetssymboler.
- Slå på {{label:Board.Analysis.ShowVariations}} for å sette inn varianter med bedre trekk i notasjonen.
- Slå på {{label:Board.Analysis.AnnotateNovelties}} for å markere det første trekket som forlater referansedatabasen din. Dette valget krever en klar referansedatabase valgt i [[page:library]].
- Klikk {{label:Board.Analysis.Analyze}} for å starte.

Mens en rapport kjører, kan du avbryte den fra fremdriftsknappen. Redigering av hovedvarianten avbryter en pågående rapport.

Når den er ferdig, viser {{label:Board.Analysis.Report}}:
- Nøyaktighetsprosenter og gjennomsnittlig centipawn-tap (ACPL) for {{label:Common.WHITE}} og {{label:Common.BLACK}}.
- En evalueringsgraf gjennom hele partiet.
- {{label:Board.Analysis.Report.KeyMoments}}: klikkbar liste over markerte trekk med evalueringsutslag og bedre trekk.
- En oversiktstabell over trekkvalitet der klikk på et antall hopper til disse trekkene.

Hvis du redigerer partiet etterpå, klikker du {{label:Board.Analysis.RegenerateReport}} for å kjøre en ny analyse.
