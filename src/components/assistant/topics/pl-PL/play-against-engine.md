---
id: play-against-engine
title: Gra przeciwko silnikowi
summary: Skonfiguruj partię przeciwko lokalnemu silnikowi lub innemu graczowi, ustaw kontrolę czasu oraz księgę debiutów i graj od dowolnej pozycji.
source: 7c75f4b49a6bdf2c
---

Aby rozpocząć partię, otwórz [[page:new-tab]] i kliknij {{label:Home.Card.PlayChess.Button}}. Możesz też zagrać od dowolnej pozycji na tablicy analizy, klikając {{label:Board.Action.PlayFromHere}} na pasku narzędzi szachownicy lub klikając prawym przyciskiem ruch w notacji.

Przed rozpoczęciem partii:
- Dla każdej ze stron wybierz {{label:Board.Opponent.Human}} (z nazwą) lub {{label:Common.Engine}} (wskaż zainstalowany silnik z [[page:engines]] i dostosuj jego opcje UCI dla tej partii).
- Kliknij {{label:Board.Action.ChangeColors}}, aby zamienić Białe i Czarne.
- W sekcji {{label:Board.Opponent.TimeSettings}} wybierz {{label:GoMode.Time}} (z {{label:GoMode.Time}} i {{label:Board.Opponent.Increment}}) albo {{label:Board.Opponent.Unlimited}}. Zaznacz {{label:Board.Opponent.SameTimeControl}}, aby ustawić taki sam zegar dla obu stron.
- Opcjonalnie zaznacz {{label:Board.Opponent.EnableOpeningBook}}, wybierz {{label:Board.Opponent.OpeningBookFile}} i ustaw {{label:Board.Opponent.OpeningBookMaxPlies}}.
- Użyj {{label:Board.Action.EditPosition}} na pasku narzędzi szachownicy przed startem, jeśli chcesz zagrać z własnej pozycji.
- Kliknij {{label:Board.Opponent.StartGame}}, aby rozpocząć.

W trakcie partii:
- Ruchy z wyprzedzeniem (premoves) są włączone podczas gry człowieka przeciwko silnikowi.
- Użyj {{label:Board.Action.TakeBack}} na pasku narzędzi szachownicy, aby cofnąć swój ostatni ruch.
- Kliknij {{label:Board.Opponent.Resign}} (lub {{label:Board.Opponent.Abort}} w meczu silnik kontra silnik), aby zakończyć partię.
- Kliknij {{label:Board.Analysis.Analyze}} w dowolnym momencie, aby przełączyć kartę w tryb analizy, lub {{label:Board.Analysis.Logs}}, aby obejrzeć dzienniki silnika.
- Po zakończeniu partii kliknij {{label:Home.NewGame}}, aby ustawić kolejną partię.
