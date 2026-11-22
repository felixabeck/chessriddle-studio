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
| Chess.com `/game/live/ID`, `/game/daily/ID`, `/analysis/game/TYPE/ID` (also with a trailing `/analysis`) | Historical game/analysis controls |
| Chess.com `/live/game/ID`, `/play/online/game/ID`, `/play/daily/game/ID` | After visible game completion                                                                 |
| Chess.com `/play/online`, `/play/daily`, `/live`                         | After completion, using `gameId` in the URL or an unambiguous game link in the end-of-game UI |
| Chess.com `/analysis?gameId=ID`                                          | Historical game controls; `gameType=daily` preserves daily games                              |
| Lichess `/game/GAMEID` and the older `/GAMEID`, with `/white` or `/black`, player links | After a rendered terminal result, including historical analysis pages                         |

Lichess studies, puzzles, broadcasts, arbitrary FEN analysis, Chess.com events,
and games without a discoverable supported ID are intentionally excluded.
Ongoing games and ongoing Lichess analysis pages get no button. The extension
never opens the desktop app by itself.

Each site adapter uses several ordered control selectors and puts the link inside
the first visible match. The link carries no class of the host: a host button
class brings state rules along (on Chess.com's light theme the hover text colour
made the label unreadable). On Lichess it takes the theme variables, on Chess.com
its own colours for the dark and the light theme (`html.light-mode`), and on both
the Studio mark and a gold border on hover. The mark is `icons/48.png`, the one
file the manifest lets the two sites load. The ordinary anchor supports keyboard focus, Enter, and the browser's
external-protocol prompt. If no app launches, check that ChessRiddle Studio is
installed; browsers do not reliably expose whether an external application was
launched.

## Safari

Safari takes the same files as Chrome. A Safari web extension only exists inside a signed macOS
application, so it ships inside ChessRiddle Studio itself, as
`Contents/PlugIns/ChessRiddle Studio Extension.appex` (`com.chessriddle.studio.Extension`), signed
with the release's Developer ID and covered by the application's notarization (d-20261122-33).
There is no App Store listing and no second download.

- **Build:** `scripts/build-safari-appex.sh <output directory> <version>` runs on macOS with a
  full Xcode only (it refuses elsewhere). It builds the Chrome package, runs Apple's packaging
  tool, compiles the generated project's extension target for both architectures, signs the bundle
  with `safari/extension.entitlements` (application sandbox) and checks its own result. Nothing
  generated is committed.
- **Release:** the macOS legs of `.github/workflows/release.yml` build the bundle before the Rust
  build, embed it through `bundle.macOS.files`, and fail unless the application and the
  application inside the disk image carry exactly one signed, sandboxed, hardened extension of the
  application's team and version that the system lists as a Safari web extension. These steps are
  staged: they run only in a manual dispatch with `safari_extension` set, until such a rehearsal
  is green.
- **For a user:** open ChessRiddle Studio once, then in Safari choose Settings, Extensions, enable
  "Analyze in ChessRiddle Studio" and allow it on chess.com and lichess.org.

**Not observed:** nobody in the project has a Mac. Packaging, signing, embedding, notarization and
registration are proven on GitHub's macOS runners; that the button appears and works in Safari is
not. Apple documents this way of distribution, but developers have reported that Safari blocked
Developer ID-signed web extensions (Apple developer forum threads 667859 and 695373). The
release's last Safari step opens the application and Safari on the runner and prints
`SAFARI: BLOCK OBSERVED`, `SAFARI: no block observed` or `SAFARI: observation unavailable`; it
never fails a release. If Safari blocks the extension on users' Macs, the fallback is an App Store
container application built from the same files.

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
Unknown markup fails closed: no button. Both sites had changed between upstream's
version and 2026-11-22 (Lichess moved games to `/game/GAMEID`, Chess.com renamed
its end-of-game and review controls), so check the live pages before a release.
Lichess answers headless browsers with a challenge page; use a visible browser.

1. Finish a Chess.com live game, including a draw; test after dismissing the
   result modal, and test a rematch. Confirm no stale link remains during play.
2. Open Chess.com live and daily historical analysis; use next/previous game
   navigation, then Back/Forward. Confirm exactly one button targets that game.
3. Finish a Lichess game, open its analysis page, flip the board, and open a
   12-character player link. Confirm only the public 8-character ID reaches the
   app. Check an ongoing game as well.
4. With ChessRiddle Studio closed and already running, activate the button and
   accept the browser prompt. Verify the imported players, result and moves.
5. Hover the button in each site's light and dark theme. The label must stay
   readable and the Studio mark must show.
6. Run `npx web-ext lint --source-dir browser-extension/dist/firefox` and inspect
   Chrome's extension error panel.
