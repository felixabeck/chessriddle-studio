---
id: chessbase-import
title: 從 ChessBase 匯入資料庫
summary: 將 ChessBase 資料庫匯出為 PGN，並轉換為 Studio 資料庫。
source: d7f599a811a0afb0
---

ChessRiddle Studio 不會直接讀取 ChessBase 的 `.cbh` 或 `.cbv` 檔案。請先將您的 ChessBase 資料庫匯出為 PGN，再將該 PGN 檔案轉換為 Studio 資料庫。

若您在檔案選取器中選取了 ChessBase 檔案，Studio 會自動開啟 {{label:ChessBaseGuide.Title}} 對話方塊。您也可以從 [[page:library]] 上 {{label:Library.AddDatabase}} 內的指南連結開啟它。

請依下列步驟從 ChessBase 匯入：
1. 在 ChessBase 中開啟資料庫，並選取要匯出的對局。
2. 在 ChessBase 中將選取的對局匯出或儲存為 `.pgn` 檔案。
3. 在 Studio 中開啟 [[page:library]]，點擊 {{label:Library.AddDatabase}}，切換至 {{label:Common.Local}} 分頁，選取匯出的 `.pgn` 檔案，輸入 {{label:Common.Name}}，然後點擊 {{label:Databases.Add.Convert}}。

轉換完成後，資料庫會顯示在 [[page:library]] 中，您可以在此探索其中的對局、棋手與賽事，或將其設為 {{label:Databases.Settings.ReferenceDatabase}}。
