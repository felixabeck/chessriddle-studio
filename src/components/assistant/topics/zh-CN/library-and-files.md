---
id: library-and-files
title: 文件与资料库
summary: 设置工作区文件夹、创建和整理 PGN 文件、打开和保存对局，以及管理回收站。
source: c4c2624190fac7bb
---

[[page:library]] ({{label:SideBar.Library}}) 将您的工作区 PGN 文件（对局、开局库、赛事、谜题和其他文件）以及棋局数据库集中在一起。

创建文件前请先选择一个工作区文件夹。如果尚未设置文件夹，请在 [[page:library]] 中点击 {{label:Files.ChooseFolder}}，或在 [[settings-category:directories]] 下配置 [[setting:files-directory]] ({{label:Settings.Directories.Files}})。

在 [[page:library]] 中：
- 点击 {{label:Files.CreateFile}} 创建新的 PGN 文件，或点击 {{label:Files.CreateFolder}} 使用子文件夹整理文件。
- 使用 {{label:Common.Search}} 输入框和 {{label:Files.FileType}} 下拉菜单按文件类型或 {{label:Library.GamesDatabase}} 进行筛选。
- 选择一个文件以预览其中的对局（预览可用眼睛按钮隐藏着法，[[setting:hide-preview-moves]]）、在分析棋盘上打开，或使用 {{label:Files.Rename}}、{{label:Files.Move}} 和 {{label:Files.Trash}} 操作。

在分析棋盘上编辑文件时：
- 通过棋盘顶部栏中的保存按钮（在自动保存关闭、不可用或失败时显示）、{{label:Menu.File}} -> {{label:Common.Save}}，或 {{label:Settings.Keybinds.Actions.SAVE_FILE}} 快捷键保存更改。
- 开启 [[setting:auto-save]] ({{label:Settings.AutoSave}}) 以自动保存已打开文件的修改。
- 使用 {{label:Menu.File}} -> {{label:Board.Database.Save}}（或棋盘顶部栏中的 {{label:Board.Action.More}} -> {{label:Board.Database.Save}}）将当前对局保存到另一个资料库文件或数据库中。

将文件移至 {{label:Files.Trash}} 不会立即永久删除。您可以立即点击提示中的 {{label:Common.Undo}}，或滚动到 [[page:library]] 中的 {{label:Files.Trash}} 区域以执行 {{label:Files.Restore}}、{{label:Files.DeletePermanently}} 或 {{label:Files.EmptyTrash}}。

连接您的 ChessRiddle 账户后，请在 [[page:library]] 中点击 {{label:Library.Sync.Action}}，将选中的 PGN 文件和棋局数据库同步到您的 ChessRiddle 私人棋库（最多 100 个文件，每个文件最大 5 MB、最多 40,000 步着法和 5,000 盘对局）。编辑、重命名、取消选择和删除会自动更新；已下载的对局历史仍保留在本地。关闭同步时，您可以选择在 ChessRiddle 上保留或移除已同步的文件。
