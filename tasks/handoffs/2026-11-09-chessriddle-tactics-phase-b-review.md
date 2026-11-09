# Review record: ChessRiddle tactics in Studio (integration phase B)

Build run tactics-phase-b, 2026-11-09, executor Codex, orchestrator Claude Code. Plan: `tasks/plans/2026-11-09-chessriddle-tactics-phase-b.md` (local, ignored). Studio and ChessRiddle commits are named in the build ledger row of this run.

## Reviews

### Round 1 (2026-11-09, plan-r1, nine Codex lenses at `openai.high`)

Raw verdicts: review-plan REVISE, review-tests REVISE, review-error-handling APPROVED with one finding, review-minimalism, review-ipc-contract, review-tauri-security, review-persisted-state, review-chess-semantics and review-correctness APPROVED with no findings.

| ID | Claim | Witness | Disposition | Correction |
|---|---|---|---|---|
| R1-1 | New `AccountError` variants break the exhaustive record in `ChessRiddleAccountCard.tsx:84`, which the plan omitted | review-plan #1 | Fix, verified at source | B2 Errors names all consumers, phase 2 includes the file |
| R1-2 | `pnpm ipc:consumers:check` fails in phase 2 because consumers arrive in phase 3 | review-plan #2 | Fix, verified at `check-ipc-command-consumers.mjs:552` | B4 moved into phase 2 |
| R1-3 | The contract check does not bind operations to their schemas and omits count | review-plan #3, review-tests #1 | Fix | B6 operation-level check, count route test |
| R1-4 | Engine errors need distinct recovery; timeout evicts the puzzle | review-error-handling #1 | Fix, verified at `shared.py:328`, `errors.py:645` | B2 variants, B4 recovery, B5 states |
| R1-5 | CR-5 has no assertion on the serialized DTO | review-tests #2 | Fix | B2 serialization test |
| R1-6 | Session lifecycle and retry identity have no named assertions | review-tests #3 | Fix | B4 session tests |
| R1-7 | The mistake filter has no mixed-backlog assertion | review-tests #4 | Fix | B1 tests |

**Authority for mechanisms added in round 1.** Engine recovery (R1-4): MANDATE "standard tactics plus retry-your-mistakes" and the threat model's closed error set, because a Retry on an evicted puzzle cannot succeed. Operation-level contract (R1-3): MANDATE section B text, "a contract check of the native request/response types against the ChessRiddle OpenAPI schema". Session and serialization tests (R1-5, R1-6, R1-7): CR-5 and the async-resource rule's stale-result guard.

**Source evidence for closure.** R1-1: `ChessRiddleAccountCard.tsx:84` read. R1-2: `check-ipc-command-consumers.mjs:415-445,552` read. R1-3: `shared.py:202` declares the alias through `Header`, `mistakes.py:77` returns `dict`. R1-4: `shared.py:328`, `errors.py:645` read. R1-5 to R1-7 are verification additions with no behavioural premise.

### Round 2 (2026-11-09, plan-r2, review-plan, review-tests, review-error-handling)

Raw verdicts: review-plan REVISE, review-tests APPROVED with one finding, review-error-handling APPROVED. R1-1, R1-2, R1-3, R1-5, R1-6 and R1-7 CLOSED by their witnesses. R1-4 CLOSED by review-error-handling, NOT CLOSED by review-plan.

| ID | Claim | Witness | Disposition | Correction |
|---|---|---|---|---|
| R1-4 (reopened) | Next after a timeout returns the same mistake | review-plan r2 | Fix, verified at `puzzle_attempt_repository.py:1605-1612`, oldest first with only the supplied exclusions | B2 exclusions, B4 source-aware recovery and test |
| R2-1 | A 30 s client cuts off long validations | review-plan r2 | Fix, verified at `config.py:631,684`, `net.rs:61-62` | B2 Deadlines reuses the 120 s client. Authority: MANDATE scope, a submit must yield a verdict |
| R2-2 | Review rows lack Authority | review-plan r2 | Fix | Authority paragraph above |
| R2-3 | Phases 2 and 3 both own translations | review-plan r2 | Fix | Training-only variants reuse the card's generic string, phase 2 has no translation change |
| R2-4 | Engine recovery has no named assertion | review-tests r2 | Fix | B2 native mapping test, B4 recovery tests |
| R2-5 | Packet lacked source evidence (late observation) | review-plan r2 | Fix | Source evidence paragraph above |

