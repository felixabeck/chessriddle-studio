# Analyze in ChessRiddle Studio

A shared Manifest V3 extension for desktop Chrome/Chromium and Firefox. It adds an
**Analyze in ChessRiddle Studio** link inside the game controls of finished
Chess.com and Lichess games. A click opens the game in the locally installed
ChessRiddle Studio, in a new analysis tab. Nothing else is started.

Adapted from the En Croissant extension by Francisco Salgueiro (upstream commit
`1064ffc2b`, GPL-3.0).

## Build and test

There is no package manifest in this directory. Tests and build run from the
repository root, with the root install:

```sh
pnpm extension:test
pnpm extension:build
```

`extension:test` is a member of `pnpm gates:contract:check`, so it runs in every
push gate and in CI. `extension:build` writes to `browser-extension/dist/`
(ignored); `node browser-extension/scripts/build.mjs --out <directory>` writes
elsewhere.

- **Chrome:** open `chrome://extensions`, enable Developer mode, choose **Load
  unpacked**, and select `browser-extension/dist/chrome`.
- **Firefox (development):** open `about:debugging#/runtime/this-firefox`, choose
  **Load Temporary Add-on**, and select `dist/firefox/manifest.json`. Temporary
  installations are removed when Firefox exits.
- **Distribution:** upload `dist/chessriddle-studio-chrome-<version>.zip` to the
  Chrome Web Store and `dist/chessriddle-studio-firefox-<version>.zip` to Mozilla
  Add-ons for review and signing. Firefox requires signing for permanent
  installation. `manifest.json` contains the Firefox id
  `studio-link@chessriddle.com`; it must not change after the first release.
  Both packages use identical JavaScript and CSS; the Chrome package omits the
  Firefox metadata.

The packages contain only the manifest, the scripts and styles, the icons and the
license. ZIP timestamps are fixed, so builds are reproducible. The version lives
in `manifest.json` only.

## Behavior

| Interface                                                                | Availability                                                                                  |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| Chess.com `/game/live/ID`, `/game/daily/ID`, `/analysis/game/TYPE/ID`    | Historical game/analysis controls                                                             |
| Chess.com `/live/game/ID`, `/play/online/game/ID`, `/play/daily/game/ID` | After visible game completion                                                                 |
| Chess.com `/play/online`, `/play/daily`, `/live`                         | After completion, using `gameId` in the URL or an unambiguous game link in the end-of-game UI |
| Chess.com `/analysis?gameId=ID`                                          | Historical game controls; `gameType=daily` preserves daily games                              |
| Lichess `/GAMEID`, `/GAMEID/white`, `/GAMEID/black`, player links        | After a rendered terminal result, including historical analysis pages                         |

Lichess studies, puzzles, broadcasts, arbitrary FEN analysis, Chess.com events,
and games without a discoverable supported ID are intentionally excluded.
Ongoing games and ongoing Lichess analysis pages get no button. The extension
never opens the desktop app by itself.

Each site adapter uses several ordered control selectors and puts the link inside
the first visible match. Lichess uses its metal button styling and theme
variables; Chess.com uses its button classes with scoped secondary-button
styling. The ordinary anchor supports keyboard focus, Enter, and the browser's
external-protocol prompt. If no app launches, check that ChessRiddle Studio is
installed; browsers do not reliably expose whether an external application was
launched.

## The link contract

The link is exactly:

```text
chessriddle-studio://import?url=<encodeURIComponent(canonical HTTPS game URL)>
```

with one of two canonical game URLs:

```text
https://lichess.org/<8 letters or digits>
https://www.chess.com/game/<live|daily>/<up to 20 digits>
```

`link-contract.json` lists accepted links, URLs that must not produce a link, and
links the app must refuse. `tests/link-contract.node-test.mjs` proves the
extension's half; the parser test in `src-tauri/src/infra/game_link.rs` proves
the app's half. The app parses the link natively and refuses everything else, so
the extension is not a security boundary for the app. Change the contract file
first when the grammar changes.

The extension accepts only exact HTTPS site hosts and supported game routes;
credentials and nonstandard ports are rejected, the Lichess four-character player
secret is stripped, and a completion dialog cannot supply an off-site URL or an
ambiguous game. Activation rechecks the current route and UI synchronously and
ignores synthetic clicks.

A throttled MutationObserver handles result text changes, hidden dialogs, lazy
mounting and replaced controls. `popstate`, `hashchange`, visibility changes and
a one-second foreground timer cover navigation, including `pushState` and
`replaceState` in the page's separate JS world. Injection is idempotent, and
observers and timers stop on `pagehide` and resume on `pageshow`. No page-world
scripts are used.

## Privacy

No analytics, storage, cookies, remote code or network requests. See
[PRIVACY.md](PRIVACY.md) for the store submission text.

## Before each store release

The tests model the selector structures in the adapters with jsdom; they are not
live-site tests, and site markup changes independently of this repository.
Unknown markup fails closed: no button.

1. Finish a Chess.com live game, including a draw; test after dismissing the
   result modal, and test a rematch. Confirm no stale link remains during play.
2. Open Chess.com live and daily historical analysis; use next/previous game
   navigation, then Back/Forward. Confirm exactly one button targets that game.
3. Finish a Lichess game, open its analysis page, flip the board, and open a
   12-character player link. Confirm only the public 8-character ID reaches the
   app. Check an ongoing game as well.
4. With ChessRiddle Studio closed and already running, activate the button and
   accept the browser prompt. Verify the imported players, result and moves.
5. Run `npx web-ext lint --source-dir browser-extension/dist/firefox` and inspect
   Chrome's extension error panel.
