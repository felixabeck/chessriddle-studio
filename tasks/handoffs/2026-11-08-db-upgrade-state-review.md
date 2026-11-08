# Review record: f-20261108-04, database schema upgrade state (2026-11-08)

Build run in worktree `db-migration-lock-state`. Plan review ran on Grok (xAI) leaves, five rounds.
Grok's balance ran out (HTTP 402) before Phase 1 changed any file. Felix chose Codex for the rest, so
implementation and the cumulative diff review ran on Codex leaves, with a Claude Code orchestrator.
The diff lenses and the code author therefore share a model family. Plan-review adoption counts:
r1=18 r2=15 r3=8 r4=2 r5=0 (2 carried).

## Carried to diff review

- CR-1 (R5-1, plan#1 + tests#1): the O1 gateway-saturation test must occupy the permits of the
  gateway the job would actually use: under `cfg(test)` `BLOCKING_GATEWAY` is per-thread
  (`src-tauri/src/infra/blocking.rs:24-25`), so reuse the existing same-thread construct
  (`park_global_gateway_holders`, `global_gateway_retains_four_permits_on_the_awaiting_thread`,
  `blocking.rs:1372-1466`; making that helper reachable from `db` tests is the only permitted
  `blocking.rs` change) and show the test goes red if the job is moved onto
  `BLOCKING_GATEWAY.spawn_cancellable`.
- CR-2 (R5-2, plan#2): the `unavailable` route test pins the existing not_found-style proof: no
  games table is mounted and the transient/upgrade-failed message is shown.

## Reviews

### Round 1 (2026-11-08, 8 lenses on Grok: plan, minimalism, correctness, error-handling, tests, ipc-contract, persisted-state, pgn-index)

Verdicts: plan REVISE, minimalism APPROVED, correctness REVISE, error-handling REVISE, tests REVISE,
ipc-contract APPROVED, persisted-state REVISE, pgn-index NOT APPLICABLE / APPROVED.

- R1-1 (plan#1, correctness#1, error-handling#3): BUSY upgrade failure retained → stuck. Fix:
  O2 transient vs permanent classification.
- R1-2 (plan#2, correctness#2, error-handling#5, tests#1): new ErrorCategory unmapped in
  `errors.ts`, busy row unreachable. Fix: O3 `databaseBusy` payload flag + real-mapping test.
- R1-3 (plan#3, ipc-contract#2): e2e `get_db_info` stubs. Fix: Phase 1 files.
- R1-4 (plan#4, plan#5, correctness#6-8, error-handling#6, persisted-state#1): consumers missed
  (LibraryPage, Databases.tsx, AccountCard, gameReferences, databaseRoute/DatabaseView clearing
  persisted view). Fix: O4 consumer list and tests.
- R1-5 (plan#6): no hook to hold the upgrade. Fix: new test hook named in Phase 1.
- R1-6 (plan#7): db.ts edited in both phases. Fix: renderer contract moved wholly to Phase 1.
- R1-7 (plan#8, ipc-contract#3, ipc-contract#1, minimalism#1): union location / tag collision /
  extra busy variant. Fix: `status` tag on the native result, transient flag on the existing error
  member in `src/bindings/index.ts`.
- R1-8 (correctness#3): nested deferred transactions defeat IMMEDIATE. Fix: O1 ensure-current
  before callers' transactions, check-only inside.
- R1-9 (correctness#4): 30 s busy timeout on the probe. Fix: O2 ≤1 s read-only probe.
- R1-10 (correctness#5): empty file handling. Fix: O2 keeps the uninitialized refusal.
- R1-11 (error-handling#1): fail-open admission. Fix: O1/O2 admission errors returned.
- R1-12 (error-handling#2): failed upgrade UI. Fix: Decision "permanently failed upgrade keeps
  Delete"; transient never retained.
- R1-13 (error-handling#4): waiter outcome after failure. Fix: O1 waiter receives job outcome.
- R1-14 (error-handling nit#1): busy copy cause. Fix: neutral copy.
- R1-15 (error-handling nit#2): deletion waits. Fix: deletion cancels.
- R1-16 (tests#2): verify:app has no assertions. Fix: scratch driver with named assertions.
- R1-17 (tests#3): concurrent get_db_info one job. Fix: Phase 1 test.
- R1-18 (tests#4): IMMEDIATE revert test. Fix: Phase 1 BUSY-at-start test.

### Round 2 (2026-11-08, 7 lenses: plan, minimalism, correctness, error-handling, tests, ipc-contract, persisted-state)

All APPROVED. R1-1..R1-11, R1-13..R1-18 CLOSED by every witness. R1-12 NOT CLOSED (error-handling):
the r2 edit had accidentally deleted `## Decisions and trade-offs`. Fix: section restored, failure
classification spelled out (disk full transient). New issues, all Fix:
- R2-1 (plan#1, tests#2): ready path still 30 s on a foreign lock → O2 1 s bound on every read + duration test.
- R2-2 (plan#2): detail copy untested → Phase 2 test.
- R2-3 (plan#3): admission refusal untested → Phase 1 test.
- R2-4 (plan nit, error-handling R1-12): Decisions reference dangling → restored.
- R2-5 (error-handling#2): foreign write lock shows endless upgrading → BUSY job outcome reported once as busy.
- R2-6 (error-handling#3): waiter abort cancelling job → O1 waiter cancellation never cancels the job.
- R2-7 (error-handling#4): permanent failure retried by other entry points → O1 all entry points return it.
- R2-8 (error-handling#5): acquisition timeout / Error::Shared not flagged → O3 extended.
- R2-9 (error-handling#6): busy logged every tick → O3 no failure log for busy.
- R2-10 (error-handling#7): check-only refusal untyped → O1 Conflict + busy flag.
- R2-11 (tests#1): failed-job waiters → Phase 1 test.
- R2-12 (tests#3): AccountCard/gameReferences tests → Phase 2.
- R2-13 (tests nit): IMMEDIATE hold point → Phase 1.
- R2-14 (ipc-contract#1): Specta type and raw consumers (`scripts/verify-app.mjs`) → O2 named enum, Phase 1 files.
- R2-15 (persisted-state#1): reseed on ready → O4 no `setDatabase` for the held handle, test across transition.

### Round 3 (2026-11-08, 5 lenses: plan, error-handling, tests, ipc-contract, persisted-state)

error-handling APPROVED (R1-12, R2-5..R2-8, R2-10 CLOSED; R2-9 NOT CLOSED), tests APPROVED (R2-1,
R2-11, R2-13 CLOSED; R2-12 NOT CLOSED), persisted-state APPROVED (R2-15 CLOSED), ipc-contract
REVISE (R2-14 NOT CLOSED, blocker). All Fix:
- R2-9: busy still logged by `run_native_operation` → busy/upgrade-failed are `get_db_info` result variants, not errors.
- R2-12: AccountCard/gameReferences already handle error rows → O4 bullet reduced to a pinning test.
- R2-14: flatten does not export → newtype `Ready(DatabaseInfo)` internally tagged.
- R3-1 (error-handling#1, #2): disk full both transient and permanent → permanent.
- R3-2 (error-handling#3): permanent failure shown with corruption copy → `UpgradeFailed` variant, `upgradeFailed` row, own copy.
- R3-3 (error-handling#4, tests#2): leftover contradictory Phase 1 sentence → replaced.

Round-3 review-plan (REVISE): all R1/R2 IDs CLOSED. Its two blockers (disk full class; leftover
Phase 1 sentence) are R3-1 and R3-3, already fixed above in the same revision. New, Fix:
- R3-4 (plan#3): `Error::Shared` BUSY unflagged and untested → Phase 1 test names the Shared path.
- R3-5 (plan#4): waiters holding all four `BLOCKING_GATEWAY` permits deadlock a gateway-run job → O1 job runs outside the gateway, saturation test.

### Round 4 (2026-11-08, 4 lenses: plan, error-handling, tests, ipc-contract)

All APPROVED. R2-9, R2-12, R2-14, R3-1..R3-5 CLOSED. New, Fix:
- R4-1 (error-handling#1): `upgradeFailed` route clears the stored view → treated as `unavailable` like transient rows, test.
- R4-2 (tests#1): saturation test missing from the Phase 1 list → added.
- R4-3 (error-handling nit, ipc-contract nit): "both variants" stale → "all four"; arbiter-closed nit.

### Round 5 (2026-11-08, 3 lenses: plan, error-handling, tests)

All APPROVED. R4-1, R4-2 CLOSED. R5-1 (plan#1, tests#1: saturation test cannot go red on the
per-thread test gateway) and R5-2 (plan#2: unavailable route render untested) are test details
within unchanged O1/O4 obligations → Fix — carried to CR-1 and CR-2.

Plan review closed after round 5. Adoptions per round: r1=18 r2=15 r3=8 r4=2 r5=0 (2 carried).

## Cumulative diff review

Lenses, round 1 (Codex, base 17c14910): correctness, root-cause, tests, error-handling, minimalism,
code-quality, ipc-contract, persisted-state, pgn-index, tauri-security, platform-semantics, records.

Orchestrator inspection before the review found two regressions, fixed in Phase 1's second fix round:
`get_db_info` had lost the linked-collection resolve and refresh, and every `connection()` opened an
extra SQLite connection under the upgrade lock.

Adopted, all Fix, repaired in 7c252e3c (rebased hash may differ) and 2fa1c24b:
- correctness: legacy upgrade published Passed for a later file identity.
- tests: cooperative-only cancellation test; no pre-2.2.0 import or account-cursor test.
- error-handling: upgrade failure reported only "database failure"; added disk-full reason.
- minimalism, code-quality: dead `check_current_database` bool; duplicated transient description; unnamed 1000 and 3000 values.
- records: d-20261108-02 lacked its Superseded-by trailer.

Skipped: root-cause's "real-app result unmeasured" (a verification limitation, resolved by the proof below).
CR-1 and CR-2 closed by correctness, tests, platform-semantics and persisted-state; CR-1's red output
is in the Phase 1 report.

Closure round 2 (correctness, tests, error-handling, minimalism, code-quality, ipc-contract, records):
all APPROVED, every adopted finding CLOSED, one new test adoption (non-disk `reason`). Closure round 3
(correctness, tests): APPROVED. diff_adopted_per_round: r1=10 r2=1 r3=0.

## Real-app proof

Release build of the reviewed code on a 2.1.0 copy of Mega Database 2025 (11,441,614 games) plus a
small current database, driven through `scripts/app-driver.mjs`: every row listed 0.2 s after opening
the Library, the large row labelled Upgrading with its explanation and no Delete, normal row with
11,441,614 games after 6.4 s, no `database is locked` and no failed `get_db_info` in the app log.
Negative control, release c6fe14f1 on the same input: no row for 111 s, no upgrading state, 5 of 8
checks fail. The two log assertions were not staged to fail; their strings are verbatim from the
incident log.
