---
id: browser-extension
title: Nettleserutvidelse og partilenker
summary: Åpne partier fra Lichess og Chess.com direkte i Studio med chessriddle-studio://-partilenker.
source: 7059f7f7afa1559d
---

ChessRiddle Studio håndterer `chessriddle-studio://`-partilenker sendt fra nettleserutvidelsen eller operativsystemet ditt.

Når en `chessriddle-studio://import?url=<game URL>`-lenke for et parti på Lichess eller Chess.com åpnes:
- Studio henter partiets PGN fra Lichess eller Chess.com.
- Partiet åpnes i en ny analysefane og bytter vinduet til brettet.
- Mens partiet lastes inn, viser et varsel fremdriften og melder fra om eventuelle feil hvis partiet ikke kan hentes.

På macOS og Windows registrerer installasjonsprogrammet URL-skjemaet `chessriddle-studio://` automatisk. I Linux AppImage-bygg registrerer Studio ved oppstart en skrivebordshåndterer for `chessriddle-studio://` slik at nettleseren kan sende lenker videre til appen.

Du kan også importere hvilken som helst parti-URL fra Lichess eller Chess.com manuelt uten utvidelsen ved å åpne [[page:new-tab]], klikke {{label:Home.Card.ImportGame.Button}}, velge {{label:Import.Online}} og lime inn {{label:Import.GameURL}}.
