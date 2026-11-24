---
id: databases
title: 資料庫、開局探索器、局面搜尋、棋手與賽事
summary: 新增或下載棋局資料庫、選取參考資料庫、在探索器中搜尋局面，以及瀏覽對局、棋手與賽事。
source: 48c72137fadc1768
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
- 搜尋與排序對局、預覽對局，或在分析棋盤上開啟。
- 在 {{label:Databases.Card.Players}} 中選取一位棋手，可檢視 {{label:Home.Personal.Overview}}、{{label:Home.Personal.Ratings}} 與 {{label:Home.Personal.Openings}}（附有 {{label:Databases.OpeningTree.Prepare}} 按鈕的互動式開局樹），以及透過 {{label:Databases.FIDE.Info}} 查看國際棋總（FIDE）資訊。
- 在 {{label:Databases.Settings.Events}} 中依名稱搜尋賽事，並依日期、棋手數、對局數或平均 Elo 排序。

在分析棋盤上，開啟 {{label:Board.Tabs.Database}} 分頁以使用開局探索器：
- 在 {{label:Board.Database.Local}}、{{label:Board.Database.LichessAll}} 與 {{label:Board.Database.LichessMaster}} 之間切換（Lichess 線上探索器需要在 [[page:accounts]] 登入 Lichess 帳戶）。
- 在 {{label:Board.Database.Stats}}（著法統計）與 {{label:Board.Database.Games}}（相符對局）之間切換。
- 針對本機資料庫，點擊 {{label:Board.Database.Compare}} 可並排檢視兩個資料庫，或開啟 {{label:Board.Database.Local.Position}} 在 {{label:Board.Database.Local.Exact}} 與 {{label:Board.Database.Local.Partial}} 局面搜尋之間切換（包括用於兵型結構搜尋的 {{label:Board.Database.Local.SimilarStructure}} 與用於自訂樣式的 {{label:Fen.Empty}}）。
- 使用 {{label:Board.Database.Pin}} 將探索器釘選在棋盤或記譜上方或下方，並使用 {{label:Board.Database.Unpin}} 將其放回分頁中。
