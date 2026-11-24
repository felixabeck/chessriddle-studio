---
id: analysis-board
title: Tablica analizy, warianty, komentarze i strzałki
summary: Wprowadzaj ruchy, edytuj pozycje, zarządzaj wariantami, pisz komentarze, dodawaj adnotacje i rysuj strzałki na szachownicy.
source: 14ba83ba3068d6ed
---

Otwórz tablicę analizy z [[page:new-tab]], klikając {{label:Home.Card.AnalysisBoard.Title}}, albo otwierając zapisaną partię lub repertuar z [[page:library]].

Wykonuj ruchy przez przeciąganie lub klikanie bierek (konfigurowane w [[setting:move-method]]). Możesz też włączyć [[setting:text-input]] ({{label:Settings.Inputs.TextInput}}), aby wpisywać ruchy w notacji SAN. Użyj przycisków nawigacji ruchów pod notacją, klawiszy strzałek lub kółka myszy (jeśli [[setting:scroll-moves]] jest włączone), aby przeglądać ruchy.

Pasek narzędzi obok notacji udostępnia akcje szachownicy:
- {{label:Board.Action.TakeSnapshot}}: zapisz obraz bieżącej szachownicy.
- {{label:Board.Action.EditPosition}}: ustaw własną pozycję przez rozstawienie bierek lub edycję FEN.
- {{label:Board.Action.PlayFromHere}}: rozpocznij partię od bieżącej pozycji.
- {{label:Board.Action.ClearDrawings}}: usuń strzałki i podświetlenia pól (widoczne, gdy [[setting:erase-drawables]] jest wyłączone).
- {{label:Board.Database.Save}}: zapisz partię w pliku biblioteki lub w bazie danych.
- Przyciski cofania, ponawiania, zapisu i odwracania szachownicy.

Zagrania innego ruchu z wcześniejszej pozycji tworzy wariant. Kliknij prawym przyciskiem myszy dowolny ruch w notacji, aby wybrać {{label:Menu.PromoteVariation}}, {{label:Menu.PromoteToMainLine}}, {{label:Menu.CopyVariationPGN}}, {{label:Menu.DeleteMove}}, {{label:Board.Action.PlayFromHere}}, {{label:Notation.AddDiagram}} lub {{label:Notation.MarkGameEndHere}}. Użyj przycisków w nagłówku notacji, aby przełączać {{label:Notation.HideMoves}}, {{label:Notation.TableView}}, {{label:Notation.HideComments}}, {{label:Notation.HideDiagrams}} i {{label:Notation.HideVariations}}.

Aby oceniać ruchy i pisać komentarze, otwórz kartę {{label:Board.Tabs.Annotate}}. Kliknij symbol oceny ruchu (lub naciśnij klawisze od 1 do 6), aby przełączyć `!!`, `!`, `!?`, `?!`, `?` lub `??`, albo kliknij {{label:Annotate.ShowMore}}, aby zobaczyć symbole oceny pozycji. Poniżej symboli użyj edytora tekstu sformatowanego do pisania komentarzy i wstawiania diagramów szachownicy w treści.

Aby rysować strzałki i wyróżniać pola, przytrzymaj prawy przycisk myszy i przeciągnij po szachownicy (lub kliknij pole prawym przyciskiem, aby narysować okrąg). Przytrzymaj klawisze modyfikujące, aby zmienić kolor: Shift dla {{label:Settings.Drawing.Red}}, Alt dla {{label:Settings.Drawing.Blue}}, Shift+Alt dla {{label:Settings.Drawing.Yellow}}, Ctrl (Cmd na macOS) dla {{label:Settings.Drawing.Orange}} i Ctrl+Alt (Cmd+Alt na macOS) dla {{label:Settings.Drawing.Cyan}}. Pełną listę rysowania znajdziesz w [[settings-category:keybinds]].

Karta {{label:Board.Tabs.Info}} wyświetla nagłówki partii, FEN, tekst PGN oraz statystyki drzewa i pozwala przełączać się między partiami w pliku PGN zawierającym wiele partii.
