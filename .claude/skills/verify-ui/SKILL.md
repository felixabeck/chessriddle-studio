---
name: verify-ui
description: Verify ChessRiddle Studio UI changes. Pixels are Playwright e2e; the real product is driven off-screen by `pnpm verify:app`; only native GTK chrome is left to Felix. Chrome MCP is never a valid verifier for this desktop app.
---

# Verify UI (ChessRiddle Studio)

This file is the source of truth. Codex follows
`.agents/skills/verify-ui/SKILL.md` after reading this contract.

TypeScript + vitest catch code correctness, not layout. Chrome MCP cannot
attach to the Tauri webview and never will: the window is WebKitGTK, which
speaks no Chrome DevTools Protocol. That is an engine difference, not a
configuration gap.

**It does not follow that only Felix can check the real product.** Until
2026-08-30 this file said "there is no documented remote-devtools path", and
that was wrong — Tauri documents WebDriver testing, and on Linux it drives the
real window through `WebKitWebDriver`. Nobody had tried it. `pnpm verify:app`
now does (proof 2 below).

## What counts as proof

1. **Automated visual matrix:** `pnpm test:e2e:container`. Playwright
   builds the renderer, serves preview on `http://127.0.0.1:4173`, and
   mocks native commands. That is the committed screenshot suite. Do not
   invent a second login or Tauri-mock driver.

   **Run it in the container, not natively.** `pnpm test:e2e` runs the same
   specs on the host, and the committed screenshots match what
   `mcr.microsoft.com/playwright:v<version>-noble` renders - measured
   2026-08-29, 8/8 green in the image with no snapshot rewritten. Natively on
   `tuxedo-atlas` the same specs fail on text rasterization alone - 47-680
   pixels differing along glyph edges, every box and control aligned to the
   pixel. That is not a layout regression and re-recording is not the fix;
   see `tasks/decisions.md`, `d-20260829-01`. `scripts/run-e2e-container.mjs`
   derives the image tag from the installed `@playwright/test` version, runs
   as the invoking user so nothing lands root-owned, and needs docker.

   Snapshots are re-recorded with `pnpm test:e2e:update`, which runs inside
   the same image — there is deliberately no script that re-records them on
   the host, and a direct `playwright ... --update-snapshots` is denied in the
   project settings, because host-rendered images would overwrite the
   canonical ones. The container form is open to every agent
   (`d-20260919-13`), under one rule that binds all of them:

   * Run `pnpm test:e2e:container` **first** and read every `*-diff.png` it
     writes. Re-record only when each moved snapshot differs solely where the
     change was meant to show. A difference anywhere else is a regression to
     fix, never evidence to refresh.
   * Predict which snapshots will move before re-recording, and stop if the
     run rewrites any other.
   * Name every moved snapshot in the commit message and in the report.
2. **The real application, driven:** `pnpm verify:app`. It starts an
   off-screen compositor (`kwin_wayland --virtual`), then `tauri-driver` ->
   `WebKitWebDriver` -> the release binary, and drives the actual product: real
   Rust backend, real IPC, real WebKitGTK. It runs the app under a throwaway
   `HOME`, because `tauri-plugin-window-state` persists geometry on exit and a
   headless run must not resize the window Felix uses. `scripts/app-driver.mjs`
   is the harness; the WebDriver wire protocol is JSON over HTTP, so it needs no
   npm dependency. `--screenshot <path>` writes a PNG of the page.

   **What it reaches:** anything in the page, plus process-level facts — that
   the app starts, answers script, exits through its own close control, and
   leaves no child behind.

   **What it cannot reach, permanently:** native GTK chrome. The menu bar, the
   window decorations and every file dialog are drawn by GTK, not by the page,
   and WebDriver only sees the page. `issue_engine_binary`
   (`src-tauri/src/main.rs`) always opens a native picker and takes no path
   argument, so **no engine can be registered from here** — any check that needs
   a live engine child is still Felix's.

   Prerequisites, both one-off and named in the failure message if missing:
   `sudo apt install webkit2gtk-driver` (must match the installed
   `libwebkit2gtk-4.1-0`), `cargo install tauri-driver --locked`, and
   GStreamer's `fakeaudiosink` (`sudo apt install gstreamer1.0-plugins-bad
   gstreamer1.0-tools`), which keeps the off-screen window's move sounds off
   the desktop's audio output. It needs
   `pnpm build` first, because it drives the release binary. Not a push gate:
   CI has no compositor and it wants a release build.
3. **Live product window:** `pnpm dev` opens the Tauri webview. This is still
   Felix's check, and still the only route for native menus, native dialogs and
   window chrome. Do not report the Tauri window as browser-verified.
4. **Invalid evidence:** `pnpm start-vite` on `http://localhost:1420`
   plus any Chrome MCP. Vite-only has no Tauri backend. `TopBar.tsx` calls
   `getCurrentWebviewWindow()` at module scope and crashes with
   `Cannot read properties of undefined (reading 'metadata')`. A blank
   page is not a layout check.

