---
id: engines
title: Motores de xadrez e o painel de análise
summary: Instale ou adicione motores locais e na nuvem, configure opções UCI e utilize a análise em direto no tabuleiro.
source: f40b5fdf8e5c15a0
---

Faça a gestão dos seus motores de xadrez em [[page:engines]] ({{label:SideBar.Engines}}).

Para adicionar um motor, clique em {{label:Common.AddNew}} em [[page:engines]] para abrir {{label:Engines.Add.Title}}:
- {{label:Common.Download}}: instale um motor pré-configurado (como o Stockfish) a partir do catálogo com {{label:Common.Install}}.
- {{label:Engines.Add.Cloud}}: adicione motores de análise em linha (ChessDB ou Lichess Cloud) com {{label:Common.Add}}.
- {{label:Common.Local}}: registe um executável de motor UCI que já tenha no computador.

Selecione qualquer motor em [[page:engines]] para o configurar. Nos motores locais pode editar os detalhes gerais, definir opções UCI predefinidas (como Threads, Hash e MultiPV), associar ficheiros de recursos como tabelas de finais Syzygy, clicar em {{label:Engines.Settings.Reset}} para repor os valores predefinidos, {{label:Common.Duplicate}} para copiar a configuração ou {{label:Common.Remove}} para o remover. Nos motores na nuvem pode editar o nome e {{label:Engines.Settings.NumOfLines}}.

No tabuleiro de análise, abra o separador {{label:Board.Tabs.Analysis}}:
- Clique em {{label:Board.Analysis.SelectEngines}} para escolher quais os motores instalados carregados no painel, ou em {{label:Board.Analysis.ManageEngines}} para ir para [[page:engines]].
- Clique em {{label:Board.Analysis.EnableEngine}} ou {{label:Board.Analysis.DisableEngine}} no cartão de um motor para iniciar ou pausar a análise, ou utilize {{label:Board.Analysis.EnableAllEngines}} na linha inferior.
- Clique em {{label:Board.Analysis.CheckThreat}} (ou prima o atalho {{label:Settings.Keybinds.Actions.TOGGLE_THREAT_MODE}}) para analisar a ameaça do adversário.
- Use o seletor de linhas no cartão para escolher de 1 a 5 linhas, ou clique em {{label:Board.Analysis.EngineSettings}} para ajustar definições por separador como limite de pesquisa e opções UCI.
- Arraste um cartão de motor pela pega de seis pontos ({{label:Board.Analysis.ReorderEngine}}) para o reordenar ou puxá-lo para o tabuleiro como janela própria, ou clique na pega para o mover por teclado. Clique em {{label:Board.Area.ReturnToEngines}} ou arraste a janela de volta sobre a lista de separadores (ou o cabeçalho de {{label:Board.Tabs.Analysis}}) para a devolver.
- Quando um motor falha, clique em {{label:Board.Analysis.Logs}} junto a {{label:Board.Analysis.RetryEngine}} para consultar a comunicação UCI. Com um motor em execução, o mesmo botão está em {{label:Board.Analysis.EngineSettings}} no respetivo cartão.

Controle as setas do motor no tabuleiro através de [[setting:arrows]] ({{label:Settings.Arrows}}). Os motores locais são guardados na pasta definida em [[setting:engines-directory]].
