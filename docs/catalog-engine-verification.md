# Real signed catalog engine verification

Run `pnpm verify:catalog-engines` on native Linux x86_64, Windows x86_64 or macOS
x86_64/aarch64 after installing the repository's pinned Node, pnpm and Rust tools,
native Tauri build prerequisites, and building the frontend with
`pnpm gate:run frontend-build`. The frontend directory is a Tauri compile input.
Use the existing Rust setup and per-checkout Cargo target/cache configuration.
No application window, user profile, signing secret or release permission is needed.

The command enables the non-default empty Cargo feature `catalog-network-tests`,
selects the feature module with the single `fs::tests::catalog_network::` filter,
discovers exactly these three runnable tests, and executes them with output visible:

```text
fs::tests::catalog_network::cleanup_failure_retains_case_owners_until_process_exit
fs::tests::catalog_network::cleanup_summary_reports_authority_and_native_platform_status
fs::tests::catalog_network::real_signed_catalog_engines_install_register_and_configure
```

Exactly one test performs real network installation and UCI. The other two regress
cleanup ownership and the actual cleanup-summary formatter. Discovery must find exactly
the three explicit names above. Execution must report all three discovered tests passed
and zero failed or ignored tests. Cargo failures, signals, missing discovery, missing success
summary and excessive output make the command fail. The launcher returns 1 on failure
and conventional signal status on interruption. Each Cargo child's observed status is
printed as `CATALOG_STATUS`. Both captured and emitted output are limited to 1 MiB per
command using the existing log size constant. Excess output is drained and discarded
until native work finishes, then fails. There is no automatic retry or abandoned
timeout future. A failed real download remains a failure.

All network-only code lives inline inside `fs::tests` behind the feature. Default
builds, discovery and backend coverage do not compile it. Never enable this feature
in ordinary coverage or add it to default features. Existing fixture tests continue
to cover offline integrity, archive and authority refusals. Removal path: delete the
feature, inline module, package command, launcher, workflow and this document together
when another existing runtime check proves the same production chain.

The test verifies the exact bundled catalog bytes and detached signature with the
production release key before parsing. It selects every entry for the native OS,
including both CPU variants, without a hardcoded engine list or count. Only identical
URL, digest, signature and nested executable path share an execution. Each alias has
its own reported result. Different paths in the same archive each get a fresh install
and handshake. Unsupported architectures and zero native selection fail.

Each distinct executable gets a new canonical temporary root, isolated authority,
engine workspace, operation registry and supervisor. Canonical temporary paths avoid
macOS's `/var` alias. The authority is opened through the existing platform-aware
`PathAuthority::open_for_engine_test`, including the macOS launch root. Shared
non-network fixture helpers create the workspace for both callers. Existing default
fixtures retain their directory-before-authority order and `path-authority.json`
registry spelling. The network fixture uses the platform helper's `registry.json`.
A fresh destination prevents adoption from bypassing transport
and digest checks. The directory contract matches `installCatalogEngine`:
`<last URL component>-<full lowercase sha256>`. Production `ProdTransport`, signed
artifact validation, streamed digest checking, extraction/publication,
`register_installed_engine` and `get_engine_config_core` run unchanged. Registration
owns executable permission. A nonempty parsed engine name and successful return from
the production `uci`/`uciok` exchange are required. `REGISTERED`, `UCI_OK`, `PASS` and
`ALIAS` lines identify results, alongside entry index, name/version, digest and path.

Each native download runs through `run_native_operation`, which observes completion
and releases its lease before delivering the result. Case errors and caught panics
still await and inspect `EngineSupervisor::terminate_all`. Only after successful
physical teardown does the test seal and inspect operation drain, clear originating-session
catalog use through the blocking gateway, await `crate::shutdown_engine_launch_root`
for an initialized authority, and remove the scratch root. `CLEANUP_OK` reports
`catalog-session=cleared` only after session clearing, or
`catalog-session=skipped-uninitialized` after setup failed before authority installation.
It reports `launch-root=reclaimed` only after successful macOS reclaim,
`launch-root=skipped-uninitialized` for uninitialized macOS authority, and
`launch-root=not-applicable` on Linux and Windows, where the shutdown facade is a noop.
These statuses describe cleanup, independently of the primary case outcome.

