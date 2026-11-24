---
id: play-against-engine
title: Игра против движка
summary: Настройка партии против локального движка или другого человека, выбор контроля времени и дебютных книг, а также игра с любой позиции.
source: 7c75f4b49a6bdf2c
---

Чтобы начать партию, откройте [[page:new-tab]] и нажмите {{label:Home.Card.PlayChess.Button}}. Вы также можете начать игру с любой позиции на доске анализа, нажав {{label:Board.Action.PlayFromHere}} на панели инструментов доски или щёлкнув правой кнопкой по ходу в нотации.

Перед началом партии:
- Для каждой стороны выберите {{label:Board.Opponent.Human}} (с указанием имени) или {{label:Common.Engine}} (выберите установленный движок из [[page:engines]] и при необходимости настройте его параметры UCI для этой партии).
- Нажмите {{label:Board.Action.ChangeColors}}, чтобы поменять белых и чёрных местами.
- В разделе {{label:Board.Opponent.TimeSettings}} выберите {{label:GoMode.Time}} (указав {{label:GoMode.Time}} и {{label:Board.Opponent.Increment}}) или {{label:Board.Opponent.Unlimited}}. Отметьте {{label:Board.Opponent.SameTimeControl}}, чтобы использовать одинаковые настройки часов для обеих сторон.
- При желании отметьте {{label:Board.Opponent.EnableOpeningBook}}, выберите {{label:Board.Opponent.OpeningBookFile}} и задайте {{label:Board.Opponent.OpeningBookMaxPlies}}.
- Используйте {{label:Board.Action.EditPosition}} на панели инструментов доски перед стартом, если хотите сыграть с произвольной позиции.
- Нажмите {{label:Board.Opponent.StartGame}}, чтобы начать.

Во время партии:
- При игре человека против движка доступны предходы.
- Используйте {{label:Board.Action.TakeBack}} на панели инструментов доски, чтобы вернуть свой последний ход.
- Нажмите {{label:Board.Opponent.Resign}} (или {{label:Board.Opponent.Abort}} в матче движков), чтобы завершить партию.
- В любой момент нажмите {{label:Board.Analysis.Analyze}}, чтобы переключить вкладку в режим анализа, или {{label:Board.Analysis.Logs}}, чтобы просмотреть логи движка.
- После завершения партии нажмите {{label:Home.NewGame}}, чтобы настроить новую игру.
