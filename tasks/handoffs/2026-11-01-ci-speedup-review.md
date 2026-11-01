# Review record: CI speedup build (2026-11-01)

Plan: tasks/plans/2026-11-01-ci-speedup.md (ignored; reproduced below). Executor: codex (plan and diff lenses, phase leaves). Orchestrator: Claude Code session 22c82e8b-ce9a-41db-8264-d2c52e744eee. Plan authorship and arbitration shared one context; detection ran on the Codex model family, implementation also on Codex (same family as the code).

## Plan

## Goal
The `Test` workflow (`.github/workflows/test.yml`) finishes in about 10-15 minutes for a push that changes no frontend mutation input (records, docs, Rust-only), and frontend pushes are bounded by the incremental mutation run instead of a full ~40-minute tree-path sweep, with every existing gate, ratchet and mutation threshold still enforced and a full frontend mutation sweep still run regularly.

## MANDATE
Felix, 2026-11-01: "Why does it take so long? Is it really necessary to always wait for one and a half hours for a CI, or can we improve this somehow?" After the proposal (per-push mutation only for changed packages with Stryker incremental mode cached across runs, a push touching none skips it; full frontend mutation sweep in `.github/workflows/mutation.yml`; split the `test` job into parallel jobs): "Yes, I definitely want you to build this. Build this now. Do you want to do it inline or execute a codex? Decide this for yourself. Full auto."

## Threat model and non-goals
Adversary: none beyond ordinary mistakes. The risks are (1) a gate silently not running in CI (skipped step, wrong selector, swallowed exit code), (2) stale incremental results hiding a surviving mutant, (3) CI and the local push gate disagreeing about what a frontend change is. Non-goals: changing local gates, coverage floors, bundle budgets, mutation thresholds, the Windows/macOS jobs, or the backend mutation suite.

## Traced premises
- Run 41318098106 (301104da): job `test` 85 min; "Run targeted frontend mutation tests" 59.4 min; e2e 9.0; frontend tests+coverage 5.2; Rust tests+coverage 4.9; contract 2.6. Windows/macOS jobs 2-10 min each.
- From that job log: package start lines annotate-comment and game-practice 15:09:44, workspace-storage 15:11:45, tree-path 15:29:37, step end 16:09:07, so tree-path alone occupied ~40 min and nothing ran beside it. Current admission is `strykerSlots` in `scripts/gate-parallelism.mjs` searching allocations within the runner budget (`d-20261015-20` superseded the serial trial of `-19`); the package scope is the four packages in `scripts/frontend-mutation-packages.mjs`.
- Rust compilation expands `tauri::generate_context!()` (`src-tauri/src/main.rs`) against `frontendDist: "../dist"` (`src-tauri/tauri.conf.json`); the Windows/macOS jobs satisfy it on clean runners with `mkdir -p dist`.
- `actions/checkout@v4` defaults to a single-commit fetch, so a previous push SHA is not present unless fetched.
- GitHub cache: keys are immutable once saved; restore prefers branch-local prefix matches over the default branch.
- `scripts/gate-receipt.mjs` passes the inherited environment to the gate command and its receipt payload does not record mutation selection env.
- `scripts/run-frontend-mutation.mjs`: `--files` selector, `--list-packages`, exclusive fence, purges `.stryker-tmp` at start. `stryker.config.mjs` reads `STRYKER_PACKAGE`, `STRYKER_FILES`, `STRYKER_MEMORY_BYTES`; thresholds 100/100/100; no incremental. Stryker core 9.6.1 supports `incremental`, `incrementalFile`, `force`.
- `scripts/run-push-gates.mjs` `FRONTEND_INPUTS` (not exported) is the push gate's frontend path set, extended by `d-20260905-15` with the mutation config, runner and package module.
- `d-20260905-15` made frontend mutation a receipt-backed LOCAL push gate running the full suite on every frontend push (no selector), and rejected a `--changed`/`--package` selector "because a wrong selector is the same local/CI drift on a smaller set"; `vitest related` reaches ~40 transitive test files for `tabStorage.ts`.
- `scripts/check-gate-routing.mjs` (contract gate member) parses every step of `test.yml`: every `CI_REQUIRED_SCRIPTS` script must appear, a gate-invoking step may not carry `if:` or `continue-on-error`, may not chain exit codes, jobs may not carry `if:`/`continue-on-error`, and every gate-invoking command must exactly match a scheduled/skill command or routed package-script segment.
- `scripts/check-remote-ci.mjs` reads the newest completed `Test` run's jobs by name; new generations may introduce and retire job names; any non-success conclusion is red.
- The push skill waits only for `rust-windows-test`, `rust-macos-test` and `rust-platform` after a push; those jobs are unchanged here.
- `.github/workflows/mutation.yml` runs only the backend matrix, weekly Sunday 03:17 UTC plus dispatch, listing packages via `--list-packages`.

