---
id: game-report
title: 對局報告
summary: 執行自動引擎複盤，以檢視準確率、評估曲線、關鍵時刻與著法分類。
source: a5e00adfe821f3f3
---

對局報告會使用本機西洋棋引擎分析主變例中的每一步著法，並總結對局的準確率與失誤。

若要生成報告，請在分析棋盤上開啟對局，切換至 {{label:Board.Tabs.Analysis}} -> {{label:Board.Analysis.Report}}，然後點擊 {{label:Board.Analysis.GenerateReport}}（或按 {{label:Settings.Keybinds.Actions.GENERATE_REPORT}} 快捷鍵）。

在 {{label:Board.Analysis.GenerateReport}} 對話方塊中：
- 選取本機 {{label:Common.Engine}}。若尚未安裝，請在 [[page:engines]] 中新增。
- 設定每步著法的搜尋上限（深度、時間或節點數）。
- 開啟 {{label:Board.Analysis.MarkMoves}} 以用品質符號標記著法。
- 開啟 {{label:Board.Analysis.ShowVariations}} 將更好的著法變化插入記譜中。
- 開啟 {{label:Board.Analysis.AnnotateNovelties}} 標記第一個離開參考資料庫的著法。此選項需要在 [[page:library]] 中選取已就緒的參考資料庫。
- 點擊 {{label:Board.Analysis.Analyze}} 開始分析。

報告執行期間，您可以從進度按鈕取消。編輯主變例也會取消進行中的報告。

完成後，{{label:Board.Analysis.Report}} 會顯示：
- {{label:Common.WHITE}} 與 {{label:Common.BLACK}} 的準確率百分比與平均厘兵損失（ACPL）。
- 整局棋的評估圖表。
- {{label:Board.Analysis.Report.KeyMoments}}：可點擊的已標記著法清單，顯示評估變化與更好的著法。
- 著法品質分類統計表，點擊數量即可跳轉至對應著法。

若您之後編輯了對局，請點擊 {{label:Board.Analysis.RegenerateReport}} 重新執行分析。
