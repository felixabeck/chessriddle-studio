# Review record: player Openings clarity and recency (2026-11-08)

Plan: tasks/plans/2026-11-08-player-openings-recency.md (ignored by git; this file is the durable record).

## Reviews

### Round 1 (r1, ten lenses: plan, minimalism, correctness, root-cause, tests, code-quality, error-handling, ipc-contract, pgn-index, persisted-state)

Verdicts: REVISE from plan, correctness, tests, code-quality, pgn-index. APPROVED from minimalism, root-cause, error-handling, ipc-contract, persisted-state.

- I1 (correctness#1, pgn-index#1, plan#1) O5 claims bounded filters exclude every undated game; `search.rs` case `Some("????")` passes a start-only bound. Fix: claim corrected, known limit recorded; shared predicate unchanged because it is pinned for other surfaces and outside MANDATE. Evidence: `search.rs:2263`, measured by reading the case table.
- I2 (plan#2, tests#3) e2e cannot prove O7 layout or Openings pixels. Fix: new e2e case with populated recency at 320px and 200% font scale plus committed snapshot.
- I3 (plan#3) no performance proof. Fix: Mega benchmark before/after with threshold.
- I4 (plan#4) Phases 1-3 share files with no dependency. Fix: merged into one UI phase.
- I5 (plan#5) obligations prescribed mechanisms. Fix: moved to Decisions as executor notes.
- I6 (tests#1) no named regression assertions. Fix: O8 lists level and observation per obligation.
- I7 (tests#2) cache accounting test outside the proof selector. Fix: selector and assertion added.
- I8 (code-quality#1) "undated" mislabels future dates. Fix: wording changed.

### Round 2 (plan, correctness, pgn-index, tests, code-quality)

I1, I2, I6, I7, I8 CLOSED by their witnesses. Remaining:

- I3 NOT CLOSED (plan). Fix: explicit before/after benchmark invocation with comparison, run by the orchestrator.
- I4 NOT CLOSED (plan, should-fix). Fix: Phase 2 follows Phase 1, dependency stated.
- I5 NOT CLOSED (plan, should-fix). Fix for O5's mechanism. The per-case lists in O8 stay: they are the verification contract that I6 required, so moving them would reopen I6.
- I9 (plan r2 new, tests r2) Phase 2 Vitest selector omitted the recency component. Fix: component named and added.
- I10 (plan r2 new) Phase 1 proof could not establish O1's browser assertion. Fix: e2e assertion and container run moved into Phase 1.

### Round 3 (plan, tests)

I3, I4, I5, I9, I10 CLOSED. All lenses APPROVED. Adoptions per round: r1=8 r2=5 r3=0.

## Carried to diff review

- CR-1 (I3 amendment, measured): `benchmark_mega_player_position_search` as written is unusable as the O6 performance proof. Its player has 2 games in the Mega copy and its 10-second bound panics at 17.7 s on the unchanged base in a debug build. The proof is an uncommitted temporary patch of that benchmark removing the player filter and the bound, one iteration, three runs each on base and candidate, median within 10%.


## Diff review

### Round d1 (correctness, root-cause, tests, code-quality, minimalism, error-handling, ipc-contract, pgn-index, records)

APPROVED: error-handling, ipc-contract, pgn-index, root-cause (limitation only). REVISE: correctness, tests, code-quality, minimalism, records.

- D1 (correctness) A finished search's stored 100% could show while the next search starts. Fix, closed d2 by correctness.
- D2 (tests) Committed Openings snapshot missing. Fix: recorded in the Playwright container, comparison passed 5/5 on the rebuilt run; final gates re-prove it on a clean tree.
- D3 (tests) Intensity normalisation not pinned. Fix, closed d2.
- D4 (code-quality) Unnamed year-window and heat-scale numbers. Fix, closed d2.
- D5 (minimalism) Duplicate render helper in ResultsChart.test.tsx. Fix, closed d2.
- D6 (records) d-20261109-03 misstated the string count. Fix: superseded by d-20261109-04 with fresh measurements, closed d2.
- CR-1 closed: measured performance proof is the all-games temporary benchmark patch (median base 191.31 s, candidate 187.35 s).
- Skip: root-cause's limitation note carries no defect; the O1 e2e assertion was shown failing before the fix by the phase leaf.

Diff adoptions per round: d1=6 d2=0.

Same-family note: plan and arbitration ran on Claude; lenses and implementation both ran on Codex, so review of Codex-written code was Codex-on-Codex in model family.

## Verification evidence

Real app (release build, WebKitGTK, throwaway profile seeded with a copy of Mega Database 2025, player Imnadze, Nato): "Searching Imnadze's games…" with skeleton during the 32 s first search; moves e4 128, d4 14, Nf3 1 with Last played and year strips; labels 11.7px; Prepare on board right edge 1851 equals the panel's content edge at 1851, panel edge 1871; Since 5 years shows 30 games, e4 15, d4 14, Black switch hint and 133 games.
