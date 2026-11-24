---
id: engines
title: Silniki szachowe i panel analizy
summary: Instaluj lub dodawaj silniki lokalne i w chmurze, konfiguruj opcje UCI oraz korzystaj z analizy na żywo na szachownicy.
source: e18a17e22622746d
---

Zarządzaj swoimi silnikami szachowymi w [[page:engines]] ({{label:SideBar.Engines}}).

Aby dodać silnik, kliknij {{label:Common.AddNew}} w [[page:engines]], aby otworzyć {{label:Engines.Add.Title}}:
- {{label:Common.Download}}: zainstaluj wstępnie skonfigurowany silnik (np. Stockfish) z katalogu za pomocą {{label:Common.Install}}.
- {{label:Engines.Add.Cloud}}: dodaj internetowe silniki analizy (ChessDB lub Lichess Cloud) za pomocą {{label:Common.Add}}.
- {{label:Common.Local}}: zarejestruj plik wykonywalny silnika UCI znajdujący się już na Twoim komputerze.

Wybierz dowolny silnik w [[page:engines]], aby go skonfigurować. W przypadku silników lokalnych możesz edytować ogólne dane, ustawiać domyślne opcje UCI (takie jak Threads, Hash i MultiPV), dołączać pliki zasobów takie jak bazy końcówek Syzygy, kliknąć {{label:Engines.Settings.Reset}}, aby przywrócić wartości domyślne, {{label:Common.Duplicate}}, aby skopiować konfigurację, lub {{label:Common.Remove}}, aby usunąć silnik. W przypadku silników w chmurze możesz edytować nazwę i {{label:Engines.Settings.NumOfLines}}.

Na tablicy analizy otwórz kartę {{label:Board.Tabs.Analysis}} i wybierz {{label:Board.Analysis.Engines}}:
- Kliknij {{label:Board.Analysis.SelectEngines}}, aby wybrać zainstalowane silniki wczytane do panelu, lub {{label:Board.Analysis.ManageEngines}}, aby przejść do [[page:engines]].
- Kliknij {{label:Board.Analysis.EnableEngine}} lub {{label:Board.Analysis.DisableEngine}} na karcie silnika, aby uruchomić lub wstrzymać analizę, albo użyj {{label:Board.Analysis.EnableAllEngines}}, gdy wczytanych jest wiele silników.
- Kliknij {{label:Board.Analysis.CheckThreat}} (lub naciśnij skrót {{label:Settings.Keybinds.Actions.TOGGLE_THREAT_MODE}}), aby przeanalizować groźbę przeciwnika.
- Kliknij {{label:Board.Analysis.Pin}}, aby przypiąć pasek oceny silnika poza kartą, lub {{label:Board.Analysis.EngineSettings}}, aby dostosować ustawienia danej karty, takie jak limit przeszukiwania i liczba linii.
- Przeciągaj karty silników za {{label:Board.Analysis.ReorderEngine}}, aby zmienić ich kolejność.
- Otwórz {{label:Board.Analysis.Logs}} w {{label:Board.Tabs.Analysis}}, aby podejrzeć komunikację UCI silnika.

Steruj strzałkami silnika na szachownicy za pomocą [[setting:arrows]] ({{label:Settings.Arrows}}). Lokalne silniki są przechowywane w katalogu ustawionym w [[setting:engines-directory]].
