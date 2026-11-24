---
id: chessbase-import
title: Importowanie baz danych z ChessBase
summary: Wyeksportuj bazę ChessBase do PGN i przekonwertuj ją na bazę danych Studio.
source: d7f599a811a0afb0
---

ChessRiddle Studio nie odczytuje bezpośrednio plików ChessBase `.cbh` ani `.cbv`. Zamiast tego wyeksportuj najpierw bazę ChessBase do PGN, a następnie przekonwertuj plik PGN na bazę danych Studio.

Jeśli w oknie wyboru pliku wskażesz plik ChessBase, Studio automatycznie otworzy okno {{label:ChessBaseGuide.Title}}. Możesz je również otworzyć z linku poradnika wewnątrz {{label:Library.AddDatabase}} w [[page:library]].

Wykonaj te kroki, aby zaimportować dane z ChessBase:
1. Otwórz bazę danych w ChessBase i zaznacz partie, które chcesz wyeksportować.
2. Wyeksportuj lub zapisz wybrane partie w ChessBase jako plik `.pgn`.
3. W Studio otwórz [[page:library]], kliknij {{label:Library.AddDatabase}}, przejdź do karty {{label:Common.Local}}, wybierz wyeksportowany plik `.pgn`, wpisz {{label:Common.Name}} i kliknij {{label:Databases.Add.Convert}}.

Po konwersji baza pojawi się w [[page:library]], gdzie możesz przeglądać jej partie, graczy i turnieje albo ustawić ją jako swoją {{label:Databases.Settings.ReferenceDatabase}}.
