---
id: feedback
title: Retours, journaux, effacement des données et mises à jour
summary: Envoyez un retour, ouvrez les journaux de l’application, rechargez ou effacez les données enregistrées, consultez la version et installez les mises à jour.
source: 8b0ca5aebb70e04f
---

Utilisez [[feedback]] ({{label:Menu.Help.SendFeedback}}) pour signaler un bug, proposer une fonctionnalité, envoyer un compliment ou transmettre tout autre retour directement au développeur.

Vous pouvez ouvrir le formulaire de retour à tout moment depuis le bouton {{label:Navigation.Feedback}} dans la barre de navigation ou via {{label:Menu.Help}} -> {{label:Menu.Help.SendFeedback}}.

Dans le formulaire, vous pouvez choisir une catégorie ({{label:Feedback.Type.Bug}}, {{label:Feedback.Type.Suggestion}}, {{label:Feedback.Type.Praise}} ou {{label:Feedback.Type.Other}}), rédiger un message (de 10 à 5 000 caractères), saisir éventuellement une adresse e-mail pour recevoir une réponse et joindre en option une capture d’écran ({{label:Feedback.TakeScreenshot}}) ou une image ({{label:Feedback.ChooseImage}}). La version de l’application et votre système d’exploitation sont transmis avec le message.

Lorsque l’Assistant prépare un brouillon de retour pour vous, cliquer sur [[feedback]] ouvre le formulaire prérempli avec ce brouillon. Rien n’est envoyé tant que vous n’avez pas relu le texte et cliqué sur {{label:Feedback.Submit}}.

Les outils de dépannage se trouvent dans [[settings-category:advanced]] ({{label:Settings.Advanced}}) :
- **Journaux** : ouvrez [[setting:open-logs]] ({{label:Menu.Help.OpenLogs}}) pour ouvrir le dossier contenant les fichiers journaux de l’application.
- **Recharger** : ouvrez [[setting:reload]] ({{label:Menu.View.Reload}}) pour recharger la fenêtre de l’application.
- **Effacer les données enregistrées** : ouvrez [[setting:clear-saved-data]] ({{label:Menu.Help.ClearSavedData}}) pour réinitialiser les paramètres et données de session enregistrés après confirmation. Cela ne supprime pas vos fichiers PGN ni vos bases de données de l’espace de travail, et l’action est bloquée si les données d’entraînement ne peuvent pas être migrées en toute sécurité.

**Version de l’application et mises à jour** :
- Consultez la version installée, la version de Tauri et le système d’exploitation via {{label:Menu.Help}} -> {{label:Menu.Help.About}} (sur macOS, dans le menu de l’application) ou tout en bas de [[page:settings]].
- Studio recherche automatiquement les mises à jour après le démarrage. Lorsqu’une mise à jour est disponible, une boîte de confirmation vous demande si vous souhaitez la télécharger et l’installer. Si vous avez des modifications non enregistrées, le redémarrage est différé jusqu’à ce que vous enregistriez ou redémarriez l’application.
