---
id: game-report
title: 对局复盘与报告
summary: 使用本地引擎分析对局，查看准确率、评估与用时图表、开局与开局库提示，以及棋盘上的关键时刻。
source: d1a4339820f36de2
---

对局报告会使用本地国际象棋引擎分析主变中的每一步棋，并将结果整理为引导式对局复盘。

要生成报告，请在分析棋盘上打开一局棋，切换到 {{label:Board.Analysis.Report}} 标签页，然后点击 {{label:Board.Analysis.GenerateReport}}（或按下快捷键 {{label:Settings.Keybinds.Actions.GENERATE_REPORT}}）。

在 {{label:Board.Analysis.GenerateReport}} 对话框中：
- 选择一个本地 {{label:Common.Engine}}。如果尚未安装引擎，可在 [[page:engines]] 中添加。
- 设置每步棋的搜索限制（深度、时间或节点数）。
- 开启 {{label:Board.Analysis.MarkMoves}}，用着法质量符号（`!!`、`!`、`!?`、`?!`、`?`、`??`）标注着法。
- 开启 {{label:Board.Analysis.ShowVariations}}，在棋谱中插入更佳着法的变着。
- 开启 {{label:Board.Analysis.AnnotateNovelties}}，用 `N` 标出离开参考数据库的第一步棋。此选项需要在 [[page:library]] 中选择已准备好的参考数据库。
- 点击 {{label:Board.Analysis.Analyze}} 开始分析。

报告运行期间，你可以通过进度按钮取消。编辑主变同样会取消正在运行的报告。

完成后，{{label:Board.Analysis.Report}} 会显示：
- 简洁的标题栏，列出所用引擎、搜索限制和日期，旁边带有小号 {{label:Board.Analysis.Report.Regenerate}} 按钮。只有当前没有最新报告时，才会显示全宽的 {{label:Board.Analysis.GenerateReport}} 按钮。
- 如果对局从均势局面开始，记分牌上方会显示一句总结；从不均衡局面开始时则不显示总结句。
- 一张汇总记分牌，包含棋手姓名与等级分、作为核心数字的 {{label:Board.Analysis.Accuracy}}、{{label:Board.Analysis.Report.AverageLoss}}、各阶段准确率以及六行着法质量统计（零值会变暗）。点击非零数字可跳转到对应着法，鼠标悬停或键盘聚焦任意指标标签都会显示其含义说明。
- 可在 {{label:Board.Analysis.Report.Evaluation}}（带零线）与 {{label:Board.Analysis.Report.WinChance}} 之间切换的图表，悬停或键盘聚焦切换标签时会显示说明。当至少半数着法带有时钟时间时，图表下方会出现 {{label:Board.Analysis.Report.TimeUsage}} 条；点击任意柱条即可跳转到该步棋。
- 开局与开局库区块，显示开局名称、新着（`N`，如有）以及仅针对你这一方的开局库提示——通过将棋手姓名与 [[page:accounts]] 中已连接的 Lichess、Chess.com 或别名账号匹配来确定你的一方；若都不匹配，则以棋盘下方的一方为准（翻转棋盘会改变该方）。它会指出你在哪一步离开了开局库（点击可带着箭头聚焦该局面），或你一直遵循到哪一步。如果未能完整读取开局库文件，则只显示一行柔和提示：{{label:Board.Analysis.Report.RepertoireIncomplete}}
- {{label:Board.Analysis.Report.KeyMoments}}：点击任意一行即可跳转到该步之前的局面，使棋盘上的两条箭头（实际着法与更佳着法）都从该格出发。使用 {{label:Board.Analysis.Report.PreviousMoment}} 和 {{label:Board.Analysis.Report.NextMoment}} 逐步浏览，或按 {{label:Board.Analysis.Report.FilterBoth}}、{{label:Board.Analysis.Report.FilterWhite}} 或 {{label:Board.Analysis.Report.FilterBlack}} 筛选。关键时刻还会显示 {{label:Board.Analysis.Report.Tag.TurningPoint}} 或 {{label:Board.Analysis.Report.Tag.TimeTrouble}} 等标签，并在引擎变着能够证明时标出失误类型。
- 在 `?!`、`?` 和 `??` 时刻上，点击 {{label:Board.Analysis.Report.Explain}} 可聚焦该局面并打开 {{label:Board.Tabs.Coach}}，附带关于该时刻的问题。未配置 AI 连接时，此按钮会隐藏。

如果你之后修改了棋局，请使用 {{label:Board.Analysis.GenerateReport}} 或 {{label:Board.Analysis.Report.Regenerate}} 重新生成报告以更新复盘内容。
