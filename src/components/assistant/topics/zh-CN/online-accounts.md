---
id: online-accounts
title: 在线账户与对手备战
summary: 添加 Lichess 和 Chess.com 账户、下载您的对局，并将在线账户关联到数据库棋手以研究对手开局。
source: fb725d488406a0b7
---

在 [[page:accounts]] ({{label:SideBar.Accounts}}) 页面管理您的 Lichess 和 Chess.com 账户。

要添加账户：
1. 在 [[page:accounts]] 上点击 {{label:Home.Accounts.Add}}。
2. 可选输入或选择 {{label:Home.Accounts.PlayerName}}，将多个账户归入同一个棋手资料下。
3. 在 {{label:Home.Accounts.Website}} 下选择 Lichess 或 Chess.com，并输入 {{label:Home.Accounts.Username}}。
4. 对于 Lichess，可选勾选 {{label:Home.Accounts.LoginWithBrowser}} 通过 OAuth 登录。登录后可加快对局下载速度，并解锁分析棋盘上的 Lichess 在线开局探索器。
5. 点击 {{label:Common.Add}}。

在 [[page:accounts]] 上的每个账户卡片中：
- 点击 {{label:Home.Accounts.UpdateStats}} 刷新您的等级分和统计信息。
- 点击下载按钮将您的对局下载到本地数据库（之后的下载只会获取自上次下载以来的新对局）。
- 点击 {{label:Home.Accounts.RemoveAccount}} 移除该账户。
- 下载对局后，[[page:accounts]] 右侧会显示您的个人统计信息（{{label:Home.Personal.Overview}}、{{label:Home.Personal.Ratings}} 和 {{label:Home.Personal.Openings}}）。

要从数据库中研究对手的在线开局：
1. 在 [[page:library]] 中打开一个数据库，并切换到 {{label:Databases.Card.Players}} 标签页。
2. 选择一位棋手以打开其棋手卡片。
3. 点击棋手姓名旁的 {{label:Databases.Opponent.AddShort}}，将一个或多个 Lichess 或 Chess.com 用户名关联到该棋手。
4. 点击 {{label:Databases.Opponent.Manage}} 按 {{label:Databases.OpeningTree.Since}} 和 {{label:Databases.Opponent.TimeControls}} 筛选，或执行 {{label:Databases.Opponent.RemoveGames}} 与 {{label:Databases.Opponent.Unlink}}。
5. 点击 {{label:Databases.Opponent.Download}}（或 {{label:Databases.Opponent.Update}}）获取其在线对局。
6. 在棋手卡片的标签页（{{label:Home.Personal.Preparation}} 或 {{label:Home.Personal.Openings}}）中点击 {{label:Databases.OpeningTree.Prepare}}，即可在分析棋盘中打开并在探索器中固定对手的对局；如需浏览其慢棋与在线开局树、按执色和 {{label:Databases.OpeningTree.Since}} 筛选并先选择特定变化，请先打开 {{label:Home.Personal.Openings}}。
