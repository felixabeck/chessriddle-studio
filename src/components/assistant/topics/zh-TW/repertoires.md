---
id: repertoires
title: 開局庫
summary: 建立開局庫、依據參考資料庫建構覆蓋範圍、透過間隔重複練習，並追蹤未完成的變例與轉置。
source: 62b7ff51627518a7
---

開局庫是類型為「開局庫」的 PGN 檔案，會在分析棋盤上新增 {{label:Board.Tabs.Practice}} 分頁。

若要建立開局庫，請開啟 [[page:new-tab]] 並點擊 {{label:Home.Card.NewRepertoire.Title}}（或在 [[page:library]] 中建立開局庫檔案）。輸入 {{label:Common.Name}}，選取 {{label:Common.WHITE}} 或 {{label:Common.BLACK}}，然後點擊 {{label:Common.Create}}。

在 {{label:Board.Tabs.Practice}} -> {{label:Board.Practice.Build}} 中建立您的開局庫：
- 在 [[page:library]] 中設定一個 {{label:Databases.Settings.ReferenceDatabase}}，讓建立器能顯示著法頻率與覆蓋率。
- 在空白開局庫中，您可以從內建的 {{label:Board.Practice.Build.Presets}} 之一開始，或直接在棋盤上輸入著法。
- 使用 {{label:Board.Practice.Build.SetAsStart}}（或在記譜中的著法上按右鍵並選取 {{label:Menu.MarkAsStart}}）標記您開局庫的起始局面。
- 點擊 {{label:Board.Practice.Build.OpponentMoves}} 或 {{label:Board.Practice.Build.YourResponse}} 中的著法以新增或跟隨變化。使用 {{label:Board.Practice.Build.NextGap}} 與 {{label:Board.Practice.Build.BiggestGap}} 跳轉至超過 [[setting:repertoire-depth]] 所設最小對局數且尚未覆蓋的對手應著。

在 {{label:Board.Tabs.Practice}} -> {{label:Board.Practice.Train}} 中練習您的開局庫：
- 點擊 {{label:Board.Practice.StartPractice}} 透過間隔重複練習到期與新局面，或點擊 {{label:Board.Practice.PracticeFullRepertoire}} 練習開局庫中的所有局面。
- 在棋盤上走出您準備好的著法。若走錯後卡住，請點擊 {{label:Board.Practice.ShowMove}}。
- 使用 {{label:Board.Practice.ShowAll}} 檢視所有卡片、使用 {{label:Board.Practice.ShowLogs}} 檢視紀錄，或使用 {{label:Common.Reset}} 重設進度。
- 有到期卡片的開局庫也會顯示在 [[page:new-tab]] 上的 {{label:Home.Library.Due}} 篩選條件下。
- 在 [[settings-category:repertoire]]（[[setting:practice-grading]]、[[setting:practice-new-per-session]]）中設定間隔重複評分與每次練習的新卡片上限。

在分析棋盤的記譜中：
- 只有一步長的旁支會以虛線框標示為 {{label:Notation.OpenVariation}}，方便您找出尚未完成的分支。按下 {{label:Settings.Keybinds.Actions.NEXT_OPEN_VARIATION}} 快捷鍵可跳至下一個未完成分支。
- 當同一開局庫的另一個分支中也出現相同局面時，著法旁會顯示 {{label:Notation.Transposition}} 圖示；點擊即可跳轉至該分支。
