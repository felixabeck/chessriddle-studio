---
paths:
  - "scripts/**"
  - ".github/workflows/**"
  - "package.json"
  - "pnpm-workspace.yaml"
  - "stryker.config.mjs"
  - "*coverage-*.json"
  - "bundle-budgets.json"
  - ".claude/skills/push/**"
  - "mutants.out/**"
---

# Gate tooling

> **Relevant when:** running, changing or recovering a gate, including a gate command typed before any file is opened.

## Scheduling and placement

`pnpm gates:push` and `pnpm checks:pre-review` are `agent-gate` commands (tuxedo-config's strict
launcher, `d-20261002-01`).

The push skill's §2 runs every final gate through one command,
`pnpm gates:push -- [--rust] [--frontend] [--bindings]` (`scripts/run-push-gates.mjs`; no flags is
the contract-only run). For the selected blocks, it runs the mutation guard first (always), then
the advisory `rust-target-eviction` step and `setup-rust` for Rust or bindings, then rebuilds
`dist/` for every `dist/` consumer and runs `bindings:check` with `--bindings`. Contract and
bundle run concurrently with one complete Rust lane at a time, in declaration order: lint, test,
coverage. Frontend coverage and mutation wait until all Rust work terminates. An ordinary lane
failure still admits later Rust lanes. Signals and unconfirmed child cleanup prevent queued
starts. E2e waits for bundle and every Rust lane, including failures, because its container
build rewrites `dist/`, a Rust compile input. After Rust, frontend coverage shares memory only
with concurrent mutation. Mutation runs last unless the existing budget and CPU thresholds allow
one frontend wave.

The shared [gate-performance reference](~/.claude/references/gate-performance.md) owns machine-wide
slot admission and scope caps. `agent-gate` takes one shared slot and runs the whole run in its
own `agents.slice/agent-gate-*.scope`. It fails closed: exit 125 (`agent-gate: REFUSED — …`) means nothing started and a
retry is safe; a missing launcher fails the gate with no in-place fallback. Never wrap a gate
command in another `flock` on `heavy-gate.lock`: it deadlocks against the launcher's own lock.
A nested `agent-gate` is safe and runs in place. `gate:ensure` and `gate:run` enter the gate scope
themselves through `agent-gate` (in place when already inside one), so a standalone receipt run
is placed and locked like the scheduler; `gate:check` only reads the cache and starts no scope.
`scripts/gate-parallelism.mjs` sizes
workers from that scope's complete cgroup chain, including the `agents.slice` budget. Frontend
consumers retain the conservative 8 GiB scope / 7 GiB usable fallback if an ancestor limit cannot
be read or no finite limit exists.

The shared Rust allocator applies before the P1 bindings exporter, each admitted Rust lane and
pre-review Windows compilation. Cold calibration covers bindings, native clippy/test, Windows GNU
clippy and nightly coverage. It allocates 8 GiB per compiler job plus 1 GiB Rust overhead, beside
the existing 1 GiB generic reserve. The largest measured process was native test at 6704693248
bytes, about 6.24 GiB. Known budgets below 9 GiB usable refuse before compilation. Unavailable
detection uses a one-job Rust fallback assuming that minimum, which requires 10 GiB including the
reserve and does not establish that an unknown machine has sufficient memory. CPU sizing and
lower valid inherited `CARGO_BUILD_JOBS` limits still apply, including Cargo's negative/default
semantics. Ordinary Cargo configuration cannot raise the computed bound. Libtest concurrency is
unchanged. Pre-review heavyweight mutation also waits for Windows compilation and its cleanup.
This removes observed cold compiler collisions at the cost of slower cold gates or explicit
insufficient-budget refusal, without omitting proof. Replace the exclusive admission or sizing
costs only after comparable cold measurements support the replacement with identical proof and
containment, and delete this operative prose with the replaced mechanism.

The e2e container runs with a 4 GiB limit reserved from frontend coverage and from frontend
mutation only when mutation shares its concurrent schedule. The schedule and its constants are
`d-20260930-03`, `d-20261002-01` (placement), and `d-20261002-03` (reserve). This Rust admission
replaces only the concurrent Rust and Rust-related frontend-share clauses of `d-20260930-04`.

## Mutation gate routing

Decision id: `d-20261101-06`. The local push gate runs the full frontend suite (receipt-backed,
unchanged). Per-push CI (`test.yml` job `frontend-mutation`) runs one package per matrix job via
`FRONTEND_MUTATION_PACKAGE`, skips when no path in the frontend mutation input superset changed
since `FRONTEND_MUTATION_CHANGED_SINCE` (any doubt runs), and reuses Stryker incremental results
only from a forced full sweep of today or yesterday (restore-only cache). `mutation.yml` runs that
forced frontend sweep daily (02:17 UTC) and alone publishes the dated cache. The backend suite
stays there weekly, with the eight packages as a matrix over `BACKEND_MUTATION_PACKAGE`.
`gate-receipt.mjs` strips `FRONTEND_MUTATION_*` from gate children.

## Backend mutation snapshot and recovery

`pnpm mutation:backend` runs `cargo-mutants --in-place` inside a verified private
snapshot under the system temporary directory, outside the checkout. It copies tracked
working-tree inputs and the required built `dist/` as independent files, refuses symlinks
or an inconsistent capture, and requires `pnpm build-vite` first. Cargo uses the reusable
`mutants.out/backend/cargo-target` cache, never the live `src-tauri/target`. Reports stay at
`mutants.out/backend/<package>/`. Mutation therefore cannot inject source or build output
into a checkout being read by another gate.

The runner still refuses a dirty `src-tauri` or failing Git, and holds an exclusive durable
regular-file fence at `mutants.out/backend/.mutation-in-progress`. Whole atomic owner records
name the runner, snapshot, cache and Linux Python 3 subreaper. Cleanup requires its terminal
evidence proving all descendants have been reaped across groups/sessions, then checks the live
tree for legacy cargo-mutants markers before removing the snapshot and fence. Missing evidence
or an unsafe cleanup retains owned state. The cache remains for the next run.

The next run or `pnpm mutation:guard:check`, which `$push` runs before any other gate, refuses
an existing fence and prints ordered recovery: stop every relevant mutation descendant,
restore **only** live files marked by a legacy interrupted in-place run, remove the recorded
snapshot only when its path is valid, then remove the fence.

## Rust build output eviction

`d-20261031-04`. An advisory P0 step `rust-target-eviction` (`pnpm rust:target:evict`) runs after
the mutation guard and before `setup-rust` when the push gate selects `rust` or `bindings`. It
is not a pre-review step.

The unit is a cargo build directory that contains `.cargo-lock`, found at most three levels
below `src-tauri/target` or `mutants.out/backend/cargo-target` of every checkout from
`git worktree list`. Size is allocated 512-byte blocks from `lstat`, each inode counted once.

The gating checkout keeps at most 40 GiB per target root (largest evictable units first; nothing
is evicted when the cap is unreachable). Every other checkout loses units with no cargo write
for 7 days (mtime of the unit and its `deps`, `.fingerprint`, `build`, `incremental` children).
A unit in use (a Cargo lock held, or a same-user process running an executable from it), a
fenced mutation cache, or any undetermined observation is skipped, never evicted. Removal
empties the unit in place under `flock -n` on every Cargo lock file present, `.fingerprint`
first, lock files kept.

The step records status `warning` on a non-zero exit, spawn failure or crash, and never changes
the run's exit code or later admission. Unconfirmed child termination stays `failed` and latches
cleanup as for any other step. Each unit and each target root gets one outcome line.
