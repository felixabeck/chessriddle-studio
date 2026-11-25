---
id: databases
title: 数据库、开局探索器、局面搜索、棋手与赛事
summary: 添加或下载棋局数据库、选择参考数据库、在探索器中搜索局面，以及浏览对局、棋手和赛事。
source: d3afecf524059542
---

数据库与您的 PGN 文件一起位于 [[page:library]] ({{label:SideBar.Library}}) 中，并保存在 [[setting:databases-directory]]。

要添加数据库，请打开 [[page:library]] 并点击 {{label:Library.AddDatabase}}：
- {{label:Databases.Add.Web}}：从目录中下载精选棋局数据库。
- {{label:Common.Local}}：选择本地 PGN 文件（包括 `.pgn.zst` 或 `.pgn.bz2`），输入 {{label:Common.Name}} 和可选的 {{label:Common.Description}}，然后点击 {{label:Databases.Add.Convert}}。

在 [[page:library]] 中选择一个数据库以进行管理：
- 勾选 {{label:Databases.Settings.ReferenceDatabase}}，将其设为开局探索器、开局库构建器、对局报告新着和 Coach 的默认参考数据库。
- 勾选 {{label:Databases.Settings.Indexed}} 以创建或移除搜索索引，从而加快查询速度。
- 点击 {{label:Databases.Settings.Explore}} 打开数据库表格视图。
- 在 {{label:Databases.Settings.Actions}} 下，使用 {{label:Databases.Settings.AddGames}} 追加 PGN 文件，使用 {{label:Databases.Settings.ExportPGN}} 导出为 PGN，或使用 {{label:Common.Delete}} 删除数据库。
- 在 {{label:Databases.Settings.AdvancedTools}} 下，使用 {{label:Databases.Settings.MergePlayers}} 合并重复的棋手条目，或使用 {{label:Databases.Settings.RemoveDup}} 和 {{label:Databases.Settings.RemoveEmpty}} 清理对局。

在数据库表格视图中，可在 {{label:Common.Games}}、{{label:Databases.Card.Players}} 和 {{label:Databases.Settings.Events}}（赛事）之间切换：
- 搜索和排序对局、预览对局（预览可用眼睛按钮隐藏着法，[[setting:hide-preview-moves]]）或在分析棋盘上打开。
- 在 {{label:Databases.Card.Players}} 中选择一位棋手，可查看 {{label:Home.Personal.Overview}}、{{label:Home.Personal.Ratings}} 和 {{label:Home.Personal.Openings}}（带有 {{label:Databases.OpeningTree.Prepare}} 按钮的交互式开局树），以及通过 {{label:Databases.FIDE.Info}} 查看国际棋联（FIDE）信息。
- 在 {{label:Databases.Settings.Events}} 中按名称搜索赛事，并按日期、棋手数、对局数或平均等级分排序。

在棋手卡片中打开 {{label:Home.Personal.Preparation}} 标签页，将其对局与您的开局库文件进行比较：
- 选择对手的执棋颜色、{{label:Databases.OpeningTree.Since}} 时间范围，以及（在关联了在线账户时）{{label:Databases.OpeningTree.OverTheBoard}}、{{label:Databases.OpeningTree.Online}} 或 {{label:Databases.Preparation.Both}}。点击 {{label:Databases.Preparation.Refresh}} 可重新运行比较。
- 提高 {{label:Databases.Preparation.MinGames}} 可隐藏对手很少下过的变化和漏洞；你的文件会折叠这些变化，训练也会跳过它们。
- 查看对手常下的变化以及 {{label:Databases.Preparation.GapsTitle}}。点击任意一行即可在该局面打开您的开局库文件，并隐藏其他分支；在记谱栏顶部可在 {{label:Notation.PreparationOpponentLines}} 与 {{label:Notation.PreparationAllLines}} 之间切换。
- 点击 {{label:Databases.Preparation.TrainLines}} 开始针对这些变化的计时训练；您的作答会更新常规间隔重复计划。
- 如需针对仅有 Lichess 或 Chess.com 账户的对手进行准备，请在 [[page:library]] 中点击 {{label:Library.OnlineOpponent}}，查找并确认其账户、下载对局，并直接在 {{label:Home.Personal.Preparation}} 标签页打开棋手卡片（再次输入同一账户时将直接打开而不会重复下载）。

在分析棋盘上，打开 {{label:Board.Tabs.Database}} 标签页以使用开局探索器：
- 在 {{label:Board.Database.Local}}、{{label:Board.Database.LichessAll}} 和 {{label:Board.Database.LichessMaster}} 之间切换（Lichess 在线探索器需要在 [[page:accounts]] 中登录 Lichess 账户）。
- 在 {{label:Board.Database.Stats}}（着法统计）和 {{label:Board.Database.Games}}（匹配对局）之间切换。
- 对于本地数据库，点击 {{label:Board.Database.Compare}} 可并排查看两个数据库，或打开 {{label:Board.Database.Local.Position}} 在 {{label:Board.Database.Local.Exact}} 与 {{label:Board.Database.Local.Partial}} 局面搜索之间切换（包括用于兵型结构搜索的 {{label:Board.Database.Local.SimilarStructure}} 和用于自定义模板的 {{label:Fen.Empty}}）。
- 使用 {{label:Board.Database.Pin}} 将探索器固定在棋盘或记谱的上方或下方，使用 {{label:Board.Database.Unpin}} 将其放回标签页中。
- 当通过 {{label:Databases.OpeningTree.Prepare}} 为数据库棋手打开棋盘时，探索器会在对手对局旁新增一列显示您的参考数据库；点击 {{label:Board.Database.RemoveReference}} 可隐藏该列，点击 {{label:Board.Database.ShowReference}} 可重新显示。
