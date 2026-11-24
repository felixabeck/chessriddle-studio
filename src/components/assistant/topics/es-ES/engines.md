---
id: engines
title: Motores de ajedrez y el panel de análisis
summary: Instala o añade motores locales y en la nube, configura opciones UCI y usa el análisis en vivo en el tablero.
source: e18a17e22622746d
---

Gestiona tus motores de ajedrez en [[page:engines]] ({{label:SideBar.Engines}}).

Para añadir un motor, haz clic en {{label:Common.AddNew}} en [[page:engines]] para abrir {{label:Engines.Add.Title}}:
- {{label:Common.Download}}: instala un motor preconfigurado (como Stockfish) desde el catálogo con {{label:Common.Install}}.
- {{label:Engines.Add.Cloud}}: añade motores de análisis en línea (ChessDB o Lichess Cloud) con {{label:Common.Add}}.
- {{label:Common.Local}}: registra un binario de motor UCI que ya tengas en tu ordenador.

Selecciona cualquier motor en [[page:engines]] para configurarlo. En los motores locales puedes editar los detalles generales, definir opciones UCI predeterminadas (como Threads, Hash y MultiPV), adjuntar archivos de recursos como tablas de finales Syzygy, hacer clic en {{label:Engines.Settings.Reset}} para restaurar los valores predeterminados, {{label:Common.Duplicate}} para copiar la configuración o {{label:Common.Remove}} para quitarlo. En los motores en la nube puedes editar el nombre y {{label:Engines.Settings.NumOfLines}}.

En el tablero de análisis, abre la pestaña {{label:Board.Tabs.Analysis}} y selecciona {{label:Board.Analysis.Engines}}:
- Haz clic en {{label:Board.Analysis.SelectEngines}} para elegir qué motores instalados se cargan en el panel, o en {{label:Board.Analysis.ManageEngines}} para ir a [[page:engines]].
- Haz clic en {{label:Board.Analysis.EnableEngine}} o {{label:Board.Analysis.DisableEngine}} en la tarjeta de un motor para iniciar o pausar el análisis, o usa {{label:Board.Analysis.EnableAllEngines}} cuando haya varios motores cargados.
- Haz clic en {{label:Board.Analysis.CheckThreat}} (o pulsa el atajo {{label:Settings.Keybinds.Actions.TOGGLE_THREAT_MODE}}) para analizar la amenaza del rival.
- Haz clic en {{label:Board.Analysis.Pin}} para fijar la barra de evaluación de un motor fuera de la pestaña, o en {{label:Board.Analysis.EngineSettings}} para ajustar opciones por pestaña como el límite de búsqueda y las líneas.
- Arrastra las tarjetas de motor desde {{label:Board.Analysis.ReorderEngine}} para cambiar su orden.
- Abre {{label:Board.Analysis.Logs}} dentro de {{label:Board.Tabs.Analysis}} para revisar la comunicación UCI del motor.

Controla las flechas del motor en el tablero con [[setting:arrows]] ({{label:Settings.Arrows}}). Los motores locales se guardan en la carpeta configurada en [[setting:engines-directory]].
