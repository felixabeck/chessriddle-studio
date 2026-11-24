---
id: ai-connections
title: Coach и подключения ИИ
summary: Подключение провайдера ИИ или локальной модели для работы Coach на доске анализа и Assistant.
source: eac73d15e14729e1
---

Подключения ИИ обеспечивают работу как Coach (на доске анализа), так и Assistant. Управляйте подключениями в разделе [[settings-category:coach]] ({{label:Settings.AI}}).

Чтобы добавить подключение, выберите один из вариантов в [[settings-category:coach]]:
- {{label:Settings.Coach.SignIn.ChatGpt}}: вход через учётную запись ChatGPT в браузере.
- {{label:Settings.Coach.SignIn.Grok}}: вход через Grok с помощью кода устройства (неофициальный способ).
- {{label:Settings.Coach.Connections.Add}}: ввод базового адреса, совместимого с OpenAI, и при необходимости API-ключа. Доступны готовые пресеты для OpenAI, Google Gemini, DeepSeek, Qwen, OpenRouter, Ollama и LM Studio.

Ключи и данные входа хранятся в системном хранилище ключей вашего компьютера. Как только сохранено хотя бы одно подключение, Assistant появляется в меню {{label:Menu.Help}} ({{label:Menu.Help.Assistant}}) и на верхней панели навигации ({{label:Navigation.Assistant}}).

Выберите подключение, модель и глубину рассуждений в [[setting:coach-model]] ({{label:Settings.Coach.Model}}). И Coach, и Assistant отвечают с помощью этого единого выбора. Кнопка модели рядом с {{label:Coach.Send}} в любой из панелей показывает, какая модель отвечает, и меняет этот же выбор; рядом находится {{label:Coach.NewConversation}}.

Нажмите {{label:Settings.Coach.Connection.Check}} на подключении, чтобы проверить его и получить список доступных моделей, или {{label:Settings.Coach.Connection.Remove}}, чтобы удалить его.

Чтобы использовать Coach на доске анализа:
- Откройте вкладку {{label:Board.Tabs.Coach}} (или нажмите сочетание клавиш {{label:Settings.Keybinds.Actions.COACH_TAB}}).
- Для проверки аналитических вариантов Coach требуется локальный шахматный движок. Выберите, какой движок использовать, в настройке [[setting:coach-engine]] ({{label:Settings.Coach.Engine}}) или установите движок на странице [[page:engines]] ({{label:SideBar.Engines}}).
- Задавайте вопросы о текущей позиции. Перед первым сообщением через подключение Studio покажет уведомление со списком отправляемых данных (позиция, PGN текущей партии, анализ движка, статистика ходов из справочной базы данных, если она выбрана, и подходящие варианты репертуара).
- На варианты ходов в ответах Coach можно навести курсор или нажать, чтобы просмотреть их на мини-доске без изменения партии. Нажмите {{label:Coach.InsertLine}} рядом с вариантом, чтобы вставить его в партию.
