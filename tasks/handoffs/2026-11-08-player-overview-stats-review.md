# Player Overview statistics — review record (2026-11-08)

Plan and diff review history of the build run that added score by colour, ratings, opponents, openings and last games to the player card Overview. Landed on master. Decisions d-20261108-12 to -15.

Executors: phase 1 and phase 4, all review lenses and fix-1 to fix-3 on Codex; phases 2 and 3 on Grok (Felix switched executor mid-run, then switched back when Grok's balance ran out during phase 3's fix round). Orchestrator and arbiter: Claude Code (Opus 5.5). Lenses shared a model family with the phase 1 and 4 and fix authors, and the arbiter also wrote the plan.

## Diff review

Round 1 (8 code lenses plus records lens, 57457282): adopted F1 time controls classified by the filter website instead of each row's site, in Overview, Ratings and Openings (correctness, pre-existing, fixed for all three); F2 no failing-before proof of the tooltip labels (root-cause); F3 monthly results unasserted and F4 top-three cut unasserted (tests); F5 bare page size and F6 undocumented rated fields (code-quality); F7 reflective month helper and F8 unused score field (minimalism). error-handling, pgn-index, ipc-contract and records approved.

Round 2 (closure, 89ac351f): F1, F3-F8 closed. F2 not closed. Adopted T5 singular labels not pinned exactly (tests). Lint found conditional expects (L1) in a test added by fix-1, and this round was launched on a red pre-review by orchestrator error, so round 3 covered the repair.

Round 3 (closure, 38d507b3): F2 closed by a staged failure (`expected [ '2 White Won' ] to include '2 Wins'`). T5, L1 and V1 (staged-failure matrix for verifyPlayerOverview) closed. No new findings.

Adoption per round: r1=8 r2=1 r3=0. Orchestrator-initiated, not lens findings: singular Win/Loss labels and the German Performance label.

Staged verify:app assertions: PO1, PO2, PO3, PO4 and PO6 seen to fail with exit 1; PO5 argued (see the header of verifyPlayerOverview). Full-suite verify:app failed twice in the existing practice journey at load average 50 from another checkout's gates, and passed at low load.

Out-of-diff finding filed: f-20261108-03 (GameCard.test.tsx transition timer outlives jsdom, intermittent).

## Plan review

### Round 1 (revision r1, 7 lenses: plan, minimalism, correctness, tests, error-handling, pgn-index, ipc-contract; Codex leaves)
Verdicts: plan REVISE, minimalism APPROVED, correctness REVISE, tests REVISE, error-handling APPROVED (1 should-fix), pgn-index REVISE, ipc-contract APPROVED. Raw reports: /tmp/build-84122ac1/lens-*-r1.txt.
- P1 [blocker] O5 query omits `sides: "Any"`; `load_games` ignores `player1` when `sides` is None (verified `src-tauri/src/db/mod.rs:2556-2622`). Witnesses: plan r1#1, correctness r1#1, pgn-index r1#1. Disposition: Fix — O5 requires `sides: "Any"`, O6 asserts it (vitest args) and verify:app checks mixed-player rows. Status: open, closure r2.
- P2 [blocker] "latest rating" not derivable from `daily.max_player_elo` (max per day). Witnesses: plan r1#2, correctness r1#2. Disposition: Fix — O2 adds `latest: Vec<LatestRatingData>` per time control with (date, time, game id) order; O3/O6 same-day decline case. Status: open, closure r2.
- P3 [blocker/should-fix] `pnpm verify:app` has no player Overview journey. Witnesses: plan r1#3, tests r1#3. Disposition: Fix — O6 + Phase 4 `verifyPlayerOverview` journey. Status: open, closure r2.
- P4 [should-fix] e2e statistics fixture owned by Phase 1 and Phase 3. Witness: plan r1#4. Disposition: Fix — Phase 1 owns final fixture data, Phase 3 only `get_games` mock + assertions. Status: open, closure r2.
- P5 [blocker] no revert-sensitive assertion for per-colour counts/score. Witness: tests r1#1. Disposition: Fix — O6 mixed-result fixture with exact expected strings. Status: open, closure r2.
- P6 [should-fix] O5 tests don't prove selection/order/bound. Witness: tests r1#2. Disposition: Fix — O6 asserts query args and order; verify:app proves real filtering. Status: open, closure r2.
- P7 [should-fix] O5 error/cancellation/retry unspecified. Witness: error-handling r1#1. Disposition: Fix — O5 failure semantics paragraph, O6 cases. Status: open, closure r2.
Adopted r1: 7.

### Round 2 (revision r2, 6 lenses: plan, correctness, tests, error-handling, pgn-index, ipc-contract)
Verdicts: plan REVISE, correctness APPROVED, tests APPROVED, error-handling APPROVED (noted retries must be disabled explicitly), pgn-index APPROVED, ipc-contract APPROVED. Raw: /tmp/build-84122ac1/lens-*-r2.txt.
- P1 CLOSED r2 (plan, correctness, pgn-index). P2 CLOSED r2 (plan, correctness). P3 CLOSED r2 (plan, tests). P4 CLOSED r2 (plan). P5 CLOSED r2 (plan, tests). P6 CLOSED r2 (plan, tests).
- P7 NOT CLOSED (plan r2#7 blocker): `useSWRImmutable` keeps SWR error retries (`node_modules/swr/dist/immutable/index.mjs:4`, default `shouldRetryOnError` true). Verified by orchestrator: `PlayerCard.tsx:17` passes no override. Disposition: Fix (second correction in lineage P7) — O5 requires explicit `shouldRetryOnError: false`; O6 asserts one invocation after an error under production SWR defaults. Closure r3.
- P8 [should-fix] (plan r2#8) P2/P3 records lack Authority. Disposition: Fix (record). Authority: P2 — MANDATE item 3 "peak and latest rating"; `daily.max_player_elo` is a per-day maximum (`src-tauri/src/db/mod.rs:3539`), so "latest" is unattainable without chronology. P3 — global rule 25 (verify frontend in the real product) and MANDATE item 6/7 real IPC payload and game opening; `scripts/verify-app.mjs:5987` journey list has no player-card journey. Closure r3.
- P9 [should-fix] (plan r2#9) r2 packet lacked CORRECTION CHECK evidence. Disposition: Fix — r3 packet carries the correction-check block with source traces. Closure r3.
Adopted r2: 3.

### Round 3 (revision r3, 2 lenses: plan, error-handling)
Verdicts: plan APPROVED, error-handling APPROVED. P7 CLOSED r3 (plan, error-handling), P8 CLOSED r3 (plan), P9 CLOSED r3 (plan). No open issues. Adopted r3: 0.
