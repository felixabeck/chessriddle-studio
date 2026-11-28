---
id: databases
title: Bazy danych, eksplorator, wyszukiwanie pozycji, gracze i turnieje
summary: Dodawaj lub pobieraj bazy partii, wybieraj bazę odniesienia, wyszukuj pozycje w eksploratorze i przeglądaj partie, graczy oraz turnieje.
source: 79c93eb50f572f36
---

Bazy danych znajdują się w [[page:library]] ({{label:SideBar.Library}}) obok plików PGN i są przechowywane w [[setting:databases-directory]].

Aby dodać bazę danych, otwórz [[page:library]] i kliknij {{label:Library.AddDatabase}}:
- {{label:Databases.Add.Web}}: pobieraj wybrane bazy partii z katalogu.
- {{label:Common.Local}}: wybierz lokalny plik PGN (w tym `.pgn.zst` lub `.pgn.bz2`), podaj {{label:Common.Name}} oraz opcjonalny {{label:Common.Description}} i kliknij {{label:Databases.Add.Convert}}.

Wybierz bazę danych w [[page:library]], aby nią zarządzać:
- Zaznacz {{label:Databases.Settings.ReferenceDatabase}}, aby ustawić ją jako domyślną bazę odniesienia dla eksploratora, kreatora repertuaru, nowinek w raporcie partii i Coach.
- Zaznacz {{label:Databases.Settings.Indexed}}, aby utworzyć lub usunąć indeksy wyszukiwania w celu przyspieszenia zapytań.
- Kliknij {{label:Databases.Settings.Explore}}, aby otworzyć widok tabeli bazy danych.
- W sekcji {{label:Databases.Settings.Actions}} użyj {{label:Databases.Settings.AddGames}}, aby dopisać pliki PGN, {{label:Databases.Settings.ExportPGN}}, aby wyeksportować do PGN, lub {{label:Common.Delete}}, aby usunąć bazę.
- W sekcji {{label:Databases.Settings.AdvancedTools}} użyj {{label:Databases.Settings.MergePlayers}}, aby połączyć zduplikowane wpisy graczy, albo {{label:Databases.Settings.RemoveDup}} i {{label:Databases.Settings.RemoveEmpty}}, aby uporządkować partie.

W widoku tabeli bazy danych przełączaj się między {{label:Common.Games}}, {{label:Databases.Card.Players}} i {{label:Databases.Settings.Events}} (turnieje):
- Wyszukuj i sortuj partie, podejrzyj partię (podgląd może ukryć ruchy przyciskiem oka, [[setting:hide-preview-moves]]) lub otwórz ją na tablicy analizy.
- W {{label:Databases.Card.Players}} wybierz gracza, aby zobaczyć {{label:Home.Personal.Overview}}, {{label:Home.Personal.Ratings}} i {{label:Home.Personal.Openings}} (interaktywne drzewo debiutowe), a także informacje FIDE poprzez {{label:Databases.FIDE.Info}}. Przycisk {{label:Databases.OpeningTree.Prepare}} w {{label:Home.Personal.Openings}} przenosi wybrany wariant, kolor oraz okres {{label:Databases.OpeningTree.Since}}.
- W {{label:Databases.Settings.Events}} wyszukuj turnieje po nazwie i sortuj według daty, graczy, partii lub średniego Elo.

Na karcie gracza otwórz kartę {{label:Home.Personal.Preparation}}, aby porównać jego partie z twoimi plikami repertuaru:
- Wybierz kolor przeciwnika, okres {{label:Databases.OpeningTree.Since}} oraz (przy powiązanych kontach internetowych) {{label:Databases.OpeningTree.OverTheBoard}}, {{label:Databases.OpeningTree.Online}} lub {{label:Databases.Preparation.Both}}. Kliknij {{label:Databases.Preparation.Refresh}}, aby uruchomić porównanie ponownie, albo kliknij {{label:Databases.OpeningTree.Prepare}}, aby otworzyć pozycję początkową na tablicy analizy z kolorem i okresem {{label:Databases.OpeningTree.Since}} z tej karty.
- Zwiększ {{label:Databases.Preparation.MinGames}}, aby ukryć warianty i luki, które przeciwnik grał tylko rzadko; Twój plik zwija te warianty, a trening je pomija.
- Przejrzyj warianty grane przez przeciwnika oraz {{label:Databases.Preparation.GapsTitle}}. Kliknij dowolny wiersz, aby otworzyć swój plik repertuaru w tej pozycji z ukrytymi pozostałymi wariantami pobocznymi; w nagłówku notacji przełączaj się między {{label:Notation.PreparationOpponentLines}} a {{label:Notation.PreparationAllLines}}.
- Kliknij {{label:Databases.Preparation.TrainLines}}, aby rozpocząć sesję treningową na czas dla tych wariantów; twoje odpowiedzi aktualizują zwykły harmonogram powtórek.
- Aby przygotować się na przeciwnika, który ma tylko konto na Lichess lub Chess.com, kliknij {{label:Library.OnlineOpponent}} w [[page:library]], aby wyszukać jego konto, pobrać partie i otworzyć jego kartę od razu na karcie {{label:Home.Personal.Preparation}} (ponowne wpisanie tego samego konta otwiera ją bez kolejnego pobierania).

Na tablicy analizy otwórz {{label:Board.Tabs.Database}}, aby korzystać z eksploratora debiutów:
- Wybierz {{label:Board.Database.LichessAll}} lub {{label:Board.Database.LichessMaster}} w menu źródeł oraz w {{label:Board.Database.Compare}} (internetowe eksploratory Lichess wymagają zalogowanego konta Lichess w [[page:accounts]]).
- {{label:Board.Database.Stats}} (statystyki ruchów) wyświetla się u góry, a {{label:Board.Database.Games}} (pasujące partie) na dole; dopóki widoczne są oba obszary, przeciągnij linię podziału między nimi, aby podzielić wysokość. Użyj {{label:Board.Database.HideGames}} lub {{label:Board.Database.ShowGames}}, aby ukryć albo pokazać listę partii, oraz ikony koła zębatego, aby rozwinąć lub zwinąć kontrolki źródeł — obie ikony znajdują się w nagłówku panelu, gdy jest on osobnym kafelkiem, oraz w górnym wierszu sterowania, gdy jest w kartach. Kolumna {{label:Board.Area.Notation}} pokazuje ruchy od pozycji na szachownicy, z następnym ruchem pogrubionym.
- Kliknij {{label:Board.Database.Compare}}, aby wyświetlić dwa źródła obok siebie, albo otwórz {{label:Board.Database.Local.Position}}, aby przełączać między wyszukiwaniem pozycji {{label:Board.Database.Local.Exact}} i {{label:Board.Database.Local.Partial}} (w tym {{label:Board.Database.Local.SimilarStructure}} do wyszukiwania struktury pionowej oraz {{label:Fen.Empty}} dla własnych układów).
- Możesz też wyświetlić {{label:Board.Tabs.Database}} jako osobny obszar na szachownicy analizy i użyć {{label:Board.Area.ReturnToTabs}}, aby przywrócić ją do kart.
- Gdy {{label:Databases.OpeningTree.Prepare}} otwiera tablicę dla gracza z bazy danych, eksplorator zaczyna od twojej bazy odniesienia jako kolejnej kolumny obok partii przeciwnika; kliknij {{label:Board.Database.RemoveReference}}, aby ukryć kolumnę, lub {{label:Board.Database.AddColumn}}, aby dodać następną.