Supervisor, operation or authority cleanup failure fails the check and reports
`RETAINED <path> reason=<stage> owners=process-lifetime`, preserving the scratch path,
native cleanup error and primary case outcome. The shared feature-only failure helper
intentionally retains the actual owned `AppState` using `std::mem::forget`, under
decision `d-20261016-29`. Keeping only
the scratch directory would drop the final supervisor and its pending `ChildOwner`,
executable leases and original child handle after a failed termination attempt finishes.
The same helper preserves operation-registry and authority owners if their cleanup
cannot safely finish. Retention lasts until the test process exits, with at most one
retained state per finite selected unique executable in that invocation. Retained scratch
directories remain on disk for diagnosis. Successful cleanup drops owners normally and
removes scratch. No production lifecycle changes, new registry, retry or timeout wrapper
are introduced. There is no hidden successful retry or conversion of failure to green.
Reversal path: remove this retention when an existing guaranteed terminal owner can
replace it while preserving child handles and executable/resource leases until confirmed
OS wait, plus operation and authority ownership through their terminal cleanup.

The feature-only `cleanup_failure_retains_case_owners_until_process_exit` regression
uses the existing failing actor fixture and real supervisor termination failure, then
passes the owned state through the same failure helper used by all three cleanup branches.
Weak supervisor handles observe continued ownership after the helper returns. It also
checks retained scratch, failure context and normal owner drop after successful teardown.
The three stage labels exercise the shared helper, not real operation-drain or authority
failures. It intentionally retains a fixed three childless fixture states until process
exit, separately from the at-most-one retained real `AppState` per selected distinct
executable. The successful control state is dropped. The actor fixture has no native
child, executable or native child lease. This proves helper ownership,
not an OS-unreapable native process or native lease retention under a staged wait failure.
The repair adds no verifier failure exit. Existing `supervisor-cleanup`,
`operation-cleanup` and `authority-cleanup` refusals remain argued at the native end-to-end
boundary in the historical matrix below. Its staged evidence remains unchanged.

The feature-only `cleanup_summary_reports_authority_and_native_platform_status`
regression asserts two complete visible lines from the same `cleanup_summary` function
used by `verify_case` output. Initialized authority reports a cleared catalog session,
uninitialized authority reports a skipped session. Both Linux and Windows report
`launch-root=not-applicable` in either case. Native macOS expects `reclaimed` only for
initialized authority and `skipped-uninitialized` otherwise. The regression uses exact
platform-specific expected strings without a second status computation. These assertions
verify output formatting after cleanup succeeds, not staged native cleanup failures.

The native download, archive size, UCI and physical
reaping bounds stay in force. Independent cases run sequentially and errors are
aggregated, including failed aliases. CPU instruction and native library failures
remain failed native cases. Windows LC0's CUDA prerequisites must be tested as
advertised, with no catalog suppression.

## Workflow operating contract

Phase 2 adds the sole `.github/workflows/catalog-engines.yml`, named `Catalog engines`.
Use native Linux x86_64, Windows x86_64 and macOS runners on a supported universal-binary
architecture. Cross-compilation is additional compile proof only. Each job uses the
repository-pinned setup and Rust cache conventions, installs existing OS prerequisites,
builds the frontend, then runs the same `pnpm verify:catalog-engines` command. Use
`contents: read`, no signing secrets, and a finite whole-job timeout that allows all
sequential native cases to reach their production deadlines. A 300-minute job limit
covers the current catalog's distinct executables and setup. Reassess this outer limit
if the catalog grows, without replacing native cleanup with timeout abandonment.

Trigger manual dispatch, weekly schedule and pushes/pull requests changing
`src/catalogs/**`, `src-tauri/Cargo.toml`, `src-tauri/src/fs.rs`, `package.json`,
`scripts/verify-catalog-engines.mjs`, the workflow, and the exercised production
installer, authority, network, operation and engine paths. Include
`src-tauri/src/infra/path_authority/**`, `src-tauri/src/infra/fs.rs`,
`src-tauri/src/infra/net.rs`, `src-tauri/src/infra/operations.rs`,
`src-tauri/src/infra/blocking.rs`, `src-tauri/src/engine/**`,
`src-tauri/src/chess.rs`, `src-tauri/src/main.rs` and release public-key inputs.
Changes to launcher helpers `scripts/child-supervisor.mjs` and
`scripts/gate-logs.mjs` also exercise this command. Keep the network job separate
from ordinary per-push heavyweight gates and default coverage.

Upload bounded per-OS verification output on success and failure. Preserve the native
command's exit status when capturing logs, including pipeline failures. Cache compiled
Rust dependencies only, never installed engines or downloaded archives. Every runtime
verification must download into a new scratch tree. Diagnose a red job without retrying
downloads into a manufactured green result. All three native jobs must be green before
the parent finding closes. Linux evidence alone does not establish Windows/macOS success.

## Phase 1 proof and source failure matrix

Implementation role resolves through `leaf.codex.write.sensitive` to `gpt-6.1-sol`,
effort `high`, with no extra options. Plan authorship and arbitration shared one
context. Detection ran on the same model family as the code. This is session
separation only.

