---
paths:
  - "scripts/install-local*"
  - "src-tauri/tauri.conf.json"
  - "src-tauri/icons/**"
  - "src-tauri/linux/**"
  - "src-tauri/src/infra/appimage_handler.rs"
  - ".claude/skills/push/**"
---

# Desktop installation

> **Relevant when:** installing the desktop app, its desktop entry or launcher identity.

## Daily desktop app

The daily desktop app is **not** `src-tauri/target/release/chessriddle-studio`: the application-menu
entry runs `~/.local/opt/chessriddle-studio/current/bin/chessriddle-studio`, a versioned copy written only by
`scripts/install-local.sh` from a clean pushed tree, or as an explicitly marked UNREVIEWED install
(`scripts/install-local.sh:7-9`) (`VERSION` beside it names the commit; `$push` runs the install as
its last step on master). So `pnpm build`,
`verify:app` and a drain may overwrite `target/release` freely without changing what Felix is
using, and an install while the app is running takes effect only at the next launch. The
`bin/chessriddle-studio` + `lib/ChessRiddle Studio/` layout is what Tauri's `resource_dir()` requires outside a cargo
output directory; resources beside the binary are not found.

## Desktop entry and launcher identity

The installer owns exactly one desktop entry, `~/.local/share/applications/chessriddle-studio.desktop`,
and its basename is `mainBinaryName`, not `productName`. A GTK window takes its Wayland app id
from `argv[0]`, and Plasma matches a window to its pinned launcher by that id, so the entry, the
`StartupWMClass` and the launched binary must all carry the same string. The installer now deletes
any other desktop entry whose `Exec` points into the install root, so a binary rename inside one
root cannot leave a duplicate behind. A rename that also moves the install root (2026-11-06:
`~/.local/opt/chessfable` → `~/.local/opt/chessriddle-studio`) is not covered: the old entry
points into the old root and has to be removed once by hand on every machine. That
retirement covers only regular files it could have written itself: a **symlinked** entry belongs to
whoever installed it and is left alone, and the installer never touches Plasma's pinned-launcher
list. A rename therefore still leaves a pin naming the old id, which has to be repointed by hand or
through `panel-launcher-sync` in `~/Projekte/tuxedo-config`.

## Game-link scheme

`chessriddle-studio://` links (from `browser-extension/`) reach the app only through a registered
scheme, and the one source of the scheme name is `plugins.deep-link.desktop.schemes` in
`src-tauri/tauri.conf.json`. No plugin crate reads it: the bundler does (macOS `Info.plist`, NSIS
registry keys, the Linux `MimeType`), and `scripts/install-local.sh` does for its one entry
(`d-20261122-13`).

* **A Linux desktop entry needs `%u` on its `Exec` line.** Without a field code the launcher
  starts the app with no argument at all (measured 2026-11-22 with `gio launch`). The bundler's
  own template has none, so `deb` and `rpm` use `src-tauri/linux/desktop-entry.template`, and the
  AppImage is built from the `deb` template.
* The installer refreshes the applications directory's desktop database (best effort) and writes
  nothing else: it sets no default handler and never touches `mimeapps.list`.
* Each leg of `.github/workflows/release.yml` asserts the registration on its built artefact. A
  manual dispatch is the rehearsal for a change here.
* On Linux, a genuine AppImage run (`APPIMAGE` naming an existing regular file, `APPDIR` set, and
  the current executable inside `APPDIR`) registers a menu-hidden (`NoDisplay=true`) handler entry
  at `<data home>/applications/chessriddle-studio-appimage-handler.desktop` carrying
  `TryExec=<APPIMAGE>` and ownership key `X-ChessRiddle-Studio-AppImage-Handler=true`, only while
  no other active handler exists across the XDG data directories. Any start removes that owned
  entry when another active handler exists, and a non-AppImage start also removes it when its
  `TryExec` target is provably missing (`NotFound`); before another start, `TryExec` causes GIO to
  ignore a moved or deleted AppImage. It refreshes `update-desktop-database` best effort, never
  sets a default handler, and never reads or writes `mimeapps.list`. KDE resolves handlers through
  ksycoca rather than `mimeinfo.cache` (it watches the applications directories and honours
  `TryExec`, though end-to-end verification probes GIO only).
