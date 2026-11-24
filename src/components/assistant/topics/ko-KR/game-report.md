---
id: game-report
title: 게임 보고서
summary: 정확도, 평가 그래프, 주요 장면 및 수 분류를 확인하는 자동 엔진 검토 실행하기.
source: a5e00adfe821f3f3
---

게임 보고서는 로컬 체스 엔진으로 메인 라인의 모든 수를 분석하여 대국의 정확도와 실수를 요약합니다.

보고서를 생성하려면 분석 보드에서 대국을 열고 {{label:Board.Tabs.Analysis}} -> {{label:Board.Analysis.Report}}로 이동한 뒤 {{label:Board.Analysis.GenerateReport}}을(를) 클릭하세요(또는 {{label:Settings.Keybinds.Actions.GENERATE_REPORT}} 단축키 사용).

{{label:Board.Analysis.GenerateReport}} 대화상자에서:
- 로컬 {{label:Common.Engine}}을(를) 선택합니다. 설치된 엔진이 없다면 [[page:engines]]에서 추가하세요.
- 수당 탐색 제한(깊이, 시간 또는 노드 수)을 설정합니다.
- 수에 품질 기호를 표시하려면 {{label:Board.Analysis.MarkMoves}}을(를) 켭니다.
- 기보에 더 나은 수순을 변형 수순으로 삽입하려면 {{label:Board.Analysis.ShowVariations}}을(를) 켭니다.
- 참조 데이터베이스에서 벗어난 첫 수를 표시하려면 {{label:Board.Analysis.AnnotateNovelties}}을(를) 켭니다. 이 옵션을 사용하려면 [[page:library]]에서 준비된 참조 데이터베이스가 선택되어 있어야 합니다.
- {{label:Board.Analysis.Analyze}}을(를) 클릭해 시작합니다.

보고서가 실행되는 동안 진행 버튼에서 취소할 수 있습니다. 메인 라인을 편집하면 진행 중인 보고서가 취소됩니다.

완료되면 {{label:Board.Analysis.Report}}에 다음 항목이 표시됩니다:
- {{label:Common.WHITE}} 및 {{label:Common.BLACK}}의 정확도 백분율과 평균 센티폰 손실(ACPL).
- 대국 전체의 평가 그래프.
- {{label:Board.Analysis.Report.KeyMoments}}: 평가 변화량과 더 나은 수를 보여주는 표시된 수의 클릭 가능한 목록.
- 횟수를 클릭하면 해당 수로 이동하는 수 품질별 분류 표.

나중에 대국을 수정했다면 {{label:Board.Analysis.RegenerateReport}}을(를) 클릭해 새 분석을 실행하세요.
