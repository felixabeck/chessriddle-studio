# Game-end marker — review history

Build run `game-end-marker` (Claude Code orchestrator, Codex executor leaves), 2026-11-05.
Felix's request: mark where an analysed game ended and keep later moves enterable but visibly
distinct from the played game. Decisions: d-20261105-17 (storage, load default, omission rule,
termination), d-20261105-18 (copy, styling, menu, Termination field), d-20261105-19 (bundle
budget). Plan: `tasks/plans/2026-11-05-game-end-marker.md` (ignored); this file is the durable
record.

## Plan review

Lenses ran on Codex (`leaf-launch.sh read-only`), review-plan at the review-plan role, the rest
at the sensitive role (the plan touched `src/state/**`).

### Round 1 — plan, minimalism, chess-semantics, persisted-state, tests, correctness

Verdicts: plan REVISE, chess-semantics REVISE, tests REVISE; minimalism, persisted-state,
correctness APPROVED.

- **R1-1** (chess-semantics, blocker): a `[%gameend]` in a variation stayed opaque, so promoting
  that variation and reloading changed its meaning. **Fix**: flags are parsed on every non-root
  node and inert off the mainline.
- **R1-2** (chess-semantics, blocker): re-entering the existing end move could re-adjudicate the
  Result (`src/state/store/tree.ts`, `makeMove`). **Fix**: the guard includes the resulting child.
- **R1-3** (plan, blocker): the database preview parsed before merging row headers
  (`GamePreview.tsx`). **Fix**: the load default runs at that boundary too.
- **R1-4** (plan, blocker): dropping the accepted Termination field lacked authority. **Fix**:
  kept, stored on the end node so it survives database rows.
- **R1-5** (plan, blocker): a command-only export is not readable in other programs. **Fix**: the
  marker token carries the fixed prose `Game ended here`, dropped again on re-import.
- **R1-6** (plan + tests, blocker): no proof that analysis renders differently (component tests
  mock `MoveCell`). **Fix**: unmocked `MoveCell` test plus a registered Playwright spec.
- **R1-7** (plan, should-fix): round-1 packet lacked history declarations. **Skip**: round 1 has
  no history.
- **R1-8** (tests, should-fix): no database save proof. **Fix**: the save serializer
  (`serializeStoreTree`) is asserted to carry the marker; Rust stores comment bytes verbatim.

### Round 2 — plan, chess-semantics, tests, persisted-state, minimalism

Closed R1-1…R1-5, R1-8. Opened **R2-1** (chess-semantics, persisted-state, plan blockers; tests
should-fix): the omission rule dropped a leaf end's termination on the database path. **Fix**:
omit the marker only for an end without termination. R1-6 not closed (selection restyles the
entered move; a new spec needs a `playwright.config.ts` project). **Fix**: compare with neither
move selected or hovered, register `e2e/game-end.spec.ts` as project `game-end`.

### Round 3 — plan, chess-semantics, persisted-state, tests

All APPROVED; R2-1 and R1-6 closed. Adoptions per round: r1=7 r2=2 r3=0.

## Implementation

- Phase 1 (`7f070e11`, sensitive rung): data model, PGN round trip, load default, store actions,
  adjudication guard, persisted schema. Orchestrator inspection found a per-render deep clone in
  the database preview; two resume rounds memoized it (second round fixed an exhaustive-deps
  lint error by reading headers from the memo key).
- Phase 2 (`d0bbc114`, normal rung): notation rows, end row, analysis styling, menu entries,
  Termination field, 16 catalogues, e2e spec. Two resume rounds fixed missing jsdom APIs in the
  new `GameInfo` test and five lint warnings.

## Cumulative diff review (7ac57840..d0bbc114, records excluded)

Lenses: correctness, root-cause, chess-semantics, persisted-state, tests, code-quality,
minimalism, error-handling (Codex, sensitive rung). Five APPROVED outright.

- **CR-C1** (correctness, blocker): an annotated analysis move kept its annotation colour and
  looked like a played move. **Fix** (`c9e70908`): every analysis move renders at opacity 0.6.
- **CR-M1** (minimalism, should-fix): duplicated result-label mapping. **Fix**: one helper.
- **CR-T1** (tests, should-fix): no conflicting marker/header termination test. **Fix**.
- **CR-T2** (tests, should-fix): no Black-to-move end-row test. **Fix**.
- **CR-RC1** (root-cause, should-fix): browser spec not yet executed. **Skip** as a code change;
  it ran at browser verification (below).
