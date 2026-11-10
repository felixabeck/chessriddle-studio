# Review record: arrow down at a line end stays at its own fork (2026-11-10)

Build run in worktree `arrow-down-line-end`, orchestrator Claude Code, executor Codex. Felix's
order and reasons: `docs/context/PRODUCT-DECISIONS.md`, entry of 2026-11-10.

## Plan review, round 1
Codex read-only lenses over the plan. review-minimalism, review-correctness, review-tests and
review-chess-semantics approved; review-persisted-state was not applicable; review-plan returned
REVISE with two issues.

* I1 (review-plan, blocker): the review packet omitted revision identity, history and open issue
  ids. Skip: a claim about the packet, not the plan; round 1 has no history or open issue.
* I2 (review-plan, should-fix): the verification section named exact fixture paths. Skip: those
  cases are the verification contract for the ordered behaviour on the existing fixture.

Plan-level adoptions: r1=0. Closed by the arbiter.

## Diff review
Round 1 over `8fed763e..6673a31b` with seven Codex lenses: correctness, root-cause, tests,
code-quality, minimalism, chess-semantics approved; persisted-state not applicable.

* T1 (review-tests, should-fix): next-sibling assertions covered only the root fork, so dropping
  the fork's path would have passed. Fix: commit "test(notation): pin the next sibling at a nested
  fork". The fix leaf showed the new case red against that mutation. Closed in round 2 by
  review-tests and review-correctness.
* R1 (review-root-cause, should-fix): no failing-before result was supplied. Closed with a
  measurement by the orchestrator: with the previous algorithm restored under the new function
  name, 10 of the rewritten tests failed (9 in `tree.test.ts`, 1 in `MoveControls.test.tsx`).

diff_adopted_per_round: r1=1 r2=0. Author and reviewers are the same model family (Codex leaves,
Codex lenses); arbitration by the Claude Code orchestrator that wrote the plan.
