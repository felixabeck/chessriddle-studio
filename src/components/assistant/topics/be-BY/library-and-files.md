---
id: library-and-files
title: Файлы і бібліятэка
summary: Налада працоўнай папкі, стварэнне і ўпарадкаванне файлаў PGN, адкрыццё і захаванне партый, а таксама кіраванне сметніцай.
source: 1c8e1ec37f492b22
---

Раздзел [[page:library]] ({{label:SideBar.Library}}) аб’ядноўвае вашы працоўныя файлы PGN (партыі, рэпертуары, турніры, задачы і іншыя файлы) і базы даных партый.

Перад стварэннем файлаў выберыце працоўную папку. Калі папка яшчэ не зададзена, націсніце {{label:Files.ChooseFolder}} на старонцы [[page:library]] або наладзьце [[setting:files-directory]] ({{label:Settings.Directories.Files}}) у [[settings-category:directories]].

На старонцы [[page:library]]:
- Націсніце {{label:Files.CreateFile}}, каб стварыць новы файл PGN, або {{label:Files.CreateFolder}}, каб упарадкаваць файлы па падпапках.
- Выкарыстоўвайце поле {{label:Common.Search}} і выпадны спіс {{label:Files.FileType}} для фільтрацыі па тыпе файла або па пункце {{label:Library.GamesDatabase}}.
- Выберыце файл, каб праглядзець яго партыі (папярэдні прагляд можа схаваць хады кнопкай-вокам, [[setting:hide-preview-moves]]), адкрыць яго на дошцы аналізу або выкарыстаць дзеянні {{label:Files.Rename}}, {{label:Files.Move}} і {{label:Files.Trash}}.

Падчас рэдагавання файла на дошцы аналізу:
- Захоўвайце змены кнопкай захавання на панэлі інструментаў дошкі, праз {{label:Menu.File}} -> {{label:Common.Save}} або спалучэннем клавіш {{label:Settings.Keybinds.Actions.SAVE_FILE}}.
- Уключыце [[setting:auto-save]] ({{label:Settings.AutoSave}}), каб праўкі ў адкрытых файлах захоўваліся аўтаматычна.
- Выкарыстоўвайце {{label:Menu.File}} -> {{label:Board.Database.Save}} (або кнопку {{label:Board.Database.Save}} на панэлі інструментаў), каб захаваць бягучую партыю ў іншы файл бібліятэкі або базу даных.

Перамяшчэнне файла ў {{label:Files.Trash}} не выдаляе яго назаўсёды адразу. Вы можаце неадкладна націснуць {{label:Common.Undo}} у паведамленні або пракруціць да раздзела {{label:Files.Trash}} у [[page:library]], каб выканаць {{label:Files.Restore}}, {{label:Files.DeletePermanently}} або {{label:Files.EmptyTrash}}.

Калі ваш акаўнт ChessRiddle падключаны, націсніце {{label:Library.Sync.Action}} на старонцы [[page:library]], каб сінхранізаваць выбраныя файлы PGN з вашай прыватнай бібліятэкай на ChessRiddle (да 100 файлаў, 5 МБ і 40 000 хадоў на файл). Змены, перайменаванні, зняцце выбару і выдаленні абнаўляюцца аўтаматычна; спампаваныя гісторыі партый і базы даных партый застаюцца лакальна. Пры выключэнні сінхранізацыі вы можаце пакінуць або выдаліць сінхранізаваныя файлы на ChessRiddle.
