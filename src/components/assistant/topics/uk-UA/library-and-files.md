---
id: library-and-files
title: Файли та бібліотека
summary: Налаштування робочої теки, створення й упорядкування файлів PGN, відкриття та збереження партій і робота з кошиком.
source: 4417697a9a5cd025
---

Розділ [[page:library]] ({{label:SideBar.Library}}) об’єднує ваші робочі файли PGN (партії, репертуари, турніри, задачі та інші файли) і бази даних партій.

Перед створенням файлів виберіть робочу теку. Якщо теку ще не вибрано, натисніть {{label:Files.ChooseFolder}} на сторінці [[page:library]] або налаштуйте [[setting:files-directory]] ({{label:Settings.Directories.Files}}) у [[settings-category:directories]].

На сторінці [[page:library]]:
- Натисніть {{label:Files.CreateFile}}, щоб створити новий файл PGN, або {{label:Files.CreateFolder}}, щоб упорядкувати файли за підтеками.
- Використовуйте поле {{label:Common.Search}} та випадний список {{label:Files.FileType}} для фільтрації за типом файлу або за пунктом {{label:Library.GamesDatabase}}.
- Виберіть файл, щоб переглянути його партії (попередній перегляд може приховати ходи кнопкою-оком, [[setting:hide-preview-moves]]), відкрити на дошці аналізу або скористатися діями {{label:Files.Rename}}, {{label:Files.Move}} і {{label:Files.Trash}}.

Під час редагування файлу на дошці аналізу:
- Зберігайте зміни кнопкою збереження на верхній панелі дошки (з’являється, коли автозбереження вимкнено, недоступне або завершилося помилкою), через {{label:Menu.File}} -> {{label:Common.Save}} або комбінацією клавіш {{label:Settings.Keybinds.Actions.SAVE_FILE}}.
- Увімкніть [[setting:auto-save]] ({{label:Settings.AutoSave}}), щоб зміни у відкритих файлах зберігалися автоматично.
- Використовуйте {{label:Menu.File}} -> {{label:Board.Database.Save}} (або {{label:Board.Action.More}} -> {{label:Board.Database.Save}} на верхній панелі дошки), щоб зберегти поточну партію в інший файл бібліотеки чи базу даних.

Переміщення файлу в {{label:Files.Trash}} не видаляє його назавжди одразу. Ви можете негайно натиснути {{label:Common.Undo}} у сповіщенні або прокрутити до розділу {{label:Files.Trash}} у [[page:library]], щоб виконати {{label:Files.Restore}}, {{label:Files.DeletePermanently}} або {{label:Files.EmptyTrash}}.

Коли ваш обліковий запис ChessRiddle підключено, натисніть {{label:Library.Sync.Action}} на сторінці [[page:library]], щоб синхронізувати вибрані файли PGN із вашою приватною бібліотекою на ChessRiddle (до 100 файлів, 5 МБ і 40 000 ходів на файл). Редагування, перейменування, зняття вибору та видалення оновлюються автоматично; завантажені історії партій і бази даних партій залишаються локально. Після вимкнення синхронізації можна залишити або видалити синхронізовані файли на ChessRiddle.
