---
name: push
description: Run ChessRiddle Studio's short push gates on the rebased, reviewed commits, push to the current branch's configured upstream, wait for CI and install. Use when Felix asks to push, or when a drain session or a build run invokes it (push-review-policy section 1); push is not a release or deployment.
disable-model-invocation: false
---

# Push ChessRiddle Studio

Complete the push autonomously. Read `~/.claude/references/push-review-policy.md` first; it is the single source for authorization, attribution, review lenses, model allocation, triage, remediation, and red-gate behavior. This skill adds only ChessRiddle Studio mechanics.

ChessRiddle Studio uses short gates at push; the full suites run in CI on every push, and release
builds run in release.yml. ChessRiddle Studio does not use a push lock.

**Execution order:** establish the exact push scope (§1) → commit known coordination records
(including any known finding closure via `./scripts/findings.py close`) according to
`~/.claude/references/coordination-file-commits.md` → fetch and rebase onto the upstream (policy
§4a item 6, with the range-diff carry or rebased-commit closure) → run the push gates (§2) → push
(§4) on the unchanged verified tree (code push, any single build-tier `tasks/build-ledger.md`
records follow-up push, CI wait on every `Test` job of the pushed HEAD, and install on `master`
after green). Review (§3), repairs and relevant `verify-ui` browser verification run on the staged
diff before each commit, through `.claude/skills/git/SKILL.md`, never at push. A gate repair is
staged, reviewed under §3, committed, and followed by the required push-gate rerun before push.

The workflow owns balanced `drain_stage` start/end records at each boundary: `code-review` for
§3, `repair` for each repair batch, `browser-verification` for the browser pass, `final-gates`
for §2, and `push` for §4, each with concise human-readable phase/round/name detail. Emit the
review, repair and browser records when those stages run before a commit. Parallel
review fixes use one enclosing repair start/end, closed after every repair proof and inspection.
A stage is the last reported state; never infer it from a later command. Review fixes still run the
§2a pre-review checks (`pnpm checks:pre-review`) immediately after each repair batch, before review
resumes, and any changed tree invalidates the push gates. A
build handoff already contains review, repairs, browser verification, and pre-gate coordination-
record commits; do not restart review or start §2 while build lenses or repairs remain outstanding.

For every `drain_stage` emission, source `~/.claude/scripts/lib/drain-breadcrumb.sh` and call it
in the same shell: `source ~/.claude/scripts/lib/drain-breadcrumb.sh && drain_stage start <stage> "<detail>"`
(use `end` for the matching closure). Fresh tool shells do not retain a source from an earlier
command.

## Relationship to the `build` skill

Rule 6b chooses between direct work and the user-wide `build` skill
(`~/.claude/skills/build/SKILL.md`). Build orchestrates planning, implementation, review, and
delivery in one session and consumes this file's gate mapping, sensitive-path globs, review tier,
and project `Skip` catalog instead of duplicating them.

`$push` remains standalone for changes created outside that workflow, including manual commits,
interrupted runs, and accumulated work from another session.

## 1. Establish the exact push scope

- Inspect `git status --porcelain=v1`, `git branch --show-current`, `git rev-parse --abbrev-ref @{u}`, `git remote get-url origin`, and `git remote get-url --push origin`.
- This repository's expected remote is `felixabeck/chessriddle-studio` in either of its two legitimate forms — `git@github.com:felixabeck/chessriddle-studio.git` (the `tuxedo-atlas` clone) or `https://github.com/felixabeck/chessriddle-studio.git`. Any other owner, repository or host is a stop. Reject a separate `remote.origin.pushurl`. In an opted-in linked worktree, require `.project.json`'s `worktreeBuilds.target` to be `master` and the branch's configured upstream to be `origin/master`. Otherwise the current local branch must track the same-named `origin/<branch>`, so `master` must track `origin/master`. Commits on a `build/*` or `drain/*` branch may reach `master` only through that opted-in worktree push route. Stop for Felix if any identity is missing or different. Never invent or change a remote/upstream.
- Build an explicit owned-path manifest from files created or edited in the invoking conversation plus file scopes assigned to its finished workers. Compare it with the initial status. Ambiguous or foreign paths are excluded and left untouched. Commits already ahead of the upstream in this single-user checkout are Felix's own agents' unpushed work, reviewed before their commits: attribute them under `~/.claude/references/push-review-policy.md` §§1–2 and carry them with this push, never a reason to stop for Felix; stop only for a committer outside the Multi-Agent rubric or an unexpected remote (§1). A drain session (`--yes` at drain start) or a `build` run invoking this skill is the explicit push request. Owned work is committed through `.claude/skills/git/SKILL.md` before `$push`, in cohesive atomic commits of manifest paths, never with `git add -A`; `$push` itself commits only known coordination records (§4).
- Gates execute against the complete worktree. Therefore stop before any compile, generator, formatter, or browser gate when a foreign dirty path is code, generated output, dependency/configuration, test, asset, locale, workflow, or another input to an affected gate. Only clearly inert foreign Markdown/planning files may remain. Never generate or commit an owned output from foreign dirty inputs.
- Every workflow-created commit carries the acting agent as committer through the session-native committer contract (policy §1; never a per-command prefix), as named in the committer rubric of `/home/felixb/Projekte/agent-kit/references/multi-agent-coordination.md`: `Claude Code`, `Grok` for the Grok CLI run in Felix's terminal, or `GrokBot` for Felix's Grok Bot desktop assistant. Leave the author untouched and add no co-author trailer.
- Determine pushed files from `BASE=$(git merge-base HEAD @{u})` and `git diff --name-only "$BASE"..HEAD`; they select the §2 gate flags (a proof of an already-published range uses the launch-upstream SHA in place of `@{u}`, see Related tests). Owned uncommitted work is staged, reviewed under §3 and committed through `.claude/skills/git/SKILL.md` before the push starts. `$push` runs no lenses; the only lens run at push is policy §4a item 6's rebased-commit closure.

