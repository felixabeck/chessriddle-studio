---
id: library-and-files
title: Файлы и библиотека
summary: Настройка рабочей папки, создание и организация PGN-файлов, открытие и сохранение партий, а также работа с корзиной.
source: 4417697a9a5cd025
---

Раздел [[page:library]] ({{label:SideBar.Library}}) объединяет ваши рабочие PGN-файлы (партии, репертуары, турниры, задачи и другие файлы) и базы данных партий.

Перед созданием файлов выберите рабочую папку. Если папка ещё не задана, нажмите {{label:Files.ChooseFolder}} на странице [[page:library]] или настройте [[setting:files-directory]] ({{label:Settings.Directories.Files}}) в разделе [[settings-category:directories]].

На странице [[page:library]]:
- Нажмите {{label:Files.CreateFile}}, чтобы создать новый PGN-файл, или {{label:Files.CreateFolder}}, чтобы упорядочить файлы по подпапкам.
- Используйте поле {{label:Common.Search}} и выпадающий список {{label:Files.FileType}} для фильтрации по типу файла или по пункту {{label:Library.GamesDatabase}}.
- Выберите файл, чтобы просмотреть его партии (предпросмотр может скрыть ходы кнопкой-глазом, [[setting:hide-preview-moves]]), открыть его на доске анализа или использовать действия {{label:Files.Rename}}, {{label:Files.Move}} и {{label:Files.Trash}}.

При редактировании файла на доске анализа:
- Сохраняйте изменения кнопкой сохранения на верхней панели доски (отображается, когда автосохранение выключено, недоступно или завершилось ошибкой), через {{label:Menu.File}} -> {{label:Common.Save}} или с помощью сочетания клавиш {{label:Settings.Keybinds.Actions.SAVE_FILE}}.
- Включите [[setting:auto-save]] ({{label:Settings.AutoSave}}), чтобы правки в открытых файлах сохранялись автоматически.
- Выберите {{label:Menu.File}} -> {{label:Board.Database.Save}} (или {{label:Board.Action.More}} -> {{label:Board.Database.Save}} на верхней панели доски), чтобы сохранить текущую партию в другой файл библиотеки или базу данных.

Перемещение файла в {{label:Files.Trash}} не удаляет его безвозвратно сразу. Вы можете сразу нажать {{label:Common.Undo}} во всплывающем уведомлении или прокрутить до раздела {{label:Files.Trash}} в [[page:library]], чтобы выполнить {{label:Files.Restore}}, {{label:Files.DeletePermanently}} или {{label:Files.EmptyTrash}}.

Когда ваш аккаунт ChessRiddle подключён, нажмите {{label:Library.Sync.Action}} на странице [[page:library]], чтобы синхронизировать выбранные PGN-файлы с вашей личной библиотекой на ChessRiddle (до 100 файлов, 5 МБ и 40 000 ходов на файл). Правки, переименования, снятие выбора и удаления обновляются автоматически; загруженные истории партий и базы данных партий остаются локально. При выключении синхронизации можно оставить или удалить синхронизированные файлы на ChessRiddle.
