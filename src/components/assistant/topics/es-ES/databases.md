---
id: databases
title: Bases de datos, explorador, búsqueda de posición, jugadores y torneos
summary: Añade o descarga bases de datos de partidas, elige una base de referencia, busca posiciones en el explorador y consulta partidas, jugadores y torneos.
source: 79c93eb50f572f36
---

Las bases de datos viven en [[page:library]] ({{label:SideBar.Library}}) junto a tus archivos PGN y se guardan en [[setting:databases-directory]].

Para añadir una base de datos, abre [[page:library]] y haz clic en {{label:Library.AddDatabase}}:
- {{label:Databases.Add.Web}}: descarga bases de datos seleccionadas del catálogo.
- {{label:Common.Local}}: elige un archivo PGN local (incluidos `.pgn.zst` o `.pgn.bz2`), introduce un {{label:Common.Name}} y una {{label:Common.Description}} opcional, y haz clic en {{label:Databases.Add.Convert}}.

Selecciona una base de datos en [[page:library]] para gestionarla:
- Marca {{label:Databases.Settings.ReferenceDatabase}} para convertirla en la base de referencia predeterminada para el explorador, el creador de repertorios, las novedades del informe de partida y el Coach.
- Marca {{label:Databases.Settings.Indexed}} para crear o eliminar índices de búsqueda y acelerar las consultas.
- Haz clic en {{label:Databases.Settings.Explore}} para abrir la vista de tabla de la base de datos.
- En {{label:Databases.Settings.Actions}}, usa {{label:Databases.Settings.AddGames}} para añadir archivos PGN, {{label:Databases.Settings.ExportPGN}} para exportar a PGN o {{label:Common.Delete}} para eliminar la base de datos.
- En {{label:Databases.Settings.AdvancedTools}}, usa {{label:Databases.Settings.MergePlayers}} para combinar entradas duplicadas de jugadores, o {{label:Databases.Settings.RemoveDup}} y {{label:Databases.Settings.RemoveEmpty}} para limpiar partidas.

Dentro de la vista de tabla de la base de datos, cambia entre {{label:Common.Games}}, {{label:Databases.Card.Players}} y {{label:Databases.Settings.Events}} (torneos):
- Busca y ordena partidas, previsualiza una partida (la vista previa puede ocultar las jugadas con el botón del ojo, [[setting:hide-preview-moves]]) o ábrela en el tablero de análisis.
- En {{label:Databases.Card.Players}}, selecciona un jugador para ver {{label:Home.Personal.Overview}}, {{label:Home.Personal.Ratings}} y {{label:Home.Personal.Openings}} (un árbol de aperturas interactivo), además de datos de la FIDE mediante {{label:Databases.FIDE.Info}}. Usa {{label:Databases.OpeningTree.Prepare}} en {{label:Home.Personal.Openings}} para conservar la línea, el color y el periodo {{label:Databases.OpeningTree.Since}} seleccionados.
- En {{label:Databases.Settings.Events}}, busca torneos por nombre y ordénalos por fecha, jugadores, partidas o Elo medio.

En la ficha de un jugador, abre la pestaña {{label:Home.Personal.Preparation}} para comparar sus partidas con tus archivos de repertorio:
- Elige el color del rival, el periodo {{label:Databases.OpeningTree.Since}} y (con cuentas en línea vinculadas) {{label:Databases.OpeningTree.OverTheBoard}}, {{label:Databases.OpeningTree.Online}} o {{label:Databases.Preparation.Both}}. Haz clic en {{label:Databases.Preparation.Refresh}} para volver a ejecutar la comparación, o haz clic en {{label:Databases.OpeningTree.Prepare}} para abrir la posición inicial en un tablero de análisis usando el color y el periodo {{label:Databases.OpeningTree.Since}} de esa pestaña.
- Sube {{label:Databases.Preparation.MinGames}} para ocultar las líneas y huecos que el rival jugó solo rara vez; tu archivo pliega esas líneas y el entrenamiento las omite.
- Revisa las líneas que juega el rival y {{label:Databases.Preparation.GapsTitle}}. Haz clic en cualquier fila para abrir tu archivo de repertorio en esa posición con las demás variantes ocultas; cambia entre {{label:Notation.PreparationOpponentLines}} y {{label:Notation.PreparationAllLines}} en la cabecera de la notación.
- Haz clic en {{label:Databases.Preparation.TrainLines}} para iniciar una sesión cronometrada con esas líneas; tus respuestas actualizan el calendario normal de repetición espaciada.
- Para prepararte contra un rival que solo tiene una cuenta de Lichess o Chess.com, haz clic en {{label:Library.OnlineOpponent}} en [[page:library]] para buscar su cuenta, descargar sus partidas y abrir su ficha directamente en la pestaña {{label:Home.Personal.Preparation}} (al introducir la misma cuenta de nuevo se vuelve a abrir sin descargar otra vez).

En el tablero de análisis, abre {{label:Board.Tabs.Database}} para usar el explorador de aperturas:
- Elige {{label:Board.Database.LichessAll}} o {{label:Board.Database.LichessMaster}} en el menú de fuentes y en {{label:Board.Database.Compare}} (los exploradores en línea de Lichess requieren una cuenta de Lichess con sesión iniciada en [[page:accounts]]).
- {{label:Board.Database.Stats}} (estadísticas de jugadas) aparece arriba y {{label:Board.Database.Games}} (partidas coincidentes) debajo; mientras se muestran ambas regiones, arrastra el divisor entre ellas para repartir la altura. Usa {{label:Board.Database.HideGames}} o {{label:Board.Database.ShowGames}} para ocultar o mostrar la lista de partidas, y el engranaje de ajustes para desplegar o plegar los controles de fuentes — ambos están en la cabecera del panel cuando es un mosaico propio y en la fila superior de controles cuando está en las pestañas. La columna {{label:Board.Area.Notation}} muestra las jugadas desde la posición del tablero, con la siguiente jugada en negrita.
- Haz clic en {{label:Board.Database.Compare}} para ver dos fuentes lado a lado, o abre {{label:Board.Database.Local.Position}} para alternar entre búsqueda de posición {{label:Board.Database.Local.Exact}} y {{label:Board.Database.Local.Partial}} (incluida {{label:Board.Database.Local.SimilarStructure}} para buscar por estructura de peones y {{label:Fen.Empty}} para patrones personalizados).
- También puedes mostrar {{label:Board.Tabs.Database}} como su propia área en el tablero de análisis y usar {{label:Board.Area.ReturnToTabs}} para devolverla a las pestañas.
- Cuando {{label:Databases.OpeningTree.Prepare}} abre un tablero para un jugador de la base de datos, el explorador empieza con tu base de referencia como columna adicional junto a las partidas del rival; haz clic en {{label:Board.Database.RemoveReference}} para ocultar una columna o en {{label:Board.Database.AddColumn}} para añadir otra.
