---
id: library-and-files
title: Fichiers et Bibliothèque
summary: Configurez un dossier de travail, créez et organisez des fichiers PGN, ouvrez et enregistrez des parties et gérez la corbeille.
source: 984717132dfb14c1
---

[[page:library]] ({{label:SideBar.Library}}) rassemble les fichiers PGN de votre espace de travail (parties, répertoires, tournois, problèmes et autres fichiers) ainsi que vos bases de parties.

Avant de créer des fichiers, choisissez un dossier de travail. Si aucun dossier n’est encore défini, cliquez sur {{label:Files.ChooseFolder}} sur [[page:library]], ou configurez [[setting:files-directory]] ({{label:Settings.Directories.Files}}) dans [[settings-category:directories]].

Sur [[page:library]] :
- Cliquez sur {{label:Files.CreateFile}} pour créer un nouveau fichier PGN ou sur {{label:Files.CreateFolder}} pour organiser vos fichiers en sous-dossiers.
- Utilisez le champ {{label:Common.Search}} et le menu {{label:Files.FileType}} pour filtrer par type de fichier ou par {{label:Library.GamesDatabase}}.
- Sélectionnez un fichier pour prévisualiser ses parties, l’ouvrir sur l’échiquier d’analyse ou utiliser {{label:Files.Rename}}, {{label:Files.Move}} et {{label:Files.Trash}}.

Lorsque vous modifiez un fichier sur l’échiquier d’analyse :
- Enregistrez vos modifications via le bouton d’enregistrement de la barre d’outils de l’échiquier, {{label:Menu.File}} -> {{label:Common.Save}}, ou le raccourci {{label:Settings.Keybinds.Actions.SAVE_FILE}}.
- Activez [[setting:auto-save]] ({{label:Settings.AutoSave}}) pour enregistrer automatiquement les modifications des fichiers ouverts.
- Utilisez {{label:Menu.File}} -> {{label:Board.Database.Save}} (ou le bouton {{label:Board.Database.Save}} de la barre d’outils) pour enregistrer la partie en cours dans un autre fichier de la bibliothèque ou une base de données.

Déplacer un fichier vers {{label:Files.Trash}} ne le supprime pas définitivement tout de suite. Vous pouvez cliquer immédiatement sur {{label:Common.Undo}} dans la notification, ou faire défiler jusqu’à la section {{label:Files.Trash}} dans [[page:library]] pour {{label:Files.Restore}} un fichier, utiliser {{label:Files.DeletePermanently}} ou {{label:Files.EmptyTrash}}.
