---
name: push
description: Validate, independently review, remediate, commit, and ordinarily push ChessFable changes to the current branch's configured upstream. Use when Felix asks to push, or when a drain session or a build run invokes it (push-review-policy section 1); push is not a release or deployment.
disable-model-invocation: false
---

# Push ChessFable

Complete the push autonomously. Read `~/.claude/references/push-review-policy.md` first; it is the single source for authorization, attribution, review lenses, model allocation, triage, remediation, and red-gate behavior. This skill adds only ChessFable mechanics.

**Execution order:** establish the exact push scope (§1) → run pre-review checks (§2a) on the last
implementation phase → complete review and arbitration with repairs (§3), including any preliminary
checks needed to reproduce review claims → run relevant browser verification through `verify-ui` →
commit implementation changes and known coordination records according to
`~/.claude/references/coordination-file-commits.md` → run the final affected gates (§2) → push (§4)
on the unchanged verified tree. A gate repair returns to `repair`, commit, and the required affected
final-gate rerun before push.

The workflow owns balanced `drain_stage` start/end records at each boundary: `code-review` for
§3, `repair` for each repair batch, `browser-verification` for the browser pass, `final-gates`
for §2, and `push` for §4, each with concise human-readable phase/round/name detail. Parallel
review fixes use one enclosing repair start/end, closed after every repair proof and inspection.
A stage is the last reported state; never infer it from a later command. Review fixes still run the
§2a pre-review checks (`pnpm checks:pre-review`) immediately after each repair batch, before review
resumes, and any changed tree invalidates the final gates. A
build handoff already contains review, repairs, browser verification, and pre-gate coordination-
record commits; do not restart review or start §2 while build lenses or repairs remain outstanding.

For every `drain_stage` emission, source `~/.claude/scripts/lib/drain-breadcrumb.sh` and call it
in the same shell: `source ~/.claude/scripts/lib/drain-breadcrumb.sh && drain_stage start <stage> "<detail>"`
(use `end` for the matching closure). Fresh tool shells do not retain a source from an earlier
command.

## Relationship to the `build` skill

The normal route for a change is the user-wide `build` skill
(`~/.claude/skills/build/SKILL.md`). It orchestrates planning, implementation, review, and
delivery in one session and consumes this file's gate mapping, sensitive-path globs, review tier,
and project `Skip` catalog instead of duplicating them.

`$push` remains standalone for changes created outside that workflow, including manual commits,
interrupted runs, and accumulated work from another session.

## 1. Establish the exact push scope

- Inspect `git status --porcelain=v1`, `git branch --show-current`, `git rev-parse --abbrev-ref @{u}`, `git remote get-url origin`, and `git remote get-url --push origin`.
- This repository's expected remote is `felixabeck/en-croissant` in either of its two legitimate forms — `git@github.com:felixabeck/en-croissant.git` (the `tuxedo-atlas` clone) or `https://github.com/felixabeck/en-croissant.git`. Any other owner, repository or host is a stop. Reject a separate `remote.origin.pushurl`. In an opted-in linked worktree, require `.project.json`'s `worktreeBuilds.target` to be `master` and the branch's configured upstream to be `origin/master`. Otherwise the current local branch must track the same-named `origin/<branch>`, so `master` must track `origin/master`. Commits on a `build/*` or `drain/*` branch may reach `master` only through that opted-in worktree push route. Stop for Felix if any identity is missing or different. Never invent or change a remote/upstream.
- Build an explicit owned-path manifest from files created or edited in the invoking conversation plus file scopes assigned to its finished workers. Compare it with the initial status. Ambiguous or foreign paths are excluded and left untouched. Commits already ahead of the upstream in this single-user checkout are Felix's own agents' unpushed work: they are in the reviewed range (`~/.claude/references/push-review-policy.md` §2) and are carried by this push, never a reason to stop for Felix; stop only for a committer outside the Multi-Agent rubric or an unexpected remote (§1). A drain session (`--yes` at drain start) or a `build` run invoking this skill is the explicit push request. Commit only manifest paths in cohesive atomic commits and never use `git add -A`.
- Gates execute against the complete worktree. Therefore stop before any compile, generator, formatter, or browser gate when a foreign dirty path is code, generated output, dependency/configuration, test, asset, locale, workflow, or another input to an affected gate. Only clearly inert foreign Markdown/planning files may remain. Never generate or commit an owned output from foreign dirty inputs.
- Every workflow-created commit sets `GIT_COMMITTER_NAME` to the acting agent per `~/.claude/references/push-review-policy.md` §1 (`Claude Code`, `Codex`, or `Grok`). Leave the author untouched and add no co-author trailer.
- Determine pushed files from `BASE=$(git merge-base HEAD @{u})` and both the committed and owned dirty diffs. Review `git diff "$BASE"..HEAD`, `git diff -- <owned tracked paths>`, `git diff --cached -- <owned tracked paths>`, plus each owned untracked file as a new-file diff. An explicit push includes already-ahead commits, so review their effective diff too.

