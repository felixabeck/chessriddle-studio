---
id: analysis-board
title: Tablica analizy, warianty, komentarze i strzałki
summary: Wprowadzaj ruchy, edytuj pozycje, zarządzaj wariantami, pisz komentarze, dodawaj adnotacje i rysuj strzałki na szachownicy.
source: 2b161f5c0298e17a
---

Otwórz tablicę analizy z [[page:new-tab]], klikając {{label:Home.Card.AnalysisBoard.Title}}, albo otwierając zapisaną partię lub repertuar z [[page:library]].

Wykonuj ruchy przez przeciąganie lub klikanie bierek (konfigurowane w [[setting:move-method]]). Możesz też włączyć [[setting:text-input]] ({{label:Settings.Inputs.TextInput}}), aby wpisywać ruchy w notacji SAN. Użyj przycisków nawigacji ruchów pod notacją, klawiszy strzałek lub kółka myszy (jeśli [[setting:scroll-moves]] jest włączone), aby przeglądać ruchy.

Górny pasek nad szachownicą udostępnia akcje szachownicy:
- {{label:Board.Action.PlayFromHere}}: rozpocznij partię od bieżącej pozycji.
- Odwróć szachownicę (`F`): zamień Białe i Czarne na dole szachownicy.
- Zapisz: pojawia się, gdy partia ma niezapisane zmiany, a automatyczny zapis jest wyłączony, niedostępny (np. w wersji roboczej) lub nie powiódł się.
- {{label:Board.Action.More}}: otwiera menu z opcjami {{label:Board.Database.Save}} (zapisz partię w pliku biblioteki lub w bazie danych), {{label:Board.Action.TakeSnapshot}} (zapisz obraz bieżącej szachownicy) i {{label:Board.Action.EditPosition}} (ustaw własną pozycję przez rozstawienie bierek lub edycję FEN).
- Cofanie, ponawianie oraz czyszczenie narysowanych strzałek i podświetleń (gdy [[setting:erase-drawables]] jest wyłączone) działają przez skróty klawiszowe w [[settings-category:keybinds]].

Zagranie innego ruchu z wcześniejszej pozycji tworzy wariant. Kliknij prawym przyciskiem myszy dowolny ruch w notacji, aby wybrać {{label:Menu.PromoteVariation}}, {{label:Menu.PromoteToMainLine}}, {{label:Menu.CopyVariationPGN}}, {{label:Menu.DeleteMove}}, {{label:Menu.DeleteVariation}}, {{label:Menu.DeleteMovesAfter}}, {{label:Board.Action.PlayFromHere}}, {{label:Notation.AddDiagram}} lub {{label:Notation.MarkGameEndHere}}. Użyj przycisku oka w nagłówku notacji dla {{label:Notation.HideMoves}}, a menu {{label:Notation.ViewOptions}}, aby przełączać {{label:Notation.TableView}}, {{label:Notation.ShowComments}}, {{label:Notation.ShowDiagrams}} i {{label:Notation.ShowVariations}}.

Aby oceniać ruchy i pisać komentarze, otwórz kartę {{label:Board.Tabs.Annotate}}. Kliknij symbol oceny ruchu (lub naciśnij klawisze od 1 do 6), aby przełączyć `!!`, `!`, `!?`, `?!`, `?` lub `??`, albo kliknij {{label:Annotate.ShowMore}}, aby zobaczyć symbole oceny pozycji. Poniżej symboli użyj edytora tekstu sformatowanego do pisania komentarzy i wstawiania diagramów szachownicy w treści.

Aby rysować strzałki i wyróżniać pola, przytrzymaj prawy przycisk myszy i przeciągnij po szachownicy (lub kliknij pole prawym przyciskiem, aby narysować okrąg). Przytrzymaj klawisze modyfikujące, aby zmienić kolor: Shift dla {{label:Settings.Drawing.Red}}, Alt dla {{label:Settings.Drawing.Blue}}, Shift+Alt dla {{label:Settings.Drawing.Yellow}}, Ctrl (Cmd na macOS) dla {{label:Settings.Drawing.Orange}} i Ctrl+Alt (Cmd+Alt na macOS) dla {{label:Settings.Drawing.Cyan}}. Pełną listę rysowania znajdziesz w [[settings-category:keybinds]].

Karta {{label:Board.Tabs.Info}} wyświetla nagłówki partii, FEN, tekst PGN oraz statystyki drzewa i pozwala przełączać się między partiami w pliku PGN zawierającym wiele partii.

Aby ułożyć obszary szachownicy analizy, przeciągnij kartę panelu ({{label:Board.Tabs.Analysis}}, {{label:Board.Analysis.Report}}, {{label:Board.Tabs.Database}}, {{label:Board.Tabs.Annotate}}, {{label:Board.Tabs.Coach}} lub {{label:Board.Tabs.Info}}) albo sześciopunktowy uchwyt karty silnika albo użyj uchwytów na pasku kart, w nagłówku notacji lub w nagłówku obszaru panelu, aby umieścić obszary obok, nad lub pod innym obszarem z podglądem albo za pomocą klawiatury. Aby rozciągnąć panel nad dwoma obszarami (na przykład {{label:Board.Tabs.Database}} nad notacją i kartami), najpierw umieść panel nad jednym z nich, a potem przenieś drugi obok. Użyj {{label:Board.Area.ReturnToTabs}} (lub {{label:Board.Area.ReturnToEngines}} dla okna silnika) albo przeciągnij obszar z powrotem na pasek kart, aby go przywrócić, oraz użyj [[setting:board-layout]] ({{label:Settings.BoardLayout.Reset}}), aby przywrócić domyślny układ.

Aby ukryć karty, na przykład gdy każdy używany panel jest wyświetlany jako osobny obszar, kliknij {{label:Board.Area.HideTabs}} pod uchwytem na końcu paska kart; sąsiednie obszary zajmą ich miejsce. Karty zachowują położenie i rozmiar: pokażesz je ponownie przyciskiem {{label:Board.Arrange.ShowTabs}}, który pojawia się w nagłówku notacji, gdy karty są ukryte, skrótem karty albo generując raport. Panel zwrócony, gdy karty są ukryte, trafia do ukrytych kart.
