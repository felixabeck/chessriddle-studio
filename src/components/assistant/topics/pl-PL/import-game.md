---
id: import-game
title: Importowanie partii
summary: Importuj partię z pliku PGN, wklejonego tekstu PGN, adresu URL z Lichess lub Chess.com, pozycji FEN albo zdjęć lub skanów PDF ręcznie zapisanego blankietu partii.
source: 85ee9b055c7abe34
---

Aby zaimportować partię lub pozycję, otwórz [[page:new-tab]] i kliknij {{label:Home.Card.ImportGame.Button}}, aby otworzyć okno {{label:Home.Card.ImportGame.Title}}. Możesz też otworzyć plik PGN bezpośrednio przez {{label:Menu.File}} -> {{label:Menu.File.OpenFile}} (lub skrót {{label:Settings.Keybinds.Actions.OPEN_FILE}}).

W oknie {{label:Home.Card.ImportGame.Title}} wybierz jedną z opcji:
- **PGN**: wybierz {{label:Common.PGNFile}} z komputera lub wklej tekst do pola {{label:Common.PGNGame}}. Zaznacz {{label:Import.SaveToCollection}}, aby zapisać kopię w folderze roboczym w [[page:library]], wpisz {{label:Common.Name}} i wybierz {{label:Files.FileType}}.
- **{{label:Import.Online}}**: wklej {{label:Import.GameURL}} z Lichess lub Chess.com, aby pobrać partię i otworzyć ją na tablicy analizy.
- **FEN**: wklej zapis FEN, aby otworzyć tablicę analizy od tej pozycji.
- **{{label:Import.FromPhoto}}** (gdy funkcje AI są dostępne): odczytaj od 1 do 4 zdjęć lub stron PDF ręcznie zapisanego blankietu partii do nowej partii. Wymaga to co najmniej jednego połączenia AI w [[settings-category:coach]] ({{label:Settings.AI}}).

Dla PGN, {{label:Import.Online}} i FEN kliknij {{label:Home.Card.ImportGame.Button}}, aby wczytać partię w bieżącej karcie.

Aby zaimportować za pomocą **{{label:Import.FromPhoto}}**:
- Dodaj maksymalnie 4 zdjęcia JPEG, PNG lub WebP albo strony PDF przyciskiem {{label:Scoresheet.Intake.ChoosePhotos}}, {{label:Scoresheet.Intake.PasteFromClipboard}} (lub skrótem Ctrl+V / Cmd+V przy otwartym panelu) albo przeciągając i upuszczając zdjęcia lub pliki PDF na otwarty panel. Wklejanie działa tylko ze zdjęciami. Każda strona PDF liczy się jako jedno zdjęcie; z dłuższego pliku PDF używane są pierwsze strony.
- Wybierz połączenie AI oraz model obsługujący obrazy za pomocą przycisku modelu lub w [[setting:coach-model]] ({{label:Settings.Coach.Model}}).
- Kliknij {{label:Scoresheet.Read.Button}}, aby rozpocząć. Przed pierwszym odczytem na danym połączeniu komunikat {{label:Scoresheet.Notice.Title}} wyjaśnia, że wybrane zdjęcia (w tym nazwiska graczy i wszystko inne zapisane na blankiecie) są wysyłane do tego dostawcy, metadane takie jak lokalizacja aparatu są najpierw usuwane, a żadne inne dane nie są wysyłane.
- Studio sprawdza każde posunięcie zgodnie ze standardowymi zasadami szachów od pozycji początkowej i otwiera partię w nowej niezapisanej karcie analizy z panelem {{label:Board.Tabs.Photo}} obok szachownicy.
- Wątpliwe lub poprawione posunięcia są oznaczone w zapisie jako niepewne. Przejdź przez nie w panelu {{label:Board.Tabs.Photo}} i klikaj {{label:Scoresheet.MarkAsChecked}} po sprawdzeniu każdego posunięcia. Jeśli poprawisz posunięcie w środku partii lub wznowisz po zatrzymaniu, kliknij {{label:Scoresheet.ContinueWithSheet}}, aby odtworzyć kolejne legalne posunięcia z blankietu. Oznaczenia pozostają, dopóki każde posunięcie nie zostanie poprawione lub oznaczone jako sprawdzone, a panel {{label:Board.Tabs.Photo}} można wyciągnąć z kart i umieścić jak pozostałe panele.
- Zapisz partię do pliku lub bazy danych zwykłą metodą zapisu ({{label:Menu.File}} -> {{label:Common.Save}}, przycisk zapisu lub {{label:Board.Database.Save}}).
- Zdjęcia są przechowywane wyłącznie w pamięci (dla maksymalnie 4 otwartych kart) i nie trafiają na dysk; po przeładowaniu lub ponownym uruchomieniu partia i oznaczenia weryfikacji pozostają, a zdjęcie możesz ponownie wyświetlić bez wysyłania przyciskiem {{label:Scoresheet.LoadPhotoAgain}} w panelu {{label:Board.Tabs.Photo}}.
