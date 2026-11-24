---
id: chessbase-import
title: Importar bases de datos desde ChessBase
summary: Exporta una base de datos de ChessBase a PGN y conviértela en una base de datos de Studio.
source: d7f599a811a0afb0
---

ChessRiddle Studio no lee directamente los archivos `.cbh` o `.cbv` de ChessBase. En su lugar, exporta primero tu base de datos de ChessBase a PGN y luego convierte el archivo PGN en una base de datos de Studio.

Si seleccionas un archivo de ChessBase en un selector de archivos, Studio abre automáticamente el diálogo {{label:ChessBaseGuide.Title}}. También puedes abrirlo desde el enlace de guía dentro de {{label:Library.AddDatabase}} en [[page:library]].

Sigue estos pasos para importar desde ChessBase:
1. Abre la base de datos en ChessBase y selecciona las partidas que quieras exportar.
2. Exporta o guarda las partidas seleccionadas como un archivo `.pgn` en ChessBase.
3. En Studio, abre [[page:library]], haz clic en {{label:Library.AddDatabase}}, cambia a la pestaña {{label:Common.Local}}, elige el archivo `.pgn` exportado, asigna un {{label:Common.Name}} y haz clic en {{label:Databases.Add.Convert}}.

Una vez convertida, la base de datos aparece en [[page:library]], donde puedes explorar sus partidas, jugadores y torneos o establecerla como tu {{label:Databases.Settings.ReferenceDatabase}}.
