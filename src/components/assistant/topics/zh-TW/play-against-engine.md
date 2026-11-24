---
id: play-against-engine
title: 與引擎對弈
summary: 設定與本機引擎或另一位棋手的對局、調整計時規則與開局庫，並從任意局面開始對弈。
source: 7c75f4b49a6bdf2c
---

若要開始對弈，請開啟 [[page:new-tab]] 並點擊 {{label:Home.Card.PlayChess.Button}}。您也可以點擊分析棋盤工具列中的 {{label:Board.Action.PlayFromHere}}，或在記譜中的著法上按右鍵，從任意局面開始對弈。

開始對弈前：
- 為雙方選擇 {{label:Board.Opponent.Human}}（填寫名稱）或 {{label:Common.Engine}}（從 [[page:engines]] 選取已安裝的引擎並調整本局的 UCI 選項）。
- 點擊 {{label:Board.Action.ChangeColors}} 互換白方與黑方。
- 在 {{label:Board.Opponent.TimeSettings}} 下選擇 {{label:GoMode.Time}}（搭配 {{label:GoMode.Time}} 與 {{label:Board.Opponent.Increment}}）或 {{label:Board.Opponent.Unlimited}}。勾選 {{label:Board.Opponent.SameTimeControl}} 讓雙方套用相同的計時設定。
- 可選填勾選 {{label:Board.Opponent.EnableOpeningBook}}、選取 {{label:Board.Opponent.OpeningBookFile}}，並設定 {{label:Board.Opponent.OpeningBookMaxPlies}}。
- 若想從自訂局面開始對弈，請在開始前使用棋盤工具列中的 {{label:Board.Action.EditPosition}}。
- 點擊 {{label:Board.Opponent.StartGame}} 開始對局。

對弈期間：
- 棋手對弈引擎時支援預走棋（Premove）。
- 使用棋盤工具列中的 {{label:Board.Action.TakeBack}} 收回您的上一步棋。
- 點擊 {{label:Board.Opponent.Resign}}（或在引擎對戰引擎時點擊 {{label:Board.Opponent.Abort}}）結束對局。
- 隨時點擊 {{label:Board.Analysis.Analyze}} 將分頁切換至分析模式，或點擊 {{label:Board.Analysis.Logs}} 檢視引擎日誌。
- 對局結束後，點擊 {{label:Home.NewGame}} 設定新對局。
