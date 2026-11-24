---
id: chessbase-import
title: Імпарт баз дадзеных з ChessBase
summary: Экспартуйце базу дадзеных ChessBase у PGN і канвертуйце яе ў базу дадзеных Studio.
source: d7f599a811a0afb0
---

ChessRiddle Studio не чытае файлы ChessBase `.cbh` і `.cbv` наўпрост. Замест гэтага спачатку экспартуйце базу дадзеных ChessBase у PGN, а потым канвертуйце файл PGN у базу дадзеных Studio.

Калі вы выбераце файл ChessBase у акне выбару файла, Studio аўтаматычна адкрые дыялог {{label:ChessBaseGuide.Title}}. Яго таксама можна адкрыць па спасылцы кіраўніцтва ўнутры {{label:Library.AddDatabase}} на старонцы [[page:library]].

Выканайце гэтыя крокі для імпарту з ChessBase:
1. Адкрыйце базу дадзеных у ChessBase і выберыце партыі, якія хочаце экспартаваць.
2. Экспартуйце або захавайце выбраныя партыі ў выглядзе файла `.pgn` у ChessBase.
3. У Studio адкрыйце [[page:library]], націсніце {{label:Library.AddDatabase}}, перайдзіце на ўкладку {{label:Common.Local}}, выберыце экспартаваны файл `.pgn`, задайце {{label:Common.Name}} і націсніце {{label:Databases.Add.Convert}}.

Пасля канвертацыі база дадзеных з’явіцца ў [[page:library]], дзе вы зможаце праглядаць яе партыі, гульцоў і турніры або прызначыць яе як {{label:Databases.Settings.ReferenceDatabase}}.
