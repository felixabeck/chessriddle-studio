---
id: databases
title: 데이터베이스, 탐색기, 포지션 검색, 선수 및 토너먼트
summary: 기보 데이터베이스 추가 또는 다운로드, 참조 데이터베이스 지정, 탐색기에서 포지션 검색, 대국·선수·토너먼트 탐색하기.
source: 9d4f20d7213a7cbb
---

데이터베이스는 PGN 파일과 함께 [[page:library]] ({{label:SideBar.Library}})에 표시되며 [[setting:databases-directory]]에 저장됩니다.

데이터베이스를 추가하려면 [[page:library]]를 열고 {{label:Library.AddDatabase}}을(를) 클릭하세요:
- {{label:Databases.Add.Web}}: 카탈로그에서 엄선된 기보 데이터베이스를 다운로드합니다.
- {{label:Common.Local}}: 로컬 PGN 파일(`.pgn.zst` 또는 `.pgn.bz2` 포함)을 선택하고 {{label:Common.Name}}과 선택 사항인 {{label:Common.Description}}을 입력한 뒤 {{label:Databases.Add.Convert}}을(를) 클릭합니다.

[[page:library]]에서 데이터베이스를 선택해 관리하세요:
- 탐색기, 레퍼토리 빌더, 게임 보고서의 새로운 수(노벨티), Coach에서 기본 참조 데이터베이스로 사용하려면 {{label:Databases.Settings.ReferenceDatabase}}을(를) 선택하세요.
- 더 빠른 조회를 위해 검색 인덱스를 만들거나 제거하려면 {{label:Databases.Settings.Indexed}}을(를) 선택하세요.
- 데이터베이스 표 보기를 열려면 {{label:Databases.Settings.Explore}}을(를) 클릭하세요.
- {{label:Databases.Settings.Actions}}에서 {{label:Databases.Settings.AddGames}}로 PGN 파일을 추가하거나, {{label:Databases.Settings.ExportPGN}}로 PGN으로 내보내거나, {{label:Common.Delete}}로 데이터베이스를 삭제할 수 있습니다.
- {{label:Databases.Settings.AdvancedTools}}에서 {{label:Databases.Settings.MergePlayers}}로 중복된 선수 항목을 병합하거나 {{label:Databases.Settings.RemoveDup}} 및 {{label:Databases.Settings.RemoveEmpty}}로 대국을 정리할 수 있습니다.

데이터베이스 표 보기에서는 {{label:Common.Games}}, {{label:Databases.Card.Players}}, {{label:Databases.Settings.Events}}(토너먼트) 사이를 전환할 수 있습니다:
- 대국을 검색 및 정렬하고, 미리 보거나(미리보기는 눈 버튼으로 수를 숨길 수 있습니다, [[setting:hide-preview-moves]]) 분석 보드에서 엽니다.
- {{label:Databases.Card.Players}}에서 선수를 선택하면 {{label:Home.Personal.Overview}}, {{label:Home.Personal.Ratings}}, {{label:Home.Personal.Openings}}(대화형 오프닝 트리)와 {{label:Databases.FIDE.Info}}를 통한 FIDE 정보를 볼 수 있습니다. {{label:Home.Personal.Overview}}와 {{label:Home.Personal.Ratings}} 탭에서 {{label:Databases.OpeningTree.Prepare}}을(를) 사용하면 백 기준 전체 대국으로 시작 포지션이 열리고, {{label:Home.Personal.Openings}} 탭에서는 선택한 수순, 색상, {{label:Databases.OpeningTree.Since}} 기간을 그대로 이어서 엽니다.
- {{label:Databases.Settings.Events}}에서는 이름으로 토너먼트를 검색하고 날짜, 참가자 수, 대국 수 또는 평균 Elo로 정렬할 수 있습니다.

