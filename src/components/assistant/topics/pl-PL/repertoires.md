---
id: repertoires
title: Repertuary debiutowe
summary: Utwórz repertuar, importuj pliki PGN, buduj pokrycie względem bazy odniesienia, ćwicz z powtórkami interwałowymi oraz śledź otwarte warianty, transpozycje i oznaczenia do sprawdzenia.
source: db00ec0860d0fa31
---

Repertuary to pliki PGN typu Repertuar, które dodają do tablicy analizy kartę {{label:Board.Tabs.Practice}}.

Aby utworzyć repertuar, otwórz [[page:new-tab]] i kliknij {{label:Home.Card.NewRepertoire.Title}} (albo utwórz plik repertuaru w [[page:library]]). Wpisz {{label:Common.Name}}, wybierz {{label:Common.WHITE}} lub {{label:Common.BLACK}}, opcjonalnie wskaż lub wklej PGN w sekcji {{label:Home.Card.NewRepertoire.FromPgn}} i kliknij {{label:Common.Create}}. Możesz też zaimportować PGN w oknie {{label:Home.Card.ImportGame.Title}} z zaznaczoną opcją {{label:Import.SaveToCollection}} i typem pliku {{label:Files.FileType.Repertoire}}.

Buduj swój repertuar w {{label:Board.Tabs.Practice}} -> {{label:Board.Practice.Build}}:
- Kliknij {{label:Board.Practice.Build.ImportPgn}}, aby scalić plik PGN lub wklejone partie z otwartym repertuarem (działa z bazą odniesienia lub bez niej).
- Ustaw {{label:Databases.Settings.ReferenceDatabase}} w [[page:library]], aby kreator mógł pokazywać częstość ruchów i pokrycie.
- W pustym repertuarze możesz zacząć od jednego z wbudowanych szablonów {{label:Board.Practice.Build.Presets}} lub wprowadzić ruchy na szachownicy.
- Oznacz pozycję startową swojego repertuaru za pomocą {{label:Board.Practice.Build.SetAsStart}} (lub kliknij prawym przyciskiem ruch w notacji i wybierz {{label:Menu.MarkAsStart}}).
- Klikaj ruchy w {{label:Board.Practice.Build.OpponentMoves}} lub {{label:Board.Practice.Build.YourResponse}}, aby dodawać lub śledzić warianty. Użyj {{label:Board.Practice.Build.NextGap}} i {{label:Board.Practice.Build.BiggestGap}}, aby przechodzić do niepokrytych odpowiedzi przeciwnika powyżej minimalnej liczby partii ustawionej w [[setting:repertoire-depth]].

Ćwicz swój repertuar w {{label:Board.Tabs.Practice}} -> {{label:Board.Practice.Train}}:
- Kliknij {{label:Board.Practice.StartPractice}}, aby powtarzać zaległe i nowe pozycje metodą powtórek interwałowych, lub {{label:Board.Practice.PracticeFullRepertoire}}, aby przećwiczyć każdą pozycję z repertuaru.
- Zagraj przygotowany ruch na szachownicy. Jeśli utkniesz po błędnym ruchu, kliknij {{label:Board.Practice.ShowMove}}.
- Przeglądaj wszystkie karty przez {{label:Board.Practice.ShowAll}}, historię przez {{label:Board.Practice.ShowLogs}} albo wyzeruj postępy przyciskiem {{label:Common.Reset}}.
- Repertuary z kartami do powtórki pojawiają się także w {{label:Home.Library.Due}} na stronie [[page:new-tab]].
- Skonfiguruj ocenianie powtórek interwałowych i limity nowych kart w [[settings-category:repertoire]] ([[setting:practice-grading]], [[setting:practice-new-per-session]]).

W notacji na tablicy analizy:
- Odgałęzienie o długości zaledwie jednego ruchu ma przerywaną ramkę jako {{label:Notation.OpenVariation}}, co pomaga wychwycić niedokończone warianty. Naciśnij skrót {{label:Settings.Keybinds.Actions.NEXT_OPEN_VARIATION}}, aby przejść do kolejnego.
- Gdy pozycja występuje w innej gałęzi tego samego repertuaru, obok ruchu pojawia się ikona {{label:Notation.Transposition}}; kliknij ją, aby przeskoczyć do tamtej gałęzi.
- Gdy zaimportowany plik PGN zawiera inną odpowiedź po twojej stronie, zaimportowany ruch jest dopisywany jako wariant i oznaczany jako {{label:Notation.ReviewMove}}. Kliknij ruch prawym przyciskiem i wybierz {{label:Menu.MarkAsReviewed}}, aby usunąć oznaczenie.
