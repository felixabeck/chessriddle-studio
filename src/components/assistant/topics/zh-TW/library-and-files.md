---
id: library-and-files
title: 檔案與資料庫
summary: 設定工作區資料夾、建立與整理 PGN 檔案、開啟與儲存對局，以及管理垃圾桶。
source: 984717132dfb14c1
---

[[page:library]] ({{label:SideBar.Library}}) 整合了您的工作區 PGN 檔案（對局、開局庫、賽事、謎題與其他檔案）以及棋局資料庫。

建立檔案前，請先選擇工作區資料夾。若尚未設定資料夾，請在 [[page:library]] 上點擊 {{label:Files.ChooseFolder}}，或在 [[settings-category:directories]] 下設定 [[setting:files-directory]] ({{label:Settings.Directories.Files}})。

在 [[page:library]] 中：
- 點擊 {{label:Files.CreateFile}} 建立新的 PGN 檔案，或點擊 {{label:Files.CreateFolder}} 以子資料夾整理檔案。
- 使用 {{label:Common.Search}} 輸入框與 {{label:Files.FileType}} 下拉選單，依檔案類型或 {{label:Library.GamesDatabase}} 篩選。
- 選取檔案即可預覽其中的對局、在分析棋盤上開啟，或使用 {{label:Files.Rename}}、{{label:Files.Move}} 與 {{label:Files.Trash}}。

在分析棋盤上編輯檔案時：
- 使用棋盤工具列的儲存按鈕、{{label:Menu.File}} -> {{label:Common.Save}}，或 {{label:Settings.Keybinds.Actions.SAVE_FILE}} 快捷鍵儲存變更。
- 開啟 [[setting:auto-save]] ({{label:Settings.AutoSave}}) 以自動儲存已開啟檔案的編輯內容。
- 使用 {{label:Menu.File}} -> {{label:Board.Database.Save}}（或工具列上的 {{label:Board.Database.Save}} 按鈕）將目前對局儲存至另一個資料庫檔案或資料庫中。

將檔案移至 {{label:Files.Trash}} 不會立即永久刪除。您可以立即點擊通知中的 {{label:Common.Undo}}，或捲動至 [[page:library]] 中的 {{label:Files.Trash}} 區段來 {{label:Files.Restore}} 檔案、{{label:Files.DeletePermanently}} 或 {{label:Files.EmptyTrash}}。
