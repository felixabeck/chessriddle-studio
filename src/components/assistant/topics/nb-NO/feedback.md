---
id: feedback
title: Tilbakemelding, logger, fjerne lagrede data og oppdateringer
summary: Send tilbakemelding, åpne programlogger, last inn på nytt eller fjern lagrede data, sjekk appversjon og installer oppdateringer.
source: 8b0ca5aebb70e04f
---

Bruk [[feedback]] ({{label:Menu.Help.SendFeedback}}) til å melde fra om feil, foreslå funksjoner, sende ros eller dele andre tilbakemeldinger direkte med utvikleren.

Du kan åpne tilbakemeldingsskjemaet når som helst fra knappen {{label:Navigation.Feedback}} i navigasjonslinjen eller via {{label:Menu.Help}} -> {{label:Menu.Help.SendFeedback}}.

I tilbakemeldingsskjemaet kan du velge kategori ({{label:Feedback.Type.Bug}}, {{label:Feedback.Type.Suggestion}}, {{label:Feedback.Type.Praise}} eller {{label:Feedback.Type.Other}}), skrive en melding (10 til 5 000 tegn), eventuelt oppgi en e-postadresse for svar og eventuelt legge ved et skjermbilde ({{label:Feedback.TakeScreenshot}}) eller et bilde ({{label:Feedback.ChooseImage}}). Appversjonen og operativsystemet ditt sendes sammen med meldingen.

Når Assistant forbereder et utkast til tilbakemelding for deg, vil klikk på [[feedback]] åpne skjemaet ferdig utfylt med dette utkastet. Ingenting sendes før du har sett over teksten og klikket {{label:Feedback.Submit}}.

Feilsøkingsverktøy ligger under [[settings-category:advanced]] ({{label:Settings.Advanced}}):
- **Logger**: åpne [[setting:open-logs]] ({{label:Menu.Help.OpenLogs}}) for å åpne mappen som inneholder programmets loggfiler.
- **Last inn på nytt**: åpne [[setting:reload]] ({{label:Menu.View.Reload}}) for å laste programvinduet på nytt.
- **Fjern lagrede data**: åpne [[setting:clear-saved-data]] ({{label:Menu.Help.ClearSavedData}}) for å tilbakestille lagrede innstillinger og øktdata etter bekreftelse. Dette sletter ikke PGN-filene eller databasene i arbeidsområdet ditt, og blokkeres dersom treningsdata ikke kan overføres trygt.

**Appversjon og oppdateringer**:
- Kontroller installert versjon, Tauri-versjon og operativsystem via {{label:Menu.Help}} -> {{label:Menu.Help.About}} (på macOS under programmenyen), eller nederst på [[page:settings]].
- Studio ser automatisk etter oppdateringer etter oppstart. Når en oppdatering er tilgjengelig, spør en bekreftelsesdialog om du vil laste den ned og installere den. Hvis du har ulagrede endringer, utsettes omstarten til du lagrer eller starter appen på nytt.
