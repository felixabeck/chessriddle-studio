---
id: engines
title: 西洋棋引擎與分析面板
summary: 安裝或新增本機與雲端引擎、設定 UCI 選項，並在棋盤上使用即時分析。
source: 0e9ac8bab01e58b5
---

在 [[page:engines]] ({{label:SideBar.Engines}}) 管理您的西洋棋引擎。

若要新增引擎，請在 [[page:engines]] 上點擊 {{label:Common.AddNew}} 開啟 {{label:Engines.Add.Title}}：
- {{label:Common.Download}}：使用 {{label:Common.Install}} 從目錄安裝預先設定的引擎（例如 Stockfish）。
- {{label:Engines.Add.Cloud}}：使用 {{label:Common.Add}} 新增線上分析引擎（ChessDB 或 Lichess Cloud）。
- {{label:Common.Local}}：登錄電腦上已有的 UCI 引擎執行檔。

在 [[page:engines]] 上選取任意引擎進行設定。對於本機引擎，您可以編輯一般詳細資料、設定預設 UCI 選項（例如 Threads、Hash 與 MultiPV）、附加如 Syzygy 殘局庫等資源檔案，點擊 {{label:Engines.Settings.Reset}} 還原預設值、{{label:Common.Duplicate}} 複製設定，或 {{label:Common.Remove}} 將其移除。對於雲端引擎，您可以編輯名稱與 {{label:Engines.Settings.NumOfLines}}。

在分析棋盤上，開啟 {{label:Board.Tabs.Analysis}} 分頁並選取 {{label:Board.Analysis.Engines}}：
- 點擊 {{label:Board.Analysis.SelectEngines}} 選取要載入面板的已安裝引擎，或點擊 {{label:Board.Analysis.ManageEngines}} 跳轉至 [[page:engines]]。
- 點擊引擎卡片上的 {{label:Board.Analysis.EnableEngine}} 或 {{label:Board.Analysis.DisableEngine}} 開始或暫停分析，載入多個引擎時可使用 {{label:Board.Analysis.EnableAllEngines}}。
- 點擊 {{label:Board.Analysis.CheckThreat}}（或按 {{label:Settings.Keybinds.Actions.TOGGLE_THREAT_MODE}} 快捷鍵）分析對手的威脅。
- 點擊 {{label:Board.Analysis.Pin}} 將引擎評估條釘選在分頁外部，或點擊 {{label:Board.Analysis.EngineSettings}} 調整各分頁專屬設定，如搜尋上限與變例數。
- 透過 {{label:Board.Analysis.ReorderEngine}} 拖曳引擎卡片以調整順序。
- 引擎發生錯誤時，點擊 {{label:Board.Analysis.RetryEngine}} 旁的 {{label:Board.Analysis.Logs}} 檢視其 UCI 通訊紀錄。對於執行中的引擎，相同按鈕位於其卡片的 {{label:Board.Analysis.EngineSettings}} 中。

透過 [[setting:arrows]] ({{label:Settings.Arrows}}) 控制棋盤上的引擎箭頭。本機引擎儲存在 [[setting:engines-directory]] 所設定的資料夾中。