### Round 3 (2026-11-09, plan-r3, review-plan, review-tests, review-error-handling)

Raw verdicts: all APPROVED. R1-4, R2-1, R2-2, R2-3, R2-4 and R2-5 CLOSED by their witnesses. Two should-fix test or capacity details, no contract change, carried below.

## Carried to diff review

* CR-A: when the session's timed-out mistake exclusion set is full at 50, the oldest id is dropped, so recovery stays defined. Witness: review-plan r3.
* CR-B: a native local-server test inspects the emitted query and proves exclusions become repeated `exclude_ids`. Witness: review-tests r3.
* CR-5, CR-6, CR-7 from the integration plan, verbatim in MANDATE.


## Diff review

Round 1 ran over the cumulative Studio range and the held ChessRiddle range. Ten Studio lenses, seven ChessRiddle lenses and one records lens, all Codex at `openai.high`. Author and reviewer share a model family, so family separation was absent. The orchestrator (Claude Code) arbitrated.

| Finding | Witness | Disposition |
|---|---|---|
| A pending promotion was dropped when a rerender built an equal position object | review-correctness | Fix, compare by FEN |
| Specific server reasons were shadowed by the generic envelope code, so `desktop_route_forbidden` and `submission_in_progress` became a generic failure | review-error-handling, review-api-contract | Fix, reasons decide first, tests use complete envelopes |
| An availability failure silently hid the home card | review-error-handling | Fix, availability no longer goes through the owner queue |
| Bare limits 50, 7 and 86,400,000 | review-code-quality | Fix, named constants |
| Golden verdict test did not assert the continuation; elapsed time unasserted | review-tests | Fix |
| Duplicate animation settling and split-word helper in e2e | review-minimalism | Fix, reused and extracted |
| d-20261109-14 still named itself the ceiling pointer | records lens | Fixed by `master`: another run set d-20261109-14 Superseded-by d-20261109-23, and d-20261109-30 is now the forward pointer |
| Decision text described the cap incompletely | records lens | Fix, decision re-recorded as d-20261109-24 |
| New privacy text is literal JSX for EN, DE and ES only | ChessRiddle review-i18n | Skip: the legal documents exist in those three languages by convention, others fall back to English through `LegalDocumentShell` |
| Privacy disclosure asserted against source text, not the rendered page | ChessRiddle review-tests | Skip: every disclosure in that test file works this way; a test-shape change with no observed failure (rule 4d) |

Round 2 ran review-correctness, review-root-cause, review-tests, review-error-handling, review-code-quality and review-minimalism over the repair commit. All approved and closed every finding. CR-5, CR-6, CR-7, CR-A and CR-B were closed by source evidence in the lens reports.

Totals: plan rounds 3, plan adoptions r1=7 r2=5 r3=0. Diff adoptions r1=8 r2=0.

## Real end-to-end proof

The `.dev` Studio binary against a disposable local stack (PostgreSQL, real migrations, GoTrue, the local web app, local Stockfish, seeded tactics and mistakes) passed all eight flows: connect and home card, puzzle load with the entrance move, correct line with rating change and solution stepping, wrong line, show solution unrated, mistake retry with a falling tactics-only count, the free daily limit with the upgrade link reaching the opener shim, and promotion. Backend logs confirmed `desktop` attribution, protocol 2 and an `Idempotency-Key` on every submit. All services were stopped.
