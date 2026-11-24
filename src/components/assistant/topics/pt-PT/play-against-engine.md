---
id: play-against-engine
title: Jogar contra um motor
summary: Configure uma partida contra um motor local ou outro humano, defina controlos de tempo e livros de aberturas e jogue a partir de qualquer posição.
source: 7c75f4b49a6bdf2c
---

Para iniciar uma partida, abra [[page:new-tab]] e clique em {{label:Home.Card.PlayChess.Button}}. Também pode jogar a partir de qualquer posição num tabuleiro de análise clicando em {{label:Board.Action.PlayFromHere}} na barra de ferramentas do tabuleiro ou clicando com o botão direito num lance da notação.

Antes de iniciar a partida:
- Para cada lado, escolha {{label:Board.Opponent.Human}} (com um nome) ou {{label:Common.Engine}} (selecione um motor instalado de [[page:engines]] e ajuste as opções UCI para esta partida).
- Clique em {{label:Board.Action.ChangeColors}} para trocar Brancas e Pretas.
- Em {{label:Board.Opponent.TimeSettings}}, escolha {{label:GoMode.Time}} (com {{label:GoMode.Time}} e {{label:Board.Opponent.Increment}}) ou {{label:Board.Opponent.Unlimited}}. Marque {{label:Board.Opponent.SameTimeControl}} para partilhar as mesmas definições de relógio em ambos os lados.
- Opcionalmente marque {{label:Board.Opponent.EnableOpeningBook}}, escolha um {{label:Board.Opponent.OpeningBookFile}} e defina {{label:Board.Opponent.OpeningBookMaxPlies}}.
- Utilize {{label:Board.Action.EditPosition}} na barra de ferramentas do tabuleiro antes de começar se quiser jogar a partir de uma posição personalizada.
- Clique em {{label:Board.Opponent.StartGame}} para começar.

Durante uma partida:
- Os lances antecipados (premoves) estão ativos ao jogar como humano contra um motor.
- Utilize {{label:Board.Action.TakeBack}} na barra de ferramentas do tabuleiro para anular o último lance.
- Clique em {{label:Board.Opponent.Resign}} (ou {{label:Board.Opponent.Abort}} num encontro entre motores) para terminar a partida.
- Clique em {{label:Board.Analysis.Analyze}} a qualquer momento para mudar o separador para modo de análise, ou em {{label:Board.Analysis.Logs}} para consultar os registos do motor.
- Quando a partida terminar, clique em {{label:Home.NewGame}} para configurar outra partida.
