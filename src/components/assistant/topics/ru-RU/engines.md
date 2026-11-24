---
id: engines
title: Шахматные движки и панель анализа
summary: Установка и добавление локальных и облачных движков, настройка параметров UCI и живой анализ на доске.
source: e18a17e22622746d
---

Управляйте шахматными движками на странице [[page:engines]] ({{label:SideBar.Engines}}).

Чтобы добавить движок, нажмите {{label:Common.AddNew}} на странице [[page:engines]], чтобы открыть окно {{label:Engines.Add.Title}}:
- {{label:Common.Download}}: установить готовый движок (например, Stockfish) из каталога с помощью {{label:Common.Install}}.
- {{label:Engines.Add.Cloud}}: добавить онлайн-движки анализа (ChessDB или Lichess Cloud) с помощью {{label:Common.Add}}.
- {{label:Common.Local}}: подключить исполняемый файл UCI-движка, уже находящийся на вашем компьютере.

Выберите любой движок на странице [[page:engines]], чтобы настроить его. Для локальных движков можно изменить общие сведения, задать параметры UCI по умолчанию (например, Threads, Hash и MultiPV), подключить файлы ресурсов, такие как таблицы эндшпилей Syzygy, нажать {{label:Engines.Settings.Reset}} для возврата значений по умолчанию, {{label:Common.Duplicate}} для копирования конфигурации или {{label:Common.Remove}} для удаления. Для облачных движков можно изменить название и {{label:Engines.Settings.NumOfLines}}.

На доске анализа откройте вкладку {{label:Board.Tabs.Analysis}} и выберите {{label:Board.Analysis.Engines}}:
- Нажмите {{label:Board.Analysis.SelectEngines}}, чтобы выбрать, какие установленные движки загрузить в панель, или {{label:Board.Analysis.ManageEngines}}, чтобы перейти на [[page:engines]].
- Нажмите {{label:Board.Analysis.EnableEngine}} или {{label:Board.Analysis.DisableEngine}} на карточке движка для запуска или паузы анализа, либо используйте {{label:Board.Analysis.EnableAllEngines}}, если загружено несколько движков.
- Нажмите {{label:Board.Analysis.CheckThreat}} (или сочетание клавиш {{label:Settings.Keybinds.Actions.TOGGLE_THREAT_MODE}}), чтобы проанализировать угрозу соперника.
- Нажмите {{label:Board.Analysis.Pin}}, чтобы закрепить шкалу оценки движка вне вкладки, или {{label:Board.Analysis.EngineSettings}}, чтобы задать настройки для текущей вкладки, например лимит поиска и число вариантов.
- Перетаскивайте карточки движков за {{label:Board.Analysis.ReorderEngine}}, чтобы изменить их порядок.
- Откройте {{label:Board.Analysis.Logs}} внутри {{label:Board.Tabs.Analysis}}, чтобы просмотреть обмен сообщениями с UCI-движком.

Управляйте стрелками движка на доске в настройке [[setting:arrows]] ({{label:Settings.Arrows}}). Локальные движки хранятся в папке, указанной в [[setting:engines-directory]].