The implementation run's named scratch directory is
`/tmp/catalog-engine-phase1-20261016`. Full command output and observed exit statuses
belong there. Staging changes only disposable input copies under its `snapshot`
directory. Never mutate the live catalog or signatures, verifier assertions or
production implementation. Restore each input and verify green after each mutation.

The tables below are dated Linux implementation-attempt checkpoints from 2026-10-16.
They are historical attempts, not Phase 1 acceptance or release completion evidence.
The root's subsequent frozen-tree proof, recorded in its release handoff, supplies
completion evidence. No future result is predicted here. The root runs the complete original
proof after documentation is finished and no other writer is active.

Implementation attempt 1, before the R-P1-MAC correction, on 2026-10-16:

| Command | Observed exit and result | Full output under the named scratch directory |
| --- | --- | --- |
| `pnpm gate:run frontend-build` | 0, frontend built | `gate-catalog-phase1-frontend.7SgV6K/log` |
| `cargo test --manifest-path src-tauri/Cargo.toml --locked --bin chessriddle-studio -- --list` | 0, 2,442 tests, network test absent | `gate-catalog-phase1-disabled-discovery.BEIEXL/log` |
| `pnpm verify:catalog-engines` | 0, exact enabled discovery, 1 passed, 0 ignored, 4 Linux entries and 3 native executions | `gate-catalog-phase1-network.HtvbfD/log` |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --features catalog-network-tests --locked -- -D warnings` | 0 | `gate-catalog-phase1-clippy.qxi7wG/log` |
| `pnpm gate:ensure backend-coverage` | 143, terminated while queued, coverage body did not start | `gate-catalog-phase1-backend-coverage.TSrpMU/log` |
| `pnpm checks:pre-review` | Not run in this attempt | No run log |

The first coverage attempt ended 143 while queued, after its owned launcher was
terminated. It did not execute coverage and is not a pass. Its full output remains
`gate-catalog-phase1-backend-coverage.TSrpMU/log`. Pre-review was not run in that attempt.
The first staging controller exited 1 because its signal barrier was not observed.
That measurement is explicitly invalid as signal-refusal evidence, as recorded below.
Its output remains `gate-catalog-phase1-staged-inputs.heorDv/log`.

R-P1-MAC source correction resumed in `resume-20261016` under the named scratch root.
Only the shared test fixture setup and feature-only authority setup/cleanup changed.
The launcher has the same assertions and behavior, with formatting differences only.
Previous catalog authentication, signed-schema, scratch-root, scratch-create,
manifest, output-limit and missing-Cargo measurements remain evidence for their
unchanged refusal sites. Their green restorations ran the earlier Linux fixture and
do not prove the new platform setup or reclaim path. The corrected fixture's measured
checkpoint follows below.

Native macOS execution remains the Phase 2 workflow obligation. Linux success and
source inspection do not count as macOS runtime evidence.

Implementation attempt 2 on 2026-10-16 used the corrected fixture and recorded new
output under `resume-20261016`:

| Command | Observed exit and result | Full output under `resume-20261016` |
| --- | --- | --- |
| `pnpm gate:run frontend-build` | 0 | `gate-catalog-p1-resume-frontend.fxDFEU/log` |
| `cargo test --manifest-path src-tauri/Cargo.toml --locked --bin chessriddle-studio -- --list` | 0, 2,442 tests, exact network test absent | `gate-catalog-p1-resume-disabled-discovery.antHW6/log` |
| `pnpm verify:catalog-engines` | 0, exact enabled discovery, 1 passed, 0 ignored, all 4 Linux entries and 3 native executions, 23.87 seconds | `gate-catalog-p1-resume-network.hlgtK9/log` |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --features catalog-network-tests --locked -- -D warnings` | 0 | `gate-catalog-p1-resume-clippy.alyRKA/log` |
| `pnpm gate:ensure backend-coverage` | 3, receipt refused because the tree changed during the gate. 2,440 tests passed, 0 failed, 2 ignored. Coverage ratchet and area floors passed, but the overall command did not pass | `gate-catalog-p1-resume-backend-coverage.Q6o4r7/log` |
| `pnpm checks:pre-review` | 0 | `gate-catalog-p1-resume-pre-review.InlkHa/log` |

The resumed coverage run exported 53 sources and 16,158 branch records. Its final
refusal was `gate receipt refused: backend-coverage — tree changed during the gate`.
The leaf edited this document while the receipt observed the tree, then stopped
changes on exit 3. Passed test and ratchet output is not an overall gate-pass claim.
The pre-review command completed with exit 0 after its queue wait, including its
selected format/lint, backend coverage mapping, Windows Clippy and bundle lanes.
The matching `completion.record` beside each table's log records the wrapper status.

