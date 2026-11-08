# Review record: yearly event editions and Players without ID (2026-11-08)

Plan and arbitration: Claude (Opus 5.5). Implementation and all lenses: Codex (same executor family for writing and reviewing, disclosed). Plan file was local and ignored; this record is the durable history.

## Plan review
### Round 1 (plan-r1.md, Codex read-only lenses: plan, minimalism, correctness, error, tests, pgn, persisted, ipc)
Verdicts: plan REVISE, tests REVISE, minimalism/correctness/error/pgn/persisted/ipc APPROVED (error raised one should-fix).
- P1 (plan#1, blocker): removing `PlayerSort::Id` breaks two internal callers. Fix: backend sort retained, only the table and its persisted state change. Evidence: `src/components/home/Databases.tsx:240`, `src/utils/gameReferences.ts:405`.
- P2 (plan#2, error#1): cancellation promise has no mechanism. Fix: promise removed from the threat model, migration stays non-cancellable as today. MANDATE does not ask for cancellation.
- P3 (plan#3, tests#4): newest-year tie unproven. Fix: production-query assertion in both directions added.
- P4 (plan#4, tests#2): no browser proof for Players. Fix: e2e assertion and container command added.
- P5 (plan#5): phases shared `db/mod.rs`. Fix: resolved by P1, phase 2 no longer touches Rust.
- P6 (tests#1): no assertion for header removal or `id` fallback. Fix: both required.
- P7 (tests#3): import path unproven. Fix: `TempGame::insert_to_db` assertion added.

### Round 2 (plan-r2.md, lenses plan, error, tests)
P1-P7 CLOSED by their witnesses. New: P8 (plan#1, blocker) AUTOINCREMENT high-water preservation unproven. Fix: upgrade assertion with a previously deleted highest ID added.

### Round 3 (plan-r3.md, lens plan)
P8 CLOSED. VERDICT APPROVED.
### Orchestrator probe after round 3
The prior rebuild mechanism (deferred foreign keys) was measured unusable on Mega, see Traced premises. P9: rebuild mechanism replaced by foreign keys off around the transaction, with verification and restoration. Authority: MANDATE "split by year" requires the upgrade to complete.

### Round 4 (plan-r4.md, lenses plan, correctness, error, pgn)
P9 NOT CLOSED by all four: migration runs inside caller transactions at `db/mod.rs:332`, `:1407` and `linked_collections.rs:2414`, so foreign keys cannot be switched off (the callers need the upgrade atomic with their revision bump, `db/mod.rs:13870`). Fix: replaced by an in-transaction rebuild with deferred foreign keys and the event index first, measured on Mega (see Traced premises). Lineage P9, second mechanism.
### Round 5 (plan-r5.md, lenses plan, correctness, error, pgn)
P9 CLOSED by all four witnesses. All verdicts APPROVED. Adoptions: r1=7 r2=1 r3=0 r4=1 r5=0.

Totals: 5 rounds, 9 issues (P1-P9), all closed. Adoptions r1=7 r2=1 r3=0 r4=1 r5=0.

## Cumulative diff review
Lenses round 1: correctness, root-cause, code-quality, minimalism, tests, error-handling, pgn-index, persisted-state. Verdicts: correctness, root-cause, tests, error, pgn, persisted APPROVED; quality and minimalism REVISE.
- D1 (quality, blocker): clippy suppression in `event_edition_tests.rs`. Fix: helper, closed by quality.
- D2 (minimalism, should-fix): four 2.x migration branches repeated their finish. Fix: `upgrade_to_event_editions`, closed by minimalism, order unchanged confirmed by correctness.
- D3 (tests, should-fix): sequence restoration unproven. Fix: no-split upgrade test, removal observed to fail, closed by tests.
- Root-cause note (no failing-before run supplied): Skip, covered by the real-app runs below.
- D4 (found by the orchestrator in the real app, first row "SVK-chT rapid 2025.05.04 - 2025"): a partial date sorted above complete dates. Four mechanisms, each reviewed: prefer complete dates (reopened: loses a known later month, partial-only still ranks top); key with '?' as '0' (reopened: variable-length dates); fixed-width key (reopened: dates under four characters); padded fixed-width key. Closed by correctness, tests confirmed the third mechanism's assertions.

## Real-app verification
Release build driven on fresh reflink copies of the 2.2.0 Mega database (11,441,614 games): upgrade listed in 31-33 s at load 5-14, Events `1 - 25 / 108800`, newest first starts with Chess.com Classic Losers 2025.05.20, search "Wch U12" lists 88 editions including 2024 (151 players) and 2023 (55 players), Players table headers Name, Elo, Games.
