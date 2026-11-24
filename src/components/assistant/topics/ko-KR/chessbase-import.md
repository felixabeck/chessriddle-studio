---
id: chessbase-import
title: ChessBase에서 데이터베이스 가져오기
summary: ChessBase 데이터베이스를 PGN으로 내보낸 뒤 Studio 데이터베이스로 변환하기.
source: d7f599a811a0afb0
---

ChessRiddle Studio는 ChessBase의 `.cbh` 또는 `.cbv` 파일을 직접 읽지 않습니다. 대신 먼저 ChessBase 데이터베이스를 PGN으로 내보낸 다음, 해당 PGN 파일을 Studio 데이터베이스로 변환하세요.

파일 선택기에서 ChessBase 파일을 선택하면 Studio가 자동으로 {{label:ChessBaseGuide.Title}} 대화상자를 엽니다. [[page:library]]의 {{label:Library.AddDatabase}} 안에 있는 안내 링크를 통해서도 열 수 있습니다.

ChessBase에서 가져오려면 다음 단계를 따르세요:
1. ChessBase에서 데이터베이스를 열고 내보낼 대국들을 선택합니다.
2. ChessBase에서 선택한 대국들을 `.pgn` 파일로 내보내거나 저장합니다.
3. Studio에서 [[page:library]]를 열고 {{label:Library.AddDatabase}}을(를) 클릭한 뒤, {{label:Common.Local}} 탭으로 전환해 내보낸 `.pgn` 파일을 선택하고 {{label:Common.Name}}을 입력한 다음 {{label:Databases.Add.Convert}}을(를) 클릭합니다.

변환이 완료되면 데이터베이스가 [[page:library]]에 나타나며, 여기에서 대국, 선수, 토너먼트를 탐색하거나 {{label:Databases.Settings.ReferenceDatabase}}로 설정할 수 있습니다.
