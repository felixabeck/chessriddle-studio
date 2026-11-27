---
id: databases
title: Базы дадзеных, аглядальнік, пошук пазіцый, гульцы і турніры
summary: Даданне або спампоўка баз партый, выбар даведачнай базы, пошук пазіцый у аглядальніку, а таксама прагляд партый, гульцоў і турніраў.
source: 221e2b80a6351752
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
- Шукайце і сартуйце партыі, праглядайце партыю (папярэдні прагляд можа схаваць хады кнопкай-вокам, [[setting:hide-preview-moves]]) або адкрывайце яе на дошцы аналізу.
- У раздзеле {{label:Databases.Card.Players}} выберыце гульца, каб праглядзець {{label:Home.Personal.Overview}}, {{label:Home.Personal.Ratings}} і {{label:Home.Personal.Openings}} (інтэрактыўнае дрэва дэбютаў з кнопкай {{label:Databases.OpeningTree.Prepare}}), а таксама звесткі ФІДЭ праз {{label:Databases.FIDE.Info}}.
- У раздзеле {{label:Databases.Settings.Events}} шукайце турніры па назве і сартуйце па даце, колькасці гульцоў, партый або сярэднім рэйтынгу Эла.

На картцы гульца адкрыйце ўкладку {{label:Home.Personal.Preparation}}, каб параўнаць яго партыі з вашымі файламі рэпертуару:
- Выберыце колер саперніка, перыяд {{label:Databases.OpeningTree.Since}} і (пры падлучаных анлайн-акаўнтах) {{label:Databases.OpeningTree.OverTheBoard}}, {{label:Databases.OpeningTree.Online}} або {{label:Databases.Preparation.Both}}. Націсніце {{label:Databases.Preparation.Refresh}}, каб запусціць параўнанне зноў.
- Павялічце {{label:Databases.Preparation.MinGames}}, каб схаваць варыянты і прабелы, якія сапернік гуляў толькі зрэдку; файл згорне гэтыя варыянты, а трэніроўка іх прапусціць.
- Праглядзіце варыянты, якія гуляе сапернік, і {{label:Databases.Preparation.GapsTitle}}. Націсніце любы радок, каб адкрыць свой файл рэпертуару на гэтай пазіцыі са схаванымі іншымі адгалінаваннямі; у загалоўку натацыі пераключайцеся паміж {{label:Notation.PreparationOpponentLines}} і {{label:Notation.PreparationAllLines}}.
- Націсніце {{label:Databases.Preparation.TrainLines}}, каб запусціць трэніроўку на час па гэтых варыянтах; вашы адказы абнаўляюць звычайны расклад інтэрвальных паўтораў.
- Каб падрыхтавацца да саперніка, які мае толькі акаўнт на Lichess або Chess.com, націсніце {{label:Library.OnlineOpponent}} у [[page:library]], каб знайсці яго акаўнт, спампаваць партыі і адкрыць картку адразу на ўкладцы {{label:Home.Personal.Preparation}} (паўторны ўвод таго ж акаўнта адкрые картку без паўторнай спампоўкі).

На дошцы аналізу адкрыйце ўкладку {{label:Board.Tabs.Database}}, каб карыстацца дэбютным аглядальнікам:
- Выберыце {{label:Board.Database.LichessAll}} або {{label:Board.Database.LichessMaster}} у меню крыніц і ў {{label:Board.Database.Compare}} (анлайн-аглядальнікі Lichess патрабуюць уваходу ў акаўнт Lichess на старонцы [[page:accounts]]).
- {{label:Board.Database.Stats}} (статыстыка хадоў) паказваецца зверху, а {{label:Board.Database.Games}} (адпаведныя партыі) — знізу; пакуль паказаны абедзве вобласці, перацягніце падзельнік паміж імі, каб размеркаваць вышыню. Выкарыстоўвайце {{label:Board.Database.HideGames}} або {{label:Board.Database.ShowGames}}, каб схаваць або паказаць спіс партый, і шасцярню налад, каб адкрыць або згарнуць элементы кіравання крыніцамі — абедзве кнопкі знаходзяцца ў загалоўку панэлі, калі яна адкрыта як асобная вобласць, і ў верхнім радку кіравання, калі яна знаходзіцца ва ўкладках. Слупок {{label:Board.Area.Notation}} паказвае хады партыі ад пазіцыі на дошцы, прычым наступны ход вылучаны паўтлустым.
- Націсніце {{label:Board.Database.Compare}}, каб параўнаць дзве крыніцы побач, або адкрыйце {{label:Board.Database.Local.Position}} для пераключэння паміж пошукам пазіцыі {{label:Board.Database.Local.Exact}} і {{label:Board.Database.Local.Partial}} (уключаючы {{label:Board.Database.Local.SimilarStructure}} для пошуку па пешкавай структуры і {{label:Fen.Empty}} для адвольных шаблонаў).
- Вы таксама можаце паказаць {{label:Board.Tabs.Database}} як асобную вобласць на дошцы аналізу і скарыстацца {{label:Board.Area.ReturnToTabs}}, каб вярнуць яе ва ўкладкі.
- Калі кнопка {{label:Databases.OpeningTree.Prepare}} адкрывае дошку для гульца з базы дадзеных, аглядальнік пачынае з даведачнай базы як дадатковага слупка побач з партыямі саперніка; націсніце {{label:Board.Database.RemoveReference}}, каб схаваць слупок, або {{label:Board.Database.AddColumn}}, каб дадаць яшчэ адзін.
