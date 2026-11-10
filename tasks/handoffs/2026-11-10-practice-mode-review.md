# Review record: practice mode — line training, automatic grading, learn step, lean stats (2026-11-10)

Build run in worktree `practice-mode`, orchestrator Claude Code, executor Codex. Felix's order:
"Yes, all of this sounds very good. Implement this full auto executor codex on a separate work
tree." on eight suggestions for the practice mode. Values and rules: `tasks/decisions.md`
d-20261110-06, amended by d-20261110-11.

## Plan review, round 1
Seven Codex read-only lenses over the plan. review-minimalism and review-persisted-state approved;
review-error-handling approved with two should-fix findings; review-plan, review-chess-semantics,
review-correctness and review-tests returned REVISE. All twelve issues were adopted as Fix.

* I1 (review-plan, blocker): phase 1 added reducer phases without the phase type in
  `src/state/atoms.ts`. Fix: phase 1 owns the type change.
* I2 (review-plan, blocker): `e2e/workspace-tabs.spec.ts` and `scripts/verify-app.mjs` depend on
  the old wrong-move and rating flow. Fix: both adapted and run.
* I3 (review-plan, blocker): Chessground moves the piece before reporting a move, so a rejected
  submission leaves the piece displaced. Fix: board restoration, proven by real board input.
* I4 (review-plan and review-tests, blocker): no proof that comments appear after the answer.
  Fix: component assertions for visibility and for waiting until Continue.
* I5 (review-plan, blocker): a six-ply replay cap contradicted "playing a line from its start".
  Fix: cap removed; the first card replays from the practice start.
* I6 (review-plan, should-fix): two phases shared the panel, its tests and the catalogues. Fix:
  merged into one phase.
* I7 (review-plan, should-fix): private helper names in obligations. Fix: removed.
* I8 (review-chess-semantics, blocker): another stored move was recognised only on one tree node
  although cards are keyed by board state. Fix: alternatives across all in-scope nodes with the
  card's board state.
* I9 (review-correctness, blocker): a correct answer after a wrong attempt, and every answer in
  full-repertoire mode, had no way to advance under manual grading. Fix: three defined endings of
  a presentation.
* I10 (review-tests, blocker): the replay proof would pass for a teleport. Fix: intermediate
  positions asserted at component and real-board level.
* I11 (review-error-handling, should-fix): no outcome for a tree change during replay when the
  card survives. Fix: restart for the same entry, or drop it when its frame is gone.
* I12 (review-error-handling, should-fix): storage failure during a session unspecified. Fix: a
  refused rating is not retried; a deck that stops being writable ends the session.

## Plan review, round 2
Closure by review-plan and the four witnesses: all approved. I1–I10 closed by review-plan and
their witnesses. I11 and I12 were closed by review-error-handling; review-plan kept both open only
for a missing authority record, which the arbiter supplied in the plan's review section without
changing an obligation.

Plan-level adoptions: r1=12 r2=0.

## Diff review, round 1
Commits are named by subject because the branch was rebased onto `master` before release.

Eight Codex lenses over the two feature commits (code) and one records lens over
`tasks/decisions.md`. review-root-cause, review-error-handling, review-tests and
review-minimalism approved; review-correctness, review-chess-semantics, review-code-quality,
review-persisted-state and the records lens returned REVISE.

* D1 (review-correctness and review-chess-semantics, blocker): a retained card whose full FEN
  changes under a running session (promotion of a transposed branch) left the session bound to
  the old FEN and rejected every move. Fix, see the lineage below.
* D2 (review-correctness blocker, review-persisted-state should-fix): a second end call on
  unmount erased the saved session summary. Fix: ending an idle session changes nothing.
* D3 (review-persisted-state, blocker, pre-existing): a drill path restored from storage without
  a live session kept navigation locked. Fix: an idle panel clears it. In round 2 the lens kept
  it open for a reload that lands on Info; closed in round 3 on the arbiter's evidence that
  `BoardAnalysis.tsx:210-215` clears the path on every mount while Practice is not selected and
  that tree hydration is synchronous.
* D4 (review-code-quality, blocker): the new-move limit bound was written three times. Fix: one
  constant.
* D5 (review-code-quality and review-minimalism, should-fix): retired reducer events and the
  `incorrect` phase remained. Fix: removed.
