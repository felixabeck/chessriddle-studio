---
id: databases
title: 資料庫、開局探索器、局面搜尋、棋手與賽事
summary: 新增或下載棋局資料庫、選取參考資料庫、在探索器中搜尋局面，以及瀏覽對局、棋手與賽事。
source: 221e2b80a6351752
---

資料庫與您的 PGN 檔案一同位在 [[page:library]] ({{label:SideBar.Library}}) 中，並儲存於 [[setting:databases-directory]]。

若要新增資料庫，請開啟 [[page:library]] 並點擊 {{label:Library.AddDatabase}}：
- {{label:Databases.Add.Web}}：從目錄下載精選棋局資料庫。
- {{label:Common.Local}}：選取本機 PGN 檔案（包括 `.pgn.zst` 或 `.pgn.bz2`），輸入 {{label:Common.Name}} 與選填的 {{label:Common.Description}}，然後點擊 {{label:Databases.Add.Convert}}。

在 [[page:library]] 中選取資料庫以進行管理：
- 勾選 {{label:Databases.Settings.ReferenceDatabase}}，將其設為探索器、開局庫建立器、對局報告新著與 Coach 的預設參考資料庫。
- 勾選 {{label:Databases.Settings.Indexed}} 以建立或移除搜尋索引，加快查詢速度。
- 點擊 {{label:Databases.Settings.Explore}} 開啟資料庫表格檢視。
- 在 {{label:Databases.Settings.Actions}} 下，使用 {{label:Databases.Settings.AddGames}} 附加 PGN 檔案、使用 {{label:Databases.Settings.ExportPGN}} 匯出為 PGN，或使用 {{label:Common.Delete}} 刪除資料庫。
- 在 {{label:Databases.Settings.AdvancedTools}} 下，使用 {{label:Databases.Settings.MergePlayers}} 合併重複的棋手項目，或使用 {{label:Databases.Settings.RemoveDup}} 與 {{label:Databases.Settings.RemoveEmpty}} 清理對局。

在資料庫表格檢視中，可在 {{label:Common.Games}}、{{label:Databases.Card.Players}} 與 {{label:Databases.Settings.Events}}（賽事）之間切換：
- 搜尋與排序對局、預覽對局（預覽可用眼睛按鈕隱藏著法，[[setting:hide-preview-moves]]），或在分析棋盤上開啟。
- 在 {{label:Databases.Card.Players}} 中選取一位棋手，可檢視 {{label:Home.Personal.Overview}}、{{label:Home.Personal.Ratings}} 與 {{label:Home.Personal.Openings}}（附有 {{label:Databases.OpeningTree.Prepare}} 按鈕的互動式開局樹），以及透過 {{label:Databases.FIDE.Info}} 查看國際棋總（FIDE）資訊。
- 在 {{label:Databases.Settings.Events}} 中依名稱搜尋賽事，並依日期、棋手數、對局數或平均 Elo 排序。

在棋手卡片中開啟 {{label:Home.Personal.Preparation}} 分頁，將對手的對局與您的開局庫檔案進行比較：
- 選擇對手的執棋顏色、{{label:Databases.OpeningTree.Since}} 期間，以及（在連結線上帳戶時）{{label:Databases.OpeningTree.OverTheBoard}}、{{label:Databases.OpeningTree.Online}} 或 {{label:Databases.Preparation.Both}}。點擊 {{label:Databases.Preparation.Refresh}} 可重新執行比較。
- 提高 {{label:Databases.Preparation.MinGames}} 可隱藏對手很少下過的變化和漏洞；你的檔案會摺疊這些變化，訓練也會略過它們。
- 檢視對手常下的變化以及 {{label:Databases.Preparation.GapsTitle}}。點擊任一列即可在該局面開啟您的開局庫檔案並隱藏其他旁枝；在記譜標頭可在 {{label:Notation.PreparationOpponentLines}} 與 {{label:Notation.PreparationAllLines}} 之間切換。
- 點擊 {{label:Databases.Preparation.TrainLines}} 開始這些變化的計時練習；您的作答會更新正常的間隔重複排程。
- 若要針對僅有 Lichess 或 Chess.com 帳戶的對手進行準備，請在 [[page:library]] 中點擊 {{label:Library.OnlineOpponent}}，尋找並確認其帳戶、下載對局，並直接在 {{label:Home.Personal.Preparation}} 分頁開啟棋手卡片（再次輸入同一帳戶時將直接開啟而不會重複下載）。

在分析棋盤上，開啟 {{label:Board.Tabs.Database}} 分頁以使用開局探索器：
- 在來源下拉選單和 {{label:Board.Database.Compare}} 中選擇 {{label:Board.Database.LichessAll}} 或 {{label:Board.Database.LichessMaster}}（Lichess 線上探索器需要在 [[page:accounts]] 登入 Lichess 帳戶）。
- 上方顯示 {{label:Board.Database.Stats}}（著法統計），下方顯示 {{label:Board.Database.Games}}（相符對局）；當兩個區域同時顯示時，可拖曳中間的分隔線分配高度。使用 {{label:Board.Database.HideGames}} 或 {{label:Board.Database.ShowGames}} 隱藏或顯示對局清單，使用設定齒輪展開或摺疊來源控制項——當面板為獨立區塊時，這兩個圖示位於面板標頭中；當其位於分頁中時，位於頂部控制列上。{{label:Board.Area.Notation}} 欄會顯示從目前棋盤局面開始的後續著法，並將下一步著法加粗。
- 點擊 {{label:Board.Database.Compare}} 可並排檢視兩個來源，或開啟 {{label:Board.Database.Local.Position}} 在 {{label:Board.Database.Local.Exact}} 與 {{label:Board.Database.Local.Partial}} 局面搜尋之間切換（包括用於兵型結構搜尋的 {{label:Board.Database.Local.SimilarStructure}} 與用於自訂樣式的 {{label:Fen.Empty}}）。
- 你也可以在分析棋盤上將 {{label:Board.Tabs.Database}} 顯示為獨立區域，並使用 {{label:Board.Area.ReturnToTabs}} 將其放回分頁中。
- 當透過 {{label:Databases.OpeningTree.Prepare}} 為資料庫棋手開啟棋盤時，探索器會先把參考資料庫作為額外一欄顯示在對手對局旁；點擊 {{label:Board.Database.RemoveReference}} 可隱藏一欄，點擊 {{label:Board.Database.AddColumn}} 可再新增一欄。
