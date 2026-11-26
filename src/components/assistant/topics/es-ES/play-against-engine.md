---
id: play-against-engine
title: Jugar contra un motor
summary: Configura una partida contra un motor local o contra otra persona, elige controles de tiempo y libros de aperturas, y juega desde cualquier posición.
source: 83458071f9a1e481
---

Para empezar una partida, abre [[page:new-tab]] y haz clic en {{label:Home.Card.PlayChess.Button}}. También puedes jugar desde cualquier posición en un tablero de análisis haciendo clic en {{label:Board.Action.PlayFromHere}} en la barra superior del tablero o haciendo clic derecho sobre una jugada en la notación.

Antes de iniciar la partida:
- Para cada bando, elige {{label:Board.Opponent.Human}} (con un nombre) o {{label:Common.Engine}} (selecciona un motor instalado de [[page:engines]] y ajusta sus opciones UCI para la partida).
- Haz clic en {{label:Board.Action.ChangeColors}} para intercambiar Blancas y Negras.
- En {{label:Board.Opponent.TimeSettings}}, elige {{label:GoMode.Time}} (con {{label:GoMode.Time}} e {{label:Board.Opponent.Increment}}) o {{label:Board.Opponent.Unlimited}}. Marca {{label:Board.Opponent.SameTimeControl}} para compartir la misma configuración de reloj en ambos bandos.
- Opcionalmente marca {{label:Board.Opponent.EnableOpeningBook}}, elige un {{label:Board.Opponent.OpeningBookFile}} y establece {{label:Board.Opponent.OpeningBookMaxPlies}}.
- Usa {{label:Board.Action.EditPosition}} en el menú {{label:Board.Action.More}} de la barra superior del tablero (o pulsa `E`) antes de empezar si quieres jugar desde una posición personalizada.
- Haz clic en {{label:Board.Opponent.StartGame}} para comenzar.

Durante una partida:
- Los movimientos anticipados (premoves) están activados cuando juegas como humano contra un motor.
- Usa {{label:Board.Action.TakeBack}} en la barra superior del tablero para deshacer tu última jugada.
- Haz clic en {{label:Board.Opponent.Resign}} (o {{label:Board.Opponent.Abort}} en un enfrentamiento entre motores) para terminar la partida.
- Haz clic en {{label:Board.Analysis.Analyze}} en cualquier momento para pasar la pestaña al modo de análisis, o en {{label:Board.Analysis.Logs}} para consultar los registros del motor.
- Cuando termine una partida, haz clic en {{label:Home.NewGame}} para configurar otra partida.
