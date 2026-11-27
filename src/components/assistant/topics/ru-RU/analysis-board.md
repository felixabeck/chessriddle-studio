---
id: analysis-board
title: Доска анализа, варианты, комментарии и стрелки
summary: Ввод ходов, редактирование позиций, работа с вариантами, написание комментариев, добавление аннотаций и рисование стрелок на доске.
source: 5901c9f30c3c3295
---

Откройте доску анализа со страницы [[page:new-tab]], нажав {{label:Home.Card.AnalysisBoard.Title}}, или открыв сохранённую партию либо репертуар из [[page:library]].

Делайте ходы перетаскиванием или нажатием на фигуры (настраивается в [[setting:move-method]]). Вы также можете включить [[setting:text-input]] ({{label:Settings.Inputs.TextInput}}), чтобы вводить ходы в алгебраической нотации SAN. Используйте кнопки управления под нотацией, клавиши со стрелками или колесо мыши (если включён параметр [[setting:scroll-moves]]) для перехода по ходам.

Верхняя панель над доской содержит действия для доски:
- {{label:Board.Action.PlayFromHere}}: начать партию с текущей позиции.
- Перевернуть доску (`F`): поменять белых и чёрных местами в нижней части доски.
- Сохранить: появляется, когда в партии есть несохранённые изменения и автосохранение выключено, недоступно (например, для черновика) или завершилось ошибкой.
- {{label:Board.Action.More}}: открывает меню с пунктами {{label:Board.Database.Save}} (сохранить партию в файл библиотеки или в базу данных), {{label:Board.Action.TakeSnapshot}} (сохранить изображение текущей доски) и {{label:Board.Action.EditPosition}} (задать произвольную позицию, расставив фигуры или отредактировав FEN).
- Отмена, повтор и очистка нарисованных стрелок и выделения полей (если выключен параметр [[setting:erase-drawables]]) работают через сочетания клавиш в [[settings-category:keybinds]].

Если сделать другой ход из более ранней позиции, создаётся вариант. Щёлкните правой кнопкой мыши по любому ходу в нотации, чтобы выбрать {{label:Menu.PromoteVariation}}, {{label:Menu.PromoteToMainLine}}, {{label:Menu.CopyVariationPGN}}, {{label:Menu.DeleteMove}}, {{label:Menu.DeleteVariation}}, {{label:Menu.DeleteMovesAfter}}, {{label:Board.Action.PlayFromHere}}, {{label:Notation.AddDiagram}} или {{label:Notation.MarkGameEndHere}}. Используйте кнопку-глаз в заголовке нотации для {{label:Notation.HideMoves}}, а меню {{label:Notation.ViewOptions}} — для переключения {{label:Notation.TableView}}, {{label:Notation.ShowComments}}, {{label:Notation.ShowDiagrams}} и {{label:Notation.ShowVariations}}.

Чтобы добавлять аннотации к ходам и писать комментарии, откройте вкладку {{label:Board.Tabs.Annotate}}. Нажмите на символ оценки хода (или клавиши от 1 до 6), чтобы переключить `!!`, `!`, `!?`, `?!`, `?` или `??`, либо нажмите {{label:Annotate.ShowMore}} для символов оценки позиции. Под символами расположен текстовый редактор для форматированных комментариев и добавления встроенных диаграмм доски.

Чтобы рисовать стрелки и выделять поля, зажмите правую кнопку мыши и проведите по доске (или нажмите правой кнопкой по полю для кружка). Удерживайте клавиши-модификаторы для разных цветов: Shift для {{label:Settings.Drawing.Red}}, Alt для {{label:Settings.Drawing.Blue}}, Shift+Alt для {{label:Settings.Drawing.Yellow}}, Ctrl (Cmd на macOS) для {{label:Settings.Drawing.Orange}} и Ctrl+Alt (Cmd+Alt на macOS) для {{label:Settings.Drawing.Cyan}}. Полный список настроек рисования смотрите в разделе [[settings-category:keybinds]].

На вкладке {{label:Board.Tabs.Info}} отображаются заголовки партии, FEN, текст PGN и статистика дерева вариантов, а также можно переключаться между партиями в многопартийном PGN-файле.

Чтобы настроить расположение областей на доске анализа, перетащите вкладку панели ({{label:Board.Tabs.Analysis}}, {{label:Board.Analysis.Report}}, {{label:Board.Tabs.Database}}, {{label:Board.Tabs.Annotate}}, {{label:Board.Tabs.Coach}} или {{label:Board.Tabs.Info}}) или ручку из шести точек на карточке движка или воспользуйтесь кнопками-ручками на панели вкладок, в заголовке нотации или в заголовке области панели, чтобы разместить области рядом, сверху или снизу от другой области с предпросмотром или с клавиатуры. Чтобы панель располагалась над двумя областями (например, {{label:Board.Tabs.Database}} над нотацией и вкладками), сначала поместите панель над одной из них, а затем переместите другую рядом. Нажмите {{label:Board.Area.ReturnToTabs}} (или {{label:Board.Area.ReturnToEngines}} для окна движка) либо перетащите область обратно на список вкладок, чтобы вернуть её.

Вкладки репертуара, партий и подготовки к сопернику сохраняют каждая свой собственный активный макет. Включены три стандартных макета ({{label:Board.Layout.Preset.Repertoire}}, {{label:Board.Layout.Preset.GameReview}} и {{label:Board.Layout.Preset.Preparation}}), а также вы можете сохранять собственные макеты, переключаться между ними, переименовывать и удалять сохранённые макеты через {{label:Board.Action.More}} ({{label:Board.Layout.SaveAs}} и {{label:Board.Layout.Manage}}) или через {{label:Menu.View}} ({{label:Board.Layout.SaveAs}} и {{label:Board.Layout.LayoutsMenu}}). Используйте [[setting:board-layout]] ({{label:Settings.BoardLayout.Reset}}), чтобы восстановить стандартные макеты для всех трёх типов вкладок, сохранив ваши пользовательские макеты.

Чтобы скрыть вкладки, например когда каждая используемая панель показана как отдельная область, нажмите {{label:Board.Area.HideTabs}} под маркером в конце панели вкладок; соседние области займут их место. Вкладки сохраняют положение и размер: верните их кнопкой {{label:Board.Arrange.ShowTabs}}, которая появляется в заголовке нотации, пока вкладки скрыты, сочетанием клавиш вкладки или созданием отчёта. Панель, возвращённая при скрытых вкладках, попадает в скрытые вкладки. Пока вкладки скрыты, команда {{label:Board.Arrange.ShowTabs}} есть также в {{label:Board.Action.More}} и в меню {{label:Menu.View}}.
