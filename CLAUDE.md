# ChessRiddle Studio — project context

Chess GUI: Tauri v2 desktop shell (Rust) + React/TypeScript renderer. **ChessRiddle Studio** is Felix's
fork of En Croissant (`origin` = `felixabeck/chessriddle-studio`, `upstream` = the original project).
Foreign upstream changes are never rewritten casually. En Croissant is the upstream name, not this
project's name.

## Layout

| Path | What lives there |
| --- | --- |
| `src-tauri/src/` | Rust: commands, engine supervision, SQLite/Diesel database, PGN parsing, OAuth |
| `src/` | React renderer: components, state, utils |
| `DESIGN.md` | ChessRiddle design source, semantic tokens, controls, typography and board defaults |
| `src/bindings/generated.ts` | **Generated** by Specta from the Rust command/event registry — never hand-edited |
| `src/platform/` | The renderer's only sanctioned door to Tauri (`tauri.ts`, `native.ts`, `errors.ts`) |
| `src/state/` | Jotai atoms + per-tab zustand tree stores with `sessionStorage` persistence |
| `e2e/` | Playwright specs with committed snapshots |
| `scripts/` | Repo-local gate checkers (`check-bindings.mjs`, `check-tauri-command-boundary.mjs`, `check-ui-boundaries.mjs`, coverage and bundle reporters) |
| `docs/` | `coverage.md`, `bundle-budgets.md`, `localization.md`, `signed-download-manifests.md`, `context/RULE-HISTORY.md` (on-demand history), `context/PRODUCT-DECISIONS.md` (product-decision precedent) |
| `tasks/` | `findings.md` (deferred-findings ledger), `decisions.md`; driven by `scripts/findings.py` |

`CHESS_LOGIC_MAP.md` describes the engine/database/streaming architecture.

## Domain rules — `.claude/rules/*.md` (MANDATORY, all agents)

`.claude/rules/*.md` carry the mandatory write-time invariants of this codebase.

| File | Read before working on | Loads |
| --- | --- | --- |
| `async-resource-invariants.md` | any command, spawned process, subscription, or registry | **always** — it applies to nearly every diff, so it is deliberately not path-scoped |
| `chess-tree-semantics.md` | position comparison, move paths, move numbering, colour parity | `src/utils/{treeReducer,chess,chessops,repertoire}.ts`, `src/state/store/tree.ts`, `GameNotation.tsx`, `panels/practice/**`, `chess.rs`, `game.rs` |
| `engine-lifecycle.md` | spawning/killing engines, UCI info aggregation, cached options, result routing | `src-tauri/src/engine/**`, `chess.rs`, `components/engines/**`, `panels/analysis/**`, `EvalListener.tsx`, `src/utils/engines.ts` |
| `ipc-events.md` | any `#[tauri::command]`, emit, listen, progress report, or capability scope | `src-tauri/src/{main,progress}.rs`, `db/search.rs`, `src/platform/**`, `src/bindings/**`, `capabilities/**`, `tauri.conf.json` |
| `persisted-state.md` | anything written to session/local storage, persisted atoms, tab lifecycle | `src/state/**`, `src/hooks/**`, `src/utils/tabs.ts`, `src/components/tabs/**` |
| `pgn-scanning.md` | PGN boundaries, the byte-offset index, move encoding, search predicates, imports | `src-tauri/src/{pgn,lexer,opening,puzzle}.rs`, `db/**`, `ImportModal.tsx`, `src/utils/db.ts` |
| `gate-tooling.md` | running, changing or recovering a gate, including a gate command typed before any file is opened | `scripts/**`, `.github/workflows/**`, `package.json`, `pnpm-workspace.yaml`, `stryker.config.mjs`, `*coverage-*.json`, `bundle-budgets.json`, `.claude/skills/push/**`, `mutants.out/**` |
| `desktop-installation.md` | installing the desktop app, its desktop entry or launcher identity | `scripts/install-local*`, `src-tauri/tauri.conf.json`, `src-tauri/icons/**`, `.claude/skills/push/**` |

Claude Code loads the always rule and matching path rules automatically. Grok, agy and review
subagents open applicable rules before work. Rules bind regardless of delivery. Add a missing
matching glob to the rule rather than working around it. Interactive Grok reads the always rule
at session start and applicable rules before work or replies, leaves read their assigned rules.

## Workflow routing

Read `.claude/skills/push/SKILL.md` for gates, review-lens triggers, findings commands and coordination/worktree procedures.
Read `.claude/skills/verify-ui/SKILL.md` before visible-change verification, including UI prerequisites and proof limits.
Delegated leaves follow their supplied scope and never stage, commit, push or deploy.

## Findings ledger

Read `.claude/skills/push/SKILL.md` → Findings ledger for immediate filing, area vocabulary, vendor ownership and validation.

## Standing cautions

- **Do not restate an exact commit count or "in sync" here**.
- **Before attributing the next ratchet disagreement to the machine, check whether the
  divergent records are simply untested**. Note that `BRDA` block/branch identity is not stable
  across builds, so ~170 records routinely flip in each direction and cancel.
- **Never rewrite a baseline to clear a red ratchet** (`docs/coverage.md`). Baseline writes are
  protected by the `scripts/coverage-report.mjs` writer guard (`d-20260927-23`):
  `--instrument-change <d-id> --finding <f-id>` must name a decision in `tasks/decisions.md` whose
  `Governs:` line names the finding before any decrease or recorded scope/area-set change is
  accepted. The writer prints every per-area, per-metric delta.
- A gate is settled when the runner agrees with this machine, not when it passes here.
- The 2026-08-09 audit **has not been reviewed line by line**. What was proven at the time is
  that the gates then run were green — not that every change is right, and not that every gate is
  green today. Defects found while getting the gates green are listed in `BACKEND_AUDIT_PLAN.md`
  and `FRONTEND_AUDIT_PLAN.md`. Treat the rest of that diff as unreviewed.

## Conventions

- Rust talks to the renderer only through Specta-registered commands and events; a new event must be
  added to `collect_events!` in `src-tauri/src/main.rs`, not emitted by a bare string. No event is
  outside the registry today; the two incidents that got there — `search_progress` and
  `convert_progress` — are written up in `.claude/rules/ipc-events.md`.
- The renderer reaches native capability only through `src/platform/`.
- Filesystem and HTTP reach are declared in `src-tauri/capabilities/main.json` and
  `src-tauri/tauri.conf.json`; widening a scope is a security decision, not a build fix.
- User-facing strings go through i18next (`src/translation/`); `pnpm i18n:extract` after adding keys.
- Formatting and linting are `oxfmt` / `oxlint` (`pnpm format`, `pnpm lint:fix`), not Prettier/ESLint.

- Generated bindings are proven by `pnpm bindings:check`. Regenerate with `pnpm bindings:generate`, never hand-edit `src/bindings/generated.ts`.
- Coverage floors and bundle budgets are ratchets. Never lower a floor or rewrite a baseline to accept a regression, see `docs/coverage.md` and `docs/bundle-budgets.md`.
- Preserve foreign work. Read `git status` and never overwrite, reformat, stage or commit another session's changes.
- Never read or search `.env*` files. `.env.example` is for structure only.
- Commit attribution and authority are in `.claude/skills/git/SKILL.md`, pushes follow the canonical push skill and never imply release or deployment.
