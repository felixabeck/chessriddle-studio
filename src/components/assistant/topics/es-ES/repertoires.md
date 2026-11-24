---
id: repertoires
title: Repertorios de aperturas
summary: Crea un repertorio, amplía la cobertura frente a una base de datos de referencia, practica con repetición espaciada y sigue las variantes abiertas y transposiciones.
source: 62b7ff51627518a7
---

Los repertorios son archivos PGN de tipo Repertorio que añaden la pestaña {{label:Board.Tabs.Practice}} al tablero de análisis.

Para crear un repertorio, abre [[page:new-tab]] y haz clic en {{label:Home.Card.NewRepertoire.Title}} (o crea un archivo de repertorio en [[page:library]]). Introduce un {{label:Common.Name}}, elige {{label:Common.WHITE}} o {{label:Common.BLACK}} y haz clic en {{label:Common.Create}}.

Construye tu repertorio en {{label:Board.Tabs.Practice}} -> {{label:Board.Practice.Build}}:
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
