---
id: ai-connections
title: Coach og KI-tilkoblinger
summary: Koble til en KI-leverandør eller lokal modell for å aktivere Coach på analysebrettet og Assistant.
source: db8abb1b23f8812c
---

KI-tilkoblinger driver både Coach (på analysebrettet) og Assistant. Administrer tilkoblingene dine under [[settings-category:coach]] ({{label:Settings.AI}}).

For å legge til en tilkobling velger du ett av disse alternativene i [[settings-category:coach]]:
- {{label:Settings.Coach.SignIn.ChatGpt}}: logg inn med ChatGPT-kontoen din i nettleseren.
- {{label:Settings.Coach.SignIn.Grok}}: logg inn med Grok ved hjelp av en enhetskode (uoffisiell).
- {{label:Settings.Coach.Connections.Add}}: skriv inn en OpenAI-kompatibel basisadresse og en valgfri API-nøkkel. Forhåndsinnstillinger finnes for OpenAI, Google Gemini, DeepSeek, Qwen, OpenRouter, Ollama og LM Studio.

Nøkler og innloggingsdata lagres i systemets nøkkelring på datamaskinen din. Når minst én tilkobling er lagret, vises Assistant i menyen {{label:Menu.Help}} ({{label:Menu.Help.Assistant}}) og på navigasjonslinjen ({{label:Navigation.Assistant}}).

Både Coach og Assistant deler samme valgte tilkobling, modell og resonneringsnivå. Bruk {{label:Settings.Coach.Connection.Check}} på en tilkobling for å kontrollere den og liste opp tilgjengelige modeller, eller {{label:Settings.Coach.Connection.Remove}} for å fjerne den.

Slik bruker du Coach på analysebrettet:
- Åpne fanen {{label:Board.Tabs.Coach}} (eller trykk hurtigtasten {{label:Settings.Keybinds.Actions.COACH_TAB}}).
- Coach trenger en lokal sjakkcomputer for å kontrollere analysevariantene sine. Velg hvilken motor den bruker i [[setting:coach-engine]] ({{label:Settings.Coach.Engine}}), eller installer en motor under [[page:engines]] ({{label:SideBar.Engines}}).
- Still spørsmål om den gjeldende stillingen. Før den første meldingen til en tilkobling viser Studio en melding med hva som sendes (stillingen, PGN for det gjeldende partiet, motoranalyse, trekkstatistikk fra referansedatabasen hvis valgt og samsvarende repertoarlinjer).
- Trekklinjer i svar fra Coach kan holdes over eller klikkes på for å forhåndsvises på et minbrett uten å endre partiet. Klikk {{label:Coach.InsertLine}} ved siden av en linje for å sette den inn som en variant.