## Approach

### O1. Parallel jobs in test.yml
Split the single `test` job into independent jobs that run concurrently: `frontend` (contract gate, frontend tests + coverage + ratchet, build-vite, bindings:check, bundle:check, coverage upload), `e2e` (test:e2e:container + audit upload), `rust` (creates `dist/` with `mkdir -p dist` before any compilation, exactly as the Windows/macOS jobs do, then cargo fmt, Linux clippy, pinned llvm-cov + nightly toolchain, test:coverage:backend, coverage:backend:check, upload) and `frontend-mutation` (O2). Every command keeps its current spelling so `check-gate-routing.mjs` still routes it; every `CI_REQUIRED_SCRIPTS` script still appears in `test.yml`; no gate step or job gains `if:` or `continue-on-error`. Every job runs `actions/checkout@v4` itself first (the mutation matrix with `fetch-depth: 0`), because a local action's `action.yml` exists only after checkout. The remaining shared setup (uv, pnpm, Node with pnpm cache, `pnpm install --frozen-lockfile`, Linux desktop deps, `scripts/setup-rust.sh`, rust-cache) is written once as a local composite action under `.github/actions/` and used by every job that needs it (rule 11: second copy is extracted). Steps that must precede others inside a job keep their order (build-vite before bindings:check and bundle:check).

### O2. Per-push frontend mutation: per-package matrix, change skip, incremental
- A `frontend-mutation-packages` job lists ids with `node scripts/run-frontend-mutation.mjs --list-packages`; `frontend-mutation` is a `fail-fast: false` matrix over them, each package on its own runner, running exactly `pnpm mutation:frontend`.
- The runner gains env-driven CI modes, inert when unset. `scripts/gate-receipt.mjs` removes every `FRONTEND_MUTATION_*` variable from the environment of every gate child it runs, so an inherited CI variable can never narrow or alter a local receipt-backed run (tested).
  - `FRONTEND_MUTATION_PACKAGE=<id>` selects one package (unknown id fails, mirroring `BACKEND_MUTATION_PACKAGE`).
  - `FRONTEND_MUTATION_CHANGED_SINCE=<sha>`: the runner lists `git diff --name-only <sha> HEAD`; when no path matches the frontend mutation input set it prints one line naming the base and exits 0 without starting Stryker. A missing, all-zero, unreachable or unparsable base, or any git failure, runs the package (never skips). The input set is the push gate's `FRONTEND_INPUTS` (exported from `run-push-gates.mjs`, one definition) plus every repository module the runner and `stryker.config.mjs` import and `.github/workflows/test.yml`; the superset choice honours `d-20260905-15` (no per-file selector).
  - `FRONTEND_MUTATION_INCREMENTAL_DIR=<dir>`: Stryker runs with `incremental: true` and `incrementalFile: <dir>/<package>.json` (passed through to `stryker.config.mjs`); thresholds unchanged. The directory is outside `.stryker-tmp` so the start purge never deletes it.
  - `FRONTEND_MUTATION_FORCE=1` (only meaningful with the incremental dir): Stryker `force: true`, recomputing every mutant and writing a fresh incremental file.
- The workflow sets `FRONTEND_MUTATION_CHANGED_SINCE` to `github.event.before` on push and to the PR base SHA on pull_request; workflow_dispatch leaves it unset (full run). The mutation matrix checkout uses `fetch-depth: 0` so the base is present; a missing base still falls back to a full run.
- Incremental freshness is enforced by cache publication, not trust: only the scheduled full sweep (O3) saves incremental files, under keys `frontend-mutation-full-<package>-<UTC date>-<run id>`. Per-push runs restore only with the explicit prefixes for the current and previous UTC date (`frontend-mutation-full-<package>-<today>-`, `...-<yesterday>-`) and never save. So per-push reuse is always relative to a forced full sweep at most ~2 days old; with no such entry (sweep failed twice, cache evicted) the package runs without reuse. Because per-push runs never save, there are no branch-local entries to shadow the default branch's.

### O3. Full frontend sweep
`.github/workflows/mutation.yml` gains a frontend matrix job over `--list-packages`, running `pnpm mutation:frontend` per package with `FRONTEND_MUTATION_INCREMENTAL_DIR` and `FRONTEND_MUTATION_FORCE=1` and no change base: a full, non-reused run whose incremental file is saved (on success only) under the dated key from O2. It runs daily and on dispatch; the backend job keeps its weekly schedule (job-level guard on the cron expression) plus dispatch. A failed sweep saves nothing, so the date-keyed restore degrades to a full per-push run after two days instead of reusing stale results; the failed Mutation run is visible in GitHub's Actions view like the existing backend sweep.

