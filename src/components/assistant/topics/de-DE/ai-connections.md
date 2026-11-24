---
id: ai-connections
title: Coach und KI-Verbindungen
summary: Verbinde einen KI-Anbieter oder ein lokales Modell, um den Coach auf dem Analysebrett und den Assistant zu nutzen.
source: db8abb1b23f8812c
---

KI-Verbindungen versorgen sowohl den Coach (auf dem Analysebrett) als auch den Assistant. Verwalte deine Verbindungen unter [[settings-category:coach]] ({{label:Settings.AI}}).

Um eine Verbindung hinzuzufügen, wähle unter [[settings-category:coach]] eine dieser Optionen:
- {{label:Settings.Coach.SignIn.ChatGpt}}: Melde dich im Browser mit deinem ChatGPT-Konto an.
- {{label:Settings.Coach.SignIn.Grok}}: Melde dich mit einem Gerätecode bei Grok an (inoffiziell).
- {{label:Settings.Coach.Connections.Add}}: Gib eine OpenAI-kompatible Basisadresse und optional einen API-Schlüssel ein. Voreinstellungen gibt es für OpenAI, Google Gemini, DeepSeek, Qwen, OpenRouter, Ollama und LM Studio.

Schlüssel und Anmeldedaten werden im Schlüsselbund deines Computers gespeichert. Sobald mindestens eine Verbindung gespeichert ist, erscheint der Assistant im Menü {{label:Menu.Help}} ({{label:Menu.Help.Assistant}}) und in der Navigationsleiste ({{label:Navigation.Assistant}}).

Coach und Assistant teilen sich dieselbe ausgewählte Verbindung, dasselbe Modell und dieselbe Denktiefe. Nutze {{label:Settings.Coach.Connection.Check}} bei einer Verbindung, um sie zu prüfen und verfügbare Modelle aufzulisten, oder {{label:Settings.Coach.Connection.Remove}}, um sie zu entfernen.

So nutzt du den Coach auf dem Analysebrett:
- Öffne den Tab {{label:Board.Tabs.Coach}} (oder drücke das Tastenkürzel {{label:Settings.Keybinds.Actions.COACH_TAB}}).
- Der Coach benötigt eine lokale Schach-Engine, um seine Analysevarianten zu prüfen. Wähle unter [[setting:coach-engine]] ({{label:Settings.Coach.Engine}}), welche Engine er nutzt, oder installiere eine unter [[page:engines]] ({{label:SideBar.Engines}}).
- Stelle Fragen zur aktuellen Stellung. Vor der ersten Nachricht an eine Verbindung zeigt Studio einen Hinweis mit allen gesendeten Daten (Stellung, PGN der aktuellen Partie, Engine-Analyse, Zugstatistiken der Referenzdatenbank falls gewählt sowie passende Repertoire-Varianten).
- Zugfolgen in Antworten des Coach kannst du mit dem Mauszeiger überfahren oder anklicken, um sie auf einem Minibrett anzusehen, ohne die Partie zu verändern. Klicke neben einer Variante auf {{label:Coach.InsertLine}}, um sie als Variante einzufügen.
