---
id: databases
title: 데이터베이스, 탐색기, 포지션 검색, 선수 및 토너먼트
summary: 기보 데이터베이스 추가 또는 다운로드, 참조 데이터베이스 지정, 탐색기에서 포지션 검색, 대국·선수·토너먼트 탐색하기.
source: 48c72137fadc1768
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
- 대국을 검색 및 정렬하고, 미리 보거나 분석 보드에서 엽니다.
- {{label:Databases.Card.Players}}에서 선수를 선택하면 {{label:Home.Personal.Overview}}, {{label:Home.Personal.Ratings}}, {{label:Home.Personal.Openings}}({{label:Databases.OpeningTree.Prepare}} 버튼이 있는 대화형 오프닝 트리)와 {{label:Databases.FIDE.Info}}를 통한 FIDE 정보를 볼 수 있습니다.
- {{label:Databases.Settings.Events}}에서는 이름으로 토너먼트를 검색하고 날짜, 참가자 수, 대국 수 또는 평균 Elo로 정렬할 수 있습니다.

분석 보드에서 오프닝 탐색기를 사용하려면 {{label:Board.Tabs.Database}} 탭을 여세요:
- {{label:Board.Database.Local}}, {{label:Board.Database.LichessAll}}, {{label:Board.Database.LichessMaster}} 사이를 전환할 수 있습니다(Lichess 온라인 탐색기를 사용하려면 [[page:accounts]]에서 Lichess 계정에 로그인해야 합니다).
- {{label:Board.Database.Stats}}(수 통계)와 {{label:Board.Database.Games}}(일치하는 대국) 보기를 전환합니다.
- 로컬 데이터베이스에서는 {{label:Board.Database.Compare}}을(를) 클릭해 두 데이터베이스를 나란히 보거나, {{label:Board.Database.Local.Position}}을 열어 {{label:Board.Database.Local.Exact}}와 {{label:Board.Database.Local.Partial}} 포지션 검색(폰 구조 검색용 {{label:Board.Database.Local.SimilarStructure}} 및 사용자 지정 패턴용 {{label:Fen.Empty}} 포함)을 전환할 수 있습니다.
- {{label:Board.Database.Pin}}으로 탐색기를 보드나 기보 위아래에 고정하고, {{label:Board.Database.Unpin}}으로 다시 탭으로 되돌릴 수 있습니다.
