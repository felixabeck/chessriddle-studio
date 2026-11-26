---
id: analysis-board
title: 분석 보드, 변형 수순, 코멘트 및 화살표
summary: 수 입력, 포지션 편집, 변형 수순 관리, 코멘트 작성, 주석 추가 및 보드에 화살표 그리기.
source: 332d035e7fda54c8
---

[[page:new-tab]]에서 {{label:Home.Card.AnalysisBoard.Title}}을(를) 클릭하거나 [[page:library]]에서 저장된 대국이나 레퍼토리를 열어 분석 보드를 시작하세요.

기물을 드래그하거나 클릭하여 수를 둡니다([[setting:move-method]]에서 설정). [[setting:text-input]] ({{label:Settings.Inputs.TextInput}})을 활성화해 SAN 기보로 수를 직접 입력할 수도 있습니다. 기보 아래의 이동 컨트롤, 방향키 또는 마우스 휠([[setting:scroll-moves]]가 켜진 경우)을 사용해 수 사이를 이동하세요.

보드 위쪽 상단 표시줄에서 보드 작업을 실행할 수 있습니다:
- {{label:Board.Action.PlayFromHere}}: 현재 포지션에서 대국을 시작합니다.
- 보드 뒤집기 (`F`): 보드 아래쪽의 백과 흑 방향을 바꿉니다.
- 저장: 대국에 저장되지 않은 변경 사항이 있고 자동 저장이 꺼져 있거나, 사용할 수 없거나(예: 임시 초안), 실패했을 때 표시됩니다.
- {{label:Board.Action.More}}: {{label:Board.Database.Save}}(대국을 라이브러리 파일이나 데이터베이스에 저장), {{label:Board.Action.TakeSnapshot}}(현재 보드의 이미지 저장), {{label:Board.Action.EditPosition}}(기물을 배치하거나 FEN을 편집해 사용자 지정 포지션 설정) 메뉴를 엽니다.
- 실행 취소, 다시 실행 및 그려진 화살표나 칸 강조 지우기([[setting:erase-drawables]]가 꺼져 있을 때)는 [[settings-category:keybinds]]의 키보드 단축키를 사용합니다.

이전 포지션에서 다른 수를 두면 변형 수순이 만들어집니다. 기보에서 아무 수나 마우스 오른쪽 버튼으로 클릭해 {{label:Menu.PromoteVariation}}, {{label:Menu.PromoteToMainLine}}, {{label:Menu.CopyVariationPGN}}, {{label:Menu.DeleteMove}}, {{label:Menu.DeleteVariation}}, {{label:Menu.DeleteMovesAfter}}, {{label:Board.Action.PlayFromHere}}, {{label:Notation.AddDiagram}} 또는 {{label:Notation.MarkGameEndHere}}을(를) 선택하세요. 기보 헤더의 눈 버튼으로 {{label:Notation.HideMoves}}를 전환하고, {{label:Notation.ViewOptions}} 메뉴에서 {{label:Notation.TableView}}, {{label:Notation.ShowComments}}, {{label:Notation.ShowDiagrams}}, {{label:Notation.ShowVariations}}를 전환할 수 있습니다.

수에 주석을 달고 코멘트를 작성하려면 {{label:Board.Tabs.Annotate}} 탭을 여세요. 수 평가 기호를 클릭하거나 숫자 1~6 키를 눌러 `!!`, `!`, `!?`, `?!`, `?`, `??`를 전환하고, 형세 및 포지션 평가 기호는 {{label:Annotate.ShowMore}}을(를) 클릭해 확인하세요. 기호 아래의 서식 있는 텍스트 편집기에서 코멘트를 작성하고 인라인 보드 다이어그램을 추가하거나 숨길 수 있습니다.

화살표를 그리거나 칸을 강조하려면 보드 위에서 마우스 오른쪽 버튼을 누른 채 드래그하세요(칸에 원을 그리려면 마우스 오른쪽 버튼으로 클릭). 보조 키를 누른 채 그리면 색상이 달라집니다: Shift는 {{label:Settings.Drawing.Red}}, Alt는 {{label:Settings.Drawing.Blue}}, Shift+Alt는 {{label:Settings.Drawing.Yellow}}, Ctrl(macOS에서는 Cmd)은 {{label:Settings.Drawing.Orange}}, Ctrl+Alt(macOS에서는 Cmd+Alt)는 {{label:Settings.Drawing.Cyan}}입니다. 전체 그리기 목록은 [[settings-category:keybinds]]에서 확인할 수 있습니다.

{{label:Board.Tabs.Info}} 탭에는 대국 헤더, FEN, PGN 텍스트 및 트리 통계가 표시되며, 여러 대국이 담긴 PGN 파일에서 대국 간 전환도 할 수 있습니다.

분석 보드의 영역을 배치하려면 패널 탭({{label:Board.Tabs.Analysis}}, {{label:Board.Analysis.Report}}, {{label:Board.Tabs.Database}}, {{label:Board.Tabs.Annotate}}, {{label:Board.Tabs.Coach}} 또는 {{label:Board.Tabs.Info}})이나 엔진 카드의 여섯 점 손잡이를 드래그하거나 탭 막대, 기보 헤더, 패널 영역 헤더의 이동 손잡이 버튼을 사용해 미리보기 또는 키보드로 다른 영역의 옆, 위, 아래에 배치할 수 있습니다. 하나의 패널을 두 영역 위에 걸쳐 놓으려면(예: 기보와 탭 위에 {{label:Board.Tabs.Database}} 배치) 먼저 한 영역 위에 패널을 놓은 다음 다른 영역을 그 옆으로 옮기세요. 영역을 되돌리려면 {{label:Board.Area.ReturnToTabs}}(엔진 창은 {{label:Board.Area.ReturnToEngines}})를 누르거나 탭 목록 위로 드래그하세요.

레퍼토리, 게임, 상대 대비 탭은 각각 고유한 활성 레이아웃을 유지합니다. 세 가지 기본 프리셋({{label:Board.Layout.Preset.Repertoire}}, {{label:Board.Layout.Preset.GameReview}}, {{label:Board.Layout.Preset.Preparation}})이 포함되어 있으며, {{label:Board.Action.More}}({{label:Board.Layout.SaveAs}} 및 {{label:Board.Layout.Manage}}) 또는 {{label:Menu.View}}({{label:Board.Layout.SaveAs}} 및 {{label:Board.Layout.LayoutsMenu}})에서 직접 레이아웃을 저장하고 전환하거나 저장된 레이아웃의 이름을 바꾸고 삭제할 수 있습니다. [[setting:board-layout]]({{label:Settings.BoardLayout.Reset}})을 사용하면 저장된 레이아웃은 유지한 채 세 가지 탭 종류의 기본 레이아웃을 복원합니다.

탭을 숨기려면(예: 사용하는 모든 패널을 별도 영역으로 표시할 때) 탭 표시줄 끝 핸들 아래의 {{label:Board.Area.HideTabs}}을(를) 클릭하세요. 이웃한 영역이 그 자리를 차지합니다. 탭은 위치와 크기를 유지하며, 탭이 숨겨진 동안 기보 머리글에 나타나는 {{label:Board.Arrange.ShowTabs}} 버튼, 탭 단축키 또는 보고서 생성으로 다시 표시할 수 있습니다. 탭이 숨겨진 동안 되돌린 패널은 숨겨진 탭으로 들어갑니다.
