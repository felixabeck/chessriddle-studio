---
id: game-report
title: Rapport de partie
summary: Lancez une analyse automatique d’une partie par moteur pour voir la précision, le graphique d’évaluation, les moments clés et la classification des coups.
source: a5e00adfe821f3f3
---

Le rapport de partie analyse chaque coup de la variante principale avec un moteur d’échecs local et résume la précision ainsi que les erreurs de la partie.

Pour générer un rapport, ouvrez une partie sur l’échiquier d’analyse, passez à {{label:Board.Tabs.Analysis}} -> {{label:Board.Analysis.Report}} et cliquez sur {{label:Board.Analysis.GenerateReport}} (ou appuyez sur le raccourci {{label:Settings.Keybinds.Actions.GENERATE_REPORT}}).

Dans la boîte de dialogue {{label:Board.Analysis.GenerateReport}} :
- Choisissez un {{label:Common.Engine}} local. S’il n’y en a aucun d’installé, ajoutez-en un sur [[page:engines]].
- Définissez la limite de recherche par coup (profondeur, temps ou nœuds).
- Activez {{label:Board.Analysis.MarkMoves}} pour annoter les coups avec des symboles de qualité.
- Activez {{label:Board.Analysis.ShowVariations}} pour insérer dans la notation des variantes avec de meilleurs coups.
- Activez {{label:Board.Analysis.AnnotateNovelties}} pour marquer le premier coup quittant votre base de données de référence. Cette option nécessite qu’une base de référence prête soit sélectionnée dans [[page:library]].
- Cliquez sur {{label:Board.Analysis.Analyze}} pour démarrer.

Pendant qu’un rapport s’exécute, vous pouvez l’annuler depuis le bouton de progression. Toute modification de la variante principale annule le rapport en cours.

Une fois terminé, {{label:Board.Analysis.Report}} affiche :
- Les pourcentages de précision et la perte moyenne en centipions (ACPL) pour {{label:Common.WHITE}} et {{label:Common.BLACK}}.
- Un graphique d’évaluation sur toute la partie.
- {{label:Board.Analysis.Report.KeyMoments}} : une liste cliquable des coups marqués indiquant les écarts d’évaluation et les meilleurs coups.
- Un tableau récapitulatif des qualités de coups où cliquer sur un total permet de sauter aux coups correspondants.

Si vous modifiez la partie par la suite, cliquez sur {{label:Board.Analysis.RegenerateReport}} pour relancer une analyse.