The resumed disposable snapshot baseline exited 0. Its staging controller exited 0
after the three resumed refusals and their restored native runs. Full output is
`resume-20261016/gate-catalog-p1-resume-staged.UfGlip/log`, with the same-directory
`completion.record`. Individual statuses and paths are preserved in both
`staged-results.jsonl` and `resume-20261016/staged-results.jsonl`.

The discovery-only lock measurement observed the actual Cargo artifact-directory
wait while holding the snapshot's `target/debug/.cargo-artifact-lock`. After lock
release, exact discovery exited 0. Evidence is
`resume-20261016/artifact-lock-measurement.json` and its matching `.log`, with canonical
wrapper exit 0 in
`resume-20261016/gate-catalog-p1-artifact-lock-measurement.Fh5zSq/completion.record`.
The earlier resumed probe using `.cargo-lock` and the old build-directory wording
reported `build_wait_observed=false`, discovery 0, and remains preserved separately
as `resume-20261016/cargo-lock-measurement.json` and its matching `.log`. Neither probe
ran an engine. The probe with the unobserved build-directory wait does not count as
refusal evidence.

The first attempt's network execution took 77.33 seconds, and the corrected fixture's
execution took 23.87 seconds. Stockfish 19 returned 19 UCI options.
RubiChess 20240817 returned 20 options for each avx2 and modern executable, with the
modern executable identifying itself as popcnt. All three cases reported inspected
supervisor reaping, drained operations, cleared catalog session use and removed scratch.
The command's enabled discovery and execution Cargo children each exited 0.
Windows/macOS runtime results belong to Phase 2 and remain unproven here.

The historical source-derived exits below enumerate the failure sites in the native
verifier and the original single-test launcher at that checkpoint. The two selector
assertions changed in the closure repair documented below, so their old wording and
one-test counts are historical only. Production errors flow through the corresponding
stage rather than being converted to skipped success. `FAIL` rows aggregate into
the Rust test's nonzero result, normally Cargo status 101 and launcher status 1.
No row is staged until both its distinguishing message and observed status are recorded.

The scratch-root stages use Cargo's native target runner configuration to launch the
unchanged test executable through `/usr/bin/env TMPDIR=<snapshot path>`. This applies
the deliberately broken temporary-root input only to the test process, preserving the
compiler's temporary directory. The runner configuration is invocation-local and is
removed for each green restoration. No verifier, production or fixture logic changes.

The resumed transport stage set the invocation's HTTPS and ALL proxy variables to
`http://catalog-verification-staged.invalid:443` and cleared its NO_PROXY variables.
It exercised unchanged `ProdTransport` and the production installer. Restoring the
invocation environment gave a real native verification exit 0, with no download retry.

The resumed permission stage used a native target runner that set `umask 0777` and
TMPDIR to `resume-20261016/permission-only-temporary-root`, then executed the unchanged
test binary. The private scratch directories had no permissions. Workspace creation
panicked before authority opening, the verifier caught the panic, and scratch removal
then refused with permission denied. Reaching the `scratch-cleanup` label follows
inspected supervisor cleanup, operation drain and the uninitialized-authority route
in the unchanged verifier. This is not a measured authority-open refusal or macOS
launch-root reclaim. The controller inspected the expected messages and absence of
`REGISTERED` or `RETAINED` before restoring permissions and removing only the three
reported scratch paths under that dedicated directory. It then removed the runner
configuration from the invocation and observed restored native verification exit 0.

