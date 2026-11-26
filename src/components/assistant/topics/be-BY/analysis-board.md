---
id: analysis-board
title: Дошка аналізу, варыяцыі, каментарыі і стрэлкі
summary: Увод хадоў, рэдагаванне пазіцый, кіраванне варыяцыямі, напісанне каментарыяў, даданне анатацый і маляванне стрэлак на дошцы.
source: 55f6c4572027d33b
---

Адкрыйце дошку аналізу са старонкі [[page:new-tab]], націснуўшы {{label:Home.Card.AnalysisBoard.Title}}, або адкрыўшы захаваную партыю ці рэпертуар з [[page:library]].

Рабіце хады перацягваннем або націсканнем на фігуры (наладжваецца ў [[setting:move-method]]). Вы таксама можаце ўключыць [[setting:text-input]] ({{label:Settings.Inputs.TextInput}}), каб уводзіць хады ў натацыі SAN. Выкарыстоўвайце элементы кіравання пад натацыяй, клавішы са стрэлкамі або кола мышы (калі ўключаны параметр [[setting:scroll-moves]]) для пераходу па хадах.

Панэль інструментаў побач з натацыяй змяшчае дзеянні для дошкі:
- {{label:Board.Action.TakeSnapshot}}: захаваць выяву бягучай дошкі.
- {{label:Board.Action.EditPosition}}: наладзіць адвольную пазіцыю, расставіўшы фігуры або адрэдагаваўшы FEN.
- {{label:Board.Action.PlayFromHere}}: пачаць гульню з бягучай пазіцыі.
- {{label:Board.Action.ClearDrawings}}: прыбраць стрэлкі і падсветку клетак (паказваецца, калі выключаны параметр [[setting:erase-drawables]]).
- {{label:Board.Database.Save}}: захаваць партыю ў файл бібліятэкі або базу даных.
- Кнопкі адмены, паўтору, захавання і перавароту дошкі.

Калі зрабіць іншы ход з папярэдняй пазіцыі, ствараецца варыяцыя. Пстрыкніце правай кнопкай мышы па любым ходзе ў натацыі, каб выбраць {{label:Menu.PromoteVariation}}, {{label:Menu.PromoteToMainLine}}, {{label:Menu.CopyVariationPGN}}, {{label:Menu.DeleteMove}}, {{label:Menu.DeleteVariation}}, {{label:Menu.DeleteMovesAfter}}, {{label:Board.Action.PlayFromHere}}, {{label:Notation.AddDiagram}} або {{label:Notation.MarkGameEndHere}}. Кнопкі ў загалоўку натацыі дазваляюць пераключаць {{label:Notation.HideMoves}}, {{label:Notation.TableView}}, {{label:Notation.HideComments}}, {{label:Notation.HideDiagrams}} і {{label:Notation.HideVariations}}.

Каб анатаваць хады і пісаць каментарыі, адкрыйце ўкладку {{label:Board.Tabs.Annotate}}. Націсніце сімвал якасці ходу (або клавішы ад 1 да 6), каб пераключыць `!!`, `!`, `!?`, `?!`, `?` ці `??`, або націсніце {{label:Annotate.ShowMore}} для ацэначных і пазіцыйных сімвалаў. Пад сімваламі ў тэкставым рэдактары можна пісаць фарматаваныя каментарыі і пераключаць убудаваныя дыяграмы дошкі.

Каб маляваць стрэлкі і выдзяляць клеткі, утрымлівайце правую кнопку мышы і правядзіце па дошцы (або пстрыкніце правай кнопкай па клетцы для кружка). Утрымлівайце клавішы-мадыфікатары для розных колераў: Shift для {{label:Settings.Drawing.Red}}, Alt для {{label:Settings.Drawing.Blue}}, Shift+Alt для {{label:Settings.Drawing.Yellow}}, Ctrl (Cmd на macOS) для {{label:Settings.Drawing.Orange}} і Ctrl+Alt (Cmd+Alt на macOS) для {{label:Settings.Drawing.Cyan}}. Поўны спіс мадыфікатараў малявання глядзіце ў [[settings-category:keybinds]].

Укладка {{label:Board.Tabs.Info}} паказвае загалоўкі партыі, FEN, тэкст PGN і статыстыку дрэва варыяцый, а таксама дазваляе пераключацца паміж партыямі ў шматпартыйным файле PGN.

Каб змяніць размяшчэнне абласцей на дошцы аналізу, перацягніце ўкладку панэлі ({{label:Board.Tabs.Analysis}}, {{label:Board.Tabs.Database}}, {{label:Board.Tabs.Annotate}}, {{label:Board.Tabs.Coach}} або {{label:Board.Tabs.Info}}) ці скарыстайцеся ручкамі перамяшчэння на панэлі ўкладак, у загалоўку натацыі або ў загалоўку асобнай вобласці панэлі, каб размясціць вобласці збоку, зверху або знізу ад іншай вобласці з папярэднім праглядам або з клавіятуры. Каб размясціць панэль над дзвюма абласцямі (напрыклад, {{label:Board.Tabs.Database}} над натацыяй і ўкладкамі), спачатку змясціце панэль над адной з іх, а затым перамясціце другую побач. Націсніце {{label:Board.Area.ReturnToTabs}} або перацягніце вобласць панэлі назад на панэль укладак, каб вярнуць яе ва ўкладкі, і выкарыстайце [[setting:board-layout]] ({{label:Settings.BoardLayout.Reset}}), каб аднавіць стандартнае размяшчэнне.
