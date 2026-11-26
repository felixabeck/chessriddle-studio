---
id: repertoires
title: Répertoires d’ouvertures
summary: Créez un répertoire, importez des PGN, construisez votre couverture face à une base de référence, entraînez-vous par répétition espacée et suivez les variantes ouvertes, transposées et coups à vérifier.
source: db00ec0860d0fa31
---

Les répertoires sont des fichiers PGN de type Répertoire qui ajoutent l’onglet {{label:Board.Tabs.Practice}} sur l’échiquier d’analyse.

Pour créer un répertoire, ouvrez [[page:new-tab]] et cliquez sur {{label:Home.Card.NewRepertoire.Title}} (ou créez un fichier de répertoire dans [[page:library]]). Saisissez un {{label:Common.Name}}, choisissez {{label:Common.WHITE}} ou {{label:Common.BLACK}}, sélectionnez ou collez éventuellement un PGN sous {{label:Home.Card.NewRepertoire.FromPgn}}, puis cliquez sur {{label:Common.Create}}. Vous pouvez aussi importer un PGN depuis {{label:Home.Card.ImportGame.Title}} en cochant {{label:Import.SaveToCollection}} avec le type {{label:Files.FileType.Repertoire}}.

Construisez votre répertoire dans {{label:Board.Tabs.Practice}} -> {{label:Board.Practice.Build}} :
- Cliquez sur {{label:Board.Practice.Build.ImportPgn}} pour fusionner un fichier PGN ou des parties collées dans le répertoire ouvert (fonctionne avec ou sans base de référence).
- Définissez une {{label:Databases.Settings.ReferenceDatabase}} dans [[page:library]] afin que l’outil affiche les fréquences de coups et la couverture.
- Sur un répertoire vide, vous pouvez partir de l’un des modèles intégrés de {{label:Board.Practice.Build.Presets}} ou jouer des coups sur l’échiquier.
- Définissez la position de départ de votre répertoire avec {{label:Board.Practice.Build.SetAsStart}} (ou faites un clic droit sur un coup dans la notation et choisissez {{label:Menu.MarkAsStart}}).
- Cliquez sur des coups dans {{label:Board.Practice.Build.OpponentMoves}} ou {{label:Board.Practice.Build.YourResponse}} pour ajouter ou suivre des lignes. Utilisez {{label:Board.Practice.Build.NextGap}} et {{label:Board.Practice.Build.BiggestGap}} pour sauter aux réponses adverses non couvertes dépassant le nombre minimal de parties défini dans [[setting:repertoire-depth]].

Entraînez votre répertoire dans {{label:Board.Tabs.Practice}} -> {{label:Board.Practice.Train}} :
- Cliquez sur {{label:Board.Practice.StartPractice}} pour réviser les positions à revoir et nouvelles par répétition espacée, ou sur {{label:Board.Practice.PracticeFullRepertoire}} pour réviser chaque position du répertoire.
- Jouez votre coup préparé sur l’échiquier. Si vous bloquez après un mauvais coup, cliquez sur {{label:Board.Practice.ShowMove}}.
- Consultez toutes les cartes avec {{label:Board.Practice.ShowAll}}, l’historique avec {{label:Board.Practice.ShowLogs}} ou réinitialisez la progression avec {{label:Common.Reset}}.
- Les répertoires contenant des cartes à réviser apparaissent aussi sous {{label:Home.Library.Due}} sur [[page:new-tab]].
- Configurez la notation de répétition espacée et le plafond de nouvelles cartes dans [[settings-category:repertoire]] ([[setting:practice-grading]], [[setting:practice-new-per-session]]).

Dans la notation sur l’échiquier d’analyse :
- Une ligne secondaire d’un seul coup est encadrée en pointillés en tant que {{label:Notation.OpenVariation}} afin de repérer les branches inachevées. Appuyez sur le raccourci {{label:Settings.Keybinds.Actions.NEXT_OPEN_VARIATION}} pour passer à la suivante.
- Lorsqu’une position apparaît dans une autre branche du même répertoire, une icône {{label:Notation.Transposition}} s’affiche à côté du coup ; cliquez dessus pour sauter à l’autre branche.
- Lorsqu’un PGN importé contient une réponse différente pour votre camp, le coup importé est ajouté en variante et signalé comme {{label:Notation.ReviewMove}}. Faites un clic droit sur le coup et choisissez {{label:Menu.MarkAsReviewed}} pour effacer le marqueur.