선수 카드의 {{label:Home.Personal.Preparation}} 탭에서 상대의 대국을 내 레퍼토리 파일과 비교하세요:
- 상대의 색, {{label:Databases.OpeningTree.Since}} 기간을 고르고(온라인 계정이 연결된 경우) {{label:Databases.OpeningTree.OverTheBoard}}, {{label:Databases.OpeningTree.Online}} 또는 {{label:Databases.Preparation.Both}} 중 하나를 선택합니다. {{label:Databases.Preparation.Refresh}}을(를) 클릭하면 비교를 다시 실행하고, {{label:Databases.OpeningTree.Prepare}}을(를) 클릭하면 해당 탭의 색상과 {{label:Databases.OpeningTree.Since}} 기간을 사용해 분석 보드에서 시작 포지션을 엽니다.
- 상대가 드물게만 둔 라인과 빈틈을 숨기려면 {{label:Databases.Preparation.MinGames}} 값을 높이세요. 파일에서 해당 라인이 접히고 훈련에서도 제외됩니다.
- 상대가 두는 수순과 {{label:Databases.Preparation.GapsTitle}}을(를) 확인하세요. 행을 클릭하면 다른 곁가지 변화가 숨겨진 채 해당 포지션에서 레퍼토리 파일이 열리며, 기보 상단에서 {{label:Notation.PreparationOpponentLines}}와(과) {{label:Notation.PreparationAllLines}} 사이를 전환할 수 있습니다.
- {{label:Databases.Preparation.TrainLines}}을(를) 클릭해 해당 수순만 제한 시간 동안 연습하세요. 응답 결과는 일반 간격 반복 일정에 반영됩니다.
- Lichess 또는 Chess.com 계정만 있는 상대를 대비하려면 [[page:library]]에서 {{label:Library.OnlineOpponent}}을(를) 클릭해 계정을 조회하고 대국을 다운로드한 뒤 {{label:Home.Personal.Preparation}} 탭에서 바로 선수 카드를 여세요(같은 계정을 다시 입력하면 다시 다운로드하지 않고 바로 열립니다).

분석 보드에서 오프닝 탐색기를 사용하려면 {{label:Board.Tabs.Database}} 탭을 여세요:
- 소스 드롭다운과 {{label:Board.Database.Compare}}에서 {{label:Board.Database.LichessAll}} 또는 {{label:Board.Database.LichessMaster}}를 선택하세요(Lichess 온라인 탐색기를 사용하려면 [[page:accounts]]에서 Lichess 계정에 로그인해야 합니다).
- 위쪽에는 {{label:Board.Database.Stats}}(수 통계), 아래쪽에는 {{label:Board.Database.Games}}(일치하는 대국)이 표시되며 두 영역이 모두 표시된 동안 가운데 구분선을 끌어 높이를 나눌 수 있습니다. {{label:Board.Database.HideGames}} 또는 {{label:Board.Database.ShowGames}}로 대국 목록을 숨기거나 표시하고 설정 톱니바퀴로 소스 제어 영역을 펼치거나 접을 수 있으며, 두 버튼은 패널이 별도 타일일 때는 패널 헤더에, 탭 안에 있을 때는 상단 제어 행에 배치됩니다. {{label:Board.Area.Notation}} 열에는 보드 국면에서 이어지는 수가 표시되며 다음 수는 굵게 강조됩니다.
- {{label:Board.Database.Compare}}을(를) 클릭해 두 소스를 나란히 보거나, {{label:Board.Database.Local.Position}}을 열어 {{label:Board.Database.Local.Exact}}와 {{label:Board.Database.Local.Partial}} 포지션 검색(폰 구조 검색용 {{label:Board.Database.Local.SimilarStructure}} 및 사용자 지정 패턴용 {{label:Fen.Empty}} 포함)을 전환할 수 있습니다.
- 분석 보드에서 {{label:Board.Tabs.Database}} 패널을 별도 영역으로 표시할 수도 있으며, {{label:Board.Area.ReturnToTabs}}로 다시 탭으로 되돌릴 수 있습니다.
- {{label:Databases.OpeningTree.Prepare}}로 데이터베이스 선수의 보드를 열면 탐색기가 참조 데이터베이스를 상대 대국 옆의 추가 열로 먼저 표시합니다. {{label:Board.Database.RemoveReference}}을(를) 클릭해 열을 숨기거나 {{label:Board.Database.AddColumn}}을(를) 클릭해 다른 열을 추가할 수 있습니다.