### O4. Contracts, checkers and docs stay consistent
`check-gate-routing.mjs` and its tests stay green; change them only where the new layout legitimately differs (e.g. the `--list-packages` listing command), with tests for any changed rule. `check-remote-ci.mjs` keeps working with the new job names (verify its generation logic; no code change expected). Workflow wiring is asserted by tests in a suite the contract gate already runs: the test.yml mutation matrix covers exactly the `--list-packages` ids via the listing job, passes the matrix package as `FRONTEND_MUTATION_PACKAGE`, sets the change base expression, `fetch-depth: 0`, the incremental dir, the dated restore prefixes and no save step; mutation.yml's frontend job has the daily schedule, `FRONTEND_MUTATION_FORCE=1`, the incremental dir and the success-only dated save; the `rust` job creates `dist/` before compiling. Each assertion fails when its wiring is removed. Update in the same change: workflow comments (mutation step's stale "323 seconds" note), `.claude/rules/gate-tooling.md` "Mutation gate routing", the push skill's CI text where it describes the Test workflow, and a `tasks/decisions.md` entry superseding the CI half of `d-20260905-15`'s "no selector" for CI only (local gate keeps the full superset run).

## Decisions and trade-offs
Decided autonomously (full auto):
- Superset change skip, not a per-package file selector: `d-20260905-15` evidence that tests reach transitively; superset cannot drift from the local gate. Rejected: per-package file map.
- Incremental accepted for per-push CI, reusing only a forced full sweep at most ~2 days old (date-keyed cache, per-push never saves), with the unchanged full local gate as the primary backstop. Rejected: no incremental (tree-path stays ~40 min on every frontend push); incremental in the local gate (out of scope).
- Separate runners per package: each package gets a whole 4-CPU runner instead of sharing one with the others; wall time becomes the slowest package rather than the sum of admission waves.
- `dist/` for the Rust job via `mkdir -p dist`, as the existing Rust jobs do, not a frontend build or artifact transfer.
- Records-only pushes are not promised "a few minutes": frontend coverage and e2e stay unconditional (no gate gains a skip), so their floor is the slowest parallel job.
- Composite action for shared setup rather than copy-pasted steps (rule 11).
- Env-driven runner modes so workflow commands stay exactly `pnpm mutation:frontend` and the routing checker's no-`if:` rule keeps protecting the gate.

## Risks / open questions
- Real CI timing can only be observed after the push to master; the push stage records the per-job durations of the first runs (a records-only or Rust-only push and the next frontend push) against run 41318098106 and repairs or reverts if the target is missed.
- Stryker incremental may still run a long dry run for tree-path; the change skip covers non-frontend pushes regardless.
- GitHub cache scope: branch caches fall back to the default branch's.

## Not part of this task
Local gates and receipts, coverage floors, bundle budgets, mutation thresholds, Windows/macOS jobs, the backend mutation suite's packages or schedule, trimming tests.

## Phases

### Phase 1 — Runner CI modes (normal)
Files: `scripts/run-frontend-mutation.mjs`, `stryker.config.mjs`, `scripts/run-push-gates.mjs` (export `FRONTEND_INPUTS` only), `scripts/run-frontend-mutation-tests.mjs`. Implements O2's runner bullets. Also `scripts/gate-receipt.mjs` (strip `FRONTEND_MUTATION_*` from gate children) and its tests. Tests: package selection (valid, unknown), change skip (matching path runs, non-matching skips, zero/unreachable/garbage base runs, git failure runs), incremental and force pass-through (file path per package, absent when unset), receipt env stripping, local default unchanged. Behavioural proof of real incremental reuse: run the real Stryker for the smallest package (`game-practice`) twice with `FRONTEND_MUTATION_PACKAGE=game-practice FRONTEND_MUTATION_INCREMENTAL_DIR=<tmp>`; the second run reports reused mutants and the same 100% score; a third run with `FRONTEND_MUTATION_FORCE=1` reports none reused.
PROOF COMMAND: `pnpm mutation:runner:test && node --test scripts/run-push-gates-tests.mjs scripts/gate-receipt-tests.mjs && pnpm exec oxlint --deny-warnings scripts/run-frontend-mutation.mjs scripts/run-push-gates.mjs stryker.config.mjs scripts/run-frontend-mutation-tests.mjs && pnpm exec oxfmt --check scripts/run-frontend-mutation.mjs scripts/run-push-gates.mjs stryker.config.mjs scripts/run-frontend-mutation-tests.mjs`

