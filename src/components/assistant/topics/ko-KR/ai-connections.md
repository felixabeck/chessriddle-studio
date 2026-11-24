---
id: ai-connections
title: Coach 및 AI 연결
summary: 분석 보드의 Coach와 Assistant를 활성화하기 위해 AI 공급자 또는 로컬 모델 연결하기.
source: eac73d15e14729e1
---

AI 연결은 분석 보드의 Coach와 Assistant 모두에 사용됩니다. [[settings-category:coach]] ({{label:Settings.AI}})에서 연결을 관리하세요.

연결을 추가하려면 [[settings-category:coach]]에서 다음 옵션 중 하나를 선택하세요:
- {{label:Settings.Coach.SignIn.ChatGpt}}: 브라우저에서 ChatGPT 계정으로 로그인합니다.
- {{label:Settings.Coach.SignIn.Grok}}: 기기 코드를 사용해 Grok으로 로그인합니다(비공식).
- {{label:Settings.Coach.Connections.Add}}: OpenAI 호환 기본 주소와 선택 사항인 API 키를 입력합니다. OpenAI, Google Gemini, DeepSeek, Qwen, OpenRouter, Ollama, LM Studio용 프리셋이 제공됩니다.

키와 로그인 자격 증명은 컴퓨터의 시스템 키링에 저장됩니다. 하나 이상의 연결이 저장되면 {{label:Menu.Help}} 메뉴({{label:Menu.Help.Assistant}})와 탐색 줄({{label:Navigation.Assistant}})에 Assistant가 나타납니다.

[[setting:coach-model]] ({{label:Settings.Coach.Model}})에서 연결, 모델 및 추론 강도를 선택하세요. Coach와 Assistant는 모두 이 하나의 선택으로 응답합니다. 두 패널 모두에서 {{label:Coach.Send}} 옆에 있는 모델 버튼은 어떤 모델이 응답하는지 보여주고 같은 선택을 변경하며, {{label:Coach.NewConversation}}이 그 옆에 있습니다.

연결을 검증하고 사용 가능한 모델을 나열하려면 {{label:Settings.Coach.Connection.Check}}을(를), 연결을 제거하려면 {{label:Settings.Coach.Connection.Remove}}을(를) 사용하세요.

분석 보드에서 Coach를 사용하려면:
- {{label:Board.Tabs.Coach}} 탭을 엽니다(또는 {{label:Settings.Keybinds.Actions.COACH_TAB}} 단축키를 누릅니다).
- Coach가 분석 수순을 검증하려면 로컬 체스 엔진이 필요합니다. [[setting:coach-engine]] ({{label:Settings.Coach.Engine}})에서 사용할 엔진을 선택하거나 [[page:engines]] ({{label:SideBar.Engines}})에서 엔진을 설치하세요.
- 현재 포지션에 대해 질문하세요. 특정 연결로 첫 메시지를 보내기 전에 Studio는 전송되는 항목(포지션, 현재 대국 PGN, 엔진 분석, 선택한 경우 참조 데이터베이스 수 통계, 일치하는 레퍼토리 수순)을 나열한 안내를 표시합니다.
- Coach 응답의 수순에 마우스를 올리거나 클릭하면 대국을 바꾸지 않고 미니 보드에서 미리 볼 수 있습니다. 수순 옆의 {{label:Coach.InsertLine}}을(를) 클릭하면 변형 수순으로 삽입됩니다.
