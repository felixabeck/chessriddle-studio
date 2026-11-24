---
id: ai-connections
title: Coach i połączenia AI
summary: Połącz dostawcę AI lub model lokalny, aby włączyć Coach na tablicy analizy oraz Assistant.
source: db8abb1b23f8812c
---

Połączenia AI zasilają zarówno Coach (na tablicy analizy), jak i Assistant. Zarządzaj swoimi połączeniami w [[settings-category:coach]] ({{label:Settings.AI}}).

Aby dodać połączenie, wybierz jedną z tych opcji w [[settings-category:coach]]:
- {{label:Settings.Coach.SignIn.ChatGpt}}: zaloguj się za pomocą swojego konta ChatGPT w przeglądarce.
- {{label:Settings.Coach.SignIn.Grok}}: zaloguj się do Grok za pomocą kodu urządzenia (nieoficjalne).
- {{label:Settings.Coach.Connections.Add}}: podaj adres bazowy zgodny z OpenAI i opcjonalny klucz API. Dostępne są gotowe ustawienia dla OpenAI, Google Gemini, DeepSeek, Qwen, OpenRouter, Ollama i LM Studio.

Klucze i dane logowania są przechowywane w systemowym pęku kluczy na Twoim komputerze. Gdy zapisane jest co najmniej jedno połączenie, Assistant pojawia się w menu {{label:Menu.Help}} ({{label:Menu.Help.Assistant}}) oraz na pasku nawigacji ({{label:Navigation.Assistant}}).

Coach i Assistant korzystają z tego samego wybranego połączenia, modelu i poziomu rozumowania. Użyj {{label:Settings.Coach.Connection.Check}} przy połączeniu, aby je sprawdzić i wyświetlić dostępne modele, lub {{label:Settings.Coach.Connection.Remove}}, aby je usunąć.

Aby używać Coach na tablicy analizy:
- Otwórz kartę {{label:Board.Tabs.Coach}} (lub naciśnij skrót {{label:Settings.Keybinds.Actions.COACH_TAB}}).
- Coach wymaga lokalnego silnika szachowego do weryfikacji wariantów analizy. Wybierz, z którego silnika korzysta, w [[setting:coach-engine]] ({{label:Settings.Coach.Engine}}), lub zainstaluj silnik w [[page:engines]] ({{label:SideBar.Engines}}).
- Zadawaj pytania o bieżącą pozycję. Przed pierwszą wiadomością do danego połączenia Studio wyświetla informację o tym, co jest wysyłane (pozycja, PGN bieżącej partii, analiza silnika, statystyki ruchów z bazy odniesienia jeśli jest wybrana oraz pasujące warianty z repertuaru).
- Na ciągi ruchów w odpowiedziach Coach można najechać kursorem lub kliknąć je, aby podejrzeć na miniszachownicy bez zmieniania partii. Kliknij {{label:Coach.InsertLine}} obok wariantu, aby wstawić go jako wariant.
