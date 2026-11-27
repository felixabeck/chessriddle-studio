---
id: game-report
title: Bilan de partie et rapports
summary: Analysez une partie avec un moteur local pour examiner la précision, les graphiques d'évaluation et de temps, les notes d'ouverture et de répertoire ainsi que les moments clés sur l'échiquier.
source: d1a4339820f36de2
---

Le rapport de partie analyse chaque coup de la ligne principale avec un moteur d'échecs local et transforme les résultats en un bilan guidé de la partie.

Pour générer un rapport, ouvrez une partie sur l'échiquier d'analyse, passez à l'onglet {{label:Board.Analysis.Report}} puis cliquez sur {{label:Board.Analysis.GenerateReport}} (ou utilisez le raccourci {{label:Settings.Keybinds.Actions.GENERATE_REPORT}}).

Dans la boîte de dialogue {{label:Board.Analysis.GenerateReport}} :
- Choisissez un {{label:Common.Engine}} local. S'il n'y en a aucun d'installé, ajoutez-en un sur [[page:engines]].
- Réglez la limite de recherche par coup (profondeur, temps ou nœuds).
- Activez {{label:Board.Analysis.MarkMoves}} pour annoter les coups avec des symboles de qualité (`!!`, `!`, `!?`, `?!`, `?`, `??`).
- Activez {{label:Board.Analysis.ShowVariations}} pour insérer les meilleures variantes dans la notation.
- Activez {{label:Board.Analysis.AnnotateNovelties}} pour marquer d'un `N` le premier coup qui sort de votre base de données de référence. Cette option nécessite une base de données de référence prête sélectionnée dans [[page:library]].
- Cliquez sur {{label:Board.Analysis.Analyze}} pour démarrer.

Pendant l'exécution du rapport, vous pouvez l'annuler depuis le bouton de progression. Modifier la ligne principale annule également un rapport en cours.

Une fois terminé, {{label:Board.Analysis.Report}} affiche :
- Un en-tête discret indiquant le moteur, la limite de recherche et la date, accompagné d'un petit bouton {{label:Board.Analysis.Report.Regenerate}}. Le grand bouton {{label:Board.Analysis.GenerateReport}} n'apparaît que lorsqu'il n'y a pas de rapport à jour.
- Une phrase de résumé au-dessus du tableau de score lorsque la partie a commencé depuis une position équilibrée ; aucune phrase n'est affichée si le départ était déséquilibré.
- Un seul tableau de score avec les noms et classements des joueurs, {{label:Board.Analysis.Accuracy}} comme chiffre principal, {{label:Board.Analysis.Report.AverageLoss}}, la précision par phase de jeu et les six lignes de qualité de coup dont les zéros sont atténués. Cliquer sur un total non nul saute aux coups correspondants, et survoler ou focaliser au clavier chaque libellé explique ce qu'il mesure.
- Un graphique basculant entre {{label:Board.Analysis.Report.Evaluation}} (avec ligne de zéro) et {{label:Board.Analysis.Report.WinChance}}, chacun expliqué au survol ou au focus clavier. Lorsqu'au moins la moitié des coups comporte un temps de pendule, une bande {{label:Board.Analysis.Report.TimeUsage}} s'affiche sous le graphique ; cliquez sur une barre pour accéder à ce coup.
- Un bloc d'ouverture et de répertoire indiquant le nom de l'ouverture, la nouveauté (`N`) lorsqu'elle est présente, et une note de répertoire uniquement pour votre camp — identifié par correspondance du nom de joueur avec vos comptes Lichess, Chess.com ou alias connectés dans [[page:accounts]], ou sinon le camp placé en bas de l'échiquier (retourner l'échiquier change ce camp). Il indique où vous avez quitté votre répertoire (un clic focalise cette position avec des flèches) ou jusqu'où vous l'avez suivi. Si les fichiers de répertoire n'ont pas pu être lus entièrement, une seule ligne atténuée s'affiche : {{label:Board.Analysis.Report.RepertoireIncomplete}}
- {{label:Board.Analysis.Report.KeyMoments}} : cliquez sur une ligne pour revenir à la position précédant le coup afin que les deux flèches sur l'échiquier (le coup joué et le meilleur coup) partent de cette case. Utilisez {{label:Board.Analysis.Report.PreviousMoment}} et {{label:Board.Analysis.Report.NextMoment}} pour les parcourir, ou filtrez par {{label:Board.Analysis.Report.FilterBoth}}, {{label:Board.Analysis.Report.FilterWhite}} ou {{label:Board.Analysis.Report.FilterBlack}}. Les moments affichent aussi des étiquettes telles que {{label:Board.Analysis.Report.Tag.TurningPoint}} ou {{label:Board.Analysis.Report.Tag.TimeTrouble}}, ainsi que le type d'erreur lorsque les variantes du moteur le démontrent.
- Sur les moments `?!`, `?` et `??`, cliquez sur {{label:Board.Analysis.Report.Explain}} pour focaliser cette position et ouvrir {{label:Board.Tabs.Coach}} avec une question sur ce moment. Ce bouton est masqué lorsqu'aucune connexion IA n'est configurée.

Si vous modifiez la partie par la suite, régénérez le rapport avec {{label:Board.Analysis.GenerateReport}} ou {{label:Board.Analysis.Report.Regenerate}} pour mettre le bilan à jour.