Markdown/planning-only changes need no *build* gate; the contract gate still runs. They still require the shared review and clean-diff checks.

## 2. Run affected gates

These are the final affected gates. Run them only after review/arbitration and repairs (§3),
relevant browser verification, and known coordination-record commits. Run them through the push
gate scheduler:

```bash
pnpm gates:push -- <blocks>
```

Choose flags from the changed paths: `--rust` for Rust/Tauri changes, `--frontend` for frontend
changes, and all three flags for cross-layer contracts or changes to workflows, dependencies, or
toolchain inputs. A Markdown/planning-only push uses no flags. The mutation guard and contract lane
run on every invocation; the runner also runs the fenced commands below as their lane contents.
One complete Rust lane runs at a time in declaration order, alongside contract and bundle.
Frontend coverage and mutation wait for every Rust lane to terminate, then retain their frontend
budget, e2e reservation and CPU rules. Ordinary Rust failures do not skip later selected lanes.
Known limitation: the scheduler does not yet follow the shared push policy §8 "Fail-fast gate order" (no further start after a red); tracked as f-20261102-05.
Signals or unconfirmed child cleanup stop queued starts. A failure
returns to `repair`, commit, and the required affected final-gate rerun before push.

`pnpm gates:push` and `pnpm checks:pre-review` run through `agent-gate`. Read
`.claude/rules/gate-tooling.md` "Scheduling and placement" before running a gate for admission,
worker sizing, e2e reservation, exit 125 and nesting. The shared
[gate-performance reference](~/.claude/references/gate-performance.md) owns machine slots and caps.

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
pnpm gate:ensure backend-test
pnpm gate:ensure backend-coverage
```

`cargo clippy --all-targets` type-checks test targets as well. The 2026-09-30 probe inserted a
type error in the `#[cfg(test)]` function `set_test_lexer_hook` in `src-tauri/src/lexer.rs`: the
fenced clippy command exited 101 with E0308, and exited 0 without the probe. This is why the
separate `cargo check` step was removed from this block and CI.

