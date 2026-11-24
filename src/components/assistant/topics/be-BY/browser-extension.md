---
id: browser-extension
title: Пашырэнне для браўзера і спасылкі на партыі
summary: Адкрывайце партыі Lichess і Chess.com наўпрост у Studio з дапамогай спасылак chessriddle-studio://.
source: 7059f7f7afa1559d
---

ChessRiddle Studio апрацоўвае спасылкі на партыі `chessriddle-studio://`, дасланыя пашырэннем для браўзера або вашай аперацыйнай сістэмай.

Калі адкрываецца спасылка `chessriddle-studio://import?url=<game URL>` для партыі Lichess або Chess.com:
- Studio спампоўвае PGN партыі з Lichess або Chess.com.
- Партыя адкрываецца ў новай укладцы аналізу, а акно пераключаецца на дошку.
- Пакуль партыя загружаецца, апавяшчэнне паказвае прагрэс і паведамляе пра памылку, калі партыю не ўдалося атрымаць.

На macOS і Windows усталёўшчык аўтаматычна рэгіструе схему URL `chessriddle-studio://`. У зборках AppImage для Linux Studio рэгіструе апрацоўшчык працоўнага стала для `chessriddle-studio://` пры запуску, каб браўзер мог перадаваць спасылкі праграме.

Вы таксама можаце імпартаваць любы URL партыі Lichess або Chess.com уручную без пашырэння: адкрыйце [[page:new-tab]], націсніце {{label:Home.Card.ImportGame.Button}}, выберыце {{label:Import.Online}} і ўстаўце {{label:Import.GameURL}}.
