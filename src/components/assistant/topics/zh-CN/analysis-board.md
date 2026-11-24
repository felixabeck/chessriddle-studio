---
id: analysis-board
title: 分析棋盘、变例、评注与箭头
summary: 输入着法、编辑局面、管理变例、撰写评注、添加注释符号以及在棋盘上绘制箭头。
source: 14ba83ba3068d6ed
---

在 [[page:new-tab]] 中点击 {{label:Home.Card.AnalysisBoard.Title}}，或在 [[page:library]] 中打开已保存的对局或开局库，即可打开分析棋盘。

通过拖动或点击棋子走棋（在 [[setting:move-method]] 中配置）。您也可以启用 [[setting:text-input]] ({{label:Settings.Inputs.TextInput}}) 以使用 SAN 记谱法输入着法。使用记谱下方的步进控件、方向键或鼠标滚轮（如果启用了 [[setting:scroll-moves]]）浏览着法。

记谱旁边的工具栏提供棋盘操作：
- {{label:Board.Action.TakeSnapshot}}：保存当前棋盘的截图。
- {{label:Board.Action.EditPosition}}：通过摆放棋子或编辑 FEN 来设置自定义局面。
- {{label:Board.Action.PlayFromHere}}：从当前局面开始对弈。
- {{label:Board.Action.ClearDrawings}}：清除箭头和格子高亮（当 [[setting:erase-drawables]] 关闭时显示）。
- {{label:Board.Database.Save}}：将对局保存到资料库文件或数据库中。
- 撤销、重做、保存和翻转棋盘控件。

从较早的局面走出不同的着法会创建一个变例。右键点击记谱中的任意着法，即可执行 {{label:Menu.PromoteVariation}}、{{label:Menu.PromoteToMainLine}}、{{label:Menu.CopyVariationPGN}}、{{label:Menu.DeleteMove}}、{{label:Board.Action.PlayFromHere}}、{{label:Notation.AddDiagram}} 或 {{label:Notation.MarkGameEndHere}}。使用记谱标题栏按钮可切换 {{label:Notation.HideMoves}}、{{label:Notation.TableView}}、{{label:Notation.HideComments}}、{{label:Notation.HideDiagrams}} 和 {{label:Notation.HideVariations}}。

要为着法添加注释并撰写评注，请打开 {{label:Board.Tabs.Annotate}} 标签页。点击着法质量符号（或按数字键 1 到 6）可切换 `!!`、`!`、`!?`、`?!`、`?` 或 `??`，点击 {{label:Annotate.ShowMore}} 可显示局面评估与策略符号。符号下方的富文本编辑器可用于编写格式化的评注并开关行内棋盘局面图。

要在棋盘上绘制箭头和高亮格子，请按住鼠标右键拖动（或右键点击格子以绘制圆圈）。按住修饰键可切换不同颜色：Shift 为 {{label:Settings.Drawing.Red}}，Alt 为 {{label:Settings.Drawing.Blue}}，Shift+Alt 为 {{label:Settings.Drawing.Yellow}}，Ctrl（macOS 上为 Cmd）为 {{label:Settings.Drawing.Orange}}，Ctrl+Alt（macOS 上为 Cmd+Alt）为 {{label:Settings.Drawing.Cyan}}。完整绘图列表见 [[settings-category:keybinds]]。

{{label:Board.Tabs.Info}} 标签页显示对局头信息、FEN、PGN 文本和变化树统计信息，并允许您在多对局 PGN 文件中切换对局。
