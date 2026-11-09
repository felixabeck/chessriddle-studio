# ChessBase migration guide — review record

Build run `chessbase-migration-guide`, 2026-11-09/10. Orchestrator Claude Code (Fable 5.2), executor
Codex for the implementation leaf and every lens. Plan: `tasks/plans/2026-11-09-chessbase-migration-guide.md`
(ignored working file; its review section is reproduced below). Decisions: `d-20261109-40`,
`d-20261110-02`. No finding was deferred or skipped; no successor entry exists.

Separation disclosure: the code was written by Codex leaves and reviewed by Codex lenses (same
family, model-level at most). The plan author also arbitrated every finding.

## Plan review


Round 1 (plan-r1, seven Codex lenses: plan, minimalism, correctness, tests, error-handling,
ipc-contract, platform-semantics). Verdicts: plan REVISE, tests REVISE, platform-semantics
REVISE, the other four APPROVED.

- **PR-1** — drop recognition is in the MANDATE but was excluded. Witness: plan r1 #1 (blocker).
  Verified: MANDATE item 1 says "drops or picks"; `DirectoryTree.tsx:283` is internal-only.
  Disposition: Fix. Correction: new obligation O5, decision entry corrected. Authority for the
  new mechanism (a native drop event): MANDATE item 1, "If someone drops or picks a `.cbh`,
  `.cbv` or `.cbz` file, show a short three-step guide". Closed r2 (plan).
- **PR-2** — new Playwright spec is not registered; every project uses a filename `testMatch`.
  Witnesses: plan r1 #2 (blocker), tests r1 #2 (blocker). Verified at `playwright.config.ts:33-`.
  Disposition: Fix. Correction: O3 verification registers three projects and proves discovery.
  Closed r2 (plan, tests).
- **PR-3** — no proof that the production selection path refuses before granting. Witnesses:
  plan r1 #3 (blocker), tests r1 #1 (blocker). Disposition: Fix. Correction: O1 places the
  refusal in the post-selection function and adds a boundary test with a real authority.
  Closed r2 (plan, tests).
- **PR-4** — GTK filter patterns are case-sensitive, so `Games.CBH` stays hidden. Witness:
  platform-semantics r1 #1 (should-fix). Verified: `rfd-0.16.0/.../dialog_ffi.rs:52` formats
  `*.{ext}`. Disposition: Fix. Correction: O1 filter carries lower and upper case; mixed case is
  a stated limit; a test pins the filter list. Native picker visibility itself stays unprovable
  by harness (Risks). Closed r2 (plan, platform-semantics).
- **PR-5** — 320 px / 200 % obligation has no browser assertion. Witness: tests r1 #3
  (should-fix). Disposition: Fix. Correction: O3 narrow and scaled projects with assertions.

Round 2 (plan-r2, closure: plan, tests, platform-semantics, ipc-contract). Verdicts: plan
REVISE, tests REVISE, platform-semantics APPROVED, ipc-contract APPROVED.

- **PR-5** reopened by plan r2 #1 (blocker; tests r2 reported it closed): the scaled project
  would run at 100 % because `e2e/fixtures.ts:1065` maps project names to scales and
  `fixtures.ts:1501` defaults to 100. Verified. Correction r3: register the project in
  `fontScaleByProject`, assert the effective scale, add `e2e/fixtures.ts` to the phase files.
- **PR-6** — PR-1's new mechanism lacked an Authority citation. Witness: plan r2 #2
  (should-fix). Disposition: Fix. Correction r3: Authority recorded on PR-1 above.
- **PR-7** — O5 never proves the production drop handler emits the event. Witness: tests r2 #1
  (blocker). Disposition: Fix. Correction r3: O5 verification adds a mock-runtime test through
  the handler the registration calls. Correction-created by PR-1's fix (lineage: PR-1).

Round 3 (plan-r3, closure: plan, tests). Verdicts: both APPROVED. PR-5, PR-6, PR-7 CLOSED
(plan r3; tests r3 for PR-5 and PR-7). No open issue, no Skip, no Defer. plan_adopted_per_round
r1=5 r2=3 r3=0.

Round walls (launch to last report): r1 about 6 min (7 lenses), r2 about 5 min (4 lenses), r3
about 3 min (2 lenses). Active wall for the whole run is unknown.

## Implementation

One phase, Codex write leaf, sensitive role, thread `01a1c258-b088-7413-ae80-3d633f9a5274`.
Two same-thread repairs:

1. Orchestrator inspection: a test hid the new link with a style tag to keep two Trash
   screenshots unchanged, the link sat below the Trash view, and en-US said "coloured". Repaired;
   `files-trash-standard-files-preview.png` and `files-trash-compact-files-preview.png` were
   re-recorded in the container and differ only by the link.
2. Review finding T1 (below).

After the rebase onto `637db9ba` the bundle check was red by 31 B. `d-20261110-02` records the
measured growth (+8,041 B total) and raises the total ceiling to 1,790,000 B; a mechanical Codex
leaf edited `bundle-budgets.json` and `docs/bundle-budgets.md`.

## Diff review

Round 1 over `637db9ba..832da76a`: correctness, root-cause, tests, code-quality, minimalism,
error-handling, ipc-contract, platform-semantics, persisted-state (code, sensitive role) and one
records lens. Nine APPROVED, records REVISE.

- **T1** — review-tests, `src/utils/files.ts:62` (should-fix, 99): nothing guarded that
  `pickPgnFile()` goes through the shared wrapper. Fix: two cases calling the real `pickPgnFile`
  with fix-revert proof (red with a direct call, green restored). Commit `494bfd9c`.
- **R1** — records lens, `tasks/decisions.md` (should-fix, 100): `d-20261109-38` still claimed the
  forward pointer. Fix: `findings.py set-trailer d-20261109-38 --superseded-by d-20261110-02`.

Round 2 (closure over `832da76a..494bfd9c`): tests, correctness, records. All APPROVED; T1 and
R1 CLOSED. REVIEWED_THROUGH `494bfd9c` before this record and the rebase.
diff_adopted_per_round r1=2 r2=0.

## Verification limits

The native file picker and a physical desktop drag cannot be driven by Playwright or
`verify:app`; both are Felix's checks. Mixed-case extensions such as `.Cbh` stay hidden in the
GTK picker. Windows and macOS runtime proof comes from the hosted `rust-windows-test` and
`rust-macos-test` jobs.
