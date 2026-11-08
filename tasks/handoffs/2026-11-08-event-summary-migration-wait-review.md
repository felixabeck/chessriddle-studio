# Review record: f-20261108-05 event-summary migration wait

Plan: tasks/plans/2026-11-08-event-summary-migration-wait.md (ignored). This file is the durable record.
Planned ahead in drain PLAN-ONLY mode at BASE 3f00969454fe6a1ccee02ab2cb8e043a279fe1e1. Same-family disclosure: Claude Code (Opus 5.5) planned and arbitrated, Codex ran every lens.

Lens set, round 1: plan, correctness, error-handling, minimalism, tests, chess-semantics, engine-protocol, ipc-contract, persisted-state, pgn-index, platform-semantics, tauri-security. Diff-only and not run: root-cause, code-quality.
Issues: I1 rollback injection (plan r1 #1, tests r1 #1), I2 acceptance versus the real wait (plan r1 #2, r2 #1, r3 #1), I3 ordinary-refresh scan proof (plan r1 #3, tests r1 #2), I4 stale function name (plan r1 #4), I5 memory proof (tests r1 #3). All Fix. Closed: I1, I3, I4, I5 in r2, I2 in r4 after a second-failed-closure judgment.

## Reviews

### Round 1 (plan-r1, 12 lenses: plan, correctness, error-handling, minimalism, tests, chess-semantics, engine-protocol, ipc-contract, persisted-state, pgn-index, platform-semantics, tauri-security)
Verdicts: plan REVISE, tests REVISE, correctness, error-handling, minimalism, pgn-index, platform-semantics APPROVED, chess-semantics, engine-protocol, ipc-contract, persisted-state, tauri-security NOT APPLICABLE and APPROVED. root-cause and code-quality are diff-only (`plan-review: false`).
- I1 Rollback tests inject failure through the removed temporary table. Witnesses: plan #1, tests #1. Verified at `migrations.rs:920,1051`. MANDATE obligation: the fix must not lose rollback coverage. Fix: temp-trigger injection, Phase 1 tests. Open for r2 closure.
- I2 Acceptance permitted about 10 s of migration alone while O6 claims about 5 s, excluding acquisition and metadata. Witness: plan #2. Fix: measure `get_db_info_blocking`, derive the limit from the real-to-generated ratio in O6. Open for r2 closure.
- I3 No proof that ordinary refreshes avoid a full Games scan. Witnesses: plan #3, tests #2. Fix: source-recording test through production callers plus EXPLAIN QUERY PLAN. Open for r2 closure.
- I4 `update_database_counts` no longer exists. Witness: plan #4. Verified by `git grep`. Fix: decision names `refresh_derived_database_data`. Open for r2 closure.
- I5 O4's memory bound had no proof against the real implementation. Witness: tests #3. Fix: peak-RSS limit in acceptance. Open for r2 closure.

### Round 2 (plan-r2, review-plan, review-tests)
Verdicts: plan REVISE, tests APPROVED. I1, I3, I4, I5 CLOSED by review-plan, I1, I3, I5 also by review-tests.
- I2 NOT CLOSED (plan r2 #1): the old SQL's generated-to-real ratio does not carry over to the new algorithm. Correction: O6 no longer claims restoration from generated data, states the estimate and limits, and makes real measurement the closing evidence with an explicit outcome for each case. Added row-width probe. Open for r3 closure.

### Round 3 (plan-r3, review-plan)
Verdict: REVISE.
- I2 NOT CLOSED (plan r3 #1): a rerun against the migrated file takes `migrations.rs:211`, skipping migration, so the time and RSS would not measure it. Verified by reading `migrations.rs:211,218`. This is the second failed closure of I2's lineage, so before patching: invariant = a measurement only counts if the run actually performs the 2.2.0 to 2.3.0 migration. Previous answer = generation skipped on an existing file. New evidence = the source trace above. Judgment = the simplest correct mechanism is an immutable seed, a fresh disposable copy per run, and Version assertions before and after. Changes: benchmark and proof command. Open for r4 fresh-context closure.

### Round 4 (plan-r4, review-plan, focused fresh-context judgment for I2)
Verdict: APPROVED. I2 CLOSED: the per-run copy and Version assertions prevent the already-migrated branch at `migrations.rs:211`, and O6 distinguishes the regression guard from the unverified real wait.
Totals: rounds 4, unique issues 5 (I1 to I5), all Fix, none deferred or skipped. Adoptions r1=7 r2=1 r3=1 r4=0. Wall seconds per round [123.9, 178.4, 77.9, 74.6]. Real Mega timing stays an explicit open measurement in O6.

### Round 5 (plan-r5, drift refresh, 12 lenses: chess-semantics, correctness, engine-protocol, error-handling, ipc-contract, minimalism, persisted-state, pgn-index, plan, platform-semantics, tauri-security, tests)
Old base 3f00969454fe6a1ccee02ab2cb8e043a279fe1e1, new base de2bde57b4ee83cc3321627f0db16f76ae4943a2. The drift changes only `.github/workflows/test.yml`, `scripts/check-gate-routing-tests.mjs`, `tasks/decisions.md` and `tasks/findings.md`, with no file under `src-tauri/` or `src/`, so every traced premise still holds at the new base. Every lens reported NO DRIFT IMPACT and APPROVED. No new issues, no filings. Plan body unchanged from plan-r4. Totals now: rounds 5, unique issues 5, adoptions r1=7 r2=1 r3=1 r4=0 r5=0, round 5 wall seconds 45.5.


## Evidence

### Manifest

[
  {
    "artefact": "lens-chess-semantics-r1.jsonl",
    "findings": [],
    "lens": "chess-semantics",
    "profile_clean": null,
    "profile_detail": "",
    "prompt": "lens-chess-semantics-r1.prompt",
    "report": "lens-chess-semantics-r1.txt",
    "round": 1,
    "terminal": "completed",
    "verdict": "APPROVED"
  },
  {
    "artefact": "lens-correctness-r1.jsonl",
    "findings": [],
    "lens": "correctness",
    "profile_clean": null,
    "profile_detail": "",
    "prompt": "lens-correctness-r1.prompt",
    "report": "lens-correctness-r1.txt",
    "round": 1,
    "terminal": "completed",
    "verdict": "APPROVED"
  },
  {
    "artefact": "lens-engine-protocol-r1.jsonl",
    "findings": [],
    "lens": "engine-protocol",
    "profile_clean": null,
    "profile_detail": "",
    "prompt": "lens-engine-protocol-r1.prompt",
    "report": "lens-engine-protocol-r1.txt",
    "round": 1,
    "terminal": "completed",
    "verdict": "APPROVED"
  },
  {
    "artefact": "lens-error-handling-r1.jsonl",
    "findings": [],
    "lens": "error-handling",
    "profile_clean": null,
    "profile_detail": "",
    "prompt": "lens-error-handling-r1.prompt",
    "report": "lens-error-handling-r1.txt",
    "round": 1,
    "terminal": "completed",
    "verdict": "APPROVED"
  },
  {
    "artefact": "lens-ipc-contract-r1.jsonl",
    "findings": [],
    "lens": "ipc-contract",
    "profile_clean": null,
    "profile_detail": "",
    "prompt": "lens-ipc-contract-r1.prompt",
    "report": "lens-ipc-contract-r1.txt",
    "round": 1,
    "terminal": "completed",
    "verdict": "APPROVED"
  },
  {
    "artefact": "lens-minimalism-r1.jsonl",
    "findings": [],
    "lens": "minimalism",
    "profile_clean": null,
    "profile_detail": "",
    "prompt": "lens-minimalism-r1.prompt",
    "report": "lens-minimalism-r1.txt",
    "round": 1,
    "terminal": "completed",
    "verdict": "APPROVED"
  },
  {
    "artefact": "lens-persisted-state-r1.jsonl",
    "findings": [],
    "lens": "persisted-state",
    "profile_clean": null,
    "profile_detail": "",
    "prompt": "lens-persisted-state-r1.prompt",
    "report": "lens-persisted-state-r1.txt",
    "round": 1,
    "terminal": "completed",
    "verdict": "APPROVED"
  },
  {
    "artefact": "lens-pgn-index-r1.jsonl",
    "findings": [],
    "lens": "pgn-index",
    "profile_clean": null,
    "profile_detail": "",
    "prompt": "lens-pgn-index-r1.prompt",
    "report": "lens-pgn-index-r1.txt",
    "round": 1,
    "terminal": "completed",
    "verdict": "APPROVED"
  },
  {
    "artefact": "lens-plan-r1.jsonl",
    "findings": [
      {
        "kind": "blocker",
        "text": "tasks/plans/2026-11-08-event-summary-migration-wait.md:76 — The test plan misses rollback tests coupled to the removed temporary table. `src-tauri/src/db/migrations.rs:920` and `:1051` create `event_summary_refresh` specifically to make migration fail. Removing its creation makes the error assertions at `:922` and `:1052` fail. Replace those injections while preserving rollback and retry coverage for every migration origin. (confidence: 100)"
      },
      {
        "kind": "blocker",
        "text": "tasks/plans/2026-11-08-event-summary-migration-wait.md:86 — The acceptance gate permits nearly 10 seconds of migration alone, while O6 claims the accepted roughly 5-second wait is restored. The actual library path also acquires the connection and reads metadata at `src-tauri/src/db/mod.rs:1837`, and databases load sequentially at `src/utils/db.ts:275`. Passing this gate cannot establish O6 or justify closing the wait finding. Require evidence against the stated wait target, including acquisition, or explicitly resolve the remaining gap. (confidence: 96)"
      },
      {
        "kind": "blocker",
        "text": "tasks/plans/2026-11-08-event-summary-migration-wait.md:77 — No planned proof distinguishes O2’s indexed ordinary refresh from an accidental full Games scan. The oracle at `src-tauri/src/db/event_summary_tests.rs:52` checks summary values, and the scale benchmark exercises migration only. An ordinary refresh that scans every game could pass both. Add verification through the production refresh caller at `src-tauri/src/db/mod.rs:4324` that detects scanning unrelated games when the dirty set is small. (confidence: 94)"
      },
      {
        "kind": "should-fix",
        "text": "tasks/plans/2026-11-08-event-summary-migration-wait.md:60 — `update_database_counts` no longer exists. The surviving choke point is `refresh_derived_database_data` at `src-tauri/src/db/mod.rs:4323`. Correct the decision amendment so it names the integration boundary actually being preserved. (confidence: 100)"
      }
    ],
    "lens": "plan",
    "profile_clean": null,
    "profile_detail": "",
    "prompt": "lens-plan-r1.prompt",
    "report": "lens-plan-r1.txt",
    "round": 1,
    "terminal": "completed",
    "verdict": "REVISE"
  },
  {
    "artefact": "lens-plan-r2.jsonl",
    "findings": [
      {
        "kind": "blocker",
        "text": "tasks/plans/.plan-2026-11-08-event-summary-migration-wait.md-r2.body.md:58 — I2 NOT CLOSED. Measuring `get_db_info_blocking` fixes the integration boundary, but the 10-second limit assumes the old SQL implementation’s synthetic-to-real ratio also applies after replacing its repeated scans and sorts (`src-tauri/src/db/event_summaries.rs:13`). That does not establish the promised approximately five-second real wait. The optional real benchmark only prints migration time (`src-tauri/src/db/event_summary_tests.rs:422`), so it supplies no failing gate for this obligation. Require calibration of the optimized path or leave restoration of the accepted wait explicitly unresolved. (confidence: 92)"
      }
    ],
    "lens": "plan",
    "profile_clean": null,
    "profile_detail": "",
    "prompt": "lens-plan-r2.prompt",
    "report": "lens-plan-r2.txt",
    "round": 2,
    "terminal": "completed",
    "verdict": "REVISE"
  },
  {
    "artefact": "lens-plan-r3.jsonl",
    "findings": [
      {
        "kind": "blocker",
        "text": "tasks/plans/.plan-2026-11-08-event-summary-migration-wait.md-r3.body.md:89 — I2 NOT CLOSED — r3 removes the unsupported timing ratio, but its replacement benchmark skips generation when the file exists while acceptance requires rerunning it at line 96. The first successful acquisition commits Version 2.3.0 (`src-tauri/src/db/migrations.rs:218`). Subsequent runs take the current-version branch at `src-tauri/src/db/migrations.rs:211`, bypassing the migration and aggregation. Their elapsed time and peak RSS therefore cannot verify the intended limits. Preserve an immutable 2.2.0 seed, measure a fresh disposable copy for each run, and verify that migration actually executed before accepting either measurement. (confidence: 99)"
      }
    ],
    "lens": "plan",
    "profile_clean": null,
    "profile_detail": "",
    "prompt": "lens-plan-r3.prompt",
    "report": "lens-plan-r3.txt",
    "round": 3,
    "terminal": "completed",
    "verdict": "REVISE"
  },
  {
    "artefact": "lens-plan-r4.jsonl",
    "findings": [],
    "lens": "plan",
    "profile_clean": null,
    "profile_detail": "",
    "prompt": "lens-plan-r4.prompt",
    "report": "lens-plan-r4.txt",
    "round": 4,
    "terminal": "completed",
    "verdict": "APPROVED"
  },
  {
    "artefact": "lens-platform-semantics-r1.jsonl",
    "findings": [],
    "lens": "platform-semantics",
    "profile_clean": null,
    "profile_detail": "",
    "prompt": "lens-platform-semantics-r1.prompt",
    "report": "lens-platform-semantics-r1.txt",
    "round": 1,
    "terminal": "completed",
    "verdict": "APPROVED"
  },
  {
    "artefact": "lens-tauri-security-r1.jsonl",
    "findings": [],
    "lens": "tauri-security",
    "profile_clean": null,
    "profile_detail": "",
    "prompt": "lens-tauri-security-r1.prompt",
    "report": "lens-tauri-security-r1.txt",
    "round": 1,
    "terminal": "completed",
    "verdict": "APPROVED"
  },
  {
    "artefact": "lens-tests-r1.jsonl",
    "findings": [
      {
        "kind": "blocker",
        "text": "tasks/plans/2026-11-08-event-summary-migration-wait.md:76 — The existing `failed_summary_upgrade_rolls_back_every_additive_origin` injects failure by precreating `event_summary_refresh`. O3 removes that temporary table, so this injection stops exercising a failure and its `is_err()` assertion fails on successful migration. Name a replacement failure injection and rollback assertions for the streamed migration. Otherwise partial summary writes or an advanced version marker after failure have no migration regression anchor. (confidence: 99)"
      },
      {
        "kind": "should-fix",
        "text": "tasks/plans/2026-11-08-event-summary-migration-wait.md:77 — O2 has no proof that ordinary refreshes avoid scanning unrelated games. Oracle equality checks values, and the scale benchmark exercises only migration. Routing ordinary refreshes through a full Games scan while filtering writes to dirty events would pass both. Add a verification level and assertion that distinguishes indexed dirty-event reads from a full scan. (confidence: 97)"
      },
      {
        "kind": "should-fix",
        "text": "tasks/plans/2026-11-08-event-summary-migration-wait.md:79 — O4 has no planned memory verification. The benchmark prints elapsed time only, while the quoted RSS measurement comes from the scratch implementation. Retaining every streamed game row could preserve all summaries and satisfy the timing threshold without any planned proof rejecting the memory regression. Name a memory or retention check against the actual implementation. (confidence: 94)"
      }
    ],
    "lens": "tests",
    "profile_clean": null,
    "profile_detail": "",
    "prompt": "lens-tests-r1.prompt",
    "report": "lens-tests-r1.txt",
    "round": 1,
    "terminal": "completed",
    "verdict": "REVISE"
  },
  {
    "artefact": "lens-tests-r2.jsonl",
    "findings": [],
    "lens": "tests",
    "profile_clean": null,
    "profile_detail": "",
    "prompt": "lens-tests-r2.prompt",
    "report": "lens-tests-r2.txt",
    "round": 2,
    "terminal": "completed",
    "verdict": "APPROVED"
  },
  {
    "artefact": "lens-chess-semantics-r5.jsonl",
    "findings": [],
    "lens": "chess-semantics",
    "profile_clean": null,
    "profile_detail": "",
    "prompt": "lens-chess-semantics-r5.prompt",
    "report": "lens-chess-semantics-r5.txt",
    "round": 5,
    "terminal": "completed",
    "verdict": "APPROVED"
  },
  {
    "artefact": "lens-correctness-r5.jsonl",
    "findings": [],
    "lens": "correctness",
    "profile_clean": null,
    "profile_detail": "",
    "prompt": "lens-correctness-r5.prompt",
    "report": "lens-correctness-r5.txt",
    "round": 5,
    "terminal": "completed",
    "verdict": "APPROVED"
  },
  {
    "artefact": "lens-engine-protocol-r5.jsonl",
    "findings": [],
    "lens": "engine-protocol",
    "profile_clean": null,
    "profile_detail": "",
    "prompt": "lens-engine-protocol-r5.prompt",
    "report": "lens-engine-protocol-r5.txt",
    "round": 5,
    "terminal": "completed",
    "verdict": "APPROVED"
  },
  {
    "artefact": "lens-error-handling-r5.jsonl",
    "findings": [],
    "lens": "error-handling",
    "profile_clean": null,
    "profile_detail": "",
    "prompt": "lens-error-handling-r5.prompt",
    "report": "lens-error-handling-r5.txt",
    "round": 5,
    "terminal": "completed",
    "verdict": "APPROVED"
  },
  {
    "artefact": "lens-ipc-contract-r5.jsonl",
    "findings": [],
    "lens": "ipc-contract",
    "profile_clean": null,
    "profile_detail": "",
    "prompt": "lens-ipc-contract-r5.prompt",
    "report": "lens-ipc-contract-r5.txt",
    "round": 5,
    "terminal": "completed",
    "verdict": "APPROVED"
  },
  {
    "artefact": "lens-minimalism-r5.jsonl",
    "findings": [],
    "lens": "minimalism",
    "profile_clean": null,
    "profile_detail": "",
    "prompt": "lens-minimalism-r5.prompt",
    "report": "lens-minimalism-r5.txt",
    "round": 5,
    "terminal": "completed",
    "verdict": "APPROVED"
  },
  {
    "artefact": "lens-persisted-state-r5.jsonl",
    "findings": [],
    "lens": "persisted-state",
    "profile_clean": null,
    "profile_detail": "",
    "prompt": "lens-persisted-state-r5.prompt",
    "report": "lens-persisted-state-r5.txt",
    "round": 5,
    "terminal": "completed",
    "verdict": "APPROVED"
  },
  {
    "artefact": "lens-pgn-index-r5.jsonl",
    "findings": [],
    "lens": "pgn-index",
    "profile_clean": null,
    "profile_detail": "",
    "prompt": "lens-pgn-index-r5.prompt",
    "report": "lens-pgn-index-r5.txt",
    "round": 5,
    "terminal": "completed",
    "verdict": "APPROVED"
  },
  {
    "artefact": "lens-plan-r5.jsonl",
    "findings": [],
    "lens": "plan",
    "profile_clean": null,
    "profile_detail": "",
    "prompt": "lens-plan-r5.prompt",
    "report": "lens-plan-r5.txt",
    "round": 5,
    "terminal": "completed",
    "verdict": "APPROVED"
  },
  {
    "artefact": "lens-platform-semantics-r5.jsonl",
    "findings": [],
    "lens": "platform-semantics",
    "profile_clean": null,
    "profile_detail": "",
    "prompt": "lens-platform-semantics-r5.prompt",
    "report": "lens-platform-semantics-r5.txt",
    "round": 5,
    "terminal": "completed",
    "verdict": "APPROVED"
  },
  {
    "artefact": "lens-tauri-security-r5.jsonl",
    "findings": [],
    "lens": "tauri-security",
    "profile_clean": null,
    "profile_detail": "",
    "prompt": "lens-tauri-security-r5.prompt",
    "report": "lens-tauri-security-r5.txt",
    "round": 5,
    "terminal": "completed",
    "verdict": "APPROVED"
  },
  {
    "artefact": "lens-tests-r5.jsonl",
    "findings": [],
    "lens": "tests",
    "profile_clean": null,
    "profile_detail": "",
    "prompt": "lens-tests-r5.prompt",
    "report": "lens-tests-r5.txt",
    "round": 5,
    "terminal": "completed",
    "verdict": "APPROVED"
  }
]

### Issues

[
  {
    "claim": "Rollback tests inject failure through the removed event_summary_refresh temporary table, so their failure assertions would stop proving rollback.",
    "closed_round": 2,
    "correction": "Temp-trigger injection on Events updates with the injected message asserted, all rollback and retry assertions kept.",
    "dependencies": [],
    "disposition": "Fix",
    "id": "I1",
    "witnesses": [
      {
        "index": 1,
        "lens": "plan",
        "round": 1
      },
      {
        "index": 1,
        "lens": "tests",
        "round": 1
      }
    ]
  },
  {
    "claim": "The acceptance limit did not establish the accepted real wait: it first excluded acquisition, then relied on a ratio that does not carry over, then measured reruns that skip the migration.",
    "closed_round": 4,
    "correction": "Measure get_db_info_blocking on a fresh copy of an immutable 2.2.0 seed with Version assertions, keep the generated limit as a regression guard, and make a real Mega measurement the closing evidence with explicit outcomes.",
    "dependencies": [],
    "disposition": "Fix",
    "id": "I2",
    "witnesses": [
      {
        "index": 2,
        "lens": "plan",
        "round": 1
      },
      {
        "index": 1,
        "lens": "plan",
        "round": 2
      },
      {
        "index": 1,
        "lens": "plan",
        "round": 3
      }
    ]
  },
  {
    "claim": "No proof distinguishes the indexed ordinary refresh from an accidental full Games scan.",
    "closed_round": 2,
    "correction": "Test-only source record through both production callers plus EXPLAIN QUERY PLAN of the indexed source.",
    "dependencies": [],
    "disposition": "Fix",
    "id": "I3",
    "witnesses": [
      {
        "index": 3,
        "lens": "plan",
        "round": 1
      },
      {
        "index": 2,
        "lens": "tests",
        "round": 1
      }
    ]
  },
  {
    "claim": "The plan named update_database_counts, which no longer exists.",
    "closed_round": 2,
    "correction": "Name refresh_derived_database_data as the preserved choke point.",
    "dependencies": [],
    "disposition": "Fix",
    "id": "I4",
    "witnesses": [
      {
        "index": 4,
        "lens": "plan",
        "round": 1
      }
    ]
  },
  {
    "claim": "The memory bound had no proof against the actual implementation.",
    "closed_round": 2,
    "correction": "Peak-RSS limit in the release benchmark acceptance.",
    "dependencies": [],
    "disposition": "Fix",
    "id": "I5",
    "witnesses": [
      {
        "index": 3,
        "lens": "tests",
        "round": 1
      }
    ]
  }
]

### delta-r2.txt

ROUND: 2
DELTA: /home/felixb/.claude/drain-plans/drain-90a2aa88/slot-0/wt/tasks/plans/.plan-delta-2026-11-08-event-summary-migration-wait.md-r2.diff
REVISED:
## Traced premises
## Approach > ### O2 Row source chosen by the caller
## Approach > ### O6 The open question is answered by removing the wait
## Decisions and trade-offs
## Phases > ### Phase 1: streamed event-summary aggregation
SETTLED:
# Plan: remove the long one-time 2.3.0 event-summary migration wait
## Goal
## MANDATE
## Threat model and non-goals
## Approach
## Approach > ### O1 One aggregation implementation
## Approach > ### O3 Writes and the dirty contract
## Approach > ### O4 Bounded memory
## Approach > ### O5 Failure handling
## Risks / open questions
## Not part of this task
## Phases

### delta-r3.txt

ROUND: 3
DELTA: /home/felixb/.claude/drain-plans/drain-90a2aa88/slot-0/wt/tasks/plans/.plan-delta-2026-11-08-event-summary-migration-wait.md-r3.diff
REVISED:
## Traced premises
## Approach > ### O6 The open question is answered by removing the wait
## Risks / open questions
## Phases > ### Phase 1: streamed event-summary aggregation
SETTLED:
# Plan: remove the long one-time 2.3.0 event-summary migration wait
## Goal
## MANDATE
## Threat model and non-goals
## Approach
## Approach > ### O1 One aggregation implementation
## Approach > ### O2 Row source chosen by the caller
## Approach > ### O3 Writes and the dirty contract
## Approach > ### O4 Bounded memory
## Approach > ### O5 Failure handling
## Decisions and trade-offs
## Not part of this task
## Phases

### delta-r4.txt

ROUND: 4
DELTA: /home/felixb/.claude/drain-plans/drain-90a2aa88/slot-0/wt/tasks/plans/.plan-delta-2026-11-08-event-summary-migration-wait.md-r4.diff
REVISED:
## Phases > ### Phase 1: streamed event-summary aggregation
SETTLED:
# Plan: remove the long one-time 2.3.0 event-summary migration wait
## Goal
## MANDATE
## Threat model and non-goals
## Traced premises
## Approach
## Approach > ### O1 One aggregation implementation
## Approach > ### O2 Row source chosen by the caller
## Approach > ### O3 Writes and the dirty contract
## Approach > ### O4 Bounded memory
## Approach > ### O5 Failure handling
## Approach > ### O6 The open question is answered by removing the wait
## Decisions and trade-offs
## Risks / open questions
## Not part of this task
## Phases

### lens-chess-semantics-r1.txt

NOT APPLICABLE: The plan changes database event-summary aggregation and migration performance. Its files and O1–O6 obligations do not manipulate in-memory game trees, positions, FEN identity, move paths or chess-rule state.

VERDICT: APPROVED
### lens-chess-semantics-r5.txt

NO DRIFT IMPACT: The drift changes only CI caching, its contract checks and ledger records, leaving in-memory chess semantics and plan obligations O1–O6 unaffected.
VERDICT: APPROVED
### lens-correctness-r1.txt

No correctness defects found in O1–O6 against the existing SQL, oracle, migration callers and write paths.

Limitation: this reviews plan-r1’s contracts only. Streaming, numeric conversions and write ordering require implementation review (confidence: 90).

VERDICT: APPROVED
### lens-correctness-r5.txt

NO DRIFT IMPACT: The drift changes only CI actionlint caching, its guard, and related ledger records, leaving all four database files and the contracts underlying O1–O6 unchanged.
VERDICT: APPROVED
### lens-engine-protocol-r1.txt

NOT APPLICABLE: The plan’s files and O1–O6 obligations concern synchronous SQLite event-summary aggregation and migration. They do not touch engine processes, UCI state, or asynchronous engine-result routing.
VERDICT: APPROVED
### lens-engine-protocol-r5.txt

NO DRIFT IMPACT: The drift changes only CI caching, its contract tests and ledger records, leaving engine supervision, UCI sequencing, result routing and plan obligations O1–O6 unaffected.
VERDICT: APPROVED
### lens-error-handling-r1.txt

No error-handling defects found in the plan. O3 and O5 require transaction rollback and typed error propagation. The existing caller surfaces migration failures as a per-database error card.

Limitation: streaming row-error handling remains unverified until implementation review (confidence: 100).

VERDICT: APPROVED
### lens-error-handling-r5.txt

NO DRIFT IMPACT: The drift changes only CI caching, its guard tests and ledger records, leaving O1–O6’s transaction rollback, typed error propagation and failure-injection obligations unaffected.
VERDICT: APPROVED
### lens-ipc-contract-r1.txt

NOT APPLICABLE: The three scoped files and O1–O6 concern internal database aggregation and migration. O6 explicitly excludes event, binding and renderer changes, so no Rust↔renderer IPC contract is touched.

VERDICT: APPROVED
### lens-ipc-contract-r5.txt

NO DRIFT IMPACT: The drift changes only CI caching, its guard tests and ledger records, leaving the plan’s Rust↔renderer contracts and O6’s no-new-IPC obligation unaffected.
VERDICT: APPROVED
### lens-minimalism-r1.txt

VERDICT: APPROVED
### lens-minimalism-r5.txt

NO DRIFT IMPACT: The drift changes only CI caching, its guard tests, and unrelated ledger records, leaving O1–O6’s aggregation, callers, and verification obligations unaffected.
VERDICT: APPROVED
### lens-persisted-state-r1.txt

NOT APPLICABLE: The listed files and O1–O6 concern backend SQLite aggregation and migration transactions. O6 explicitly excludes renderer changes. No renderer storage keys, hydration, atom families or tab lifecycle are affected.

VERDICT: APPROVED
### lens-persisted-state-r5.txt

NO DRIFT IMPACT: The drift changes only CI caching, its contract tests and ledger records, leaving renderer persistence, tab lifecycle and the plan’s O1–O6 obligations unaffected.
VERDICT: APPROVED
### lens-pgn-index-r1.txt

No in-lens defects found. The plan preserves dirty-event selection, stored summary semantics and caller-owned transaction boundaries while streaming game rows.

VERDICT: APPROVED
### lens-pgn-index-r5.txt

NO DRIFT IMPACT: The drift changes only CI caching, its contract tests and ledger records, leaving database scanning, indexing, storage and transaction paths unchanged and invalidating none of O1–O6.
VERDICT: APPROVED
### lens-plan-r1.txt

[blocker] tasks/plans/2026-11-08-event-summary-migration-wait.md:76 — The test plan misses rollback tests coupled to the removed temporary table. `src-tauri/src/db/migrations.rs:920` and `:1051` create `event_summary_refresh` specifically to make migration fail. Removing its creation makes the error assertions at `:922` and `:1052` fail. Replace those injections while preserving rollback and retry coverage for every migration origin. (confidence: 100)

[blocker] tasks/plans/2026-11-08-event-summary-migration-wait.md:86 — The acceptance gate permits nearly 10 seconds of migration alone, while O6 claims the accepted roughly 5-second wait is restored. The actual library path also acquires the connection and reads metadata at `src-tauri/src/db/mod.rs:1837`, and databases load sequentially at `src/utils/db.ts:275`. Passing this gate cannot establish O6 or justify closing the wait finding. Require evidence against the stated wait target, including acquisition, or explicitly resolve the remaining gap. (confidence: 96)

[blocker] tasks/plans/2026-11-08-event-summary-migration-wait.md:77 — No planned proof distinguishes O2’s indexed ordinary refresh from an accidental full Games scan. The oracle at `src-tauri/src/db/event_summary_tests.rs:52` checks summary values, and the scale benchmark exercises migration only. An ordinary refresh that scans every game could pass both. Add verification through the production refresh caller at `src-tauri/src/db/mod.rs:4324` that detects scanning unrelated games when the dirty set is small. (confidence: 94)

[should-fix] tasks/plans/2026-11-08-event-summary-migration-wait.md:60 — `update_database_counts` no longer exists. The surviving choke point is `refresh_derived_database_data` at `src-tauri/src/db/mod.rs:4323`. Correct the decision amendment so it names the integration boundary actually being preserved. (confidence: 100)

Limitation: Real Mega performance remains unverified, as acknowledged at plan line 64. This read-only review inspected source and history without executing tests or benchmarks. (confidence: 100)

VERDICT: REVISE
### lens-plan-r2.txt

I1 CLOSED — r2:82 replaces table-collision injection with an Events update trigger and verifies its error message. Validation inspects only `protect_unknown_%` triggers (`src-tauri/src/db/migrations.rs:764`), and all four origins reach the summary write (`migrations.rs:217,226,242,318`).

[blocker] tasks/plans/.plan-2026-11-08-event-summary-migration-wait.md-r2.body.md:58 — I2 NOT CLOSED. Measuring `get_db_info_blocking` fixes the integration boundary, but the 10-second limit assumes the old SQL implementation’s synthetic-to-real ratio also applies after replacing its repeated scans and sorts (`src-tauri/src/db/event_summaries.rs:13`). That does not establish the promised approximately five-second real wait. The optional real benchmark only prints migration time (`src-tauri/src/db/event_summary_tests.rs:422`), so it supplies no failing gate for this obligation. Require calibration of the optimized path or leave restoration of the accepted wait explicitly unresolved. (confidence: 92)

I3 CLOSED — r2:83 requires caller-level source recording plus EXPLAIN of the indexed query. This covers both actual entry points (`src-tauri/src/db/mod.rs:4324`, `src-tauri/src/db/migrations.rs:362`).

I4 CLOSED — r2:63 now names the existing `refresh_derived_database_data` function (`src-tauri/src/db/mod.rs:4323`).

I5 CLOSED — r2:88–91 adds a release-process peak-RSS limit and a prebuilt rerun, measuring the application implementation rather than only the scratch aggregation.

VERDICT: REVISE
### lens-plan-r3.txt

[blocker] tasks/plans/.plan-2026-11-08-event-summary-migration-wait.md-r3.body.md:89 — I2 NOT CLOSED — r3 removes the unsupported timing ratio, but its replacement benchmark skips generation when the file exists while acceptance requires rerunning it at line 96. The first successful acquisition commits Version 2.3.0 (`src-tauri/src/db/migrations.rs:218`). Subsequent runs take the current-version branch at `src-tauri/src/db/migrations.rs:211`, bypassing the migration and aggregation. Their elapsed time and peak RSS therefore cannot verify the intended limits. Preserve an immutable 2.2.0 seed, measure a fresh disposable copy for each run, and verify that migration actually executed before accepting either measurement. (confidence: 99)

VERDICT: REVISE
### lens-plan-r4.txt

I2 CLOSED — plan-r4 requires a fresh disposable copy for every run, Version assertions before and after, and timing through `get_db_info_blocking` (`tasks/plans/.plan-2026-11-08-event-summary-migration-wait.md-r4.body.md:89,96`). This directly prevents reruns from taking the already-migrated branch at `src-tauri/src/db/migrations.rs:211`. The 2.2.0 branch performs migration before publishing Version 2.3.0 (`:213-219`), and fixture setup does not acquire the database (`src-tauri/src/db/mod.rs:805-820`).

O6 honestly distinguishes the synthetic regression guard from restoration of the real Mega wait (`tasks/plans/.plan-2026-11-08-event-summary-migration-wait.md-r4.body.md:61-63`). Real Mega timing remains an explicit, unverified limitation. Closure confirms the planned verification mechanism, not measured performance.

VERDICT: APPROVED
### lens-plan-r5.txt

NO DRIFT IMPACT: The drift changes only actionlint caching, its CI guard, and ledger records, leaving O1–O6, database code, dependencies, and planned verification unchanged.
VERDICT: APPROVED
### lens-platform-semantics-r1.txt

No platform-semantics findings. The planned mechanism introduces no OS-specific paths, handles, FFI or `cfg` branches. Existing test helpers are available on Linux, macOS and Windows.

Proof remains pending: neither `pnpm rust:windows:check` nor the non-Linux Unix source probe ran during this read-only plan review. Windows and macOS runtime proof belongs to `rust-windows-test` and `rust-macos-test`. The `rust-platform` matrix checks compilation and warnings, not runtime behavior. The proposed ignored scale benchmark will not run in those ordinary CI test jobs.

No files changed.

VERDICT: APPROVED
### lens-platform-semantics-r5.txt

NO DRIFT IMPACT: The drift changes only frontend CI caching, its guard and ledger records, leaving O1–O6, database paths and Windows/macOS proof jobs unchanged.
VERDICT: APPROVED
### lens-tauri-security-r1.txt

NOT APPLICABLE: The plan’s files and O1–O6 cover event-summary aggregation and transactional database updates. They introduce no credential/session flow, filesystem authority or recursive mutation, signed-download verification, or renderer-facing diagnostic payload.

VERDICT: APPROVED
### lens-tauri-security-r5.txt

NO DRIFT IMPACT: The drift changes only CI actionlint caching, its contract tests and ledger records, leaving O1–O6 and all native security boundaries relevant to the plan unchanged.
VERDICT: APPROVED
### lens-tests-r1.txt

[blocker] tasks/plans/2026-11-08-event-summary-migration-wait.md:76 — The existing `failed_summary_upgrade_rolls_back_every_additive_origin` injects failure by precreating `event_summary_refresh`. O3 removes that temporary table, so this injection stops exercising a failure and its `is_err()` assertion fails on successful migration. Name a replacement failure injection and rollback assertions for the streamed migration. Otherwise partial summary writes or an advanced version marker after failure have no migration regression anchor. (confidence: 99)

[should-fix] tasks/plans/2026-11-08-event-summary-migration-wait.md:77 — O2 has no proof that ordinary refreshes avoid scanning unrelated games. Oracle equality checks values, and the scale benchmark exercises only migration. Routing ordinary refreshes through a full Games scan while filtering writes to dirty events would pass both. Add a verification level and assertion that distinguishes indexed dirty-event reads from a full scan. (confidence: 97)

[should-fix] tasks/plans/2026-11-08-event-summary-migration-wait.md:79 — O4 has no planned memory verification. The benchmark prints elapsed time only, while the quoted RSS measurement comes from the scratch implementation. Retaining every streamed game row could preserve all summaries and satisfy the timing threshold without any planned proof rejecting the memory regression. Name a memory or retention check against the actual implementation. (confidence: 94)

VERDICT: REVISE
### lens-tests-r2.txt

I1 CLOSED — Phase 1 requires trigger-injected summary-write failure, assertion of the injected error message, rollback checks for every migration origin and successful retry after removing the trigger.

I3 CLOSED — Production-caller tests assert source selection, while EXPLAIN assertions reject a full Games scan for ordinary refreshes.

I5 CLOSED — The release benchmark measures production-path peak RSS against a fixed 1.2 GB limit, requires a compiler-free rerun and stops acceptance on failure.

VERDICT: APPROVED
### lens-tests-r5.txt

NO DRIFT IMPACT: The drift changes actionlint caching, its workflow guard tests and ledger records, leaving O1–O6’s verification paths, assertions and proof commands unaffected.
VERDICT: APPROVED
### plan-r1.md

# Plan: remove the long one-time 2.3.0 event-summary migration wait

## Goal
Bring the one-time 2.2.0 to 2.3.0 migration of a Mega-sized database back to the wait d-20261108-02 accepted (about 5 s) by replacing the sort-heavy backfill, so the Library's existing loading line stays correct and no new upgrade state is needed.

## MANDATE
f-20261108-05, verbatim:

One-time 2.3.0 event-summary migration holds the library on the generic loading line for about 24 s on Mega Database 2025

* **Where:** `migrate_event_summaries` in `src-tauri/src/db/migrations.rs` (Games(EventID) index build plus full backfill) during `validate_existing_database`, shown through the library listing in `src/components/databases/useDatabaseLibrary.tsx`.
* **Defect:** the 2.2.0 to 2.3.0 upgrade runs synchronously when a database is first opened by a build containing it, and the library shows only its generic loading line meanwhile. d-20261108-02 accepted a wait of about 5 s and named filing a finding as its reversal path if a measured wait noticeably exceeds an ordinary listing.
* **Failure scenario:** release-profile benchmark `db::event_summary_tests::benchmark_mega_event_summaries` on a copy of Mega Database 2025 (11,441,614 games, 70,039 events, schema 2.2.0), 2026-11-08, machine load average about 42: migration plus acquisition took 23.55 s, once per database.
* **Open question:** should the listing show a per-database one-time upgrade state, or is a wait of this size acceptable for databases of this size?

## Threat model and non-goals
Input is a user-selected or previously imported SQLite database, including legacy rows with odd but schema-valid values (NULL dates, `?`-prefixed partial dates, zero or negative ratings, Unknown ID 0). No adversary deliberately crafting a database to exhaust memory is in scope. Migration remains synchronous, uncancellable from the listing, and inside the caller's transaction exactly as today.

## Traced premises
Frozen at BASE 3f009694.
- `src-tauri/src/db/migrations.rs:351-363` `migrate_event_summaries` adds the columns, runs `event_summaries_sql()` (index, dirty table, triggers), marks every non-zero event dirty and calls `refresh_event_summaries`.
- `src-tauri/src/db/event_summaries.rs:5-53` `refresh_event_summaries` is one SQL script. `dirty_games` is `NOT MATERIALIZED`, so `totals`, both halves of `participants` and `ranked_sites` each re-read the rows and sort or deduplicate them.
- `src-tauri/src/db/mod.rs:4323-4324` `refresh_derived_database_data` is the only other caller. It runs for every production write path, normally over a small dirty set.
- `src-tauri/src/db/migrations.rs:213-248,318` all four upgrade arms reach `migrate_event_summaries`, each inside a transaction.
- `src/utils/db.ts:275-279` `getDatabases` fetches metadata with `collectSequential`, and `src/components/databases/useDatabaseLibrary.tsx:320-324` shows only `Library.DatabasesLoading` until the whole list resolves. `get_db_info` reaches the migration through `get_db_or_create` (`src-tauri/src/db/mod.rs:1837`).
- `src-tauri/src/db/event_summary_tests.rs:5-84` `assert_event_summaries` is an independent Rust oracle, already called by the write-path tests. `src-tauri/src/db/migrations.rs:809` `pre_event_summary_schema` builds a 2.2.0 schema for tests.
- Existing streaming precedent: `load_iter::<_, DefaultLoadingMode>` at `src-tauri/src/db/mod.rs:3448` over a `sql_query`.

Measurements (2026-11-08, load average about 1, synthetic 11,441,614-game and 70,038-event database on tmpfs, 200-game runs per event, random players, SQLite CLI 3.45.1 and scratch crates pinned to the app's diesel 2.1.4 and bundled libsqlite3-sys 0.25.2; no Mega copy exists on this machine any more):
- `CREATE INDEX games_event_idx`: 2.26 s.
- Current refresh SQL: 28.5 to 29.8 s. Components: totals 9.3 s, participants 13.1 s, sites 9.4 s.
- Rejected tunings, all with the same result: `MATERIALIZED` narrow CTE 23.8 s; table scan with dirty lookup 27.4 s (26.0 s materialized); `PRAGMA cache_size` 1 GB 27.4 s; `PRAGMA threads` 4 or 8 with a large cache 27.5 to 28.6 s. Sorting and deduplication dominate, a plain narrow table scan costs 0.58 s.
- One-pass Rust aggregation over a rowid-order scan: rusqlite 3.04 s scan and aggregate plus 0.14 s update, identical checksums to the SQL over every summary column. Through Diesel `sql_query` plus `load_iter`: 4.72 s, peak RSS 686 MB at 22,876,980 distinct (event, player) pairs, the worst case for this data shape because players are random per game.
- The real-app measurement in `tasks/handoffs/2026-11-08-event-summary-columns-review.md` was 12.7 to 15.2 s for the whole listing, so synthetic SQL time is pessimistic against real Mega.

## Approach

### O1 One aggregation implementation
`refresh_event_summaries` computes summaries by streaming rows into per-event accumulators in Rust and writing the results. The SQL script is removed, so the migration and every write path share one implementation (universal rule 11, async-resource "second implementation gets extracted"). Semantics are exactly those of the removed SQL and of `assert_event_summaries`:
GameCount counts every game of the event. StartDate and EndDate are the bytewise minimum and maximum of non-NULL dates not beginning with `?`. PlayerCount is the number of distinct non-zero White or Black IDs. SiteID is the most frequent non-zero site, ties to the lowest ID, 0 when none. AvgElo is the mean of all positive rating slots across both colours, rounded half away from zero, NULL when none.

### O2 Row source chosen by the caller
Ordinary refreshes read the games of dirty events through `games_event_idx`, as today, so a small dirty set never scans Games. The migration backfill reads Games once in rowid order. Only the row source differs, never the accumulation or write. Both sources use only the seven columns the aggregation needs.

### O3 Writes and the dirty contract
Exactly the dirty non-zero events are written, including dirty events that have no remaining games (zero counts, NULL dates and AvgElo, SiteID 0). Event 0 and non-dirty events are untouched. The dirty table is empty afterwards. All writes happen on the caller's connection inside the caller's transaction, so any failure leaves no partial summaries. No temporary table remains in use.

### O4 Bounded memory
Accumulators hold counters, two date strings, and one entry per distinct (event, player) and (event, site) pair. Games rows are never retained. The measured worst case is above: 686 MB at 22.9 M distinct pairs, at most two entries per game.

### O5 Failure handling
Row and write failures return the existing typed `Error` through the caller's transaction. No `unwrap`, `expect` or panic on database-driven values. Rating arithmetic cannot overflow (`f64` accumulation, `i64` counts).

### O6 The open question is answered by removing the wait
No per-database upgrade state, event, binding or renderer change. d-20261108-02 stays in force because its accepted wait size is restored.

## Decisions and trade-offs
Decided autonomously:
- **Answer to the open question.** Question: should the listing show a per-database one-time upgrade state, or is the wait acceptable? Chosen: neither, shrink the wait to the size d-20261108-02 accepted. Rejected: a dedicated upgrade state (new event, binding and renderer state for a once-per-database wait, which explains the wait instead of removing it, rule 6d), accepting about 24 s (the wait d-20261108-02 explicitly did not accept), a background backfill (Events would show blank summaries, plus a new long-lived write job). Reason: measured about 6x reduction with no user-visible change. Reversal path: restore the SQL script from git and file a finding if a real-database measurement stays well above 5 s.
- **Amends d-20261108-11's "one set-based recomputation".** Chosen: one streamed Rust aggregation over the same dirty set and triggers, new evidence being the 28 s backfill measured above, which d-20261108-11 did not have. Dirty tracking, the choke point at `update_database_counts`, `games_event_idx` and every summary definition stay. Rejected: a Rust path for the migration alongside the SQL for incremental writes (two implementations of one definition). Reason: only a streamed pass removes the sort cost. Reversal path: restore the SQL body of `refresh_event_summaries`.
- This is not parkable as `felix-decision`: per the ledger contract's tests it chooses between working mechanisms, and one option keeps the filed defect.

## Risks / open questions
- Real Mega time cannot be measured here because no copy remains. The adopter runs `benchmark_mega_event_summaries` too if a copy is available, otherwise the report states this limit.
- Peak memory rises from about 30 MB to at most the O4 bound during this one-time step on the very largest databases.

## Not part of this task
Upgrade progress UI or copy, making `getDatabases` progressive, cancelling a migration, adding Events indexes, and other migration arms' player-count backfill.

## Phases

### Phase 1: streamed event-summary aggregation
Files: `src-tauri/src/db/event_summaries.rs`, `src-tauri/src/db/migrations.rs`, `src-tauri/src/db/event_summary_tests.rs`.
Touches persistence inside the caller's transaction. Role: sensitive.
Tests:
- Keep every existing `assert_event_summaries` call.
- Add a test seeding edge rows (the `summaries_cover_edges` shapes, site ties, a dirty event with no games, multi-event games) that runs both the ordinary refresh and the migration row source and asserts identical results through the oracle.
- Prove red by breaking one semantic rule (tie-break, `?` filter or rating filter) locally and confirming the new test fails, then restore it.
- Add one `#[ignore]` test that builds a generated 2.2.0 database of 11,441,614 games and 70,038 events at the path named by `EVENT_SUMMARY_BENCH_DB` using `pre_event_summary_schema`, then prints the elapsed time of `validate_existing_database`. It lives beside `benchmark_mega_event_summaries`.

PROOF COMMAND (3 commands):
PATH="$HOME/.cargo/bin:$PATH" cargo test --manifest-path src-tauri/Cargo.toml --locked --bins -- db::event_summar db::migrations::
PATH="$HOME/.cargo/bin:$PATH" EVENT_SUMMARY_BENCH_DB="$RUN_TMP/bench.db3" cargo test --manifest-path src-tauri/Cargo.toml --locked --release --bins -- --ignored --nocapture event_summary_migration_scale
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check

Acceptance: at load average below 5, the printed migration time is below 10 s (index plus backfill, against a baseline of about 31 s on this shape). The orchestrator reruns it and records the number.

### plan-r2.md

# Plan: remove the long one-time 2.3.0 event-summary migration wait

## Goal
Bring the one-time 2.2.0 to 2.3.0 migration of a Mega-sized database back to the wait d-20261108-02 accepted (about 5 s) by replacing the sort-heavy backfill, so the Library's existing loading line stays correct and no new upgrade state is needed.

## MANDATE
f-20261108-05, verbatim:

One-time 2.3.0 event-summary migration holds the library on the generic loading line for about 24 s on Mega Database 2025

* **Where:** `migrate_event_summaries` in `src-tauri/src/db/migrations.rs` (Games(EventID) index build plus full backfill) during `validate_existing_database`, shown through the library listing in `src/components/databases/useDatabaseLibrary.tsx`.
* **Defect:** the 2.2.0 to 2.3.0 upgrade runs synchronously when a database is first opened by a build containing it, and the library shows only its generic loading line meanwhile. d-20261108-02 accepted a wait of about 5 s and named filing a finding as its reversal path if a measured wait noticeably exceeds an ordinary listing.
* **Failure scenario:** release-profile benchmark `db::event_summary_tests::benchmark_mega_event_summaries` on a copy of Mega Database 2025 (11,441,614 games, 70,039 events, schema 2.2.0), 2026-11-08, machine load average about 42: migration plus acquisition took 23.55 s, once per database.
* **Open question:** should the listing show a per-database one-time upgrade state, or is a wait of this size acceptable for databases of this size?

## Threat model and non-goals
Input is a user-selected or previously imported SQLite database, including legacy rows with odd but schema-valid values (NULL dates, `?`-prefixed partial dates, zero or negative ratings, Unknown ID 0). No adversary deliberately crafting a database to exhaust memory is in scope. Migration remains synchronous, uncancellable from the listing, and inside the caller's transaction exactly as today.

## Traced premises
Frozen at BASE 3f009694.
- `src-tauri/src/db/migrations.rs:351-363` `migrate_event_summaries` adds the columns, runs `event_summaries_sql()` (index, dirty table, triggers), marks every non-zero event dirty and calls `refresh_event_summaries`.
- `src-tauri/src/db/event_summaries.rs:5-53` `refresh_event_summaries` is one SQL script. `dirty_games` is `NOT MATERIALIZED`, so `totals`, both halves of `participants` and `ranked_sites` each re-read the rows and sort or deduplicate them.
- `src-tauri/src/db/mod.rs:4323-4324` `refresh_derived_database_data` is the only other caller. It runs for every production write path, normally over a small dirty set.
- `src-tauri/src/db/migrations.rs:213-248,318` all four upgrade arms reach `migrate_event_summaries`, each inside a transaction.
- `src/utils/db.ts:275-279` `getDatabases` fetches metadata with `collectSequential`, and `src/components/databases/useDatabaseLibrary.tsx:320-324` shows only `Library.DatabasesLoading` until the whole list resolves. `get_db_info` reaches the migration through `get_db_or_create` (`src-tauri/src/db/mod.rs:1837`).
- `src-tauri/src/db/event_summary_tests.rs:5-84` `assert_event_summaries` is an independent Rust oracle, already called by the write-path tests. `src-tauri/src/db/migrations.rs:809` `pre_event_summary_schema` builds a 2.2.0 schema for tests.
- Existing streaming precedent: `load_iter::<_, DefaultLoadingMode>` at `src-tauri/src/db/mod.rs:3448` over a `sql_query`.

- `src-tauri/src/db/migrations.rs:920,1051` inject the rollback failure by pre-creating a temporary `event_summary_refresh` table, which only works while the refresh creates that table.
- `src-tauri/src/db/migrations.rs:17-22` `take_content_pragma_counts` is the existing test-only thread-local counter precedent. `validate_sentinel_records_and_triggers` inspects only `protect_unknown_%` triggers, so a differently named TEMP trigger does not trip validation.

Measurements (2026-11-08, load average about 1, synthetic 11,441,614-game and 70,038-event database on tmpfs, 200-game runs per event, random players, SQLite CLI 3.45.1 and scratch crates pinned to the app's diesel 2.1.4 and bundled libsqlite3-sys 0.25.2; no Mega copy exists on this machine any more):
- `CREATE INDEX games_event_idx`: 2.26 s.
- Current refresh SQL: 28.5 to 29.8 s. Components: totals 9.3 s, participants 13.1 s, sites 9.4 s.
- Rejected tunings, all with the same result: `MATERIALIZED` narrow CTE 23.8 s; table scan with dirty lookup 27.4 s (26.0 s materialized); `PRAGMA cache_size` 1 GB 27.4 s; `PRAGMA threads` 4 or 8 with a large cache 27.5 to 28.6 s. Sorting and deduplication dominate, a plain narrow table scan costs 0.58 s.
- One-pass Rust aggregation over a rowid-order scan: rusqlite 3.04 s scan and aggregate plus 0.14 s update, identical checksums to the SQL over every summary column. Through Diesel `sql_query` plus `load_iter`: 4.72 s, peak RSS 686 MB at 22,876,980 distinct (event, player) pairs, the worst case for this data shape because players are random per game.
- The real-app measurement in `tasks/handoffs/2026-11-08-event-summary-columns-review.md` was 12.7 to 15.2 s for the whole listing, so synthetic SQL time is pessimistic against real Mega.

## Approach

### O1 One aggregation implementation
`refresh_event_summaries` computes summaries by streaming rows into per-event accumulators in Rust and writing the results. The SQL script is removed, so the migration and every write path share one implementation (universal rule 11, async-resource "second implementation gets extracted"). Semantics are exactly those of the removed SQL and of `assert_event_summaries`:
GameCount counts every game of the event. StartDate and EndDate are the bytewise minimum and maximum of non-NULL dates not beginning with `?`. PlayerCount is the number of distinct non-zero White or Black IDs. SiteID is the most frequent non-zero site, ties to the lowest ID, 0 when none. AvgElo is the mean of all positive rating slots across both colours, rounded half away from zero, NULL when none.

### O2 Row source chosen by the caller
Ordinary refreshes read the games of dirty events through `games_event_idx`, as today, so a small dirty set never scans Games. The migration backfill reads Games once in rowid order. Only the row source differs, never the accumulation or write. Both sources use only the seven columns the aggregation needs. `refresh_derived_database_data` uses the indexed source and `migrate_event_summaries` the full scan, and the test build records which one each used.

### O3 Writes and the dirty contract
Exactly the dirty non-zero events are written, including dirty events that have no remaining games (zero counts, NULL dates and AvgElo, SiteID 0). Event 0 and non-dirty events are untouched. The dirty table is empty afterwards. All writes happen on the caller's connection inside the caller's transaction, so any failure leaves no partial summaries. No temporary table remains in use.

### O4 Bounded memory
Accumulators hold counters, two date strings, and one entry per distinct (event, player) and (event, site) pair. Games rows are never retained. The measured worst case is above: 686 MB at 22.9 M distinct pairs, at most two entries per game.

### O5 Failure handling
Row and write failures return the existing typed `Error` through the caller's transaction. No `unwrap`, `expect` or panic on database-driven values. Rating arithmetic cannot overflow (`f64` accumulation, `i64` counts).

### O6 The open question is answered by removing the wait
No per-database upgrade state, event, binding or renderer change. d-20261108-02 stays in force only if its accepted wait size is restored, and the Phase 1 acceptance measures that through the production listing path. The target is about 5 s on real Mega. The generated database is about 2 to 2.4 times slower than real Mega under the current SQL (about 31 s against the 12.7 to 15.2 s real-app listing), so the equivalent limit on the generated database is 10 s for migration, acquisition and metadata together.

## Decisions and trade-offs
Decided autonomously:
- **Answer to the open question.** Question: should the listing show a per-database one-time upgrade state, or is the wait acceptable? Chosen: neither, shrink the wait to the size d-20261108-02 accepted. Rejected: a dedicated upgrade state (new event, binding and renderer state for a once-per-database wait, which explains the wait instead of removing it, rule 6d), accepting about 24 s (the wait d-20261108-02 explicitly did not accept), a background backfill (Events would show blank summaries, plus a new long-lived write job). Reason: measured about 6x reduction with no user-visible change. Reversal path: restore the SQL script from git and file a finding if a real-database measurement stays well above 5 s.
- **Amends d-20261108-11's "one set-based recomputation".** Chosen: one streamed Rust aggregation over the same dirty set and triggers, new evidence being the 28 s backfill measured above, which d-20261108-11 did not have. Dirty tracking, the choke point at `refresh_derived_database_data` (named `update_database_counts` when d-20261108-11 was written), `games_event_idx` and every summary definition stay. Rejected: a Rust path for the migration alongside the SQL for incremental writes (two implementations of one definition). Reason: only a streamed pass removes the sort cost. Reversal path: restore the SQL body of `refresh_event_summaries`.
- This is not parkable as `felix-decision`: per the ledger contract's tests it chooses between working mechanisms, and one option keeps the filed defect.

## Risks / open questions
- Real Mega time cannot be measured here because no copy remains. The adopter runs `benchmark_mega_event_summaries` too if a copy is available, otherwise the report states this limit.
- Peak memory rises from about 30 MB to at most the O4 bound during this one-time step on the very largest databases.

## Not part of this task
Upgrade progress UI or copy, making `getDatabases` progressive, cancelling a migration, adding Events indexes, and other migration arms' player-count backfill.

## Phases

### Phase 1: streamed event-summary aggregation
Files: `src-tauri/src/db/event_summaries.rs`, `src-tauri/src/db/migrations.rs`, `src-tauri/src/db/event_summary_tests.rs`.
Touches persistence inside the caller's transaction. Role: sensitive.
Tests:
- Keep every existing `assert_event_summaries` call.
- Add a test seeding edge rows (the `summaries_cover_edges` shapes, site ties, a dirty event with no games, multi-event games) that runs both the ordinary refresh and the migration row source and asserts identical results through the oracle.
- Prove red by breaking one semantic rule (tie-break, `?` filter or rating filter) locally and confirming the new test fails, then restore it.
- Replace the `event_summary_refresh` failure injection in both rollback tests with a `CREATE TEMP TRIGGER` named outside `protect_unknown_%` that raises `ABORT` on any `UPDATE` of `Events`. Keep every existing rollback and retry assertion for all migration origins, drop the trigger before the retry, and assert the error carries the injected message so the failure is proven to come from the summary write.
- Add a test proving the row source through the production callers: the test-only record shows `refresh_derived_database_data` used the indexed source and `migrate_event_summaries` the full scan, and `EXPLAIN QUERY PLAN` of the indexed source shows a `games_event_idx` search and no full scan of Games.
- Add one `#[ignore]` test named `event_summary_migration_scale`, beside `benchmark_mega_event_summaries`. It builds a generated 2.2.0 database of 11,441,614 games and 70,038 events at the path named by `EVENT_SUMMARY_BENCH_DB` using `pre_event_summary_schema`, with 200-game runs per event and random players, then prints the elapsed time of `get_db_info_blocking` on it through the `database_app_with_grant` fixture, covering migration, acquisition and metadata.

PROOF COMMAND (3 commands):
PATH="$HOME/.cargo/bin:$PATH" cargo test --manifest-path src-tauri/Cargo.toml --locked --bins -- db::event_summar db::migrations::
PATH="$HOME/.cargo/bin:$PATH" EVENT_SUMMARY_BENCH_DB="$RUN_TMP/bench.db3" /usr/bin/time -f "maxrss=%MkB" cargo test --manifest-path src-tauri/Cargo.toml --locked --release --bins -- --ignored --nocapture event_summary_migration_scale
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check

Acceptance: at load average below 5, the printed `get_db_info_blocking` time is at most 10 s (baseline about 31 s on this shape, derivation in O6), and peak RSS reported for the test process is at most 1.2 GB (worst-case scratch measurement 686 MB, retaining every streamed row is estimated to add about 1 GB). `/usr/bin/time` measures the slowest child, so the orchestrator confirms the reported value belongs to the test binary, not the compiler, by building first and rerunning. The orchestrator reruns it and records both numbers. If a Mega copy is available, it also runs `benchmark_mega_event_summaries` and records the real time. A missed limit stops the phase for arbitration, it is never relaxed by editing the number.

## Reviews

### Round 1 (plan-r1, 12 lenses: plan, correctness, error-handling, minimalism, tests, chess-semantics, engine-protocol, ipc-contract, persisted-state, pgn-index, platform-semantics, tauri-security)
Verdicts: plan REVISE, tests REVISE, correctness, error-handling, minimalism, pgn-index, platform-semantics APPROVED, chess-semantics, engine-protocol, ipc-contract, persisted-state, tauri-security NOT APPLICABLE and APPROVED. root-cause and code-quality are diff-only (`plan-review: false`).
- I1 Rollback tests inject failure through the removed temporary table. Witnesses: plan #1, tests #1. Verified at `migrations.rs:920,1051`. MANDATE obligation: the fix must not lose rollback coverage. Fix: temp-trigger injection, Phase 1 tests. Open for r2 closure.
- I2 Acceptance permitted about 10 s of migration alone while O6 claims about 5 s, excluding acquisition and metadata. Witness: plan #2. Fix: measure `get_db_info_blocking`, derive the limit from the real-to-generated ratio in O6. Open for r2 closure.
- I3 No proof that ordinary refreshes avoid a full Games scan. Witnesses: plan #3, tests #2. Fix: source-recording test through production callers plus EXPLAIN QUERY PLAN. Open for r2 closure.
- I4 `update_database_counts` no longer exists. Witness: plan #4. Verified by `git grep`. Fix: decision names `refresh_derived_database_data`. Open for r2 closure.
- I5 O4's memory bound had no proof against the real implementation. Witness: tests #3. Fix: peak-RSS limit in acceptance. Open for r2 closure.

### plan-r3.md

# Plan: remove the long one-time 2.3.0 event-summary migration wait

## Goal
Bring the one-time 2.2.0 to 2.3.0 migration of a Mega-sized database back to the wait d-20261108-02 accepted (about 5 s) by replacing the sort-heavy backfill, so the Library's existing loading line stays correct and no new upgrade state is needed.

## MANDATE
f-20261108-05, verbatim:

One-time 2.3.0 event-summary migration holds the library on the generic loading line for about 24 s on Mega Database 2025

* **Where:** `migrate_event_summaries` in `src-tauri/src/db/migrations.rs` (Games(EventID) index build plus full backfill) during `validate_existing_database`, shown through the library listing in `src/components/databases/useDatabaseLibrary.tsx`.
* **Defect:** the 2.2.0 to 2.3.0 upgrade runs synchronously when a database is first opened by a build containing it, and the library shows only its generic loading line meanwhile. d-20261108-02 accepted a wait of about 5 s and named filing a finding as its reversal path if a measured wait noticeably exceeds an ordinary listing.
* **Failure scenario:** release-profile benchmark `db::event_summary_tests::benchmark_mega_event_summaries` on a copy of Mega Database 2025 (11,441,614 games, 70,039 events, schema 2.2.0), 2026-11-08, machine load average about 42: migration plus acquisition took 23.55 s, once per database.
* **Open question:** should the listing show a per-database one-time upgrade state, or is a wait of this size acceptable for databases of this size?

## Threat model and non-goals
Input is a user-selected or previously imported SQLite database, including legacy rows with odd but schema-valid values (NULL dates, `?`-prefixed partial dates, zero or negative ratings, Unknown ID 0). No adversary deliberately crafting a database to exhaust memory is in scope. Migration remains synchronous, uncancellable from the listing, and inside the caller's transaction exactly as today.

## Traced premises
Frozen at BASE 3f009694.
- `src-tauri/src/db/migrations.rs:351-363` `migrate_event_summaries` adds the columns, runs `event_summaries_sql()` (index, dirty table, triggers), marks every non-zero event dirty and calls `refresh_event_summaries`.
- `src-tauri/src/db/event_summaries.rs:5-53` `refresh_event_summaries` is one SQL script. `dirty_games` is `NOT MATERIALIZED`, so `totals`, both halves of `participants` and `ranked_sites` each re-read the rows and sort or deduplicate them.
- `src-tauri/src/db/mod.rs:4323-4324` `refresh_derived_database_data` is the only other caller. It runs for every production write path, normally over a small dirty set.
- `src-tauri/src/db/migrations.rs:213-248,318` all four upgrade arms reach `migrate_event_summaries`, each inside a transaction.
- `src/utils/db.ts:275-279` `getDatabases` fetches metadata with `collectSequential`, and `src/components/databases/useDatabaseLibrary.tsx:320-324` shows only `Library.DatabasesLoading` until the whole list resolves. `get_db_info` reaches the migration through `get_db_or_create` (`src-tauri/src/db/mod.rs:1837`).
- `src-tauri/src/db/event_summary_tests.rs:5-84` `assert_event_summaries` is an independent Rust oracle, already called by the write-path tests. `src-tauri/src/db/migrations.rs:809` `pre_event_summary_schema` builds a 2.2.0 schema for tests.
- Existing streaming precedent: `load_iter::<_, DefaultLoadingMode>` at `src-tauri/src/db/mod.rs:3448` over a `sql_query`.

- `src-tauri/src/db/migrations.rs:920,1051` inject the rollback failure by pre-creating a temporary `event_summary_refresh` table, which only works while the refresh creates that table.
- `src-tauri/src/db/migrations.rs:17-22` `take_content_pragma_counts` is the existing test-only thread-local counter precedent. `validate_sentinel_records_and_triggers` inspects only `protect_unknown_%` triggers, so a differently named TEMP trigger does not trip validation.

Measurements (2026-11-08, load average about 1, synthetic 11,441,614-game and 70,038-event database on tmpfs, 200-game runs per event, random players, SQLite CLI 3.45.1 and scratch crates pinned to the app's diesel 2.1.4 and bundled libsqlite3-sys 0.25.2; no Mega copy exists on this machine any more):
- `CREATE INDEX games_event_idx`: 2.26 s.
- Current refresh SQL: 28.5 to 29.8 s. Components: totals 9.3 s, participants 13.1 s, sites 9.4 s.
- Rejected tunings, all with the same result: `MATERIALIZED` narrow CTE 23.8 s; table scan with dirty lookup 27.4 s (26.0 s materialized); `PRAGMA cache_size` 1 GB 27.4 s; `PRAGMA threads` 4 or 8 with a large cache 27.5 to 28.6 s. Sorting and deduplication dominate, a plain narrow table scan costs 0.58 s.
- One-pass Rust aggregation over a rowid-order scan: rusqlite 3.04 s scan and aggregate plus 0.14 s update, identical checksums to the SQL over every summary column. Through Diesel `sql_query` plus `load_iter`: 4.72 s, peak RSS 686 MB at 22,876,980 distinct (event, player) pairs, the worst case for this data shape because players are random per game.
- Row-width sensitivity: the same Diesel pass on a 4.28 GB generated database (282-byte Moves, same rows) took 5.71 s, index 2.41 s, so a wider real file adds about a second on tmpfs. Disk read cost was not measured.
- The real-app measurement in `tasks/handoffs/2026-11-08-event-summary-columns-review.md` was 12.7 to 15.2 s for the whole listing, so synthetic SQL time is pessimistic against real Mega.

## Approach

### O1 One aggregation implementation
`refresh_event_summaries` computes summaries by streaming rows into per-event accumulators in Rust and writing the results. The SQL script is removed, so the migration and every write path share one implementation (universal rule 11, async-resource "second implementation gets extracted"). Semantics are exactly those of the removed SQL and of `assert_event_summaries`:
GameCount counts every game of the event. StartDate and EndDate are the bytewise minimum and maximum of non-NULL dates not beginning with `?`. PlayerCount is the number of distinct non-zero White or Black IDs. SiteID is the most frequent non-zero site, ties to the lowest ID, 0 when none. AvgElo is the mean of all positive rating slots across both colours, rounded half away from zero, NULL when none.

### O2 Row source chosen by the caller
Ordinary refreshes read the games of dirty events through `games_event_idx`, as today, so a small dirty set never scans Games. The migration backfill reads Games once in rowid order. Only the row source differs, never the accumulation or write. Both sources use only the seven columns the aggregation needs. `refresh_derived_database_data` uses the indexed source and `migrate_event_summaries` the full scan, and the test build records which one each used.

### O3 Writes and the dirty contract
Exactly the dirty non-zero events are written, including dirty events that have no remaining games (zero counts, NULL dates and AvgElo, SiteID 0). Event 0 and non-dirty events are untouched. The dirty table is empty afterwards. All writes happen on the caller's connection inside the caller's transaction, so any failure leaves no partial summaries. No temporary table remains in use.

### O4 Bounded memory
Accumulators hold counters, two date strings, and one entry per distinct (event, player) and (event, site) pair. Games rows are never retained. The measured worst case is above: 686 MB at 22.9 M distinct pairs, at most two entries per game.

### O5 Failure handling
Row and write failures return the existing typed `Error` through the caller's transaction. No `unwrap`, `expect` or panic on database-driven values. Rating arithmetic cannot overflow (`f64` accumulation, `i64` counts).

### O6 The open question is answered by removing the wait
No per-database upgrade state, event, binding or renderer change.

Whether this restores the about 5 s that d-20261108-02 accepted on real Mega is not established by a generated database, because the old SQL's synthetic-to-real ratio does not carry over to a different algorithm. The plan therefore claims only what it proves: the sort-heavy backfill is gone, and the generated-database limit in Phase 1 catches a regression to it. Estimated real wait from the probes is 5 to 9 s on this hardware before disk costs (index about 2.4 s, pass 4.7 to 5.7 s, plus writes), and real Mega should be lower because its games repeat players within an event.

Real Mega is measured whenever a copy exists: at or below 7 s through the production path closes the finding as restored. Above 7 s the finding stays open with the measurement and the listing-state question returns with that evidence. If no copy exists at adoption, the closing note states that the real wait was not measured, and d-20261108-02's reversal path (file a finding on a measured overrun) remains the backstop.

## Decisions and trade-offs
Decided autonomously:
- **Answer to the open question.** Question: should the listing show a per-database one-time upgrade state, or is the wait acceptable? Chosen: neither, shrink the wait to the size d-20261108-02 accepted. Rejected: a dedicated upgrade state (new event, binding and renderer state for a once-per-database wait, which explains the wait instead of removing it, rule 6d), accepting about 24 s (the wait d-20261108-02 explicitly did not accept), a background backfill (Events would show blank summaries, plus a new long-lived write job). Reason: measured about 6x reduction with no user-visible change. Reversal path: restore the SQL script from git and file a finding if a real-database measurement stays well above 5 s.
- **Amends d-20261108-11's "one set-based recomputation".** Chosen: one streamed Rust aggregation over the same dirty set and triggers, new evidence being the 28 s backfill measured above, which d-20261108-11 did not have. Dirty tracking, the choke point at `refresh_derived_database_data` (named `update_database_counts` when d-20261108-11 was written), `games_event_idx` and every summary definition stay. Rejected: a Rust path for the migration alongside the SQL for incremental writes (two implementations of one definition). Reason: only a streamed pass removes the sort cost. Reversal path: restore the SQL body of `refresh_event_summaries`.
- This is not parkable as `felix-decision`: per the ledger contract's tests it chooses between working mechanisms, and one option keeps the filed defect.

## Risks / open questions
- Real Mega time cannot be measured here because no copy remains, so restoration of the accepted wait stays unverified until O6's measurement runs. Disk read cost was not probed.
- Peak memory rises from about 30 MB to at most the O4 bound during this one-time step on the very largest databases.

## Not part of this task
Upgrade progress UI or copy, making `getDatabases` progressive, cancelling a migration, adding Events indexes, and other migration arms' player-count backfill.

## Phases

### Phase 1: streamed event-summary aggregation
Files: `src-tauri/src/db/event_summaries.rs`, `src-tauri/src/db/migrations.rs`, `src-tauri/src/db/event_summary_tests.rs`.
Touches persistence inside the caller's transaction. Role: sensitive.
Tests:
- Keep every existing `assert_event_summaries` call.
- Add a test seeding edge rows (the `summaries_cover_edges` shapes, site ties, a dirty event with no games, multi-event games) that runs both the ordinary refresh and the migration row source and asserts identical results through the oracle.
- Prove red by breaking one semantic rule (tie-break, `?` filter or rating filter) locally and confirming the new test fails, then restore it.
- Replace the `event_summary_refresh` failure injection in both rollback tests with a `CREATE TEMP TRIGGER` named outside `protect_unknown_%` that raises `ABORT` on any `UPDATE` of `Events`. Keep every existing rollback and retry assertion for all migration origins, drop the trigger before the retry, and assert the error carries the injected message so the failure is proven to come from the summary write.
- Add a test proving the row source through the production callers: the test-only record shows `refresh_derived_database_data` used the indexed source and `migrate_event_summaries` the full scan, and `EXPLAIN QUERY PLAN` of the indexed source shows a `games_event_idx` search and no full scan of Games.
- Add one `#[ignore]` test named `event_summary_migration_scale`, beside `benchmark_mega_event_summaries`. It builds a generated 2.2.0 database of 11,441,614 games and 70,038 events at the path named by `EVENT_SUMMARY_BENCH_DB` using `pre_event_summary_schema`, with 200-game runs per event and random players, generation skipped when the file already exists, then prints the elapsed time of `get_db_info_blocking` on it through the `database_app_with_grant` fixture, covering migration, acquisition and metadata.

PROOF COMMAND (3 commands):
PATH="$HOME/.cargo/bin:$PATH" cargo test --manifest-path src-tauri/Cargo.toml --locked --bins -- db::event_summar db::migrations::
PATH="$HOME/.cargo/bin:$PATH" EVENT_SUMMARY_BENCH_DB="$RUN_TMP/bench.db3" /usr/bin/time -f "maxrss=%MkB" cargo test --manifest-path src-tauri/Cargo.toml --locked --release --bins -- --ignored --nocapture event_summary_migration_scale
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check

Acceptance: at load average below 5, the printed `get_db_info_blocking` time is at most 10 s (baseline about 31 s on this shape, a regression guard and not a proof of the real wait, see O6), and peak RSS reported for the test process is at most 1.2 GB (worst-case scratch measurement 686 MB, retaining every streamed row is estimated to add about 1 GB). `/usr/bin/time` measures the slowest child, so the orchestrator confirms the reported value belongs to the test binary, not the compiler, by building first and rerunning. The orchestrator reruns it and records both numbers. If a Mega copy is available, it also measures that copy through `get_db_info_blocking` (a 2.2.0 file at the `EVENT_SUMMARY_BENCH_DB` path, with generation skipped when the file already exists) and applies O6's 7 s rule. A missed limit stops the phase for arbitration, it is never relaxed by editing the number.

## Reviews

### Round 1 (plan-r1, 12 lenses: plan, correctness, error-handling, minimalism, tests, chess-semantics, engine-protocol, ipc-contract, persisted-state, pgn-index, platform-semantics, tauri-security)
Verdicts: plan REVISE, tests REVISE, correctness, error-handling, minimalism, pgn-index, platform-semantics APPROVED, chess-semantics, engine-protocol, ipc-contract, persisted-state, tauri-security NOT APPLICABLE and APPROVED. root-cause and code-quality are diff-only (`plan-review: false`).
- I1 Rollback tests inject failure through the removed temporary table. Witnesses: plan #1, tests #1. Verified at `migrations.rs:920,1051`. MANDATE obligation: the fix must not lose rollback coverage. Fix: temp-trigger injection, Phase 1 tests. Open for r2 closure.
- I2 Acceptance permitted about 10 s of migration alone while O6 claims about 5 s, excluding acquisition and metadata. Witness: plan #2. Fix: measure `get_db_info_blocking`, derive the limit from the real-to-generated ratio in O6. Open for r2 closure.
- I3 No proof that ordinary refreshes avoid a full Games scan. Witnesses: plan #3, tests #2. Fix: source-recording test through production callers plus EXPLAIN QUERY PLAN. Open for r2 closure.
- I4 `update_database_counts` no longer exists. Witness: plan #4. Verified by `git grep`. Fix: decision names `refresh_derived_database_data`. Open for r2 closure.
- I5 O4's memory bound had no proof against the real implementation. Witness: tests #3. Fix: peak-RSS limit in acceptance. Open for r2 closure.

### Round 2 (plan-r2, review-plan, review-tests)
Verdicts: plan REVISE, tests APPROVED. I1, I3, I4, I5 CLOSED by review-plan, I1, I3, I5 also by review-tests.
- I2 NOT CLOSED (plan r2 #1): the old SQL's generated-to-real ratio does not carry over to the new algorithm. Correction: O6 no longer claims restoration from generated data, states the estimate and limits, and makes real measurement the closing evidence with an explicit outcome for each case. Added row-width probe. Open for r3 closure.

### plan-r4.md

# Plan: remove the long one-time 2.3.0 event-summary migration wait

## Goal
Bring the one-time 2.2.0 to 2.3.0 migration of a Mega-sized database back to the wait d-20261108-02 accepted (about 5 s) by replacing the sort-heavy backfill, so the Library's existing loading line stays correct and no new upgrade state is needed.

## MANDATE
f-20261108-05, verbatim:

One-time 2.3.0 event-summary migration holds the library on the generic loading line for about 24 s on Mega Database 2025

* **Where:** `migrate_event_summaries` in `src-tauri/src/db/migrations.rs` (Games(EventID) index build plus full backfill) during `validate_existing_database`, shown through the library listing in `src/components/databases/useDatabaseLibrary.tsx`.
* **Defect:** the 2.2.0 to 2.3.0 upgrade runs synchronously when a database is first opened by a build containing it, and the library shows only its generic loading line meanwhile. d-20261108-02 accepted a wait of about 5 s and named filing a finding as its reversal path if a measured wait noticeably exceeds an ordinary listing.
* **Failure scenario:** release-profile benchmark `db::event_summary_tests::benchmark_mega_event_summaries` on a copy of Mega Database 2025 (11,441,614 games, 70,039 events, schema 2.2.0), 2026-11-08, machine load average about 42: migration plus acquisition took 23.55 s, once per database.
* **Open question:** should the listing show a per-database one-time upgrade state, or is a wait of this size acceptable for databases of this size?

## Threat model and non-goals
Input is a user-selected or previously imported SQLite database, including legacy rows with odd but schema-valid values (NULL dates, `?`-prefixed partial dates, zero or negative ratings, Unknown ID 0). No adversary deliberately crafting a database to exhaust memory is in scope. Migration remains synchronous, uncancellable from the listing, and inside the caller's transaction exactly as today.

## Traced premises
Frozen at BASE 3f009694.
- `src-tauri/src/db/migrations.rs:351-363` `migrate_event_summaries` adds the columns, runs `event_summaries_sql()` (index, dirty table, triggers), marks every non-zero event dirty and calls `refresh_event_summaries`.
- `src-tauri/src/db/event_summaries.rs:5-53` `refresh_event_summaries` is one SQL script. `dirty_games` is `NOT MATERIALIZED`, so `totals`, both halves of `participants` and `ranked_sites` each re-read the rows and sort or deduplicate them.
- `src-tauri/src/db/mod.rs:4323-4324` `refresh_derived_database_data` is the only other caller. It runs for every production write path, normally over a small dirty set.
- `src-tauri/src/db/migrations.rs:213-248,318` all four upgrade arms reach `migrate_event_summaries`, each inside a transaction.
- `src/utils/db.ts:275-279` `getDatabases` fetches metadata with `collectSequential`, and `src/components/databases/useDatabaseLibrary.tsx:320-324` shows only `Library.DatabasesLoading` until the whole list resolves. `get_db_info` reaches the migration through `get_db_or_create` (`src-tauri/src/db/mod.rs:1837`).
- `src-tauri/src/db/event_summary_tests.rs:5-84` `assert_event_summaries` is an independent Rust oracle, already called by the write-path tests. `src-tauri/src/db/migrations.rs:809` `pre_event_summary_schema` builds a 2.2.0 schema for tests.
- Existing streaming precedent: `load_iter::<_, DefaultLoadingMode>` at `src-tauri/src/db/mod.rs:3448` over a `sql_query`.

- `src-tauri/src/db/migrations.rs:920,1051` inject the rollback failure by pre-creating a temporary `event_summary_refresh` table, which only works while the refresh creates that table.
- `src-tauri/src/db/migrations.rs:17-22` `take_content_pragma_counts` is the existing test-only thread-local counter precedent. `validate_sentinel_records_and_triggers` inspects only `protect_unknown_%` triggers, so a differently named TEMP trigger does not trip validation.

Measurements (2026-11-08, load average about 1, synthetic 11,441,614-game and 70,038-event database on tmpfs, 200-game runs per event, random players, SQLite CLI 3.45.1 and scratch crates pinned to the app's diesel 2.1.4 and bundled libsqlite3-sys 0.25.2; no Mega copy exists on this machine any more):
- `CREATE INDEX games_event_idx`: 2.26 s.
- Current refresh SQL: 28.5 to 29.8 s. Components: totals 9.3 s, participants 13.1 s, sites 9.4 s.
- Rejected tunings, all with the same result: `MATERIALIZED` narrow CTE 23.8 s; table scan with dirty lookup 27.4 s (26.0 s materialized); `PRAGMA cache_size` 1 GB 27.4 s; `PRAGMA threads` 4 or 8 with a large cache 27.5 to 28.6 s. Sorting and deduplication dominate, a plain narrow table scan costs 0.58 s.
- One-pass Rust aggregation over a rowid-order scan: rusqlite 3.04 s scan and aggregate plus 0.14 s update, identical checksums to the SQL over every summary column. Through Diesel `sql_query` plus `load_iter`: 4.72 s, peak RSS 686 MB at 22,876,980 distinct (event, player) pairs, the worst case for this data shape because players are random per game.
- Row-width sensitivity: the same Diesel pass on a 4.28 GB generated database (282-byte Moves, same rows) took 5.71 s, index 2.41 s, so a wider real file adds about a second on tmpfs. Disk read cost was not measured.
- The real-app measurement in `tasks/handoffs/2026-11-08-event-summary-columns-review.md` was 12.7 to 15.2 s for the whole listing, so synthetic SQL time is pessimistic against real Mega.

## Approach

### O1 One aggregation implementation
`refresh_event_summaries` computes summaries by streaming rows into per-event accumulators in Rust and writing the results. The SQL script is removed, so the migration and every write path share one implementation (universal rule 11, async-resource "second implementation gets extracted"). Semantics are exactly those of the removed SQL and of `assert_event_summaries`:
GameCount counts every game of the event. StartDate and EndDate are the bytewise minimum and maximum of non-NULL dates not beginning with `?`. PlayerCount is the number of distinct non-zero White or Black IDs. SiteID is the most frequent non-zero site, ties to the lowest ID, 0 when none. AvgElo is the mean of all positive rating slots across both colours, rounded half away from zero, NULL when none.

### O2 Row source chosen by the caller
Ordinary refreshes read the games of dirty events through `games_event_idx`, as today, so a small dirty set never scans Games. The migration backfill reads Games once in rowid order. Only the row source differs, never the accumulation or write. Both sources use only the seven columns the aggregation needs. `refresh_derived_database_data` uses the indexed source and `migrate_event_summaries` the full scan, and the test build records which one each used.

### O3 Writes and the dirty contract
Exactly the dirty non-zero events are written, including dirty events that have no remaining games (zero counts, NULL dates and AvgElo, SiteID 0). Event 0 and non-dirty events are untouched. The dirty table is empty afterwards. All writes happen on the caller's connection inside the caller's transaction, so any failure leaves no partial summaries. No temporary table remains in use.

### O4 Bounded memory
Accumulators hold counters, two date strings, and one entry per distinct (event, player) and (event, site) pair. Games rows are never retained. The measured worst case is above: 686 MB at 22.9 M distinct pairs, at most two entries per game.

### O5 Failure handling
Row and write failures return the existing typed `Error` through the caller's transaction. No `unwrap`, `expect` or panic on database-driven values. Rating arithmetic cannot overflow (`f64` accumulation, `i64` counts).

### O6 The open question is answered by removing the wait
No per-database upgrade state, event, binding or renderer change.

Whether this restores the about 5 s that d-20261108-02 accepted on real Mega is not established by a generated database, because the old SQL's synthetic-to-real ratio does not carry over to a different algorithm. The plan therefore claims only what it proves: the sort-heavy backfill is gone, and the generated-database limit in Phase 1 catches a regression to it. Estimated real wait from the probes is 5 to 9 s on this hardware before disk costs (index about 2.4 s, pass 4.7 to 5.7 s, plus writes), and real Mega should be lower because its games repeat players within an event.

Real Mega is measured whenever a copy exists: at or below 7 s through the production path closes the finding as restored. Above 7 s the finding stays open with the measurement and the listing-state question returns with that evidence. If no copy exists at adoption, the closing note states that the real wait was not measured, and d-20261108-02's reversal path (file a finding on a measured overrun) remains the backstop.

## Decisions and trade-offs
Decided autonomously:
- **Answer to the open question.** Question: should the listing show a per-database one-time upgrade state, or is the wait acceptable? Chosen: neither, shrink the wait to the size d-20261108-02 accepted. Rejected: a dedicated upgrade state (new event, binding and renderer state for a once-per-database wait, which explains the wait instead of removing it, rule 6d), accepting about 24 s (the wait d-20261108-02 explicitly did not accept), a background backfill (Events would show blank summaries, plus a new long-lived write job). Reason: measured about 6x reduction with no user-visible change. Reversal path: restore the SQL script from git and file a finding if a real-database measurement stays well above 5 s.
- **Amends d-20261108-11's "one set-based recomputation".** Chosen: one streamed Rust aggregation over the same dirty set and triggers, new evidence being the 28 s backfill measured above, which d-20261108-11 did not have. Dirty tracking, the choke point at `refresh_derived_database_data` (named `update_database_counts` when d-20261108-11 was written), `games_event_idx` and every summary definition stay. Rejected: a Rust path for the migration alongside the SQL for incremental writes (two implementations of one definition). Reason: only a streamed pass removes the sort cost. Reversal path: restore the SQL body of `refresh_event_summaries`.
- This is not parkable as `felix-decision`: per the ledger contract's tests it chooses between working mechanisms, and one option keeps the filed defect.

## Risks / open questions
- Real Mega time cannot be measured here because no copy remains, so restoration of the accepted wait stays unverified until O6's measurement runs. Disk read cost was not probed.
- Peak memory rises from about 30 MB to at most the O4 bound during this one-time step on the very largest databases.

## Not part of this task
Upgrade progress UI or copy, making `getDatabases` progressive, cancelling a migration, adding Events indexes, and other migration arms' player-count backfill.

## Phases

### Phase 1: streamed event-summary aggregation
Files: `src-tauri/src/db/event_summaries.rs`, `src-tauri/src/db/migrations.rs`, `src-tauri/src/db/event_summary_tests.rs`.
Touches persistence inside the caller's transaction. Role: sensitive.
Tests:
- Keep every existing `assert_event_summaries` call.
- Add a test seeding edge rows (the `summaries_cover_edges` shapes, site ties, a dirty event with no games, multi-event games) that runs both the ordinary refresh and the migration row source and asserts identical results through the oracle.
- Prove red by breaking one semantic rule (tie-break, `?` filter or rating filter) locally and confirming the new test fails, then restore it.
- Replace the `event_summary_refresh` failure injection in both rollback tests with a `CREATE TEMP TRIGGER` named outside `protect_unknown_%` that raises `ABORT` on any `UPDATE` of `Events`. Keep every existing rollback and retry assertion for all migration origins, drop the trigger before the retry, and assert the error carries the injected message so the failure is proven to come from the summary write.
- Add a test proving the row source through the production callers: the test-only record shows `refresh_derived_database_data` used the indexed source and `migrate_event_summaries` the full scan, and `EXPLAIN QUERY PLAN` of the indexed source shows a `games_event_idx` search and no full scan of Games.
- Add one `#[ignore]` test named `event_summary_migration_scale`, beside `benchmark_mega_event_summaries`. It builds a generated 2.2.0 database of 11,441,614 games and 70,038 events as an immutable seed at the path named by `EVENT_SUMMARY_BENCH_SEED` using `pre_event_summary_schema`, with 200-game runs per event and random players, generating it only when absent. Every run copies the seed to a fresh disposable sibling file, asserts the copy's `Version` is 2.2.0 before and 2.3.0 after, and prints the elapsed time of `get_db_info_blocking` on the copy through the `database_app_with_grant` fixture, covering migration, acquisition and metadata. The copy is deleted at the end, the seed is never opened for writing. Elapsed time starts after the copy.

PROOF COMMAND (3 commands):
PATH="$HOME/.cargo/bin:$PATH" cargo test --manifest-path src-tauri/Cargo.toml --locked --bins -- db::event_summar db::migrations::
PATH="$HOME/.cargo/bin:$PATH" EVENT_SUMMARY_BENCH_SEED="$RUN_TMP/bench-seed.db3" /usr/bin/time -f "maxrss=%MkB" cargo test --manifest-path src-tauri/Cargo.toml --locked --release --bins -- --ignored --nocapture event_summary_migration_scale
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check

Acceptance: at load average below 5, the printed `get_db_info_blocking` time is at most 10 s (baseline about 31 s on this shape, a regression guard and not a proof of the real wait, see O6), and peak RSS reported for the test process is at most 1.2 GB (worst-case scratch measurement 686 MB, retaining every streamed row is estimated to add about 1 GB). `/usr/bin/time` measures the slowest child, so the orchestrator confirms the reported value belongs to the test binary, not the compiler, by building first and rerunning, and the seed's own generation counts only against the first run, so the recorded numbers come from a rerun against the existing seed. The orchestrator reruns it and records both numbers. If a Mega copy is available, it also measures that copy through `get_db_info_blocking` (a 2.2.0 copy supplied as the `EVENT_SUMMARY_BENCH_SEED` seed, so the same copy-and-assert path runs) and applies O6's 7 s rule. A missed limit stops the phase for arbitration, it is never relaxed by editing the number.

## Reviews

### Round 1 (plan-r1, 12 lenses: plan, correctness, error-handling, minimalism, tests, chess-semantics, engine-protocol, ipc-contract, persisted-state, pgn-index, platform-semantics, tauri-security)
Verdicts: plan REVISE, tests REVISE, correctness, error-handling, minimalism, pgn-index, platform-semantics APPROVED, chess-semantics, engine-protocol, ipc-contract, persisted-state, tauri-security NOT APPLICABLE and APPROVED. root-cause and code-quality are diff-only (`plan-review: false`).
- I1 Rollback tests inject failure through the removed temporary table. Witnesses: plan #1, tests #1. Verified at `migrations.rs:920,1051`. MANDATE obligation: the fix must not lose rollback coverage. Fix: temp-trigger injection, Phase 1 tests. Open for r2 closure.
- I2 Acceptance permitted about 10 s of migration alone while O6 claims about 5 s, excluding acquisition and metadata. Witness: plan #2. Fix: measure `get_db_info_blocking`, derive the limit from the real-to-generated ratio in O6. Open for r2 closure.
- I3 No proof that ordinary refreshes avoid a full Games scan. Witnesses: plan #3, tests #2. Fix: source-recording test through production callers plus EXPLAIN QUERY PLAN. Open for r2 closure.
- I4 `update_database_counts` no longer exists. Witness: plan #4. Verified by `git grep`. Fix: decision names `refresh_derived_database_data`. Open for r2 closure.
- I5 O4's memory bound had no proof against the real implementation. Witness: tests #3. Fix: peak-RSS limit in acceptance. Open for r2 closure.

### Round 2 (plan-r2, review-plan, review-tests)
Verdicts: plan REVISE, tests APPROVED. I1, I3, I4, I5 CLOSED by review-plan, I1, I3, I5 also by review-tests.
- I2 NOT CLOSED (plan r2 #1): the old SQL's generated-to-real ratio does not carry over to the new algorithm. Correction: O6 no longer claims restoration from generated data, states the estimate and limits, and makes real measurement the closing evidence with an explicit outcome for each case. Added row-width probe. Open for r3 closure.

### Round 3 (plan-r3, review-plan)
Verdict: REVISE.
- I2 NOT CLOSED (plan r3 #1): a rerun against the migrated file takes `migrations.rs:211`, skipping migration, so the time and RSS would not measure it. Verified by reading `migrations.rs:211,218`. This is the second failed closure of I2's lineage, so before patching: invariant = a measurement only counts if the run actually performs the 2.2.0 to 2.3.0 migration. Previous answer = generation skipped on an existing file. New evidence = the source trace above. Judgment = the simplest correct mechanism is an immutable seed, a fresh disposable copy per run, and Version assertions before and after. Changes: benchmark and proof command. Open for r4 fresh-context closure.

### plan-r5.md

# Plan: remove the long one-time 2.3.0 event-summary migration wait

## Goal
Bring the one-time 2.2.0 to 2.3.0 migration of a Mega-sized database back to the wait d-20261108-02 accepted (about 5 s) by replacing the sort-heavy backfill, so the Library's existing loading line stays correct and no new upgrade state is needed.

## MANDATE
f-20261108-05, verbatim:

One-time 2.3.0 event-summary migration holds the library on the generic loading line for about 24 s on Mega Database 2025

* **Where:** `migrate_event_summaries` in `src-tauri/src/db/migrations.rs` (Games(EventID) index build plus full backfill) during `validate_existing_database`, shown through the library listing in `src/components/databases/useDatabaseLibrary.tsx`.
* **Defect:** the 2.2.0 to 2.3.0 upgrade runs synchronously when a database is first opened by a build containing it, and the library shows only its generic loading line meanwhile. d-20261108-02 accepted a wait of about 5 s and named filing a finding as its reversal path if a measured wait noticeably exceeds an ordinary listing.
* **Failure scenario:** release-profile benchmark `db::event_summary_tests::benchmark_mega_event_summaries` on a copy of Mega Database 2025 (11,441,614 games, 70,039 events, schema 2.2.0), 2026-11-08, machine load average about 42: migration plus acquisition took 23.55 s, once per database.
* **Open question:** should the listing show a per-database one-time upgrade state, or is a wait of this size acceptable for databases of this size?

## Threat model and non-goals
Input is a user-selected or previously imported SQLite database, including legacy rows with odd but schema-valid values (NULL dates, `?`-prefixed partial dates, zero or negative ratings, Unknown ID 0). No adversary deliberately crafting a database to exhaust memory is in scope. Migration remains synchronous, uncancellable from the listing, and inside the caller's transaction exactly as today.

## Traced premises
Frozen at BASE 3f009694.
- `src-tauri/src/db/migrations.rs:351-363` `migrate_event_summaries` adds the columns, runs `event_summaries_sql()` (index, dirty table, triggers), marks every non-zero event dirty and calls `refresh_event_summaries`.
- `src-tauri/src/db/event_summaries.rs:5-53` `refresh_event_summaries` is one SQL script. `dirty_games` is `NOT MATERIALIZED`, so `totals`, both halves of `participants` and `ranked_sites` each re-read the rows and sort or deduplicate them.
- `src-tauri/src/db/mod.rs:4323-4324` `refresh_derived_database_data` is the only other caller. It runs for every production write path, normally over a small dirty set.
- `src-tauri/src/db/migrations.rs:213-248,318` all four upgrade arms reach `migrate_event_summaries`, each inside a transaction.
- `src/utils/db.ts:275-279` `getDatabases` fetches metadata with `collectSequential`, and `src/components/databases/useDatabaseLibrary.tsx:320-324` shows only `Library.DatabasesLoading` until the whole list resolves. `get_db_info` reaches the migration through `get_db_or_create` (`src-tauri/src/db/mod.rs:1837`).
- `src-tauri/src/db/event_summary_tests.rs:5-84` `assert_event_summaries` is an independent Rust oracle, already called by the write-path tests. `src-tauri/src/db/migrations.rs:809` `pre_event_summary_schema` builds a 2.2.0 schema for tests.
- Existing streaming precedent: `load_iter::<_, DefaultLoadingMode>` at `src-tauri/src/db/mod.rs:3448` over a `sql_query`.

- `src-tauri/src/db/migrations.rs:920,1051` inject the rollback failure by pre-creating a temporary `event_summary_refresh` table, which only works while the refresh creates that table.
- `src-tauri/src/db/migrations.rs:17-22` `take_content_pragma_counts` is the existing test-only thread-local counter precedent. `validate_sentinel_records_and_triggers` inspects only `protect_unknown_%` triggers, so a differently named TEMP trigger does not trip validation.

Measurements (2026-11-08, load average about 1, synthetic 11,441,614-game and 70,038-event database on tmpfs, 200-game runs per event, random players, SQLite CLI 3.45.1 and scratch crates pinned to the app's diesel 2.1.4 and bundled libsqlite3-sys 0.25.2; no Mega copy exists on this machine any more):
- `CREATE INDEX games_event_idx`: 2.26 s.
- Current refresh SQL: 28.5 to 29.8 s. Components: totals 9.3 s, participants 13.1 s, sites 9.4 s.
- Rejected tunings, all with the same result: `MATERIALIZED` narrow CTE 23.8 s; table scan with dirty lookup 27.4 s (26.0 s materialized); `PRAGMA cache_size` 1 GB 27.4 s; `PRAGMA threads` 4 or 8 with a large cache 27.5 to 28.6 s. Sorting and deduplication dominate, a plain narrow table scan costs 0.58 s.
- One-pass Rust aggregation over a rowid-order scan: rusqlite 3.04 s scan and aggregate plus 0.14 s update, identical checksums to the SQL over every summary column. Through Diesel `sql_query` plus `load_iter`: 4.72 s, peak RSS 686 MB at 22,876,980 distinct (event, player) pairs, the worst case for this data shape because players are random per game.
- Row-width sensitivity: the same Diesel pass on a 4.28 GB generated database (282-byte Moves, same rows) took 5.71 s, index 2.41 s, so a wider real file adds about a second on tmpfs. Disk read cost was not measured.
- The real-app measurement in `tasks/handoffs/2026-11-08-event-summary-columns-review.md` was 12.7 to 15.2 s for the whole listing, so synthetic SQL time is pessimistic against real Mega.

## Approach

### O1 One aggregation implementation
`refresh_event_summaries` computes summaries by streaming rows into per-event accumulators in Rust and writing the results. The SQL script is removed, so the migration and every write path share one implementation (universal rule 11, async-resource "second implementation gets extracted"). Semantics are exactly those of the removed SQL and of `assert_event_summaries`:
GameCount counts every game of the event. StartDate and EndDate are the bytewise minimum and maximum of non-NULL dates not beginning with `?`. PlayerCount is the number of distinct non-zero White or Black IDs. SiteID is the most frequent non-zero site, ties to the lowest ID, 0 when none. AvgElo is the mean of all positive rating slots across both colours, rounded half away from zero, NULL when none.

### O2 Row source chosen by the caller
Ordinary refreshes read the games of dirty events through `games_event_idx`, as today, so a small dirty set never scans Games. The migration backfill reads Games once in rowid order. Only the row source differs, never the accumulation or write. Both sources use only the seven columns the aggregation needs. `refresh_derived_database_data` uses the indexed source and `migrate_event_summaries` the full scan, and the test build records which one each used.

### O3 Writes and the dirty contract
Exactly the dirty non-zero events are written, including dirty events that have no remaining games (zero counts, NULL dates and AvgElo, SiteID 0). Event 0 and non-dirty events are untouched. The dirty table is empty afterwards. All writes happen on the caller's connection inside the caller's transaction, so any failure leaves no partial summaries. No temporary table remains in use.

### O4 Bounded memory
Accumulators hold counters, two date strings, and one entry per distinct (event, player) and (event, site) pair. Games rows are never retained. The measured worst case is above: 686 MB at 22.9 M distinct pairs, at most two entries per game.

### O5 Failure handling
Row and write failures return the existing typed `Error` through the caller's transaction. No `unwrap`, `expect` or panic on database-driven values. Rating arithmetic cannot overflow (`f64` accumulation, `i64` counts).

### O6 The open question is answered by removing the wait
No per-database upgrade state, event, binding or renderer change.

Whether this restores the about 5 s that d-20261108-02 accepted on real Mega is not established by a generated database, because the old SQL's synthetic-to-real ratio does not carry over to a different algorithm. The plan therefore claims only what it proves: the sort-heavy backfill is gone, and the generated-database limit in Phase 1 catches a regression to it. Estimated real wait from the probes is 5 to 9 s on this hardware before disk costs (index about 2.4 s, pass 4.7 to 5.7 s, plus writes), and real Mega should be lower because its games repeat players within an event.

Real Mega is measured whenever a copy exists: at or below 7 s through the production path closes the finding as restored. Above 7 s the finding stays open with the measurement and the listing-state question returns with that evidence. If no copy exists at adoption, the closing note states that the real wait was not measured, and d-20261108-02's reversal path (file a finding on a measured overrun) remains the backstop.

## Decisions and trade-offs
Decided autonomously:
- **Answer to the open question.** Question: should the listing show a per-database one-time upgrade state, or is the wait acceptable? Chosen: neither, shrink the wait to the size d-20261108-02 accepted. Rejected: a dedicated upgrade state (new event, binding and renderer state for a once-per-database wait, which explains the wait instead of removing it, rule 6d), accepting about 24 s (the wait d-20261108-02 explicitly did not accept), a background backfill (Events would show blank summaries, plus a new long-lived write job). Reason: measured about 6x reduction with no user-visible change. Reversal path: restore the SQL script from git and file a finding if a real-database measurement stays well above 5 s.
- **Amends d-20261108-11's "one set-based recomputation".** Chosen: one streamed Rust aggregation over the same dirty set and triggers, new evidence being the 28 s backfill measured above, which d-20261108-11 did not have. Dirty tracking, the choke point at `refresh_derived_database_data` (named `update_database_counts` when d-20261108-11 was written), `games_event_idx` and every summary definition stay. Rejected: a Rust path for the migration alongside the SQL for incremental writes (two implementations of one definition). Reason: only a streamed pass removes the sort cost. Reversal path: restore the SQL body of `refresh_event_summaries`.
- This is not parkable as `felix-decision`: per the ledger contract's tests it chooses between working mechanisms, and one option keeps the filed defect.

## Risks / open questions
- Real Mega time cannot be measured here because no copy remains, so restoration of the accepted wait stays unverified until O6's measurement runs. Disk read cost was not probed.
- Peak memory rises from about 30 MB to at most the O4 bound during this one-time step on the very largest databases.

## Not part of this task
Upgrade progress UI or copy, making `getDatabases` progressive, cancelling a migration, adding Events indexes, and other migration arms' player-count backfill.

## Phases

### Phase 1: streamed event-summary aggregation
Files: `src-tauri/src/db/event_summaries.rs`, `src-tauri/src/db/migrations.rs`, `src-tauri/src/db/event_summary_tests.rs`.
Touches persistence inside the caller's transaction. Role: sensitive.
Tests:
- Keep every existing `assert_event_summaries` call.
- Add a test seeding edge rows (the `summaries_cover_edges` shapes, site ties, a dirty event with no games, multi-event games) that runs both the ordinary refresh and the migration row source and asserts identical results through the oracle.
- Prove red by breaking one semantic rule (tie-break, `?` filter or rating filter) locally and confirming the new test fails, then restore it.
- Replace the `event_summary_refresh` failure injection in both rollback tests with a `CREATE TEMP TRIGGER` named outside `protect_unknown_%` that raises `ABORT` on any `UPDATE` of `Events`. Keep every existing rollback and retry assertion for all migration origins, drop the trigger before the retry, and assert the error carries the injected message so the failure is proven to come from the summary write.
- Add a test proving the row source through the production callers: the test-only record shows `refresh_derived_database_data` used the indexed source and `migrate_event_summaries` the full scan, and `EXPLAIN QUERY PLAN` of the indexed source shows a `games_event_idx` search and no full scan of Games.
- Add one `#[ignore]` test named `event_summary_migration_scale`, beside `benchmark_mega_event_summaries`. It builds a generated 2.2.0 database of 11,441,614 games and 70,038 events as an immutable seed at the path named by `EVENT_SUMMARY_BENCH_SEED` using `pre_event_summary_schema`, with 200-game runs per event and random players, generating it only when absent. Every run copies the seed to a fresh disposable sibling file, asserts the copy's `Version` is 2.2.0 before and 2.3.0 after, and prints the elapsed time of `get_db_info_blocking` on the copy through the `database_app_with_grant` fixture, covering migration, acquisition and metadata. The copy is deleted at the end, the seed is never opened for writing. Elapsed time starts after the copy.

PROOF COMMAND (3 commands):
PATH="$HOME/.cargo/bin:$PATH" cargo test --manifest-path src-tauri/Cargo.toml --locked --bins -- db::event_summar db::migrations::
PATH="$HOME/.cargo/bin:$PATH" EVENT_SUMMARY_BENCH_SEED="$RUN_TMP/bench-seed.db3" /usr/bin/time -f "maxrss=%MkB" cargo test --manifest-path src-tauri/Cargo.toml --locked --release --bins -- --ignored --nocapture event_summary_migration_scale
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check

Acceptance: at load average below 5, the printed `get_db_info_blocking` time is at most 10 s (baseline about 31 s on this shape, a regression guard and not a proof of the real wait, see O6), and peak RSS reported for the test process is at most 1.2 GB (worst-case scratch measurement 686 MB, retaining every streamed row is estimated to add about 1 GB). `/usr/bin/time` measures the slowest child, so the orchestrator confirms the reported value belongs to the test binary, not the compiler, by building first and rerunning, and the seed's own generation counts only against the first run, so the recorded numbers come from a rerun against the existing seed. The orchestrator reruns it and records both numbers. If a Mega copy is available, it also measures that copy through `get_db_info_blocking` (a 2.2.0 copy supplied as the `EVENT_SUMMARY_BENCH_SEED` seed, so the same copy-and-assert path runs) and applies O6's 7 s rule. A missed limit stops the phase for arbitration, it is never relaxed by editing the number.

## Reviews

### Round 1 (plan-r1, 12 lenses: plan, correctness, error-handling, minimalism, tests, chess-semantics, engine-protocol, ipc-contract, persisted-state, pgn-index, platform-semantics, tauri-security)
Verdicts: plan REVISE, tests REVISE, correctness, error-handling, minimalism, pgn-index, platform-semantics APPROVED, chess-semantics, engine-protocol, ipc-contract, persisted-state, tauri-security NOT APPLICABLE and APPROVED. root-cause and code-quality are diff-only (`plan-review: false`).
- I1 Rollback tests inject failure through the removed temporary table. Witnesses: plan #1, tests #1. Verified at `migrations.rs:920,1051`. MANDATE obligation: the fix must not lose rollback coverage. Fix: temp-trigger injection, Phase 1 tests. Open for r2 closure.
- I2 Acceptance permitted about 10 s of migration alone while O6 claims about 5 s, excluding acquisition and metadata. Witness: plan #2. Fix: measure `get_db_info_blocking`, derive the limit from the real-to-generated ratio in O6. Open for r2 closure.
- I3 No proof that ordinary refreshes avoid a full Games scan. Witnesses: plan #3, tests #2. Fix: source-recording test through production callers plus EXPLAIN QUERY PLAN. Open for r2 closure.
- I4 `update_database_counts` no longer exists. Witness: plan #4. Verified by `git grep`. Fix: decision names `refresh_derived_database_data`. Open for r2 closure.
- I5 O4's memory bound had no proof against the real implementation. Witness: tests #3. Fix: peak-RSS limit in acceptance. Open for r2 closure.

### Round 2 (plan-r2, review-plan, review-tests)
Verdicts: plan REVISE, tests APPROVED. I1, I3, I4, I5 CLOSED by review-plan, I1, I3, I5 also by review-tests.
- I2 NOT CLOSED (plan r2 #1): the old SQL's generated-to-real ratio does not carry over to the new algorithm. Correction: O6 no longer claims restoration from generated data, states the estimate and limits, and makes real measurement the closing evidence with an explicit outcome for each case. Added row-width probe. Open for r3 closure.

### Round 3 (plan-r3, review-plan)
Verdict: REVISE.
- I2 NOT CLOSED (plan r3 #1): a rerun against the migrated file takes `migrations.rs:211`, skipping migration, so the time and RSS would not measure it. Verified by reading `migrations.rs:211,218`. This is the second failed closure of I2's lineage, so before patching: invariant = a measurement only counts if the run actually performs the 2.2.0 to 2.3.0 migration. Previous answer = generation skipped on an existing file. New evidence = the source trace above. Judgment = the simplest correct mechanism is an immutable seed, a fresh disposable copy per run, and Version assertions before and after. Changes: benchmark and proof command. Open for r4 fresh-context closure.

### Round 4 (plan-r4, review-plan, focused fresh-context judgment for I2)
Verdict: APPROVED. I2 CLOSED: the per-run copy and Version assertions prevent the already-migrated branch at `migrations.rs:211`, and O6 distinguishes the regression guard from the unverified real wait.
Totals: rounds 4, unique issues 5 (I1 to I5), all Fix, none deferred or skipped. Adoptions r1=7 r2=1 r3=1 r4=0. Wall seconds per round [123.9, 178.4, 77.9, 74.6]. Real Mega timing stays an explicit open measurement in O6.

---

# Cumulative diff review (adopting session da2f5271, 2026-11-08)

Executor Codex wrote the code and ran the lenses, so review was same-family, with Claude Code (Opus 5.5) arbitrating. Commit ids predate the final rebase wherever they appear. The landed code commit carries the subject `perf(db): stream event summaries instead of sorting them in SQL`.

**Round 1 is void.** A rebase stopped on a decision-id conflict and the launch command did not stop for it, so eight lenses ran against an empty diff and approved nothing real. No verdict from that round counts.

**Round 2**, eight lenses over the aggregation on the earlier master: correctness REVISE, tests REVISE, pgn-index REVISE, root-cause, minimalism, code-quality, error-handling and platform-semantics APPROVED.

* **Skip, witnessed by correctness and pgn-index.** A non-numeric text rating such as `'Unrated'` leaves `AvgElo` out of the denominator, where the removed SQL counted it as zero. The reviewed definition is the mean of positive rating slots, and the previous test oracle also treated such a slot as not positive. The import path parses ratings to an integer or none (`src-tauri/src/db/mod.rs` `WhiteElo` handling). A SQLite probe confirmed only non-numeric text stays text in an INTEGER column. This is a known divergence from the removed SQL for an input no production writer produces.
* **Skip, witnessed by tests.** The ignored scale benchmark prints its time and asserts no 10 s limit. The reviewed plan makes it a printed, orchestrator-measured guard, and CPU core class alone moves the result by about 3 to 4 s.
* **Fix CR-1, witnessed by tests.** No test exercised a row read failure. The new test `both_summary_sources_propagate_row_errors_and_preserve_dirty_summaries` covers both row sources. Replacing the propagation with a skip turned it red.
* **Nit, root-cause.** Real Mega timing stays unverified, which the plan and closing note state.

**Round 3**, closure over that test, correctness and tests: CR-1 CLOSED by both, both APPROVED.

**Rebuild.** While final gates waited on the push lock, master gained the background upgrade owner and the Library's Upgrading state (d-20261108-08, d-20261108-09, f-20261108-04). `get_db_info` no longer migrates, so the benchmark would have measured nothing and the plan's "no upgrade state" answer no longer held. The branch was rebuilt on that master, the benchmark now polls `get_db_info_blocking` until Ready, and the decisions were re-recorded as d-20261108-17 and d-20261108-18.

**Round 4**, correctness, root-cause, tests and pgn-index over the rebuilt range: all APPROVED, no findings.

`diff_adopted_per_round`: r1=void r2=1 r3=0 r4=0.

**Records lens.** Three rounds over the earlier records found a missing `Superseded-by` trailer on d-20261108-11, an unsupported memory ceiling and a pairs-per-game miscount. The rebuilt records carry the trailer and the corrected wording. One nit, that random players only approach the maximum of player pairs, was skipped because the entry no longer makes that claim.

**Scale limit arbitration.** The plan's limit is at most 10 s at load below 5, and a missed limit stops for arbitration. Through the background owner, the generated 11,441,614-game database reached Ready in 8.3 to 9.6 s pinned to a 5.09 GHz core and about 12.6 s pinned to a 3.32 GHz core, so the limit holds on fast cores and is missed on slow ones. The number was not edited. The arbitration accepted the phase because the guard's purpose is the about 31 s baseline, which every run clears by a factor of about 2.5 or more, and because that baseline was measured on the earlier inline path. Peak RSS was 572 MB against a limit of 1.2 GB.
