---
id: feedback
title: Comentários, registos, limpeza de dados guardados e atualizações
summary: Envie comentários, abra os registos da aplicação, recarregue ou limpe os dados guardados, consulte a versão da aplicação e instale atualizações.
source: 8b0ca5aebb70e04f
---

Utilize [[feedback]] ({{label:Menu.Help.SendFeedback}}) para comunicar um erro, sugerir uma funcionalidade, enviar um elogio ou partilhar outras observações diretamente com o programador.

Pode abrir o formulário de comentários a qualquer momento através do botão {{label:Navigation.Feedback}} na barra de navegação ou em {{label:Menu.Help}} -> {{label:Menu.Help.SendFeedback}}.

No formulário pode escolher um tipo ({{label:Feedback.Type.Bug}}, {{label:Feedback.Type.Suggestion}}, {{label:Feedback.Type.Praise}} ou {{label:Feedback.Type.Other}}), escrever uma mensagem (10 a 5.000 caracteres), indicar opcionalmente um endereço de e-mail para resposta e anexar opcionalmente uma captura de ecrã ({{label:Feedback.TakeScreenshot}}) ou uma imagem ({{label:Feedback.ChooseImage}}). A versão da aplicação e o sistema operativo são incluídos com a mensagem.

Quando o Assistant prepara um rascunho de comentário para si, clicar em [[feedback]] abre o formulário preenchido com esse rascunho. Nada é enviado até rever o texto e clicar em {{label:Feedback.Submit}}.

As ferramentas de resolução de problemas encontram-se em [[settings-category:advanced]] ({{label:Settings.Advanced}}):
- **Registos**: abra [[setting:open-logs]] ({{label:Menu.Help.OpenLogs}}) para abrir a pasta que contém os ficheiros de registo da aplicação.
- **Recarregar**: abra [[setting:reload]] ({{label:Menu.View.Reload}}) para recarregar a janela da aplicação.
- **Limpar dados guardados**: abra [[setting:clear-saved-data]] ({{label:Menu.Help.ClearSavedData}}) para repor as definições e os dados de sessão guardados após confirmação. Isto não elimina os seus ficheiros PGN nem bases de dados da área de trabalho, e é bloqueado caso os dados de treino não possam ser migrados em segurança.

**Versão da aplicação e atualizações**:
- Consulte a versão instalada, a versão do Tauri e o sistema operativo em {{label:Menu.Help}} -> {{label:Menu.Help.About}} (no macOS, no menu da aplicação), ou no fundo de [[page:settings]].
- O Studio procura atualizações automaticamente após o arranque. Quando houver uma atualização disponível, uma caixa de confirmação pergunta se pretende transferi-la e instalá-la. Se tiver alterações por guardar, o reinício é adiado até guardar ou reiniciar a aplicação.
