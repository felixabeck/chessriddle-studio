---
id: repertoires
title: Дебютные репертуары
summary: Создание репертуара, импорт PGN, подбор покрытия по справочной базе, тренировка с интервальным повторением и отслеживание незавершённых вариантов, транспозиций и отметок проверки.
source: db00ec0860d0fa31
---

Репертуары — это PGN-файлы с типом «Репертуар», добавляющие на доску анализа вкладку {{label:Board.Tabs.Practice}}.

Чтобы создать репертуар, откройте [[page:new-tab]] и нажмите {{label:Home.Card.NewRepertoire.Title}} (или создайте файл репертуара в [[page:library]]). Введите {{label:Common.Name}}, выберите {{label:Common.WHITE}} или {{label:Common.BLACK}}, при желании выберите или вставьте PGN в разделе {{label:Home.Card.NewRepertoire.FromPgn}} и нажмите {{label:Common.Create}}. Вы также можете импортировать PGN через {{label:Home.Card.ImportGame.Title}}, включив {{label:Import.SaveToCollection}} и выбрав тип {{label:Files.FileType.Repertoire}}.

Собирайте свой репертуар в разделе {{label:Board.Tabs.Practice}} -> {{label:Board.Practice.Build}}:
- Нажмите {{label:Board.Practice.Build.ImportPgn}}, чтобы объединить PGN-файл или вставленные партии с открытым репертуаром (работает как со справочной базой, так и без неё).
- Укажите {{label:Databases.Settings.ReferenceDatabase}} в [[page:library]], чтобы конструктор показывал частоту ходов и покрытие.
- В пустом репертуаре можно начать с одного из встроенных шаблонов {{label:Board.Practice.Build.Presets}} или ввести ходы на доске.
- Отметьте стартовую позицию вашего репертуара с помощью {{label:Board.Practice.Build.SetAsStart}} (или щёлкните правой кнопкой по ходу в нотации и выберите {{label:Menu.MarkAsStart}}).
- Нажимайте на ходы в списках {{label:Board.Practice.Build.OpponentMoves}} или {{label:Board.Practice.Build.YourResponse}}, чтобы добавлять или просматривать линии. Используйте {{label:Board.Practice.Build.NextGap}} и {{label:Board.Practice.Build.BiggestGap}}, чтобы переходить к непокрытым ответам соперника с числом партий выше порога [[setting:repertoire-depth]].

Тренируйте свой репертуар в разделе {{label:Board.Tabs.Practice}} -> {{label:Board.Practice.Train}}:
- Нажмите {{label:Board.Practice.StartPractice}}, чтобы повторять просроченные и новые позиции по методике интервального повторения, или {{label:Board.Practice.PracticeFullRepertoire}}, чтобы отрабатывать все позиции репертуара.
- Сделайте подготовленный ход на доске. Если вы затрудняетесь после ошибки, нажмите {{label:Board.Practice.ShowMove}}.
- Просматривайте все карточки через {{label:Board.Practice.ShowAll}}, историю через {{label:Board.Practice.ShowLogs}} или сбрасывайте прогресс кнопкой {{label:Common.Reset}}.
- Репертуары с карточками к повторению также отображаются в фильтре {{label:Home.Library.Due}} на странице [[page:new-tab]].
- Настройте систему оценок интервального повторения и лимиты новых карточек в разделе [[settings-category:repertoire]] ([[setting:practice-grading]], [[setting:practice-new-per-session]]).

В нотации на доске анализа:
- Боковая линия длиной всего в один ход выделяется пунктирной рамкой как {{label:Notation.OpenVariation}}, чтобы вы легко находили незавершённые ветки. Нажмите горячую клавишу {{label:Settings.Keybinds.Actions.NEXT_OPEN_VARIATION}}, чтобы перейти к следующей такой ветке.
- Когда позиция встречается в другой ветке этого же репертуара, рядом с ходом появляется значок {{label:Notation.Transposition}}; нажмите на него, чтобы перейти в другую ветку.
- Если импортированный PGN содержит другой ответ за ваш цвет, импортированный ход добавляется как вариант и помечается как {{label:Notation.ReviewMove}}. Щёлкните по ходу правой кнопкой и выберите {{label:Menu.MarkAsReviewed}}, чтобы снять отметку.
