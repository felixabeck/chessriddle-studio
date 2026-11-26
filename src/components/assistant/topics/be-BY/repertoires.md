---
id: repertoires
title: Дэбютныя рэпертуары
summary: Стварэнне рэпертуару, імпарт PGN, пабудова пакрыцця па даведачнай базе, трэніроўка з інтэрвальным паўтарэннем і адсочванне незавершаных варыяцый, транспазіцый і пазнак праверкі.
source: db00ec0860d0fa31
---

Рэпертуары — гэта файлы PGN з тыпам «Рэпертуар», якія дадаюць на дошку аналізу ўкладку {{label:Board.Tabs.Practice}}.

Каб стварыць рэпертуар, адкрыйце [[page:new-tab]] і націсніце {{label:Home.Card.NewRepertoire.Title}} (або стварыце файл рэпертуару ў [[page:library]]). Увядзіце {{label:Common.Name}}, выберыце {{label:Common.WHITE}} або {{label:Common.BLACK}}, па жаданні абярыце або ўстаўце PGN у раздзеле {{label:Home.Card.NewRepertoire.FromPgn}} і націсніце {{label:Common.Create}}. Таксама можна імпартаваць PGN праз {{label:Home.Card.ImportGame.Title}}, уключыўшы {{label:Import.SaveToCollection}} і выбраўшы тып {{label:Files.FileType.Repertoire}}.

Будуйце свой рэпертуар у {{label:Board.Tabs.Practice}} -> {{label:Board.Practice.Build}}:
- Націсніце {{label:Board.Practice.Build.ImportPgn}}, каб аб’яднаць файл PGN або ўстаўленыя партыі з адкрытым рэпертуарам (працуе і з даведачнай базай, і без яе).
- Задайце {{label:Databases.Settings.ReferenceDatabase}} у [[page:library]], каб канструктар паказваў частату хадоў і пакрыццё.
- У пустым рэпертуары можна пачаць з аднаго з убудаваных шаблонаў {{label:Board.Practice.Build.Presets}} або ўвесці хады на дошцы.
- Пазначце пачатковую пазіцыю вашага рэпертуару з дапамогай {{label:Board.Practice.Build.SetAsStart}} (або пстрыкніце правай кнопкай па ходзе ў натацыі і выберыце {{label:Menu.MarkAsStart}}).
- Націскайце на хады ў {{label:Board.Practice.Build.OpponentMoves}} або {{label:Board.Practice.Build.YourResponse}}, каб дадаваць ці праглядаць лініі. Выкарыстоўвайце {{label:Board.Practice.Build.NextGap}} і {{label:Board.Practice.Build.BiggestGap}}, каб пераходзіць да непакрытых адказаў саперніка з колькасцю партый вышэй за парог [[setting:repertoire-depth]].

Трэніруйце свой рэпертуар у {{label:Board.Tabs.Practice}} -> {{label:Board.Practice.Train}}:
- Націсніце {{label:Board.Practice.StartPractice}}, каб адпрацоўваць пратэрмінаваныя і новыя пазіцыі з дапамогай інтэрвальнага паўтарэння, або {{label:Board.Practice.PracticeFullRepertoire}}, каб трэніраваць усе пазіцыі ў рэпертуары.
- Згуляйце падрыхтаваны ход на дошцы. Калі затрымаліся пасля няправільнага ходу, націсніце {{label:Board.Practice.ShowMove}}.
- Праглядайце ўсе карткі праз {{label:Board.Practice.ShowAll}}, гісторыю праз {{label:Board.Practice.ShowLogs}} або скідайце прагрэс кнопкай {{label:Common.Reset}}.
- Рэпертуары з карткамі да паўтарэння таксама адлюстроўваюцца ў фільтры {{label:Home.Library.Due}} на старонцы [[page:new-tab]].
- Наладзьце ацэньванне інтэрвальнага паўтарэння і ліміты новых картак у [[settings-category:repertoire]] ([[setting:practice-grading]], [[setting:practice-new-per-session]]).

У натацыі на дошцы аналізу:
- Бакавая лінія даўжынёй усяго ў адзін ход абводзіцца пункцірнай рамкай як {{label:Notation.OpenVariation}}, каб вы бачылі незавершаныя галіны. Націсніце спалучэнне клавіш {{label:Settings.Keybinds.Actions.NEXT_OPEN_VARIATION}}, каб перайсці да наступнай такой галіны.
- Калі пазіцыя сустракаецца ў іншай галіне таго ж рэпертуару, побач з ходам з’яўляецца значок {{label:Notation.Transposition}}; націсніце на яго, каб перайсці да іншай галіны.
- Калі імпартаваны PGN змяшчае іншы адказ для вашага боку, імпартаваны ход дадаецца як варыянт і пазначаецца як {{label:Notation.ReviewMove}}. Пстрыкніце правай кнопкай па ходзе і выберыце {{label:Menu.MarkAsReviewed}}, каб зняць пазнаку.
