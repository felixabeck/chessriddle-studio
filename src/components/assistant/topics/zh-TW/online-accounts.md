---
id: online-accounts
title: 線上帳戶與對手備戰
summary: 新增 Lichess 與 Chess.com 帳戶、下載您的對局，並將線上帳戶連結至資料庫棋手以研究對手開局。
source: 7c518989c9948fec
---

在 [[page:accounts]] ({{label:SideBar.Accounts}}) 上管理您的 Lichess 與 Chess.com 帳戶。

若要新增帳戶：
1. 在 [[page:accounts]] 上點擊 {{label:Home.Accounts.Add}}。
2. 可選填或選取 {{label:Home.Accounts.PlayerName}}，將多個帳戶歸納在同一個棋手設定檔下。
3. 在 {{label:Home.Accounts.Website}} 下選擇 Lichess 或 Chess.com，並輸入 {{label:Home.Accounts.Username}}。
4. 針對 Lichess，可選擇勾選 {{label:Home.Accounts.LoginWithBrowser}} 以透過 OAuth 登入。登入後可加快對局下載速度，並可使用分析棋盤上的 Lichess 線上開局探索器。
5. 點擊 {{label:Common.Add}}。

在 [[page:accounts]] 上的每張帳戶卡片中：
- 點擊 {{label:Home.Accounts.UpdateStats}} 重新整理您的等級分與統計資料。
- 點擊下載按鈕將您的對局下載至本機資料庫（後續下載只會擷取上次下載後的新對局）。
- 點擊 {{label:Home.Accounts.RemoveAccount}} 移除帳戶。
- 下載對局後，[[page:accounts]] 右側會顯示您的個人統計資訊（{{label:Home.Personal.Overview}}、{{label:Home.Personal.Ratings}} 與 {{label:Home.Personal.Openings}}）。

若要從資料庫研究對手的線上開局：
1. 在 [[page:library]] 中開啟資料庫，並切換至 {{label:Databases.Card.Players}} 分頁。
2. 選取一位棋手開啟其棋手卡片。
3. 點擊 {{label:Databases.Opponent.Add}}，將一個或多個 Lichess 或 Chess.com 使用者名稱連結至該棋手。
4. 點擊 {{label:Databases.Opponent.Manage}} 依 {{label:Databases.OpeningTree.Since}} 與 {{label:Databases.Opponent.TimeControls}} 篩選，或執行 {{label:Databases.Opponent.RemoveGames}} 與 {{label:Databases.Opponent.Unlink}}。
5. 點擊 {{label:Databases.Opponent.Download}}（或 {{label:Databases.Opponent.Update}}）擷取對手的線上對局。
6. 在棋手卡片上開啟 {{label:Home.Personal.Openings}} 分頁以瀏覽其線下與線上開局樹、依棋色與 {{label:Databases.OpeningTree.Since}} 篩選，並點擊 {{label:Databases.OpeningTree.Prepare}} 在分析棋盤中開啟該變化，同時將對手的對局釘選於探索器中。
