---
id: game-report
title: Przegląd partii i raport
summary: Przeanalizuj partię lokalnym silnikiem, aby zobaczyć dokładność, wykresy oceny i czasu, informacje o debiucie i repertuarze oraz kluczowe momenty na szachownicy.
source: d1a4339820f36de2
---

Raport partii analizuje każdy ruch wariantu głównego lokalnym silnikiem szachowym i zamienia wyniki w przejrzysty przegląd partii.

Aby wygenerować raport, otwórz partię na szachownicy analizy, przełącz się na kartę {{label:Board.Analysis.Report}} i kliknij {{label:Board.Analysis.GenerateReport}} (lub naciśnij skrót {{label:Settings.Keybinds.Actions.GENERATE_REPORT}}).

W oknie {{label:Board.Analysis.GenerateReport}}:
- Wybierz lokalny {{label:Common.Engine}}. Jeśli żaden nie jest zainstalowany, dodaj go w [[page:engines]].
- Ustaw limit przeszukiwania na ruch (głębokość, czas lub węzły).
- Włącz {{label:Board.Analysis.MarkMoves}}, aby oznaczyć ruchy symbolami jakości (`!!`, `!`, `!?`, `?!`, `?`, `??`).
- Włącz {{label:Board.Analysis.ShowVariations}}, aby wstawić lepsze warianty do zapisu partii.
- Włącz {{label:Board.Analysis.AnnotateNovelties}}, aby oznaczyć symbolem `N` pierwszy ruch opuszczający Twoją bazę referencyjną. Ta opcja wymaga gotowej bazy referencyjnej wybranej w [[page:library]].
- Kliknij {{label:Board.Analysis.Analyze}}, aby rozpocząć.

Podczas generowania raportu możesz go anulować przyciskiem postępu. Edycja wariantu głównego również anuluje trwający raport.

Po zakończeniu karta {{label:Board.Analysis.Report}} wyświetla:
- Dyskretny nagłówek z nazwą silnika, limitem i datą oraz mały przycisk {{label:Board.Analysis.Report.Regenerate}} obok. Szeroki przycisk {{label:Board.Analysis.GenerateReport}} pojawia się tylko wtedy, gdy nie ma aktualnego raportu.
- Jednozdaniowe podsumowanie nad tablicą wyników, jeśli partia rozpoczęła się z wyrównanej pozycji; przy nierównym starcie podsumowanie nie jest wyświetlane.
- Jedną tablicę wyników z nazwiskami i rankingami graczy, {{label:Board.Analysis.Accuracy}} jako główną liczbą, {{label:Board.Analysis.Report.AverageLoss}}, dokładnością w poszczególnych fazach partii oraz sześcioma wierszami jakości ruchów z przygaszonymi zerami. Kliknięcie niezerowej liczby przenosi do tych ruchów, a najechanie kursorem lub skupienie klawiaturą dowolnej etykiety wyjaśnia jej znaczenie.
- Wykres przełączany między {{label:Board.Analysis.Report.Evaluation}} (z linią zera) a {{label:Board.Analysis.Report.WinChance}}, z opisem dostępnym po najechaniu lub skupieniu klawiaturą. Gdy co najmniej połowa ruchów zawiera czasy zegara, pod wykresem pojawia się pasek {{label:Board.Analysis.Report.TimeUsage}}; kliknij dowolny słupek, aby przejść do tego ruchu.
- Blok debiutu i repertuaru pokazujący nazwę debiutu, nowinkę (`N`), gdy wystąpiła, oraz notatkę o repertuarze tylko dla Twojej strony — dopasowanej po nazwie gracza do połączonych kont Lichess, Chess.com lub aliasów w [[page:accounts]], albo do strony u dołu szachownicy, jeśli żadna nazwa nie pasuje (obrócenie szachownicy zmienia tę stronę). Informuje, gdzie opuściłeś repertuar (kliknięcie ustawia pozycję ze strzałkami) lub do którego ruchu był on grany zgodnie z repertuarem. Jeśli plików repertuaru nie udało się odczytać w całości, pojawia się jeden przygaszony wiersz: {{label:Board.Analysis.Report.RepertoireIncomplete}}
- {{label:Board.Analysis.Report.KeyMoments}}: kliknij dowolny wiersz, aby przejść do pozycji przed ruchem, dzięki czemu obie strzałki na szachownicy (zagrany ruch i lepszy ruch) wychodzą z tego pola. Użyj {{label:Board.Analysis.Report.PreviousMoment}} i {{label:Board.Analysis.Report.NextMoment}}, aby przechodzić między nimi, albo filtruj według {{label:Board.Analysis.Report.FilterBoth}}, {{label:Board.Analysis.Report.FilterWhite}} lub {{label:Board.Analysis.Report.FilterBlack}}. Momenty pokazują też znaczniki takie jak {{label:Board.Analysis.Report.Tag.TurningPoint}} lub {{label:Board.Analysis.Report.Tag.TimeTrouble}} oraz rodzaj błędu, gdy warianty silnika go potwierdzają.
- Przy momentach `?!`, `?` i `??` kliknij {{label:Board.Analysis.Report.Explain}}, aby ustawić tę pozycję i otworzyć {{label:Board.Tabs.Coach}} z pytaniem o dany moment. Przycisk ten jest ukryty, gdy nie skonfigurowano żadnego połączenia AI.

Jeśli później zmodyfikujesz partię, wygeneruj raport ponownie za pomocą {{label:Board.Analysis.GenerateReport}} lub {{label:Board.Analysis.Report.Regenerate}}, aby zaktualizować przegląd.
