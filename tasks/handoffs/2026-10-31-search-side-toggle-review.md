# Review history: database Games colour filter (build search-side-toggle, 2026-10-31)

Plan: `tasks/plans/2026-10-31-search-side-toggle.md` (ignored; its MANDATE and obligations are summarised in d-20261031-10). Executor: Codex (plan lenses `leaf.codex.read.review-plan`, diff lenses and writes at the normal rung). Orchestrator: Claude Code.

## Plan review

### Round 1 (r1)
- lens-plan-r1 (review-plan, Codex): VERDICT REVISE. P1 [blocker] visual proof misses the Any swatch, open menu and German 320 px / 200 % sizing; existing journeys start at WhiteBlack in English (src/state/store/database.ts:65, e2e/database-files.spec.ts:1808, e2e/fixtures.ts:646). Disposition: Fix — added O6 and phase files. Verified: store default `sides: "WhiteBlack"` cited by lens. Closure: r2 review-plan.
- lens-minimalism-r1 (review-minimalism, Codex): VERDICT APPROVED, no findings.
### Round 2 (r2)
- lens-plan-r2 (review-plan, Codex): VERDICT REVISE. P1 NOT CLOSED [blocker]: O6 demanded opponent Black and player Any at once, impossible because both SideInputs share `query.sides` (GameTable.tsx:121,134; SideInput.tsx:21). Verified against source. Disposition: Fix (P1 lineage, correction 2) — O6 now captures `BlackWhite` and `Any` as separate states. Closure: r3 review-plan.
### Round 3 (r3)
- lens-plan-r3 (review-plan, Codex): VERDICT APPROVED. P1 CLOSED. No additional findings.
### Phase-1 proof failure → plan correction (before r4)
- phase-1 (Codex, normal) RED: at 320 px / 200 % typing width 0 px; JS `useElementSize` min-width forced the fields onto two rows, moving `database-adaptive-wide` and `database-labelled-game` beyond the search bar; catalogue unit test passed the wrapper instead of `translation`. Orchestrator inspected diff and screenshots. Correction C1 to O1: CSS container-query collapse to swatch + chevron in narrow fields, no JS measurement, keep one-row layout. Closure: r4 review-plan.
### Round 4 (r4)
- lens-plan-r4 (review-plan, Codex): VERDICT REVISE. C1 NOT CLOSED [blocker]: collapse alone leaves ~51 px per field at 320/200 (sidebar, view padding, search padding, 32 px gap), collapsed chip needs ~44 px, O6 needs 40 px typing. Verified the cited arithmetic sources exist. Disposition: Fix (C1 lineage, correction 2) — O1 permits narrow-only CSS reflow to one field per row, one row kept where usable. Closure: r5 review-plan.
### Round 5 (r5)
- lens-plan-r5 (review-plan, Codex): VERDICT APPROVED. C1 CLOSED. [should-fix] record Authority for the CSS reflow: Authority — MANDATE "find a good solution" plus O6 (frozen threat model: 320 px / 200 % matrix); necessary correctness work for C1, not new scope. Disposition: Fix (recorded here). Limitation noted: browser geometry verified only in phase proof.

Adoptions per round: r1=1 r2=1 r3=0 r4=1 r5=1. Unique issues: P1 (2 corrections, closed r3), C1 (opened by the red phase-1 proof, 2 corrections, closed r5).

## Cumulative diff review (range 61edb7ad..ca58eb74, then closure ca58eb74..66f103e2)

- review-correctness c1: REVISE. F1 [blocker] Tooltip inside Menu.Target sends aria-haspopup/aria-expanded/id to the tooltip box (verified: Mantine `Tooltip.mjs` spreads `...others` onto the floating element). Fix → 66f103e2. c2: F1 CLOSED.
- review-code-quality c1: REVISE. F2 [blocker] `color: "gray"` misdescribes the split swatch. Fix → `side: "any"`. c2: F2 CLOSED.
- review-tests c1: APPROVED with F3 [should-fix] tooltip label unproven, F4 [should-fix] focus ring unproven. Both Fix. c2: F3, F4 CLOSED (e2e negative control: old Tooltip order fails `aria-haspopup` assertion).
- review-root-cause c1: APPROVED. review-minimalism c1: APPROVED. Records lens (tasks/findings.md, f-20261031-04): APPROVED.

Out-of-diff finding filed: f-20261031-04 (German catalogue spells "Weiss" in four strings; shown in the new chip).
