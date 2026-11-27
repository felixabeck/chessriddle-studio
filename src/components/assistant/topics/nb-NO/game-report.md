---
id: game-report
title: Partigjennomgang og rapport
summary: Analyser et parti med en lokal motor for å se presisjon, vurderings- og tidsdiagrammer, åpnings- og repertoarnotater samt nøkkeløyeblikk på brettet.
source: d1a4339820f36de2
---

Partirapporten analyserer hvert trekk i hovedvarianten med en lokal sjakkmotor og gjør resultatene om til en veiledet gjennomgang av partiet.

For å lage en rapport åpner du et parti på analysebrettet, bytter til fanen {{label:Board.Analysis.Report}} og klikker på {{label:Board.Analysis.GenerateReport}} (eller trykker hurtigtasten {{label:Settings.Keybinds.Actions.GENERATE_REPORT}}).

I dialogen {{label:Board.Analysis.GenerateReport}}:
- Velg en lokal {{label:Common.Engine}}. Hvis ingen er installert, kan du legge til en under [[page:engines]].
- Angi søkegrensen per trekk (dybde, tid eller noder).
- Slå på {{label:Board.Analysis.MarkMoves}} for å merke trekk med kvalitetssymboler (`!!`, `!`, `!?`, `?!`, `?`, `??`).
- Slå på {{label:Board.Analysis.ShowVariations}} for å sette inn bedre varianter i notasjonen.
- Slå på {{label:Board.Analysis.AnnotateNovelties}} for å merke det første trekket som forlater referansedatabasen din med `N`. Dette krever en klar referansedatabase valgt i [[page:library]].
- Klikk på {{label:Board.Analysis.Analyze}} for å starte.

Mens en rapport kjører, kan du avbryte den fra fremdriftsknappen. Hvis du redigerer hovedvarianten, avbrytes også en pågående rapport.

Når rapporten er ferdig, viser {{label:Board.Analysis.Report}}:
- En dempet overskrift med motor, søkegrense og dato, samt en liten {{label:Board.Analysis.Report.Regenerate}}-knapp ved siden av. Den brede knappen {{label:Board.Analysis.GenerateReport}} vises bare når det ikke finnes noen gjeldende rapport.
- En oppsummeringssetning over resultattavlen når partiet startet fra en balansert stilling; fra en ubalansert startstilling vises ingen oppsummeringssetning.
- Én resultattavle med spillernavn og ratinger, {{label:Board.Analysis.Accuracy}} som hovedtall, {{label:Board.Analysis.Report.AverageLoss}}, presisjon per partifase og de seks radene for trekkvalitet med nullverdier tonet ned. Klikk på et tall større enn null for å hoppe til de trekkene, og hold musepekeren over eller fokuser på en etikett med tastaturet for å se forklaringen.
- Et diagram som veksler mellom {{label:Board.Analysis.Report.Evaluation}} (med nulllinje) og {{label:Board.Analysis.Report.WinChance}}, hver med forklaring ved peker eller tastaturfokus. Når minst halvparten av trekkene har klokketider, vises en stripe for {{label:Board.Analysis.Report.TimeUsage}} under diagrammet; klikk på en stolpe for å hoppe til det trekket.
- En åpnings- og repertoarblokk med åpningsnavnet, nyheten (`N`) når den finnes, og et repertoarnotat bare for din side — matchet på spillernavn mot dine tilkoblede Lichess-, Chess.com- eller alias-kontoer under [[page:accounts]], eller den siden som står nederst på brettet hvis ingen navn matcher (å snu brettet endrer denne siden). Notatet viser hvor du forlot repertoaret (et klikk fokuserer den stillingen med piler) eller hvor langt du fulgte det. Hvis repertoarfilene ikke kunne leses fullstendig, vises én dempet linje: {{label:Board.Analysis.Report.RepertoireIncomplete}}
- {{label:Board.Analysis.Report.KeyMoments}}: klikk på en rad for å gå til stillingen før trekket, slik at begge pilene på brettet (det spilte trekket og det bedre trekket) starter fra det feltet. Bruk {{label:Board.Analysis.Report.PreviousMoment}} og {{label:Board.Analysis.Report.NextMoment}} for å bla gjennom dem, eller filtrer etter {{label:Board.Analysis.Report.FilterBoth}}, {{label:Board.Analysis.Report.FilterWhite}} eller {{label:Board.Analysis.Report.FilterBlack}}. Øyeblikk viser også merkelapper som {{label:Board.Analysis.Report.Tag.TurningPoint}} eller {{label:Board.Analysis.Report.Tag.TimeTrouble}}, samt feilens art når motorvariantene beviser den.
- På `?!`-, `?`- og `??`-øyeblikk kan du klikke på {{label:Board.Analysis.Report.Explain}} for å fokusere den stillingen og åpne {{label:Board.Tabs.Coach}} med et spørsmål om øyeblikket. Denne knappen er skjult når ingen KI-tilkobling er satt opp.

Hvis du redigerer partiet etterpå, lag rapporten på nytt med {{label:Board.Analysis.GenerateReport}} eller {{label:Board.Analysis.Report.Regenerate}} for å oppdatere gjennomgangen.
