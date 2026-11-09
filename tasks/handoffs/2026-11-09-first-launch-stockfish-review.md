# Review record: automatic Stockfish install at first launch (2026-11-09)

Plan file (ignored, local): `tasks/plans/2026-11-09-first-launch-stockfish.md`. Executor Codex, orchestrator Claude Code. Lenses and code share the Codex family, the arbiter is the plan author.

## Plan review, 4 rounds
Round 1 raw verdicts: review-plan REVISE, review-minimalism REVISE, review-tests REVISE, review-correctness APPROVED, review-error-handling APPROVED, review-persisted-state APPROVED, review-engine-protocol APPROVED.
- I1 (review-plan #1, review-tests #2): real-product proof had no runnable scenario. Fix: opt-in harness mode with assertions and staging. Obligation: "Real product" verification. Verified: `scripts/verify-app.mjs:4745` seeds engines and has no such assertion.
- I2 (review-plan #2): policy does not cover the download. Fix: disclosure in three languages, Phase 3. MANDATE: "Check whether privacy text covers this and update it". Verified: `PrivacyEN.tsx:2992` and `:2725`.
- I3 (review-plan #3): review packet lacked history. Fix: supplied from round 2.
- I4 (review-minimalism #1): upgrade dialog repeats the install sequence. Fix: routed through the shared action. Verified: `UpgradeEngineModal.tsx:48`.
- I5 (review-tests #1): new spec would never run without project registration. Fix: registered, assertions named. Verified: `playwright.config.ts` selects each spec by `testMatch`.
Round 2 raw verdicts: review-plan REVISE, review-minimalism APPROVED, review-tests APPROVED. I1, I3, I4, I5 closed.
- I2 reopened (review-plan r2 #2): the legal-document revision and hash dependency was missing. Fix: added to the text and Phase 3. Verified: `legalDocumentRevisions.test.ts` in chess-tactics-app.
- I6 (review-plan r2 #6): harness mode lacked an authority entry. Fix. Authority: MANDATE "same install flow, same progress and cancel" and the fixed verify-ui rule that behavior existing only in the real product is proven with `pnpm verify:app`. A new mode is needed because the default run seeds engines first.
- I7 (review-tests r2 #3): the 320px and 200% obligation had been dropped by the rewrite. Fix: restored with screenshot and clipping assertions.
Round 3 raw verdicts: review-plan REVISE, review-tests APPROVED. I6, I7 closed.
- I2 reopened again (review-plan r3 #1): second failed closure of one lineage, so the file list was replaced by a source trace. Invariant: the test at `legalDocumentRevisions.test.ts:43-53` requires a new history entry, the current constant matching it and the hash matching the sources. Previous answer named a subset of files. New evidence: `legalDocuments.ts:2-3` owns `PRIVACY_REVISION` and derives the date. Change: Phase 3 states the repository's whole revision contract.
Round 4: focused review-plan closed I2. r1=5 r2=3 r3=1 r4=0 adopted.

## Diff review
Round 1, 8 lenses over the cumulative diff: correctness, root-cause, error-handling, persisted-state, engine-protocol APPROVED. code-quality APPROVED with one finding. tests and minimalism REVISE.
- CR-Q1 verify-ui guide said WebDriver cannot register an engine. Fix.
- CR-T1 screenshot baselines missing. Fix, recorded in the container.
- CR-T2 cancel proof could pass through the mock's own timeout. Fix: the mock settles only on the prepared ticket's cancel.
- CR-M1 duplicated assertion helper in `scripts/verify-app.mjs`. Fix, reopened once for the conversion verifier and closed.
- CR-M2 duplicated install mocks. Fix for `UpgradeEngineModal.test.tsx`. Skip for `AddEngine.test.tsx`: its cancellation-race tests exercise the real job registry, and replacing that mock removed five tests.
- pre-review lint: three conditional expects. Fix.
Round 3, correctness and tests over the repairs: CR-T1 reopened, the 200% analysis snapshot was blank because the popover opened above the viewport. Fix: the empty fixed-height list renders only when engines exist, with a viewport assertion.

## Defects found by browser verification
- Install Stockfish wrapped onto two lines in centered empty states, then overflowed at 320px. Fixed.
- Mock used the wrong cancel argument and cancellation message. Fixed.
- Deferred: f-20261109-04, the Manage Engines row is clipped at 320px and 200% font scale. It predates this change.

## Real-app proof
`pnpm verify:app --fallback-engine-install`: FE1 to FE9 passed, including a real download, verification and registration of Stockfish 19, and `navigator.webdriver` true. Staged against a build without the button, exit 1. Recorded in `scripts/verify-app.mjs`.
