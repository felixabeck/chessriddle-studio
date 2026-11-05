# Review record: engine hotkeys (Space = best engine move, X = threat mode)

Build run engine-hotkeys, 2026-11-05, Claude Code orchestrator, Codex executor (lenses and writes), full auto. Plan: tasks/plans/2026-11-05-engine-hotkeys.md (ignored). Commits f877abd1, 575a5c34, 9d1804d7, db440c51 on master.

## Plan review

### Round 1 (plan-r1) — lenses: review-plan, review-minimalism, review-correctness, review-tests, review-persisted-state, review-chess-semantics, review-engine-protocol (Codex)
Verdicts: plan REVISE (3 blockers), engine-protocol REVISE (1 blocker), persisted-state REVISE
(1 blocker), tests APPROVED (1 should-fix), minimalism APPROVED, correctness APPROVED (limitation:
WebKit `:focus-visible`), chess-semantics APPROVED.

- **I1** — Space source lines omit context and failed-terminal eligibility. Witnesses: review-plan
  r1 #1, review-engine-protocol r1 #1. Evidence: `useDisplayedEngineLines.ts` gates `current` on
  `memory.context === engineLineContext(...)` and derives `failure` from `matchingEngineTerminal`;
  retained `fallback` lines are dimmed. MANDATE: "best engine move ... when the engine is running".
  Disposition: **Fix** — O1 source rule rewritten to the panel's current, non-failed lines through
  one extracted derivation. Status: open, closure in r2.
- **I2** — Keymap repair writer turns a refused write into a defaults write / throw. Witnesses:
  review-persisted-state r1 #1, review-plan r1 #2. Evidence: `src/state/keybinds.ts:93-97` catch
  around both parse and `setItem`. MANDATE: O3 migration depends on this writer. Disposition:
  **Fix** — O3 write-failure obligation and test. Status: open, closure in r2.
- **I3** — Browser proof cannot exercise O4 native focus/Space activation. Witnesses: review-plan
  r1 #3, review-tests r1 #1. Evidence: Vitest jsdom (`vite.config.ts`), synthetic keydown in
  `Board.test.tsx`. Disposition: **Fix** — O5 committed Playwright spec with real key presses
  (a)–(e), plus WebKit probe. Status: open, closure in r2.
- correctness r1 limitation (WebKit `:focus-visible`) — covered by I3, no separate issue.
- minimalism r1 limitation (unspecified selector) — Skip: carried to diff review by nature; no
  plan defect.

### Round 2 (plan-r2) — closure: review-plan, review-engine-protocol, review-persisted-state, review-tests (Codex)
Verdicts: all APPROVED. I1 CLOSED (review-plan, review-engine-protocol). I2 CLOSED (review-plan,
review-persisted-state). I3 CLOSED (review-plan, review-tests).
- **I4** — review-plan r2 #1 (should-fix): I1–I3 Fix entries lack Authority. Disposition: **Fix**,
  record-only (no semantic change, so no further lens round): Authority for I1 = MANDATE "best engine
  move ... when the engine is running" (a failed or stale-context engine is not a running engine's
  best move) + engine-lifecycle rule "a payload is used only when its ... settings, go mode and
  executable identity still match"; I2 = necessary correctness of the O3 migration, which writes
  through this writer on every upgraded profile (persisted-state rule); I3 = necessary verification
  of O4, which jsdom cannot observe. closed_round: arbiter.
Adoptions: r1=3 r2=1. Plan review complete.

## Diff review

### d1 — cumulative diff 16324d52..73d08bb4, 8 lenses (correctness, root-cause, tests, code-quality, minimalism, error-handling, engine-protocol, persisted-state), all sensitive
Verdicts: minimalism REVISE, persisted-state REVISE, the other six APPROVED.
- F1 (minimalism, should-fix 98): e2e best-moves payload factory, request type and engine seed duplicated e2e/engine-gap.spec.ts. Fix: extracted to e2e/fixtures.ts, both specs routed through it. CLOSED d2 (minimalism).
- F2 (persisted-state, blocker 97): keymap storage read unguarded, SecurityError escapes hydration. Fix: guarded read, handled report, initial value, no write. CLOSED d2 (persisted-state). Fails-before evidence: refused-read test 1/9 failed against 73d08bb4, 9/9 after.
- F3 (tests, should-fix 100/99): engine-order test had one eligible engine; no non-PV1 case. Fix: two-engine priority case, PV2-only no-op case. CLOSED d2 (tests).
- F4 (code-quality, nit 98): hotkey tests under a misnamed describe. Fix. CLOSED d2 (code-quality).
- root-cause should-fix (evidence only): fails-before evidence for the storage fix. Supplied: new keybinds tests 6/8 failed against base keybinds.ts, 8/8 after. Closed by evidence.
- correctness limitation (WebKit focus not executed): covered by the Playwright WebKit probe, 5/5 pass.

### d2 — closure over 73d08bb4..e3cc6a42, 6 lenses: all APPROVED, F1-F4 CLOSED. root-cause asked for refused-read fails-before evidence; supplied (see F2).

### d3 — rebased-commit closure after upstream moved to 7cca5380 (c64908a5 pinned engine bar, 7cca5380 log mock); range-diff: one context-only change. 4 lenses (correctness, root-cause, engine-protocol, tests): all APPROVED.
- T1 (tests, should-fix 100): X test never used an enabled engine with loaded:false. Fix. CLOSED d4.
- T2 (tests, should-fix 97): actionable eligibility untested for remote no-lines terminals. Fix. CLOSED d4.
- root-cause repeat evidence request: already supplied above. Closed by evidence.
Mutation evidence for T1/T2: removing each guard turned its new test red; restored, 323/323 passed.

### d4 — closure over the test commit, tests + correctness: APPROVED, T1 T2 CLOSED.

Adoptions: plan r1=3 r2=1; diff d1=4 d2=0 d3=2 d4=0.
Family disclosure: plan authorship and arbitration shared one Claude context; all lenses and all writes ran on the OpenAI family (Codex), so lenses reviewed code written by the same family in separate sessions.
