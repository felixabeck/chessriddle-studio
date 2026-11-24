---
id: play-against-engine
title: 엔진과 대국하기
summary: 로컬 엔진 또는 다른 사람과의 대국 설정, 시간 제어 및 오프닝 북 지정, 임의의 포지션에서 대국 시작하기.
source: 7c75f4b49a6bdf2c
---

대국을 시작하려면 [[page:new-tab]]을 열고 {{label:Home.Card.PlayChess.Button}}을(를) 클릭하세요. 분석 보드 도구 모음의 {{label:Board.Action.PlayFromHere}}을(를) 클릭하거나 기보의 수를 마우스 오른쪽 버튼으로 클릭해 원하는 포지션에서 바로 대국할 수도 있습니다.

대국을 시작하기 전에:
- 각 진영에 대해 {{label:Board.Opponent.Human}}(이름 입력) 또는 {{label:Common.Engine}}([[page:engines]]에서 설치된 엔진을 선택하고 해당 대국용 UCI 옵션 조정)을 선택하세요.
- 백과 흑을 바꾸려면 {{label:Board.Action.ChangeColors}}을(를) 클릭하세요.
- {{label:Board.Opponent.TimeSettings}}에서 {{label:GoMode.Time}}({{label:GoMode.Time}} 및 {{label:Board.Opponent.Increment}} 포함) 또는 {{label:Board.Opponent.Unlimited}}을(를) 선택하세요. 양쪽에 같은 시계 설정을 적용하려면 {{label:Board.Opponent.SameTimeControl}}을(를) 선택합니다.
- 필요에 따라 {{label:Board.Opponent.EnableOpeningBook}}을(를) 선택하고 {{label:Board.Opponent.OpeningBookFile}}을(를) 고른 뒤 {{label:Board.Opponent.OpeningBookMaxPlies}}을(를) 설정하세요.
- 사용자 지정 포지션에서 시작하려면 대국 시작 전에 보드 도구 모음의 {{label:Board.Action.EditPosition}}을(를) 사용하세요.
- {{label:Board.Opponent.StartGame}}을(를) 클릭해 대국을 시작합니다.

대국 중:
- 사람이 엔진을 상대로 둘 때는 미리 두기(프리무브)를 사용할 수 있습니다.
- 마지막 수를 무르려면 보드 도구 모음의 {{label:Board.Action.TakeBack}}을(를) 사용하세요.
- 대국을 끝내려면 {{label:Board.Opponent.Resign}}(또는 엔진 대 엔진 대국에서는 {{label:Board.Opponent.Abort}})을(를) 클릭하세요.
- 언제든지 {{label:Board.Analysis.Analyze}}을(를) 클릭해 탭을 분석 모드로 전환하거나, {{label:Board.Analysis.Logs}}을(를) 클릭해 엔진 로그를 확인할 수 있습니다.
- 대국이 끝나면 {{label:Home.NewGame}}을(를) 클릭해 새 대국을 설정하세요.
