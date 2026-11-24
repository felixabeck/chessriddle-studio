---
id: chessbase-import
title: Импорт баз данных из ChessBase
summary: Экспорт базы данных ChessBase в PGN и конвертация её в базу данных Studio.
source: d7f599a811a0afb0
---

ChessRiddle Studio не читает файлы ChessBase `.cbh` и `.cbv` напрямую. Вместо этого сначала экспортируйте базу данных ChessBase в PGN, а затем конвертируйте PGN-файл в базу данных Studio.

Если вы выберете файл ChessBase в диалоге выбора файла, Studio автоматически откроет окно {{label:ChessBaseGuide.Title}}. Его также можно открыть по ссылке руководства внутри {{label:Library.AddDatabase}} на странице [[page:library]].

Чтобы выполнить импорт из ChessBase, сделайте следующее:
1. Откройте базу данных в ChessBase и выберите партии, которые хотите экспортировать.
2. Экспортируйте или сохраните выбранные партии в виде файла `.pgn` в ChessBase.
3. В Studio откройте [[page:library]], нажмите {{label:Library.AddDatabase}}, перейдите на вкладку {{label:Common.Local}}, выберите экспортированный файл `.pgn`, укажите {{label:Common.Name}} и нажмите {{label:Databases.Add.Convert}}.

После конвертации база данных появится в [[page:library]], где вы сможете просматривать партии, игроков и турниры или назначить её как {{label:Databases.Settings.ReferenceDatabase}}.
