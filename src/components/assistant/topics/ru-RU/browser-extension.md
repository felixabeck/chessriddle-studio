---
id: browser-extension
title: Расширение для браузера и ссылки на партии
summary: Открытие партий Lichess и Chess.com напрямую в Studio по ссылкам chessriddle-studio://.
source: 7059f7f7afa1559d
---

ChessRiddle Studio обрабатывает ссылки на партии `chessriddle-studio://`, отправленные расширением для браузера или операционной системой.

При открытии ссылки `chessriddle-studio://import?url=<game URL>` для партии Lichess или Chess.com:
- Studio загружает PGN партии с Lichess или Chess.com.
- Партия открывается на новой вкладке анализа, а окно переключается на доску.
- Пока партия загружается, уведомление показывает ход загрузки и сообщает об ошибке, если партию не удалось получить.

На macOS и Windows установщик автоматически регистрирует схему URL `chessriddle-studio://`. В сборках AppImage для Linux Studio регистрирует обработчик рабочего стола для `chessriddle-studio://` при запуске, чтобы браузер мог передавать ссылки приложению.

Вы также можете импортировать любой URL партии Lichess или Chess.com вручную без расширения: откройте [[page:new-tab]], нажмите {{label:Home.Card.ImportGame.Button}}, выберите {{label:Import.Online}} и вставьте {{label:Import.GameURL}}.
