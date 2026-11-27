---
id: databases
title: Bases de données, explorateur, recherche de position, joueurs et tournois
summary: Ajoutez ou téléchargez des bases de parties, choisissez une base de référence, recherchez des positions dans l’explorateur et parcourez parties, joueurs et tournois.
source: 526f05192ead329f
---

Les bases de données se trouvent dans [[page:library]] ({{label:SideBar.Library}}) aux côtés de vos fichiers PGN et sont stockées dans [[setting:databases-directory]].

Pour ajouter une base de données, ouvrez [[page:library]] et cliquez sur {{label:Library.AddDatabase}} :
- {{label:Databases.Add.Web}} : téléchargez des bases de parties sélectionnées depuis le catalogue.
- {{label:Common.Local}} : sélectionnez un fichier PGN local (y compris `.pgn.zst` ou `.pgn.bz2`), saisissez un {{label:Common.Name}} et une {{label:Common.Description}} facultative, puis cliquez sur {{label:Databases.Add.Convert}}.

Sélectionnez une base de données dans [[page:library]] pour la gérer :
- Cochez {{label:Databases.Settings.ReferenceDatabase}} pour en faire la base de référence par défaut pour l’explorateur, le créateur de répertoire, les nouveautés du rapport de partie et le Coach.
- Cochez {{label:Databases.Settings.Indexed}} pour créer ou supprimer les index de recherche afin d’accélérer les requêtes.
- Cliquez sur {{label:Databases.Settings.Explore}} pour ouvrir la vue tabulaire de la base de données.
- Sous {{label:Databases.Settings.Actions}}, utilisez {{label:Databases.Settings.AddGames}} pour ajouter des fichiers PGN, {{label:Databases.Settings.ExportPGN}} pour exporter en PGN ou {{label:Common.Delete}} pour supprimer la base de données.
- Sous {{label:Databases.Settings.AdvancedTools}}, utilisez {{label:Databases.Settings.MergePlayers}} pour regrouper des fiches de joueurs en double, ou {{label:Databases.Settings.RemoveDup}} et {{label:Databases.Settings.RemoveEmpty}} pour nettoyer les parties.

Dans la vue tabulaire de la base de données, passez de {{label:Common.Games}} à {{label:Databases.Card.Players}} et {{label:Databases.Settings.Events}} (tournois) :
- Recherchez et triez les parties, prévisualisez une partie (l’aperçu peut masquer les coups avec le bouton œil, [[setting:hide-preview-moves]]) ou ouvrez-la sur l’échiquier d’analyse.
- Dans {{label:Databases.Card.Players}}, sélectionnez un joueur pour consulter {{label:Home.Personal.Overview}}, {{label:Home.Personal.Ratings}} et {{label:Home.Personal.Openings}} (un arbre d’ouvertures interactif avec un bouton {{label:Databases.OpeningTree.Prepare}}), ainsi que les informations FIDE via {{label:Databases.FIDE.Info}}.
- Dans {{label:Databases.Settings.Events}}, recherchez les tournois par nom et triez par date, joueurs, parties ou Elo moyen.

Sur la fiche d’un joueur, ouvrez l’onglet {{label:Home.Personal.Preparation}} pour comparer ses parties avec vos fichiers de répertoire :
- Choisissez la couleur de l’adversaire, la période {{label:Databases.OpeningTree.Since}} et (avec des comptes en ligne liés) {{label:Databases.OpeningTree.OverTheBoard}}, {{label:Databases.OpeningTree.Online}} ou {{label:Databases.Preparation.Both}}. Cliquez sur {{label:Databases.Preparation.Refresh}} pour relancer la comparaison.
- Augmentez {{label:Databases.Preparation.MinGames}} pour masquer les lignes et lacunes que l’adversaire n’a jouées que rarement ; votre fichier replie ces lignes et l’entraînement les laisse de côté.
- Consultez les lignes jouées par l’adversaire et {{label:Databases.Preparation.GapsTitle}}. Cliquez sur une ligne pour ouvrir votre fichier de répertoire à cette position avec les autres variantes masquées ; basculez entre {{label:Notation.PreparationOpponentLines}} et {{label:Notation.PreparationAllLines}} dans l’en-tête de la notation.
- Cliquez sur {{label:Databases.Preparation.TrainLines}} pour lancer une séance chronométrée sur ces lignes ; vos réponses mettent à jour le calendrier habituel de répétition espacée.
- Pour vous préparer contre un adversaire qui n’a qu’un compte Lichess ou Chess.com, cliquez sur {{label:Library.OnlineOpponent}} dans [[page:library]] pour rechercher son compte, télécharger ses parties et ouvrir sa fiche directement sur l’onglet {{label:Home.Personal.Preparation}} (saisir le même compte à nouveau la rouvre sans retélécharger).

Sur l’échiquier d’analyse, ouvrez {{label:Board.Tabs.Database}} pour utiliser l’explorateur d’ouvertures :
- Choisissez {{label:Board.Database.LichessAll}} ou {{label:Board.Database.LichessMaster}} dans le menu des sources et dans {{label:Board.Database.Compare}} (les explorateurs en ligne Lichess nécessitent un compte Lichess connecté sur [[page:accounts]]).
- {{label:Board.Database.Stats}} (statistiques de coups) s’affiche en haut et {{label:Board.Database.Games}} (parties correspondantes) en bas ; faites glisser le séparateur entre les deux pour partager la hauteur. La colonne {{label:Board.Area.Notation}} montre les coups à partir de la position sur l’échiquier, avec le coup suivant en gras.
- Cliquez sur {{label:Board.Database.Compare}} afin d’afficher deux sources côte à côte, ou ouvrez {{label:Board.Database.Local.Position}} pour basculer entre la recherche de position {{label:Board.Database.Local.Exact}} et {{label:Board.Database.Local.Partial}} (y compris {{label:Board.Database.Local.SimilarStructure}} pour la recherche par structure de pions et {{label:Fen.Empty}} pour des motifs personnalisés).
- Vous pouvez aussi afficher {{label:Board.Tabs.Database}} dans sa propre zone sur l’échiquier d’analyse et utiliser {{label:Board.Area.ReturnToTabs}} pour le replacer dans les onglets.
- Lorsque {{label:Databases.OpeningTree.Prepare}} ouvre un échiquier pour un joueur de la base de données, l’explorateur commence avec votre base de référence comme colonne supplémentaire à côté des parties de l’adversaire ; cliquez sur {{label:Board.Database.RemoveReference}} pour masquer une colonne ou sur {{label:Board.Database.AddColumn}} pour en ajouter une autre.
