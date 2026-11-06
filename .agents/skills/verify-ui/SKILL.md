---
name: verify-ui
description: Verify ChessRiddle Studio UI changes. Pixels are Playwright e2e; the real product is driven off-screen by `pnpm verify:app`; only native GTK chrome is left to Felix. Chrome MCP is never a valid verifier for this desktop app.
---

# verify-ui (Codex)

Read `.claude/skills/verify-ui/SKILL.md` first and follow that contract.
This file only names the Codex runtime: do not use in-app Browser or
chrome-devtools on `pnpm start-vite` as layout evidence.

Two commands, because these are the ones you will otherwise guess wrong:

* Pixels: `pnpm test:e2e:container`, never the native `pnpm test:e2e`.
* Real product behaviour: `pnpm verify:app`.

What each proves, what neither reaches, and why, is in the canonical file. Read
it rather than this line.
