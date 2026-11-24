---
id: feedback
title: Feedback, logs, clearing saved data, and updates
summary: Send feedback, open application logs, reload or clear saved data, check app version info, and install updates.
---

Use [[feedback]] ({{label:Menu.Help.SendFeedback}}) to report a bug, suggest a feature, send praise, or share other feedback directly with the developer.

You can open the feedback form at any time from the {{label:Navigation.Feedback}} button in the navigation row or from {{label:Menu.Help}} -> {{label:Menu.Help.SendFeedback}}.

In the feedback form you can choose a type ({{label:Feedback.Type.Bug}}, {{label:Feedback.Type.Suggestion}}, {{label:Feedback.Type.Praise}}, or {{label:Feedback.Type.Other}}), write a message (10 to 5,000 characters), optionally enter an email address for a reply, and optionally attach a screenshot ({{label:Feedback.TakeScreenshot}}) or image ({{label:Feedback.ChooseImage}}). Your app version and operating system are included with the message.

When the Assistant prepares a feedback draft for you, clicking [[feedback]] opens the form prefilled with that draft. Nothing is sent until you review the text and click {{label:Feedback.Submit}}.

Troubleshooting tools live in [[settings-category:advanced]] ({{label:Settings.Advanced}}):
- **Logs**: open [[setting:open-logs]] ({{label:Menu.Help.OpenLogs}}) to open the folder containing the application log files.
- **Reload**: open [[setting:reload]] ({{label:Menu.View.Reload}}) to reload the application window.
- **Clear saved data**: open [[setting:clear-saved-data]] ({{label:Menu.Help.ClearSavedData}}) to reset saved settings and session data after confirmation. This does not delete your workspace PGN files or databases, and is blocked if practice data cannot be safely migrated.

**App version and updates**:
- Check the installed version, Tauri version, and operating system via {{label:Menu.Help}} -> {{label:Menu.Help.About}} (on macOS, under the application menu), or at the bottom of [[page:settings]].
- Studio checks for updates automatically after startup. When an update is available, a confirmation dialog asks whether to download and install it. If you have unsaved changes, the restart is deferred until you save or restart the app.
