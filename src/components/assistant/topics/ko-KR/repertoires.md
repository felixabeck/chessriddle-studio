---
id: repertoires
title: 오프닝 레퍼토리
summary: 레퍼토리 만들기, PGN 가져오기, 참조 데이터베이스를 기준으로 수순 구축하기, 간격 반복 학습으로 연습하기, 미완성 변형 수순·전위·검토 표시 추적하기.
source: db00ec0860d0fa31
---

레퍼토리는 분석 보드에 {{label:Board.Tabs.Practice}} 탭을 추가하는 레퍼토리 유형의 PGN 파일입니다.

레퍼토리를 만들려면 [[page:new-tab]]을 열고 {{label:Home.Card.NewRepertoire.Title}}을(를) 클릭하거나([[page:library]]에서 레퍼토리 파일을 만들 수도 있음) {{label:Common.Name}}을 입력하고 {{label:Common.WHITE}} 또는 {{label:Common.BLACK}}을 선택한 뒤 선택적으로 {{label:Home.Card.NewRepertoire.FromPgn}}에서 PGN을 고르거나 붙여 넣고 {{label:Common.Create}}을(를) 클릭하세요. {{label:Import.SaveToCollection}}을 켜고 파일 유형을 {{label:Files.FileType.Repertoire}}로 설정해 {{label:Home.Card.ImportGame.Title}}에서 PGN을 가져올 수도 있습니다.

{{label:Board.Tabs.Practice}} -> {{label:Board.Practice.Build}}에서 레퍼토리를 구축합니다:
- 열려 있는 레퍼토리에 PGN 파일이나 붙여 넣은 대국을 병합하려면 {{label:Board.Practice.Build.ImportPgn}}을(를) 클릭하세요(참조 데이터베이스 유무와 관계없이 동작합니다).
- 빌더가 수 빈도와 커버리지를 표시할 수 있도록 [[page:library]]에서 {{label:Databases.Settings.ReferenceDatabase}}을(를) 설정하세요.
- 비어 있는 레퍼토리에서는 내장된 {{label:Board.Practice.Build.Presets}} 중 하나로 시작하거나 보드에 직접 수를 입력할 수 있습니다.
- {{label:Board.Practice.Build.SetAsStart}}을(를) 사용해 레퍼토리의 시작 포지션을 지정하세요(또는 기보의 수를 마우스 오른쪽 버튼으로 클릭하고 {{label:Menu.MarkAsStart}} 선택).
- {{label:Board.Practice.Build.OpponentMoves}} 또는 {{label:Board.Practice.Build.YourResponse}}에서 수를 클릭해 라인을 추가하거나 따라갑니다. [[setting:repertoire-depth]]에 설정된 최소 대국 수 이상이면서 아직 다루지 않은 상대 응수로 이동하려면 {{label:Board.Practice.Build.NextGap}} 및 {{label:Board.Practice.Build.BiggestGap}}을(를) 사용하세요.

{{label:Board.Tabs.Practice}} -> {{label:Board.Practice.Train}}에서 레퍼토리를 연습합니다:
- 간격 반복 학습으로 복습할 포지션과 새 포지션을 연습하려면 {{label:Board.Practice.StartPractice}}을(를), 레퍼토리의 모든 포지션을 연습하려면 {{label:Board.Practice.PracticeFullRepertoire}}을(를) 클릭하세요.
- 보드에서 준비한 수를 둡니다. 틀린 수 뒤에 막히면 {{label:Board.Practice.ShowMove}}을(를) 클릭하세요.
- {{label:Board.Practice.ShowAll}}로 모든 카드를 확인하거나, {{label:Board.Practice.ShowLogs}}로 기록을 보거나, {{label:Common.Reset}}으로 진행 상태를 초기화할 수 있습니다.
- 복습할 카드가 있는 레퍼토리는 [[page:new-tab]]의 {{label:Home.Library.Due}} 필터에도 표시됩니다.
- 간격 반복 채점 방식과 세션당 새 카드 제한은 [[settings-category:repertoire]]([[setting:practice-grading]], [[setting:practice-new-per-session]])에서 설정하세요.

분석 보드의 기보에서:
- 한 수만 이어진 곁가지 수순은 미완성 분기를 쉽게 찾을 수 있도록 {{label:Notation.OpenVariation}}으로 점선 테두리가 표시됩니다. 다음 미완성 수순으로 이동하려면 {{label:Settings.Keybinds.Actions.NEXT_OPEN_VARIATION}} 단축키를 누르세요.
- 같은 레퍼토리의 다른 분기에도 나타나는 포지션이면 수 옆에 {{label:Notation.Transposition}} 아이콘이 표시되며, 클릭하면 다른 분기로 이동합니다.
- 가져온 PGN에 내 차례의 다른 응수가 포함되어 있으면 가져온 수가 변형 수순으로 추가되고 {{label:Notation.ReviewMove}}로 표시됩니다. 해당 수를 마우스 오른쪽 버튼으로 클릭하고 {{label:Menu.MarkAsReviewed}}를 선택하면 표시가 지워집니다.
