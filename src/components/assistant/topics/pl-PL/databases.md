---
id: databases
title: Bazy danych, eksplorator, wyszukiwanie pozycji, gracze i turnieje
summary: Dodawaj lub pobieraj bazy partii, wybieraj bazę odniesienia, wyszukuj pozycje w eksploratorze i przeglądaj partie, graczy oraz turnieje.
source: 3bb4014ea8eab046
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
- Wyszukuj i sortuj partie, podejrzyj partię lub otwórz ją na tablicy analizy.
- W {{label:Databases.Card.Players}} wybierz gracza, aby zobaczyć {{label:Home.Personal.Overview}}, {{label:Home.Personal.Ratings}} i {{label:Home.Personal.Openings}} (interaktywne drzewo debiutowe z przyciskiem {{label:Databases.OpeningTree.Prepare}}), a także informacje FIDE poprzez {{label:Databases.FIDE.Info}}.
- W {{label:Databases.Settings.Events}} wyszukuj turnieje po nazwie i sortuj według daty, graczy, partii lub średniego Elo.

Na karcie gracza otwórz kartę {{label:Home.Personal.Preparation}}, aby porównać jego partie z twoimi plikami repertuaru:
- Wybierz kolor przeciwnika, okres {{label:Databases.OpeningTree.Since}} oraz (przy powiązanych kontach internetowych) {{label:Databases.OpeningTree.OverTheBoard}}, {{label:Databases.OpeningTree.Online}} lub {{label:Databases.Preparation.Both}}. Kliknij {{label:Databases.Preparation.Refresh}}, aby uruchomić porównanie ponownie.
- Zwiększ {{label:Databases.Preparation.MinGames}}, aby ukryć warianty i luki, które przeciwnik grał tylko rzadko; Twój plik zwija te warianty, a trening je pomija.
- Przejrzyj warianty grane przez przeciwnika oraz {{label:Databases.Preparation.GapsTitle}}. Kliknij dowolny wiersz, aby otworzyć swój plik repertuaru w tej pozycji z ukrytymi pozostałymi wariantami pobocznymi; w nagłówku notacji przełączaj się między {{label:Notation.PreparationOpponentLines}} a {{label:Notation.PreparationAllLines}}.
- Kliknij {{label:Databases.Preparation.TrainLines}}, aby rozpocząć sesję treningową na czas dla tych wariantów; twoje odpowiedzi aktualizują zwykły harmonogram powtórek.

Na tablicy analizy otwórz {{label:Board.Tabs.Database}}, aby korzystać z eksploratora debiutów:
- Przełączaj się między {{label:Board.Database.Local}}, {{label:Board.Database.LichessAll}} i {{label:Board.Database.LichessMaster}} (internetowe eksploratory Lichess wymagają zalogowanego konta Lichess w [[page:accounts]]).
- Przełączaj się między {{label:Board.Database.Stats}} (statystyki ruchów) i {{label:Board.Database.Games}} (pasujące partie).
- Dla baz lokalnych kliknij {{label:Board.Database.Compare}}, aby wyświetlić dwie bazy obok siebie, albo otwórz {{label:Board.Database.Local.Position}}, aby przełączać między wyszukiwaniem pozycji {{label:Board.Database.Local.Exact}} i {{label:Board.Database.Local.Partial}} (w tym {{label:Board.Database.Local.SimilarStructure}} do wyszukiwania struktury pionowej oraz {{label:Fen.Empty}} dla własnych układów).
- Użyj {{label:Board.Database.Pin}}, aby przypiąć eksplorator nad lub pod szachownicą albo notacją, oraz {{label:Board.Database.Unpin}}, aby przywrócić go do kart.
- Gdy {{label:Databases.OpeningTree.Prepare}} otwiera tablicę dla gracza z bazy danych, eksplorator dodaje twoją bazę odniesienia jako kolejną kolumnę obok partii przeciwnika; kliknij {{label:Board.Database.RemoveReference}}, aby ją ukryć, lub {{label:Board.Database.ShowReference}}, aby ją przywrócić.
