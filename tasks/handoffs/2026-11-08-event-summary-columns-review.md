# Review record: Event summary columns (2026-11-08)

Plan: tasks/plans/2026-11-08-event-summary-columns.md (ignored). This file is the durable record.

## Reviews

### Round 1 (plan-r1) — lenses: plan, minimalism, correctness, tests, error-handling, pgn-index, persisted-state, ipc-contract
Verdicts: plan REVISE, correctness REVISE, tests REVISE, error-handling APPROVED (1 should-fix), minimalism/pgn-index/persisted-state/ipc-contract APPROVED (no findings).
- P1 [correctness#1 blocker] Same-year abbreviation drops a year-only end (`2016.08.01 – `). Disposition: Fix — O5 date display rule rewritten (year-only end shown in full). MANDATE: "Date (start, or range start–end)". Closure: correctness r2.
- P2 [error-handling#1 should-fix] Refresh failure semantics unspecified. Disposition: Fix — O2 failure semantics + O7 rollback test. Evidence: update_database_counts runs inside each write transaction (mod.rs:4279 callers). Closure: error-handling r2.
- P3 [plan#1 blocker] DTO with joined `site` breaks `ops.rs:39` storage consumer. Verified: `src-tauri/src/db/ops.rs:39` loads `events::table.first::<Event>()`. Disposition: Fix — O4 separates storage row and read DTO. Closure: plan r2. Authority: necessary to preserve the existing write-path consumer `create_event` (`src-tauri/src/db/ops.rs:39-41`) under the MANDATE's accepted "Store per-event summary fields" with a joined Site name in the list; not a new feature mechanism.
- P4 [plan#2 blocker, tests#1 blocker] No behavioral proof of the read contract. Disposition: Fix — O7 read-API production-query tests. Closure: plan r2, tests r2.
- P5 [plan#3 blocker] Phase 1 not independently type-valid (store sort schema). Verified `src/state/store/database.ts:205,213`. Disposition: Fix — O6 and minimal TournamentTable adaptation moved into Phase 1 with tsgo/vitest proof. Closure: plan r2.
- P6 [tests#2 should-fix] TournamentCard and panels GamesTable preset application unproven. Disposition: Fix — O7 rendered assertions per consumer + verify-ui surfaces. Closure: tests r2.

### Round 2 (plan-r2) — lenses: plan, correctness, tests, error-handling
Verdicts: correctness APPROVED (P1 CLOSED), error-handling APPROVED (P2 CLOSED), tests APPROVED (P4, P6 CLOSED), plan REVISE (P1–P4, P6 CLOSED; P5 NOT CLOSED).
- P5 (root P5) [plan r2 blocker] Phase 1 still leaves `databaseTableLocale.test.tsx` (Event fixture, ID header) to Phase 2. Verified file lines 148/203 per lens. Disposition: Fix — Phase 1 now owns every renderer source/test/e2e fixture constructing Event/TournamentSort or asserting the ID header; proof runs vitest related over all changed renderer paths. Closure: plan r3.
- P7 [plan r2#2 should-fix] P3's correction lacked an Authority line. Disposition: Fix — Authority added to P3. Closure: plan r3.

### Round 3 (plan-r3) — lens: plan
Verdict: APPROVED. P5 CLOSED, P7 CLOSED. All issues P1–P7 closed; plan review complete (3 rounds; adoptions r1=6 r2=2 r3=0).


## Diff review (executor: Codex leaves and Codex lenses, orchestrated and arbitrated by Claude Opus 5.5; same-context plan author arbitrated; reviewer and code author share the OpenAI family, disclosed)

### Round d1, range merge-base..794d7696 (correctness, root-cause, code-quality, tests, minimalism, error-handling, pgn-index, persisted-state, ipc-contract, records)
- F1 [code-quality should-fix] update_database_counts hides the event-summary refresh. Fix, 7fd9d9d1. CLOSED d2.
- F2 [correctness blocker] Self-play game produced two leaderboard rows in TournamentCard (pre-existing, touched component, rule 4b). Fix, 06894282, red-proved. CLOSED d2.
- F3 [minimalism should-fix] Duplicate canonical-schema validator. Fix, 7fd9d9d1. CLOSED d2.
- F4 [minimalism nit] Repeated tournament fixtures. Fix, 06894282. CLOSED d2.
- F5 [tests should-fix] Merge test proved neither refresh nor lower PlayerCount. Fix, 7fd9d9d1, red-proved by removing WhiteID/BlackID from the trigger. CLOSED d2.
- F6 [tests should-fix] No unequal site frequency case. Fix, 7fd9d9d1, red-proved. CLOSED d2.
Other lenses APPROVED without findings. Records lens APPROVED; it could not run findings.py check in its read-only sandbox.

### Round d2, closure over 794d7696..06894282 (code-quality, minimalism, correctness, tests)
All APPROVED; F1-F6 CLOSED. diff_adopted_per_round: r1=6 r2=0.

### Repair after real-data verification (orchestrator finding)
- F7 Date sort desc ordered recurring events by their first date; 13,395 of 70,038 Mega events span more than one calendar year. Date desc now uses EndDate, asc keeps StartDate; red-proved. This amends plan O4 (Date sorts by StartDate). Reviewed in closure round d3.

## Verification
- Mega benchmark, release profile, copy of Mega Database 2025 (11,441,614 games, 70,039 events, schema 2.2.0): migration plus acquisition 23.55 s at load average about 42; sum(GameCount) over events equals games with EventID != 0; dirty set empty. Queries: first page at most 62 ms, last page at most 207 ms on the clean run; one 352 ms last-page spike in the first run at load about 42.
- Real app (release binary, WebKitGTK, app-driver, profile seeded with a fresh 2.2.0 copy of Mega): library listed the database after 12.7 to 15.2 s including migration; Events default newest first, 1 - 25 / 70038, table fits its panel (959 px, no horizontal overflow); sorting by Players, Games, Avg Elo, Name and Date returned the expected first rows; event selection shows the Games card; Games and Players tabs render.
- pnpm test:e2e:container: first run 3 tests failed on 5 snapshots, each diff limited to the Plies header and cells (intended right alignment); pnpm test:e2e:update rewrote exactly those 5; 362 passed.
- One unreproduced Vitest unhandled error occurred in one related-tests run at load about 30 (5248 tests passed); the immediate rerun was fully green and the output of the failing run was not retained.
- Finding filed: f-20261108-05 (one-time migration wait on very large databases).
