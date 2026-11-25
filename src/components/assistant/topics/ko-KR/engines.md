---
id: engines
title: 체스 엔진과 분석 패널
summary: 로컬 및 클라우드 엔진 설치·추가, UCI 옵션 구성, 보드에서 실시간 분석 사용하기.
source: 0e9ac8bab01e58b5
---

[[page:engines]] ({{label:SideBar.Engines}}) 페이지에서 체스 엔진을 관리하세요.

엔진을 추가하려면 [[page:engines]]에서 {{label:Common.AddNew}}을(를) 클릭해 {{label:Engines.Add.Title}}을(를) 여세요:
- {{label:Common.Download}}: 카탈로그에서 사전 구성된 엔진(예: Stockfish)을 {{label:Common.Install}} 버튼으로 설치합니다.
- {{label:Engines.Add.Cloud}}: 온라인 분석 엔진(ChessDB 또는 Lichess Cloud)을 {{label:Common.Add}} 버튼으로 추가합니다.
- {{label:Common.Local}}: 컴퓨터에 이미 있는 UCI 엔진 실행 파일을 등록합니다.

[[page:engines]]에서 엔진을 선택해 설정할 수 있습니다. 로컬 엔진의 경우 일반 정보를 편집하고, 기본 UCI 옵션(예: Threads, Hash, MultiPV)을 지정하고, Syzygy 테이블베이스 같은 리소스 파일을 연결하며, {{label:Engines.Settings.Reset}}으로 기본값을 복원하거나 {{label:Common.Duplicate}}로 구성을 복제하거나 {{label:Common.Remove}}로 삭제할 수 있습니다. 클라우드 엔진에서는 이름과 {{label:Engines.Settings.NumOfLines}}을(를) 편집할 수 있습니다.

분석 보드에서 {{label:Board.Tabs.Analysis}} 탭을 열고 {{label:Board.Analysis.Engines}}을(를) 선택하세요:
- 패널에 불러올 설치된 엔진을 고르려면 {{label:Board.Analysis.SelectEngines}}을(를), [[page:engines]]로 이동하려면 {{label:Board.Analysis.ManageEngines}}을(를) 클릭하세요.
- 엔진 카드에서 {{label:Board.Analysis.EnableEngine}} 또는 {{label:Board.Analysis.DisableEngine}}을(를) 클릭해 분석을 시작하거나 일시 정지하고, 여러 엔진이 로드된 경우 {{label:Board.Analysis.EnableAllEngines}}을(를) 사용하세요.
- 상대의 위협을 분석하려면 {{label:Board.Analysis.CheckThreat}}을(를) 클릭하거나 {{label:Settings.Keybinds.Actions.TOGGLE_THREAT_MODE}} 단축키를 누르세요.
- 탭 바깥에 엔진 평가 막대를 고정하려면 {{label:Board.Analysis.Pin}}을(를), 탐색 제한과 수순 개수 같은 탭별 설정을 조정하려면 {{label:Board.Analysis.EngineSettings}}을(를) 클릭하세요.
- {{label:Board.Analysis.ReorderEngine}}을(를) 드래그해 엔진 카드의 순서를 바꿉니다.
- 엔진이 실패하면 {{label:Board.Analysis.RetryEngine}} 옆의 {{label:Board.Analysis.Logs}}을(를) 클릭해 UCI 통신 내용을 확인하세요. 실행 중인 엔진은 엔진 카드의 {{label:Board.Analysis.EngineSettings}} 안에 같은 버튼이 있습니다.

보드에 표시되는 엔진 화살표는 [[setting:arrows]] ({{label:Settings.Arrows}})에서 제어할 수 있습니다. 로컬 엔진은 [[setting:engines-directory]]에 지정된 폴더에 저장됩니다.
