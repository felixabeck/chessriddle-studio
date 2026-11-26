---
id: play-against-engine
title: Spille mot en computer
summary: Sett opp et parti mot en lokal computer eller et annet menneske, velg tidskontroll og åpningsbøker og spill fra hvilken som helst stilling.
source: 83458071f9a1e481
---

For å starte et parti åpner du [[page:new-tab]] og klikker {{label:Home.Card.PlayChess.Button}}. Du kan også spille fra hvilken som helst stilling på et analysebrett ved å klikke {{label:Board.Action.PlayFromHere}} i brettets topplinje eller høyreklikke et trekk i notasjonen.

Før partiet starter:
- For hver side velger du {{label:Board.Opponent.Human}} (med et navn) eller {{label:Common.Engine}} (velg en installert motor fra [[page:engines]] og juster UCI-valgene for partiet).
- Klikk {{label:Board.Action.ChangeColors}} for å bytte mellom hvit og svart.
- Under {{label:Board.Opponent.TimeSettings}} velger du {{label:GoMode.Time}} (med {{label:GoMode.Time}} og {{label:Board.Opponent.Increment}}) eller {{label:Board.Opponent.Unlimited}}. Kryss av for {{label:Board.Opponent.SameTimeControl}} for å bruke samme klokkeoppsett på begge sider.
- Kryss eventuelt av for {{label:Board.Opponent.EnableOpeningBook}}, velg en {{label:Board.Opponent.OpeningBookFile}} og angi {{label:Board.Opponent.OpeningBookMaxPlies}}.
- Bruk {{label:Board.Action.EditPosition}} i menyen {{label:Board.Action.More}} på brettets topplinje (eller trykk `E`) før start hvis du vil spille fra en egendefinert stilling.
- Klikk {{label:Board.Opponent.StartGame}} for å begynne.

Under et parti:
- Forhåndstrekk (premoves) er aktivert når du spiller som menneske mot en computer.
- Bruk {{label:Board.Action.TakeBack}} i brettets topplinje for å angre det siste trekket ditt.
- Klikk {{label:Board.Opponent.Resign}} (eller {{label:Board.Opponent.Abort}} i et computer-mot-computer-parti) for å avslutte partiet.
- Klikk {{label:Board.Analysis.Analyze}} når som helst for å bytte fanen til analysemodus, eller {{label:Board.Analysis.Logs}} for å se motorlogger.
- Når partiet er ferdig, klikker du {{label:Home.NewGame}} for å sette opp et nytt parti.
