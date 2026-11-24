---
id: ai-connections
title: Coach e ligações de IA
summary: Ligue um fornecedor de IA ou um modelo local para ativar o Coach no tabuleiro de análise e o Assistant.
source: db8abb1b23f8812c
---

As ligações de IA alimentam tanto o Coach (no tabuleiro de análise) como o Assistant. Faça a gestão das suas ligações em [[settings-category:coach]] ({{label:Settings.AI}}).

Para adicionar uma ligação, escolha uma destas opções em [[settings-category:coach]]:
- {{label:Settings.Coach.SignIn.ChatGpt}}: inicie sessão com a sua conta ChatGPT no navegador.
- {{label:Settings.Coach.SignIn.Grok}}: inicie sessão no Grok através de um código de dispositivo (não oficial).
- {{label:Settings.Coach.Connections.Add}}: introduza um endereço base compatível com OpenAI e uma chave de API opcional. Estão disponíveis predefinições para OpenAI, Google Gemini, DeepSeek, Qwen, OpenRouter, Ollama e LM Studio.

As chaves e credenciais de início de sessão são guardadas no porta-chaves do sistema do seu computador. Assim que houver pelo menos uma ligação guardada, o Assistant aparece no menu {{label:Menu.Help}} ({{label:Menu.Help.Assistant}}) e na barra de navegação ({{label:Navigation.Assistant}}).

O Coach e o Assistant partilham a mesma ligação, o mesmo modelo e o mesmo nível de raciocínio selecionados. Utilize {{label:Settings.Coach.Connection.Check}} numa ligação para a verificar e listar os modelos disponíveis, ou {{label:Settings.Coach.Connection.Remove}} para a remover.

Para usar o Coach no tabuleiro de análise:
- Abra o separador {{label:Board.Tabs.Coach}} (ou prima o atalho {{label:Settings.Keybinds.Actions.COACH_TAB}}).
- O Coach precisa de um motor de xadrez local para verificar as respetivas linhas de análise. Escolha o motor utilizado em [[setting:coach-engine]] ({{label:Settings.Coach.Engine}}), ou instale um motor em [[page:engines]] ({{label:SideBar.Engines}}).
- Faça perguntas sobre a posição atual. Antes da primeira mensagem enviada a uma ligação, o Studio apresenta um aviso com o que é enviado (a posição, o PGN da partida atual, a análise do motor, as estatísticas de lances da base de dados de referência, se estiver selecionada, e as linhas correspondentes do repertório).
- Passe o cursor ou clique nas sequências de lances nas respostas do Coach para as pré-visualizar num minitabuleiro sem alterar a partida. Clique em {{label:Coach.InsertLine}} junto a uma linha para a inserir como variante.
