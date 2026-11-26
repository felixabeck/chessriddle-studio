---
id: import-game
title: Importer une partie
summary: Importez une partie depuis un fichier PGN, un texte PGN collé, une URL Lichess ou Chess.com, une position FEN ou des photos ou scans PDF d’une feuille de partie manuscrite.
source: 2a3b47d982e0f514
---

Pour importer une partie ou une position, ouvrez [[page:new-tab]] et cliquez sur {{label:Home.Card.ImportGame.Button}} afin d’ouvrir la boîte de dialogue {{label:Home.Card.ImportGame.Title}}. Vous pouvez aussi ouvrir un fichier PGN directement depuis {{label:Menu.File}} -> {{label:Menu.File.OpenFile}} (ou avec le raccourci {{label:Settings.Keybinds.Actions.OPEN_FILE}}).

Dans la boîte de dialogue {{label:Home.Card.ImportGame.Title}}, choisissez l’une des options :
- **PGN** : sélectionnez un {{label:Common.PGNFile}} sur votre ordinateur ou collez du texte dans {{label:Common.PGNGame}}. Cochez {{label:Import.SaveToCollection}} pour enregistrer une copie dans votre dossier de travail dans [[page:library]], puis saisissez un {{label:Common.Name}} et choisissez un {{label:Files.FileType}}.
- **{{label:Import.Online}}** : collez une {{label:Import.GameURL}} Lichess ou Chess.com pour récupérer la partie et l’ouvrir sur un échiquier d’analyse.
- **FEN** : collez une chaîne FEN pour ouvrir un échiquier d’analyse à partir de cette position.
- **{{label:Import.FromPhoto}}** (lorsque les fonctions d’IA sont disponibles) : transcrivez 1 à 4 photos ou pages PDF d’une feuille de partie manuscrite en une nouvelle partie. Cela nécessite au moins une connexion IA dans [[settings-category:coach]] ({{label:Settings.AI}}).

Pour PGN, {{label:Import.Online}} et FEN, cliquez sur {{label:Home.Card.ImportGame.Button}} pour charger la partie dans l’onglet actuel.

Pour importer avec **{{label:Import.FromPhoto}}** :
- Ajoutez jusqu’à 4 photos JPEG, PNG ou WebP ou pages PDF via {{label:Scoresheet.Intake.ChoosePhotos}}, {{label:Scoresheet.Intake.PasteFromClipboard}} (ou Ctrl+V / Cmd+V lorsque le volet est ouvert), ou en glissant-déposant les photos ou fichiers PDF dans le volet ouvert. Le collage ne fonctionne qu’avec des photos. Chaque page PDF compte comme une photo ; d’un PDF plus long, les premières pages sont utilisées.
- Choisissez la connexion IA et un modèle capable de lire les images avec le bouton de modèle ou dans [[setting:coach-model]] ({{label:Settings.Coach.Model}}).
- Cliquez sur {{label:Scoresheet.Read.Button}} pour lancer l’analyse. Avant la première lecture sur une connexion, {{label:Scoresheet.Notice.Title}} explique que les photos sélectionnées (y compris les noms des joueurs et tout ce qui figure sur la feuille) sont envoyées à ce fournisseur, que les métadonnées comme la position de l’appareil photo sont d’abord supprimées et qu’aucune autre donnée n’est envoyée.
- Studio vérifie chaque coup selon les règles standard des échecs depuis la position initiale et ouvre la partie dans un nouvel onglet d’analyse non enregistré avec le panneau {{label:Board.Tabs.Photo}} à côté de l’échiquier.
- Les coups douteux ou corrigés sont signalés comme incertains dans la notation. Parcourez-les dans le panneau {{label:Board.Tabs.Photo}} et cliquez sur {{label:Scoresheet.MarkAsChecked}} après vérification. Si vous corrigez un coup au milieu de la partie ou poursuivez après un arrêt, cliquez sur {{label:Scoresheet.ContinueWithSheet}} pour rejouer les coups légaux suivants de la feuille. Une fois terminé, cliquez sur {{label:Scoresheet.FinishReview}} pour effacer les marques restantes.
- Enregistrez la partie dans un fichier ou une base de données par la méthode habituelle ({{label:Menu.File}} -> {{label:Common.Save}}, le bouton d’enregistrement ou {{label:Board.Database.Save}}).
- Les photos restent uniquement en mémoire (jusqu’à 4 onglets ouverts) et ne sont pas enregistrées sur disque ; après un rechargement ou un redémarrage, la partie et ses marques de révision sont conservées et vous pouvez utiliser {{label:Scoresheet.LoadPhotoAgain}} dans le panneau {{label:Board.Tabs.Photo}} pour afficher de nouveau la photo sans l’envoyer.
