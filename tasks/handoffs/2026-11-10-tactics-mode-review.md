# Review record: ChessRiddle tactics mode, complete in itself

Build run tactics-mode, 2026-11-10, executor Codex, orchestrator Claude Code (Fable 5.2). Plan: `tasks/plans/2026-11-10-tactics-mode.md` (local, ignored). The build ledger row of this run, added after the push, names the commits. The code author and every lens are Codex; Claude Code arbitrated. There was no model-family separation between author and reviewers.

## MANDATE

Felix, 2026-11-10: "So let's just focus on tactics, no more puzzle modes, but make these really well so that the user is really inclined to check chess riddle out. So as you said, difficulty has to come and the puzzle theme also has to come, I mean the motive." On the timer: "I think the timer is something valuable and easy to build. So this is something I think it's worth building." On the keys: "I would use the same keyboards that we use in the browser." On the scope list (difficulty and motif synced with the account, timer synced, Enter or A and the arrows and ?, a "This session" summary, Analyse after the verdict, website link and connect prompt): "I think this is the right scope now to build it like this." and "But, yeah, just build it. Full auto, Executor Codex." Left out by his decision: other puzzle modes, zen mode, save the puzzle, wrong-piece hint, remaining-puzzles counter, motif shown after solving. Studio repository only; the ChessRiddle allowlist change runs in a ChessRiddle session.

## Reviews

### Plan round 1 (plan-r1, nine Codex lenses, 302 s wall)

Raw verdicts: review-plan REVISE, review-persisted-state REVISE, review-error-handling APPROVED with two findings, review-tests APPROVED with two findings, review-correctness APPROVED with one limitation, review-minimalism, review-ipc-contract, review-tauri-security and review-chess-semantics APPROVED with no findings.

| ID | Claim | Witness | Disposition | Correction |
|---|---|---|---|---|
| R1-1 | Phase 1 exports commands whose production consumers arrive in phase 2, so `ipc:consumers:check` fails | review-plan #1 (blocker) | Fix, `scripts/check-ipc-command-consumers.mjs:552` | One phase |
| R1-2 | The new error `noMatch` breaks two exhaustive error maps | review-plan #2 (blocker) | Fix | Both maps are unconditional work of the one phase |
| R1-3 | The Analyse proof does not show that the opened tree holds the line; UCI tokens are dropped silently by the PGN text path | review-plan #3 (blocker) | Fix | O11 states the resulting tree; O13 proves it |
| R1-4 | A saved motif that left the catalogue makes every next request fail, and a failed catalogue read removes the way to recover | review-persisted-state #1 (blocker) | Fix, `backend/app/api/routes/puzzles/standard.py:162` in ChessRiddle | O5 effective motif |
| R1-5 | Failed settings and motif reads have no visible error or retry | review-error-handling #1 | Fix | O5; only `updateRequired` stays silent |
| R1-6 | A failed save may have been committed; restoring old values and saving later overwrites it | review-error-handling #2 | Fix | O5 reconciling read before the next save |
| R1-7 | No proof that settings and summary are shared across tabs | review-tests #1 | Fix | O13 two-tab assertion |
| R1-8 | No proof of motif-label lookup with fallback disabled or of an unknown identifier | review-tests #2 | Fix | O13 assertion |
| R1-9 | The order of the settings load and the first puzzle request is unspecified | review-correctness limitation | Fix | O5 first request waits |

### Plan round 2 (plan-r2, five lenses, 424 s wall)

Raw verdicts: review-plan REVISE, review-persisted-state, review-error-handling, review-tests and review-correctness APPROVED. R1-1, R1-2 and R1-4 to R1-9 CLOSED.

| ID | Claim | Witness | Disposition | Correction |
|---|---|---|---|---|
| R1-3 (residual) | The text path of `createTab` tokenises through the native lexer, which Vitest and the browser tests mock, so the proof could pass on fabricated tokens | review-plan r2 #1 (blocker) | Fix, `src/utils/chess.ts:601` | O11 builds the tree in the renderer and passes it as `initialTree` |
| R2-1 (lineage R1-4) | With the settings read finished and the catalogue read pending, the first request goes out without the saved motif | review-plan r2 #2 (blocker) | Fix | O5 waits for both reads |
| R2-2 | R1-4 and R1-6 add mechanisms without Authority | review-plan r2 #3 | Fix (record) | Authority: MANDATE "synced with the account" for both |

### Plan round 3 (plan-r3, review-plan and review-persisted-state, 140 s wall)

