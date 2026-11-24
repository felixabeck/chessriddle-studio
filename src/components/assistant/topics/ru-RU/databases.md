---
id: databases
title: Базы данных, обозреватель, поиск позиций, игроки и турниры
summary: Добавление и загрузка баз партий, выбор справочной базы, поиск позиций в обозревателе, а также просмотр партий, игроков и турниров.
source: 48c72137fadc1768
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
- Ищите и сортируйте партии, просматривайте партию в предпросмотре или открывайте её на доске анализа.
- В разделе {{label:Databases.Card.Players}} выберите игрока, чтобы увидеть вкладки {{label:Home.Personal.Overview}}, {{label:Home.Personal.Ratings}} и {{label:Home.Personal.Openings}} (интерактивное дерево дебютов с кнопкой {{label:Databases.OpeningTree.Prepare}}), а также данные ФИДЕ через {{label:Databases.FIDE.Info}}.
- В разделе {{label:Databases.Settings.Events}} ищите турниры по названию и сортируйте по дате, числу игроков, количеству партий или среднему рейтингу Эло.

На доске анализа откройте вкладку {{label:Board.Tabs.Database}}, чтобы использовать дебютный обозреватель:
- Переключайтесь между {{label:Board.Database.Local}}, {{label:Board.Database.LichessAll}} и {{label:Board.Database.LichessMaster}} (онлайн-обозреватели Lichess требуют авторизованного аккаунта Lichess на странице [[page:accounts]]).
- Переключайтесь между {{label:Board.Database.Stats}} (статистика ходов) и {{label:Board.Database.Games}} (подходящие партии).
- Для локальных баз данных нажмите {{label:Board.Database.Compare}}, чтобы сравнить две базы рядом, или откройте {{label:Board.Database.Local.Position}} для переключения между режимами поиска позиции {{label:Board.Database.Local.Exact}} и {{label:Board.Database.Local.Partial}} (включая {{label:Board.Database.Local.SimilarStructure}} для поиска по пешечной структуре и {{label:Fen.Empty}} для произвольных шаблонов).
- Используйте {{label:Board.Database.Pin}}, чтобы закрепить обозреватель над или под доской либо нотацией, и {{label:Board.Database.Unpin}}, чтобы вернуть его во вкладки.
