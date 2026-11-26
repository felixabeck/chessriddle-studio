---
id: game-report
title: 对局报告
summary: 运行自动引擎复盘，查看准确率、评估曲线、关键时刻和着法分类。
source: b69aae8a4fe0f417
---

对局报告会使用本地国际象棋引擎分析主线中的每一步棋，并总结对局的准确率和失误情况。

要生成报告，请在分析棋盘上打开一局棋，切换到 {{label:Board.Analysis.Report}} 标签页，然后点击 {{label:Board.Analysis.GenerateReport}}（或按 {{label:Settings.Keybinds.Actions.GENERATE_REPORT}} 快捷键）。

在 {{label:Board.Analysis.GenerateReport}} 对话框中：
- 选择一个本地 {{label:Common.Engine}}。如果尚未安装，请在 [[page:engines]] 中添加。
- 设置每步棋的搜索限制（深度、时间或节点数）。
- 开启 {{label:Board.Analysis.MarkMoves}} 以用质量符号标注着法。
- 开启 {{label:Board.Analysis.ShowVariations}} 将更好的着法变化插入记谱中。
- 开启 {{label:Board.Analysis.AnnotateNovelties}} 标记首个离开参考数据库的着法。此选项需要在 [[page:library]] 中选择已准备好的参考数据库。
- 点击 {{label:Board.Analysis.Analyze}} 开始分析。

报告运行期间，您可以通过进度按钮取消。编辑主线也会取消正在进行的报告。

完成后，{{label:Board.Analysis.Report}} 会显示：
- {{label:Common.WHITE}} 和 {{label:Common.BLACK}} 的准确率百分比与平均厘兵损失（ACPL）。
- 贯穿整局棋的评估图表。
- {{label:Board.Analysis.Report.KeyMoments}}：可点击的已标记着法列表，显示评估波动和更好的着法。
- 着法质量分布表，点击其中的计数可跳转到对应着法。

如果您之后修改了对局，请点击 {{label:Board.Analysis.RegenerateReport}} 运行新的分析。
