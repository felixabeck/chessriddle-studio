---
id: ai-connections
title: Coach та підключення ШІ
summary: Підключіть провайдера ШІ або локальну модель, щоб використовувати Coach на дошці аналізу та Assistant.
source: eac73d15e14729e1
---

Підключення ШІ забезпечують роботу як Coach (на дошці аналізу), так і Assistant. Керуйте своїми підключеннями в розділі [[settings-category:coach]] ({{label:Settings.AI}}).

Щоб додати підключення, виберіть один із варіантів у [[settings-category:coach]]:
- {{label:Settings.Coach.SignIn.ChatGpt}}: увійдіть за допомогою облікового запису ChatGPT у браузері.
- {{label:Settings.Coach.SignIn.Grok}}: увійдіть у Grok за кодом пристрою (неофіційно).
- {{label:Settings.Coach.Connections.Add}}: введіть базову адресу, сумісну з OpenAI, та за потреби ключ API. Доступні пресети для OpenAI, Google Gemini, DeepSeek, Qwen, OpenRouter, Ollama та LM Studio.

Ключі та облікові дані для входу зберігаються в системному сховищі ключів вашого комп’ютера. Щойно збережено принаймні одне підключення, Assistant з’являється в меню {{label:Menu.Help}} ({{label:Menu.Help.Assistant}}) і в рядку навігації ({{label:Navigation.Assistant}}).

Виберіть підключення, модель і рівень міркування у [[setting:coach-model]] ({{label:Settings.Coach.Model}}). І Coach, і Assistant відповідають із цим єдиним вибором. Кнопка моделі поруч із {{label:Coach.Send}} на будь-якій із панелей показує, яка модель відповідає, та змінює цей самий вибір; поруч розташована {{label:Coach.NewConversation}}.

Скористайтеся {{label:Settings.Coach.Connection.Check}} на підключенні, щоб перевірити його й отримати список доступних моделей, або {{label:Settings.Coach.Connection.Remove}}, щоб видалити його.

Щоб користуватися Coach на дошці аналізу:
- Відкрийте вкладку {{label:Board.Tabs.Coach}} (або натисніть комбінацію клавіш {{label:Settings.Keybinds.Actions.COACH_TAB}}).
- Для перевірки варіантів аналізу Coach потребує локальний шаховий рушій. Виберіть, який рушій використовувати, у [[setting:coach-engine]] ({{label:Settings.Coach.Engine}}) або встановіть рушій на сторінці [[page:engines]] ({{label:SideBar.Engines}}).
- Ставте запитання про поточну позицію. Перед першим повідомленням до підключення Studio показує сповіщення з переліком даних, які надсилаються (позиція, PGN поточної партії, аналіз рушія, статистика ходів із довідкової бази даних, якщо її вибрано, та відповідні лінії репертуару).
- На лінії ходів у відповідях Coach можна навести курсор або клацнути, щоб переглянути їх на мінідошці без зміни партії. Натисніть {{label:Coach.InsertLine}} поруч із лінією, щоб вставити її як варіант.
