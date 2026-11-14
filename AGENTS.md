# ChessRiddle Studio — agent context

ChessRiddle Studio is Felix's fork of En Croissant, a Tauri v2 desktop chess GUI with a Rust backend and
React/TypeScript renderer. `origin` is `felixabeck/chessriddle-studio`, En Croissant names upstream.

Read `CLAUDE.md` first for the canonical layout, domain-rule routing and product invariants.
Grok and Antigravity (`agy`) do not auto-load `.claude/rules/*.md`, open applicable rules before working.
`async-resource-invariants.md` always applies to commands, processes, subscriptions and registries.
A rule binds whether or not it is already in context. Interactive Grok reads the always rule at
session start and applicable rules before work or replies, leaves read their assigned rules.

A delegated leaf never stages, commits, pushes or deploys. It follows the supplied assignment and
leaves permitted changes unstaged with proof.

Preserve foreign work and inspect `git status` yourself. Never overwrite or restage another
session's changes. Never read or search `.env*` files, `.env.example` is for structure only.

`src/bindings/generated.ts` belongs to Specta. Regenerate with `pnpm bindings:generate` and prove
it with `pnpm bindings:check`, never hand-edit it. Coverage floors and bundle budgets are ratchets,
never lower them to clear a red gate. Formatting and linting use `oxfmt` / `oxlint`. User-facing
strings go through i18next in `src/translation/`, then `pnpm i18n:extract`. Widening filesystem,
HTTP or CSP scope is a security decision, not a build fix.

Read `.claude/skills/push/SKILL.md` for gate mapping, review-lens triggers, findings recipes and
coordination/worktree procedures.
Read `.claude/skills/verify-ui/SKILL.md` before visible-change verification, including UI prerequisites
and proof limits.
