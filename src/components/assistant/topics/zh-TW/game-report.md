---
id: game-report
title: 對局覆盤與報告
summary: 使用本機引擎分析對局，檢視準確度、評估與用時圖表、開局與開局庫提示，以及棋盤上的關鍵時刻。
source: d1a4339820f36de2
---

對局報告會以本機西洋棋引擎分析主變中的每一步棋，並將結果整理成引導式的對局覆盤。

若要產生報告，請在分析棋盤中開啟一局棋，切換至 {{label:Board.Analysis.Report}} 分頁，然後點擊 {{label:Board.Analysis.GenerateReport}}（或按下快捷鍵 {{label:Settings.Keybinds.Actions.GENERATE_REPORT}}）。

在 {{label:Board.Analysis.GenerateReport}} 對話方塊中：
- 選擇一個本機 {{label:Common.Engine}}。若尚未安裝，請前往 [[page:engines]] 新增。
- 設定每步棋的搜尋限制（深度、時間或節點數）。
- 開啟 {{label:Board.Analysis.MarkMoves}}，以着法品質符號（`!!`、`!`、`!?`、`?!`、`?`、`??`）標記着法。
- 開啟 {{label:Board.Analysis.ShowVariations}}，將較佳着法的變着加入棋譜記號中。
- 開啟 {{label:Board.Analysis.AnnotateNovelties}}，將離開參考資料庫的第一步棋標記為 `N`。此選項需在 [[page:library]] 中選取已就緒的參考資料庫。
- 點擊 {{label:Board.Analysis.Analyze}} 開始分析。

報告執行期間，可透過進度按鈕取消。編輯主變也會取消正在執行的報告。

完成後，{{label:Board.Analysis.Report}} 會顯示：
- 簡潔的標頭列，顯示引擎、搜尋限制與日期，旁側附有小型的 {{label:Board.Analysis.Report.Regenerate}} 按鈕。只有在目前沒有最新報告時，才會顯示全寬的 {{label:Board.Analysis.GenerateReport}} 按鈕。
- 若對局從均勢局面開始，記分板上方會顯示一句摘要；若從不均衡局面開局，則不顯示摘要句。
- 單一記分板，列出棋手姓名與等級分、作為核心數值的 {{label:Board.Analysis.Accuracy}}、{{label:Board.Analysis.Report.AverageLoss}}、各階段準確度，以及六列着法品質統計（數值為零時會淡化顯示）。點擊非零數字可跳轉至對應着法；將指標懸停或以鍵盤聚焦任一指標標籤，即可查看其說明。
- 可在 {{label:Board.Analysis.Report.Evaluation}}（附零線）與 {{label:Board.Analysis.Report.WinChance}} 之間切換的圖表，懸停或鍵盤聚焦切換標籤時會顯示說明。當至少半數着法帶有時鐘時間時，圖表下方會出現 {{label:Board.Analysis.Report.TimeUsage}} 長條圖；點擊任一長條即可跳至該步棋。
- 開局與開局庫區塊，顯示開局名稱、新着（`N`，若有）以及僅針對您這一側的開局庫提示——依棋手姓名比對 [[page:accounts]] 中已連結的 Lichess、Chess.com 或別名帳號來判斷您的一側；若無名稱相符，則以棋盤下方的一側為準（翻轉棋盤會改變該側）。它會指出您在何處離開開局庫（點擊可附帶箭頭聚焦該局面），或您一路跟隨到哪一步。若無法完整讀取開局庫檔案，僅會顯示一行淡色文字：{{label:Board.Analysis.Report.RepertoireIncomplete}}
- {{label:Board.Analysis.Report.KeyMoments}}：點擊任一列即可前往該步棋之前的局面，讓棋盤上的兩個箭頭（實際着法與較佳着法）都從該格出發。使用 {{label:Board.Analysis.Report.PreviousMoment}} 與 {{label:Board.Analysis.Report.NextMoment}} 依序瀏覽，或依 {{label:Board.Analysis.Report.FilterBoth}}、{{label:Board.Analysis.Report.FilterWhite}} 或 {{label:Board.Analysis.Report.FilterBlack}} 篩選。關鍵時刻亦會顯示 {{label:Board.Analysis.Report.Tag.TurningPoint}} 或 {{label:Board.Analysis.Report.Tag.TimeTrouble}} 等標籤，以及當引擎變着能證實時的失誤類型。
- 在 `?!`、`?` 與 `??` 時刻上，點擊 {{label:Board.Analysis.Report.Explain}} 可聚焦該局面並開啟 {{label:Board.Tabs.Coach}}，附上關於該時刻的問題。未設定任何 AI 連線時，此按鈕會隱藏。

若之後編輯了對局，請以 {{label:Board.Analysis.GenerateReport}} 或 {{label:Board.Analysis.Report.Regenerate}} 重新產生報告，以更新覆盤內容。
