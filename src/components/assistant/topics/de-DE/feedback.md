---
id: feedback
title: Feedback, Protokolle, gespeicherte Daten löschen und Updates
summary: Feedback senden, Anwendungsprotokolle öffnen, App neu laden oder gespeicherte Daten löschen, App-Version prüfen und Updates installieren.
source: 8b0ca5aebb70e04f
---

Nutze [[feedback]] ({{label:Menu.Help.SendFeedback}}), um Fehler zu melden, Funktionen vorzuschlagen, Lob auszusprechen oder sonstiges Feedback direkt an den Entwickler zu senden.

Du kannst das Feedback-Formular jederzeit über die Schaltfläche {{label:Navigation.Feedback}} in der Navigationsleiste oder über {{label:Menu.Help}} -> {{label:Menu.Help.SendFeedback}} öffnen.

Im Feedback-Formular kannst du eine Kategorie wählen ({{label:Feedback.Type.Bug}}, {{label:Feedback.Type.Suggestion}}, {{label:Feedback.Type.Praise}} oder {{label:Feedback.Type.Other}}), eine Nachricht schreiben (10 bis 5.000 Zeichen), optional eine E-Mail-Adresse für eine Antwort angeben und optional ein Bildschirmfoto ({{label:Feedback.TakeScreenshot}}) oder ein Bild ({{label:Feedback.ChooseImage}}) anhängen. Deine App-Version und dein Betriebssystem werden mit der Nachricht gesendet.

Wenn der Assistant einen Feedback-Entwurf für dich vorbereitet, öffnet ein Klick auf [[feedback]] das Formular mit diesem vorausgefüllten Entwurf. Es wird erst etwas gesendet, wenn du den Text geprüft und auf {{label:Feedback.Submit}} geklickt hast.

Werkzeuge zur Fehlerbehebung findest du unter [[settings-category:advanced]] ({{label:Settings.Advanced}}):
- **Protokolle**: Öffne [[setting:open-logs]] ({{label:Menu.Help.OpenLogs}}), um den Ordner mit den Anwendungsprotokollen zu öffnen.
- **Neu laden**: Öffne [[setting:reload]] ({{label:Menu.View.Reload}}), um das Anwendungsfenster neu zu laden.
- **Gespeicherte Daten löschen**: Öffne [[setting:clear-saved-data]] ({{label:Menu.Help.ClearSavedData}}), um gespeicherte Einstellungen und Sitzungsdaten nach Bestätigung zurückzusetzen. Deine Workspace-PGN-Dateien und Datenbanken bleiben erhalten; die Aktion wird blockiert, falls Übungsdaten nicht sicher migriert werden können.

**App-Version und Updates**:
- Prüfe die installierte Version, die Tauri-Version und das Betriebssystem über {{label:Menu.Help}} -> {{label:Menu.Help.About}} (unter macOS im Anwendungsmenü) oder ganz unten unter [[page:settings]].
- Studio sucht nach dem Start automatisch nach Updates. Sobald ein Update verfügbar ist, fragt ein Bestätigungsdialog, ob es heruntergeladen und installiert werden soll. Bei ungesicherten Änderungen wird der Neustart aufgeschoben, bis du speicherst oder die App neu startest.
