---
id: ai-connections
title: Coach y conexiones de IA
summary: Conecta un proveedor de IA o un modelo local para habilitar el Coach en el tablero de análisis y el Assistant.
source: eac73d15e14729e1
---

Las conexiones de IA dan soporte tanto al Coach (en el tablero de análisis) como al Assistant. Gestiona tus conexiones en [[settings-category:coach]] ({{label:Settings.AI}}).

Para añadir una conexión, elige una de estas opciones en [[settings-category:coach]]:
- {{label:Settings.Coach.SignIn.ChatGpt}}: inicia sesión con tu cuenta de ChatGPT en el navegador.
- {{label:Settings.Coach.SignIn.Grok}}: inicia sesión con Grok usando un código de dispositivo (no oficial).
- {{label:Settings.Coach.Connections.Add}}: introduce una dirección base compatible con OpenAI y una clave de API opcional. Hay ajustes predefinidos para OpenAI, Google Gemini, DeepSeek, Qwen, OpenRouter, Ollama y LM Studio.

Las claves y credenciales de inicio de sesión se guardan en el llavero del sistema de tu ordenador. Cuando haya al menos una conexión guardada, el Assistant aparecerá en el menú {{label:Menu.Help}} ({{label:Menu.Help.Assistant}}) y en la barra de navegación ({{label:Navigation.Assistant}}).

Elige la conexión, el modelo y el nivel de razonamiento en [[setting:coach-model]] ({{label:Settings.Coach.Model}}). Tanto el Coach como el Assistant responden con esa misma elección. El botón del modelo junto a {{label:Coach.Send}} en cualquiera de los dos paneles muestra qué modelo responde y cambia esa misma elección; {{label:Coach.NewConversation}} está justo al lado.

Usa {{label:Settings.Coach.Connection.Check}} en una conexión para comprobarla y listar sus modelos disponibles, o {{label:Settings.Coach.Connection.Remove}} para eliminarla.

Para usar el Coach en el tablero de análisis:
- Abre la pestaña {{label:Board.Tabs.Coach}} (o pulsa el atajo {{label:Settings.Keybinds.Actions.COACH_TAB}}).
- El Coach necesita un motor de ajedrez local para verificar sus líneas de análisis. Elige qué motor usa en [[setting:coach-engine]] ({{label:Settings.Coach.Engine}}) o instala uno en [[page:engines]] ({{label:SideBar.Engines}}).
- Haz preguntas sobre la posición actual. Antes del primer mensaje a una conexión, Studio muestra un aviso con lo que se envía (la posición, el PGN de la partida actual, el análisis del motor, las estadísticas de jugadas de la base de datos de referencia si hay una seleccionada y las líneas coincidentes del repertorio).
- Puedes pasar el cursor o hacer clic sobre las líneas de jugadas en las respuestas del Coach para previsualizarlas en un minitablero sin modificar la partida. Haz clic en {{label:Coach.InsertLine}} junto a una línea para insertarla como variante.
