---
id: game-report
title: 게임 복기 및 보고서
summary: 로컬 엔진으로 기보를 분석하여 정확도, 평가 및 시간 그래프, 오프닝과 레퍼토리 메모, 보드 위 주요 장면을 확인합니다.
source: d1a4339820f36de2
---

게임 보고서는 로컬 체스 엔진으로 메인라인의 모든 수를 분석하고 그 결과를 단계별 게임 복기로 정리해 줍니다.

보고서를 생성하려면 분석 보드에서 기보를 열고 {{label:Board.Analysis.Report}} 탭으로 이동한 뒤 {{label:Board.Analysis.GenerateReport}}를 클릭하거나 {{label:Settings.Keybinds.Actions.GENERATE_REPORT}} 단축키를 누르세요.

{{label:Board.Analysis.GenerateReport}} 대화상자에서:
- 로컬 {{label:Common.Engine}}을 선택합니다. 설치된 엔진이 없다면 [[page:engines]]에서 추가할 수 있습니다.
- 수당 탐색 제한(깊이, 시간 또는 노드 수)을 설정합니다.
- 수 품질 기호(`!!`, `!`, `!?`, `?!`, `?`, `??`)를 표시하려면 {{label:Board.Analysis.MarkMoves}}를 켭니다.
- 기보에 더 나은 수 변화도를 추가하려면 {{label:Board.Analysis.ShowVariations}}를 켭니다.
- 참고 데이터베이스에서 처음 벗어나는 수에 `N`을 표시하려면 {{label:Board.Analysis.AnnotateNovelties}}를 켭니다. 이 옵션은 [[page:library]]에서 준비된 참고 데이터베이스가 선택되어 있어야 합니다.
- 시작하려면 {{label:Board.Analysis.Analyze}}를 클릭합니다.

보고서가 실행되는 동안 진행 버튼에서 취소할 수 있습니다. 메인라인을 편집해도 진행 중인 보고서가 취소됩니다.

완료되면 {{label:Board.Analysis.Report}}에 다음이 표시됩니다:
- 사용한 엔진, 탐색 제한, 날짜가 적힌 간결한 헤더와 그 옆의 작은 {{label:Board.Analysis.Report.Regenerate}} 버튼. 전체 너비의 {{label:Board.Analysis.GenerateReport}} 버튼은 현재 보고서가 없을 때만 표시됩니다.
- 균형 잡힌 포지션에서 시작한 게임이라면 스코어보드 위에 한 문장 요약이 표시됩니다. 불균형한 시작 포지션에서는 요약 문장이 표시되지 않습니다.
- 플레이어 이름과 레이팅, 대표 수치인 {{label:Board.Analysis.Accuracy}}, {{label:Board.Analysis.Report.AverageLoss}}, 게임 단계별 정확도, 그리고 0이 흐리게 표시되는 여섯 가지 수 품질 행을 담은 하나의 스코어보드. 0이 아닌 숫자를 클릭하면 해당 수로 이동하며, 각 항목 라벨에 마우스를 올리거나 키보드로 포커스하면 의미를 설명해 줍니다.
- {{label:Board.Analysis.Report.Evaluation}}(0 기준선 포함)과 {{label:Board.Analysis.Report.WinChance}}를 전환하는 그래프(마우스 오버 또는 키보드 포커스 시 각 보기 설명 제공). 절반 이상의 수에 시계 시간이 기록되어 있으면 그래프 아래에 {{label:Board.Analysis.Report.TimeUsage}} 막대가 나타나며, 막대를 클릭하면 해당 수로 이동합니다.
- 오프닝 이름, 새 수(`N`)가 있을 때의 표시, 그리고 내 진영에 대한 레퍼토리 메모를 담은 오프닝 및 레퍼토리 영역. 진영은 [[page:accounts]]에 연결된 Lichess, Chess.com 또는 별칭 계정과 플레이어 이름을 대조해 결정하며, 일치하는 이름이 없으면 보드 아래쪽 진영을 기준으로 합니다(보드를 뒤집으면 해당 진영도 바뀝니다). 레퍼토리를 벗어난 위치(클릭 시 화살표와 함께 해당 포지션에 포커스)나 어디까지 따라갔는지를 보여 줍니다. 레퍼토리 파일을 완전히 읽지 못한 경우에는 흐린 안내 한 줄만 표시됩니다: {{label:Board.Analysis.Report.RepertoireIncomplete}}
- {{label:Board.Analysis.Report.KeyMoments}}: 행을 클릭하면 해당 수를 두기 직전 포지션으로 이동해 보드 위의 두 화살표(실제로 둔 수와 더 나은 수)가 모두 그 칸에서 시작합니다. {{label:Board.Analysis.Report.PreviousMoment}}와 {{label:Board.Analysis.Report.NextMoment}}로 차례대로 넘기거나 {{label:Board.Analysis.Report.FilterBoth}}, {{label:Board.Analysis.Report.FilterWhite}}, {{label:Board.Analysis.Report.FilterBlack}}으로 필터링할 수 있습니다. 각 장면에는 {{label:Board.Analysis.Report.Tag.TurningPoint}}이나 {{label:Board.Analysis.Report.Tag.TimeTrouble}} 같은 태그와 엔진 수순으로 확인되는 실수 유형도 함께 표시됩니다.
- `?!`, `?`, `??` 장면에서는 {{label:Board.Analysis.Report.Explain}}을 클릭해 해당 포지션에 포커스하고 그 장면에 대한 질문과 함께 {{label:Board.Tabs.Coach}}를 열 수 있습니다. AI 연결이 설정되어 있지 않으면 이 버튼은 숨겨집니다.

나중에 기보를 수정했다면 {{label:Board.Analysis.GenerateReport}} 또는 {{label:Board.Analysis.Report.Regenerate}}로 보고서를 다시 생성해 복기 내용을 업데이트하세요.
