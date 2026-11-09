# Review record: one Puzzles entry with ChessRiddle as the default source

Build run puzzles-one-entry, 2026-11-09, executor Codex, orchestrator Claude Code. Plan: `tasks/plans/2026-11-09-puzzles-one-entry.md` (local, ignored). Commits are named in the build ledger row of this run. The code author and every lens are Codex; Claude Code arbitrated. Model-family separation between author and reviewer is absent and disclosed.

## MANDATE

Felix, 2026-11-09, on the New Tab screen: "is it sensible to have those two options or should I just only use the chess riddle puzzles here?" Accepted proposal: one "Puzzles" button with ChessRiddle as the default inside it, a connected user starts ChessRiddle tactics directly, a user who is not connected sees "Connect your ChessRiddle account" first with the offline databases as a smaller second choice, offline puzzles are kept. Felix: "Yes, I will definitely, I want to build this", then "Alright, build this full auto executor codex."

## Reviews

### Plan round 1 (plan-r1, six Codex lenses, 175 s wall)

Raw verdicts: review-plan REVISE, review-error-handling REVISE, review-tests APPROVED with two findings, review-minimalism, review-correctness and review-persisted-state APPROVED with no findings.

| ID | Claim | Witness | Disposition | Correction |
|---|---|---|---|---|
| R1-1 | No rendered proof that the source control is disabled during a submission | review-plan #1 (blocker), review-tests #2 | Fix, `src/state/chessRiddleTraining.test.ts` exercised only the registry | O8 component assertion for pending and settled submission |
| R1-2 | Phases 1 and 2 overlap in the training component, tests, snapshots and catalogues | review-plan #2 | Fix | One phase |
| R1-3 | Independence of the ChessRiddle view from the offline session restore is unproven | review-tests #1 | Fix | O8 component assertion with a failing restore |
| R1-4 | A failed availability read is presented as an offline choice and its error hidden | review-error-handling #1 (blocker) | Fix, verified at `src/state/chessRiddleTraining.ts:141-148` | O5 leaves the source absent only on confirmed `false`; a failed read opens the ChessRiddle view with error, Retry and the offline button |
| R1-5 | Automatic load after "connected" can loop while training keeps answering with an authentication error | review-error-handling #2 | Fix | O6: automatic load only after a user-triggered card action, a "Try again" button, the mount read never loads |

### Plan round 2 (plan-r2, review-plan, review-tests, review-error-handling, 169 s wall)

Raw verdicts: review-plan REVISE, review-tests APPROVED, review-error-handling APPROVED. R1-1, R1-2 and R1-3 CLOSED by review-plan, R1-1 and R1-3 by review-tests, R1-4 and R1-5 by review-error-handling. review-plan left two residuals:

| ID | Claim | Witness | Disposition | Correction |
|---|---|---|---|---|
| R1-4 (residual) | The offline way out after a failed availability read had no rendering contract: an IPC failure maps to `server` (`src/platform/chessriddle.ts:31`) whose only action is Retry (`src/state/chessRiddleTraining.ts:254-262`) | review-plan r2 #1 (blocker) | Fix | O6 names the failed-availability case with error, Retry and offline button; O8 requires the rendered assertion |
| R1-5 (residual) | The record lacked the correction trace and the Authority for the new mechanism | review-plan r2 #2 | Fix | Trace: `ChessRiddleAccountCard.tsx:77` (mount read) and `:196` (Refresh button) ran the same operation. O6 states that only connect, reconnect and the clicked refresh invoke the callback |

**Authority for the mechanism added in round 1 (R1-5).** MANDATE, "Not connected: it shows "Connect your ChessRiddle account" first": connecting inside the tab must lead to a puzzle and must not replace the prompt with an endless reload. The frozen threat model names the connected and not-connected environments.

### Plan round 3 (plan-r3, review-plan, review-error-handling, 107 s wall)

Raw verdicts: both APPROVED. R1-4 and R1-5 CLOSED by both. No open plan issue. Adoptions per round: r1=5 r2=2 r3=0.

### Implementation

One phase, one Codex write leaf on the sensitive rung, one resume for four layout corrections the orchestrator found by reading the snapshots: the heading and the Tactics and Mistakes buttons are hidden while the connect prompt shows, the Connect button is the only filled button, the connect snapshots show the top of the panel, and the offline view with the source control got its own snapshots. The orchestrator reran the full phase proof twice: related Vitest 4,848 tests, the i18n and boundary checks, formatting and lint, and 110 browser tests in the container.

### Diff round 1 (cumulative diff, seven Codex lenses)

Raw verdicts: review-code-quality REVISE; review-correctness, review-root-cause, review-tests, review-minimalism, review-error-handling and review-persisted-state APPROVED.

| ID | Claim | Witness | Disposition | Result |
|---|---|---|---|---|
| D1 | No controlled failing-before run for the change | review-root-cause #1 (should-fix) | Skip: this is a requested behaviour change, not a defect repair, so there is no prior failure to reproduce; the new tests are named in O8 | - |
| D2 | The source-switching browser test never changed the offline session, so resetting offline progress on a switch would pass | review-tests #1 | Fix | The test plays an offline move and checks it after a round trip; the component test preserves a completed offline attempt |
| D3 | The New Tab test never unmounted the home view, so removing the owner guard would pass | review-tests #2 | Fix | New unmount case; observed red without the guard ("expected new, received puzzles") |
| D4 | Bare `28` as the layout breakpoint of the source control | review-code-quality #1 (blocker) | Fix | `SOURCE_CONTROL_MIN_WIDTH_REM` |
| D5 | A connected result with uncertain durability started training and unmounted the card before its warning could be read | review-error-handling #1 | Fix | Such a result does not invoke the callback; the card stays with its warning and the user continues with "Try again" |

### Diff round 2 (closure over the repair commit, review-correctness, review-tests, review-code-quality, review-error-handling)

Raw verdicts: all APPROVED. D2 and D3 CLOSED by review-tests, D4 by review-code-quality, D5 by review-error-handling. review-correctness found no defect introduced by the repair. Diff adoptions per round: r1=4 r2=0.

## Decisions

`d-20261110-01` records the one-tab-kind model and the product details. The single entry is Felix's choice; the details were decided under full auto and reported to him. It supersedes the placement part of `d-20261109-39`; the solving rules of that decision stay. Product precedent: `docs/context/PRODUCT-DECISIONS.md`, "One Puzzles entry, ChessRiddle first".

## Verification

* Browser tests in the container, mocked IPC: Puzzles opens ChessRiddle directly when the connection is available; a user who is not connected sees the prompt and connecting loads the first puzzle; switching to the offline databases and back keeps the tab, an offline move and the ChessRiddle line; with the connection unavailable Puzzles opens the offline view without the source control. Snapshots cover the ChessRiddle view with the control, the connect prompt and the offline view with the control.
* Real application, `.dev` identifier, WebKitGTK through `scripts/app-driver.mjs`, on `b7d083794`, not connected and with no backend: New Tab shows one Puzzles action, it opens the connect prompt with the source control, the offline button switches the same tab to the offline databases, the control switches back, and "Try again" without an account returns to the prompt. 5 of 5.
* Not verified in this run: connecting and solving against a ChessRiddle backend with the new entry. That needs the ChessRiddle side deployed and is done against production afterwards. Real Windows and macOS are untested.
* Known limit: at 1440 by 900 with 200 % font scale the connect prompt is taller than the visible panel (344 px visible, 721 px content in English), so the Connect button needs scrolling inside the panel.

## Open items

None from this run. The integration roadmap continues in `tasks/handoffs/2026-11-06-chessriddle-integration-plan.md`.
