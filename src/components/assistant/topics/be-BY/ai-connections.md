---
id: ai-connections
title: Coach і падключэнні ШІ
summary: Падключыце правайдэра ШІ або лакальную мадэль, каб выкарыстоўваць Coach на дошцы аналізу і Assistant.
source: eac73d15e14729e1
---

Падключэнні ШІ забяспечваюць працу як Coach (на дошцы аналізу), так і Assistant. Кіруйце сваімі падключэннямі ў [[settings-category:coach]] ({{label:Settings.AI}}).

Каб дадаць падключэнне, выберыце адзін з варыянтаў у [[settings-category:coach]]:
- {{label:Settings.Coach.SignIn.ChatGpt}}: увайдзіце з дапамогай уліковага запісу ChatGPT у браўзеры.
- {{label:Settings.Coach.SignIn.Grok}}: увайдзіце ў Grok з дапамогай кода прылады (неафіцыйна).
- {{label:Settings.Coach.Connections.Add}}: увядзіце базавы адрас, сумяшчальны з OpenAI, і па жаданні ключ API. Даступныя прадусталяваныя налады для OpenAI, Google Gemini, DeepSeek, Qwen, OpenRouter, Ollama і LM Studio.

Ключы і даныя ўваходу захоўваюцца ў сістэмным сховішчы ключоў вашага камп’ютара. Як толькі захавана хаця б адно падключэнне, Assistant з’яўляецца ў меню {{label:Menu.Help}} ({{label:Menu.Help.Assistant}}) і ў радку навігацыі ({{label:Navigation.Assistant}}).

Выберыце падключэнне, мадэль і ўзровень разважанняў у [[setting:coach-model]] ({{label:Settings.Coach.Model}}). І Coach, і Assistant адказваюць з гэтым адзіным выбарам. Кнопка мадэлі побач з {{label:Coach.Send}} на любой з панэляў паказвае, якая мадэль адказвае, і змяняе гэты ж выбар; побач знаходзіцца {{label:Coach.NewConversation}}.

Націсніце {{label:Settings.Coach.Connection.Check}} на падключэнні, каб праверыць яго і паказаць спіс даступных мадэляў, або {{label:Settings.Coach.Connection.Remove}}, каб выдаліць яго.

Каб карыстацца Coach на дошцы аналізу:
- Адкрыйце ўкладку {{label:Board.Tabs.Coach}} (або націсніце спалучэнне клавіш {{label:Settings.Keybinds.Actions.COACH_TAB}}).
- Для праверкі варыянтаў аналізу Coach патрэбны лакальны шахматны рухавік. Выберыце, які рухавік ён выкарыстоўвае, у [[setting:coach-engine]] ({{label:Settings.Coach.Engine}}) або ўсталюйце рухавік на старонцы [[page:engines]] ({{label:SideBar.Engines}}).
- Задавайце пытанні пра бягучую пазіцыю. Перад першым паведамленнем праз падключэнне Studio пакажа паведамленне са спісам дадзеных, якія адпраўляюцца (пазіцыя, PGN бягучай партыі, аналіз рухавіка, статыстыка хадоў з даведачнай базы дадзеных, калі яна выбрана, і адпаведныя лініі рэпертуару).
- На лініі хадоў у адказах Coach можна навесці курсор або націснуць, каб праглядзець іх на міні-дошцы без змены партыі. Націсніце {{label:Coach.InsertLine}} побач з лініяй, каб уставіць яе як варыяцыю.
