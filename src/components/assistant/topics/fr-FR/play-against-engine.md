---
id: play-against-engine
title: Jouer contre un moteur
summary: Configurez une partie contre un moteur local ou un autre joueur humain, réglez les cadences et livres d’ouvertures et jouez depuis n’importe quelle position.
source: 7c75f4b49a6bdf2c
---

Pour démarrer une partie, ouvrez [[page:new-tab]] et cliquez sur {{label:Home.Card.PlayChess.Button}}. Vous pouvez aussi jouer à partir de n’importe quelle position sur un échiquier d’analyse en cliquant sur {{label:Board.Action.PlayFromHere}} dans la barre d’outils de l’échiquier ou en faisant un clic droit sur un coup dans la notation.

Avant de lancer la partie :
- Pour chaque camp, choisissez {{label:Board.Opponent.Human}} (avec un nom) ou {{label:Common.Engine}} (sélectionnez un moteur installé depuis [[page:engines]] et ajustez ses options UCI pour cette partie).
- Cliquez sur {{label:Board.Action.ChangeColors}} pour inverser les Blancs et les Noirs.
- Sous {{label:Board.Opponent.TimeSettings}}, choisissez {{label:GoMode.Time}} (avec {{label:GoMode.Time}} et {{label:Board.Opponent.Increment}}) ou {{label:Board.Opponent.Unlimited}}. Cochez {{label:Board.Opponent.SameTimeControl}} pour appliquer la même pendule aux deux camps.
- Cochez éventuellement {{label:Board.Opponent.EnableOpeningBook}}, choisissez un {{label:Board.Opponent.OpeningBookFile}} et définissez {{label:Board.Opponent.OpeningBookMaxPlies}}.
- Utilisez {{label:Board.Action.EditPosition}} dans la barre d’outils de l’échiquier avant de commencer si vous souhaitez jouer à partir d’une position personnalisée.
- Cliquez sur {{label:Board.Opponent.StartGame}} pour commencer.

Pendant une partie :
- Les coups anticipés (premoves) sont activés lorsque vous jouez en tant qu’humain contre un moteur.
- Utilisez {{label:Board.Action.TakeBack}} dans la barre d’outils de l’échiquier pour annuler votre dernier coup.
- Cliquez sur {{label:Board.Opponent.Resign}} (ou {{label:Board.Opponent.Abort}} dans un match moteur contre moteur) pour mettre fin à la partie.
- Cliquez sur {{label:Board.Analysis.Analyze}} à tout moment pour passer l’onglet en mode analyse, ou sur {{label:Board.Analysis.Logs}} pour consulter les journaux du moteur.
- Une fois la partie terminée, cliquez sur {{label:Home.NewGame}} pour configurer une nouvelle partie.
