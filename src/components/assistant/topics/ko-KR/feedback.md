---
id: feedback
title: 피드백, 로그, 저장된 데이터 지우기 및 업데이트
summary: 피드백 보내기, 애플리케이션 로그 열기, 저장된 데이터 다시 불러오기 또는 지우기, 앱 버전 확인 및 업데이트 설치하기.
source: 8b0ca5aebb70e04f
---

버그를 신고하거나, 기능을 제안하거나, 칭찬을 남기거나, 기타 의견을 개발자에게 직접 전달하려면 [[feedback]] ({{label:Menu.Help.SendFeedback}})을(를) 사용하세요.

탐색 줄의 {{label:Navigation.Feedback}} 버튼 또는 {{label:Menu.Help}} -> {{label:Menu.Help.SendFeedback}}을 통해 언제든지 피드백 양식을 열 수 있습니다.

피드백 양식에서는 유형({{label:Feedback.Type.Bug}}, {{label:Feedback.Type.Suggestion}}, {{label:Feedback.Type.Praise}} 또는 {{label:Feedback.Type.Other}})을 선택하고, 메시지(10~5,000자)를 작성하며, 원할 경우 회신을 받을 이메일 주소를 입력하고, 스크린샷({{label:Feedback.TakeScreenshot}})이나 이미지({{label:Feedback.ChooseImage}})를 첨부할 수 있습니다. 앱 버전과 운영 체제 정보도 메시지와 함께 전송됩니다.

Assistant가 피드백 초안을 작성해 주면 [[feedback]]을(를) 클릭할 때 해당 초안이 미리 채워진 상태로 양식이 열립니다. 내용을 검토한 뒤 {{label:Feedback.Submit}}을(를) 클릭하기 전까지는 아무것도 전송되지 않습니다.

문제 해결 도구는 [[settings-category:advanced]] ({{label:Settings.Advanced}})에 있습니다:
- **로그**: [[setting:open-logs]] ({{label:Menu.Help.OpenLogs}})을(를) 열어 애플리케이션 로그 파일이 들어 있는 폴더를 엽니다.
- **새로고침**: [[setting:reload]] ({{label:Menu.View.Reload}})을(를) 열어 애플리케이션 창을 다시 불러옵니다.
- **저장된 데이터 지우기**: [[setting:clear-saved-data]] ({{label:Menu.Help.ClearSavedData}})을(를) 열어 확인 후 저장된 설정과 세션 데이터를 초기화합니다. 작업 공간의 PGN 파일이나 데이터베이스는 삭제되지 않으며, 연습 데이터를 안전하게 마이그레이션할 수 없는 경우에는 차단됩니다.

**앱 버전 및 업데이트**:
- {{label:Menu.Help}} -> {{label:Menu.Help.About}}(macOS에서는 애플리케이션 메뉴 아래) 또는 [[page:settings]] 맨 아래에서 설치된 버전, Tauri 버전 및 운영 체제를 확인하세요.
- Studio는 시작 후 자동으로 업데이트를 확인합니다. 업데이트가 있으면 다운로드 및 설치 여부를 묻는 확인 대화상자가 나타납니다. 저장하지 않은 변경 사항이 있는 경우 저장하거나 앱을 다시 시작할 때까지 재시작이 보류됩니다.
