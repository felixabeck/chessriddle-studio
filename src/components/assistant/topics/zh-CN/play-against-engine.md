---
id: play-against-engine
title: 与引擎对弈
summary: 配置与本地引擎或另一位棋手的对局、设置时限和开局库，并从任意局面开始对弈。
source: 7c75f4b49a6bdf2c
---

要开始对弈，请打开 [[page:new-tab]] 并点击 {{label:Home.Card.PlayChess.Button}}。您也可以在分析棋盘上点击棋盘工具栏中的 {{label:Board.Action.PlayFromHere}}，或右键点击记谱中的某个着法，从任意局面开始对弈。

开始对弈前：
- 为每一方选择 {{label:Board.Opponent.Human}}（填写姓名）或 {{label:Common.Engine}}（从 [[page:engines]] 中选择已安装的引擎并调整本局的 UCI 选项）。
- 点击 {{label:Board.Action.ChangeColors}} 交换白方和黑方。
- 在 {{label:Board.Opponent.TimeSettings}} 下选择 {{label:GoMode.Time}}（设置 {{label:GoMode.Time}} 和 {{label:Board.Opponent.Increment}}）或 {{label:Board.Opponent.Unlimited}}。勾选 {{label:Board.Opponent.SameTimeControl}} 让双方共用相同的计时设置。
- 可选勾选 {{label:Board.Opponent.EnableOpeningBook}}，选择一个 {{label:Board.Opponent.OpeningBookFile}}，并设置 {{label:Board.Opponent.OpeningBookMaxPlies}}。
- 如果想从自定义局面开始对弈，请在开始前使用棋盘工具栏中的 {{label:Board.Action.EditPosition}}。
- 点击 {{label:Board.Opponent.StartGame}} 开始对局。

对弈过程中：
- 棋手对阵引擎时支持预走棋（Premove）。
- 使用棋盘工具栏中的 {{label:Board.Action.TakeBack}} 撤销您的上一步棋。
- 点击 {{label:Board.Opponent.Resign}}（在引擎对引擎对局中为 {{label:Board.Opponent.Abort}}）结束对局。
- 随时点击 {{label:Board.Analysis.Analyze}} 将标签页切换为分析模式，或点击 {{label:Board.Analysis.Logs}} 查看引擎日志。
- 对局结束后，点击 {{label:Home.NewGame}} 设置新对局。
