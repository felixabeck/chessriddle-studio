---
id: ai-connections
title: Coach et connexions IA
summary: Connectez un fournisseur d’IA ou un modèle local pour activer le Coach sur l’échiquier d’analyse ainsi que l’Assistant.
source: db8abb1b23f8812c
---

Les connexions IA alimentent à la fois le Coach (sur l’échiquier d’analyse) et l’Assistant. Gérez vos connexions dans [[settings-category:coach]] ({{label:Settings.AI}}).

Pour ajouter une connexion, choisissez l’une de ces options dans [[settings-category:coach]] :
- {{label:Settings.Coach.SignIn.ChatGpt}} : connectez-vous avec votre compte ChatGPT dans le navigateur.
- {{label:Settings.Coach.SignIn.Grok}} : connectez-vous à Grok à l’aide d’un code d’appareil (non officiel).
- {{label:Settings.Coach.Connections.Add}} : saisissez une adresse de base compatible OpenAI et une clé API facultative. Des préréglages sont disponibles pour OpenAI, Google Gemini, DeepSeek, Qwen, OpenRouter, Ollama et LM Studio.

Les clés et identifiants de session sont enregistrés dans le trousseau de clés du système de votre ordinateur. Dès qu’au moins une connexion est enregistrée, l’Assistant apparaît dans le menu {{label:Menu.Help}} ({{label:Menu.Help.Assistant}}) et dans la barre de navigation ({{label:Navigation.Assistant}}).

Le Coach et l’Assistant partagent la même connexion, le même modèle et le même niveau de raisonnement sélectionnés. Utilisez {{label:Settings.Coach.Connection.Check}} sur une connexion pour la vérifier et lister ses modèles disponibles, ou {{label:Settings.Coach.Connection.Remove}} pour la supprimer.

Pour utiliser le Coach sur l’échiquier d’analyse :
- Ouvrez l’onglet {{label:Board.Tabs.Coach}} (ou appuyez sur le raccourci {{label:Settings.Keybinds.Actions.COACH_TAB}}).
- Le Coach a besoin d’un moteur d’échecs local pour vérifier ses variantes d’analyse. Choisissez le moteur utilisé dans [[setting:coach-engine]] ({{label:Settings.Coach.Engine}}), ou installez un moteur depuis [[page:engines]] ({{label:SideBar.Engines}}).
- Posez des questions sur la position actuelle. Avant le premier message envoyé à une connexion, Studio affiche un avis indiquant ce qui est transmis (la position, le PGN de la partie en cours, l’analyse du moteur, les statistiques de coups de la base de données de référence si elle est sélectionnée, ainsi que les lignes correspondantes du répertoire).
- Les suites de coups dans les réponses du Coach peuvent être survolées ou cliquées pour les prévisualiser sur un mini-échiquier sans modifier la partie. Cliquez sur {{label:Coach.InsertLine}} à côté d’une ligne pour l’insérer comme variante.