Both APPROVED. R1-3, R2-1 and R2-2 CLOSED. No open issue. Adoptions per round: r1=9 r2=3 r3=0. Unique plan issues: 11, all Fix.

### Implementation

One Codex write leaf (sensitive role), one thread. Two orchestrator resumes before the review, both from looking at the snapshots: the main-flow snapshots showed the refused-settings state, the session summary was one small dimmed string, the timer duration needed a snapshot (resume 1); the website link had slipped below the panel fold and the shortcuts overview showed raw key identifiers (resume 2). The orchestrator reran the complete phase proof on the result: 14 commands exit 0, 5,965 related Vitest tests, 48 Rust tests, 114 container browser tests.

The pre-review checks then failed on the total bundle budget (1,807,844 B against 1,790,000 B). A Codex write leaf (normal role) looked for removable bytes (50 B), measured the published base `8fed763e0` and the candidate, and the total ceiling was raised to 1,820,000 B through `d-20261110-09`.

### Diff round 1 (ten Codex lenses over `5782903cb..eb958593a`)

Raw verdicts: review-correctness, review-error-handling, review-code-quality and review-minimalism REVISE; review-tests and review-root-cause APPROVED with findings; review-ipc-contract, review-tauri-security, review-persisted-state and review-chess-semantics APPROVED with no findings.

| ID | Claim | Witness | Disposition |
|---|---|---|---|
| D1 | A next request during a pending settings save uses the old filters | review-correctness (blocker) | Fix: the request waits for the save and its reconciling read |
| D2 | A failed profile read is swallowed and never retried | review-error-handling (blocker) | Fix: typed error and Retry beside the rating |
| D3 | Unnamed limits in `chessriddle_training.rs` | review-code-quality (blocker) | Fix: named constants shared by validation and normalisation |
| D4 | Second identifier formatter for unknown motifs | review-minimalism | Fix: `formatThemeLabel` |
| D5 | Timer controls' saves untested | review-tests | Fix |
| D6 | Website button untested | review-tests | Fix |
| D7 | Rating not asserted through the account DTO | review-tests | Fix |
| D8 | Invalid values not refused through the owner | review-tests | Fix |
| D9 | `GameCard.test.tsx` harness change without a reproduction | review-root-cause | Fix: reverted; two full related runs (237 files, 6,365 tests each) did not show the failure |

### Diff round 2 (closure over `eb958593a..6ac852dd3`, six lenses)

D1 to D9 CLOSED. Raw verdicts: review-correctness REVISE, the other five APPROVED.

| ID | Claim | Witness | Disposition |
|---|---|---|---|
| E1 | A recovered profile read treats the first known handle as an account switch and erases the session counters | review-correctness (blocker), review-error-handling | Fix |
| E2 | A comment attributes Studio's motif shape to the server | review-code-quality | Fix |
| E3 | No test pins the stale-rejection guard of the summary store | review-tests | Fix |
| E4 | D1 and D2 carry no failing-before run | review-root-cause (verification limitation) | Skip: both are new behaviour of this run with no earlier release; the regression tests assert the delayed-save order and the retry directly, and the orchestrator reran the proof green on `6ac852dd3` |

### Diff round 3 (closure over `6ac852dd3..e936639a4`, four lenses)

review-correctness, review-error-handling, review-code-quality and review-tests APPROVED. E1, E2 and E3 CLOSED. No open finding.

## Verification

* Orchestrator reruns: full phase proof before the first commit (14 of 14 commands exit 0) and after the first repair (14 of 14; 50 Rust tests, 4,918 related Vitest tests, 116 container browser tests); `pnpm checks:pre-review` exit 0 after each commit batch.
* Real app, `.dev` identifier build of `e936639a4`'s predecessor `6ac852dd3`, WebKitGTK through `scripts/app-driver.mjs`, not connected, no backend: the connect prompt names the benefits and shows the website link; no settings control while not connected; Enter does nothing on the prompt. 3 of 3 on the second run; the first run failed in the check script before the prompt text had fully rendered.
* Not verified: settings, motif, timer, summary and Analyse against a real ChessRiddle backend. The backend still refuses the settings routes for the Studio login; that change and its deploy are a ChessRiddle task. Real Windows and macOS.

## Open obligations

* ChessRiddle: admit `GET` and `PATCH /api/v1/users/me/settings` for the Studio login (handover prompt given to Felix on 2026-11-10).
* After that deploy: the real flow with a `.dev` build.
