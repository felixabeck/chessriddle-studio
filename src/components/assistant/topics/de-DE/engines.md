---
id: engines
title: Schach-Engines und das Analysepanel
summary: Lokale und Cloud-Engines installieren oder hinzufügen, UCI-Optionen konfigurieren und Live-Analyse auf dem Brett nutzen.
source: 0e9ac8bab01e58b5
---

Verwalte deine Schach-Engines auf [[page:engines]] ({{label:SideBar.Engines}}).

Um eine Engine hinzuzufügen, klicke auf [[page:engines]] auf {{label:Common.AddNew}}, um {{label:Engines.Add.Title}} zu öffnen:
- {{label:Common.Download}}: Eine vorkonfigurierte Engine (wie Stockfish) mit {{label:Common.Install}} aus dem Katalog installieren.
- {{label:Engines.Add.Cloud}}: Online-Analyse-Engines (ChessDB oder Lichess Cloud) mit {{label:Common.Add}} hinzufügen.
- {{label:Common.Local}}: Eine bereits auf deinem Computer vorhandene UCI-Engine-Datei einbinden.

Wähle eine Engine auf [[page:engines]] aus, um sie einzurichten. Bei lokalen Engines kannst du allgemeine Angaben bearbeiten, Standard-UCI-Optionen (wie Threads, Hash und MultiPV) festlegen, Ressourcendateien wie Syzygy-Endspieldatenbanken anhängen, mit {{label:Engines.Settings.Reset}} die Standardwerte wiederherstellen, mit {{label:Common.Duplicate}} die Konfiguration kopieren oder sie mit {{label:Common.Remove}} entfernen. Bei Cloud-Engines kannst du den Namen und {{label:Engines.Settings.NumOfLines}} anpassen.

Öffne auf dem Analysebrett den Tab {{label:Board.Tabs.Analysis}} und wähle {{label:Board.Analysis.Engines}}:
- Klicke auf {{label:Board.Analysis.SelectEngines}}, um festzulegen, welche installierten Engines im Panel geladen werden, oder auf {{label:Board.Analysis.ManageEngines}}, um zu [[page:engines]] zu springen.
- Klicke auf einer Engine-Karte auf {{label:Board.Analysis.EnableEngine}} oder {{label:Board.Analysis.DisableEngine}}, um die Analyse zu starten oder zu pausieren, oder nutze {{label:Board.Analysis.EnableAllEngines}}, wenn mehrere Engines geladen sind.
- Klicke auf {{label:Board.Analysis.CheckThreat}} (oder drücke das Tastenkürzel {{label:Settings.Keybinds.Actions.TOGGLE_THREAT_MODE}}), um die gegnerische Drohung zu analysieren.
- Klicke auf {{label:Board.Analysis.Pin}}, um die Bewertungsleiste einer Engine außerhalb des Tabs anzuheften, oder auf {{label:Board.Analysis.EngineSettings}}, um tab-spezifische Einstellungen wie Suchlimit und Variantenanzahl anzupassen.
- Ziehe Engine-Karten an {{label:Board.Analysis.ReorderEngine}}, um ihre Reihenfolge zu ändern.
- Wenn eine Engine ausfällt, klicke neben {{label:Board.Analysis.RetryEngine}} auf {{label:Board.Analysis.Logs}}, um ihre UCI-Kommunikation anzusehen. Bei einer laufenden Engine findest du denselben Button unter {{label:Board.Analysis.EngineSettings}} auf ihrer Karte.

Steuere Engine-Pfeile auf dem Brett unter [[setting:arrows]] ({{label:Settings.Arrows}}). Lokale Engines werden in dem unter [[setting:engines-directory]] festgelegten Ordner gespeichert.
