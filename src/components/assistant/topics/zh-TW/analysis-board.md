---
id: analysis-board
title: 分析棋盤、變例、註解與箭頭
summary: 輸入著法、編輯局面、管理變例、撰寫註解、新增評註符號，以及在棋盤上繪製箭頭。
source: c4040958465a3812
---

從 [[page:new-tab]] 點擊 {{label:Home.Card.AnalysisBoard.Title}}，或從 [[page:library]] 開啟已儲存的對局或開局庫，即可開啟分析棋盤。

透過拖曳或點擊棋子走棋（在 [[setting:move-method]] 中設定）。您也可以啟用 [[setting:text-input]] ({{label:Settings.Inputs.TextInput}})，以 SAN 記譜法輸入著法。使用記譜下方的步進控制項、方向鍵或滑鼠滾輪（若啟用 [[setting:scroll-moves]]）來瀏覽著法。

記譜旁的工具列提供棋盤操作：
- {{label:Board.Action.TakeSnapshot}}：儲存目前棋盤的圖片。
- {{label:Board.Action.EditPosition}}：透過擺放棋子或編輯 FEN 設定自訂局面。
- {{label:Board.Action.PlayFromHere}}：從目前局面開始對弈。
- {{label:Board.Action.ClearDrawings}}：清除箭頭與棋格高亮（當 [[setting:erase-drawables]] 關閉時顯示）。
- {{label:Board.Database.Save}}：將對局儲存至資料庫檔案或資料庫中。
- 復原、重做、儲存與翻轉棋盤控制項。

在較早的局面走出不同的著法會建立變例。在記譜中的任何著法上按右鍵，即可選取 {{label:Menu.PromoteVariation}}、{{label:Menu.PromoteToMainLine}}、{{label:Menu.CopyVariationPGN}}、{{label:Menu.DeleteMove}}、{{label:Menu.DeleteVariation}}、{{label:Menu.DeleteMovesAfter}}、{{label:Board.Action.PlayFromHere}}、{{label:Notation.AddDiagram}} 或 {{label:Notation.MarkGameEndHere}}。使用記譜標題列按鈕可切換 {{label:Notation.HideMoves}}、{{label:Notation.TableView}}、{{label:Notation.HideComments}}、{{label:Notation.HideDiagrams}} 與 {{label:Notation.HideVariations}}。

若要為著法加上評註與撰寫註解，請開啟 {{label:Board.Tabs.Annotate}} 分頁。點擊著法品質符號（或按數字鍵 1 到 6）可切換 `!!`、`!`、`!?`、`?!`、`?` 或 `??`，或點擊 {{label:Annotate.ShowMore}} 查看評估與局面符號。在符號下方，使用格式文字編輯器撰寫註解並切換行內棋盤局面圖。

若要在棋盤上繪製箭頭與標記棋格，請按住滑鼠右鍵拖曳（或在棋格上按右鍵繪製圓圈）。按住輔助鍵可切換不同顏色：Shift 為 {{label:Settings.Drawing.Red}}、Alt 為 {{label:Settings.Drawing.Blue}}、Shift+Alt 為 {{label:Settings.Drawing.Yellow}}、Ctrl（macOS 為 Cmd）為 {{label:Settings.Drawing.Orange}}、Ctrl+Alt（macOS 為 Cmd+Alt）為 {{label:Settings.Drawing.Cyan}}。完整繪圖清單請參閱 [[settings-category:keybinds]]。

{{label:Board.Tabs.Info}} 分頁會顯示對局標頭、FEN、PGN 文字與變化樹統計資料，並可讓您在多對局 PGN 檔案中切換對局。

要調整分析棋盤的版面配置，可以拖曳面板分頁（{{label:Board.Tabs.Analysis}}、{{label:Board.Tabs.Database}}、{{label:Board.Tabs.Annotate}}、{{label:Board.Tabs.Coach}}或{{label:Board.Tabs.Info}}），或使用分頁列、記譜標題列或面板區域標題列上的拖曳手把按鈕，透過預覽或鍵盤將區域放置到其他區域的左側、右側、上方或下方。若要讓一個面板橫跨兩個區域（例如將{{label:Board.Tabs.Database}}放在記譜和分頁上方），請先將該面板放到其中一個區域上方，再把另一個區域移到它旁邊。點擊{{label:Board.Area.ReturnToTabs}}或將面板區域拖回分頁列即可放回分頁，使用[[setting:board-layout]]（{{label:Settings.BoardLayout.Reset}}）可還原預設版面。

若要隱藏分頁（例如所用的每個面板都已顯示為獨立區域時），請點擊分頁列末端拖曳把手下方的{{label:Board.Area.HideTabs}}，相鄰區域會佔用其空間。分頁會保留位置與大小：分頁隱藏時，棋譜標題列會出現{{label:Board.Arrange.ShowTabs}}按鈕，點擊它、使用分頁快捷鍵或產生報告即可重新顯示。分頁隱藏時放回的面板會進入隱藏的分頁。
