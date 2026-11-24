---
id: library-and-files
title: Файлы и библиотека
summary: Настройка рабочей папки, создание и организация PGN-файлов, открытие и сохранение партий, а также работа с корзиной.
source: 984717132dfb14c1
---

Раздел [[page:library]] ({{label:SideBar.Library}}) объединяет ваши рабочие PGN-файлы (партии, репертуары, турниры, задачи и другие файлы) и базы данных партий.

Перед созданием файлов выберите рабочую папку. Если папка ещё не задана, нажмите {{label:Files.ChooseFolder}} на странице [[page:library]] или настройте [[setting:files-directory]] ({{label:Settings.Directories.Files}}) в разделе [[settings-category:directories]].

На странице [[page:library]]:
- Нажмите {{label:Files.CreateFile}}, чтобы создать новый PGN-файл, или {{label:Files.CreateFolder}}, чтобы упорядочить файлы по подпапкам.
- Используйте поле {{label:Common.Search}} и выпадающий список {{label:Files.FileType}} для фильтрации по типу файла или по пункту {{label:Library.GamesDatabase}}.
- Выберите файл, чтобы просмотреть его партии, открыть его на доске анализа или использовать действия {{label:Files.Rename}}, {{label:Files.Move}} и {{label:Files.Trash}}.

При редактировании файла на доске анализа:
- Сохраняйте изменения кнопкой сохранения на панели инструментов доски, через {{label:Menu.File}} -> {{label:Common.Save}} или с помощью сочетания клавиш {{label:Settings.Keybinds.Actions.SAVE_FILE}}.
- Включите [[setting:auto-save]] ({{label:Settings.AutoSave}}), чтобы правки в открытых файлах сохранялись автоматически.
- Выберите {{label:Menu.File}} -> {{label:Board.Database.Save}} (или кнопку {{label:Board.Database.Save}} на панели инструментов), чтобы сохранить текущую партию в другой файл библиотеки или базу данных.

Перемещение файла в {{label:Files.Trash}} не удаляет его безвозвратно сразу. Вы можете сразу нажать {{label:Common.Undo}} во всплывающем уведомлении или прокрутить до раздела {{label:Files.Trash}} в [[page:library]], чтобы выполнить {{label:Files.Restore}}, {{label:Files.DeletePermanently}} или {{label:Files.EmptyTrash}}.
