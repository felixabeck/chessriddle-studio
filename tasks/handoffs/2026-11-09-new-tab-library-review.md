# New Tab Library list: review record

Plan: `tasks/plans/2026-11-09-new-tab-library.md` (ignored). Executor: Codex. Orchestrator and arbiter: Claude Code (Opus 5.5).

Separation: plan author and arbiter are Claude. Code author and every lens are Codex, so diff review shares the code author's family. Disclosed under push-review-policy §3.

## Plan review


### Round 1 (revision plan-r1)

Raw verdicts: review-plan REVISE, review-correctness REVISE, review-tests REVISE, review-error-handling APPROVED with one should-fix, review-minimalism APPROVED, review-persisted-state APPROVED, review-pgn-index APPROVED, review-ipc-contract APPROVED. Reports: `/tmp/build-new-tab-library/lens-*-r1.txt`.

- **I1** Windows has no individual-game source. Witnesses: review-plan 2, review-correctness 1. Fix: O5 and Threat model state the file-row behaviour and its one-line notice, citing the 2026-10-04 product decision. Verified `src-tauri/src/db/linked_collections.rs:85`. MANDATE item 3.
- **I2** The workspace listing itself can rebuild indexes, so the guarantee was false. Witness: review-plan 1. Fix: guarantee removed, O4 requires non-blocking render. Verified `src-tauri/src/file_workspace.rs:1620`.
- **I3** Game-table opens have no timestamp. Witness: review-plan 3. Fix: O3 dedicated record. MANDATE item 2.
- **I4** Recents eviction loses last-opened. Witness: review-plan 4. Fix: O3 dedicated record, bounded by the persisted-state rule.
- **I5** Phase 2 alone would send Due to Info. Witness: review-plan 5. Fix: Phase 2 migrates the existing caller.
- **I6** No regression assertions for O4 to O6. Witness: review-tests 1. Fix: Phase 3 assertions.
- **I7** No browser assertion for owner replacement. Witness: review-tests 2. Fix: Phase 4 e2e cases.
- **I8** No Rust query assertions. Witness: review-tests 3. Fix: Phase 1 assertions.
- **I9** No assertions for panel intent and ownership failure. Witness: review-tests 4. Fix: Phase 2 assertions.
- **I10** Translation coverage unasserted. Witness: review-tests 5. Fix: Phase 4 catalogue test.
- **I11** Freshness failures cannot reach the notice. Witness: review-error-handling 1. Fix: O5 derives incompleteness from descriptors.

### Round 2 (revision plan-r2)

Raw verdicts: review-plan REVISE, review-tests REVISE, review-correctness APPROVED, review-error-handling APPROVED, review-persisted-state APPROVED. Reports: `/tmp/build-new-tab-library/lens-*-r2.txt`.

- **I1** review-plan NOT CLOSED, review-correctness CLOSED. Arbiter closes on evidence: MANDATE item 3 names own library-folder collections, and `docs/context/PRODUCT-DECISIONS.md` 2026-10-04 says Windows keeps unlinked databases until the port, so the item has no subject there. O5 now says this and that the feed activates when collections ship. Reported to Felix.
- **I2, I5 to I11** CLOSED by review-plan and witnesses.
- **I3** NOT CLOSED: `src/components/panels/info/InfoPanel.tsx:132` is a second route into the table. Fix: O3 records at the game-table page itself, one place for every route.
- **I4** review-plan NOT CLOSED, review-persisted-state CLOSED. Skip: the persisted-state rule requires a bound. Reaching 1000 distinct opened items only degrades the oldest to modified-time order, which is an unobserved edge under global rule 4d.
- **I12** Pending listing has no assertion. Witnesses: review-plan new blocker, review-tests 2. Fix: Phase 4 assertion.
- **I13** Writers and consumers of the record are unasserted. Witness: review-tests 1. Fix: Phase 2 and 3 assertions.
- **I14** New mechanism lacks Authority. Witness: review-plan should-fix. Fix: Authority line in Decisions.

### Round 3 (revision plan-r3)

Raw verdicts: review-plan APPROVED with one should-fix, review-tests APPROVED. Reports: `/tmp/build-new-tab-library/lens-*-r3.txt`.

- **I3, I12, I13** CLOSED by review-plan and witnesses.
- **I14** Record-only: Authority for the O3 persisted record is MANDATE item 2, "sorted by last opened", as stated under Decisions. Closed by arbiter with this entry.

Plan review converged. Adoptions per round: r1=11 r2=4 r3=0.

## Cumulative diff review

### Round 1

Verdicts: correctness APPROVED, root-cause APPROVED with a limitation, persisted-state APPROVED, pgn-index APPROVED, ipc-contract APPROVED, records APPROVED, code-quality REVISE, error-handling REVISE, minimalism REVISE, tests REVISE.

- **F1** Fix. Due completeness ignored listing failures and could say "Nothing due". error-handling.
- **F2** Fix. Failed database rows discarded their guidance. error-handling.
- **F3** Fix. `player_name` forwarding untested across the renderer adapter. tests.
- **F4** Fix. Listing-triggered database refresh untested. tests.
- **F5** Fix. Unexplained key bound. code-quality.
- **F6** Fix. `openStandaloneDatabase` also opened collections, renamed `openDatabaseTable`. code-quality.
- **F7** Fix. Action groups selected by index. code-quality.
- **F8** Fix. Duplicated catalogue key list. minimalism.
- Root-cause limitation about before-and-after proof: Skip, a statement about evidence rather than a defect. Each regression test added by repair was confirmed by removing its production line.

### Round 2, closure of F1 to F8

All closed by their witnesses, correctness APPROVED. **F9** Fix: `databaseError` and `unreadDatabases` lacked Due coverage (tests). Closed in the next round.

### Findings from verification, not lenses

- Own reading of phase diffs: retired collections hid their file (phase 3); seconds used as milliseconds, raw file name as tab title, no date on game rows, an empty due total (phase 4). All fixed with tests.
- Full e2e: an unrequested recasing of two English labels, and filter labels breaking mid-word. Fixed.
- Real app in WebKitGTK: `.pgn` shown in collection names. Fixed.

### Rounds 4 and 5, closure of the verification repairs

correctness APPROVED, tests APPROVED. One suggestion, an en-GB regression test for a string restored to its original value: Skip, no payoff.

Adoptions per round: diff r1=8 r2=1 r3=0 r4=0 r5=0, plus plan r1=11 r2=4 r3=0.

## Verification

- `pnpm test:e2e:container`: 385 passed before re-recording, with only four snapshots differing, each inspected. Moved: `workspace-tabs`, `workspace-tab-context-menu`, `workspace-tabs-import-refused`, and `board-keyboard` (a hover scrollbar, because the control moved off the side panel).
- Real release binary driven in WebKitGTK with a seeded Library: every repertoire beyond ten listed, one row per collection, games newest first with partial dates after full ones, "Felix Beck" finding "Beck, Felix", owner replacement keeping another board, Info for a repertoire from All, and reordering after opening.

## Known limits

- Windows has no linked collections, so game PGNs stay file rows under Games (d-20261109-29).
- Due counts game 0 of a repertoire file, as before.
