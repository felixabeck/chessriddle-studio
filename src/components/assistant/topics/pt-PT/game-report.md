---
id: game-report
title: Revisão da partida e relatório
summary: Analise uma partida com um motor local para ver a precisão, gráficos de avaliação e tempo, notas de abertura e repertório e momentos-chave no tabuleiro.
source: d1a4339820f36de2
---

O relatório da partida analisa cada lance da variante principal com um motor de xadrez local e transforma os resultados numa revisão guiada da partida.

Para gerar um relatório, abra uma partida no tabuleiro de análise, mude para o separador {{label:Board.Analysis.Report}} e clique em {{label:Board.Analysis.GenerateReport}} (ou prima o atalho {{label:Settings.Keybinds.Actions.GENERATE_REPORT}}).

Na caixa de diálogo {{label:Board.Analysis.GenerateReport}}:
- Escolha um {{label:Common.Engine}} local. Se nenhum estiver instalado, adicione um em [[page:engines]].
- Defina o limite de pesquisa por lance (profundidade, tempo ou nós).
- Ative {{label:Board.Analysis.MarkMoves}} para anotar os lances com símbolos de qualidade (`!!`, `!`, `!?`, `?!`, `?`, `??`).
- Ative {{label:Board.Analysis.ShowVariations}} para inserir variantes com melhores lances na notação.
- Ative {{label:Board.Analysis.AnnotateNovelties}} para marcar com `N` o primeiro lance que sai da sua base de dados de referência. Esta opção requer uma base de dados de referência pronta selecionada em [[page:library]].
- Clique em {{label:Board.Analysis.Analyze}} para iniciar.

Enquanto o relatório decorre, pode cancelá-lo a partir do botão de progresso. Editar a variante principal também cancela um relatório em curso.

Quando termina, {{label:Board.Analysis.Report}} mostra:
- Um cabeçalho discreto com o motor, o limite de pesquisa e a data, além de um pequeno botão {{label:Board.Analysis.Report.Regenerate}} ao lado. O botão largo {{label:Board.Analysis.GenerateReport}} só aparece quando não existe um relatório atual.
- Uma frase de resumo acima do marcador quando a partida começou numa posição equilibrada; a partir de um início desequilibrado não é mostrada nenhuma frase.
- Um único marcador com os nomes e ratings dos jogadores, {{label:Board.Analysis.Accuracy}} como número principal, {{label:Board.Analysis.Report.AverageLoss}}, precisão por fase da partida e as seis linhas de qualidade de lance com os zeros esbatidos. Clicar numa contagem diferente de zero salta para esses lances, e passar o ponteiro ou focar com o teclado qualquer etiqueta explica o que mede.
- Um gráfico que alterna entre {{label:Board.Analysis.Report.Evaluation}} (com linha de zero) e {{label:Board.Analysis.Report.WinChance}}, cada um explicado ao passar o ponteiro ou ao focar com o teclado. Quando pelo menos metade dos lances tem tempos de relógio, surge por baixo uma faixa de {{label:Board.Analysis.Report.TimeUsage}}; clique em qualquer barra para ir para esse lance.
- Um bloco de abertura e repertório com o nome da abertura, a novidade (`N`) quando presente e uma nota de repertório apenas para o seu lado — correspondido pelo nome do jogador às suas contas ligadas do Lichess, Chess.com ou pseudónimos em [[page:accounts]], ou ao lado na parte inferior do tabuleiro se nenhum nome corresponder (rodar o tabuleiro muda esse lado). Indica onde saiu do repertório (um clique foca essa posição com setas) ou até onde o seguiu. Se não foi possível ler completamente os ficheiros de repertório, mostra apenas uma linha esbatida: {{label:Board.Analysis.Report.RepertoireIncomplete}}
- {{label:Board.Analysis.Report.KeyMoments}}: clique em qualquer linha para ir para a posição anterior ao lance, para que ambas as setas no tabuleiro (o lance jogado e o melhor lance) partam dessa casa. Use {{label:Board.Analysis.Report.PreviousMoment}} e {{label:Board.Analysis.Report.NextMoment}} para percorrer os momentos, ou filtre por {{label:Board.Analysis.Report.FilterBoth}}, {{label:Board.Analysis.Report.FilterWhite}} ou {{label:Board.Analysis.Report.FilterBlack}}. Os momentos também mostram etiquetas como {{label:Board.Analysis.Report.Tag.TurningPoint}} ou {{label:Board.Analysis.Report.Tag.TimeTrouble}} e o tipo de erro quando as linhas do motor o comprovam.
- Nos momentos `?!`, `?` e `??`, clique em {{label:Board.Analysis.Report.Explain}} para focar essa posição e abrir {{label:Board.Tabs.Coach}} com uma pergunta sobre esse momento. Este botão fica oculto quando não existe nenhuma ligação de IA configurada.

Se editar a partida depois, volte a gerar o relatório com {{label:Board.Analysis.GenerateReport}} ou {{label:Board.Analysis.Report.Regenerate}} para atualizar a revisão.
