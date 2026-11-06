---
paths:
  - "scripts/install-local*"
  - "src-tauri/tauri.conf.json"
  - "src-tauri/icons/**"
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
any other desktop entry whose `Exec` points into the install root, so a future rename cannot leave
a duplicate behind. That
retirement covers only regular files it could have written itself: a **symlinked** entry belongs to
whoever installed it and is left alone, and the installer never touches Plasma's pinned-launcher
list. A rename therefore still leaves a pin naming the old id, which has to be repointed by hand or
through `panel-launcher-sync` in `~/Projekte/tuxedo-config`.
