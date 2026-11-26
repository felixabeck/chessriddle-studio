---
id: analysis-board
title: Échiquier d’analyse, variantes, commentaires et flèches
summary: Saisissez des coups, éditez des positions, gérez des variantes, rédigez des commentaires, ajoutez des annotations et tracez des flèches sur l’échiquier.
source: c4040958465a3812
---

Ouvrez un échiquier d’analyse depuis [[page:new-tab]] en cliquant sur {{label:Home.Card.AnalysisBoard.Title}}, ou en ouvrant une partie ou un répertoire enregistré depuis [[page:library]].

Jouez des coups en faisant glisser les pièces ou en cliquant dessus (configurable dans [[setting:move-method]]). Vous pouvez aussi activer [[setting:text-input]] ({{label:Settings.Inputs.TextInput}}) pour saisir les coups en notation SAN. Utilisez les commandes de déplacement sous la notation, les touches fléchées ou la molette de la souris (si [[setting:scroll-moves]] est activé) pour parcourir les coups.

La barre d’outils à côté de la notation propose des actions sur l’échiquier :
- {{label:Board.Action.TakeSnapshot}} : enregistrer une image de l’échiquier actuel.
- {{label:Board.Action.EditPosition}} : configurer une position personnalisée en plaçant des pièces ou en modifiant le FEN.
- {{label:Board.Action.PlayFromHere}} : démarrer une partie à partir de la position actuelle.
- {{label:Board.Action.ClearDrawings}} : effacer les flèches et les cases mises en surbrillance (affiché lorsque [[setting:erase-drawables]] est désactivé).
- {{label:Board.Database.Save}} : enregistrer la partie dans un fichier de la bibliothèque ou une base de données.
- Boutons pour annuler, rétablir, enregistrer et retourner l’échiquier.

Jouer un autre coup à partir d’une position précédente crée une variante. Faites un clic droit sur n’importe quel coup dans la notation pour accéder à {{label:Menu.PromoteVariation}}, {{label:Menu.PromoteToMainLine}}, {{label:Menu.CopyVariationPGN}}, {{label:Menu.DeleteMove}}, {{label:Menu.DeleteVariation}}, {{label:Menu.DeleteMovesAfter}}, {{label:Board.Action.PlayFromHere}}, {{label:Notation.AddDiagram}} ou {{label:Notation.MarkGameEndHere}}. Utilisez les boutons de l’en-tête de la notation pour activer ou désactiver {{label:Notation.HideMoves}}, {{label:Notation.TableView}}, {{label:Notation.HideComments}}, {{label:Notation.HideDiagrams}} et {{label:Notation.HideVariations}}.

Pour annoter des coups et rédiger des commentaires, ouvrez l’onglet {{label:Board.Tabs.Annotate}}. Cliquez sur un symbole de qualité de coup (ou appuyez sur les touches 1 à 6) pour basculer `!!`, `!`, `!?`, `?!`, `?` ou `??`, ou cliquez sur {{label:Annotate.ShowMore}} pour afficher les symboles d’évaluation et de position. Sous les symboles, utilisez l’éditeur de texte enrichi pour rédiger des commentaires mis en forme et insérer des diagrammes d’échiquier dans le texte.

Pour tracer des flèches et mettre des cases en évidence, faites un clic droit maintenu et glissez sur l’échiquier (ou faites un clic droit sur une case pour dessiner un cercle). Maintenez des touches modificatrices pour changer de couleur : Maj pour {{label:Settings.Drawing.Red}}, Alt pour {{label:Settings.Drawing.Blue}}, Maj+Alt pour {{label:Settings.Drawing.Yellow}}, Ctrl (Cmd sur macOS) pour {{label:Settings.Drawing.Orange}} et Ctrl+Alt (Cmd+Alt sur macOS) pour {{label:Settings.Drawing.Cyan}}. Consultez la liste complète des commandes de dessin dans [[settings-category:keybinds]].

L’onglet {{label:Board.Tabs.Info}} affiche les en-têtes de la partie, le FEN, le texte PGN et les statistiques d’arbre, et vous permet de passer d’une partie à l’autre dans un fichier PGN multi-parties.

Pour organiser l’échiquier d’analyse, faites glisser un onglet de panneau ({{label:Board.Tabs.Analysis}}, {{label:Board.Tabs.Database}}, {{label:Board.Tabs.Annotate}}, {{label:Board.Tabs.Coach}} ou {{label:Board.Tabs.Info}}) ou utilisez les poignées de la barre d’onglets, de l’en-tête de la notation ou de l’en-tête d’une zone de panneau afin de placer des zones à côté, au-dessus ou au-dessous d’une autre zone avec aperçu ou au clavier. Pour étendre un panneau au-dessus de deux zones (par exemple {{label:Board.Tabs.Database}} au-dessus de la notation et des onglets), placez d’abord le panneau au-dessus de l’une d’elles, puis déplacez l’autre à côté. Cliquez sur {{label:Board.Area.ReturnToTabs}} ou faites glisser une zone de panneau sur la barre d’onglets pour la remettre dans les onglets, et utilisez [[setting:board-layout]] ({{label:Settings.BoardLayout.Reset}}) pour rétablir la disposition par défaut.

Pour masquer les onglets, par exemple lorsque chaque panneau utilisé est affiché comme une zone à part, cliquez sur {{label:Board.Area.HideTabs}} sous la poignée au bout de la barre d’onglets ; les zones voisines prennent leur place. Les onglets gardent leur position et leur taille : réaffichez-les avec le bouton {{label:Board.Arrange.ShowTabs}} qui apparaît dans l’en-tête de la notation tant qu’ils sont masqués, avec un raccourci d’onglet ou avec la génération du rapport. Un panneau remis dans les onglets pendant qu’ils sont masqués rejoint les onglets masqués.