- Closure round over `d0bbc114..c9e70908` (correctness, minimalism, tests): all closed, APPROVED.
  Minimalism nit (inline the `--notation-analysis-opacity` custom property): **Skip**, the name
  documents the value; arbiter close.

## Browser verification

`pnpm test:e2e:container` (full suite) on `c9e70908`: 344 passed, 5 failed, no snapshot moved.
The four game-end cases failed on a 0.4 px sub-pixel overlap in the order assertion; the
screenshots showed the intended layout but an "Unexpected Tauri IPC command: write_game" toast
(the spec lacked the autosave mock) and a filled Termination field out of character with the
header strip. **Fix** (`caf1ef6a`): 1 px tolerance, `write_game` mock with a no-toast assertion,
Termination as an unstyled inline input. Rerun: game-end 4/4 passed; screenshots inspected in
table/inline views, light/dark.

`board-wood-texture` "arrows from PGN drawings … preference is off" timed out twice under load
and passed 8/8 on four later runs, including the same commit, in this worktree and a clean
checkout. Filed as **f-20261105-07** (follow-up of f-20261102-06).

## Bundle budget

Pre-review `bundle` failed after `caf1ef6a`: total 1,710,028 B vs 1,710,000 B. Published base
`b96abc72` measured 1,706,857 B (+3,171 B), as did the earlier base `7ac57840`. Recorded **d-20261105-19** (raise total by the
established 10,000 B step), applied in `01f6313a`.

## Known limits

- Tabs open before this update keep their persisted tree without a default end; mark it once via
  the move menu.
- The database "Plies" column still counts the whole mainline.
- One intermittent Vitest unhandled error appeared once in the phase-1 proof (four later runs
  clean); not reproduced.

## Final closure reviews

- Budget change (`01f6313a`), correctness lens with the measurement evidence: APPROVED.
- Browser repair (`caf1ef6a`), correctness lens: APPROVED.
- Records lens over `tasks/decisions.md`, `tasks/findings.md` and this file: REVISE.
  - **RL-1** (should-fix): f-20261102-06 is still `open` although `e2e/fixtures.ts` implements
    its fix. **Skip**: that finding's lifecycle belongs to its owning session; this run did not
    work it.
  - **RL-2** (should-fix): f-20261105-07 repeated "the abort happens on every run" as a fact.
    **Fix**: the correction is part of the re-filed entry f-20261105-07 (see below).

## Renumbering after rebase

While this run was in review, master gained its own `d-20261105-14` and `f-20261105-05`. The
branch was rebuilt on `b96abc72`: the four code commits were replayed unchanged (identical
source), the decisions were re-recorded as d-20261105-17, -18 and -19, the finding was re-filed
as f-20261105-07 with the RL-2 correction folded in, the d-20261105-06 trailer now points at
d-20261105-19, and the bundle was re-measured on `caf1ef6a` against `b96abc72` with identical
figures. Review evidence above refers to the same content under the new hashes; review ranges
cite the pre-rebase base `7ac57840`.

Rebase records lens: REVISE with two should-fix items, both **Fix**: f-20261102-06's older
"abort happens on every run" claim got a correction annotation pointing at f-20261105-07, and
the temporary measurement worktree was removed so the "removed after measurement" statement in
d-20261105-19 and `docs/bundle-budgets.md` holds.

## Final gates

First `pnpm gates:push -- --frontend` run: contract, build, bundle, frontend coverage and e2e
green; `frontend-mutation` red in package `tree-path` (98.81 % against the 100 % break
threshold): two unreachable optional chains on an effective end's `gameEnd` and an untested
`.trim()` in termination sanitizing. **Fix** (`0b6986fa`): `getEffectiveGameEnd` returns a type
that guarantees `gameEnd`, plus a trimming test; `tree-path` mutation 100 %, closure correctness
lens APPROVED. The six timeouts in that package are pre-existing loop mutants.

## Hash map after the final rebase

Master moved twice more before the final gates (f-20261010-25 commits, then defde908 arrow-down
navigation), so the branch was rebased without content changes. Hashes in this file are the
final ones. Ledger entries written earlier cite pre-rebase hashes of the same commits:
d-20261105-19's candidate `bf71bc27` is `caf1ef6a`, and f-20261105-07's `7b66be20`, `d31f67d5`
and `dcc002af` are `c9e70908`, `7f070e11` and `d0bbc114`. `docs/bundle-budgets.md` cites
`caf1ef6a`.
