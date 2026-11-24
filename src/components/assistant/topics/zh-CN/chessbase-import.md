---
id: chessbase-import
title: 从 ChessBase 导入数据库
summary: 将 ChessBase 数据库导出为 PGN 并转换为 Studio 数据库。
source: d7f599a811a0afb0
---

ChessRiddle Studio 不直接读取 ChessBase 的 `.cbh` 或 `.cbv` 文件。请先将 ChessBase 数据库导出为 PGN，然后再将 PGN 文件转换为 Studio 数据库。

如果您在文件选择器中选中了 ChessBase 文件，Studio 会自动打开 {{label:ChessBaseGuide.Title}} 对话框。您也可以通过 [[page:library]] 中 {{label:Library.AddDatabase}} 内的指南链接打开它。

按照以下步骤从 ChessBase 导入：
1. 在 ChessBase 中打开数据库，并选中要导出的对局。
2. 在 ChessBase 中将选中的对局导出或保存为 `.pgn` 文件。
3. 在 Studio 中打开 [[page:library]]，点击 {{label:Library.AddDatabase}}，切换到 {{label:Common.Local}} 标签页，选择导出的 `.pgn` 文件，输入 {{label:Common.Name}}，然后点击 {{label:Databases.Add.Convert}}。

转换完成后，数据库会出现在 [[page:library]] 中，您可以浏览其中的对局、棋手和赛事，或将其设为 {{label:Databases.Settings.ReferenceDatabase}}。
