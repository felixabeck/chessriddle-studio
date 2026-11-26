---
id: repertoires
title: Repertorios de aperturas
summary: Crea un repertorio, importa archivos PGN, amplía la cobertura frente a una base de datos de referencia, practica con repetición espaciada y sigue variantes abiertas, transposiciones y marcas de revisión.
source: db00ec0860d0fa31
---

Los repertorios son archivos PGN de tipo Repertorio que añaden la pestaña {{label:Board.Tabs.Practice}} al tablero de análisis.

Para crear un repertorio, abre [[page:new-tab]] y haz clic en {{label:Home.Card.NewRepertoire.Title}} (o crea un archivo de repertorio en [[page:library]]). Introduce un {{label:Common.Name}}, elige {{label:Common.WHITE}} o {{label:Common.BLACK}}, selecciona o pega opcionalmente un PGN en {{label:Home.Card.NewRepertoire.FromPgn}} y haz clic en {{label:Common.Create}}. También puedes importar un PGN desde {{label:Home.Card.ImportGame.Title}} con {{label:Import.SaveToCollection}} activado y tipo de archivo {{label:Files.FileType.Repertoire}}.

Construye tu repertorio en {{label:Board.Tabs.Practice}} -> {{label:Board.Practice.Build}}:
- Haz clic en {{label:Board.Practice.Build.ImportPgn}} para combinar un archivo PGN o partidas pegadas en el repertorio abierto (funciona con o sin base de datos de referencia).
- Configura una {{label:Databases.Settings.ReferenceDatabase}} en [[page:library]] para que el creador muestre frecuencias de jugada y cobertura.
- En un repertorio vacío, puedes empezar desde uno de los ajustes integrados de {{label:Board.Practice.Build.Presets}} o introducir jugadas en el tablero.
- Marca la posición inicial de tu repertorio con {{label:Board.Practice.Build.SetAsStart}} (o haz clic derecho sobre una jugada en la notación y elige {{label:Menu.MarkAsStart}}).
- Haz clic en jugadas de {{label:Board.Practice.Build.OpponentMoves}} o {{label:Board.Practice.Build.YourResponse}} para añadir o seguir líneas. Usa {{label:Board.Practice.Build.NextGap}} y {{label:Board.Practice.Build.BiggestGap}} para saltar a respuestas del rival sin cubrir por encima del número mínimo de partidas fijado en [[setting:repertoire-depth]].

Practica tu repertorio en {{label:Board.Tabs.Practice}} -> {{label:Board.Practice.Train}}:
- Haz clic en {{label:Board.Practice.StartPractice}} para entrenar posiciones pendientes y nuevas con repetición espaciada, o en {{label:Board.Practice.PracticeFullRepertoire}} para repasar cada posición del repertorio.
- Juega tu jugada preparada en el tablero. Si te quedas bloqueado tras una jugada incorrecta, haz clic en {{label:Board.Practice.ShowMove}}.
- Revisa todas las tarjetas con {{label:Board.Practice.ShowAll}}, consulta el historial con {{label:Board.Practice.ShowLogs}} o reinicia el progreso con {{label:Common.Reset}}.
- Los repertorios con tarjetas pendientes también aparecen en {{label:Home.Library.Due}} en [[page:new-tab]].
- Configura la calificación de repetición espaciada y los límites de tarjetas nuevas en [[settings-category:repertoire]] ([[setting:practice-grading]], [[setting:practice-new-per-session]]).

En la notación del tablero de análisis:
- Una línea secundaria de una sola jugada se enmarca con borde discontinuo como {{label:Notation.OpenVariation}} para que detectes ramas sin terminar. Pulsa el atajo {{label:Settings.Keybinds.Actions.NEXT_OPEN_VARIATION}} para saltar a la siguiente.
- Cuando una posición aparece en otra rama del mismo repertorio, se muestra un icono de {{label:Notation.Transposition}} junto a la jugada; haz clic en él para saltar a la otra rama.
- Cuando un PGN importado contiene una respuesta distinta para tu bando, la jugada importada se añade como variante y se marca como {{label:Notation.ReviewMove}}. Haz clic derecho sobre la jugada y elige {{label:Menu.MarkAsReviewed}} para quitar la marca.
