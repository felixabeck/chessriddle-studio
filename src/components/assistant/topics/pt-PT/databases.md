---
id: databases
title: Bases de dados, explorador, pesquisa de posição, jogadores e torneios
summary: Adicione ou transfira bases de dados de partidas, escolha uma base de referência, pesquise posições no explorador e consulte partidas, jogadores e torneios.
source: 526f05192ead329f
---

As bases de dados ficam em [[page:library]] ({{label:SideBar.Library}}) junto aos seus ficheiros PGN e são guardadas em [[setting:databases-directory]].

Para adicionar uma base de dados, abra [[page:library]] e clique em {{label:Library.AddDatabase}}:
- {{label:Databases.Add.Web}}: transfira bases de dados selecionadas do catálogo.
- {{label:Common.Local}}: escolha um ficheiro PGN local (incluindo `.pgn.zst` ou `.pgn.bz2`), introduza um {{label:Common.Name}} e uma {{label:Common.Description}} opcional e clique em {{label:Databases.Add.Convert}}.

Selecione uma base de dados em [[page:library]] para a gerir:
- Marque {{label:Databases.Settings.ReferenceDatabase}} para a definir como a base de referência predefinida para o explorador, o criador de repertórios, as novidades do relatório de partida e o Coach.
- Marque {{label:Databases.Settings.Indexed}} para criar ou remover índices de pesquisa e acelerar as consultas.
- Clique em {{label:Databases.Settings.Explore}} para abrir a vista de tabela da base de dados.
- Em {{label:Databases.Settings.Actions}}, utilize {{label:Databases.Settings.AddGames}} para acrescentar ficheiros PGN, {{label:Databases.Settings.ExportPGN}} para exportar para PGN ou {{label:Common.Delete}} para remover a base de dados.
- Em {{label:Databases.Settings.AdvancedTools}}, utilize {{label:Databases.Settings.MergePlayers}} para combinar registos duplicados de jogadores, ou {{label:Databases.Settings.RemoveDup}} e {{label:Databases.Settings.RemoveEmpty}} para limpar partidas.

Dentro da vista de tabela da base de dados, alterne entre {{label:Common.Games}}, {{label:Databases.Card.Players}} e {{label:Databases.Settings.Events}} (torneios):
- Pesquise e ordene partidas, pré-visualize uma partida (a pré-visualização pode ocultar os lances com o botão do olho, [[setting:hide-preview-moves]]) ou abra-a no tabuleiro de análise.
- Em {{label:Databases.Card.Players}}, selecione um jogador para consultar {{label:Home.Personal.Overview}}, {{label:Home.Personal.Ratings}} e {{label:Home.Personal.Openings}} (uma árvore de aberturas interativa com o botão {{label:Databases.OpeningTree.Prepare}}), bem como informação FIDE através de {{label:Databases.FIDE.Info}}.
- Em {{label:Databases.Settings.Events}}, pesquise torneios por nome e ordene por data, jogadores, partidas ou Elo médio.

No cartão de um jogador, abra o separador {{label:Home.Personal.Preparation}} para comparar as partidas dele com os seus ficheiros de repertório:
- Escolha a cor do adversário, o período {{label:Databases.OpeningTree.Since}} e (com contas online associadas) {{label:Databases.OpeningTree.OverTheBoard}}, {{label:Databases.OpeningTree.Online}} ou {{label:Databases.Preparation.Both}}. Clique em {{label:Databases.Preparation.Refresh}} para repetir a comparação.
- Aumente {{label:Databases.Preparation.MinGames}} para ocultar as linhas e lacunas que o adversário jogou só raramente; o seu ficheiro recolhe essas linhas e o treino deixa-as de fora.
- Veja as linhas que o adversário joga e {{label:Databases.Preparation.GapsTitle}}. Clique em qualquer linha para abrir o seu ficheiro de repertório nessa posição com as restantes variantes secundárias ocultas; alterne entre {{label:Notation.PreparationOpponentLines}} e {{label:Notation.PreparationAllLines}} no cabeçalho da notação.
- Clique em {{label:Databases.Preparation.TrainLines}} para iniciar uma sessão cronometrada sobre essas linhas; as suas respostas atualizam o calendário normal de repetição espaçada.
- Para se preparar contra um adversário que só tem uma conta no Lichess ou Chess.com, clique em {{label:Library.OnlineOpponent}} em [[page:library]] para procurar a conta, transferir as partidas e abrir o cartão diretamente no separador {{label:Home.Personal.Preparation}} (ao introduzir novamente a mesma conta, reabre sem transferir outra vez).

No tabuleiro de análise, abra {{label:Board.Tabs.Database}} para usar o explorador de aberturas:
- Escolha {{label:Board.Database.LichessAll}} ou {{label:Board.Database.LichessMaster}} no menu de fontes e em {{label:Board.Database.Compare}} (os exploradores em linha do Lichess requerem uma conta Lichess com sessão iniciada em [[page:accounts]]).
- {{label:Board.Database.Stats}} (estatísticas de lances) aparece em cima e {{label:Board.Database.Games}} (partidas correspondentes) em baixo; arraste o separador entre ambos para dividir a altura. A coluna {{label:Board.Area.Notation}} mostra os lances a partir da posição no tabuleiro, com o lance seguinte a negrito.
- Clique em {{label:Board.Database.Compare}} para ver duas fontes lado a lado, ou abra {{label:Board.Database.Local.Position}} para alternar entre pesquisa de posição {{label:Board.Database.Local.Exact}} e {{label:Board.Database.Local.Partial}} (incluindo {{label:Board.Database.Local.SimilarStructure}} para pesquisa por estrutura de peões e {{label:Fen.Empty}} para padrões personalizados).
- Também pode mostrar {{label:Board.Tabs.Database}} como uma área própria no tabuleiro de análise e utilizar {{label:Board.Area.ReturnToTabs}} para a devolver aos separadores.
- Quando {{label:Databases.OpeningTree.Prepare}} abre um tabuleiro para um jogador da base de dados, o explorador começa com a sua base de referência como outra coluna ao lado das partidas do adversário; clique em {{label:Board.Database.RemoveReference}} para ocultar uma coluna ou em {{label:Board.Database.AddColumn}} para adicionar outra.
