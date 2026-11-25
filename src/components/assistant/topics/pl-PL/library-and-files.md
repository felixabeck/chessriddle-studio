---
id: library-and-files
title: Pliki i Biblioteka
summary: Skonfiguruj folder roboczy, twórz i porządkuj pliki PGN, otwieraj i zapisuj partie oraz zarządzaj koszem.
source: 1c8e1ec37f492b22
---

[[page:library]] ({{label:SideBar.Library}}) łączy pliki PGN z Twojego obszaru roboczego (partie, repertuary, turnieje, zagadki i inne pliki) z Twoimi bazami partii.

Zanim utworzysz pliki, wybierz folder roboczy. Jeśli żaden folder nie jest jeszcze ustawiony, kliknij {{label:Files.ChooseFolder}} w [[page:library]] lub skonfiguruj [[setting:files-directory]] ({{label:Settings.Directories.Files}}) w [[settings-category:directories]].

W [[page:library]]:
- Kliknij {{label:Files.CreateFile}}, aby utworzyć nowy plik PGN, lub {{label:Files.CreateFolder}}, aby uporządkować pliki w podfolderach.
- Użyj pola {{label:Common.Search}} oraz listy rozwijanej {{label:Files.FileType}}, aby filtrować według typu pliku lub {{label:Library.GamesDatabase}}.
- Wybierz plik, aby podejrzeć jego partie (podgląd może ukryć ruchy przyciskiem oka, [[setting:hide-preview-moves]]), otworzyć go na tablicy analizy lub użyć {{label:Files.Rename}}, {{label:Files.Move}} i {{label:Files.Trash}}.

Podczas edycji pliku na tablicy analizy:
- Zapisz zmiany przyciskiem zapisu na pasku szachownicy, przez {{label:Menu.File}} -> {{label:Common.Save}} lub skrótem {{label:Settings.Keybinds.Actions.SAVE_FILE}}.
- Włącz [[setting:auto-save]] ({{label:Settings.AutoSave}}), aby automatycznie zapisywać zmiany w otwartych plikach.
- Użyj {{label:Menu.File}} -> {{label:Board.Database.Save}} (lub przycisku {{label:Board.Database.Save}} na pasku narzędzi), aby zapisać bieżącą partię w innym pliku biblioteki lub bazie danych.

Przeniesienie pliku do {{label:Files.Trash}} nie usuwa go od razu na stałe. Możesz od razu kliknąć {{label:Common.Undo}} w powiadomieniu albo przewinąć do sekcji {{label:Files.Trash}} w [[page:library]], aby użyć {{label:Files.Restore}}, {{label:Files.DeletePermanently}} lub {{label:Files.EmptyTrash}}.

Gdy Twoje konto ChessRiddle jest połączone, kliknij {{label:Library.Sync.Action}} w [[page:library]], aby zsynchronizować wybrane pliki PGN z prywatną biblioteką w ChessRiddle (do 100 plików, 5 MB i 40 000 posunięć na plik). Edycje, zmiany nazw, odznaczenia i usunięcia aktualizują się automatycznie; pobrane historie partii oraz bazy danych partii pozostają lokalnie. Wyłączenie synchronizacji pozwala zachować lub usunąć zsynchronizowane pliki w ChessRiddle.