Markdown/planning-only changes need no *build* gate; the contract gate still runs. Their pre-commit review and clean-diff checks still apply.

## 2. Run affected gates

These are the declared push gates. Run them on the clean rebased HEAD, after known
coordination-record commits and the policy §4a item 6 rebase. Run them through the push
gate scheduler:

```bash
pnpm gates:push -- <blocks>
```

Choose flags from the changed paths: `--rust` for Rust/Tauri changes, `--frontend` for frontend
changes, and all three flags for cross-layer contracts or changes to workflows, dependencies, or
toolchain inputs. A Markdown/planning-only push uses no flags. The mutation guard and contract lane
run on every invocation; the runner also runs the fenced commands below as their lane contents.
P2 first runs the light stage: contract, bundle and rust-lint concurrently. Every selected light
lane must terminate green before `related-tests` starts (when `--rust`, `--frontend`, or
`--bindings` is selected). Full Rust tests, both coverage ratchets, and e2e run in CI
(`.github/workflows/test.yml`); frontend mutation runs daily in `.github/workflows/mutation.yml`.
In both push and pre-review mode, the first failed step or lane blocks every further step, lane
and lane command. Advisory warnings do not block starts. Selected gates that never started are
reported as skipped with a reason naming the first red gate. Running commands finish under their
existing supervision. A running multi-command lane starts no further command and records stopped
with that reason and no exit code (d-20261105-04, d-20261105-05). Signals and unconfirmed child
cleanup retain precedence over the red-gate reason. Exit-code precedence is unchanged. A failure
is repaired as a staged diff, reviewed under §3 and committed, then the push gates rerun.

ChessRiddle Studio does not use the push lock; a rejected push means rebase, rerun
`pnpm gates:push` (about 5 minutes) and push again.

`pnpm gates:push` and `pnpm checks:pre-review` run in the caller's scope (`d-20261124-02`); only
Rust-compiling commands — P1 `bindings-check`, `rust-lint`'s `cargo clippy` and
`pnpm rust:windows:check`, pre-review `windows-clippy`, and `related-tests` `cargo test` — are
spawned through `agent-gate`, serialised run-wide so one run never has two `agent-gate` calls alive
at once, with `CARGO_BUILD_JOBS` sized inside each gate scope. Non-Rust lanes were measured below
the 6 GiB session-scope threshold on 2026-11-24 on `tuxedo-felix` at `bb9d374f6` (2.25 GiB
pre-review, 1.51 GiB push `--frontend` light part, 3.97 GiB `vitest related` over 246 files;
0 OOM kills, 0 swap). Read `.claude/rules/gate-tooling.md` "Scheduling and placement" before
running a gate for admission, worker sizing, exit 125 and nesting. The shared
[gate-performance reference](~/.claude/references/gate-performance.md) owns machine slots and caps.

No command that can rewrite a tracked file — `pnpm bindings:generate`, a stale `pnpm bindings:check`,
`pnpm i18n:extract`, `pnpm format`, `pnpm lint:fix` — runs concurrently with any gate, in this
session, a parallel script, or a review lens working in the checkout (`f-20260906-06`). Each gate
transcript lands in `artifacts/gates/<run>/`, with the newest 100 runs retained.

**Gate on the exit code, never on a line of output.** `pnpm lint:ci && echo green || echo red` reports the failure and still leaves the shell at exit 0, so a `&&`-chained commit behind it proceeds over a red gate. Check `$?` (or `${PIPESTATUS[0]}` behind a pipe, with `set -o pipefail`) and stop. *Measured 2026-08-29: a formatting failure was printed as `lint:ci RED` and the same command committed and pushed anyway, which took a second commit to repair.*

### Unconditional contract gate

Run the contract gate on every push and every path, including Markdown and planning changes:

```bash
pnpm gates:contract:check
```

The mutation guard stays the chain's first member. It refuses an existing backend fence before
any other gate starts, including retained private-snapshot runs and legacy interrupted live
mutations. New backend mutation runs change only an external snapshot and a mutation-only cache,
so a run starting after the guard cannot inject source or build output into the live checkout.
Recovery still checks the live tree for legacy markers (`f-20260829-09`). In CI every job starts
from a fresh checkout.

### Rust/Tauri backend

Affected by `src-tauri/**` or root Rust/Tauri configuration:

```bash
bash scripts/setup-rust.sh
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --locked -- -D warnings
pnpm rust:windows:check
```

