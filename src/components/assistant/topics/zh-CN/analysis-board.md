---
id: analysis-board
title: 分析棋盘、变例、评注与箭头
summary: 输入着法、编辑局面、管理变例、撰写评注、添加注释符号以及在棋盘上绘制箭头。
source: f49e0c9098ffc5cf
---

在 [[page:new-tab]] 中点击 {{label:Home.Card.AnalysisBoard.Title}}，或在 [[page:library]] 中打开已保存的对局或开局库，即可打开分析棋盘。

通过拖动或点击棋子走棋（在 [[setting:move-method]] 中配置）。您也可以启用 [[setting:text-input]] ({{label:Settings.Inputs.TextInput}}) 以使用 SAN 记谱法输入着法。使用记谱下方的步进控件、方向键或鼠标滚轮（如果启用了 [[setting:scroll-moves]]）浏览着法。

棋盘上方的顶部栏提供棋盘操作：
- {{label:Board.Action.PlayFromHere}}：从当前局面开始对弈。
- 翻转棋盘（`F`）：交换棋盘下方的白方与黑方。
- 保存：当对局有未保存的更改，且自动保存已关闭、不可用（例如草稿）或上次写入失败时显示。
- {{label:Board.Action.More}}：打开菜单以执行 {{label:Board.Action.NewAnalysis}}（在同一标签页中将棋盘替换为空棋盘；如有未保存的更改，会先询问你）、{{label:Board.Database.Save}}（将对局保存到资料库文件或数据库中）、{{label:Board.Action.TakeSnapshot}}（保存当前棋盘的截图）以及 {{label:Board.Action.EditPosition}}（通过摆放棋子或编辑 FEN 设置自定义局面）。
- 撤销、重做以及清除绘制的箭头或高亮（当 [[setting:erase-drawables]] 关闭时）使用 [[settings-category:keybinds]] 中的键盘快捷键。

从较早的局面走出不同的着法会创建一个变例。右键点击记谱中的任意着法，即可执行 {{label:Menu.PromoteVariation}}、{{label:Menu.PromoteToMainLine}}、{{label:Menu.CopyVariationPGN}}、{{label:Menu.DeleteMove}}、{{label:Menu.DeleteVariation}}、{{label:Menu.DeleteMovesAfter}}、{{label:Board.Action.PlayFromHere}}、{{label:Notation.AddDiagram}} 或 {{label:Notation.MarkGameEndHere}}。使用记谱标题栏中的眼睛按钮可切换 {{label:Notation.HideMoves}}，使用 {{label:Notation.ViewOptions}} 菜单可切换 {{label:Notation.TableView}}、{{label:Notation.ShowComments}}、{{label:Notation.ShowDiagrams}} 和 {{label:Notation.ShowVariations}}。

要为着法添加注释并撰写评注，请打开 {{label:Board.Tabs.Annotate}} 标签页。点击着法质量符号（或按数字键 1 到 6）可切换 `!!`、`!`、`!?`、`?!`、`?` 或 `??`，点击 {{label:Annotate.ShowMore}} 可显示局面评估与策略符号。符号下方的富文本编辑器可用于编写格式化的评注并开关行内棋盘局面图。

要在棋盘上绘制箭头和高亮格子，请按住鼠标右键拖动（或右键点击格子以绘制圆圈）。按住修饰键可切换不同颜色：Shift 为 {{label:Settings.Drawing.Red}}，Alt 为 {{label:Settings.Drawing.Blue}}，Shift+Alt 为 {{label:Settings.Drawing.Yellow}}，Ctrl（macOS 上为 Cmd）为 {{label:Settings.Drawing.Orange}}，Ctrl+Alt（macOS 上为 Cmd+Alt）为 {{label:Settings.Drawing.Cyan}}。完整绘图列表见 [[settings-category:keybinds]]。

{{label:Board.Tabs.Info}} 标签页显示对局头信息、FEN、PGN 文本和变化树统计信息，并允许您在多对局 PGN 文件中切换对局。

要调整分析棋盘的布局，可以拖动面板标签页（{{label:Board.Tabs.Analysis}}、{{label:Board.Analysis.Report}}、{{label:Board.Tabs.Database}}、{{label:Board.Tabs.Annotate}}、{{label:Board.Tabs.Coach}}或{{label:Board.Tabs.Info}}）或引擎卡片的六点手柄，或使用标签栏、记谱标题栏或面板区域标题栏上的拖动手柄按钮，通过预览或键盘将区域放置到其他区域的左侧、右侧、上方或下方。若要让一个面板横跨两个区域（例如将{{label:Board.Tabs.Database}}放在记谱和标签页上方），请先将该面板放到其中一个区域上方，再把另一个区域移到它旁边。点击{{label:Board.Area.ReturnToTabs}}（引擎窗口则为{{label:Board.Area.ReturnToEngines}}）或将区域拖回标签栏即可放回。

开局库、对局和对手准备标签页各自保留自己的实时布局。内置三个预设布局（{{label:Board.Layout.Preset.Repertoire}}、{{label:Board.Layout.Preset.GameReview}} 和 {{label:Board.Layout.Preset.Preparation}}），你可以在 {{label:Board.Action.More}}（{{label:Board.Layout.SaveAs}} 与 {{label:Board.Layout.Manage}}）或 {{label:Menu.View}}（{{label:Board.Layout.SaveAs}} 与 {{label:Board.Layout.LayoutsMenu}}）中保存自己的布局、切换布局，或重命名与删除已保存的布局。使用 [[setting:board-layout]]（{{label:Settings.BoardLayout.Reset}}）可将三种标签页恢复为预设布局，同时保留已保存的布局。

要隐藏标签页（例如所用的每个面板都已显示为独立区域时），请点击标签栏末尾拖动手柄下方的{{label:Board.Area.HideTabs}}，相邻区域会占据其空间。标签页会保留位置和大小：标签页隐藏时，记谱标题栏中会出现{{label:Board.Arrange.ShowTabs}}按钮，点击它、使用标签页快捷键或生成报告即可重新显示。标签页隐藏时放回的面板会进入隐藏的标签页。标签页隐藏时，{{label:Board.Action.More}}和{{label:Menu.View}}菜单中也有{{label:Board.Arrange.ShowTabs}}。
