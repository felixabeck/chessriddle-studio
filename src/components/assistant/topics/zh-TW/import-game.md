---
id: import-game
title: 匯入對局
summary: 從 PGN 檔案、貼上的 PGN 文字、Lichess 或 Chess.com 網址、FEN 局面，或手寫紀錄紙的照片或 PDF 掃描檔匯入對局。
source: 2a3b47d982e0f514
---

若要匯入對局或局面，請開啟 [[page:new-tab]] 並點擊 {{label:Home.Card.ImportGame.Button}} 以開啟 {{label:Home.Card.ImportGame.Title}} 對話方塊。您也可以透過 {{label:Menu.File}} -> {{label:Menu.File.OpenFile}}（或 {{label:Settings.Keybinds.Actions.OPEN_FILE}} 快捷鍵）直接開啟 PGN 檔案。

在 {{label:Home.Card.ImportGame.Title}} 對話方塊中，選擇以下選項之一：
- **PGN**：從電腦選取一個 {{label:Common.PGNFile}}，或將文字貼入 {{label:Common.PGNGame}}。勾選 {{label:Import.SaveToCollection}} 可將複本儲存至 [[page:library]] 的工作區資料夾，接著輸入 {{label:Common.Name}} 並選擇 {{label:Files.FileType}}。
- **{{label:Import.Online}}**：貼上 Lichess 或 Chess.com 的 {{label:Import.GameURL}} 以擷取對局並在分析棋盤上開啟。
- **FEN**：貼上 FEN 字串，以從該局面開啟分析棋盤。
- **{{label:Import.FromPhoto}}**（當 AI 功能可用時）：將 1 至 4 張手寫紀錄紙照片或 PDF 頁面辨識為新對局。這需要在 [[settings-category:coach]]（{{label:Settings.AI}}）中至少有一個 AI 連線。

對於 PGN、{{label:Import.Online}} 與 FEN，點擊 {{label:Home.Card.ImportGame.Button}} 將對局載入目前分頁。

要使用 **{{label:Import.FromPhoto}}** 匯入：
- 透過 {{label:Scoresheet.Intake.ChoosePhotos}}、{{label:Scoresheet.Intake.PasteFromClipboard}}（或在面板開啟時按 Ctrl+V / Cmd+V），或將照片或 PDF 檔案拖放到開啟的面板中，加入最多 4 張 JPEG、PNG 或 WebP 照片或 PDF 頁面。貼上僅適用於照片。每個 PDF 頁面算作一張照片；較長的 PDF 只使用前幾頁。
- 透過模型按鈕或在 [[setting:coach-model]]（{{label:Settings.Coach.Model}}）中選擇 AI 連線與支援影像的模型。
- 點擊 {{label:Scoresheet.Read.Button}} 開始辨識。在某個連線上首次讀取前，{{label:Scoresheet.Notice.Title}} 會說明所選照片（包含棋手姓名與紀錄紙上書寫的其他內容）會傳送給該供應商，相機位置等中繼資料會先被移除，且不會傳送其他任何資料。
- Studio 會依標準西洋棋規則從初始局面檢查每一步棋，並在新的未儲存分析分頁中開啟對局，棋盤旁附有 {{label:Board.Tabs.Photo}} 面板。
- 存疑或經過修正的著法會在棋譜中標記為不確定。在 {{label:Board.Tabs.Photo}} 面板中逐一查看，並在核對後點擊 {{label:Scoresheet.MarkAsChecked}}。若您在中途修正了著法或從中斷處繼續，可點擊 {{label:Scoresheet.ContinueWithSheet}} 自動重演紀錄紙上的後續合法著法。完成後點擊 {{label:Scoresheet.FinishReview}} 清除剩餘標記。
- 使用一般儲存流程（{{label:Menu.File}} -> {{label:Common.Save}}、儲存按鈕或 {{label:Board.Database.Save}}）將對局儲存到檔案或資料庫。
- 照片僅保存在記憶體中（最多保留 4 個開啟分頁），不會寫入磁碟；重新載入或重新啟動後，對局與核對標記仍會保留，您可在 {{label:Board.Tabs.Photo}} 面板中使用 {{label:Scoresheet.LoadPhotoAgain}} 重新檢視照片而無需再次傳送。
