---
id: analysis-board
title: Tablero de análisis, variantes, comentarios y flechas
summary: Introduce jugadas, edita posiciones, gestiona variantes, escribe comentarios, añade anotaciones y dibuja flechas en el tablero.
source: 958c8f05fc6ed494
---

Abre un tablero de análisis desde [[page:new-tab]] haciendo clic en {{label:Home.Card.AnalysisBoard.Title}} o abriendo una partida o repertorio guardado desde [[page:library]].

Realiza jugadas arrastrando o haciendo clic en las piezas (configurable en [[setting:move-method]]). También puedes activar [[setting:text-input]] ({{label:Settings.Inputs.TextInput}}) para escribir jugadas en notación SAN. Usa los controles de jugada debajo de la notación, las teclas de flecha o la rueda del ratón (si [[setting:scroll-moves]] está activado) para avanzar o retroceder por las jugadas.

La barra de herramientas junto a la notación ofrece acciones de tablero:
- {{label:Board.Action.TakeSnapshot}}: guarda una imagen de la posición actual.
- {{label:Board.Action.EditPosition}}: configura una posición personalizada colocando piezas o editando el FEN.
- {{label:Board.Action.PlayFromHere}}: inicia una partida desde la posición actual.
- {{label:Board.Action.ClearDrawings}}: elimina las flechas y casillas resaltadas (se muestra cuando [[setting:erase-drawables]] está desactivado).
- {{label:Board.Database.Save}}: guarda la partida en un archivo de la biblioteca o en una base de datos.
- Controles para deshacer, rehacer, guardar y girar el tablero.

Jugar una jugada distinta desde una posición anterior crea una variante. Haz clic derecho sobre cualquier jugada en la notación para usar {{label:Menu.PromoteVariation}}, {{label:Menu.PromoteToMainLine}}, {{label:Menu.CopyVariationPGN}}, {{label:Menu.DeleteMove}}, {{label:Menu.DeleteVariation}}, {{label:Menu.DeleteMovesAfter}}, {{label:Board.Action.PlayFromHere}}, {{label:Notation.AddDiagram}} o {{label:Notation.MarkGameEndHere}}. Usa los botones del encabezado de la notación para alternar {{label:Notation.HideMoves}}, {{label:Notation.TableView}}, {{label:Notation.HideComments}}, {{label:Notation.HideDiagrams}} y {{label:Notation.HideVariations}}.

Para anotar jugadas y escribir comentarios, abre la pestaña {{label:Board.Tabs.Annotate}}. Haz clic en un símbolo de calidad de jugada (o pulsa las teclas del 1 al 6) para alternar `!!`, `!`, `!?`, `?!`, `?` o `??`, o haz clic en {{label:Annotate.ShowMore}} para ver símbolos de evaluación y posicionales. Debajo de los símbolos, usa el editor de texto enriquecido para escribir comentarios con formato y activar diagramas integrados en el tablero.

Para dibujar flechas y resaltar casillas, haz clic derecho y arrastra sobre el tablero (o haz clic derecho en una casilla para dibujar un círculo). Mantén pulsadas teclas modificadoras para usar otros colores: Mayús para {{label:Settings.Drawing.Red}}, Alt para {{label:Settings.Drawing.Blue}}, Mayús+Alt para {{label:Settings.Drawing.Yellow}}, Ctrl (Cmd en macOS) para {{label:Settings.Drawing.Orange}} y Ctrl+Alt (Cmd+Alt en macOS) para {{label:Settings.Drawing.Cyan}}. Consulta la lista completa de dibujo en [[settings-category:keybinds]].

La pestaña {{label:Board.Tabs.Info}} muestra las cabeceras de la partida, el FEN, el texto PGN y estadísticas del árbol, y te permite cambiar entre partidas en un archivo PGN con varias partidas.

Para organizar el tablero de análisis, arrastra una pestaña de panel ({{label:Board.Tabs.Analysis}}, {{label:Board.Tabs.Database}}, {{label:Board.Tabs.Annotate}}, {{label:Board.Tabs.Coach}} o {{label:Board.Tabs.Info}}) o usa los botones de agarre de la barra de pestañas, la cabecera de la notación o la cabecera de un área de panel para colocar áreas al lado, encima o debajo de otra área con vista previa o con el teclado. Para que un panel abarque dos áreas (por ejemplo, {{label:Board.Tabs.Database}} sobre la notación y las pestañas), coloca primero el panel encima de una de ellas y después mueve la otra a su lado. Usa {{label:Board.Area.ReturnToTabs}} o arrastra un área de panel sobre la lista de pestañas para devolverla a las pestañas, y usa [[setting:board-layout]] ({{label:Settings.BoardLayout.Reset}}) para restaurar la disposición predeterminada.

Para ocultar las pestañas, por ejemplo cuando cada panel que usas se muestra como su propia zona, haz clic en {{label:Board.Area.HideTabs}} al final de la barra de pestañas; las zonas vecinas ocupan su espacio. Las pestañas conservan su posición y tamaño: vuelve a mostrarlas con {{label:Board.Arrange.ShowTabs}} en el menú del asa del encabezado de la notación, con un atajo de pestaña o al generar el informe. Un panel que devuelves mientras las pestañas están ocultas pasa a las pestañas ocultas.