| Source exit | Distinguishing message | Evidence/status |
| --- | --- | --- |
| Catalog authentication | `catalog-signature: Invalid input: artifact manifest signature verification failed` | Staged by appending a newline to the snapshot catalog. Cargo execution 101, public command 1. Restored native verification 0. Logs `staged-catalog-signature.log` and `staged-catalog-signature-restored-green.log` |
| Signed document parsing | ``catalog-parse: missing field `name` at line 11 column 5`` | Staged by substituting the committed signed database catalog and its matching signature in the snapshot. Authentication succeeded, schema parsing refused. Cargo execution 101, public command 1. Restored native verification 0. Logs `staged-catalog-schema.log` and `staged-catalog-schema-restored-green.log` |
| Native platform | `native-platform: unsupported native environment` | Argued on this native Linux x86_64 host, changing target constants would edit verifier logic. Other native architectures require actual runners |
| Empty selection | `native-selection: zero catalog entries` | Argued under current authenticated catalog, changing OS fields requires a new release signature |
| Canonical scratch root | `scratch-root: No such file or directory (os error 2)` | Staged with a missing temporary-root path under the snapshot. Cargo execution 101, public command 1. Restored native verification 0. Logs `staged-scratch-root.log` and `staged-scratch-root-restored-green.log` |
| Scratch creation | `scratch-create: Not a directory (os error 20)` | Staged with a regular file as the temporary-root input under the snapshot. Cargo execution 101, public command 1. Restored native verification 0. Logs `staged-scratch-create.log` and `staged-scratch-create-restored-green.log` |
| Platform-aware authority opening | `authority:` with the opening error's native diagnostic | Argued, not staged. `open_for_engine_test` is new in the R-P1-MAC correction and opens `registry.json` in a fresh private scratch directory. Malformed-registry staging would require interposing a writer after that private directory is created, which is not authorized. The measured permission mask fails earlier in workspace creation, so it does not cover this mapping. The macOS launch-root setup error path also requires a native macOS runner |
| Shared authority installation | `authority:` with the installation error's native diagnostic | Argued, not staged. The shared authority is newly allocated and uninitialized. Forcing installation refusal requires modifying private in-process initialization or mutex state, which needs logic edits or unauthorized process interference |
| Missing archive filename | `directory-contract: missing archive filename` | Argued, changing the authenticated URL requires signing authority |
| Freshness inspection | `fresh-destination:` with I/O diagnostic | Argued, private newly created workspace has no external writer, inducing failure requires interference after creation |
| Existing destination | `fresh-destination: artifact already exists` | Argued, unique fresh root excludes adoption, precreating the dynamically selected child needs concurrent interference |
| Production installer | `install: network failure` | Staged with the invocation-local invalid proxy. All four selected entries failed, including the shared alias, and all three distinct cases reported `CLEANUP_OK`. Cargo discovery 0, execution 101, public command 1. Restored discovery and execution both 0, public command 0. Logs `resume-20261016/staged-production-transport.log` and `resume-20261016/staged-production-transport-restored-green.log`. This covers transport refusal only. Other signature, digest, archive, publication and native-operation errors remain argued here. Replacing authenticated artifact inputs needs signing authority and mutating the private installed tree needs unauthorized interference |
| Registration | `registration:` | Argued, changing the signed nested path or installed tree needs signing authority or a concurrent private-root mutation. Offline fixture tests retain refusal coverage |
| Production UCI | `uci:` | Real Linux success proven. Failure argued, deterministic replacement of the authenticated executable needs signing authority or an interception of private output after verification. No interception hook is authorized. Missing instructions and libraries require actual affected native environments |
| Empty configured identity | `uci-identity: empty engine name after uciok` | Argued, would require modifying the authenticated executable or upstream artifact without triggering digest refusal |
| Case panic | ``case-panic: called `Result::unwrap()` on an `Err` value`` with `PermissionDenied` | Staged through the real permission-mask input, not a logic edit. The primary caught setup panic appears in `case=Err(...)` inside each `scratch-cleanup` refusal. Cargo discovery 0, execution 101, public command 1. Restored discovery and execution both 0, public command 0. Logs `resume-20261016/staged-scratch-permissions.log` and `resume-20261016/staged-scratch-permissions-restored-green.log`. This measures the text-panic path. The non-text payload fallback remains argued because forcing that payload requires logic edits |
| Supervisor teardown | `supervisor-cleanup:` and `RETAINED` | Argued, deterministic OS reaping failure requires process interference or modified supervisor logic. No fake successful cleanup is accepted |
| Native lease drain | `operation-cleanup:` and `RETAINED` | Argued, retaining a lease after completed `run_native_operation` requires changing ownership logic |
| Catalog-session cleanup and its blocking gateway | `authority-cleanup:` and `RETAINED <path> reason=authority-cleanup` | Argued, not staged. Forcing a clear-session persistence or gateway error requires changing filesystem permissions after private setup, poisoning private mutex state or editing ownership logic. No such concurrent private-state interference is authorized. The permission stage instead measures the uninitialized-authority success route and preserves its primary setup error |
| Shared launch-root shutdown lookup and its blocking gateway | `authority-cleanup:` with the native diagnostic and `RETAINED <path> reason=authority-cleanup` | Argued, not staged. The R-P1-MAC correction awaits the existing `crate::shutdown_engine_launch_root` after supervisor cleanup, operation drain and session clearing. Its Linux branch returns success without reclaim. The macOS authority lookup, launch-root lookup and gateway failures require a native macOS environment and invalid private authority or gateway state, which is not supplied by the permitted real inputs |
| Shared launch-root reclaim report | `authority-cleanup:` with `engine launch leaves could not be reclaimed` and `RETAINED <path> reason=authority-cleanup` | Argued, not staged. The existing shutdown facade turns nonempty macOS reclaim failures into an error, which the verifier preserves alongside the primary case result and retained scratch path. Deterministic failure requires native macOS and interfering with private launch leaves or changing reclaim logic. Neither that refusal nor macOS reclaim success was measured on Linux |
| Scratch removal | `scratch-cleanup: Permission denied (os error 13)` with `case=Err(...)` | Staged by the same permission-mask input as the caught setup panic. Both distinguishing messages appeared in the same run. Cargo discovery 0, execution 101, public command 1. Restored discovery and execution both 0, public command 0. Log pair `resume-20261016/staged-scratch-permissions.log` and `resume-20261016/staged-scratch-permissions-restored-green.log`. The controller removed only the reported scratch trees after inspecting the completed cleanup path, then restored the normal invocation |
| Any failed case or alias | `FAIL entry[...]`, final aggregated error | Both original scratch-root stages and the resumed transport and permission stages reported all four selected entry failures, including the Stockfish alias and both independent RubiChess paths, then Cargo execution 101 and public command 1. Each corresponding restored native run exited 0. See those four staged/restored log pairs |
| Cargo spawn | `CATALOG_FAIL discovery: cargo could not start: spawn cargo ENOENT` | Staged with a disposable PATH missing Cargo. The spawn failed, so no Cargo process exit exists. The launcher reported child code -2, signal null, and returned 1. Restored native discovery and execution both 0, public command 0. Logs `staged-cargo-spawn.log` and `staged-cargo-spawn-restored-green.log`. Root independently measured public exit 1 in `/tmp/build-cad8d11a/launcher-missing-cargo.log`, with restoration supplied by the resumed full native command |
| Cargo signal | `CATALOG_FAIL discovery: cargo terminated by SIGTERM` | Repaired staging held the measured artifact lock, inspected the actual Cargo child argv for `--list`, then sent SIGTERM while Cargo reported the artifact-directory wait. No execution command started. Cargo reported code null and signal SIGTERM, public launcher 1, `signalled_at_locked_discovery=true`. Restored native discovery and execution both 0, public command 0. Logs `resume-20261016/staged-cargo-discovery-signal.log` and `resume-20261016/staged-cargo-discovery-signal-restored-green.log`, with records in `resume-20261016/staged-results.jsonl`. The initial measurement sent no signal and returned 0 with `signalled_at_locked_discovery=false`, restoration 0 and controller 1. That failed measurement remains preserved in `staged-cargo-discovery-signal.log`, `staged-cargo-discovery-signal-restored-green.log` and `gate-catalog-phase1-staged-inputs.heorDv/log` and is not refusal evidence |
| Cargo nonzero status | `CATALOG_FAIL discovery: cargo exited 101` and `CATALOG_FAIL execution: cargo exited 101` | Invalid snapshot TOML staged discovery failure with Cargo 101 and public command 1, then restored native verification 0. Log pair `staged-cargo-manifest`. Catalog and scratch stages separately measured execution propagation with the same statuses |
| Excess command output | `CATALOG_FAIL discovery: output exceeded 1048576 bytes` | Staged with excessive real unused Cargo manifest keys. Cargo discovery completed 0 with signal null, public launcher returned 1 after draining bounded output, and execution did not start. Restored native discovery and execution both 0, public command 0. Logs `staged-cargo-output-limit.log` and `staged-cargo-output-limit-restored-green.log` |
| Missing/excess exact discovery | `expected exactly one runnable test` | Argued, exact test identity and compilation guard are verifier logic. Do not rename/remove the test or substitute Cargo to manufacture evidence. Missing feature/target inputs instead cause a real Cargo refusal |
| Interrupted discovery | `discovery: interrupted` | Argued, event timing cannot be forced with the permitted real file inputs |
| Missing exact successful execution | `expected exactly one passed test with zero ignored tests` | Argued, real test result comes from Cargo. Editing assertions or substituting Cargo is forbidden |
| Signal forwarding failure | Existing child-supervisor rejection | Argued, inherited helper behavior, real signal/OS failure requires process interference |

