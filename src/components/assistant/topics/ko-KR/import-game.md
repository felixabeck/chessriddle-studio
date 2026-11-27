---
id: import-game
title: 대국 불러오기
summary: PGN 파일, 붙여넣은 PGN 텍스트, Lichess 또는 Chess.com URL, FEN 포지션, 또는 손글씨 기보 사진이나 PDF 스캔에서 대국 불러오기.
source: bf71b9a270c61e30
---

대국이나 포지션을 불러오려면 [[page:new-tab]]을 열고 {{label:Home.Card.ImportGame.Button}}을(를) 클릭하여 {{label:Home.Card.ImportGame.Title}} 대화상자를 여세요. {{label:Menu.File}} -> {{label:Menu.File.OpenFile}}(또는 {{label:Settings.Keybinds.Actions.OPEN_FILE}} 단축키)로 PGN 파일을 직접 열 수도 있습니다.

{{label:Home.Card.ImportGame.Title}} 대화상자에서 옵션 중 하나를 선택하세요:
- **PGN**: 컴퓨터에서 {{label:Common.PGNFile}}을(를) 선택하거나 {{label:Common.PGNGame}}에 텍스트를 붙여넣습니다. [[page:library]]의 작업 폴더에 사본을 저장하려면 {{label:Import.SaveToCollection}}을(를) 선택하고 {{label:Common.Name}}을 입력한 뒤 {{label:Files.FileType}}을(를) 고르세요.
- **{{label:Import.Online}}**: Lichess 또는 Chess.com {{label:Import.GameURL}}을(를) 붙여넣어 대국을 가져오고 분석 보드에서 엽니다.
- **FEN**: FEN 문자열을 붙여넣어 해당 포지션에서 시작하는 분석 보드를 엽니다.
- **{{label:Import.FromPhoto}}**(AI 기능을 사용할 수 있을 때): 손글씨 기보 사진 또는 PDF 페이지 1~4장을 새 대국으로 옮겨 적습니다. [[settings-category:coach]] ({{label:Settings.AI}})에 AI 연결이 하나 이상 필요합니다.

PGN, {{label:Import.Online}}, FEN에서는 {{label:Home.Card.ImportGame.Button}}을(를) 클릭하면 현재 탭으로 대국이 불러와집니다.

**{{label:Import.FromPhoto}}**(으)로 불러오려면:
- {{label:Scoresheet.Intake.ChoosePhotos}}, {{label:Scoresheet.Intake.PasteFromClipboard}}(또는 창이 열린 상태에서 Ctrl+V / Cmd+V)를 사용하거나 열린 창으로 끌어다 놓아 JPEG, PNG 또는 WebP 사진이나 PDF 페이지를 최대 4장까지 추가하세요. 붙여넣기는 사진에만 사용할 수 있습니다. PDF 한 페이지는 사진 한 장으로 계산되며, 더 긴 PDF는 앞쪽 페이지가 사용됩니다.
- 모델 버튼이나 [[setting:coach-model]] ({{label:Settings.Coach.Model}})에서 AI 연결과 이미지 인식 모델을 선택하세요.
- {{label:Scoresheet.Read.Button}}을(를) 클릭해 시작합니다. 연결당 처음 읽기 전에 {{label:Scoresheet.Notice.Title}} 안내가 표시되어 선택한 사진(선수 이름과 기보에 적힌 기타 내용 포함)이 해당 제공업체로 전송되며, 카메라 위치 같은 메타데이터는 먼저 제거되고 다른 데이터는 전송되지 않음을 설명합니다.
- 스튜디오는 시작 포지션부터 표준 체스 규칙에 따라 모든 수를 확인하고, 보드 옆에 {{label:Board.Tabs.Photo}} 패널이 열린 새 미저장 분석 탭으로 대국을 엽니다.
- 불확실하거나 수정된 수는 기보에 불확실 표시로 나타납니다. {{label:Board.Tabs.Photo}} 패널에서 이동하며 확인한 뒤 {{label:Scoresheet.MarkAsChecked}}를 클릭하세요. 중간 수를 고쳤거나 중단 지점 이후를 이어가려면 {{label:Scoresheet.ContinueWithSheet}}를 클릭해 기보의 남은 합법 수를 한 번에 재생할 수 있습니다. 각 수를 고치거나 확인 완료로 표시할 때까지 표시는 유지되며, {{label:Board.Tabs.Photo}} 패널은 탭에서 끌어내어 다른 패널처럼 배치할 수 있습니다.
- 일반 저장 흐름({{label:Menu.File}} -> {{label:Common.Save}}, 저장 버튼 또는 {{label:Board.Database.Save}})으로 검토한 대국을 파일이나 데이터베이스에 저장하세요.
- 스튜디오는 대국을 불러오는 즉시 사진을 이 컴퓨터에 저장합니다. PGN 파일이나 데이터베이스에 대국을 저장하면 사진에 대한 참조가 함께 남아, 대국을 다시 열 때마다 {{label:Board.Tabs.Photo}} 패널에 사진이 다시 표시됩니다. 사진은 업로드되지 않으며 라이브러리 동기화도 이를 전송하지 않습니다.
- 사진이 이 컴퓨터에 없는 경우(예: 다른 컴퓨터에서 복사한 PGN 파일), 패널에 해당 안내가 표시되며 {{label:Scoresheet.LoadPhotoAgain}}을(를) 사용하면 어디에도 전송하지 않고 사진을 다시 연결합니다.
- 스튜디오가 알고 있는 어떤 대국에서도 더 이상 참조하지 않는 사진은 하루가 지나면 삭제되므로, 스튜디오 밖으로 복사한 대국에는 사진에 대한 참조만 남습니다.
