---
id: browser-extension
title: 瀏覽器擴充功能與對局連結
summary: 使用 chessriddle-studio:// 對局連結直接在 Studio 中開啟 Lichess 與 Chess.com 對局。
source: 7059f7f7afa1559d
---

ChessRiddle Studio 會處理瀏覽器擴充功能或您的作業系統所傳送的 `chessriddle-studio://` 對局連結。

當開啟針對 Lichess 或 Chess.com 對局的 `chessriddle-studio://import?url=<game URL>` 連結時：
- Studio 會從 Lichess 或 Chess.com 擷取該對局的 PGN。
- 對局會在新的分析分頁中開啟，並將視窗切換至棋盤。
- 載入對局期間，通知會顯示進度；若無法擷取對局，則會回報錯誤。

在 macOS 與 Windows 上，安裝程式會自動登錄 `chessriddle-studio://` URL 配置。在 Linux AppImage 組建版本中，Studio 會在啟動時為 `chessriddle-studio://` 登錄桌面處理程式，讓瀏覽器能將連結交給應用程式處理。

您也可以在沒有擴充功能的情況下手動匯入任何 Lichess 或 Chess.com 對局網址：開啟 [[page:new-tab]]，點擊 {{label:Home.Card.ImportGame.Button}}，選擇 {{label:Import.Online}}，然後貼上 {{label:Import.GameURL}}。
