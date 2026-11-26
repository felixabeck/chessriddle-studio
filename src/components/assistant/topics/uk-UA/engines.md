---
id: engines
title: Шахові рушії та панель аналізу
summary: Встановлення й додавання локальних та хмарних рушіїв, налаштування параметрів UCI і живий аналіз на дошці.
source: f40b5fdf8e5c15a0
---

Керуйте своїми шаховими рушіями на сторінці [[page:engines]] ({{label:SideBar.Engines}}).

Щоб додати рушій, натисніть {{label:Common.AddNew}} на сторінці [[page:engines]], щоб відкрити {{label:Engines.Add.Title}}:
- {{label:Common.Download}}: установити попередньо налаштований рушій (наприклад, Stockfish) із каталогу за допомогою {{label:Common.Install}}.
- {{label:Engines.Add.Cloud}}: додати онлайн-рушії аналізу (ChessDB або Lichess Cloud) через {{label:Common.Add}}.
- {{label:Common.Local}}: зареєструвати виконуваний файл UCI-рушія, що вже є на вашому комп’ютері.

Виберіть будь-який рушій на сторінці [[page:engines]], щоб налаштувати його. Для локальних рушіїв можна редагувати загальні відомості, задавати типові параметри UCI (наприклад, Threads, Hash і MultiPV), підключати файли ресурсів на кшталт таблиць Syzygy, натискати {{label:Engines.Settings.Reset}} для повернення до типових значень, {{label:Common.Duplicate}} для копіювання конфігурації або {{label:Common.Remove}} для видалення. Для хмарних рушіїв можна змінювати назву та {{label:Engines.Settings.NumOfLines}}.

На дошці аналізу відкрийте вкладку {{label:Board.Tabs.Analysis}}:
- Натисніть {{label:Board.Analysis.SelectEngines}}, щоб вибрати, які встановлені рушії завантажити в панель, або {{label:Board.Analysis.ManageEngines}}, щоб перейти на [[page:engines]].
- Натисніть {{label:Board.Analysis.EnableEngine}} або {{label:Board.Analysis.DisableEngine}} на картці рушія, щоб запустити чи призупинити аналіз, або скористайтеся {{label:Board.Analysis.EnableAllEngines}} у нижньому рядку.
- Натисніть {{label:Board.Analysis.CheckThreat}} (або комбінацію клавіш {{label:Settings.Keybinds.Actions.TOGGLE_THREAT_MODE}}), щоб проаналізувати загрозу суперника.
- Виберіть від 1 до 5 ліній на картці або натисніть {{label:Board.Analysis.EngineSettings}}, щоб налаштувати параметри для вкладки, як-от межу пошуку та опції UCI.
- Перетягніть картку рушія за ручку із шести крапок ({{label:Board.Analysis.ReorderEngine}}), щоб змінити порядок або винести її на дошку як окреме вікно, чи натисніть на ручку для переміщення з клавіатури. Натисніть {{label:Board.Area.ReturnToEngines}} або перетягніть вікно назад на список вкладок (або заголовок {{label:Board.Tabs.Analysis}}), щоб повернути його.
- Якщо рушій дав збій, натисніть {{label:Board.Analysis.Logs}} поруч із {{label:Board.Analysis.RetryEngine}}, щоб переглянути його обмін через UCI. Для робочого рушія та сама кнопка є в {{label:Board.Analysis.EngineSettings}} на його картці.

Керуйте стрілками рушія на дошці за допомогою [[setting:arrows]] ({{label:Settings.Arrows}}). Локальні рушії зберігаються в теці, заданій у [[setting:engines-directory]].
