---
id: library-and-files
title: 文件与资料库
summary: 设置工作区文件夹、创建和整理 PGN 文件、打开和保存对局，以及管理回收站。
source: 984717132dfb14c1
---

[[page:library]] ({{label:SideBar.Library}}) 将您的工作区 PGN 文件（对局、开局库、赛事、谜题和其他文件）以及棋局数据库集中在一起。

创建文件前请先选择一个工作区文件夹。如果尚未设置文件夹，请在 [[page:library]] 中点击 {{label:Files.ChooseFolder}}，或在 [[settings-category:directories]] 下配置 [[setting:files-directory]] ({{label:Settings.Directories.Files}})。

在 [[page:library]] 中：
- 点击 {{label:Files.CreateFile}} 创建新的 PGN 文件，或点击 {{label:Files.CreateFolder}} 使用子文件夹整理文件。
- 使用 {{label:Common.Search}} 输入框和 {{label:Files.FileType}} 下拉菜单按文件类型或 {{label:Library.GamesDatabase}} 进行筛选。
- 选择一个文件以预览其中的对局、在分析棋盘上打开，或使用 {{label:Files.Rename}}、{{label:Files.Move}} 和 {{label:Files.Trash}} 操作。

在分析棋盘上编辑文件时：
- 通过棋盘工具栏中的保存按钮、{{label:Menu.File}} -> {{label:Common.Save}}，或 {{label:Settings.Keybinds.Actions.SAVE_FILE}} 快捷键保存更改。
- 开启 [[setting:auto-save]] ({{label:Settings.AutoSave}}) 以自动保存已打开文件的修改。
- 使用 {{label:Menu.File}} -> {{label:Board.Database.Save}}（或工具栏上的 {{label:Board.Database.Save}} 按钮）将当前对局保存到另一个资料库文件或数据库中。

将文件移至 {{label:Files.Trash}} 不会立即永久删除。您可以立即点击提示中的 {{label:Common.Undo}}，或滚动到 [[page:library]] 中的 {{label:Files.Trash}} 区域以执行 {{label:Files.Restore}}、{{label:Files.DeletePermanently}} 或 {{label:Files.EmptyTrash}}。
