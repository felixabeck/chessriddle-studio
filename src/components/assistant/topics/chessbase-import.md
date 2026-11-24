---
id: chessbase-import
title: Importing databases from ChessBase
summary: Export a ChessBase database to PGN and convert it into a Studio database.
---

ChessRiddle Studio does not read ChessBase `.cbh` or `.cbv` files directly. Instead, export your ChessBase database to PGN first and then convert the PGN file into a Studio database.

If you select a ChessBase file in a file picker, Studio opens the {{label:ChessBaseGuide.Title}} dialog automatically. You can also open it from the guide link inside {{label:Library.AddDatabase}} on [[page:library]].

Follow these steps to import from ChessBase:
1. Open the database in ChessBase and select the games you want to export.
2. Export or save the selected games as a `.pgn` file in ChessBase.
3. In Studio, open [[page:library]], click {{label:Library.AddDatabase}}, switch to the {{label:Common.Local}} tab, pick the exported `.pgn` file, give it a {{label:Common.Name}}, and click {{label:Databases.Add.Convert}}.

Once converted, the database appears in [[page:library]] where you can explore its games, players, and tournaments or set it as your {{label:Databases.Settings.ReferenceDatabase}}.