* D6 (review-code-quality, should-fix): phase comments contradicted the flow. Fix.
* D7 (review-minimalism, nit): redundant rating guard in `BoardAnalysis.tsx`. Fix: removed.
* D8 (review-tests, should-fix): the limit test never started a session. Fix: it does, with a
  non-default limit and with zero.
* R1, R2 (records, should-fix): d-20261110-06 stated rules without their spaced-session scope and
  described manual grading wrongly. Fix: d-20261110-11.
* R3 (records, should-fix): d-20261021-05 still required the delayed answer reveal. Fix:
  superseded-by trailer pointing to d-20261110-11.

Repair: commit "fix(practice): restart on a changed card FEN, keep the summary, clear a stale drill path". Fix-revert proofs for D1, D2 and D3 were red without the fix and green
with it.

## Diff review, rounds 2 to 5: the changed-position lineage
* Round 2 over that repair commit: D2, D4–D8 and R1–R3 closed. E1 (review-correctness,
  blocker, lineage D1): the restart reset the presentation's failure and rating, allowing a
  second rating. E3 (records, should-fix): d-20261110-06 lacked a pointer to its amendment; fixed
  with a trailer. Repair: commit "fix(practice): a restarted presentation keeps its failure and rating".
* Round 3 over that repair commit: E1 closed. F1 (review-correctness, blocker, lineage D1): the
  restart now preserved the learn flag after the learn step had finished. Second reopen of the
  same mechanism, so patching stopped. A mechanism note went to a fresh-context review-plan
  judgment, which chose a phase-preserving rebind after consistent tree and deck reconciliation
  and listed the cases to test.
* Round 4 over commit "fix(practice): rebind a running presentation to a changed card position": F1 closed. G1 (review-correctness and
  review-chess-semantics, blocker, lineage D1): reconciliation still used the stale deck card's
  answer and dropped an entry whose representative branch was deleted while an equivalent
  position with another answer survived. G2 (review-tests, should-fix): no negative test for the
  resolver's scope rule. Repair: commit "fix(practice): resolve the current card from the tree, not from a stale deck": the current card's frame, FEN and answer come
  from one tree resolver that shares deck construction's selection rule.
* Round 5 over that commit and the verify-app commit: G1 and G2 closed; review-correctness,
  review-chess-semantics and review-tests approved.

## Final gates and their repair
The first complete gate run passed contract, coverage, bundle and the full e2e suite and failed
the frontend mutation gate: four surviving mutants in `session.ts` (score 98.54). Repair: commit
"test(practice): close the surviving mutants in the session core" (the replay start is a required
argument, the common prefix is computed without a counting loop, the reducer is an exhaustive
switch, tests for the same-token replay guard and the path cases); the package is back at 100
with no survivor. Round 6 over that commit: review-correctness approved, review-tests approved
with H1 (should-fix): the phase restrictions were not asserted for every phase and event pair.
Fix: commit "test(practice): pin every phase and event pair of the session reducer" (88 cases).
Round 7 over that commit: H1 closed, both lenses approved.

Before the last gate run `master` had gained a decision with the id this run had used for its
amendment, so the branch was rebuilt on the new `master`: the code commits were carried by
cherry-pick and the amendment, both trailers and the finding were filed again through
`findings.py` (now d-20261110-11 and f-20261110-02).

diff_adopted_per_round: r1=11 r2=2 r3=1 r4=2 r5=0 r6=1 r7=0.

## Real-app verification
`pnpm verify:app` on a release build drives the practice scenario through the real backend. The
scenario first failed before reaching practice because a repertoire opens on Info since the
Library redesign; commit "test(verify-app): open Practice explicitly and capture practice screenshots" selects the Practice tab explicitly. On the release build of
that commit the practice checks passed: fifty automatic ratings reached the native review store
and were recorded as Good, the 12,000 native positions were unchanged, and no legacy key was
created. Screenshots of the idle panel and of the first card of a session were taken from the
real WebKitGTK window. Two unrelated checks failed in that run: GO11 (double-click on a non-first
PGN game in the Library) in both runs, filed as f-20261110-02, and the file-freshness main-thread
budget (1241 ms against 1000 ms) once, while review leaves and other gates were loading the
machine; it had passed in the run before.

Author and reviewers are the same model family (Codex leaves, Codex lenses); arbitration by the
Claude Code orchestrator that wrote the plan.
