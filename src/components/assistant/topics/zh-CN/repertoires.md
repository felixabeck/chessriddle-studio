---
id: repertoires
title: 开局库
summary: 创建开局库、导入 PGN、对照参考数据库构建覆盖范围、通过间隔重复进行练习，以及跟踪未完成的变例、转置和核查标记。
source: db00ec0860d0fa31
---

开局库是类型为“开局库”的 PGN 文件，它会在分析棋盘上添加 {{label:Board.Tabs.Practice}} 标签页。

要创建开局库，请打开 [[page:new-tab]] 并点击 {{label:Home.Card.NewRepertoire.Title}}（或在 [[page:library]] 中创建开局库文件）。输入 {{label:Common.Name}}，选择 {{label:Common.WHITE}} 或 {{label:Common.BLACK}}，也可以在 {{label:Home.Card.NewRepertoire.FromPgn}} 下选择或粘贴 PGN，然后点击 {{label:Common.Create}}。您还可以在 {{label:Home.Card.ImportGame.Title}} 中勾选 {{label:Import.SaveToCollection}} 并将文件类型设为 {{label:Files.FileType.Repertoire}} 来导入 PGN。

在 {{label:Board.Tabs.Practice}} -> {{label:Board.Practice.Build}} 中构建您的开局库：
- 点击 {{label:Board.Practice.Build.ImportPgn}}，将 PGN 文件或粘贴的对局合并到当前打开的开局库中（无论是否配置参考数据库均可用）。
- 在 [[page:library]] 中设置一个 {{label:Databases.Settings.ReferenceDatabase}}，以便构建器显示着法频率和覆盖情况。
- 在空的开局库中，您可以从内置的 {{label:Board.Practice.Build.Presets}} 之一开始，或在棋盘上直接输入着法。
- 使用 {{label:Board.Practice.Build.SetAsStart}}（或右键点击记谱中的着法并选择 {{label:Menu.MarkAsStart}}）标记您开局库的起始局面。
- 点击 {{label:Board.Practice.Build.OpponentMoves}} 或 {{label:Board.Practice.Build.YourResponse}} 中的着法来添加或跟随变化。使用 {{label:Board.Practice.Build.NextGap}} 和 {{label:Board.Practice.Build.BiggestGap}} 跳转到超过 [[setting:repertoire-depth]] 所设最小对局数的未覆盖对手应对。

在 {{label:Board.Tabs.Practice}} -> {{label:Board.Practice.Train}} 中练习您的开局库：
- 点击 {{label:Board.Practice.StartPractice}} 通过间隔重复练习待复习和新局面，或点击 {{label:Board.Practice.PracticeFullRepertoire}} 练习开局库中的所有局面。
- 在棋盘上走出您准备好的着法。走错后如果卡住，请点击 {{label:Board.Practice.ShowMove}}。
- 使用 {{label:Board.Practice.ShowAll}} 查看所有卡片，使用 {{label:Board.Practice.ShowLogs}} 回顾记录，或使用 {{label:Common.Reset}} 重置进度。
- 有待复习卡片的开局库也会显示在 [[page:new-tab]] 的 {{label:Home.Library.Due}} 筛选器下。
- 在 [[settings-category:repertoire]]（[[setting:practice-grading]]、[[setting:practice-new-per-session]]）中配置间隔重复评分和每次练习的新卡片上限。

在分析棋盘的记谱中：
- 只有一步长的分支会以虚线框标示为 {{label:Notation.OpenVariation}}，方便您发现未完成的分支。按 {{label:Settings.Keybinds.Actions.NEXT_OPEN_VARIATION}} 快捷键可跳转到下一个此类分支。
- 当同一开局库的另一分支中也出现相同局面时，着法旁会出现 {{label:Notation.Transposition}} 图标；点击它即可跳转到另一个分支。
- 当导入的 PGN 为您这一方提供了不同的应手时，导入的着法会作为变化追加并标记为 {{label:Notation.ReviewMove}}。右键点击该着法并选择 {{label:Menu.MarkAsReviewed}} 即可清除标记。