### Phase 2 — Workflows (normal)
Files: `.github/workflows/test.yml`, `.github/workflows/mutation.yml`, `.github/actions/<setup>/action.yml`, `scripts/check-gate-routing.mjs` and `scripts/check-gate-routing-tests.mjs` only if required. Implements O1, O2's workflow bullets, O3.
Includes the workflow wiring assertions of O4. PROOF COMMAND: `pnpm gates:contract:check` (includes check-gate-routing and the wiring tests) plus a YAML parse of every changed workflow/action file (`node -e` with the repo's yaml dependency if present, otherwise python3 yaml).

### Phase 3 — Docs and decision record (mechanical)
Files: `.claude/rules/gate-tooling.md`, `.claude/skills/push/SKILL.md` (CI description only), `tasks/decisions.md` via `./scripts/findings.py record-decision`. Implements O4's docs.
PROOF COMMAND: `pnpm gates:contract:check && ./scripts/findings.py check`

## Reviews

### Round 1 (lenses: plan, minimalism, correctness, tests, root-cause, error-handling; executor codex)
Verdicts: plan REVISE, correctness REVISE, root-cause REVISE, tests REVISE, minimalism APPROVED, error-handling APPROVED (with one should-fix).
- PR-1 Rust job lacks `dist/` (plan#1, correctness#1, root-cause#1) — Fix: O1 rust job runs `mkdir -p dist` before compilation (traced: test.yml rust-macos/windows jobs do the same; main.rs generate_context, tauri.conf.json frontendDist). Open.
- PR-2 change base not fetched by shallow checkout (plan#2, correctness#2) — Fix: O2 `fetch-depth: 0` on the mutation matrix; fallback unchanged. Open.
- PR-3 one-day staleness bound not established; branch cache precedence; failed sweep keeps stale results (plan#3, error-handling#1) — Fix: O2/O3 date-keyed full-sweep-only publication, per-push restore only today/yesterday prefixes, never save; failed sweep saves nothing. Open.
- PR-4 inherited CI env can weaken local receipts (plan#4) — Fix: gate-receipt strips `FRONTEND_MUTATION_*` from gate children, tested. Verified: gate-receipt.mjs passes inherited env, payload lacks the selection. Open.
- PR-5 proofs do not establish incremental behaviour or workflow wiring (plan#5, tests#1, tests#2) — Fix: real two-run Stryker reuse proof plus force run; workflow wiring assertions in a contract-gated test suite (O4). Open.
- PR-6 records-only "few minutes" unsupported (plan#6) — Fix: Goal and Decisions corrected; no new skip of unconditional gates. Open.
- PR-7 scheduling premise misread d-20261015-20 / package count (plan#7, root-cause#2) — Fix: premise corrected to observed starts and current `strykerSlots`; before/after per-job timing recorded in push stage. Open.

### Round 2 (closure: plan, correctness, root-cause, tests, error-handling)
Verdicts: correctness APPROVED, root-cause APPROVED, tests APPROVED, error-handling APPROVED, plan REVISE.
- PR-1..PR-7 CLOSED by their witnesses (plan closed all seven; correctness PR-1/PR-2; root-cause PR-1/PR-7; tests PR-5; error-handling PR-3).
- PR-3/PR-4 Authority (plan r2 should-fix): PR-3's dated, sweep-only cache publication implements the MANDATE words "Stryker incremental mode and its incremental file cached across runs" under the frozen threat-model risk (2) "stale incremental results hiding a surviving mutant"; PR-4's receipt env stripping implements frozen risk (3) "CI and the local push gate disagreeing". Recorded; no plan text change.
- PR-8 composite action cannot contain checkout (plan r2 blocker) — Fix: O1 every job checks out before the composite action; mutation matrix keeps `fetch-depth: 0`. Open.
- Root-cause r2 should-fix (no measured after-timing yet) — already the plan's push-stage obligation (Risks); no change.

### Round 3 (closure: plan)
Verdict: plan APPROVED. PR-8 CLOSED. Plan review converged; adoptions r1=7 r2=1 r3=0.

## Cumulative diff review

Range 60db92f863d34e99c34bd39ce66c1808cb1ae7d8..5a6a9575, round c1 (correctness, root-cause, code-quality, minimalism, tests, error-handling; records lens on tasks/decisions.md):

### lens-code-quality-c1

[nit] scripts/check-gate-routing-tests.mjs:948 — `phase2Contracts`, `phase2Texts` and the “Phase 2” test titles describe an implementation phase rather than their enduring purpose. Use names such as `ciWorkflowContracts` and `readCiWorkflowTexts` so readers can identify the checks without consulting the original plan. Neighboring tests describe the behavior they verify. (confidence: 96)

VERDICT: APPROVED

### lens-correctness-c1

[blocker] scripts/run-frontend-mutation.mjs:55 — A push changing only `tsconfig.json` skips every mutation package because that path is absent from `FRONTEND_INPUTS` and the discovered module closure. Yet `vite.config.ts:14` reads it directly and incorporates its contents into Vitest’s transform cache key. Compiler configuration changes therefore receive a successful skip despite changing a mutation input. Include this consumed configuration in the skip scope. (confidence: 96)

VERDICT: REVISE

### lens-error-handling-c1

VERDICT: APPROVED

### lens-minimalism-c1

[nit] .github/workflows/mutation.yml:163 — The full-sweep job computes `yesterday`, but only consumes `today` when publishing its cache. Delete this unused output line (confidence: 100).

VERDICT: APPROVED

### lens-records-c1

[should-fix] tasks/decisions.md:2008 — `d-20260905-15` still says `Superseded-by: -`, leaving its “No selector” rule standing, although line 11327 explicitly supersedes that rule for CI. The ledger header and its referenced contract require marking the prior decision superseded. Add the successor with the CI-only scope preserved. (confidence: 100)

Unverifiable from committed evidence: run 41318098106 timings and the claimed r1–r3 review provenance. No live services queried. No files changed.

VERDICT: REVISE

### lens-root-cause-c1

[should-fix] .github/workflows/test.yml:317 — Verification limitation: the plan records an 85-minute baseline, but supplies no hosted after-change timing. Parallel jobs remove serial gate accumulation, and change-based skipping removes unnecessary mutation runs, but the claimed runtime improvement remains unverified, especially for frontend pushes retaining Stryker’s long baseline run. Record comparable hosted timings before declaring the performance fix proven. No prior-fix reintroduction identified. (confidence: 100)

VERDICT: APPROVED

### lens-tests-c1

[should-fix] scripts/run-frontend-mutation-tests.mjs:250 — Every change-skip test substitutes Git output without checking the compared revisions. Changing the production command to `git diff --name-only -z HEAD HEAD` would leave these tests green while skipping mutation on frontend changes. Add a real two-commit Git fixture asserting that a frontend change prevents skipping. (confidence: 99)

VERDICT: APPROVED

Dispositions: correctness blocker (tsconfig.json skip) Fix; tests should-fix (real git fixture) Fix; code-quality nit (phase2 names) Fix; minimalism nit (unused yesterday) Fix; records should-fix (d-20260905-15 Superseded-by) Fix via findings.py set-trailer; root-cause should-fix (hosted timing unverified) Skip: measured in the push stage per plan Risks; error-handling APPROVED without findings.

Closure round c2 over 5a6a9575..e3a028d4:

### lens-code-quality-c2

CLOSED — `scripts/check-gate-routing-tests.mjs:948` and `:1092` replace `phase2*` with `ciWorkflowContracts` and `readCiWorkflowTexts`. Both test titles and all callers use the descriptive names.

No new readability or local-consistency defects found.

VERDICT: APPROVED

### lens-correctness-c2

CLOSED — `scripts/run-push-gates.mjs:194` adds `tsconfig*.json` to the shared frontend inputs, so a `tsconfig.json`-only change retains mutation execution. Both Git commands receive the supplied `cwd`. No new correctness defects found.

Limitation: tests were inspected, not executed under the read-only review restrictions (confidence: 95).

VERDICT: APPROVED

### lens-minimalism-c2

CLOSED — `.github/workflows/mutation.yml:158` no longer computes or emits the unused `yesterday` output. The sweep cache key uses only `today`.

No new bloat or duplication defects found in the closure delta. No files changed.

VERDICT: APPROVED

### lens-records-c2

CLOSED — tasks/decisions.md:2008 now links to d-20261101-06, which explicitly limits supersession to CI. No new defects found. Ledger validation passed. Historical hosted-run timings remain unverifiable from local evidence.

VERDICT: APPROVED

### lens-tests-c2

CLOSED — `scripts/run-frontend-mutation-tests.mjs:304` now uses real two-commit Git fixtures and asserts skip decisions for frontend, records and TypeScript config changes. Comparing HEAD with itself would fail the frontend assertions. Invalid Git arguments or revisions would fail the records assertion. These tests run through `mutation:runner:test` in the CI contract gate.

No new verification defects found in the closure delta. Review was read-only, tests were not executed.

VERDICT: APPROVED
