---
id: databases
title: Бази даних, оглядач, пошук позицій, гравці та турніри
summary: Додавання або завантаження баз партій, вибір довідкової бази, пошук позицій в оглядачі та перегляд партій, гравців і турнірів.
source: 79c93eb50f572f36
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
- Шукайте та сортуйте партії, переглядайте партію (попередній перегляд може приховати ходи кнопкою-оком, [[setting:hide-preview-moves]]) чи відкривайте її на дошці аналізу.
- У розділі {{label:Databases.Card.Players}} виберіть гравця, щоб переглянути {{label:Home.Personal.Overview}}, {{label:Home.Personal.Ratings}} та {{label:Home.Personal.Openings}} (інтерактивне дерево дебютів), а також інформацію ФІДЕ через {{label:Databases.FIDE.Info}}. Кнопка {{label:Databases.OpeningTree.Prepare}} у вкладці {{label:Home.Personal.Openings}} переносить вибраний варіант, колір і період {{label:Databases.OpeningTree.Since}}.
- У розділі {{label:Databases.Settings.Events}} шукайте турніри за назвою та сортуйте за датою, кількістю гравців, партій або середнім рейтингом Ело.

На картці гравця відкрийте вкладку {{label:Home.Personal.Preparation}}, щоб порівняти його партії з вашими файлами репертуару:
- Виберіть колір суперника, період {{label:Databases.OpeningTree.Since}} та (за наявності прив’язаних онлайн-акаунтів) {{label:Databases.OpeningTree.OverTheBoard}}, {{label:Databases.OpeningTree.Online}} або {{label:Databases.Preparation.Both}}. Натисніть {{label:Databases.Preparation.Refresh}}, щоб запустити порівняння знову, або натисніть {{label:Databases.OpeningTree.Prepare}}, щоб відкрити початкову позицію на дошці аналізу з кольором і періодом {{label:Databases.OpeningTree.Since}} цієї вкладки.
- Збільште {{label:Databases.Preparation.MinGames}}, щоб приховати варіанти й прогалини, які суперник грав лише зрідка; файл згорне ці варіанти, а тренування їх пропустить.
- Перегляньте варіанти, які грає суперник, та {{label:Databases.Preparation.GapsTitle}}. Натисніть будь-який рядок, щоб відкрити ваш файл репертуару в цій позиції з прихованими іншими відгалуженнями; у заголовку нотації перемикайтеся між {{label:Notation.PreparationOpponentLines}} і {{label:Notation.PreparationAllLines}}.
- Натисніть {{label:Databases.Preparation.TrainLines}}, щоб запустити тренування на час за цими варіантами; ваші відповіді оновлюють звичайний розклад інтервального повторення.
- Щоб підготуватися до суперника, який має лише акаунт на Lichess або Chess.com, натисніть {{label:Library.OnlineOpponent}} у [[page:library]], знайдіть його акаунт, завантажте партії та відкрийте картку відразу на вкладці {{label:Home.Personal.Preparation}} (повторне введення того самого акаунта відкриє її без повторного завантаження).

На дошці аналізу відкрийте вкладку {{label:Board.Tabs.Database}}, щоб скористатися оглядачем дебютів:
- Виберіть {{label:Board.Database.LichessAll}} або {{label:Board.Database.LichessMaster}} у меню джерел і в {{label:Board.Database.Compare}} (онлайн-оглядачі Lichess вимагають авторизованого облікового запису Lichess на сторінці [[page:accounts]]).
- {{label:Board.Database.Stats}} (статистика ходів) відображається вгорі, а {{label:Board.Database.Games}} (відповідні партії) — унизу; поки показані обидві області, перетягніть роздільник між ними, щоб розподілити висоту. Використовуйте {{label:Board.Database.HideGames}} або {{label:Board.Database.ShowGames}}, щоб приховати чи показати список партій, і значок шестерні налаштувань, щоб розгорнути чи згорнути елементи керування джерелами — обидві кнопки розміщені в заголовку панелі, коли вона є окремою плиткою, і у верхньому рядку керування, коли вона у вкладках. Стовпець {{label:Board.Area.Notation}} показує ходи від позиції на дошці, виділяючи наступний хід напівжирним.
- Натисніть {{label:Board.Database.Compare}}, щоб порівняти два джерела поруч, або відкрийте {{label:Board.Database.Local.Position}} для перемикання між пошуком позиції {{label:Board.Database.Local.Exact}} і {{label:Board.Database.Local.Partial}} (включно з {{label:Board.Database.Local.SimilarStructure}} для пошуку за пішаковою структурою та {{label:Fen.Empty}} для довільних шаблонів).
- Ви також можете показати {{label:Board.Tabs.Database}} як окрему область на дошці аналізу та скористатися {{label:Board.Area.ReturnToTabs}}, щоб повернути її до вкладок.
- Коли кнопка {{label:Databases.OpeningTree.Prepare}} відкриває дошку для гравця з бази даних, оглядач починає з довідкової бази як додаткового стовпця поруч із партіями суперника; натисніть {{label:Board.Database.RemoveReference}}, щоб приховати стовпець, або {{label:Board.Database.AddColumn}}, щоб додати ще один.
