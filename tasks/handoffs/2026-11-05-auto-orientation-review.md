# Review record — remembered board orientation and database-owner inference (2026-11-05)

Build run auto-orientation (Claude Code orchestrator, Codex executor, full auto). Plan: `tasks/plans/2026-11-05-auto-orientation.md` (ignored; this file is the durable record). Master commits 18cabb95..d7f93752. Decisions d-20261105-12, d-20261105-13; product decision in `docs/context/PRODUCT-DECISIONS.md` (2026-11-05, Games reopen from the remembered side).

## Plan review


### Round 1 (plan-r1) — lenses: plan, minimalism, correctness, error-handling, tests, chess-semantics, ipc-contract, persisted-state, pgn-index

Verdicts: plan REVISE, correctness REVISE, tests APPROVED (3 should-fix), others APPROVED.

- **I1** — Unknown player (ID 0) / missing Black names would satisfy the owner predicate.
  Witnesses: correctness r1 #1 (blocker 97), plan r1 #3 (should-fix 96). Verified:
  `src-tauri/src/db/mod.rs:417` maps a missing name to player 0, `create.sql:48` names it Unknown.
  Disposition: Fix (O5 excludes ID 0 and placeholder names). Status: open, closure r2.
- **I2** — Opening seeds from the cached list row; after a flip, reopening from a stale SWR row
  loses the orientation and seeds an obsolete stamp. Witness: plan r1 #1 (blocker 95). Verified:
  `GameTable.tsx:66` SWR rows passed to `openDatabaseGame`, `tabs.ts:611` seeds from that object.
  Disposition: Fix (O5 fetches the current row by ID at open). Status: open, closure r2.
- **I3** — Nullable binding breaks row-as-headers consumers (`GameCard.tsx:117/120`). Witness: plan
  r1 #2 (blocker 98). Disposition: Fix (O4 optional, not nullable; consumers listed). Status: open.
- **I4** — New e2e spec name matches no Playwright project. Witness: tests r1 #1 (100). Fix:
  extend an existing matched spec. Status: open.
- **I5** — No regression assertion for linked open and reload recovery. Witness: tests r1 #2 (94).
  Fix: O6 names both. Status: open.
- **I6** — Mocked IPC in e2e; no real renderer→database proof. Witness: tests r1 #3 (94). Fix:
  O6 adds a Rust test with the serializer's exact PGN and a `pnpm verify:app` real-app flip/
  reopen in step 7. Status: open.

### Round 2 (plan-r2) — lenses: plan, correctness, tests

Verdicts: correctness APPROVED (I1 CLOSED), tests APPROVED (I4, I5, I6 CLOSED), plan REVISE
(I1–I5 CLOSED; I6 NOT CLOSED, blocker 97: the scenario belongs in `scripts/verify-app.mjs`, which
`pnpm verify:app` runs, not in `scripts/app-driver.mjs`). Verified: `package.json:76`.
- I1–I5: CLOSED in r2.
- **I6** — correction r3: O6 and Phase 2 name `scripts/verify-app.mjs`. Status: open, closure r3.

### Round 3 (plan-r3) — lenses: plan, tests

Verdicts: plan APPROVED (I6 CLOSED), tests APPROVED (I6 CLOSED). All issues I1–I6 closed.
Adoptions per round: r1=6 r2=1 r3=0.

## Cumulative diff review

### Round d1 — 108cf9cf..8e29d0a0 excluding tasks/decisions.md (lenses: correctness, root-cause, tests, error-handling, code-quality, minimalism, chess-semantics, persisted-state, pgn-index, ipc-contract, all role sensitive; records lens mechanical over tasks/decisions.md)

Verdicts: minimalism REVISE; all others APPROVED (error-handling APPROVED with two should-fix).
- **E1** — `src/utils/tabs.ts:592` a game deleted after listing returned `null`, so Open game silently did nothing (error-handling #1, 98). Fix: typed `not-found` AppError with the new string `Databases.Game.NoLongerExists` in all 16 catalogues (bace8153). Closed d2 (error-handling). Revert probe: five tests fail with the fix reverted (two in `src/utils/databaseGame.test.ts`, three open gestures in `GameTable.test.tsx`).
- **E2** — inference failure log lacked game/database identity (error-handling #2, 92). Fix: message and context name `databaseHandleKey` and game id (bace8153). Closed d2.
- **M1** — `scripts/verify-app.mjs` duplicated the IPC invoke/unwrap helper four times (minimalism #1, 99). Fix: shared `invokeIpc` (d84d7741). Closed d2.
- **M2** — duplicated `clickButton` (minimalism #2, 99). Fix: one shared helper (d84d7741). Closed d2.

### Round d2 — closure over the two repair commits (error-handling, minimalism, correctness, root-cause)

All APPROVED; E1, E2, M1, M2 CLOSED. Root-cause asked for a failing-before measurement of E1; supplied by the revert probe above.

### Final gate repair and round d3

The first final `gates:push` failed e2e `e2e/game-references.spec.ts` (two citation tests): the scenario did not mock `get_db_game`, which every database open now calls first ("Unexpected Tauri IPC command: get_db_game"). Production is unaffected (the backend returns the row). Fix d7f93752 adds the mock; full container e2e 345 passed. Closure d3 (correctness, root-cause, tests) all APPROVED.

## Findings filed or closed by this run

- f-20261105-04 (filed): double-click opening of a newly selected database game can throw from a retired notation virtualizer (observed in the e2e double-click variant; orientation journeys use the Open game button).
- f-20261105-02 (closed): verify:app practice epoch drift, repaired in the verify-app scenario work.

## Proof

- Phase 1: `db::` 804 passed, bindings check, fmt, clippy green (own run).
- Phase 2: tsgo/lint/format, vitest related 4504 passed, container e2e, `pnpm verify:app` all checks passed incl. AO1–AO3 (own runs twice).
- Final: `pnpm gates:push -- --rust --frontend --bindings` all 13 lanes green on d7f93752's tree; `pnpm ci:remote:check` OK.

Plan authorship and arbitration shared one context (Claude Code); implementation and detection ran on Codex (OpenAI family).
