---
id: chessbase-import
title: Importere databaser fra ChessBase
summary: Eksporter en ChessBase-database til PGN og konverter den til en Studio-database.
source: d7f599a811a0afb0
---

ChessRiddle Studio leser ikke ChessBase-`.cbh`- eller `.cbv`-filer direkte. Eksporter i stedet ChessBase-databasen til PGN først, og konverter deretter PGN-filen til en Studio-database.

Hvis du velger en ChessBase-fil i en filvelger, åpner Studio dialogen {{label:ChessBaseGuide.Title}} automatisk. Du kan også åpne den fra veiledningslenken inne i {{label:Library.AddDatabase}} på [[page:library]].

Følg disse trinnene for å importere fra ChessBase:
1. Åpne databasen i ChessBase og velg partiene du vil eksportere.
2. Eksporter eller lagre de valgte partiene som en `.pgn`-fil i ChessBase.
3. I Studio åpner du [[page:library]], klikker {{label:Library.AddDatabase}}, bytter til fanen {{label:Common.Local}}, velger den eksporterte `.pgn`-filen, gir den et {{label:Common.Name}} og klikker {{label:Databases.Add.Convert}}.

Når den er konvertert, vises databasen i [[page:library]], der du kan utforske partier, spillere og turneringer eller angi den som din {{label:Databases.Settings.ReferenceDatabase}}.