The rows marked argued remain explicit staging gaps whenever this document or a green
run is cited. Transport staging does not cover every installer failure, the permission
stage does not cover authority opening or macOS reclaim, and the measured Cargo signal
does not cover launcher interruption or forwarding failure. No all-assertions-staged
claim is made. Historical checkpoint statuses remain unchanged by later root proof.
No browser proof is required because Phase 1 changes no visible UI or IPC contract.

## Cleanup ownership repair checkpoint

The C1/C2/C4 repair on 2026-10-16 changed only the feature-gated `catalog_network`
module and this document. Other `fs.rs` code remained byte-identical to Git HEAD.
Plan authorship and arbitration shared one context. Detection ran on the same model
family as the code. Evidence is under `/tmp/catalog-cleanup-repair.9JKgG8`.
This checkpoint preserves the earlier attempts and argued native failure gaps above.

The focused regression command was:

```text
cargo test --manifest-path src-tauri/Cargo.toml --locked --bin chessriddle-studio --features catalog-network-tests fs::tests::catalog_network::cleanup_failure_retains_case_owners_until_process_exit -- --exact --nocapture --test-threads=1
```

| Proof | Actual result | Output under the repair evidence directory |
| --- | --- | --- |
| First attempt | Format check 0, focused compilation 101 with E0603 for private engine modules. No test executed. Work stopped for root inspection | `gate-catalog-cleanup-initial.36JWYo/log` |
| Resumed focused regression after using public re-exports | Format check 0, regression 0 with exactly 1 passed, 0 failed and 0 ignored | `gate-catalog-cleanup-resumed-focused.VWj6OI/log` |
| Git-derived fix-only retention reversal | Reverse apply 0 without offsets. Only `std::mem::forget(state)` removed, test and all other edits retained byte-identically. Executed regression 101 with `CASE_OWNER_DROPPED stage=supervisor-cleanup`, 0 passed and 1 failed | `reversal-origin.diff`, `retention-only.patch`, `reverse-apply.log`, `reversal-red.log`, `reversal-red.status` |
| Exact restoration | Forward apply 0 without offsets, full `fs.rs` bytes matched `fixed-fs.rs`. Regression 0 with exactly 1 passed, 0 failed and 0 ignored. Reversal/restoration controller 0 | `restore-apply.log`, `restoration-green.log`, `gate-catalog-cleanup-reversal.5cf5jO/log` |
| `pnpm verify:catalog-engines` | 0 on Linux x86_64. Exact discovery 0, execution 0 with 1 passed and 0 ignored, all 4 selected entries through 3 distinct native executions, 21.63 seconds. All three reported cleared sessions, `launch-root=not-applicable` and removed scratch | `gate-catalog-cleanup-native-network.P9Y1Sc/log` |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --features catalog-network-tests --locked -- -D warnings` | 0 | `gate-catalog-cleanup-feature-clippy.eEIgqg/log` |
| `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` | 0 after Clippy | `gate-catalog-cleanup-feature-clippy.eEIgqg/log` |

Each detached attempt has its canonical `completion.record` beside its log. The
initial record remains 101. The resumed focused, reversal/restoration, network and
Clippy/format records are 0. The reversal's expected failing Cargo execution remains
101 inside its successful proof controller, rather than being reported as a green test.
The restored `fs.rs` SHA-256 is
`45aa899b57613229581b637a274315ed11c60add2c3fa1b1c12aa74dda5256cf`.
The helper regression does not stage a native OS wait failure, operation-drain failure
or authority-cleanup failure. Native macOS reclaim, Windows behavior and the new
uninitialized-authority status text were not exercised by this repair checkpoint.
No pre-review or receipt-backed gate was run by this repair worker.

## Automated closure repair checkpoint

The subsequent C2/C4 closure repair on 2026-10-16 changes only the feature-only
`catalog_network` module, the existing public launcher and this document. Named text
limits and actual failed-case `AppState` retention are unchanged. All other `fs.rs`
bytes and `error.rs` match Git HEAD. Plan authorship and arbitration shared one context.
Detection ran on the same model family as the code. Evidence is under
`/tmp/catalog-closure-r3.9F5bZl`. Earlier counts, including historical three-native-case
and one-test results, remain historical and do not describe the new selector.

| Proof | Observed result | Evidence under the closure directory |
| --- | --- | --- |
| Exact status regression | Cargo 0, 1 passed, 0 failed, 0 ignored, 2,447 filtered out on Linux | `gate-catalog-r3-focused.Ok19pS/log` |
| Exact ownership regression | Cargo 0, 1 passed, 0 failed, 0 ignored, 2,447 filtered out | Same focused log |
| Status-only reversal | Cargo 101, 0 passed, 1 failed, 0 ignored. Exact line comparison rejected unconditional `catalog-session=cleared launch-root=reclaimed` against Linux `catalog-session=cleared launch-root=not-applicable` | `status-only.patch`, `reversal-red.log`, `reversal-red.status` |
| Exact restoration | Patch applied without offsets, complete file matched saved fixed bytes. Cargo 0, 1 passed, 0 failed, 0 ignored | `reverse-apply.log`, `restore-apply.log`, `restoration-green.log`, `gate-catalog-r3-reversal.Kycu8m/log` |

The reversal derives the old unconditional visible line from
`git show 6f924f3e^:src-tauri/src/fs.rs`. Git's `diff --no-index` produces the exact
patch between that historical behavior inside the current helper and the fixed source.
Reverse application changes only the helper's status behavior and unused argument
spelling. The new test, real output call, ownership helper and every other source byte
remain present. Forward application restores the complete saved file byte-for-byte.
The restored SHA-256 is
`536e674138ba9ea4d6b16af8825f0b30725f9ed896aca3dd6adcfb6b518dac6a`.
Both canonical focused and reversal controller records are 0. The expected failing
Cargo status remains 101 inside the successful reversal controller.

Launcher staging uses only the invocation-local native Cargo runner configuration.
An inline Python runner executes the real compiled test binary with additional libtest
arguments. It neither substitutes Cargo nor fabricates test output. The unchanged
launcher still supplies its single module filter. `--skip` can remove a real test,
and an additional filter can include an existing neighboring test. Execution-only
arguments leave discovery untouched. Removing the invocation override restores the
canonical command, including a fresh real network installation and UCI run. No tracked
runner, new installation route, verifier logic edit or assertion fixture mutation is
introduced. Runner inputs, full output and same-run public statuses are retained as
`<stage>-runner-input.txt`, `<stage>.log` and `<stage>.status`.

| Changed assertion / real input stage | Distinguishing observed output | Same-run status and restoration |
| --- | --- | --- |
| Exact discovery, omit ownership with `--skip` | `CATALOG_FAIL discovery: expected exactly these 3 runnable tests:` with `found 2:` and the actual remaining names | `discovery-two`: Cargo discovery 0, public command 1, execution did not start. Removing override restored public 0, discovery/execution 0, 3 passed, 0 failed, 0 ignored, 4 Linux entries and 3 native installs/UCI |
| Excess discovery, add the existing `fs::tests::from_operations_derives_exclusive_download_classes` filter | Same exact discovery refusal prefix with `found 4:` and the actual extra name | `discovery-excess`: Cargo discovery 0, public command 1, execution did not start. Restored public 0, discovery/execution 0, 3 passed, 0 failed, 0 ignored, 4 Linux entries and 3 native installs/UCI |
| Same count with a wrong identity, skip network and add that neighboring test | Same exact discovery refusal prefix with `found 3:` and `fs::tests::from_operations_derives_exclusive_download_classes: test` replacing the network identity | `discovery-wrong-name`: Cargo discovery 0, public command 1, execution did not start. Restored public 0, discovery/execution 0, 3 passed, 0 failed, 0 ignored, 4 Linux entries and 3 native installs/UCI |
| All discovered tests passed, skip network only during execution | `test result: ok. 2 passed; 0 failed; 0 ignored;` then `CATALOG_FAIL execution: expected all 3 discovered tests passed with zero failed or ignored tests` | `execution-two`: discovery/execution Cargo 0, public command 1. Restored public 0 with 3 passed, 0 failed, 0 ignored, 4 Linux entries and 3 native installs/UCI |
| Nonzero expected summary, skip entire module only during execution | `test result: ok. 0 passed; 0 failed; 0 ignored;` then the same exact execution refusal | `execution-zero`: discovery/execution Cargo 0, public command 1. Restored public 0 with 3 passed, 0 failed, 0 ignored, 4 Linux entries and 3 native installs/UCI |
| Missing execution summary, pass `--list` only during execution | Actual three-name listing without a `test result:` line, then the same exact execution refusal | `execution-list`: discovery/execution Cargo 0, public command 1. Restored public 0 with 3 passed, 0 failed, 0 ignored, 4 Linux entries and 3 native installs/UCI |

The missing-discovery and three execution stages have canonical controller status 0
in `gate-catalog-r3-staging.sE1Pq1/completion.record`. Excess and wrong-identity
discovery stages have controller status 0 in
`gate-catalog-r3-identity.sQvnC0/completion.record`. Successful restorations list all
three exact intended names and report `3 passed`, `0 failed`, `0 ignored`,
`0 measured` and `2445 filtered out`. Each real Linux case emits
`CLEANUP_OK supervisor=reaped operations=drained catalog-session=cleared launch-root=not-applicable scratch=removed`.

The zero-ignored and zero-measured summary predicates and discovery's benchmark-kind
rejection remain argued for nonzero counts or an actual benchmark identity.
This feature module has no ignored tests or benchmarks, so manufacturing
those counts requires changing test declarations or substituting output. Nonzero
failed counts already make real Cargo fail before summary validation, as in the
historical native refusals. This repair adds no native failure exit. The inherited
native failure gaps and unchanged launcher spawn, signal, nonzero status, output-cap,
interruption and signal-forwarding rows remain staged or argued as explicitly recorded
in the historical matrix. None is reclassified as staged by the new selector proof.
Linux formatter tests do not prove native Windows or macOS cleanup execution.

Documentation is frozen before the final detached public command, feature all-target
Clippy, format check and `pnpm checks:pre-review`. Their canonical completion record
and full output under this closure directory carry the results reported with the change.
No pass is inferred from a missing or pending record, and no document is edited during
receipt gates.
