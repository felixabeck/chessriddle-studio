---
id: chessbase-import
title: Імпорт баз даних із ChessBase
summary: Експортуйте базу даних ChessBase у PGN і конвертуйте її в базу даних Studio.
source: d7f599a811a0afb0
---

ChessRiddle Studio не читає файли ChessBase `.cbh` або `.cbv` напряму. Натомість спершу експортуйте свою базу даних ChessBase у формат PGN, а потім конвертуйте файл PGN у базу даних Studio.

Якщо ви виберете файл ChessBase у діалозі вибору файлу, Studio автоматично відкриє вікно {{label:ChessBaseGuide.Title}}. Його також можна відкрити за посиланням посібника всередині {{label:Library.AddDatabase}} на сторінці [[page:library]].

Виконайте ці кроки для імпорту з ChessBase:
1. Відкрийте базу даних у ChessBase і виберіть партії, які потрібно експортувати.
2. Експортуйте або збережіть вибрані партії як файл `.pgn` у ChessBase.
3. У Studio відкрийте [[page:library]], натисніть {{label:Library.AddDatabase}}, перейдіть на вкладку {{label:Common.Local}}, виберіть експортований файл `.pgn`, вкажіть {{label:Common.Name}} і натисніть {{label:Databases.Add.Convert}}.

Після конвертації база даних з’явиться в [[page:library]], де ви зможете переглядати її партії, гравців і турніри або призначити її як {{label:Databases.Settings.ReferenceDatabase}}.
