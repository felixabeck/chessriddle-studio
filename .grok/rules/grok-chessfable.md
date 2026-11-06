# Grok overlay — ChessRiddle Studio

Grok-only delta. Shared conventions live in `CLAUDE.md` and `AGENTS.md`.
Do not copy them here.

## Project MCP

This repo stays project-MCP-free. There is no Sentry, no Supabase, and no
documented web-devtools path. Do not add `[mcp_servers]` to
`.grok/config.toml`. User-wide `chrome-devtools` stays in `~/.grok`; it is
not this app's verifier.

## Verification

Chrome MCP cannot attach to the Tauri webview. `pnpm start-vite` plus a
browser is invalid layout evidence: Vite-only crashes in `TopBar.tsx`
(`getCurrentWebviewWindow()` at module scope) and stays blank.

- Gates: the commands in `.claude/skills/push/SKILL.md`.
- Visible UI: `pnpm test:e2e:container` (Playwright inside the pinned image, mocked native,
  preview `:4173`). Never the native `pnpm test:e2e` — the committed screenshots match what the
  container renders, so a host run fails on font antialiasing alone.
- Live product: `pnpm dev`. Felix looks at the Tauri window. The agent
  does not claim Chrome saw the product.

Follow `.claude/skills/verify-ui/SKILL.md`.
