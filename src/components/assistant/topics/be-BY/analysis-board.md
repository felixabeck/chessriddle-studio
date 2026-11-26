---
id: analysis-board
title: Дошка аналізу, варыяцыі, каментарыі і стрэлкі
summary: Увод хадоў, рэдагаванне пазіцый, кіраванне варыяцыямі, напісанне каментарыяў, даданне анатацый і маляванне стрэлак на дошцы.
source: 332d035e7fda54c8
---

Адкрыйце дошку аналізу са старонкі [[page:new-tab]], націснуўшы {{label:Home.Card.AnalysisBoard.Title}}, або адкрыўшы захаваную партыю ці рэпертуар з [[page:library]].

Рабіце хады перацягваннем або націсканнем на фігуры (наладжваецца ў [[setting:move-method]]). Вы таксама можаце ўключыць [[setting:text-input]] ({{label:Settings.Inputs.TextInput}}), каб уводзіць хады ў натацыі SAN. Выкарыстоўвайце элементы кіравання пад натацыяй, клавішы са стрэлкамі або кола мышы (калі ўключаны параметр [[setting:scroll-moves]]) для пераходу па хадах.

Верхняя панэль над дошкай змяшчае дзеянні для дошкі:
- {{label:Board.Action.PlayFromHere}}: пачаць гульню з бягучай пазіцыі.
- Пераварот дошкі (`F`): памяняць белых і чорных у ніжняй частцы дошкі.
- Захаванне: з’яўляецца, калі ў партыі ёсць незахаваныя змены і аўтазахаванне выключана, недаступнае (напрыклад, у чарнавіку) або завяршылася памылкай.
- {{label:Board.Action.More}}: адкрывае меню з пунктамі {{label:Board.Database.Save}} (захаваць партыю ў файл бібліятэкі або базу даных), {{label:Board.Action.TakeSnapshot}} (захаваць выяву бягучай дошкі) і {{label:Board.Action.EditPosition}} (наладзіць адвольную пазіцыю, расставіўшы фігуры або адрэдагаваўшы FEN).
- Адмена, паўтор і ачыстка намаляваных стрэлак ці падсветкі (калі выключаны параметр [[setting:erase-drawables]]) выконваюцца праз спалучэнні клавіш у [[settings-category:keybinds]].

Калі зрабіць іншы ход з папярэдняй пазіцыі, ствараецца варыяцыя. Пстрыкніце правай кнопкай мышы па любым ходзе ў натацыі, каб выбраць {{label:Menu.PromoteVariation}}, {{label:Menu.PromoteToMainLine}}, {{label:Menu.CopyVariationPGN}}, {{label:Menu.DeleteMove}}, {{label:Menu.DeleteVariation}}, {{label:Menu.DeleteMovesAfter}}, {{label:Board.Action.PlayFromHere}}, {{label:Notation.AddDiagram}} або {{label:Notation.MarkGameEndHere}}. Выкарыстоўвайце кнопку-вока ў загалоўку натацыі для {{label:Notation.HideMoves}}, а меню {{label:Notation.ViewOptions}} — для пераключэння {{label:Notation.TableView}}, {{label:Notation.ShowComments}}, {{label:Notation.ShowDiagrams}} і {{label:Notation.ShowVariations}}.

Каб анатаваць хады і пісаць каментарыі, адкрыйце ўкладку {{label:Board.Tabs.Annotate}}. Націсніце сімвал якасці ходу (або клавішы ад 1 да 6), каб пераключыць `!!`, `!`, `!?`, `?!`, `?` ці `??`, або націсніце {{label:Annotate.ShowMore}} для ацэначных і пазіцыйных сімвалаў. Пад сімваламі ў тэкставым рэдактары можна пісаць фарматаваныя каментарыі і пераключаць убудаваныя дыяграмы дошкі.

Каб маляваць стрэлкі і выдзяляць клеткі, утрымлівайце правую кнопку мышы і правядзіце па дошцы (або пстрыкніце правай кнопкай па клетцы для кружка). Утрымлівайце клавішы-мадыфікатары для розных колераў: Shift для {{label:Settings.Drawing.Red}}, Alt для {{label:Settings.Drawing.Blue}}, Shift+Alt для {{label:Settings.Drawing.Yellow}}, Ctrl (Cmd на macOS) для {{label:Settings.Drawing.Orange}} і Ctrl+Alt (Cmd+Alt на macOS) для {{label:Settings.Drawing.Cyan}}. Поўны спіс мадыфікатараў малявання глядзіце ў [[settings-category:keybinds]].

Укладка {{label:Board.Tabs.Info}} паказвае загалоўкі партыі, FEN, тэкст PGN і статыстыку дрэва варыяцый, а таксама дазваляе пераключацца паміж партыямі ў шматпартыйным файле PGN.

Каб змяніць размяшчэнне абласцей на дошцы аналізу, перацягніце ўкладку панэлі ({{label:Board.Tabs.Analysis}}, {{label:Board.Analysis.Report}}, {{label:Board.Tabs.Database}}, {{label:Board.Tabs.Annotate}}, {{label:Board.Tabs.Coach}} або {{label:Board.Tabs.Info}}) ці шасцікропкавы маркер карткі рухавіка ці скарыстайцеся ручкамі перамяшчэння на панэлі ўкладак, у загалоўку натацыі або ў загалоўку асобнай вобласці панэлі, каб размясціць вобласці збоку, зверху або знізу ад іншай вобласці з папярэднім праглядам або з клавіятуры. Каб размясціць панэль над дзвюма абласцямі (напрыклад, {{label:Board.Tabs.Database}} над натацыяй і ўкладкамі), спачатку змясціце панэль над адной з іх, а затым перамясціце другую побач. Націсніце {{label:Board.Area.ReturnToTabs}} (або {{label:Board.Area.ReturnToEngines}} для акна рухавіка) ці перацягніце вобласць назад на панэль укладак, каб вярнуць яе.

Укладкі рэпертуару, партый і падрыхтоўкі да суперніка захоўваюць кожная свой уласны актыўны макет. Уключаны тры стандартныя макеты ({{label:Board.Layout.Preset.Repertoire}}, {{label:Board.Layout.Preset.GameReview}} і {{label:Board.Layout.Preset.Preparation}}), а таксама вы можаце захоўваць уласныя макеты, пераключацца паміж імі або пераймяноўваць і выдаляць захаваныя макеты праз {{label:Board.Action.More}} ({{label:Board.Layout.SaveAs}} і {{label:Board.Layout.Manage}}) або праз {{label:Menu.View}} ({{label:Board.Layout.SaveAs}} і {{label:Board.Layout.LayoutsMenu}}). Выкарыстайце [[setting:board-layout]] ({{label:Settings.BoardLayout.Reset}}), каб аднавіць стандартныя макеты для ўсіх трох тыпаў укладак, захаваўшы вашы ўласныя макеты.

Каб схаваць укладкі, напрыклад калі кожная панэль, якой вы карыстаецеся, паказана як асобная вобласць, націсніце {{label:Board.Area.HideTabs}} пад маркерам у канцы панэлі ўкладак; суседнія вобласці зоймуць іх месца. Укладкі захоўваюць становішча і памер: вярніце іх кнопкай {{label:Board.Arrange.ShowTabs}}, якая з’яўляецца ў загалоўку натацыі, пакуль укладкі схаваныя, спалучэннем клавіш укладкі або стварэннем справаздачы. Панэль, вернутая пры схаваных укладках, трапляе ў схаваныя ўкладкі.
