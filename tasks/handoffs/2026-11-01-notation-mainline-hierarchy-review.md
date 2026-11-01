# Review record: notation main-line hierarchy (build, 2026-11-01)

Durable review history for the build that set variations apart from the main line in the game
notation (Felix, 2026-11-01: "there should be a better highlight of the main line. Something like
Leaches does. I definitely want this built."). The plan file lived in the ignored
`tasks/plans/2026-11-01-notation-mainline-hierarchy.md`; its MANDATE, approach and full plan-review
record are copied below. Executor: Grok (xai.low leaves) for every lens and write leaf; orchestrator
and arbiter: Claude Code (Opus). Plan authorship and arbitration shared one context; detection ran
on a different model family (Grok).

## Plan (final reviewed revision, r4)


### Goal

In both notation views (inline and table), a reader sees at a glance which moves are the main
line and which are side lines, modeled on Lichess's notation with inline notation off: the main
line prominent, side lines visibly subordinate in their own block between main-line moves.

### MANDATE

Felix, 2026-11-01, first message: "Currently in a game it's not that easy to distinguish the main
line from the side lines. Do you think we should add something to show the difference more
clearly? [...] Now I turned on the inline notation in Leachess and then I think it's about as
confusing as what we currently have. [...] But with the other option to deactivate the inline
notation, I think it's visually quite clear where the main line is and where the sidelines are.
So should we add at least the option to display it like this or do you have a better solution
altogether? I'm really open here. So what do you recommend?"

Felix, 2026-11-01, second message (with a screenshot of ChessFable's table view): "Now I find the
table view that you mean. You're right, that's closer to the Leaches one I liked, but still I
don't like or there should be a better highlight of the main line. Something like Leaches does. I
definitely want this built. So build it now, full auto."

The recommendation Felix accepted with "I definitely want this built": side lines get a smaller
font, normal weight and moderately dimmed colour in both views; in table view the side-line block
gets an inset background and a clearer guide line; the current-move highlight stays bright at
every depth; no new setting; Lichess's parentheses for deeper sub-variations are left out; the
table-view default is not changed now (Felix decides after seeing the styling).

### Threat model and non-goals

No adversary: this is presentation of the user's own game tree. Inputs are arbitrary PGN trees,
including deep nesting, very long lines (the existing 32-move row split and the 20,000-node
virtualization test), comments on any move, NAG-annotated moves, games starting from a
Black-to-move FEN, and both colour schemes at the existing e2e viewports including 320px and 200%
font scale.

### Traced premises

- `src/components/common/notationRows.ts:152` `addInlineVariationRows` / `:164` `queueVariationTasks`
  emit one `{type: "variation"}` row per parent with alternatives, before the alternative lines; a
  collapsed parent emits the variation row and hides only the alternatives (inline view pushes the
  main-line continuation task before returning; table view continues the main line in its own
  loop).
- `notationRows.ts:193` `appendInlineTasks`: main line is the `children[0]` chain from the root at
  `depth 0`; alternatives at `depth + 1` with `variationParent` set; continuations after a
  variation group keep their task's depth.
- `notationRows.ts:300` `appendTableRows`: main line becomes `table` rows; main-line comments are
  `comment` rows at depth 0; variations are inline rows via `addInlineVariationRows(..., 0, ...)`,
  so their moves rows have depth >= 1 and their first-level `variation` rows depth 0 (inline view's
  first-level `variation` rows are depth 0 as well).
- `src/components/common/GameNotation.tsx:420` `InlineRow` applies `marginLeft: depth * 12` and
  `.variationBorder` only when `variationParent` is set; `:483` `VariationRow` renders the
  Plus/Minus `IconAction` alone in a full row with `.variationBorder`.
- `src/components/common/MoveCell.module.css:1` `.cell`: `font: inherit` followed by absolute
  `font-size: 0.9rem; font-weight: 600`, so a row-level percentage does not change the SAN size;
  colour comes from `--light-color/--dark-color`, set in `MoveCell.tsx` from the NAG annotation
  colour (gray when unannotated), and `.cell` applies `color: var(--light-color)/var(--dark-color)`,
  so a row-level colour does not reach the SAN either. `CompleteMoveCell.tsx:150` wraps each move
  (number + cell) in a `fontSize: "80%"` span, which affects the move number but not the
  rem-sized SAN.
- `MoveCell` is also the engine-line renderer (`src/components/panels/analysis/AnalysisRow.tsx:234`),
  and `CompleteMoveCell.tsx` mounts it at two sites: the normal cell (`:127`) and the
  `OpenMoveMenu` target (`:231`).
- `src/components/common/GameNotation.module.css:7` `.comment` uses `--mantine-font-size-sm` (rem),
  and `Comment` renders as a sibling of the move wrapper in `CompleteMoveCell.tsx:143-179`, so a
  move-level size change does not reach comments.
- `GameNotation.module.css:17` `.variationBorder`: `2px solid var(--cf-border)`.
- The visible current-move highlight is `[data-notation-current="true"] .cell`
  (`MoveCell.module.css:43`); the wrapper carrying `data-notation-current` is transparent and the
  default `.cell` background is transparent.
- `src/styles/theme.ts:188` `--mantine-color-dimmed` is `hsl(0 0% 40%)` light and
  `color-mix(muted-foreground 65%, foreground)` dark; `surface-inset` is `hsl(40 25% 91%)` light,
  `hsl(30 10% 22%)` dark; `border-strong` exists in both schemes. Raw `muted-foreground` on dark
  `surface-inset` is about 3.4:1, below AA, so it is not usable for variation move text.
- `GameNotation.tsx:105` collapse state is component-local `useState<Set<TreeNode>>`, not
  persisted. `tableViewAtom` (`src/state/atoms.ts:429`) default `false` stays untouched.
- `src/utils/chess.ts:448` keeps a PGN NAG token only when its value matches `/^\$\d+$/`.
- `e2e/fixtures.ts:679` sets font scale per Playwright project name (default 100);
  `assertNoHorizontalOverflow` (`e2e/fixtures.ts:1102`) checks the document, not the notation
  scroll viewport. Playwright projects run Chromium in the pinned container; Felix's app is
  WebKitGTK.
- `GameNotation.test.tsx:62-92` mocks `CompleteMoveCell`, `Comment` and Mantine under jsdom, so
  component tests can prove which rows carry a class, not computed styles.

### Approach

### A. Variation-block hierarchy (both views)

Quoting MANDATE: "there should be a better highlight of the main line. Something like Leaches
does." and the accepted recommendation (smaller font, normal weight, moderately dimmed colour;
inset background and clearer guide line; current-move highlight stays bright).

- A variation block is every `moves` row with depth >= 1 plus every `variation` (toggle) row at any
  depth, including first-level toggle rows at depth 0. These rows get one surface-level class
  (named for the block, replacing the border-named `.variationBorder`), in both views. Main-line
  rows are depth-0 `moves` rows, `table` rows and `comment` rows; they do not get the class.
- Inside a variation block, moves render subordinate to the main line: smaller SAN, normal font
  weight instead of 600, and unannotated SAN in `--mantine-color-dimmed`. One named scale (about
  0.9) defines the size: variation SAN computed size = scale x main-line SAN computed size (today
  `0.9rem`), and variation comment computed size = scale x main-line comment computed size. The
  existing `80%` move wrapper stays as it is (it sizes move numbers in both main line and
  variations). Move numbers stay dimmed.
- The styling is opt-in from the notation variation block only: engine lines
  (`AnalysisRow.tsx`) and main-line moves keep today's `MoveCell` rendering. It applies equally to
  both `MoveCell` mount sites in `CompleteMoveCell` (normal cell and open context-menu target), so
  right-clicking a variation move does not change its styling.
- NAG-annotated moves keep their annotation colour at every depth (DESIGN.md: NAG colours keep
  their board meaning); only size and weight change for them.
- Main-line moves (depth-0 inline rows and all `table` rows) and main-line comment rows keep their
  current size, weight, colour and card surface, so the main line reads as one band between
  variation blocks.
- The variation block sits on the inset surface tier (`--cf-surface-inset`, DESIGN.md tier 2 inside
  the notation card) with its left guide line in `--cf-border-strong`. Nested variations stay
  distinguishable through the existing per-depth indent plus their own guide line.
- The toggle row stays a row (model unchanged) but is part of the block: same inset surface and
  guide line, compact height so it does not read as an empty separator line.
- Variation SAN text keeps a contrast of at least 4.5:1 against the inset surface in both schemes.
- The current-move highlight on a variation move stays clearly visible in both schemes.

### B. Unchanged contracts

- `notationRows.ts` and its row model are unchanged. Which node is main line is unchanged (the
  `children[0]` chain). No change to move numbering, paths, NAG rendering, transposition actions,
  the context menu, collapse behaviour, scroll-to-current, or tree mutation.
- No new setting, no change to the `tableViewAtom` default, no parentheses for nested variations,
  no persisted-state change, no change to main-line table column layout.

### C. Verification

- Component (`GameNotation.test.tsx`): exactly the variation-block rows defined in A carry the
  block class: `moves` rows with depth >= 1 and every `variation` row, including a first-level
  `variation` row at depth 0 (asserted explicitly); depth-0 `moves` rows, `table` rows and `comment`
  rows do not; collapse still works and the collapsed-ancestor scroll test still passes. (This proves class placement only; computed styles
  are proven in e2e.)
- E2E (new `e2e/notation-hierarchy.spec.ts`): a game with nested variations, comments on main-line
  and variation moves, and a NAG-annotated variation move (`Nag` token value `"$2"` form), current
  move set on a variation move, captured in inline and table views in light and dark (four
  committed snapshots). Computed-style assertions, each able to fail if its styling is reverted:
  - variation SAN `button` computed font size smaller and font weight lower than main-line SAN
    `button`;
  - variation comment computed font size smaller than main-line comment;
  - variation block background equals the computed `--cf-surface-inset` and differs from the card
    background; its left border colour equals `--cf-border-strong`;
  - unannotated variation SAN computed colour equals the computed `--mantine-color-dimmed` and
    differs from unannotated main-line SAN colour; its contrast against the block background
    >= 4.5:1;
  - a NAG-annotated variation SAN has the same computed colour as a main-line SAN carrying the
    same NAG (the fixture annotates one main-line and one variation move with the same NAG), and
    the variation block has no opacity or filter that would alter it;
  - the current variation move's `.cell` background is non-transparent and differs from a
    non-current variation move's `.cell` background;
  - engine-line rendering unaffected is proven by the existing `analysis-two-engines-*.png`
    snapshots of `#topRight` (`e2e/engine-gap.spec.ts:462`) staying unchanged; other engine-gap
    snapshots that include the notation may move only in variation-block styling.
- Overflow: inside the notation scroll viewport `scrollWidth <= clientWidth` in both views, run
  additionally in a second Playwright project for the same spec at a 320px-wide viewport and 200%
  font scale (registered in `fontScaleByProject`), overflow assertions only, no snapshots there.
- Existing snapshots run first; any moved snapshot must differ only in variation-block styling, and
  each is named in the commit and report.
- WebKit: one ad hoc Playwright WebKit render of the same fixture in both schemes, inspected by the
  orchestrator (not committed), because Felix sees WebKitGTK.

### Decisions and trade-offs

Decided autonomously (full auto):

1. Apply the hierarchy in both views, not only table view. Rejected: table-only (inline view would
   stay as confusing as Felix described). Reason: one styling rule, and Felix's complaint covers
   "a game", not one view.
2. Dim with `--mantine-color-dimmed`, not raw `muted-foreground`. Reason: the raw token fails AA on
   the dark inset surface (about 3.4:1); the dimmed variable is the project's AA-adjusted secondary
   text.
3. Inset surface tier for variation blocks in both views. Rejected: a tinted primary background (no
   precedent in DESIGN.md). Reason: DESIGN.md's golden rule uses `surface-inset` for nested groups
   inside cards.
4. Keep the toggle row and fold it into the block instead of moving the toggle inline. Rejected:
   inline toggle (round-1 review: not in the accepted recommendation, and it rewrites the row
   model). Reason: minimal change meeting the MANDATE.
5. Leave main-line table column widths unchanged. Rejected: a compact column cap (round-1 review:
   not in the accepted recommendation, and Mantine's fixed 100%-wide table would need a different
   mechanism). Reported to Felix as a possible follow-up.

### Risks / open questions

- Dark `surface-inset` (22% lightness) is a strong band against the 13.5% card; if screenshots show
  it overpowering, the fallback within tokens is `--cf-muted` (17%) with the contrast assertion
  re-pointed. Decided at visual inspection, recorded in the report.
- Virtualizer row heights change slightly; measurement is dynamic (`measureElement`), so no
  functional risk expected.

### Not part of this task

- Changing the `tableViewAtom` default (Felix decides after seeing the result).
- Parenthesised sub-variations, a new notation setting, moving the collapse toggle, main-line table
  column widths, engine-line or GamePreview-specific styling.
- Rust, IPC, persisted state, `notationRows.ts`.

### Phases

### Phase 1: Variation-block styling (role normal)

Files: `src/components/common/GameNotation.tsx`, `GameNotation.module.css`,
`GameNotation.test.tsx`, `MoveCell.tsx`, `MoveCell.module.css`, `CompleteMoveCell.tsx` (only if the
opt-in must reach the cell explicitly).
Implements Approach A–B with the component tests of C.
PROOF COMMAND:
`pnpm exec vitest run src/components/common src/components/panels/analysis && pnpm exec tsgo --noEmit && pnpm exec oxlint --deny-warnings src/components/common && pnpm exec oxfmt --check src/components/common`

### Phase 2: E2E hierarchy spec and snapshots (role normal)

Files: new `e2e/notation-hierarchy.spec.ts`, two project entries in `playwright.config.ts`, the
`fontScaleByProject` entry in `e2e/fixtures.ts`, the new committed snapshots, plus any existing
snapshot that moves only in variation-block styling. Fixture through existing `e2e/fixtures.ts`
helpers (`lex_pgn` tokens with `ParenOpen`/`ParenClose`, `Comment`, `Nag` as `"$n"`), no new mock
driver.
PROOF COMMAND (orchestrator runs the container steps):
first the full `pnpm test:e2e:container` with the new spec present (existing snapshots compared
against Phase 1, every `*-diff.png` read), then `pnpm test:e2e:update --project=notation-hierarchy`
plus `pnpm test:e2e:update --project=<name>` only for existing projects whose moved snapshots differ
solely in variation-block styling, then `pnpm test:e2e:container --project=notation-hierarchy
--project=notation-hierarchy-scaled`, then the full `pnpm test:e2e:container` again.


## Plan review


### Round 1 (plan-r1, Grok xai.low leaves, 7 lenses)

Verdicts: review-plan REVISE, review-minimalism REVISE, review-chess-semantics APPROVED (no
findings), review-tests REVISE, review-correctness APPROVED (4 should-fix), review-code-quality
APPROVED (4 should-fix, 1 nit), review-root-cause REVISE. Every lens noted it could not read
`.claude/skills/verify-ui/SKILL.md` (Grok skill-door deny); judged from DESIGN.md and sources.

- PR-1 Approach C column cap is a no-op on Mantine's 100%-wide fixed table and is outside the
  accepted recommendation. Witnesses: plan#1, plan#7, minimalism#2, tests#1, correctness#2,
  root-cause#1. Verified: `node_modules/@mantine/core/styles/Table.css:2` `width: 100%`.
  Disposition: Fix — Approach C removed; Decision 5 records it; reported to Felix as follow-up.
- PR-2 Approach B (inline toggle) is outside the accepted recommendation and rewrites the row
  model. Witnesses: minimalism#1; related plan#4, code-quality#3, correctness#1 (premise).
  Disposition: Fix — B removed; toggle row kept and folded into the block (A); premise on
  collapsed continuation corrected.
- PR-3 Current-move proof passes on a transparent cell. Witness: plan#2. Verified
  `MoveCell.module.css:5,43`. Disposition: Fix — C now compares current `.cell` to a non-current
  variation `.cell` and requires non-transparent.
- PR-4 A row-level size does not reach `.cell` (absolute rem) and component tests mock the cell.
  Witnesses: plan#3, code-quality#2. Disposition: Fix — premise corrected; e2e asserts computed
  size on the SAN button; component test scoped to class placement.
- PR-5 Side-line comments use rem and sit outside the move cell. Witness: root-cause#2.
  Disposition: Fix — A names comment scaling explicitly; e2e asserts comment size.
- PR-6 `MoveCell` is shared with engine lines; two mount sites in `CompleteMoveCell`. Witnesses:
  plan#8, correctness#3, correctness#4. Disposition: Fix — A requires opt-in styling from the
  variation block, both mount sites; engine-gap snapshots prove engine lines unchanged.
- PR-7 NAG fixture value must be `"$n"`. Witness: plan#6. Verified `src/utils/chess.ts:448`.
  Disposition: Fix — C and Phase 2 name the form.
- PR-8 Overflow not checked at 320px / 200% nor inside the notation viewport. Witnesses: plan#5,
  tests#2, tests#3. Disposition: Fix — notation-viewport overflow assertion plus a scaled second
  project.
- PR-9 Unnamed 90% scale; border-named class for a surface; three terms for one concept.
  Witnesses: code-quality#1, code-quality#4, code-quality#5 (nit). Disposition: Fix — one named
  scale, a block-named class, "variation" terminology in code.
- PR-10 Component hook test is lock-in only. Witness: tests#4 (nit). Disposition: Fix — C states
  it proves class placement only.
- PR-11 WebKit probe is inspection-only. Witness: tests#5 (nit). Disposition: Skip — WebKit
  inspection is supplementary to the Chromium container gate; a committed WebKit project is not
  part of the repository's e2e contract (`verify-ui` SKILL "What counts as proof").

Adopted this round: 10.

### Round 2 (plan-r2, closure: review-plan, minimalism, tests, correctness, code-quality, root-cause)

Verdicts: review-plan REVISE (PR-1..PR-10 CLOSED, 1 blocker, 2 should-fix, 1 nit),
review-minimalism APPROVED (PR-1, PR-2 CLOSED), review-tests APPROVED (PR-1, PR-8, PR-10 CLOSED;
2 should-fix), review-correctness APPROVED (PR-1, PR-2, PR-6 CLOSED; 2 should-fix, 1 nit),
review-code-quality APPROVED (PR-2, PR-4, PR-9 CLOSED; 3 should-fix, 2 late nits),
review-root-cause APPROVED (PR-1, PR-5 CLOSED). PR-1..PR-10 closed.

- PR-12 Dimmed colour has no failing assertion; `.cell` colour comes from `--light/--dark-color`.
  Witnesses: plan#1 (blocker), tests#1. Verified `MoveCell.module.css:25-32`. Disposition: Fix —
  premise added; C asserts computed colour equals `--mantine-color-dimmed` and differs from
  main-line SAN.
- PR-13 "depth-0 rows do not" contradicts first-level `variation` rows at depth 0. Witnesses:
  plan#2, correctness#1, code-quality#1. Verified `notationRows.ts:174-179,322`. Disposition: Fix —
  A defines block and main-line rows by type and depth explicitly.
- PR-14 NAG preservation assertion passes under opacity/mixing. Witness: plan#3. Disposition:
  Fix — C compares against a main-line move with the same NAG and forbids block opacity/filter.
- PR-15 engine-gap snapshot set includes notation; only `analysis-two-engines-*` isolates engine
  lines. Witness: tests#2. Verified `e2e/engine-gap.spec.ts:462`. Disposition: Fix — C names the
  anchor.
- PR-16 Named scale ambiguous against the 80% wrapper and rem `.cell`. Witnesses: correctness#2,
  code-quality#3. Disposition: Fix — A defines the scale relative to computed main-line sizes and
  states the wrapper stays; premise restored.
- Nits closed by arbiter (contract-neutral text): stale line citations (plan#4, code-quality#2,
  code-quality late#2), collapsed-continuation wording (correctness#3), "side-line" wording
  (code-quality late#1).

Adopted this round: 5.

### Round 3 (plan-r3, closure: review-plan, tests, correctness, code-quality)

Verdicts: review-plan APPROVED (PR-12, PR-14, PR-15, PR-16 CLOSED; PR-13 NOT CLOSED; 1 late nit),
review-tests APPROVED (PR-12, PR-15 CLOSED; 1 should-fix restating PR-13), review-correctness
APPROVED (PR-13, PR-16 CLOSED), review-code-quality APPROVED (PR-12, PR-14, PR-15, PR-16 CLOSED;
PR-13 NOT CLOSED plus 1 should-fix restating it).

- PR-13 (lineage, second attempt): C's component bullet still said "depth-0 rows do not".
  Witnesses: plan r3, tests r3#1, code-quality r3. Disposition: Fix — C's bullet now restates A's
  definition, names the depth-0 first-level `variation` row explicitly.
- PR-17 Phase 2 proof recorded new snapshots before running existing ones. Witness: plan r3 late#1
  (nit). Disposition: Fix — Phase 2 proof runs the full container suite first, then scoped updates.
  Arbiter-closed nit, rechecked in diff review.

Adopted this round: 1 (PR-13).

### Round 4 (plan-r4, closure: review-plan, tests, correctness, code-quality)

Verdicts: all four APPROVED, PR-13 CLOSED by every witness and review-plan. No new findings.
Plan review complete. Open issues: none. Skip: PR-11. Defer: none.

Adoptions per round: r1=10 r2=5 r3=1 r4=0.


## Implementation

- Phase 1 (Grok write leaf, role normal): variation-block styling, committed as
  "feat(notation): set variations apart from the main line". Proof green (vitest
  src/components/common + panels/analysis 526 passed, tsgo, oxlint, oxfmt), re-run by the orchestrator.
- Phase 2 (Grok write leaf, role normal, 2 fix rounds): e2e spec `e2e/notation-hierarchy.spec.ts`,
  projects `notation-hierarchy` and `notation-hierarchy-scaled`, four new snapshots, moved
  `variation-chooser-board-keyboard.png` (variation lines only, 285 px).
  - Fix round 1: at 320x720 / 200% the leaf had injected layout CSS to mount rows; the injected layout
    overflowed 176 > 174 in table view with master styling too (orchestrator probe), so the injection
    was removed and the viewport changed.
  - Fix round 2: at 800x720 and 1000x720 / 200% no notation rows mount (header fills the card,
    filed f-20261101-32); viewport set to 1000x1100 (decision recorded in tasks/decisions.md).
- Orchestrator visual inspection of the container snapshots found the variation band jagged (margin
  indentation left a notch beside nested rows). Phase 1 session resumed (fix round 1): shared left
  edge, padding indentation, per-level guide gradient. Committed as
  "fix(notation): keep the variation band continuous across nesting".
- Revert probes (pinned container): MoveCell reverted -> fails "inline variation SAN font-size";
  block background transparent -> fails "inline variation block background"; all Phase 1 styling
  reverted -> fails "variation SAN is not inside a variation block".
- WebKit (native Playwright WebKit, disposable config, scratch snapshot dir): all computed-style
  assertions passed in both schemes; renders inspected, same as Chromium.

## Diff review

### Round d1 (6 code lenses + records lens, Grok)

Verdicts: correctness APPROVED, root-cause APPROVED, chess-semantics APPROVED, tests APPROVED
(1 should-fix, 1 nit), code-quality APPROVED (5 should-fix, 2 nits), minimalism REVISE (2 should-fix,
1 nit), records APPROVED.

- tests#1 320px/200% overflow not covered — Defer: unreachable in the real layout (no rows mount),
  annotated on f-20261101-32 with the move-to-320px instruction.
- tests#2 / cq#5 tautological marginLeft assertion — Fix.
- cq#1 / min nit dead depth-0 marginLeft branch — Fix.
- cq#2 unexplained +1 guide depth on toggle rows — Fix (comment).
- cq#3 `--cf-*` prefix reserved for theme tokens (DESIGN.md) — Fix (renamed to `--notation-*`).
- cq#4 variable named for variations on the shared `.cell` — Fix (`--notation-scale`).
- cq nits (boolean name, colour variable name) — Fix.
- min#1 duplicated game opener in the spec — Fix. min#2 unused `tableView` option — Fix.

Repair: Grok write leaf fix-1, committed as "refactor(notation): use local names for the
variation-block variables"; container run of the four affected projects green against committed
snapshots (visually neutral). Pre-review green.

### Round d2 (closure: tests, code-quality, minimalism, correctness, records)

All APPROVED; every adopted d1 finding CLOSED. New: CommentRow's depth margin unreachable
(code-quality should-fix, minimalism nit) and a CSS comment naming engine lines (code-quality nit) —
Fix via mechanical Grok leaf fix-2, committed as "refactor(notation): drop the unreachable
comment-row indent".

### Round d3 (closure: tests, code-quality, minimalism, correctness)

All APPROVED; cq-d2#1, cq-d2 nit#1 and min-d2 nit#1 CLOSED. New remarks:
- tests: 320px/200% overflow again — Skip: re-raise of the d1 Defer without a changed premise
  (still annotated on f-20261101-32).
- code-quality: `CommentNotationRow.depth` has no reader after the no-op margin was dropped — Skip:
  the field was already always 0 on master (every `addComment` passes 0), it belongs to the row model
  the plan keeps unchanged, and it is not a product defect.

REVIEWED_THROUGH: the fix-2 commit ("refactor(notation): drop the unreachable comment-row indent").

## Metrics

Plan review adoptions: r1=10 r2=5 r3=1 r4=0. Diff review adoptions: d1=8 d2=2 d3=0.
Findings filed: f-20261101-32 (200% font scale leaves the notation without rows), annotated with the
deferred 320px overflow check. Decisions: d-20261102-01 (variation-block mechanism), d-20261102-02 (scaled overflow viewport).
