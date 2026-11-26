---
id: library-and-files
title: 파일 및 라이브러리
summary: 작업 폴더 설정, PGN 파일 생성 및 정리, 대국 열기와 저장, 휴지통 관리.
source: 4417697a9a5cd025
---

[[page:library]] ({{label:SideBar.Library}})에는 작업 공간의 PGN 파일(대국, 레퍼토리, 토너먼트, 퍼즐 및 기타 파일)과 기보 데이터베이스가 함께 모여 있습니다.

파일을 만들기 전에 먼저 작업 폴더를 선택하세요. 아직 폴더가 설정되지 않았다면 [[page:library]]에서 {{label:Files.ChooseFolder}}을(를) 클릭하거나 [[settings-category:directories]] 아래의 [[setting:files-directory]] ({{label:Settings.Directories.Files}})에서 지정하세요.

[[page:library]]에서 할 수 있는 작업:
- {{label:Files.CreateFile}}을(를) 클릭해 새 PGN 파일을 만들거나 {{label:Files.CreateFolder}}을(를) 클릭해 하위 폴더로 파일을 정리합니다.
- {{label:Common.Search}} 입력란과 {{label:Files.FileType}} 드롭다운을 사용해 파일 유형이나 {{label:Library.GamesDatabase}}별로 필터링합니다.
- 파일을 선택하면 포함된 대국을 미리 보거나(미리보기는 눈 버튼으로 수를 숨길 수 있습니다, [[setting:hide-preview-moves]]), 분석 보드에서 열거나, {{label:Files.Rename}}, {{label:Files.Move}}, {{label:Files.Trash}} 작업을 실행할 수 있습니다.

분석 보드에서 파일을 편집할 때:
- 보드 상단 표시줄의 저장 버튼(자동 저장이 꺼져 있거나, 사용할 수 없거나, 실패했을 때 표시), {{label:Menu.File}} -> {{label:Common.Save}}, 또는 {{label:Settings.Keybinds.Actions.SAVE_FILE}} 단축키로 변경 내용을 저장하세요.
- 열려 있는 파일의 편집 내용을 자동으로 저장하려면 [[setting:auto-save]] ({{label:Settings.AutoSave}})을(를) 켜세요.
- 현재 대국을 다른 라이브러리 파일이나 데이터베이스에 저장하려면 {{label:Menu.File}} -> {{label:Board.Database.Save}}(또는 보드 상단 표시줄의 {{label:Board.Action.More}} -> {{label:Board.Database.Save}})을(를) 사용하세요.

파일을 {{label:Files.Trash}}로 옮겨도 즉시 영구 삭제되지는 않습니다. 알림에서 바로 {{label:Common.Undo}}을(를) 클릭하거나, [[page:library]]의 {{label:Files.Trash}} 섹션으로 스크롤하여 {{label:Files.Restore}}, {{label:Files.DeletePermanently}} 또는 {{label:Files.EmptyTrash}}을(를) 실행할 수 있습니다.

ChessRiddle 계정이 연결되어 있으면 [[page:library]]에서 {{label:Library.Sync.Action}}을(를) 클릭하여 선택한 PGN 파일을 ChessRiddle의 비공개 라이브러리에 동기화할 수 있습니다(파일당 최대 100개 파일, 5 MB, 40,000수). 수정, 이름 변경, 선택 해제, 삭제는 자동으로 반영되며, 다운로드한 대국 기록과 기보 데이터베이스는 로컬에만 남습니다. 동기화를 끌 때는 ChessRiddle에 동기화된 파일을 유지하거나 제거할 수 있습니다.
