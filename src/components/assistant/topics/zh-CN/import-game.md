---
id: import-game
title: 导入对局
summary: 从 PGN 文件、粘贴的 PGN 文本、Lichess 或 Chess.com 链接、FEN 局面，或手写记录纸的照片或 PDF 扫描件导入对局。
source: 2a3b47d982e0f514
---

要导入对局或局面，请打开 [[page:new-tab]] 并点击 {{label:Home.Card.ImportGame.Button}} 以打开 {{label:Home.Card.ImportGame.Title}} 对话框。您也可以直接通过 {{label:Menu.File}} -> {{label:Menu.File.OpenFile}}（或 {{label:Settings.Keybinds.Actions.OPEN_FILE}} 快捷键）打开 PGN 文件。

在 {{label:Home.Card.ImportGame.Title}} 对话框中，选择以下选项之一：
- **PGN**：从电脑中选择一个 {{label:Common.PGNFile}} 或将文本粘贴到 {{label:Common.PGNGame}} 中。勾选 {{label:Import.SaveToCollection}} 可将副本保存到 [[page:library]] 的工作区文件夹中，然后输入 {{label:Common.Name}} 并选择 {{label:Files.FileType}}。
- **{{label:Import.Online}}**：粘贴 Lichess 或 Chess.com 的 {{label:Import.GameURL}} 以获取对局并在分析棋盘中打开。
- **FEN**：粘贴 FEN 字符串以从该局面打开分析棋盘。
- **{{label:Import.FromPhoto}}**（当 AI 功能可用时）：将 1 至 4 张手写记录纸照片或 PDF 页面识别为新对局。这需要在 [[settings-category:coach]]（{{label:Settings.AI}}）中至少有一个 AI 连接。

对于 PGN、{{label:Import.Online}} 和 FEN，点击 {{label:Home.Card.ImportGame.Button}} 将对局加载到当前标签页。

要使用 **{{label:Import.FromPhoto}}** 导入：
- 通过 {{label:Scoresheet.Intake.ChoosePhotos}}、{{label:Scoresheet.Intake.PasteFromClipboard}}（或在面板打开时按 Ctrl+V / Cmd+V），或将照片或 PDF 文件拖放到打开的面板中，添加最多 4 张 JPEG、PNG 或 WebP 照片或 PDF 页面。粘贴仅适用于照片。每个 PDF 页面计为一张照片；较长的 PDF 只使用前几页。
- 通过模型按钮或在 [[setting:coach-model]]（{{label:Settings.Coach.Model}}）中选择 AI 连接和支持图像的模型。
- 点击 {{label:Scoresheet.Read.Button}} 开始识别。在某个连接上首次读取前，{{label:Scoresheet.Notice.Title}} 会说明所选照片（包括棋手姓名和记录纸上书写的其他内容）将发送给该服务商，相机位置等元数据会先被移除，且不会发送其他任何数据。
- Studio 会按标准国际象棋规则从初始局面校验每一步棋，并在一个新的未保存分析标签页中打开对局，棋盘旁配有 {{label:Board.Tabs.Photo}} 面板。
- 存疑或经过修正的着法会在棋谱中标为不确定。在 {{label:Board.Tabs.Photo}} 面板中逐一查看，并在核对后点击 {{label:Scoresheet.MarkAsChecked}}。如果您在中途修改了着法或从中断处继续，可点击 {{label:Scoresheet.ContinueWithSheet}} 自动续演记录纸上的后续合法着法。完成后点击 {{label:Scoresheet.FinishReview}} 清除剩余标记。
- 使用常规保存流程（{{label:Menu.File}} -> {{label:Common.Save}}、保存按钮或 {{label:Board.Database.Save}}）将对局保存到文件或数据库。
- 照片仅保存在内存中（最多保留 4 个已打开标签页），不会写入磁盘；重新加载或重启后，对局与核对标记仍会保留，您可在 {{label:Board.Tabs.Photo}} 面板中使用 {{label:Scoresheet.LoadPhotoAgain}} 重新查看照片而无需再次发送。
