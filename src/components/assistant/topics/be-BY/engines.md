---
id: engines
title: Шахматныя рухавікі і панэль аналізу
summary: Усталяванне і даданне лакальных і хмарных рухавікоў, налада параметраў UCI і жывы аналіз на дошцы.
source: f40b5fdf8e5c15a0
---

Кіруйце сваімі шахматнымі рухавікамі на старонцы [[page:engines]] ({{label:SideBar.Engines}}).

Каб дадаць рухавік, націсніце {{label:Common.AddNew}} на старонцы [[page:engines]], каб адкрыць {{label:Engines.Add.Title}}:
- {{label:Common.Download}}: усталяваць папярэдне наладжаны рухавік (напрыклад, Stockfish) з каталога з дапамогай {{label:Common.Install}}.
- {{label:Engines.Add.Cloud}}: дадаць анлайн-рухавікі аналізу (ChessDB або Lichess Cloud) праз {{label:Common.Add}}.
- {{label:Common.Local}}: зарэгістраваць выканальны файл UCI-рухавіка, які ўжо ёсць на вашым камп’ютары.

Выберыце любы рухавік на старонцы [[page:engines]], каб наладзіць яго. Для лакальных рухавікоў можна рэдагаваць агульныя звесткі, задаваць параметры UCI па змаўчанні (напрыклад, Threads, Hash і MultiPV), далучаць файлы рэсурсаў, такія як табліцы Syzygy, націскаць {{label:Engines.Settings.Reset}} для скіду да стандартных значэнняў, {{label:Common.Duplicate}} для капіявання канфігурацыі або {{label:Common.Remove}} для выдалення. Для хмарных рухавікоў можна змяняць назву і {{label:Engines.Settings.NumOfLines}}.

На дошцы аналізу адкрыйце ўкладку {{label:Board.Tabs.Analysis}}:
- Націсніце {{label:Board.Analysis.SelectEngines}}, каб выбраць, якія ўсталяваныя рухавікі загрузіць у панэль, або {{label:Board.Analysis.ManageEngines}}, каб перайсці на [[page:engines]].
- Націсніце {{label:Board.Analysis.EnableEngine}} або {{label:Board.Analysis.DisableEngine}} на картцы рухавіка, каб запусціць ці прыпыніць аналіз, або выкарыстоўвайце {{label:Board.Analysis.EnableAllEngines}} у ніжнім радку.
- Націсніце {{label:Board.Analysis.CheckThreat}} (або спалучэнне клавіш {{label:Settings.Keybinds.Actions.TOGGLE_THREAT_MODE}}), каб прааналізаваць пагрозу саперніка.
- Выберыце ад 1 да 5 ліній на картцы або націсніце {{label:Board.Analysis.EngineSettings}}, каб наладзіць параметры для бягучай укладкі, напрыклад ліміт пошуку і опцыі UCI.
- Перацягніце картку рухавіка за шасцікропкавы маркер ({{label:Board.Analysis.ReorderEngine}}), каб змяніць парадак або вынесці яе на дошку як асобнае акно, ці націсніце на маркер для перамяшчэння з клавіятуры. Націсніце {{label:Board.Area.ReturnToEngines}} або перацягніце акно назад на панэль укладак (ці загаловак {{label:Board.Tabs.Analysis}}), каб вярнуць яго.
- Калі рухавік дае збой, націсніце {{label:Board.Analysis.Logs}} побач з {{label:Board.Analysis.RetryEngine}}, каб праглядзець яго UCI-абмен. Для працуючага рухавіка тая ж кнопка ёсць у {{label:Board.Analysis.EngineSettings}} на яго картцы.

Кіруйце стрэлкамі рухавіка на дошцы з дапамогай [[setting:arrows]] ({{label:Settings.Arrows}}). Лакальныя рухавікі захоўваюцца ў папцы, вызначанай у [[setting:engines-directory]].
