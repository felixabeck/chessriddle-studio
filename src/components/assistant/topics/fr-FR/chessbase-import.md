---
id: chessbase-import
title: Importer des bases depuis ChessBase
summary: Exportez une base ChessBase en PGN et convertissez-la en base de données Studio.
source: d7f599a811a0afb0
---

ChessRiddle Studio ne lit pas directement les fichiers ChessBase `.cbh` ou `.cbv`. Exportez d’abord votre base ChessBase au format PGN, puis convertissez le fichier PGN en base de données Studio.

Si vous sélectionnez un fichier ChessBase dans un sélecteur de fichiers, Studio ouvre automatiquement la boîte de dialogue {{label:ChessBaseGuide.Title}}. Vous pouvez aussi l’ouvrir depuis le lien d’aide dans {{label:Library.AddDatabase}} sur [[page:library]].

Suivez ces étapes pour importer depuis ChessBase :
1. Ouvrez la base dans ChessBase et sélectionnez les parties que vous souhaitez exporter.
2. Exportez ou enregistrez les parties sélectionnées au format `.pgn` dans ChessBase.
3. Dans Studio, ouvrez [[page:library]], cliquez sur {{label:Library.AddDatabase}}, passez à l’onglet {{label:Common.Local}}, sélectionnez le fichier `.pgn` exporté, donnez-lui un {{label:Common.Name}} et cliquez sur {{label:Databases.Add.Convert}}.

Une fois convertie, la base apparaît dans [[page:library]], où vous pouvez explorer ses parties, joueurs et tournois ou la définir comme {{label:Databases.Settings.ReferenceDatabase}}.
