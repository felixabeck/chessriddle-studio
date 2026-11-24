---
id: ai-connections
title: Coach and AI connections
summary: Connect an AI provider or local model to enable the Coach on the analysis board and the Assistant.
---

AI connections power both the Coach (on the analysis board) and the Assistant. Manage your connections in [[settings-category:coach]] ({{label:Settings.AI}}).

To add a connection, choose one of these options in [[settings-category:coach]]:
- {{label:Settings.Coach.SignIn.ChatGpt}}: sign in with your ChatGPT account in the browser.
- {{label:Settings.Coach.SignIn.Grok}}: sign in with Grok using a device code (unofficial).
- {{label:Settings.Coach.Connections.Add}}: enter an OpenAI-compatible base address and optional API key. Presets are available for OpenAI, Google Gemini, DeepSeek, Qwen, OpenRouter, Ollama, and LM Studio.

Keys and sign-in credentials are stored in your computer's system keyring. Once at least one connection is saved, the Assistant appears in the {{label:Menu.Help}} menu ({{label:Menu.Help.Assistant}}) and in the navigation row ({{label:Navigation.Assistant}}).

Both the Coach and the Assistant share the same selected connection, model, and reasoning effort. Use {{label:Settings.Coach.Connection.Check}} on a connection to verify it and list its available models, or {{label:Settings.Coach.Connection.Remove}} to remove it.

To use the Coach on the analysis board:
- Open the {{label:Board.Tabs.Coach}} tab (or press the {{label:Settings.Keybinds.Actions.COACH_TAB}} shortcut).
- The Coach requires a local chess engine to verify its analysis lines. Choose which engine it uses in [[setting:coach-engine]] ({{label:Settings.Coach.Engine}}), or install an engine on [[page:engines]] ({{label:SideBar.Engines}}).
- Ask questions about the current position. Before the first message to a connection, Studio shows a notice listing what is sent (the position, current game PGN, engine analysis, reference database move statistics if selected, and matching repertoire lines).
- Move lines in Coach answers can be hovered or clicked to preview on a mini board without changing the game. Click {{label:Coach.InsertLine}} beside a line to insert it as a variation.
