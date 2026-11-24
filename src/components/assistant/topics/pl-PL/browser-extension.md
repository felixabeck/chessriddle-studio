---
id: browser-extension
title: Rozszerzenie przeglądarki i linki do partii
summary: Otwieraj partie z Lichess i Chess.com bezpośrednio w Studio za pomocą linków chessriddle-studio://.
source: 7059f7f7afa1559d
---

ChessRiddle Studio obsługuje linki do partii `chessriddle-studio://` wysyłane przez rozszerzenie przeglądarki lub system operacyjny.

Po otwarciu linku `chessriddle-studio://import?url=<game URL>` dla partii z Lichess lub Chess.com:
- Studio pobiera PGN partii z Lichess lub Chess.com.
- Partia otwiera się w nowej karcie analizy i przenosi okno na szachownicę.
- Podczas wczytywania partii powiadomienie pokazuje postęp i zgłasza błąd, jeśli nie uda się pobrać partii.

W systemach macOS i Windows instalator rejestruje schemat URL `chessriddle-studio://` automatycznie. W kompilacjach Linux AppImage Studio rejestruje przy uruchomieniu obsługę pulpitu dla `chessriddle-studio://`, dzięki czemu przeglądarka może przekazywać linki do aplikacji.

Możesz też ręcznie zaimportować dowolny adres URL partii z Lichess lub Chess.com bez rozszerzenia: otwórz [[page:new-tab]], kliknij {{label:Home.Card.ImportGame.Button}}, wybierz {{label:Import.Online}} i wklej {{label:Import.GameURL}}.
