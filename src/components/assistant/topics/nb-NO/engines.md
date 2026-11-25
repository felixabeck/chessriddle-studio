---
id: engines
title: Sjakkcomputere og analysepanelet
summary: Installer eller legg til lokale motorer og skymotorer, konfigurer UCI-valg og bruk sanntidsanalyse på brettet.
source: 0e9ac8bab01e58b5
---

Administrer sjakkmotorene dine på [[page:engines]] ({{label:SideBar.Engines}}).

For å legge til en motor klikker du {{label:Common.AddNew}} på [[page:engines]] for å åpne {{label:Engines.Add.Title}}:
- {{label:Common.Download}}: installer en forhåndskonfigurert motor (som Stockfish) fra katalogen med {{label:Common.Install}}.
- {{label:Engines.Add.Cloud}}: legg til nettbaserte analysemotorer (ChessDB eller Lichess Cloud) med {{label:Common.Add}}.
- {{label:Common.Local}}: registrer en UCI-motorfil som allerede ligger på datamaskinen din.

Velg hvilken som helst motor på [[page:engines]] for å konfigurere den. For lokale motorer kan du redigere generelle opplysninger, angi standard UCI-valg (som Threads, Hash og MultiPV), legge ved ressursfiler som Syzygy-sluttspilltabeller, klikke {{label:Engines.Settings.Reset}} for å gjenopprette standardverdier, {{label:Common.Duplicate}} for å kopiere oppsettet eller {{label:Common.Remove}} for å fjerne den. For skymotorer kan du redigere navnet og {{label:Engines.Settings.NumOfLines}}.

På analysebrettet åpner du fanen {{label:Board.Tabs.Analysis}} og velger {{label:Board.Analysis.Engines}}:
- Klikk {{label:Board.Analysis.SelectEngines}} for å velge hvilke installerte motorer som lastes i panelet, eller {{label:Board.Analysis.ManageEngines}} for å gå til [[page:engines]].
- Klikk {{label:Board.Analysis.EnableEngine}} eller {{label:Board.Analysis.DisableEngine}} på et motorkort for å starte eller pause analysen, eller bruk {{label:Board.Analysis.EnableAllEngines}} når flere motorer er lastet.
- Klikk {{label:Board.Analysis.CheckThreat}} (eller trykk hurtigtasten {{label:Settings.Keybinds.Actions.TOGGLE_THREAT_MODE}}) for å analysere motstanderens trussel.
- Klikk {{label:Board.Analysis.Pin}} for å feste en motors evalueringsstolpe utenfor fanen, eller {{label:Board.Analysis.EngineSettings}} for å justere innstillinger per fane som søkegrense og antall varianter.
- Dra motorkort etter {{label:Board.Analysis.ReorderEngine}} for å endre rekkefølgen.
- Når en motor feiler, klikker du {{label:Board.Analysis.Logs}} ved siden av {{label:Board.Analysis.RetryEngine}} for å se motorens UCI-kommunikasjon. For en motor som kjører, finner du samme knapp under {{label:Board.Analysis.EngineSettings}} på kortet.

Styr motorpiler på brettet med [[setting:arrows]] ({{label:Settings.Arrows}}). Lokale motorer lagres i mappen som er valgt i [[setting:engines-directory]].
