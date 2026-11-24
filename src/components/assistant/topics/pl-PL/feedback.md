---
id: feedback
title: Opinie, dzienniki, czyszczenie zapisanych danych i aktualizacje
summary: Wyślij opinię, otwórz dzienniki aplikacji, przeładuj lub wyczyść zapisane dane, sprawdź wersję aplikacji i zainstaluj aktualizacje.
source: 8b0ca5aebb70e04f
---

Użyj [[feedback]] ({{label:Menu.Help.SendFeedback}}), aby zgłosić błąd, zasugerować funkcję, przesłać pochwałę lub podzielić się inną uwagą bezpośrednio z twórcą aplikacji.

Formularz opinii możesz otworzyć w dowolnym momencie przyciskiem {{label:Navigation.Feedback}} na pasku nawigacji lub przez {{label:Menu.Help}} -> {{label:Menu.Help.SendFeedback}}.

W formularzu możesz wybrać rodzaj zgłoszenia ({{label:Feedback.Type.Bug}}, {{label:Feedback.Type.Suggestion}}, {{label:Feedback.Type.Praise}} lub {{label:Feedback.Type.Other}}), wpisać wiadomość (od 10 do 5 000 znaków), opcjonalnie podać adres e-mail do odpowiedzi oraz opcjonalnie dołączyć zrzut ekranu ({{label:Feedback.TakeScreenshot}}) lub obraz ({{label:Feedback.ChooseImage}}). Wraz z wiadomością przesyłana jest wersja aplikacji oraz system operacyjny.

Gdy Assistant przygotuje dla Ciebie szkic opinii, kliknięcie [[feedback]] otwiera formularz wypełniony tym szkicem. Nic nie jest wysyłane, dopóki nie sprawdzisz treści i nie klikniesz {{label:Feedback.Submit}}.

Narzędzia diagnostyczne znajdują się w [[settings-category:advanced]] ({{label:Settings.Advanced}}):
- **Dzienniki**: otwórz [[setting:open-logs]] ({{label:Menu.Help.OpenLogs}}), aby otworzyć folder z plikami dzienników aplikacji.
- **Przeładuj**: otwórz [[setting:reload]] ({{label:Menu.View.Reload}}), aby przeładować okno aplikacji.
- **Wyczyść zapisane dane**: otwórz [[setting:clear-saved-data]] ({{label:Menu.Help.ClearSavedData}}), aby po potwierdzeniu zresetować zapisane ustawienia i dane sesji. Nie usuwa to plików PGN ani baz danych z obszaru roboczego i jest blokowane, jeśli danych ćwiczeń nie można bezpiecznie zmigrować.

**Wersja aplikacji i aktualizacje**:
- Sprawdź zainstalowaną wersję, wersję Tauri i system operacyjny przez {{label:Menu.Help}} -> {{label:Menu.Help.About}} (w systemie macOS w menu aplikacji) albo na samym dole [[page:settings]].
- Studio automatycznie sprawdza aktualizacje po uruchomieniu. Gdy dostępna jest aktualizacja, okno potwierdzenia pyta, czy ją pobrać i zainstalować. Jeśli masz niezapisane zmiany, ponowne uruchomienie zostaje odłożone do momentu zapisania lub restartu aplikacji.
