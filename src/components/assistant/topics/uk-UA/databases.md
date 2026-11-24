---
id: databases
title: Бази даних, оглядач, пошук позицій, гравці та турніри
summary: Додавання або завантаження баз партій, вибір довідкової бази, пошук позицій в оглядачі та перегляд партій, гравців і турнірів.
source: 48c72137fadc1768
---

Бази даних містяться в [[page:library]] ({{label:SideBar.Library}}) поряд із вашими файлами PGN і зберігаються в [[setting:databases-directory]].

Щоб додати базу даних, відкрийте [[page:library]] та натисніть {{label:Library.AddDatabase}}:
- {{label:Databases.Add.Web}}: завантажити підготовлені бази партій із каталогу.
- {{label:Common.Local}}: вибрати локальний файл PGN (зокрема `.pgn.zst` або `.pgn.bz2`), ввести {{label:Common.Name}}, за бажанням додати {{label:Common.Description}} та натиснути {{label:Databases.Add.Convert}}.

Виберіть базу даних у [[page:library]], щоб керувати нею:
- Позначте {{label:Databases.Settings.ReferenceDatabase}}, щоб зробити її типовою довідковою базою для оглядача, конструктора репертуару, новинок у звіті про партію та Coach.
- Позначте {{label:Databases.Settings.Indexed}}, щоб створити або видалити пошукові індекси для швидшого пошуку.
- Натисніть {{label:Databases.Settings.Explore}}, щоб відкрити табличний перегляд бази даних.
- У розділі {{label:Databases.Settings.Actions}} скористайтеся {{label:Databases.Settings.AddGames}} для додавання файлів PGN, {{label:Databases.Settings.ExportPGN}} для експорту в PGN або {{label:Common.Delete}} для видалення бази.
- У розділі {{label:Databases.Settings.AdvancedTools}} використовуйте {{label:Databases.Settings.MergePlayers}} для об’єднання дубльованих записів гравців або {{label:Databases.Settings.RemoveDup}} і {{label:Databases.Settings.RemoveEmpty}} для очищення партій.

У табличному перегляді бази даних перемикайтеся між {{label:Common.Games}}, {{label:Databases.Card.Players}} та {{label:Databases.Settings.Events}} (турнірами):
- Шукайте та сортуйте партії, переглядайте партію чи відкривайте її на дошці аналізу.
- У розділі {{label:Databases.Card.Players}} виберіть гравця, щоб переглянути {{label:Home.Personal.Overview}}, {{label:Home.Personal.Ratings}} та {{label:Home.Personal.Openings}} (інтерактивне дерево дебютів із кнопкою {{label:Databases.OpeningTree.Prepare}}), а також інформацію ФІДЕ через {{label:Databases.FIDE.Info}}.
- У розділі {{label:Databases.Settings.Events}} шукайте турніри за назвою та сортуйте за датою, кількістю гравців, партій або середнім рейтингом Ело.

На дошці аналізу відкрийте вкладку {{label:Board.Tabs.Database}}, щоб скористатися оглядачем дебютів:
- Перемикайтеся між {{label:Board.Database.Local}}, {{label:Board.Database.LichessAll}} і {{label:Board.Database.LichessMaster}} (онлайн-оглядачі Lichess вимагають авторизованого облікового запису Lichess на сторінці [[page:accounts]]).
- Перемикайтеся між {{label:Board.Database.Stats}} (статистика ходів) і {{label:Board.Database.Games}} (відповідні партії).
- Для локальних баз даних натисніть {{label:Board.Database.Compare}}, щоб порівняти дві бази поруч, або відкрийте {{label:Board.Database.Local.Position}} для перемикання між пошуком позиції {{label:Board.Database.Local.Exact}} і {{label:Board.Database.Local.Partial}} (включно з {{label:Board.Database.Local.SimilarStructure}} для пошуку за пішаковою структурою та {{label:Fen.Empty}} для довільних шаблонів).
- Використовуйте {{label:Board.Database.Pin}}, щоб закріпити оглядач над чи під дошкою або нотацією, та {{label:Board.Database.Unpin}}, щоб повернути його до вкладок.
