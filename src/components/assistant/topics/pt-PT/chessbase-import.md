---
id: chessbase-import
title: Importar bases de dados do ChessBase
summary: Exporte uma base de dados do ChessBase para PGN e converta-a numa base de dados do Studio.
source: d7f599a811a0afb0
---

O ChessRiddle Studio não lê diretamente ficheiros `.cbh` ou `.cbv` do ChessBase. Em vez disso, exporte primeiro a sua base de dados do ChessBase para PGN e depois converta o ficheiro PGN numa base de dados do Studio.

Se selecionar um ficheiro do ChessBase num seletor de ficheiros, o Studio abre automaticamente a janela {{label:ChessBaseGuide.Title}}. Também pode abri-la a partir da ligação do guia dentro de {{label:Library.AddDatabase}} em [[page:library]].

Siga estes passos para importar a partir do ChessBase:
1. Abra a base de dados no ChessBase e selecione as partidas que pretende exportar.
2. Exporte ou guarde as partidas selecionadas como ficheiro `.pgn` no ChessBase.
3. No Studio, abra [[page:library]], clique em {{label:Library.AddDatabase}}, mude para o separador {{label:Common.Local}}, escolha o ficheiro `.pgn` exportado, atribua um {{label:Common.Name}} e clique em {{label:Databases.Add.Convert}}.

Depois de convertida, a base de dados aparece em [[page:library]], onde pode explorar as suas partidas, jogadores e torneios ou defini-la como a sua {{label:Databases.Settings.ReferenceDatabase}}.
