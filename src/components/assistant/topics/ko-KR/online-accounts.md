---
id: online-accounts
title: 온라인 계정과 상대 분석 준비
summary: Lichess 및 Chess.com 계정 추가, 내 대국 다운로드, 데이터베이스 선수와 온라인 계정을 연결해 상대의 오프닝 연구하기.
source: 5288fb0320fbe939
---

[[page:accounts]] ({{label:SideBar.Accounts}}) 페이지에서 Lichess 및 Chess.com 계정을 관리하세요.

계정을 추가하려면:
1. [[page:accounts]]에서 {{label:Home.Accounts.Add}}을(를) 클릭합니다.
2. 여러 계정을 하나의 선수 프로필로 묶으려면 선택적으로 {{label:Home.Accounts.PlayerName}}을 입력하거나 선택합니다.
3. {{label:Home.Accounts.Website}}에서 Lichess 또는 Chess.com을 선택하고 {{label:Home.Accounts.Username}}을 입력합니다.
4. Lichess의 경우 선택적으로 {{label:Home.Accounts.LoginWithBrowser}}을(를) 체크해 OAuth로 로그인합니다. 로그인하면 더 빠른 대국 다운로드와 분석 보드의 Lichess 온라인 오프닝 탐색기를 사용할 수 있습니다.
5. {{label:Common.Add}}을(를) 클릭합니다.

[[page:accounts]]의 각 계정 카드에서:
- {{label:Home.Accounts.UpdateStats}}을(를) 클릭해 레이팅과 통계를 새로 고칩니다.
- 다운로드 버튼을 클릭해 내 대국을 로컬 데이터베이스에 저장합니다(이후 다운로드에서는 마지막 다운로드 이후의 새 대국만 가져옵니다).
- 계정을 제거하려면 {{label:Home.Accounts.RemoveAccount}}을(를) 클릭합니다.
- 대국을 다운로드하고 나면 [[page:accounts]] 오른쪽에 개인 통계({{label:Home.Personal.Overview}}, {{label:Home.Personal.Ratings}}, {{label:Home.Personal.Openings}})가 표시됩니다.

데이터베이스에서 상대의 온라인 오프닝을 연구하려면:
1. [[page:library]]에서 데이터베이스를 열고 {{label:Databases.Card.Players}} 탭으로 전환합니다.
2. 선수를 선택해 선수 카드를 엽니다.
3. {{label:Databases.Opponent.Add}}을(를) 클릭해 해당 선수에게 하나 이상의 Lichess 또는 Chess.com 사용자 이름을 연결합니다.
4. {{label:Databases.OpeningTree.Since}} 및 {{label:Databases.Opponent.TimeControls}}로 필터링하거나 {{label:Databases.Opponent.RemoveGames}} 또는 {{label:Databases.Opponent.Unlink}}을(를) 실행하려면 {{label:Databases.Opponent.Manage}}을(를) 클릭합니다.
5. 온라인 대국을 가져오려면 {{label:Databases.Opponent.Download}}(또는 {{label:Databases.Opponent.Update}})을(를) 클릭합니다.
6. 선수 카드의 탭({{label:Home.Personal.Overview}}, {{label:Home.Personal.Ratings}}, {{label:Home.Personal.Preparation}} 또는 {{label:Home.Personal.Openings}})에서 {{label:Databases.OpeningTree.Prepare}}을(를) 클릭하면 탐색기에 상대의 대국이 고정된 분석 보드가 열립니다. 오프라인 및 온라인 오프닝 트리를 살펴보고 색상과 {{label:Databases.OpeningTree.Since}}별로 필터링하며 특정 수순을 먼저 고르려면 {{label:Home.Personal.Openings}} 탭을 여세요.