`cargo clippy --all-targets` type-checks test targets as well. The 2026-09-30 probe inserted a
type error in the `#[cfg(test)]` function `set_test_lexer_hook` in `src-tauri/src/lexer.rs`: the
fenced clippy command exited 101 with E0308, and exited 0 without the probe. This is why the
separate `cargo check` step was removed from this block and CI.

The canonical [gate-tooling contract](../../rules/gate-tooling.md#scheduling-and-placement)
owns Rust admission and allocation policy, implemented by `rustBuildEnvironment` in
`scripts/gate-parallelism.mjs`.

`pnpm rust:windows:check` covers GNU-target type-checking and linting only. Full Rust tests, the
backend coverage ratchet, the MSVC target (`rust-platform`), and all Windows/macOS tests remain
CI-only in `.github/workflows/test.yml`. If the gate is red because a toolchain prerequisite is
missing, run the setup commands it prints and rerun the gate.

`spawn cargo ENOENT` from any of these means `~/.cargo/bin` is missing from that shell's `PATH`, not that the checkout is broken — prefix the call with `PATH="$HOME/.cargo/bin:$PATH"`.

### TypeScript/React frontend

Affected by `src/**`, `public/**`, `index.html`, `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `vite.config.*`, or i18n configuration/catalogs:

```bash
pnpm build-vite
pnpm bundle:check
```

The runner always builds `dist/` in P1 before cargo and bundle consumers. Tauri's
`frontendDist: "../dist"` is a compile input through `generate_context!`; measured 2026-09-29, an
otherwise no-op cargo check re-checked the crate after `pnpm build-vite`. Rust-only and
bindings-only runs also rebuild `dist/`, even when an ignored directory already exists. `bundle:check`
reads `dist/.vite/manifest.json` written by `build-vite`. Full frontend coverage (`test:coverage` and
`coverage:frontend:check`) and `test:e2e:container` run in CI (`.github/workflows/test.yml`).

As a contract-gate member, `ui:boundary:check` scans the whole tree, reading files from disk, so it sees committed and uncommitted content alike. It was diff-scoped for two of its rules until 2026-08-29, which made those two vacuous on any clean checkout — including every CI run.

The coverage floors in `coverage-areas.json` / `backend-coverage-areas.json` and the baselines in the two `*-baselines.json` files are ratchets, and `bundle-budgets.json` caps gzip bytes. A red ratchet is a finding about the diff. Never run `coverage:baseline:*` or change a coverage baseline or floor to make a gate pass. Do not repair a red bundle check with a blind numeric ceiling change. The only permitted ceiling increase is the existing conscious feature-growth route in `docs/bundle-budgets.md`: before the ceiling is updated, a recorded technical decision must provide comparable published-base and candidate production measurements and a rationale showing that required behavior is preserved, and independent review must approve the change. Red checks remain defects, normal proofs remain mandatory, and push gates must pass on the clean reviewed HEAD.

For visible UI changes, run the repo-local `$verify-ui` workflow during the browser-verification
stage, after review repairs and before the commit (it owns
`pnpm test:e2e:container` and the live Tauri-window check). Retain screenshots of every affected
flow. Missing screenshots are not evidence that layout is correct.

### Cross-layer contracts

Changes to Specta commands/events/types, `src-tauri/src/main.rs`, or `src/bindings/generated.ts` require both backend and frontend gates plus:

```bash
pnpm bindings:check
```

That command runs the debug Specta exporter in export-only mode and then proves the checked-in binding is exact; the exporter writes `src/bindings/generated.ts` only when its bytes differ, so a green check leaves the file untouched. Never hand-edit a generated binding to make the gate pass.

### Findings ledger

`pnpm findings:kit:check` wraps the required `kit sync --check .` gate. It runs
`env -u KIT_ROOT kit sync --check .` and is local-only (CI has no kit). The script
already clears `KIT_ROOT`, so an inherited value cannot point the check at another
kit tree; the `env -u KIT_ROOT` below is kept for the same reason at the call site.
It runs on **every** push: `scripts/findings.py` is the kit's vendored copy, and this
line fails if those bytes have drifted from the **released** kit.

The gate deliberately names no path into `~/Projekte/agent-kit`. `kit` on PATH resolves
to `$HOME/.local/share/agent-kit/current/bin/kit`, an immutable release worktree that
only a gated kit push publishes, so an unfinished edit saved in the kit's workbench can
no longer redden or silence this gate.

```bash
env -u KIT_ROOT pnpm findings:kit:check
```

`./scripts/findings.py check` is a member of the unconditional contract gate (the generic
writer tests live in agent-kit since 2026-10-13). It validates the ledger: a malformed header or an area outside the closed
vocabulary silently drops a finding out of the derived queue, which is exactly the loss the ledger
exists to prevent. `tasks/findings.md` names this gate as `$push`'s job, so it runs here.

`scripts/findings.py` is byte-identical across Felix's projects by contract, so **nothing
repository-specific may be added to it**; a change there is a change to every copy. Its behaviour,
including the `_atomic_write` failure reporting of f-20260829-14, is tested in agent-kit.

### CI, dependencies, and release mechanics

Changes to workflows also run every gate whose toolchain they can affect. Changes to `package.json`,
`pnpm-lock.yaml`, `src-tauri/Cargo.toml`, or `src-tauri/Cargo.lock` do the same.
- `pnpm verify:app` is not a push gate: it drives the real Tauri window through `tauri-driver` under an off-screen compositor, so it needs a release build and a compositor that CI does not have. Run it by hand when a diff changes lifecycle, IPC or process teardown — it is the only check in this repository that observes the actual product. `d-20260830-18` and `.claude/skills/verify-ui/SKILL.md` carry the contract and the limits.
- The frontend mutation suite is not a push gate (neither locally nor in `.github/workflows/test.yml`). `.github/workflows/mutation.yml` runs the forced full frontend sweep daily (02:17 UTC) and publishes per-package baseline artifacts for manual `pnpm mutation:frontend` runs, which reuse today's or yesterday's UTC sweep unless `--full` is passed (see `gate-tooling.md`). Ordinary sizing charges each Stryker runner 2432 MiB (`STRYKER_RUNNER_BYTES`, re-measured 2026-10-31 for f-20261022-05; the measurement is recorded on the constant). The backend suite remains only in `.github/workflows/mutation.yml` (dispatchable, weekly, one job per package) because the eight packages take about an hour. **Never start `pnpm mutation:backend` as part of a push:** its eight-package schedule stays outside push gates. It runs `cargo-mutants --in-place` only in a verified external snapshot, uses `mutants.out/backend/cargo-target` instead of the live target, and requires Linux Python 3 descendant containment. The durable fence and first guard remain for incomplete cleanup and legacy interrupted live mutations (`f-20260829-09`).
- Exercise changed shell/workflow mechanics against their refusal/error case where locally possible.
- `$push` never tags, publishes a GitHub release, signs bundles, or deploys. Those require their own explicit workflow.

## Related tests

In push mode (`pnpm gates:push` with `--rust`, `--frontend`, or `--bindings`), the `related-tests`
lane runs automatically after every selected light lane terminates green. It inspects existing
changed paths from `git merge-base HEAD @{u}..HEAD` plus dirty paths (deleted paths excluded; a
missing upstream fails the lane). An empty changed-path set fails the lane instead of passing with
zero commands (`f-20261124-03`). A gate proof of an already-published range, where `HEAD` = `@{u}`
(a drain resume's `push-gate` attempt), passes `--base <sha>` naming the range's start (the
launch-upstream SHA, policy "Canonical headless gate route"), so the lane diffs from
`git merge-base HEAD <sha>`. The same SHA replaces `@{u}` when choosing the flags (§1). No scripts branch is needed because the `contract` lane already
runs every `scripts/*-tests.mjs`.

The lane, every pre-commit check (git skill) and build phase proofs (agent-kit build skill) use the same two commands:

- `src/**` and `scripts/**/*.mjs` other than `*-tests.mjs`: `pnpm exec vitest related --run --passWithNoTests <paths>`.
- `src-tauri/src/**/*.rs`: one `cargo test --manifest-path src-tauri/Cargo.toml --locked --bins -- <module>:: ...` command with one filter per changed module (`src-tauri/src/a/b.rs` → `a::b::`, `mod.rs` → its directory module), under the shared Rust allocator. A changed `src-tauri/src/main.rs`, `src-tauri/src/lib.rs`, `src-tauri/build.rs`, `Cargo.toml` or `Cargo.lock` runs the whole `--bins` suite without filters. The crate has only a binary target, so `--lib` does not apply. If `cargo` is missing, prefix with `PATH="$HOME/.cargo/bin:$PATH"`.

Pre-commit checks and build phase proofs additionally run, for a changed `scripts/<name>.mjs`, `node --test` on every matching `scripts/*-tests.mjs` file (`git grep -l <name> -- 'scripts/*-tests.mjs'`) plus changed `*-tests.mjs` files themselves; at push the contract lane covers these.

Verified forms (2026-11-02): Vitest related ran 4171 tests for `src/utils/annotation.ts`. The cargo filter `lexer::` ran 12 tests.

## 2a. Pre-review checks

Run this before each pre-commit review (build step 5 phase review; step 6 only on cumulative
file overlap) and after every repair batch, before a closure round over a diff. A red pre-review run is repaired
before review starts or resumes. These cheap, changed-path checks do not replace the push
gates in §2.

```bash
pnpm checks:pre-review
```

The scheduler selects only lanes whose inputs changed. The frontend build runs first whenever the
Windows clippy or bundle lane is selected, those lanes consume its `dist/` output. Windows clippy
uses the same Rust allocation as push. Signals and unconfirmed cleanup prevent queued starts. Commands in the selected lanes are:

```bash
pnpm build-vite
pnpm exec oxfmt --check <changed-format-files>
pnpm exec oxlint --deny-warnings <changed-js-ts-files>
pnpm exec tsgo --noEmit
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
pnpm coverage:mapping:frontend
pnpm coverage:mapping:backend
pnpm rust:windows:check
pnpm bundle:check
```

## 3. Independent review and remediation

Run the review on the staged diff before each commit, exactly as
`~/.claude/references/push-review-policy.md` §§2–4a specify — named lenses over
`git diff --cached -- <owned paths>` read with full `merge-base..HEAD` context;
`review-correctness` and `review-root-cause` always on; the rest when their `description:` line
applies. `.claude/skills/git/SKILL.md` runs this step; `$push` does not. Every finding
gets a `Fix` / `Defer` / `Skip(reason)` verdict. Out-of-area findings are `Defer`d autonomously
through the project ledger/inbox workflow (policy §4, universal rule 4b); ledger-backed deferrals
need no manual handoff prompt. Never ask Felix which.

Record paths follow policy §1b: `tasks/findings.md`, `tasks/decisions.md`, `tasks/build-ledger.md`
and `tasks/handoffs/**` are ledger records, reviewed by `./scripts/findings.py check` and excluded
from the §3 fan-out's DIFF. ChessRiddle Studio has no other record paths.

A path below is a Sensitive-Path glob: a hit is `--role sensitive` for that lens (and for
fixes); everything else is `--role normal`. The globs do not replace named-lens selection.

```text
src-tauri/capabilities/**
src-tauri/tauri.conf.json
src-tauri/src/oauth.rs
src-tauri/src/fs.rs
src-tauri/src/pgn.rs
src-tauri/src/puzzle.rs
src-tauri/src/infra/**
src-tauri/src/db/**
src-tauri/src/chess.rs
src-tauri/src/game.rs
src-tauri/src/engine/**
src-tauri/src/main.rs
src/bindings/generated.ts
src/state/**
src/utils/lichess/**
src/utils/session.ts
src/components/home/Account*.tsx
src/routes/accounts*.tsx
src/components/engines/**
.github/workflows/**
package.json
pnpm-lock.yaml
src-tauri/Cargo.toml
src-tauri/Cargo.lock
```

`review-tauri-security` is a mandatory additive lens whenever the diff touches any of these
paths:

```text
src-tauri/src/oauth.rs
src-tauri/src/credentials.rs
src/utils/session.ts
src-tauri/src/fs.rs
src-tauri/src/infra/**
docs/signed-download-manifests.md
```

It does not replace `review-ipc-contract`: capability and CSP scope, `src-tauri/tauri.conf.json`,
the Specta registry and generated bindings, and listener lifetimes remain owned by that lens.

**Repairs:** read and follow `~/.claude/references/push-review-policy.md` §5 before
implementing any adopted `Fix`.

Repair every `Fix`, inspect each repair diff, and rerun every gate invalidated by the repair.
Security and filesystem refusal paths must be exercised, not merely read.

The lens executor, its model rungs and the fallback switch are governed by `~/.claude/references/review-lens-contract.md` and `~/.claude/references/executor-profiles.md`. Do not restate them here; a fallback run is disclosed in the report as that contract requires.

## Project `Skip` catalog

ChessRiddle Studio adds these rejected actions to the shared policy §4 `Skip` catalog:

* Rebaselining coverage or lowering a coverage floor to clear a ratchet.
* Re-recording e2e snapshots natively.
* Hand-editing `src/bindings/generated.ts`.
* Running `mutation:backend` during a push.
* Widening a capability scope to make a build pass.

## Override keywords

Use the exact-string override keywords from
`~/.claude/references/push-review-policy.md` §7.

## 4. Commit, push, and verify

- Implementation commits arrive reviewed (§3, through `.claude/skills/git/SKILL.md`). Commit the
  coordination records already known to the run according to
  `~/.claude/references/coordination-file-commits.md` — **including any finding closure
  (`./scripts/findings.py close`)** — using the attribution above and only the remaining authorized
  paths, then fetch and rebase under policy §4a item 6 and run §2. These commits precede the push
  gates so no closure commit follows the code push and the post-push record stays a single commit.
- Require `git diff --check`, all push gates green on the final tree, and no unresolved `Fix` finding.
- If a push gate requires a repair, stage it, review it under §3, commit it, and rerun the affected
  push gates on the changed tree before push. The push then uses the unchanged verified tree.
- Before pushing, apply the shared policy §8 "A red remote is a red gate" by running:

```bash
pnpm ci:remote:check
```

  It checks the `Test` workflow (newest 30 runs) and the daily `Mutation` workflow's frontend jobs
  (newest 10 runs, skipping Sunday backend-only runs and cancelled runs where frontend jobs are
  `skipped` or `cancelled`; if no frontend result exists in 10 runs it reports that without
  failing). For each red `Test` job `J` on the branch, its **red streak** is the maximal run of
  consecutive completed `Test` runs (newest first) whose `J` is non-success; its first red run is
  the oldest of them (`headSha` = first red SHA). Attribution is undetermined when an older `Test`
  run between the newest red and the last success for `J` is not completed yet, no success for
  `J` exists in the 30-run window, or a needed `gh` query fails.
  Streak ownership and the 120-minute `* **Repair owner:**` reservation follow policy §8 "Red
  streaks and repair owners" (agent-kit d-20261123-02) for every session and drain.
  Exit 1 refuses the push unless this push's commits repair the finding that owns every listed red
  job (for non-push `Mutation` sweeps, policy §8 clears a red once the finding citing that same run
  id in `**CI run:** <id>` is handled). If any listed red job has no owning finding, file it first
  through `./scripts/findings.py file`; filing a finding alone never licenses a code push (policy §8
  names the one records-only exception for that filing). Exit 2 refuses the push and reports its
  cause. Only `success` passes for `Test`: `skipped`, `neutral` and every other non-success
  conclusion are red because no `Test` workflow job is skipped by design. Policy §8 is the source
  of this refusal rule. The §2 gate locally type-checks and lints the `x86_64-pc-windows-gnu` target;
  `rust-windows-test`, `rust-macos-test` and `rust-platform` remain CI-only alongside the Linux
  heavy suites (`frontend`, `e2e`, `rust`).
- Record `<old>` (`git rev-parse @{u}`) before pushing so post-push CI attribution can check
  `<old>..<new>`. In an opted-in linked worktree, recheck that `worktreeBuilds.target` is `master`
  and the branch still tracks `origin/master`, then push its rebased commits with exactly
  `git push origin HEAD:refs/heads/master`. Never push a `build/*` or `drain/*` branch or open it
  as a PR. Otherwise run ordinary non-force `git push` to the configured upstream. Verify local
  `HEAD` equals `@{u}`.
- Build tier only: write and commit the single post-push records-only `tasks/build-ledger.md` run
  row (push SHA, gate timings, review counts; CI and install cells say `"CI pending at record time"`)
  and push it.
- Wait on **every `Test` job** of the pushed HEAD (`<new>`, which is the records SHA
  when the build-ledger row was pushed; its `Test` run tests the code commit too) and gate on each
  job's `conclusion`, never on the run having started (the Windows/macOS jobs take about five to
  ten minutes, and the Linux jobs run in parallel across `frontend`, `e2e`, and `rust`).
  Exception for runner infrastructure: when a red job's failing or timed-out step is a setup step
  (`Set up job`, checkout, `Set up repository dependencies`, toolchain install) and no repository
  check had started, wait until the whole run has completed, then run
  `gh run rerun <run-id> --failed` once and wait again. A second red, or a hang in any later step,
  takes the red-job path below. Every job carries `timeout-minutes`, which does not cover a job
  still `queued`: if the run has not completed 120 minutes after the push, cancel it, rerun it once,
  and if that attempt also misses 120 minutes, stop the wait and report the push as landed with CI
  unconfirmed, naming the stuck jobs.
- If **green** (every `Test` job of `<new>` concludes `success`) and the push went to `master`, run the installer only from a
  checkout whose `HEAD` equals the verified pushed SHA, normally the pushing worktree. Check that
  equality immediately before invoking the installer. A main checkout on `master` is eligible only
  when its `HEAD` equals that same SHA. The installer performs a Tauri release build followed by an
  atomic swap of `~/.local/opt/chessriddle-studio/current`:

```bash
agent-gate bash scripts/install-local.sh
```

  The release `rustc` alone peaks above 4 GB, so the installer runs in its own `agent-gate` scope
  like the other heavy gates; run directly inside an agent session's 8 GiB scope it was OOM-killed
  on 2026-11-16 (f-20261116-03). Exit 125 means `agent-gate` refused before anything started. This
  is how a pushed change reaches the application-menu entry Felix uses; nothing else updates it,
  and it is not a release or deployment. Report the installed short commit from
  `~/.local/opt/chessriddle-studio/current/VERSION`. In a `build` run, only then release its run
  lock (`bash ~/.claude/scripts/build-run-lock.sh release`) and remove the worktree it owns
  (`kit worktree remove <path>`). If the build fails, the push stands and the failure is
  reported as its own blocker — the previous installed copy keeps running.
- If **red**, read the failing tests from `gh api repos/<owner>/<repo>/actions/jobs/<job-id>/logs`
  (because `gh run view --log-failed` returned nothing for these runs on 2026-09-19) and run
  `pnpm ci:remote:check --owner <old>..<new>` (full 40-hex SHAs; ignores `Mutation`; resolves the
  pushed commit set with `git rev-list`; exit 2 refuses when `<new>`'s `Test` run is not completed
  or not in the window, or when any red job's attribution is undetermined — wait and re-check if an
  older `Test` run is still in progress):
  - **Own red** (exit 1; some red `Test` job's first red SHA is in `<old>..<new>`): if the run
    closed a finding pre-gate, reopen it with
    `./scripts/findings.py set-header <id> --status open --note-file <note>` where `<note>`
    carries `* **CI run:** <first red run id>` and
    `* **Repair owner:** <session id> on <host>, <ISO time>`; for a red with no finding, file one
    through `./scripts/findings.py file` with those lines (or annotate an already-open finding).
    Push the records-only change under policy §8's exception, then claim it locally
    (`./scripts/findings.py next --pin <id> --claim`). Do **not** install that SHA. Return to
    `repair`, gate, and push again through the ordinary route.
  - **Inherited red** (exit 0; every red `Test` job's first red SHA is outside `<old>..<new>`):
    report the inherited red job(s) and their attribution (first red run, SHA, subject) in the push
    report, do **not** repair, do **not** install that SHA, and finish.
- The post-push coordination-record exception remains governed by
  `~/.claude/references/coordination-file-commits.md`; it does not generalize to implementation changes.
- Report commits, destination, gate results, review findings/verdicts, CI/install outcome, and that
  no release/deployment occurred.
- On any persistent red gate, follow the shared policy: do not push and report the exact blocker.

ChessRiddle Studio override to shared policy §7: this workflow never performs a force push. A message containing `force push` requires a separate stop for the exact refspec and force-with-lease decision; it is not treated as an automatic gate-skip-and-push marker here.

## Project review lenses


Adversarial review runs in two tiers, and names never collide between them. Project-independent
lenses live in `~/.claude/agents/`, ChessRiddle Studio-specific ones in `.claude/agents/`.

| Lens | Owns | Triggered by a diff touching |
| --- | --- | --- |
| `review-chess-semantics` | position identity from FEN fields, ply/colour parity off a non-standard start FEN, `number[]` move paths after tree mutation, mainline-vs-variation assumptions | `src/utils/treeReducer.ts`, `src/state/store/tree.ts`, `src/utils/chess*.ts`, `src/utils/repertoire.ts`, `src/components/common/GameNotation.tsx`, `src/components/panels/practice/**`, `src-tauri/src/chess.rs`, `src-tauri/src/game.rs` |
| `review-engine-protocol` | UCI process lifecycle, multipv aggregation, cached option state, binding an async result to the position/tab/engine that asked | `src-tauri/src/engine/**`, `src-tauri/src/chess.rs`, `src/components/engines/**`, `src/components/panels/analysis/**`, `src/components/boards/EvalListener.tsx`, `src/utils/engines.ts` |
| `review-ipc-contract` | bare-string events vs. the Specta registry, correlation ids on broadcasts, stale generated bindings, listener lifetimes, capability scope | `src-tauri/src/main.rs`, any `#[tauri::command]`, any emit/listen call, `src/bindings/**`, `src/platform/**`, `src-tauri/capabilities/**`, `src-tauri/tauri.conf.json` |
| `review-persisted-state` | `sessionStorage`/`localStorage` size and quota, write/read symmetry, keys shared across tabs, hydration of corrupt or absent data | `src/state/**`, `src/hooks/**`, `src/utils/tabs.ts`, `src/components/tabs/**`, any direct web-storage access |
| `review-pgn-index` | game-boundary detection, the cached byte-offset index, reader position, `CastlingMode` symmetry across encode/decode, whole-file materialisation | `src-tauri/src/pgn.rs`, `src-tauri/src/lexer.rs`, `src-tauri/src/db/**`, `src-tauri/src/opening.rs`, `src-tauri/src/puzzle.rs`, `src/components/tabs/ImportModal.tsx`, `src/utils/db.ts` |
| `review-tauri-security` | OAuth token acquisition, credential storage and refresh, renderer-session sanitization, path containment and recursive deletion, signed download manifest verification, bearer-token and raw-diagnostic egress | `src-tauri/src/oauth.rs`, `src-tauri/src/credentials.rs`, `src/utils/session.ts`, `src-tauri/src/fs.rs`, `src-tauri/src/infra/**`, `docs/signed-download-manifests.md` |
| `review-platform-semantics` | OS behavior of filesystem, handle, process and FFI code; platform-gated test parity across Linux, macOS and Windows | `src-tauri/src/**` with `cfg` on `target_os`, `windows` or `unix`, or filesystem/process/handle/FFI code; tests with platform-specific fixtures or cfg-gated helpers |

Which lenses review a staged diff is decided by `~/.claude/references/push-review-policy.md`; this table
says what each one knows, so a plan can be sanity-checked against the right lens before code exists.


## Findings ledger

Deferred findings go on disk the moment they are found, per universal rule 4b — never only into a
session's context, and never only into a handoff message.

- The ledger is `tasks/findings.md`, an **append-only log**; the work queue is derived from it by
  `./scripts/findings.py`, grouped by `Root` only; findings without a root are singletons,
  ranked by relation then age. Position in the file carries no meaning.
- **File every new finding with one command**, whether or not a drain is running. Write the complete
  `###` entry to a file with `**ID:** f-PENDING`, then run
  `./scripts/findings.py file <path-to-entry-file>`. It validates, publishes atomically
  through the inbox spool `tasks/findings-inbox/`, and reports the allocated id — or, if a drain
  holds the lock, that the drain will merge it. **Never pick an id yourself and never edit
  `tasks/findings.md` by hand while a drain is running.**
- `./scripts/findings.py next` picks the next cluster, `related` finds siblings before you
  file, `decisions` lists what is parked on Felix, `drain-status` answers whether a drain is
  running (exit 0 = yes). `check` validates every header and the area vocabulary.
- `tasks/decisions.md` records the technical calls made while working findings, so a later session
  reads them instead of re-deriving the question.
- The area vocabulary is a **closed set**, listed in the ledger header; `check` rejects any other
  value. Adding an area is a deliberate edit to that list.
- The universal contract — field meanings, ranking, the decision discipline, the lock protocol — is
  `~/.claude/references/findings-ledger-contract.md`. `scripts/findings.py` is the vendored copy
  of `~/Projekte/agent-kit/scripts/findings.py`, written by `kit sync` and verified byte-exact by
  `kit sync --check` apart from the `agent-kit-sha256` stamp line that `kit sync` itself inserts
  after the shebang; nothing
  project-specific may be added to it — project specifics live in the ledger header.

CI runs `./scripts/findings.py check` in `.github/workflows/test.yml`. Run it directly whenever
a diff touches `tasks/`.


## Multi-agent coordination

Shared contract: `/home/felixb/Projekte/agent-kit/references/multi-agent-coordination.md`.
This repository is worked on by Claude Code, Grok and Antigravity (`agy`) leaves.

**Division of labour.** The selected orchestrator uses the user-wide `build` skill
(`~/.claude/skills/build/SKILL.md`) when its proportionality rule calls for it, and reads project
gates from `.claude/skills/push/SKILL.md`. Executor selection and leaf launch belong to
`~/.claude/references/executor-profiles.md`.

* Claude Code reads `.claude/skills/push/SKILL.md` directly, and
  `.grok/rules/grok-chessfable.md` points Grok at the canonical file.
* Gate scope is split. Per commit and after every repair batch, run `pnpm checks:pre-review` from
  `.claude/skills/push/SKILL.md`, plus the related tests and the §3 staged-diff review before the
  commit. At push, run `pnpm gates:push`; the full suites run in CI. Never commit on red.

### Worktree builds

* **DO:** run `build` in its own worktree via `kit worktree create`. Outreach, records and small edits stay in the main checkout on `master`.
* **DO:** start drains with the usual `drain-findings.sh` command from the main checkout. It automatically creates or reuses its own drain worktree. `--stop`/`--resume`/`--queue-plans` from the main checkout reach it. Run `findings.py` with the worktree as cwd.
* **DO NOT:** push a `build/*` or `drain/*` branch or open it as a PR. Only its rebased commits reach `master` through `git push origin HEAD:refs/heads/master`, with upstream `origin/master`.
* Dev-server ports stay shared across checkouts. Coordinate `pnpm dev` with any existing dev server before starting another checkout.
* All Rust checkouts share the sccache compile cache through machine wiring in tuxedo-config's `rust-toolchain` module, with no repository Cargo configuration.


## Other-agent coordination


* Commit as the acting agent (`Claude Code`, `Grok` or `GrokBot`) through the session-native committer contract (§1);
  author stays Felix Beck, with no co-author or AI trailer.
* Per commit, run `pnpm checks:pre-review`, the related tests and the §3 staged-diff review;
  at push, run `pnpm gates:push`; the full suites run in CI. Never commit on red.
* Handoffs longer than a few lines go in `tasks/handoffs/YYYY-MM-DD-<slug>.md`, never through Felix;
  pass the receiving agent the file path.

### Worktree builds

* **DO:** run `build` in its own worktree via `kit worktree create`. Outreach, records and small edits stay in the main checkout on `master`.
* **DO:** start drains with the usual `drain-findings.sh` command from the main checkout. It automatically creates or reuses its own drain worktree. `--stop`/`--resume`/`--queue-plans` from the main checkout reach it. Run `findings.py` with the worktree as cwd.
* **DO NOT:** push a `build/*` or `drain/*` branch or open it as a PR. Only its rebased commits reach `master` through `git push origin HEAD:refs/heads/master`, with upstream `origin/master`.
* Dev-server ports stay shared across checkouts. Coordinate `pnpm dev` with any existing dev server before starting another checkout.
* All Rust checkouts share the sccache compile cache through machine wiring in tuxedo-config's `rust-toolchain` module, with no repository Cargo configuration.


## Findings you cannot fix here

A defect you find outside your assignment is not a question for Felix and not a chat note — it goes
on disk immediately. Write the complete `###` entry to a file with `**ID:** f-PENDING`, then run
`./scripts/findings.py file <path-to-entry-file>`. Never pick an id yourself, never edit
`tasks/findings.md` by hand. `./scripts/findings.py related --area <a> --file <p>` first, so
you extend an existing finding instead of filing a duplicate. The area vocabulary is a closed set in
the ledger header. Full contract: the "Findings ledger" section of `CLAUDE.md`.

## Additional gate cautions

Never add another `flock` on `heavy-gate.lock`: it deadlocks against the launcher's own lock.
Never start `pnpm mutation:backend` as part of a push. Never `git checkout -- src-tauri` wholesale,
which destroys a concurrent editor's work along with a legacy mutant.

Gate scripts live in `package.json`. The path mapping and any direct tool invocations live in the
canonical push contract.

- Generated bindings are proven by `pnpm bindings:check`. Regenerate with `pnpm bindings:generate`, never hand-edit `src/bindings/generated.ts`.
- Coverage and bundle size are ratcheted. Never lower a floor or rewrite a baseline to accept a regression — see `docs/coverage.md`.

Mechanical classes already covered by a checker, so review effort belongs elsewhere:
untranslated JSX and missing locale keys (`pnpm i18n:jsx`, `pnpm i18n:check`), direct
`@tauri-apps/*` imports and raw `listen()` outside the platform facade
(`pnpm tauri:boundary:check`), exported IPC commands without a production renderer consumer
(`pnpm ipc:consumers:check`), and direct `ActionIcon`/`Modal` imports plus unsafe focus resets
(`pnpm ui:boundary:check`).

Executable gate schedules live in `scripts/run-push-gates.mjs`.
