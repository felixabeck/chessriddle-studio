---
id: engines
title: Moteurs d’échecs et panneau d’analyse
summary: Installez ou ajoutez des moteurs locaux et cloud, configurez les options UCI et utilisez l’analyse en direct sur l’échiquier.
source: f40b5fdf8e5c15a0
---

Gérez vos moteurs d’échecs sur [[page:engines]] ({{label:SideBar.Engines}}).

Pour ajouter un moteur, cliquez sur {{label:Common.AddNew}} sur [[page:engines]] afin d’ouvrir {{label:Engines.Add.Title}} :
- {{label:Common.Download}} : installez un moteur préconfiguré (comme Stockfish) depuis le catalogue avec {{label:Common.Install}}.
- {{label:Engines.Add.Cloud}} : ajoutez des moteurs d’analyse en ligne (ChessDB ou Lichess Cloud) avec {{label:Common.Add}}.
- {{label:Common.Local}} : enregistrez un exécutable de moteur UCI déjà présent sur votre ordinateur.

Sélectionnez n’importe quel moteur sur [[page:engines]] pour le configurer. Pour les moteurs locaux, vous pouvez modifier les informations générales, définir les options UCI par défaut (telles que Threads, Hash et MultiPV), joindre des fichiers de ressources comme des tables de finales Syzygy, cliquer sur {{label:Engines.Settings.Reset}} pour rétablir les valeurs par défaut, {{label:Common.Duplicate}} pour copier la configuration ou {{label:Common.Remove}} pour le supprimer. Pour les moteurs cloud, vous pouvez modifier le nom et {{label:Engines.Settings.NumOfLines}}.

Sur l’échiquier d’analyse, ouvrez l’onglet {{label:Board.Tabs.Analysis}} :
- Cliquez sur {{label:Board.Analysis.SelectEngines}} pour choisir les moteurs installés chargés dans le panneau, ou sur {{label:Board.Analysis.ManageEngines}} pour aller sur [[page:engines]].
- Cliquez sur {{label:Board.Analysis.EnableEngine}} ou {{label:Board.Analysis.DisableEngine}} sur la carte d’un moteur pour démarrer ou mettre en pause l’analyse, ou utilisez {{label:Board.Analysis.EnableAllEngines}} sur la ligne du bas.
- Cliquez sur {{label:Board.Analysis.CheckThreat}} (ou appuyez sur le raccourci {{label:Settings.Keybinds.Actions.TOGGLE_THREAT_MODE}}) pour analyser la menace de l’adversaire.
- Utilisez le sélecteur de lignes d’une carte pour choisir 1 à 5 lignes, ou cliquez sur {{label:Board.Analysis.EngineSettings}} pour ajuster les réglages propres à l’onglet tels que la limite de recherche et les options UCI.
- Faites glisser une carte moteur par sa poignée à six points ({{label:Board.Analysis.ReorderEngine}}) pour la réordonner ou la sortir sur l’échiquier dans sa propre fenêtre, ou cliquez sur la poignée pour la déplacer au clavier. Cliquez sur {{label:Board.Area.ReturnToEngines}} ou faites glisser la fenêtre sur la barre d’onglets (ou l’en-tête de {{label:Board.Tabs.Analysis}}) pour la remettre en place.
- Si un moteur échoue, cliquez sur {{label:Board.Analysis.Logs}} à côté de {{label:Board.Analysis.RetryEngine}} pour consulter sa communication UCI. Pour un moteur en cours, le même bouton se trouve sous {{label:Board.Analysis.EngineSettings}} sur sa carte.

Réglez les flèches du moteur sur l’échiquier avec [[setting:arrows]] ({{label:Settings.Arrows}}). Les moteurs locaux sont enregistrés dans le dossier défini dans [[setting:engines-directory]].
