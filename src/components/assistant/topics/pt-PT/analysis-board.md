---
id: analysis-board
title: Tabuleiro de análise, variantes, comentários e setas
summary: Introduza lances, edite posições, gira variantes, escreva comentários, adicione anotações e desenhe setas no tabuleiro.
source: 9fead5328d0f7506
---

Abra um tabuleiro de análise a partir de [[page:new-tab]] clicando em {{label:Home.Card.AnalysisBoard.Title}}, ou abrindo uma partida ou repertório guardado a partir de [[page:library]].

Execute lances arrastando ou clicando nas peças (configurável em [[setting:move-method]]). Também pode ativar [[setting:text-input]] ({{label:Settings.Inputs.TextInput}}) para escrever lances em notação SAN. Utilize os controlos de lances por baixo da notação, as teclas de setas ou a roda do rato (se [[setting:scroll-moves]] estiver ativo) para percorrer os lances.

A barra de ferramentas junto à notação disponibiliza ações para o tabuleiro:
- {{label:Board.Action.TakeSnapshot}}: guardar uma imagem do tabuleiro atual.
- {{label:Board.Action.EditPosition}}: configurar uma posição personalizada colocando peças ou editando a FEN.
- {{label:Board.Action.PlayFromHere}}: iniciar uma partida a partir da posição atual.
- {{label:Board.Action.ClearDrawings}}: remover setas e casas destacadas (visível quando [[setting:erase-drawables]] está desativado).
- {{label:Board.Database.Save}}: guardar a partida num ficheiro da biblioteca ou numa base de dados.
- Controlos para anular, refazer, guardar e rodar o tabuleiro.

Jogar um lance diferente a partir de uma posição anterior cria uma variante. Clique com o botão direito do rato sobre qualquer lance na notação para {{label:Menu.PromoteVariation}}, {{label:Menu.PromoteToMainLine}}, {{label:Menu.CopyVariationPGN}}, {{label:Menu.DeleteMove}}, {{label:Board.Action.PlayFromHere}}, {{label:Notation.AddDiagram}} ou {{label:Notation.MarkGameEndHere}}. Utilize os botões no cabeçalho da notação para alternar {{label:Notation.HideMoves}}, {{label:Notation.TableView}}, {{label:Notation.HideComments}}, {{label:Notation.HideDiagrams}} e {{label:Notation.HideVariations}}.

Para anotar lances e escrever comentários, abra o separador {{label:Board.Tabs.Annotate}}. Clique num símbolo de qualidade de lance (ou prima as teclas 1 a 6) para alternar `!!`, `!`, `!?`, `?!`, `?` ou `??`, ou clique em {{label:Annotate.ShowMore}} para ver símbolos de avaliação e posicionais. Abaixo dos símbolos, utilize o editor de texto formatado para escrever comentários e alternar diagramas de tabuleiro em linha.

Para desenhar setas e destacar casas, clique com o botão direito do rato e arraste no tabuleiro (ou clique com o botão direito numa casa para desenhar um círculo). Mantenha premidas teclas modificadoras para escolher outras cores: Shift para {{label:Settings.Drawing.Red}}, Alt para {{label:Settings.Drawing.Blue}}, Shift+Alt para {{label:Settings.Drawing.Yellow}}, Ctrl (Cmd no macOS) para {{label:Settings.Drawing.Orange}} e Ctrl+Alt (Cmd+Alt no macOS) para {{label:Settings.Drawing.Cyan}}. Consulte a lista completa de desenho em [[settings-category:keybinds]].

O separador {{label:Board.Tabs.Info}} mostra os cabeçalhos da partida, a FEN, o texto PGN e as estatísticas da árvore, permitindo também alternar entre partidas num ficheiro PGN com várias partidas.

Para organizar o tabuleiro de análise, arraste um separador de painel ({{label:Board.Tabs.Analysis}}, {{label:Board.Tabs.Database}}, {{label:Board.Tabs.Annotate}}, {{label:Board.Tabs.Coach}} ou {{label:Board.Tabs.Info}}) ou use as pegas na barra de separadores, no cabeçalho da notação ou no cabeçalho de uma área de painel para colocar áreas ao lado, acima ou abaixo de outra área com pré-visualização ou por teclado. Para colocar um painel sobre duas áreas (por exemplo, {{label:Board.Tabs.Database}} acima da notação e dos separadores), coloque primeiro o painel acima de uma delas e depois mova a outra para o lado. Use {{label:Board.Area.ReturnToTabs}} ou arraste uma área de painel para a lista de separadores para a devolver aos separadores, e use [[setting:board-layout]] ({{label:Settings.BoardLayout.Reset}}) para repor a disposição predefinida.
