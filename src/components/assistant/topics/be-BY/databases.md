---
id: databases
title: Базы дадзеных, аглядальнік, пошук пазіцый, гульцы і турніры
summary: Даданне або спампоўка баз партый, выбар даведачнай базы, пошук пазіцый у аглядальніку, а таксама прагляд партый, гульцоў і турніраў.
source: 48c72137fadc1768
---

Базы дадзеных знаходзяцца ў [[page:library]] ({{label:SideBar.Library}}) побач з вашымі файламі PGN і захоўваюцца ў [[setting:databases-directory]].

Каб дадаць базу дадзеных, адкрыйце [[page:library]] і націсніце {{label:Library.AddDatabase}}:
- {{label:Databases.Add.Web}}: спампаваць падрыхтаваныя базы партый з каталога.
- {{label:Common.Local}}: выбраць лакальны файл PGN (уключаючы `.pgn.zst` ці `.pgn.bz2`), увесці {{label:Common.Name}}, па жаданні дадаць {{label:Common.Description}} і націснуць {{label:Databases.Add.Convert}}.

Выберыце базу дадзеных у [[page:library]], каб кіраваць ёю:
- Адзначце {{label:Databases.Settings.ReferenceDatabase}}, каб зрабіць яе даведачнай базай па змаўчанні для аглядальніка, канструктара рэпертуару, навінак у справаздачы па партыі і Coach.
- Адзначце {{label:Databases.Settings.Indexed}}, каб стварыць або выдаліць пошукавыя індэксы для хутчэйшага пошуку.
- Націсніце {{label:Databases.Settings.Explore}}, каб адкрыць таблічны прагляд базы дадзеных.
- У раздзеле {{label:Databases.Settings.Actions}} выкарыстоўвайце {{label:Databases.Settings.AddGames}} для дадання файлаў PGN, {{label:Databases.Settings.ExportPGN}} для экспарту ў PGN або {{label:Common.Delete}} для выдалення базы.
- У раздзеле {{label:Databases.Settings.AdvancedTools}} выкарыстоўвайце {{label:Databases.Settings.MergePlayers}} для аб’яднання дублікатаў гульцоў або {{label:Databases.Settings.RemoveDup}} і {{label:Databases.Settings.RemoveEmpty}} для ачысткі партый.

У таблічным праглядзе базы дадзеных пераключайцеся паміж {{label:Common.Games}}, {{label:Databases.Card.Players}} і {{label:Databases.Settings.Events}} (турнірамі):
- Шукайце і сартуйце партыі, праглядайце партыю або адкрывайце яе на дошцы аналізу.
- У раздзеле {{label:Databases.Card.Players}} выберыце гульца, каб праглядзець {{label:Home.Personal.Overview}}, {{label:Home.Personal.Ratings}} і {{label:Home.Personal.Openings}} (інтэрактыўнае дрэва дэбютаў з кнопкай {{label:Databases.OpeningTree.Prepare}}), а таксама звесткі ФІДЭ праз {{label:Databases.FIDE.Info}}.
- У раздзеле {{label:Databases.Settings.Events}} шукайце турніры па назве і сартуйце па даце, колькасці гульцоў, партый або сярэднім рэйтынгу Эла.

На дошцы аналізу адкрыйце ўкладку {{label:Board.Tabs.Database}}, каб карыстацца дэбютным аглядальнікам:
- Пераключайцеся паміж {{label:Board.Database.Local}}, {{label:Board.Database.LichessAll}} і {{label:Board.Database.LichessMaster}} (анлайн-аглядальнікі Lichess патрабуюць уваходу ў акаўнт Lichess на старонцы [[page:accounts]]).
- Пераключайцеся паміж {{label:Board.Database.Stats}} (статыстыка хадоў) і {{label:Board.Database.Games}} (адпаведныя партыі).
- Для лакальных баз дадзеных націсніце {{label:Board.Database.Compare}}, каб параўнаць дзве базы побач, або адкрыйце {{label:Board.Database.Local.Position}} для пераключэння паміж пошукам пазіцыі {{label:Board.Database.Local.Exact}} і {{label:Board.Database.Local.Partial}} (уключаючы {{label:Board.Database.Local.SimilarStructure}} для пошуку па пешкавай структуры і {{label:Fen.Empty}} для адвольных шаблонаў).
- Выкарыстоўвайце {{label:Board.Database.Pin}}, каб замацаваць аглядальнік над або пад дошкай ці натацыяй, і {{label:Board.Database.Unpin}}, каб вярнуць яго ва ўкладкі.
