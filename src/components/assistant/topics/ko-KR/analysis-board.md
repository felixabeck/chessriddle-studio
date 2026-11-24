---
id: analysis-board
title: 분석 보드, 변형 수순, 코멘트 및 화살표
summary: 수 입력, 포지션 편집, 변형 수순 관리, 코멘트 작성, 주석 추가 및 보드에 화살표 그리기.
source: 14ba83ba3068d6ed
---

[[page:new-tab]]에서 {{label:Home.Card.AnalysisBoard.Title}}을(를) 클릭하거나 [[page:library]]에서 저장된 대국이나 레퍼토리를 열어 분석 보드를 시작하세요.

기물을 드래그하거나 클릭하여 수를 둡니다([[setting:move-method]]에서 설정). [[setting:text-input]] ({{label:Settings.Inputs.TextInput}})을 활성화해 SAN 기보로 수를 직접 입력할 수도 있습니다. 기보 아래의 이동 컨트롤, 방향키 또는 마우스 휠([[setting:scroll-moves]]가 켜진 경우)을 사용해 수 사이를 이동하세요.

기보 옆의 도구 모음에서는 보드 관련 작업을 실행할 수 있습니다:
- {{label:Board.Action.TakeSnapshot}}: 현재 보드의 이미지를 저장합니다.
- {{label:Board.Action.EditPosition}}: 기물을 배치하거나 FEN을 편집해 사용자 지정 포지션을 설정합니다.
- {{label:Board.Action.PlayFromHere}}: 현재 포지션에서 대국을 시작합니다.
- {{label:Board.Action.ClearDrawings}}: 화살표와 칸 강조 표시를 지웁니다([[setting:erase-drawables]]가 꺼져 있을 때 표시됨).
- {{label:Board.Database.Save}}: 대국을 라이브러리 파일이나 데이터베이스에 저장합니다.
- 실행 취소, 다시 실행, 저장 및 보드 뒤집기 버튼.

이전 포지션에서 다른 수를 두면 변형 수순이 만들어집니다. 기보에서 아무 수나 마우스 오른쪽 버튼으로 클릭해 {{label:Menu.PromoteVariation}}, {{label:Menu.PromoteToMainLine}}, {{label:Menu.CopyVariationPGN}}, {{label:Menu.DeleteMove}}, {{label:Board.Action.PlayFromHere}}, {{label:Notation.AddDiagram}} 또는 {{label:Notation.MarkGameEndHere}}을(를) 선택하세요. 기보 헤더 버튼을 사용해 {{label:Notation.HideMoves}}, {{label:Notation.TableView}}, {{label:Notation.HideComments}}, {{label:Notation.HideDiagrams}}, {{label:Notation.HideVariations}} 표시를 전환할 수 있습니다.

수에 주석을 달고 코멘트를 작성하려면 {{label:Board.Tabs.Annotate}} 탭을 여세요. 수 평가 기호를 클릭하거나 숫자 1~6 키를 눌러 `!!`, `!`, `!?`, `?!`, `?`, `??`를 전환하고, 형세 및 포지션 평가 기호는 {{label:Annotate.ShowMore}}을(를) 클릭해 확인하세요. 기호 아래의 서식 있는 텍스트 편집기에서 코멘트를 작성하고 인라인 보드 다이어그램을 추가하거나 숨길 수 있습니다.

화살표를 그리거나 칸을 강조하려면 보드 위에서 마우스 오른쪽 버튼을 누른 채 드래그하세요(칸에 원을 그리려면 마우스 오른쪽 버튼으로 클릭). 보조 키를 누른 채 그리면 색상이 달라집니다: Shift는 {{label:Settings.Drawing.Red}}, Alt는 {{label:Settings.Drawing.Blue}}, Shift+Alt는 {{label:Settings.Drawing.Yellow}}, Ctrl(macOS에서는 Cmd)은 {{label:Settings.Drawing.Orange}}, Ctrl+Alt(macOS에서는 Cmd+Alt)는 {{label:Settings.Drawing.Cyan}}입니다. 전체 그리기 목록은 [[settings-category:keybinds]]에서 확인할 수 있습니다.

{{label:Board.Tabs.Info}} 탭에는 대국 헤더, FEN, PGN 텍스트 및 트리 통계가 표시되며, 여러 대국이 담긴 PGN 파일에서 대국 간 전환도 할 수 있습니다.
