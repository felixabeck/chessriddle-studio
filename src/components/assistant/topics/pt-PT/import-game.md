---
id: import-game
title: Importar uma partida
summary: Importe uma partida a partir de um ficheiro PGN, texto PGN colado, um URL do Lichess ou Chess.com, uma posição FEN ou fotografias de uma folha de partida manuscrita.
source: bda7f1cdec3151e0
---

Para importar uma partida ou posição, abra [[page:new-tab]] e clique em {{label:Home.Card.ImportGame.Button}} para abrir a janela {{label:Home.Card.ImportGame.Title}}. Também pode abrir um ficheiro PGN diretamente através de {{label:Menu.File}} -> {{label:Menu.File.OpenFile}} (ou do atalho {{label:Settings.Keybinds.Actions.OPEN_FILE}}).

Na janela {{label:Home.Card.ImportGame.Title}}, escolha uma das opções:
- **PGN**: selecione um {{label:Common.PGNFile}} do seu computador ou cole texto em {{label:Common.PGNGame}}. Marque {{label:Import.SaveToCollection}} para guardar uma cópia na sua pasta de trabalho em [[page:library]], depois introduza um {{label:Common.Name}} e escolha um {{label:Files.FileType}}.
- **{{label:Import.Online}}**: cole um {{label:Import.GameURL}} do Lichess ou do Chess.com para obter a partida e abri-la num tabuleiro de análise.
- **FEN**: cole uma sequência FEN para abrir um tabuleiro de análise a partir dessa posição.
- **{{label:Import.FromPhoto}}** (quando as funcionalidades de IA estão disponíveis): transcreva de 1 a 4 fotografias de uma folha de partida manuscrita para uma nova partida. Requer pelo menos uma ligação de IA em [[settings-category:coach]] ({{label:Settings.AI}}).

Para PGN, {{label:Import.Online}} e FEN, clique em {{label:Home.Card.ImportGame.Button}} para carregar a partida no separador atual.

Para importar com **{{label:Import.FromPhoto}}**:
- Adicione até 4 fotografias JPEG, PNG ou WebP através de {{label:Scoresheet.Intake.ChoosePhotos}}, {{label:Scoresheet.Intake.PasteFromClipboard}} (ou Ctrl+V / Cmd+V com o painel aberto) ou arrastando e largando as fotografias no painel aberto.
- Escolha a ligação de IA e um modelo compatível com imagens no botão do modelo ou em [[setting:coach-model]] ({{label:Settings.Coach.Model}}).
- Clique em {{label:Scoresheet.Read.Button}} para iniciar. Antes da primeira leitura numa ligação, {{label:Scoresheet.Notice.Title}} explica que as fotografias selecionadas (incluindo os nomes dos jogadores e tudo o que estiver escrito na folha) são enviadas para esse fornecedor, os metadados como a localização da câmara são removidos primeiro e nenhuns outros dados são enviados.
- O Studio verifica cada lance segundo as regras padrão do xadrez a partir da posição inicial e abre a partida num novo separador de análise não guardado com o painel {{label:Board.Tabs.Photo}} ao lado do tabuleiro.
- Os lances duvidosos ou corrigidos ficam marcados como incertos na notação. Percorra-os no painel {{label:Board.Tabs.Photo}} e clique em {{label:Scoresheet.MarkAsChecked}} à medida que confirma cada lance. Se corrigir um lance a meio ou prosseguir após uma paragem, clique em {{label:Scoresheet.ContinueWithSheet}} para reproduzir os lances legais seguintes da folha. Quando terminar, clique em {{label:Scoresheet.FinishReview}} para limpar as marcas restantes.
- Guarde a partida num ficheiro ou base de dados através do fluxo normal ({{label:Menu.File}} -> {{label:Common.Save}}, o botão guardar ou {{label:Board.Database.Save}}).
- As fotografias ficam apenas em memória (até 4 separadores abertos) e não são guardadas em disco; após recarregar ou reiniciar, a partida e as marcas de revisão mantêm-se e pode usar {{label:Scoresheet.LoadPhotoAgain}} no painel {{label:Board.Tabs.Photo}} para voltar a ver a fotografia sem a enviar.
