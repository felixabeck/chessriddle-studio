---
id: library-and-files
title: Files and the Library
summary: Set up a workspace folder, create and organize PGN files, open and save games, and manage the trash.
---

[[page:library]] ({{label:SideBar.Library}}) brings together your workspace PGN files (games, repertoires, tournaments, puzzles, and other files) and your game databases.

Before creating files, choose a workspace folder. If no folder is set yet, click {{label:Files.ChooseFolder}} on [[page:library]], or configure [[setting:files-directory]] ({{label:Settings.Directories.Files}}) under [[settings-category:directories]].

On [[page:library]]:
- Click {{label:Files.CreateFile}} to create a new PGN file or {{label:Files.CreateFolder}} to organize files into subfolders.
- Use the {{label:Common.Search}} input and the {{label:Files.FileType}} dropdown to filter by file type or {{label:Library.GamesDatabase}}.
- Select a file to preview its games (the preview can hide its moves with the eye button, [[setting:hide-preview-moves]]), open it on the analysis board, or use {{label:Files.Rename}}, {{label:Files.Move}}, and {{label:Files.Trash}}.

While editing a file on the analysis board:
- Save changes with the save button in the board's top bar (shown when auto-save is off, unavailable, or failed), {{label:Menu.File}} -> {{label:Common.Save}}, or the {{label:Settings.Keybinds.Actions.SAVE_FILE}} shortcut.
- Turn on [[setting:auto-save]] ({{label:Settings.AutoSave}}) to save edits to opened files automatically.
- Use {{label:Menu.File}} -> {{label:Board.Database.Save}} (or {{label:Board.Action.More}} -> {{label:Board.Database.Save}} in the board's top bar) to save the current game into another library file or database.

Moving a file to {{label:Files.Trash}} does not delete it permanently right away. You can immediately click {{label:Common.Undo}} in the notice, or scroll to the {{label:Files.Trash}} section in [[page:library]] to {{label:Files.Restore}} a file, {{label:Files.DeletePermanently}}, or {{label:Files.EmptyTrash}}.

When your ChessRiddle account is connected, click {{label:Library.Sync.Action}} on [[page:library]] to sync selected PGN files and game databases to your private Library on ChessRiddle (up to 100 files, 5 MB, 40,000 moves and 5,000 games per file). Edits, renames, deselections, and removals update automatically; downloaded game histories stay local. Turning sync off lets you keep or remove the synced files on ChessRiddle.
