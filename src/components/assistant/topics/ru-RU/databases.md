---
id: databases
title: Базы данных, обозреватель, поиск позиций, игроки и турниры
summary: Добавление и загрузка баз партий, выбор справочной базы, поиск позиций в обозревателе, а также просмотр партий, игроков и турниров.
source: 526f05192ead329f
---

Базы данных находятся в [[page:library]] ({{label:SideBar.Library}}) рядом с вашими PGN-файлами и хранятся в каталоге [[setting:databases-directory]].

Чтобы добавить базу данных, откройте [[page:library]] и нажмите {{label:Library.AddDatabase}}:
- {{label:Databases.Add.Web}}: загрузить готовые базы партий из каталога.
- {{label:Common.Local}}: выбрать локальный PGN-файл (включая `.pgn.zst` или `.pgn.bz2`), указать {{label:Common.Name}}, при желании добавить {{label:Common.Description}} и нажать {{label:Databases.Add.Convert}}.

Выберите базу данных в [[page:library]], чтобы управлять ею:
- Отметьте {{label:Databases.Settings.ReferenceDatabase}}, чтобы сделать её справочной базой по умолчанию для обозревателя, конструктора репертуара, новинок в отчёте по партии и Coach.
- Отметьте {{label:Databases.Settings.Indexed}}, чтобы создать или удалить поисковые индексы для ускорения поиска.
- Нажмите {{label:Databases.Settings.Explore}}, чтобы открыть табличный просмотр базы данных.
- В разделе {{label:Databases.Settings.Actions}} используйте {{label:Databases.Settings.AddGames}} для добавления PGN-файлов, {{label:Databases.Settings.ExportPGN}} для экспорта в PGN или {{label:Common.Delete}} для удаления базы.
- В разделе {{label:Databases.Settings.AdvancedTools}} используйте {{label:Databases.Settings.MergePlayers}} для объединения дублирующихся записей игроков, а также {{label:Databases.Settings.RemoveDup}} и {{label:Databases.Settings.RemoveEmpty}} для очистки партий.

В табличном просмотре базы данных переключайтесь между разделами {{label:Common.Games}}, {{label:Databases.Card.Players}} и {{label:Databases.Settings.Events}} (турниры):
- Ищите и сортируйте партии, просматривайте партию в предпросмотре (предпросмотр может скрыть ходы кнопкой-глазом, [[setting:hide-preview-moves]]) или открывайте её на доске анализа.
- В разделе {{label:Databases.Card.Players}} выберите игрока, чтобы увидеть вкладки {{label:Home.Personal.Overview}}, {{label:Home.Personal.Ratings}} и {{label:Home.Personal.Openings}} (интерактивное дерево дебютов с кнопкой {{label:Databases.OpeningTree.Prepare}}), а также данные ФИДЕ через {{label:Databases.FIDE.Info}}.
- В разделе {{label:Databases.Settings.Events}} ищите турниры по названию и сортируйте по дате, числу игроков, количеству партий или среднему рейтингу Эло.

На карточке игрока откройте вкладку {{label:Home.Personal.Preparation}}, чтобы сравнить его партии с вашими файлами репертуара:
- Выберите цвет соперника, период {{label:Databases.OpeningTree.Since}} и (при привязанных онлайн-аккаунтах) {{label:Databases.OpeningTree.OverTheBoard}}, {{label:Databases.OpeningTree.Online}} или {{label:Databases.Preparation.Both}}. Нажмите {{label:Databases.Preparation.Refresh}}, чтобы повторить сравнение.
- Увеличьте {{label:Databases.Preparation.MinGames}}, чтобы скрыть варианты и пробелы, которые соперник играл лишь изредка; файл свернёт эти варианты, а тренировка их пропустит.
- Просмотрите варианты, которые играет соперник, и {{label:Databases.Preparation.GapsTitle}}. Нажмите любую строку, чтобы открыть свой файл репертуара в этой позиции со скрытыми остальными ответвлениями; в заголовке нотации переключайтесь между {{label:Notation.PreparationOpponentLines}} и {{label:Notation.PreparationAllLines}}.
- Нажмите {{label:Databases.Preparation.TrainLines}}, чтобы запустить тренировку на время по этим вариантам; ваши ответы обновляют обычное расписание интервальных повторений.
- Чтобы подготовиться к сопернику, у которого есть только аккаунт на Lichess или Chess.com, нажмите {{label:Library.OnlineOpponent}} в [[page:library]], найдите его аккаунт, загрузите партии и откройте карточку сразу на вкладке {{label:Home.Personal.Preparation}} (повторный ввод того же аккаунта откроет её без новой загрузки).

На доске анализа откройте вкладку {{label:Board.Tabs.Database}}, чтобы использовать дебютный обозреватель:
- Выберите {{label:Board.Database.LichessAll}} или {{label:Board.Database.LichessMaster}} в меню источников и в {{label:Board.Database.Compare}} (онлайн-обозреватели Lichess требуют авторизованного аккаунта Lichess на странице [[page:accounts]]).
- {{label:Board.Database.Stats}} (статистика ходов) отображается сверху, а {{label:Board.Database.Games}} (подходящие партии) — снизу; перетащите разделитель между ними, чтобы распределить высоту. Столбец {{label:Board.Area.Notation}} показывает ходы от позиции на доске, выделяя следующий ход полужирным.
- Нажмите {{label:Board.Database.Compare}}, чтобы сравнить два источника рядом, или откройте {{label:Board.Database.Local.Position}} для переключения между режимами поиска позиции {{label:Board.Database.Local.Exact}} и {{label:Board.Database.Local.Partial}} (включая {{label:Board.Database.Local.SimilarStructure}} для поиска по пешечной структуре и {{label:Fen.Empty}} для произвольных шаблонов).
- Вы также можете отобразить {{label:Board.Tabs.Database}} как отдельную область на доске анализа и использовать {{label:Board.Area.ReturnToTabs}}, чтобы вернуть её во вкладки.
- Когда кнопка {{label:Databases.OpeningTree.Prepare}} открывает доску для игрока базы данных, обозреватель начинает со справочной базы как дополнительного столбца рядом с партиями соперника; нажмите {{label:Board.Database.RemoveReference}}, чтобы скрыть столбец, или {{label:Board.Database.AddColumn}}, чтобы добавить ещё один.
