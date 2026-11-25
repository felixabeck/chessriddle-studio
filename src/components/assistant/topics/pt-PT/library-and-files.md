---
id: library-and-files
title: Ficheiros e Biblioteca
summary: Configure uma pasta de trabalho, crie e organize ficheiros PGN, abra e guarde partidas e faça a gestão do lixo.
source: 2c064b437ded0b67
---

[[page:library]] ({{label:SideBar.Library}}) reúne os ficheiros PGN da sua área de trabalho (partidas, repertórios, torneios, problemas e outros ficheiros) e as suas bases de dados de partidas.

Antes de criar ficheiros, escolha uma pasta de trabalho. Se ainda não existir nenhuma pasta definida, clique em {{label:Files.ChooseFolder}} em [[page:library]], ou configure [[setting:files-directory]] ({{label:Settings.Directories.Files}}) em [[settings-category:directories]].

Em [[page:library]]:
- Clique em {{label:Files.CreateFile}} para criar um novo ficheiro PGN ou em {{label:Files.CreateFolder}} para organizar ficheiros em subpastas.
- Utilize o campo {{label:Common.Search}} e a lista {{label:Files.FileType}} para filtrar por tipo de ficheiro ou {{label:Library.GamesDatabase}}.
- Selecione um ficheiro para pré-visualizar as respetivas partidas, abri-lo no tabuleiro de análise ou usar {{label:Files.Rename}}, {{label:Files.Move}} e {{label:Files.Trash}}.

Enquanto edita um ficheiro no tabuleiro de análise:
- Guarde as alterações com o botão guardar na barra do tabuleiro, {{label:Menu.File}} -> {{label:Common.Save}}, ou o atalho {{label:Settings.Keybinds.Actions.SAVE_FILE}}.
- Ative [[setting:auto-save]] ({{label:Settings.AutoSave}}) para gravar automaticamente as alterações nos ficheiros abertos.
- Utilize {{label:Menu.File}} -> {{label:Board.Database.Save}} (ou o botão {{label:Board.Database.Save}} na barra de ferramentas) para guardar a partida atual noutro ficheiro da biblioteca ou base de dados.

Mover um ficheiro para {{label:Files.Trash}} não o elimina permanentemente de imediato. Pode clicar logo em {{label:Common.Undo}} no aviso, ou deslocar-se até à secção {{label:Files.Trash}} em [[page:library]] para {{label:Files.Restore}} um ficheiro, usar {{label:Files.DeletePermanently}} ou {{label:Files.EmptyTrash}}.

Quando a sua conta ChessRiddle estiver ligada, clique em {{label:Library.Sync.Action}} em [[page:library]] para sincronizar os ficheiros PGN selecionados com a sua biblioteca privada no ChessRiddle (até 100 ficheiros, 5 MB e 40 000 lances por ficheiro). As edições, alterações de nome, desseleções e eliminações são atualizadas automaticamente; os históricos de partidas transferidos e as bases de dados de partidas permanecem locais. Ao desligar a sincronização, pode manter ou remover os ficheiros sincronizados no ChessRiddle.
