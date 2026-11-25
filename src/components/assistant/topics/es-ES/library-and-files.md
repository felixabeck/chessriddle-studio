---
id: library-and-files
title: Archivos y la Biblioteca
summary: Configura una carpeta de trabajo, crea y organiza archivos PGN, abre y guarda partidas y gestiona la papelera.
source: 1c8e1ec37f492b22
---

[[page:library]] ({{label:SideBar.Library}}) reúne tus archivos PGN del espacio de trabajo (partidas, repertorios, torneos, puzles y otros archivos) junto con tus bases de datos de partidas.

Antes de crear archivos, elige una carpeta de trabajo. Si aún no hay ninguna configurada, haz clic en {{label:Files.ChooseFolder}} en [[page:library]], o configura [[setting:files-directory]] ({{label:Settings.Directories.Files}}) en [[settings-category:directories]].

En [[page:library]]:
- Haz clic en {{label:Files.CreateFile}} para crear un nuevo archivo PGN o en {{label:Files.CreateFolder}} para organizar los archivos en subcarpetas.
- Usa el campo {{label:Common.Search}} y el desplegable {{label:Files.FileType}} para filtrar por tipo de archivo o por {{label:Library.GamesDatabase}}.
- Selecciona un archivo para previsualizar sus partidas (la vista previa puede ocultar las jugadas con el botón del ojo, [[setting:hide-preview-moves]]), abrirlo en el tablero de análisis o usar {{label:Files.Rename}}, {{label:Files.Move}} y {{label:Files.Trash}}.

Mientras editas un archivo en el tablero de análisis:
- Guarda los cambios con el botón de guardar en la barra del tablero, {{label:Menu.File}} -> {{label:Common.Save}}, o el atajo {{label:Settings.Keybinds.Actions.SAVE_FILE}}.
- Activa [[setting:auto-save]] ({{label:Settings.AutoSave}}) para guardar automáticamente los cambios en los archivos abiertos.
- Usa {{label:Menu.File}} -> {{label:Board.Database.Save}} (o el botón {{label:Board.Database.Save}} de la barra de herramientas) para guardar la partida actual en otro archivo de la biblioteca o base de datos.

Mover un archivo a {{label:Files.Trash}} no lo elimina de forma permanente al instante. Puedes hacer clic de inmediato en {{label:Common.Undo}} en el aviso, o desplazarte a la sección {{label:Files.Trash}} en [[page:library]] para {{label:Files.Restore}} un archivo, usar {{label:Files.DeletePermanently}} o ejecutar {{label:Files.EmptyTrash}}.

Cuando tu cuenta de ChessRiddle esté conectada, haz clic en {{label:Library.Sync.Action}} en [[page:library]] para sincronizar los archivos PGN seleccionados con tu biblioteca privada en ChessRiddle (hasta 100 archivos, 5 MB y 40 000 jugadas por archivo). Las ediciones, los cambios de nombre, las deselecciones y las eliminaciones se actualizan automáticamente; los historiales de partidas descargados y las bases de datos de partidas permanecen en local. Al desactivar la sincronización puedes mantener o eliminar los archivos sincronizados en ChessRiddle.
