---
id: browser-extension
title: 브라우저 확장 프로그램과 대국 링크
summary: chessriddle-studio:// 대국 링크를 사용해 Lichess 및 Chess.com 대국을 Studio에서 바로 열기.
source: 7059f7f7afa1559d
---

ChessRiddle Studio는 브라우저 확장 프로그램이나 운영 체제에서 전달하는 `chessriddle-studio://` 대국 링크를 처리합니다.

Lichess 또는 Chess.com 대국에 대한 `chessriddle-studio://import?url=<game URL>` 링크가 열리면:
- Studio가 Lichess 또는 Chess.com에서 해당 대국의 PGN을 가져옵니다.
- 새 분석 탭에서 대국이 열리고 창이 보드로 전환됩니다.
- 대국을 불러오는 동안 알림에 진행 상태가 표시되며, 대국을 가져올 수 없는 경우 오류가 보고됩니다.

macOS와 Windows에서는 설치 프로그램이 `chessriddle-studio://` URL 스킴을 자동으로 등록합니다. Linux AppImage 빌드에서는 브라우저가 앱으로 링크를 전달할 수 있도록 Studio 실행 시 `chessriddle-studio://`용 데스크톱 핸들러를 등록합니다.

확장 프로그램 없이도 Lichess 또는 Chess.com 대국 URL을 수동으로 불러올 수 있습니다. [[page:new-tab]]을 열고 {{label:Home.Card.ImportGame.Button}}을(를) 클릭한 뒤 {{label:Import.Online}}을(를) 선택하고 {{label:Import.GameURL}}을(를) 붙여넣으세요.
