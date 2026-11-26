---
id: analysis-board
title: Tablero de análisis, variantes, comentarios y flechas
summary: Introduce jugadas, edita posiciones, gestiona variantes, escribe comentarios, añade anotaciones y dibuja flechas en el tablero.
source: f49e0c9098ffc5cf
---

Abre un tablero de análisis desde [[page:new-tab]] haciendo clic en {{label:Home.Card.AnalysisBoard.Title}} o abriendo una partida o repertorio guardado desde [[page:library]].

Realiza jugadas arrastrando o haciendo clic en las piezas (configurable en [[setting:move-method]]). También puedes activar [[setting:text-input]] ({{label:Settings.Inputs.TextInput}}) para escribir jugadas en notación SAN. Usa los controles de jugada debajo de la notación, las teclas de flecha o la rueda del ratón (si [[setting:scroll-moves]] está activado) para avanzar o retroceder por las jugadas.

La barra superior sobre el tablero ofrece acciones de tablero:
- {{label:Board.Action.PlayFromHere}}: inicia una partida desde la posición actual.
- Girar tablero (`F`): intercambia Blancas y Negras en la parte inferior del tablero.
- Guardar: aparece cuando la partida tiene cambios sin guardar y el guardado automático está desactivado, no disponible (como en un borrador) o falló.
- {{label:Board.Action.More}}: abre el menú con {{label:Board.Action.NewAnalysis}} (sustituye el tablero por uno vacío en la misma pestaña; si la partida tiene cambios sin guardar, se te pregunta antes), {{label:Board.Database.Save}} (guarda la partida en un archivo de la biblioteca o en una base de datos), {{label:Board.Action.TakeSnapshot}} (guarda una imagen del tablero actual) y {{label:Board.Action.EditPosition}} (configura una posición personalizada colocando piezas o editando el FEN).
- Deshacer, rehacer y borrar flechas o casillas resaltadas (cuando [[setting:erase-drawables]] está desactivado) usan sus atajos de teclado en [[settings-category:keybinds]].

Jugar una jugada distinta desde una posición anterior crea una variante. Haz clic derecho sobre cualquier jugada en la notación para usar {{label:Menu.PromoteVariation}}, {{label:Menu.PromoteToMainLine}}, {{label:Menu.CopyVariationPGN}}, {{label:Menu.DeleteMove}}, {{label:Menu.DeleteVariation}}, {{label:Menu.DeleteMovesAfter}}, {{label:Board.Action.PlayFromHere}}, {{label:Notation.AddDiagram}} o {{label:Notation.MarkGameEndHere}}. Usa el botón del ojo en el encabezado de la notación para {{label:Notation.HideMoves}}, y el menú {{label:Notation.ViewOptions}} para alternar {{label:Notation.TableView}}, {{label:Notation.ShowComments}}, {{label:Notation.ShowDiagrams}} y {{label:Notation.ShowVariations}}.

Para anotar jugadas y escribir comentarios, abre la pestaña {{label:Board.Tabs.Annotate}}. Haz clic en un símbolo de calidad de jugada (o pulsa las teclas del 1 al 6) para alternar `!!`, `!`, `!?`, `?!`, `?` o `??`, o haz clic en {{label:Annotate.ShowMore}} para ver símbolos de evaluación y posicionales. Debajo de los símbolos, usa el editor de texto enriquecido para escribir comentarios con formato y activar diagramas integrados en el tablero.

Para dibujar flechas y resaltar casillas, haz clic derecho y arrastra sobre el tablero (o haz clic derecho en una casilla para dibujar un círculo). Mantén pulsadas teclas modificadoras para usar otros colores: Mayús para {{label:Settings.Drawing.Red}}, Alt para {{label:Settings.Drawing.Blue}}, Mayús+Alt para {{label:Settings.Drawing.Yellow}}, Ctrl (Cmd en macOS) para {{label:Settings.Drawing.Orange}} y Ctrl+Alt (Cmd+Alt en macOS) para {{label:Settings.Drawing.Cyan}}. Consulta la lista completa de dibujo en [[settings-category:keybinds]].

La pestaña {{label:Board.Tabs.Info}} muestra las cabeceras de la partida, el FEN, el texto PGN y estadísticas del árbol, y te permite cambiar entre partidas en un archivo PGN con varias partidas.

Para organizar el tablero de análisis, arrastra una pestaña de panel ({{label:Board.Tabs.Analysis}}, {{label:Board.Analysis.Report}}, {{label:Board.Tabs.Database}}, {{label:Board.Tabs.Annotate}}, {{label:Board.Tabs.Coach}} o {{label:Board.Tabs.Info}}) o el asa de seis puntos de una tarjeta de motor o usa los botones de agarre de la barra de pestañas, la cabecera de la notación o la cabecera de un área de panel para colocar áreas al lado, encima o debajo de otra área con vista previa o con el teclado. Para que un panel abarque dos áreas (por ejemplo, {{label:Board.Tabs.Database}} sobre la notación y las pestañas), coloca primero el panel encima de una de ellas y después mueve la otra a su lado. Usa {{label:Board.Area.ReturnToTabs}} (o {{label:Board.Area.ReturnToEngines}} para una ventana de motor) o arrastra el área sobre la lista de pestañas para devolverla.

Las pestañas de repertorio, partida y preparación contra rivales mantienen cada una su propio diseño activo. Se incluyen tres diseños predefinidos ({{label:Board.Layout.Preset.Repertoire}}, {{label:Board.Layout.Preset.GameReview}} y {{label:Board.Layout.Preset.Preparation}}), y puedes guardar tus propios diseños, cambiar entre ellos o renombrar y eliminar diseños guardados desde {{label:Board.Action.More}} ({{label:Board.Layout.SaveAs}} y {{label:Board.Layout.Manage}}) o desde {{label:Menu.View}} ({{label:Board.Layout.SaveAs}} y {{label:Board.Layout.LayoutsMenu}}). Usa [[setting:board-layout]] ({{label:Settings.BoardLayout.Reset}}) para restaurar los diseños predefinidos de los tres tipos de pestaña conservando tus diseños guardados.

Para ocultar las pestañas, por ejemplo cuando cada panel que usas se muestra como su propia zona, haz clic en {{label:Board.Area.HideTabs}} debajo del asa al final de la barra de pestañas; las zonas vecinas ocupan su espacio. Las pestañas conservan su posición y tamaño: vuelve a mostrarlas con el botón {{label:Board.Arrange.ShowTabs}} que aparece en el encabezado de la notación mientras están ocultas, con un atajo de pestaña o al generar el informe. Un panel que devuelves mientras las pestañas están ocultas pasa a las pestañas ocultas. Mientras las pestañas están ocultas, {{label:Board.Arrange.ShowTabs}} también aparece en {{label:Board.Action.More}} y en {{label:Menu.View}}.
