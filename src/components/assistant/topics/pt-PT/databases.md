---
id: databases
title: Bases de dados, explorador, pesquisa de posição, jogadores e torneios
summary: Adicione ou transfira bases de dados de partidas, escolha uma base de referência, pesquise posições no explorador e consulte partidas, jogadores e torneios.
source: 48c72137fadc1768
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
- Pesquise e ordene partidas, pré-visualize uma partida ou abra-a no tabuleiro de análise.
- Em {{label:Databases.Card.Players}}, selecione um jogador para consultar {{label:Home.Personal.Overview}}, {{label:Home.Personal.Ratings}} e {{label:Home.Personal.Openings}} (uma árvore de aberturas interativa com o botão {{label:Databases.OpeningTree.Prepare}}), bem como informação FIDE através de {{label:Databases.FIDE.Info}}.
- Em {{label:Databases.Settings.Events}}, pesquise torneios por nome e ordene por data, jogadores, partidas ou Elo médio.

No tabuleiro de análise, abra {{label:Board.Tabs.Database}} para usar o explorador de aberturas:
- Alterne entre {{label:Board.Database.Local}}, {{label:Board.Database.LichessAll}} e {{label:Board.Database.LichessMaster}} (os exploradores em linha do Lichess requerem uma conta Lichess com sessão iniciada em [[page:accounts]]).
- Alterne entre {{label:Board.Database.Stats}} (estatísticas de lances) e {{label:Board.Database.Games}} (partidas correspondentes).
- Para bases de dados locais, clique em {{label:Board.Database.Compare}} para ver duas bases lado a lado, ou abra {{label:Board.Database.Local.Position}} para alternar entre pesquisa de posição {{label:Board.Database.Local.Exact}} e {{label:Board.Database.Local.Partial}} (incluindo {{label:Board.Database.Local.SimilarStructure}} para pesquisa por estrutura de peões e {{label:Fen.Empty}} para padrões personalizados).
- Utilize {{label:Board.Database.Pin}} para fixar o explorador acima ou abaixo do tabuleiro ou da notação, e {{label:Board.Database.Unpin}} para o devolver aos separadores.
