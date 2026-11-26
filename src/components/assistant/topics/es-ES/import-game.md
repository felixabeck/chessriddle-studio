---
id: import-game
title: Importar una partida
summary: Importa una partida desde un archivo PGN, texto PGN pegado, una URL de Lichess o Chess.com, una posición FEN o fotos o escaneos PDF de una planilla manuscrita.
source: 2a3b47d982e0f514
---

Para importar una partida o posición, abre [[page:new-tab]] y haz clic en {{label:Home.Card.ImportGame.Button}} para abrir el diálogo {{label:Home.Card.ImportGame.Title}}. También puedes abrir un archivo PGN directamente desde {{label:Menu.File}} -> {{label:Menu.File.OpenFile}} (o con el atajo {{label:Settings.Keybinds.Actions.OPEN_FILE}}).

En el diálogo {{label:Home.Card.ImportGame.Title}}, elige una de las opciones:
- **PGN**: selecciona un {{label:Common.PGNFile}} de tu ordenador o pega el texto en {{label:Common.PGNGame}}. Marca {{label:Import.SaveToCollection}} para guardar una copia en tu carpeta de trabajo en [[page:library]], introduce un {{label:Common.Name}} y elige un {{label:Files.FileType}}.
- **{{label:Import.Online}}**: pega una {{label:Import.GameURL}} de Lichess o Chess.com para obtener la partida y abrirla en un tablero de análisis.
- **FEN**: pega una cadena FEN para abrir un tablero de análisis desde esa posición.
- **{{label:Import.FromPhoto}}** (cuando las funciones de IA están disponibles): transcribe de 1 a 4 fotos o páginas PDF de una planilla manuscrita en una partida nueva. Requiere al menos una conexión de IA en [[settings-category:coach]] ({{label:Settings.AI}}).

Para PGN, {{label:Import.Online}} y FEN, haz clic en {{label:Home.Card.ImportGame.Button}} para cargar la partida en la pestaña actual.

Para importar con **{{label:Import.FromPhoto}}**:
- Añade hasta 4 fotos JPEG, PNG o WebP o páginas PDF mediante {{label:Scoresheet.Intake.ChoosePhotos}}, {{label:Scoresheet.Intake.PasteFromClipboard}} (o Ctrl+V / Cmd+V con el panel abierto) o arrastrando y soltando las fotos o archivos PDF sobre el panel abierto. Pegar solo funciona con fotos. Cada página PDF cuenta como una foto; de un PDF más largo se usan las primeras páginas.
- Elige la conexión de IA y un modelo compatible con imágenes desde el botón del modelo o en [[setting:coach-model]] ({{label:Settings.Coach.Model}}).
- Haz clic en {{label:Scoresheet.Read.Button}} para empezar. Antes de la primera lectura en una conexión, {{label:Scoresheet.Notice.Title}} explica que las fotos seleccionadas (incluidos los nombres de los jugadores y cualquier otro texto de la planilla) se envían a ese proveedor, que los metadatos como la ubicación de la cámara se eliminan antes y que no se envía ningún otro dato.
- Studio comprueba cada jugada según las reglas del ajedrez estándar desde la posición inicial y abre la partida en una nueva pestaña de análisis sin guardar, con el panel {{label:Board.Tabs.Photo}} junto al tablero.
- Las jugadas dudosas o corregidas aparecen marcadas como inciertas en la notación. Recórrelas en el panel {{label:Board.Tabs.Photo}} y haz clic en {{label:Scoresheet.MarkAsChecked}} al verificar cada una. Si corriges una jugada intermedia o sigues tras una interrupción, haz clic en {{label:Scoresheet.ContinueWithSheet}} para reproducir las jugadas legales siguientes de la planilla. Cuando termines, haz clic en {{label:Scoresheet.FinishReview}} para quitar las marcas restantes.
- Guarda la partida en un archivo o base de datos con el flujo habitual ({{label:Menu.File}} -> {{label:Common.Save}}, el botón de guardar o {{label:Board.Database.Save}}).
- Las fotos solo se conservan en memoria (hasta 4 pestañas abiertas) y no se guardan en disco; tras recargar o reiniciar, la partida y sus marcas de revisión permanecen, y puedes usar {{label:Scoresheet.LoadPhotoAgain}} en el panel {{label:Board.Tabs.Photo}} para volver a ver la foto sin enviarla.
