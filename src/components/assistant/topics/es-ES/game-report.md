---
id: game-report
title: Informe de partida
summary: Ejecuta una revisión automática con motor de una partida para ver la precisión, la gráfica de evaluación, los momentos clave y la clasificación de jugadas.
source: b69aae8a4fe0f417
---

El informe de partida analiza cada jugada de la línea principal con un motor de ajedrez local y resume la precisión y los errores de la partida.

Para generar un informe, abre una partida en el tablero de análisis, cambia a la pestaña {{label:Board.Analysis.Report}} y haz clic en {{label:Board.Analysis.GenerateReport}} (o pulsa el atajo {{label:Settings.Keybinds.Actions.GENERATE_REPORT}}).

En el diálogo {{label:Board.Analysis.GenerateReport}}:
- Elige un {{label:Common.Engine}} local. Si no tienes ninguno instalado, añade uno en [[page:engines]].
- Define el límite de búsqueda por jugada (profundidad, tiempo o nodos).
- Activa {{label:Board.Analysis.MarkMoves}} para anotar las jugadas con símbolos de calidad.
- Activa {{label:Board.Analysis.ShowVariations}} para insertar variantes con mejores jugadas en la notación.
- Activa {{label:Board.Analysis.AnnotateNovelties}} para marcar la primera jugada que sale de tu base de datos de referencia. Esta opción requiere tener seleccionada una base de referencia lista en [[page:library]].
- Haz clic en {{label:Board.Analysis.Analyze}} para empezar.

Mientras se ejecuta un informe, puedes cancelarlo desde el botón de progreso. Editar la línea principal cancela un informe en curso.

Una vez terminado, {{label:Board.Analysis.Report}} muestra:
- Porcentajes de precisión y pérdida media de centipeones (ACPL) para {{label:Common.WHITE}} y {{label:Common.BLACK}}.
- Una gráfica de evaluación a lo largo de toda la partida.
- {{label:Board.Analysis.Report.KeyMoments}}: lista interactiva de jugadas marcadas con saltos de evaluación y mejores jugadas.
- Una tabla de desglose de calidad de jugadas donde al hacer clic en una cifra saltas a esas jugadas.

Si editas la partida después, haz clic en {{label:Board.Analysis.RegenerateReport}} para ejecutar un nuevo análisis.
