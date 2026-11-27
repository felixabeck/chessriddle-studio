---
id: game-report
title: Revisión de partida y reporte
summary: Analiza una partida con un motor local para ver la precisión, gráficos de valoración y tiempo, notas de apertura y repertorio, y momentos clave en el tablero.
source: d1a4339820f36de2
---

El reporte de partida analiza cada jugada de la línea principal con un motor de ajedrez local y convierte los resultados en una revisión guiada de la partida.

Para generar un reporte, abre una partida en el tablero de análisis, cambia a la pestaña {{label:Board.Analysis.Report}} y haz clic en {{label:Board.Analysis.GenerateReport}} (o pulsa el atajo {{label:Settings.Keybinds.Actions.GENERATE_REPORT}}).

En el diálogo {{label:Board.Analysis.GenerateReport}}:
- Elige un {{label:Common.Engine}} local. Si no hay ninguno instalado, añade uno en [[page:engines]].
- Define el límite de búsqueda por jugada (profundidad, tiempo o nodos).
- Activa {{label:Board.Analysis.MarkMoves}} para anotar las jugadas con símbolos de calidad (`!!`, `!`, `!?`, `?!`, `?`, `??`).
- Activa {{label:Board.Analysis.ShowVariations}} para insertar variantes con jugadas mejores en la notación.
- Activa {{label:Board.Analysis.AnnotateNovelties}} para marcar con `N` la primera jugada que sale de tu base de datos de referencia. Esta opción requiere una base de datos de referencia lista seleccionada en [[page:library]].
- Haz clic en {{label:Board.Analysis.Analyze}} para comenzar.

Mientras el reporte está en curso, puedes cancelarlo desde el botón de progreso. Editar la línea principal también cancela el reporte en curso.

Una vez terminado, {{label:Board.Analysis.Report}} muestra:
- Un encabezado discreto con el motor, el límite de búsqueda y la fecha, además de un botón pequeño {{label:Board.Analysis.Report.Regenerate}} al lado. El botón ancho {{label:Board.Analysis.GenerateReport}} solo aparece cuando no hay un reporte actual.
- Una frase de resumen sobre el marcador cuando la partida comenzó desde una posición equilibrada; si comenzó desequilibrada, no se muestra ninguna frase.
- Un único marcador con los nombres y ratings de los jugadores, {{label:Board.Analysis.Accuracy}} como cifra principal, {{label:Board.Analysis.Report.AverageLoss}}, la precisión por fase de la partida y las seis filas de calidad de jugada con los ceros atenuados. Al hacer clic en un recuento distinto de cero saltas a esas jugadas, y al pasar el cursor o enfocar con el teclado cualquier etiqueta se explica lo que mide.
- Un gráfico que alterna entre {{label:Board.Analysis.Report.Evaluation}} (con línea de cero) y {{label:Board.Analysis.Report.WinChance}}, con una explicación al pasar el cursor o enfocar con el teclado. Cuando al menos la mitad de las jugadas tienen reloj, aparece debajo una franja de {{label:Board.Analysis.Report.TimeUsage}}; haz clic en cualquier barra para ir a esa jugada.
- Un bloque de apertura y repertorio con el nombre de la apertura, la novedad (`N`) cuando existe y una nota de repertorio solo para tu bando, emparejado por nombre de jugador con tus cuentas conectadas de Lichess, Chess.com o alias en [[page:accounts]], o el bando situado en la parte inferior del tablero si ningún nombre coincide (girar el tablero cambia ese bando). Indica dónde saliste de tu repertorio (al hacer clic enfoca esa posición con flechas) o hasta dónde lo seguiste. Si no se pudieron leer por completo los archivos de repertorio, muestra una única línea atenuada: {{label:Board.Analysis.Report.RepertoireIncomplete}}
- {{label:Board.Analysis.Report.KeyMoments}}: haz clic en cualquier fila para ir a la posición anterior a la jugada, de modo que ambas flechas en el tablero (la jugada realizada y la mejor jugada) parten de esa casilla. Usa {{label:Board.Analysis.Report.PreviousMoment}} y {{label:Board.Analysis.Report.NextMoment}} para recorrerlos, o filtra por {{label:Board.Analysis.Report.FilterBoth}}, {{label:Board.Analysis.Report.FilterWhite}} o {{label:Board.Analysis.Report.FilterBlack}}. Los momentos también muestran etiquetas como {{label:Board.Analysis.Report.Tag.TurningPoint}} o {{label:Board.Analysis.Report.Tag.TimeTrouble}}, y el tipo de error cuando las líneas del motor lo demuestran.
- En los momentos `?!`, `?` y `??`, haz clic en {{label:Board.Analysis.Report.Explain}} para enfocar esa posición y abrir {{label:Board.Tabs.Coach}} con una pregunta sobre ese momento. Este botón permanece oculto si no hay ninguna conexión de IA configurada.

Si editas la partida después, vuelve a generar el reporte con {{label:Board.Analysis.GenerateReport}} o {{label:Board.Analysis.Report.Regenerate}} para actualizar la revisión.
