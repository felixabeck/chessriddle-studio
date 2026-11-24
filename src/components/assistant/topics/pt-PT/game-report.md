---
id: game-report
title: Relatório da partida
summary: Execute uma revisão automática com motor a uma partida para ver a precisão, o gráfico de avaliação, os momentos-chave e as classificações dos lances.
source: a5e00adfe821f3f3
---

O relatório da partida analisa cada lance da linha principal com um motor de xadrez local e resume a precisão e os erros da partida.

Para gerar um relatório, abra uma partida no tabuleiro de análise, mude para {{label:Board.Tabs.Analysis}} -> {{label:Board.Analysis.Report}} e clique em {{label:Board.Analysis.GenerateReport}} (ou prima o atalho {{label:Settings.Keybinds.Actions.GENERATE_REPORT}}).

Na janela {{label:Board.Analysis.GenerateReport}}:
- Escolha um {{label:Common.Engine}} local. Se nenhum estiver instalado, adicione um em [[page:engines]].
- Defina o limite de pesquisa por lance (profundidade, tempo ou nós).
- Ative {{label:Board.Analysis.MarkMoves}} para anotar os lances com símbolos de qualidade.
- Ative {{label:Board.Analysis.ShowVariations}} para inserir variantes com melhores lances na notação.
- Ative {{label:Board.Analysis.AnnotateNovelties}} para marcar o primeiro lance que sai da sua base de dados de referência. Esta opção requer uma base de referência pronta selecionada em [[page:library]].
- Clique em {{label:Board.Analysis.Analyze}} para iniciar.

Enquanto o relatório estiver em execução, pode cancelá-lo através do botão de progresso. Editar a linha principal cancela um relatório em curso.

Quando terminar, {{label:Board.Analysis.Report}} apresenta:
- Percentagens de precisão e perda média em centipeões (ACPL) para as {{label:Common.WHITE}} e as {{label:Common.BLACK}}.
- Um gráfico de avaliação ao longo da partida.
- {{label:Board.Analysis.Report.KeyMoments}}: lista clicável dos lances assinalados com oscilações de avaliação e melhores lances.
- Uma tabela de distribuição da qualidade dos lances onde clicar numa contagem salta para esses lances.

Se editar a partida posteriormente, clique em {{label:Board.Analysis.RegenerateReport}} para executar uma nova análise.
