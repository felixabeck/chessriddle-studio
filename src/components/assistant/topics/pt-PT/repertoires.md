---
id: repertoires
title: Repertórios de aberturas
summary: Crie um repertório, construa cobertura face a uma base de referência, pratique com repetição espaçada e acompanhe variantes abertas e transposições.
source: 62b7ff51627518a7
---

Os repertórios são ficheiros PGN do tipo Repertório que adicionam o separador {{label:Board.Tabs.Practice}} ao tabuleiro de análise.

Para criar um repertório, abra [[page:new-tab]] e clique em {{label:Home.Card.NewRepertoire.Title}} (ou crie um ficheiro de repertório em [[page:library]]). Introduza um {{label:Common.Name}}, escolha {{label:Common.WHITE}} ou {{label:Common.BLACK}} e clique em {{label:Common.Create}}.

Construa o seu repertório em {{label:Board.Tabs.Practice}} -> {{label:Board.Practice.Build}}:
- Defina uma {{label:Databases.Settings.ReferenceDatabase}} em [[page:library]] para que o construtor mostre frequências de lances e cobertura.
- Num repertório vazio, pode começar por um dos modelos integrados em {{label:Board.Practice.Build.Presets}} ou introduzir lances no tabuleiro.
- Defina a posição inicial do seu repertório com {{label:Board.Practice.Build.SetAsStart}} (ou clique com o botão direito num lance da notação e escolha {{label:Menu.MarkAsStart}}).
- Clique nos lances em {{label:Board.Practice.Build.OpponentMoves}} ou {{label:Board.Practice.Build.YourResponse}} para adicionar ou seguir linhas. Utilize {{label:Board.Practice.Build.NextGap}} e {{label:Board.Practice.Build.BiggestGap}} para saltar para respostas do adversário ainda sem cobertura acima do número mínimo de partidas definido em [[setting:repertoire-depth]].

Pratique o seu repertório em {{label:Board.Tabs.Practice}} -> {{label:Board.Practice.Train}}:
- Clique em {{label:Board.Practice.StartPractice}} para treinar posições pendentes e novas com repetição espaçada, ou em {{label:Board.Practice.PracticeFullRepertoire}} para praticar todas as posições do repertório.
- Jogue o seu lance preparado no tabuleiro. Se ficar bloqueado após um lance errado, clique em {{label:Board.Practice.ShowMove}}.
- Inspecione todos os cartões com {{label:Board.Practice.ShowAll}}, consulte o histórico com {{label:Board.Practice.ShowLogs}} ou reponha o progresso com {{label:Common.Reset}}.
- Os repertórios com cartões por rever também aparecem em {{label:Home.Library.Due}} em [[page:new-tab]].
- Configure a classificação por repetição espaçada e os limites de novos cartões em [[settings-category:repertoire]] ([[setting:practice-grading]], [[setting:practice-new-per-session]]).

Na notação do tabuleiro de análise:
- Uma linha secundária com apenas um lance é destacada com uma moldura tracejada como {{label:Notation.OpenVariation}} para identificar ramos inacabados. Prima o atalho {{label:Settings.Keybinds.Actions.NEXT_OPEN_VARIATION}} para saltar para a próxima.
- Quando uma posição aparece noutro ramo do mesmo repertório, surge um ícone {{label:Notation.Transposition}} junto ao lance; clique nele para saltar para o outro ramo.