There is no authenticated local page. Do not invent a login driver. This
repo has no `scripts/dev-up.sh`.

## After a visible UI change

5. Run `pnpm test:e2e:container` (add `--project=<name>` for a single
   affected project; no `--` separator — the wrapper tolerates one, but this
   is the canonical form). Keep the snapshots. Missing snapshots are not
   evidence that layout is correct.
6. For responsive work, the committed matrix already includes 320px and
   200% font-scale. As of 2026-10-11, the clipped-heading finding
   `f-20260829-02` in `tasks/findings.md` is handled.
7. If the behaviour only exists in the real product — lifecycle, IPC, process
   teardown, anything the mocked container suite cannot answer — run
   `pnpm verify:app` and report what it asserted.
8. Only if the change can be judged nowhere but in native GTK chrome (menus,
   dialogs, decorations), start `pnpm dev` and name the window check as
   Felix's, not the agent's. That set is now much smaller than it was.

## Report

Name the commands and results, which snapshots moved, and whether a native GTK
check is still needed. Do not claim Chrome MCP verified the app, and do not
claim `pnpm verify:app` verified a menu, a dialog or a window decoration.

## Project UI prerequisites


`.claude/skills/verify-ui/SKILL.md` is the canonical contract (`.agents/skills/verify-ui/SKILL.md`
is its Codex bridge). **Read it before verifying any visible change.** Chrome MCP cannot attach to
the Tauri webview — the window is WebKitGTK and speaks no CDP — and `pnpm start-vite` plus a browser is not evidence,
because `TopBar.tsx` calls `getCurrentWebviewWindow()` at module scope and the page crashes without
a Tauri backend.

There are two automated proofs, answering different questions. `pnpm test:e2e:container` pins
renderer **pixels** in Chromium against a mocked IPC surface. `pnpm verify:app` pins **behaviour**
in the actual product: it drives the real window off-screen through `kwin_wayland --virtual` →
`tauri-driver` → `WebKitWebDriver` → the release binary, with the real Rust backend and real IPC
(`scripts/app-driver.mjs`). Use it for lifecycle, IPC and process-teardown claims. It needs
`webkit2gtk-driver` and `gstreamer1.0-plugins-bad` (apt) and `tauri-driver` (cargo), plus a
`pnpm build`, and is not a push gate.

What remains Felix's is now only **native GTK chrome** — menus, file dialogs, window decorations.
WebDriver sees the page, not the GTK widgets around it, and `issue_engine_binary` always opens a
native picker, so registering an engine (and therefore any check needing a live engine child)
cannot be automated this way.


## Other-agent UI verification


`.claude/skills/verify-ui/SKILL.md` is the canonical contract; `.agents/skills/verify-ui/SKILL.md`
is its bridge for you. **Read it before verifying any UI change.** Chrome MCP cannot attach to the
Tauri webview, and `pnpm start-vite` plus a browser is not evidence — `TopBar.tsx` calls
`getCurrentWebviewWindow()` at module scope and the page crashes without a Tauri backend. Automated
proof for pixels is `pnpm test:e2e:container`, which runs the suite inside the pinned Playwright
image so the committed screenshots do not depend on which machine recorded them. Never re-record
snapshots natively.

For behaviour in the real product, `pnpm verify:app` drives the actual Tauri window off-screen
through `tauri-driver` and `WebKitWebDriver` — real backend, real IPC, real WebKitGTK. Native GTK
chrome (menus, dialogs, decorations) is outside both and stays Felix's.

Historical verifier evidence lives in `docs/context/RULE-HISTORY.md`.