The canonical [gate-tooling contract](../../rules/gate-tooling.md#scheduling-and-placement)
owns Rust admission and allocation policy, implemented by `rustBuildEnvironment` in
`scripts/gate-parallelism.mjs`.

`pnpm rust:windows:check` covers GNU-target type-checking and linting only. The MSVC target
(`rust-platform`) and all Windows tests (`rust-windows-test`) remain CI-only. If the gate is red
because a toolchain prerequisite is missing, run the setup commands it prints and rerun the gate.

`test:coverage:backend` needs the pinned `nightly-2025-06-01` toolchain with `llvm-tools-preview` and `cargo-llvm-cov` 0.8.7 (the versions `.github/workflows/test.yml` installs); `coverage:backend:check` reads the LCOV it writes, so the two run in that order. `spawn cargo ENOENT` from any of these means `~/.cargo/bin` is missing from that shell's `PATH`, not that the checkout is broken — prefix the call with `PATH="$HOME/.cargo/bin:$PATH"`.

### TypeScript/React frontend

Affected by `src/**`, `public/**`, `index.html`, `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `vite.config.*`, `stryker.config.mjs`, `scripts/run-frontend-mutation.mjs`, `scripts/frontend-mutation-packages.mjs`, or i18n configuration/catalogs:

```bash
pnpm gate:ensure frontend-coverage
pnpm gate:ensure frontend-mutation
pnpm gate:run frontend-build
pnpm bundle:check
pnpm gate:ensure e2e-container
```

The runner always builds `dist/` in P1 before cargo and bundle consumers. Tauri's
`frontendDist: "../dist"` is a compile input through `generate_context!`; measured 2026-09-29, an
otherwise no-op cargo check re-checked the crate after `pnpm build-vite`. `gate:run` is required
because the receipt fingerprints tracked files while `dist/` is ignored, so a receipt cannot prove
that `dist/` came from this tree. The e2e container runs its own `vite build` into the mounted tree,
so it starts after bundle and every selected cargo lane finishes. Rust-only and bindings-only runs
also rebuild `dist/`, even when an ignored directory already exists.

The order is not cosmetic: `coverage:frontend:check` reads `coverage/lcov.info` written by `test:coverage`, and `bundle:check` reads `dist/.vite/manifest.json` written by `build-vite`. `pnpm test` alone is not sufficient — it produces no LCOV, so the coverage ratchet then measures a stale or absent file.

As a contract-gate member, `ui:boundary:check` scans the whole tree, reading files from disk, so it sees committed and uncommitted content alike. It was diff-scoped for two of its rules until 2026-08-29, which made those two vacuous on any clean checkout — including every CI run.

The coverage floors in `coverage-areas.json` / `backend-coverage-areas.json` and the baselines in the two `*-baselines.json` files are ratchets, and `bundle-budgets.json` caps gzip bytes. A red ratchet is a finding about the diff. Never run `coverage:baseline:*` or change a coverage baseline or floor to make a gate pass. Do not repair a red bundle check with a blind numeric ceiling change. The only permitted ceiling increase is the existing conscious feature-growth route in `docs/bundle-budgets.md`: before the ceiling is updated, a recorded technical decision must provide comparable published-base and candidate production measurements and a rationale showing that required behavior is preserved, and independent review must approve the change. Red checks remain defects, normal proofs remain mandatory, and final gates must pass on the clean reviewed HEAD.

For visible UI changes, run the repo-local `$verify-ui` workflow during the browser-verification
stage, after review repairs and before known coordination-record commits and final gates (it owns
`pnpm test:e2e:container` and the live Tauri-window check). Retain screenshots of every affected
flow. Missing screenshots are not evidence that layout is correct.

### Exact-tree gate receipts

The seven expensive gates are registered in `scripts/gate-receipt.mjs`. Use `ensure` for normal gate
runs, `run` when fresh evidence is required, and `check` only to query the cache:

```bash
pnpm gate:ensure backend-test
pnpm gate:ensure backend-coverage
pnpm gate:ensure frontend-coverage
pnpm gate:ensure frontend-mutation
pnpm gate:ensure frontend-build
pnpm gate:ensure e2e-container
pnpm gate:ensure tauri-build
pnpm gate:run frontend-build
pnpm gate:check frontend-build
```

`gate:check` only reads the cache and starts no scope; how `gate:ensure` and `gate:run` are placed is in `.claude/rules/gate-tooling.md`.

Receipts are reusable only for a clean exact tree with the same command, platform, toolchain, and
an unexpired timestamp. A miss runs the gate under `ensure`; `check` never starts one. Gate failures
propagate their own exit codes, and a tree change during a run refuses the receipt.

That refusal keys on tracked-file size and mtime, not only bytes, so **receipt-backed gates may run
concurrently**: the 2026-09-29 parallel run recorded receipts for all passing gates with no tree
change refusal. The tracked-file-rewriter prohibition remains: no command that can rewrite a
tracked file — `pnpm bindings:generate`, a stale `pnpm bindings:check`, `pnpm i18n:extract`,
`pnpm format`, `pnpm lint:fix` — runs concurrently with any of them, in this session, a parallel
script, or a review lens working in the checkout (`f-20260906-06`).

Each gate transcript lands in `artifacts/gates/<run>/receipt-<gate>.log`, with the newest 100
runs retained and the scheduler's run directory shared when run as a lane.
A failed gate's last own output line names its transcript; through `pnpm gate:*`, only pnpm's
one `ELIFECYCLE` line follows.

`bindings:check` stays in P1 after the `dist/` build and before receipt-backed lanes because it
compiles against `dist/` and conditionally rewrites `src/bindings/generated.ts` when stale. The
contract lane's `lint:ci` runs `i18next-cli extract --ci`, which is also a conditional rewriter.
Measured on a clean tree on 2026-09-30, it exited 0 without changing the size or mtime of any
tracked translation file; a stale tree makes it write and then fail, so any concurrent receipt
gate refuses the changed tree and the overall run remains red. The contract gate is also the
runner's `contract` lane, followed by the required local kit-parity check.

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
- The frontend mutation suite is a receipt-backed frontend push gate: run it through `pnpm gate:ensure frontend-mutation`. CI runs it per package with a change skip and bounded incremental reuse, and `.github/workflows/mutation.yml` runs the full sweep daily. Ordinary sizing charges each Stryker runner 2432 MiB (`STRYKER_RUNNER_BYTES`, re-measured 2026-10-31 for f-20261022-05; the measurement is recorded on the constant). In the laptop's 11596410880-byte `agent-gate` scope that schedules all four packages as three slots of one runner each and one changed package as one slot of three runners; both completed on 2026-10-31 with no OOM event or swap use. Historical: on 2026-10-02 the suite took 346.9 s as the last lane of an all-blocks `pnpm gates:push` with 21 runners per package under the former 1.2 GiB charge (`tasks/handoffs/2026-10-02-agent-gate-convergence-review.md`). The backend suite remains only in `.github/workflows/mutation.yml` (dispatchable, weekly, one job per package) because the eight packages take about an hour. **Never start `pnpm mutation:backend` as part of a push:** its eight-package schedule stays outside push gates. It runs `cargo-mutants --in-place` only in a verified external snapshot, uses `mutants.out/backend/cargo-target` instead of the live target, and requires Linux Python 3 descendant containment. The durable fence and first guard remain for incomplete cleanup and legacy interrupted live mutations (`f-20260829-09`).
- Exercise changed shell/workflow mechanics against their refusal/error case where locally possible.
- `$push` never tags, publishes a GitHub release, signs bundles, or deploys. Those require their own explicit workflow.

## Related tests

For build phase proofs (agent-kit build skill), append tests for the phase's changed and created paths:

- `src/**` and other Vitest-covered TypeScript paths: `pnpm exec vitest related --run <paths>`.
- `src-tauri/src/**/*.rs`: run per changed module with `cargo test --manifest-path src-tauri/Cargo.toml --locked --bins -- <module path>::` (`src-tauri/src/a/b.rs` → `a::b`, `mod.rs` → its directory module, `main.rs` → no filter). The crate has only a binary target, so `--lib` does not apply. If `cargo` is missing, prefix with `PATH="$HOME/.cargo/bin:$PATH"`.
- `scripts/<name>.mjs`: run `node --test` on every matching `scripts/*-tests.mjs` file (`git grep -l <name> -- 'scripts/*-tests.mjs'`), plus changed `*-tests.mjs` files themselves.

Verified forms (2026-11-02): Vitest related ran 4171 tests for `src/utils/annotation.ts`; cargo filter `lexer::` ran 12 tests.

## 2a. Pre-review checks

Run this after the last implementation phase and after every repair batch, before code review
(including build step 6) and before a closure round over a diff. A red pre-review run is repaired
before review starts or resumes. These cheap, changed-path checks do not replace the final affected
gates in §2.

```bash
pnpm checks:pre-review
```

The scheduler selects only lanes whose inputs changed. The frontend build runs first whenever the
Windows clippy or bundle lane is selected, those lanes consume its `dist/` output. Windows clippy
uses the same Rust allocation as push and completes before heavyweight mutation starts, including
when the budget allows concurrent frontend work. Signals and unconfirmed cleanup prevent queued
starts. Commands in the selected lanes are:

```bash
pnpm gate:run frontend-build
pnpm exec oxfmt --check <changed-format-files>
pnpm exec oxlint --deny-warnings <changed-js-ts-files>
pnpm exec tsgo --noEmit
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
pnpm coverage:mapping:frontend
pnpm coverage:mapping:backend
pnpm mutation:frontend -- --files <comma-separated-production-files>
pnpm rust:windows:check
pnpm bundle:check
```

## 3. Independent review and remediation

Run the review exactly as `~/.claude/references/push-review-policy.md` §§2–4 specify — named
lenses over the effective pushed diff plus enclosing code; `review-correctness` and
`review-root-cause` always on; the rest when their `description:` line applies. Every finding
gets a `Fix` / `Defer` / `Skip(reason)` verdict. Out-of-area findings are `Defer`d autonomously
through the project ledger/inbox workflow (policy §4, universal rule 4b); ledger-backed deferrals
need no manual handoff prompt. Never ask Felix which.

Records-only pushes use policy §1b's single records lens instead of this fan-out. For a mixed range,
run the §3 fan-out over a DIFF excluding the record paths and, in parallel, the records lens over
the record paths, as §1b specifies. ChessFable's record paths are `tasks/findings.md`,
`tasks/decisions.md`, `tasks/build-ledger.md` and `tasks/handoffs/**`.

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
src/components/common/AccountCards.tsx
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

ChessFable adds these rejected actions to the shared policy §4 `Skip` catalog:

* Rebaselining coverage or lowering a coverage floor to clear a ratchet.
* Re-recording e2e snapshots natively.
* Hand-editing `src/bindings/generated.ts`.
* Running `mutation:backend` during a push.
* Widening a capability scope to make a build pass.

## Override keywords

Use the exact-string override keywords from
`~/.claude/references/push-review-policy.md` §7.

## 4. Commit, push, and verify

- After review, repairs, and browser verification, commit implementation changes and coordination
  records already known to the run according to `~/.claude/references/coordination-file-commits.md`,
  using the attribution above and only the remaining authorized paths. These commits precede the
  final affected gates.
- Require `git diff --check`, all affected gates green on the final tree, and no unresolved `Fix` finding.
- If a final gate requires a repair, return to `repair`, commit the repair, and rerun the affected
  final gates on the changed tree before push. The push then uses the unchanged verified tree.
- Before pushing, apply the shared policy §8 "A red remote is a red gate" by running:

```bash
pnpm ci:remote:check
```

  Exit 1 refuses the push unless this push's commits repair the finding that owns every listed red
  job. If any listed red job has no owning finding, file it first through `./scripts/findings.py file`;
  filing a finding alone never licenses the push. Exit 2 refuses the push and reports its
  cause. Only `success` passes: `skipped`, `neutral` and every other non-success conclusion are red
  because no `Test` workflow job is skipped by design. Policy §8 is the source of this refusal
  rule. The §2 gate locally type-checks and lints the `x86_64-pc-windows-gnu` target; the jobs this
  machine cannot reproduce remain `rust-windows-test`, `rust-macos-test` and the `rust-platform`
  matrix of the `Test` workflow, including the MSVC target. All Windows tests stay CI-only. These
  named jobs only decide what to wait for after the push.
- In an opted-in linked worktree, recheck that `worktreeBuilds.target` is `master` and the branch still tracks `origin/master`, then push its rebased commits with exactly `git push origin HEAD:refs/heads/master`. Never push a `build/*` or `drain/*` branch or open it as a PR. Otherwise run ordinary non-force `git push` to the configured upstream.
- Verify local `HEAD` equals `@{u}` and report commits, destination, gate results, review findings/verdicts, and that no release/deployment occurred.
- Wait for those jobs on the pushed SHA (the Windows/macOS jobs take about five to ten minutes,
  and the Linux jobs run in parallel across frontend, e2e, rust, and per-package frontend-mutation)
  and gate on each job's `conclusion`, never on the run having started. Red returns to
  `repair`; read the failing tests from `gh api repos/<owner>/<repo>/actions/jobs/<job-id>/logs`,
  because `gh run view --log-failed` returned nothing for these runs on 2026-09-19.
- The post-push coordination-record exception remains governed by
  `~/.claude/references/coordination-file-commits.md`; it does not generalize to implementation changes.
- After a verified push to `master`, including the required remote-CI wait above, run the installer only from a checkout whose `HEAD` equals the verified pushed SHA, normally the pushing worktree. Check that equality immediately before invoking the installer. A main checkout on `master` is eligible only when its `HEAD` equals that same SHA. The installer performs a Tauri release build followed by an atomic swap of `~/.local/opt/chessfable/current`:

```bash
bash scripts/install-local.sh
```

  This is how a pushed change reaches the application-menu entry Felix uses; nothing else updates it, and it is not a release or deployment. Report the installed short commit from `~/.local/opt/chessfable/current/VERSION`. If the build fails, the push stands and the failure is reported as its own blocker — the previous installed copy keeps running.
- On any persistent red gate, follow the shared policy: do not push and report the exact blocker.

ChessFable override to shared policy §7: this workflow never performs a force push. A message containing `force push` requires a separate stop for the exact refspec and force-with-lease decision; it is not treated as an automatic gate-skip-and-push marker here.

## Project review lenses


Adversarial review runs in two tiers, and names never collide between them. Project-independent
lenses live in `~/.claude/agents/`, ChessFable-specific ones in `.claude/agents/`.

| Lens | Owns | Triggered by a diff touching |
| --- | --- | --- |
| `review-chess-semantics` | position identity from FEN fields, ply/colour parity off a non-standard start FEN, `number[]` move paths after tree mutation, mainline-vs-variation assumptions | `src/utils/treeReducer.ts`, `src/state/store/tree.ts`, `src/utils/chess*.ts`, `src/utils/repertoire.ts`, `src/components/common/GameNotation.tsx`, `src/components/panels/practice/**`, `src-tauri/src/chess.rs`, `src-tauri/src/game.rs` |
| `review-engine-protocol` | UCI process lifecycle, multipv aggregation, cached option state, binding an async result to the position/tab/engine that asked | `src-tauri/src/engine/**`, `src-tauri/src/chess.rs`, `src/components/engines/**`, `src/components/panels/analysis/**`, `src/components/boards/EvalListener.tsx`, `src/utils/engines.ts` |
| `review-ipc-contract` | bare-string events vs. the Specta registry, correlation ids on broadcasts, stale generated bindings, listener lifetimes, capability scope | `src-tauri/src/main.rs`, any `#[tauri::command]`, any emit/listen call, `src/bindings/**`, `src/platform/**`, `src-tauri/capabilities/**`, `src-tauri/tauri.conf.json` |
| `review-persisted-state` | `sessionStorage`/`localStorage` size and quota, write/read symmetry, keys shared across tabs, hydration of corrupt or absent data | `src/state/**`, `src/hooks/**`, `src/utils/tabs.ts`, `src/components/tabs/**`, any direct web-storage access |
| `review-pgn-index` | game-boundary detection, the cached byte-offset index, reader position, `CastlingMode` symmetry across encode/decode, whole-file materialisation | `src-tauri/src/pgn.rs`, `src-tauri/src/lexer.rs`, `src-tauri/src/db/**`, `src-tauri/src/opening.rs`, `src-tauri/src/puzzle.rs`, `src/components/tabs/ImportModal.tsx`, `src/utils/db.ts` |
| `review-tauri-security` | OAuth token acquisition, credential storage and refresh, renderer-session sanitization, path containment and recursive deletion, signed download manifest verification, bearer-token and raw-diagnostic egress | `src-tauri/src/oauth.rs`, `src-tauri/src/credentials.rs`, `src/utils/session.ts`, `src-tauri/src/fs.rs`, `src-tauri/src/infra/**`, `docs/signed-download-manifests.md` |
| `review-platform-semantics` | OS behavior of filesystem, handle, process and FFI code; platform-gated test parity across Linux, macOS and Windows | `src-tauri/src/**` with `cfg` on `target_os`, `windows` or `unix`, or filesystem/process/handle/FFI code; tests with platform-specific fixtures or cfg-gated helpers |

Which lenses run for a push is decided by `~/.claude/references/push-review-policy.md`; this table
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
This repository is worked on by Claude Code, Codex, and Grok.

**Division of labour.** The selected orchestrator uses the user-wide `build` skill
(`~/.claude/skills/build/SKILL.md`) when its proportionality rule calls for it, and reads project
gates from `.claude/skills/push/SKILL.md`. Executor selection and leaf launch belong to
`~/.claude/references/executor-profiles.md`; Codex orchestration uses
`~/.codex/skills/build/SKILL.md`. An interactive Codex session
follows `~/.claude/references/codex-interactive-workflow.md`, including its scoped commit
authorization.

* Claude Code reads `.claude/skills/push/SKILL.md` directly; Codex reaches it through
  `.agents/skills/push/SKILL.md`, whose Codex delta names its own committer; and
  `.grok/rules/grok-chessfable.md` points at the canonical file.
* Gate scope is split. Per commit and after every repair batch, run `pnpm checks:pre-review` from
  `.claude/skills/push/SKILL.md`. Once per task, after the last commit, run the full affected set.
  Never commit on red.

### Worktree builds

* **DO:** run `build` in its own worktree via `kit worktree create`. Outreach, records and small edits stay in the main checkout on `master`.
* **DO:** start drains with the usual `drain-findings.sh` command from the main checkout. It automatically creates or reuses its own drain worktree. `--stop`/`--resume`/`--queue-plans` from the main checkout reach it. Run `findings.py` with the worktree as cwd.
* **DO NOT:** push a `build/*` or `drain/*` branch or open it as a PR. Only its rebased commits reach `master` through `git push origin HEAD:refs/heads/master`, with upstream `origin/master`.
* Dev-server ports stay shared across checkouts. Coordinate `pnpm dev` with any existing dev server before starting another checkout.
* All Rust checkouts share the sccache compile cache through machine wiring in tuxedo-config's `rust-toolchain` module, with no repository Cargo configuration.


## Other-agent coordination


* Set `GIT_COMMITTER_NAME` to the acting agent (`Claude Code`, `Codex`, or `Grok`); author stays
  Felix Beck, with no co-author or AI trailer. Claude Code reads `.claude/skills/push/SKILL.md`,
  Codex reaches it through `.agents/skills/push/SKILL.md`, whose delta names `Codex`, and
  `.grok/rules/grok-chessfable.md` points at the canonical file.
* Per commit, run the narrowest affected checks from the canonical push mapping; once per task,
  after the last commit, run the full affected set. Never commit on red.
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
