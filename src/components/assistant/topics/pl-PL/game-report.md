---
id: game-report
title: Raport partii
summary: Uruchom automatyczną analizę partii silnikiem, aby zobaczyć dokładność, wykres oceny, kluczowe momenty i klasyfikacje ruchów.
source: b69aae8a4fe0f417
---

Raport partii analizuje każdy ruch linii głównej za pomocą lokalnego silnika szachowego i podsumowuje dokładność oraz błędy w partii.

Aby wygenerować raport, otwórz partię na tablicy analizy, przejdź do karty {{label:Board.Analysis.Report}} i kliknij {{label:Board.Analysis.GenerateReport}} (lub naciśnij skrót {{label:Settings.Keybinds.Actions.GENERATE_REPORT}}).

W oknie {{label:Board.Analysis.GenerateReport}}:
- Wybierz lokalny {{label:Common.Engine}}. Jeśli żaden nie jest zainstalowany, dodaj go w [[page:engines]].
- Ustaw limit przeszukiwania na ruch (głębokość, czas lub węzły).
- Włącz {{label:Board.Analysis.MarkMoves}}, aby oznaczyć ruchy symbolami jakości.
- Włącz {{label:Board.Analysis.ShowVariations}}, aby wstawić do notacji warianty z lepszymi ruchami.
- Włącz {{label:Board.Analysis.AnnotateNovelties}}, aby oznaczyć pierwszy ruch wychodzący poza Twoją bazę odniesienia. Ta opcja wymaga gotowej bazy odniesienia wybranej w [[page:library]].
- Kliknij {{label:Board.Analysis.Analyze}}, aby rozpocząć.

Podczas generowania raportu możesz go anulować przyciskiem postępu. Edycja linii głównej anuluje trwający raport.

Po zakończeniu {{label:Board.Analysis.Report}} wyświetla:
- Procenty dokładności i średnią stratę centypionów (ACPL) dla {{label:Common.WHITE}} i {{label:Common.BLACK}}.
- Wykres oceny w trakcie całej partii.
- {{label:Board.Analysis.Report.KeyMoments}}: klikalną listę oznaczonych ruchów ze skokami oceny i lepszymi ruchami.
- Tabelę podsumowania jakości ruchów, w której kliknięcie liczby przenosi do odpowiednich ruchów.

Jeśli później zmodyfikujesz partię, kliknij {{label:Board.Analysis.RegenerateReport}}, aby uruchomić świeżą analizę.
