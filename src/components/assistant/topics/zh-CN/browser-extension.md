---
id: browser-extension
title: 浏览器扩展与对局链接
summary: 使用 chessriddle-studio:// 对局链接在 Studio 中直接打开 Lichess 和 Chess.com 对局。
source: 7059f7f7afa1559d
---

ChessRiddle Studio 会处理由浏览器扩展或操作系统发送的 `chessriddle-studio://` 对局链接。

当打开针对 Lichess 或 Chess.com 对局的 `chessriddle-studio://import?url=<game URL>` 链接时：
- Studio 会从 Lichess 或 Chess.com 获取该对局的 PGN。
- 对局会在新的分析标签页中打开，并将窗口切换到棋盘。
- 在加载对局期间，通知会显示进度；如果无法获取对局，则会报告错误。

在 macOS 和 Windows 上，安装程序会自动注册 `chessriddle-studio://` URL 协议。在 Linux AppImage 构建版本中，Studio 会在启动时为 `chessriddle-studio://` 注册桌面处理程序，以便浏览器将链接移交给应用。

您也可以不使用扩展，手动导入任意 Lichess 或 Chess.com 对局 URL：打开 [[page:new-tab]]，点击 {{label:Home.Card.ImportGame.Button}}，选择 {{label:Import.Online}}，然后粘贴 {{label:Import.GameURL}}。
