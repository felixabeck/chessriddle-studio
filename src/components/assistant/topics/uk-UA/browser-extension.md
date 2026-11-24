---
id: browser-extension
title: Розширення для браузера та посилання на партії
summary: Відкривайте партії Lichess і Chess.com безпосередньо в Studio за допомогою посилань chessriddle-studio://.
source: 7059f7f7afa1559d
---

ChessRiddle Studio обробляє посилання на партії `chessriddle-studio://`, надіслані розширенням браузера або вашою операційною системою.

Коли відкривається посилання `chessriddle-studio://import?url=<game URL>` для партії Lichess або Chess.com:
- Studio завантажує PGN партії з Lichess або Chess.com.
- Партія відкривається в новій вкладці аналізу, а вікно перемикається на дошку.
- Поки партія завантажується, сповіщення показує перебіг і повідомляє про помилку, якщо партію не вдається отримати.

У macOS і Windows інсталятор автоматично реєструє схему URL `chessriddle-studio://`. У збірках AppImage для Linux Studio реєструє обробник робочого столу для `chessriddle-studio://` під час запуску, щоб браузер міг передавати посилання програмі.

Ви також можете імпортувати будь-який URL партії Lichess або Chess.com вручну без розширення: відкрийте [[page:new-tab]], натисніть {{label:Home.Card.ImportGame.Button}}, виберіть {{label:Import.Online}} і вставте {{label:Import.GameURL}}.
