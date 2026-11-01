# Review record: Annotate editor move navigation (2026-11-01)

Build run `annotate-tab-nav` (Claude Code orchestrator, Codex executor, session
b88fc52e-ffd2-488e-b769-666bd9956a34), full auto. Decision: d-20261101-05 (hint and fixed Esc). Commits made on branch `build/annotate-tab-nav-20261101` and
released to `master` by rebase and fast-forward push: feature, mutation repair, key formatter, coverage
scope, settings test, decision and this record.

## Plan review (verbatim plan record follows)

The complete reviewed plan, including its `## Reviews` section, is reproduced below.

## Plan: Keyboard move navigation from the annotation comment editor

### Goal

While writing a move comment in the Annotate panel, Felix can press one key to go to the next
(or previous) move and keep typing there immediately, without clicking back into the editor.

### MANDATE

Felix, 2026-11-01 (original request): "I want to annotate some things here. Is there an easy way to
make those annotations and then going to the next move with a keyboard press? I want something like
I write a comment, then I press, then I'm at the next move and can directly write again. Because
currently I think I have to write and then I have to focus the moves again or click on next move and
then click back into this writing field again and then start typing again. So it would be nice to
have a shortcut for next move that keeps the focus in the notation."

Felix's decisions (2026-11-01), accepting the recommendation: Tab = next move in the current line,
Shift+Tab = previous move, Esc = leave the editor so the board shortcuts work again, both
navigation keys rebindable in the keybind settings. At a branch point Tab follows the main line of
the current line and never opens the variation chooser; side lines are reached by clicking a move.
Build order: "Yes, build it, full auto executor codex on a separate work tree."

### Threat model and non-goals

No adversary: local single-user UI input. Environments: the Tauri desktop renderer on Linux, macOS
and Windows, and the Playwright e2e harness (browser with mocked Tauri commands). Non-goals: a key
for entering side lines from the editor, changing the variation chooser, changing how comments are
serialized or saved.

### Traced premises

- `src/components/common/MoveControls.tsx:69-70` registers `keyMap.NEXT_MOVE` / `PREVIOUS_MOVE` via
  `useHotkeys` with default options; react-hotkeys-hook 4.x ignores events from contenteditable and
  form fields by default, so arrows inside the editor only move the caret.
- `MoveControls.tsx` `next()` opens the variation chooser when `chooseVariationAtom` is on and the
  continuation has more than one child; otherwise calls the store's `goToNext`.
- `src/state/store/tree.ts:393` `goToNext` steps into child 0 of `nextContinuation` (respecting
  `practicePath`); `:417` `goToPrevious` drops the last path element. `nextContinuation`
  (`tree.ts:272`) returns the current node's children when it has any, but at a leaf it searches
  other occurrences of the same board state and continues there (transposition fallback,
  covered by `tree.test.ts:1627`), so `goToNext` at a line end can jump into another line.
- react-hotkeys-hook `useHotkeys` without a ref scope attaches its listener to `document`.
- `src/state/store/variationChooser.ts` `subscribeVariationChooser` closes an open chooser on every
  position change.
- `src/components/panels/annotation/AnnotationEditor.tsx` builds the Tiptap editor with
  `useEditor({...}, [position.join()])`: every position change creates a new editor instance which
  starts unfocused. `onUpdate` saves the comment through `setComment` on every edit.
- `src/state/keybinds.ts` defines the default `KeyMap`; `createKeybindStorage.repair` merges every
  default id into a persisted map, so a new id appears for users with stored keybinds.
  `SettingsPage.tsx` renders every keymap entry with `KeybindInput` (names are not translated).
- Board hotkeys `ANNOTATION_*` use bare digits `1`-`6`; they stay disabled inside the editor.

### Approach

#### O1 — Editor-scoped navigation keys
Inside the comment editor only, the `ANNOTATION_NEXT_MOVE` keybind (default `tab`) moves to the
first child of the **current node** (the current line's next move; the store's `goToNext` may be
used only when the current node has children, so its transposition fallback is never reached), and
`ANNOTATION_PREVIOUS_MOVE` (default `shift+tab`) calls `goToPrevious`. The key's default action
(focus traversal / text insertion) is prevented. Tab never opens the variation chooser, regardless
of `chooseVariationAtom` ("At a branch point Tab follows the main line … never opens the variation
chooser"). At a leaf (end of the current line, including a transposed leaf) and at the root the key
does nothing and focus stays. Bindings are read from `keyMapAtom` in the react-hotkeys-hook format
so a rebinding in settings takes effect; they are scoped to the editor element and never fire
outside it — Tab elsewhere keeps its normal browser focus traversal.

#### O2 — Focus survives the move change
After an O1 navigation the editor of the new move has focus with the caret at the end of its
existing comment, so typing continues immediately ("then I'm at the next move and can directly
write again"). Navigation started elsewhere (board, arrows, clicks on notation) keeps today's
behaviour: the editor does not steal focus. The executor chooses the mechanism (focus the rebuilt
editor when the navigation originated in the editor, or keep one editor instance and reset its
content and undo history per node); whichever is chosen, undo must not cross into another move's
comment and the existing content-sync guarantees in `AnnotationEditor.test.tsx` stay green.

#### O3 — Esc leaves the editor
Esc inside the editor blurs it, so the board hotkeys (arrows, `1`-`6`, …) work again on the next
key press. Esc is fixed, not a keymap entry.

#### O4 — Discoverability
Authority: Felix accepted the recommendation (2026-11-01, "I like the top idea") whose text said
"Esc covers that, and the shortcut tooltip should say so."
While the editor has focus, a single dimmed hint line under it shows the current bindings, e.g.
"Tab: next move · Shift+Tab: previous move · Esc: leave editor", using the live keymap values and
i18next strings (`pnpm i18n:extract`). It is not rendered while the editor is unfocused, so
existing e2e screenshots of the panel stay unchanged.

#### O5 — Keymap entries
Add `ANNOTATION_NEXT_MOVE` ("Annotation editor: next move", `tab`) and `ANNOTATION_PREVIOUS_MOVE`
("Annotation editor: previous move", `shift+tab`) to the defaults in `src/state/keybinds.ts`. No
storage schema change; the existing repair adds them to stored maps.

### Decisions and trade-offs

- Known limit, not changed here: `createKeybindStorage.getItem` writes the repaired map back and on a
  refused write falls into the parse-failure catch. The two new defaults trigger that existing
  write once; the hazard (localStorage at quota) is pre-existing and unobserved (R1 Skip).

- Tab over Ctrl/Alt+Arrow: those are word-jumps on Linux/Windows and macOS respectively; Enter is a
  line break. Cost: Tab no longer moves focus out of the editor — Esc (O3) is the exit, shown in O4.
- No extraction from `MoveControls.next()`: the editor path is the plain store `goToNext` without the
  chooser branch, so there is no second copy of the chooser logic (rule 11 not triggered).
- Hint only while focused (O4) to avoid clutter and snapshot churn.
- Esc fixed rather than rebindable: it is the universal "leave" key; fewer settings.

### Risks / open questions

- Tiptap/ProseMirror may handle Tab itself; the handler must win and prevent default (proven by e2e).
- Rebinding to a key that also types text (e.g. a letter) would navigate instead of typing; that is
  the user's explicit choice in settings.

### Not part of this task

Entering side lines from the editor, chooser changes, NAG buttons, notation panel changes.

### Phases

#### Phase 1 — Editor keyboard navigation (O1–O5)
Files: `src/components/panels/annotation/AnnotationEditor.tsx`,
`src/components/panels/annotation/AnnotationEditor.test.tsx`, `src/state/keybinds.ts`,
`src/translation/*` (via `pnpm i18n:extract`), a new or extended e2e spec under `e2e/`
(prefer `e2e/board-keyboard.spec.ts`), plus any test of `keybinds.ts` defaults that enumerates ids.
Surfaces: persisted keymap defaults (no schema change); no IPC, no auth, no concurrency.
Role: normal.
Unit cases: Tab moves to the next move and the new editor has focus; Shift+Tab back; Tab at a
branch point with `chooseVariationAtom` on goes to child 0 and opens no chooser; Tab at a line-end
leaf is a no-op with focus kept, including a leaf whose position transposes into another line that
has a continuation (position must not change); Esc blurs; a rebound keymap value is honoured;
Tab/Shift+Tab dispatched while focus is outside the editor do not change the position; navigation
from outside does not focus the editor; undo after Tab does not restore the previous move's comment;
Tab into a move with an existing comment then typing appends after that comment; the hint appears
on editor focus, shows rebound keys, and disappears on blur.
Keymap test (`src/state/keybinds.test.ts`): a stored valid older map without the two new ids gains
both defaults while its existing custom bindings are preserved.
E2E case: open a game, focus the editor, type "first", Tab, type "second", Shift+Tab, type " more"
— the first move's comment is "first more", the second's "second", and the editor kept focus
throughout; Esc then ArrowRight moves the board; with focus on the board, Tab does not change the
move.
PROOF COMMAND:
`pnpm exec vitest run src/components/panels/annotation src/state && pnpm exec tsgo --noEmit && pnpm i18n:check && pnpm test:e2e:container -- e2e/board-keyboard.spec.ts`

### Reviews

#### Round 1 (plan-r1) — lenses: plan REVISE, correctness REVISE, chess-semantics REVISE, minimalism REVISE, persisted-state REVISE, tests APPROVED
- **P1** goToNext's transposition fallback at a leaf leaves the current line. Witnesses: plan#1, correctness#1, chess-semantics#1. Verified `src/state/store/tree.ts:272-285`. Disposition: Fix — O1 confined to the current node's children; transposed-leaf unit case. Obligation: "next move in the current line".
- **P2** No proof that bindings are inert outside the editor. Witness: plan#2. Verified: unscoped useHotkeys attaches to document. Disposition: Fix — O1 scoping wording + unit/e2e cases.
- **P3** No proof of caret-at-end in a populated comment. Witnesses: plan#3, tests#1. Disposition: Fix — unit + e2e append cases.
- **P4** O4 hint outside MANDATE. Witnesses: minimalism#1, plan#4. Disposition: Skip — Felix accepted the recommendation that said the tooltip should mention Esc ("I like the top idea", 2026-11-01); authority line added to O4.
- **P5** O4 has no assertion. Witness: tests#2. Disposition: Fix — hint unit case.
- **P6** No upgrade test for older stored keymap. Witness: tests#3. Disposition: Fix — keybinds.test.ts case.
- **P7** Repair write-back on quota resets custom bindings. Witness: persisted-state#1. Disposition: Skip — pre-existing code path unchanged by this plan, quota edge unobserved (rule 4d); recorded as known limit.
Adopted lens findings this round: r1=8 (plan#1-3, correctness#1, chess-semantics#1, tests#1-3); unique Fix issues: 5.

#### Round 2 (plan-r2, closure) — lenses: plan APPROVED, correctness APPROVED, chess-semantics APPROVED, tests APPROVED
- P1 CLOSED (plan, correctness, chess-semantics); P2 CLOSED (plan); P3 CLOSED (plan, tests); P5 CLOSED (plan, tests); P6 CLOSED (plan, tests).
Adopted lens findings this round: r2=0. Plan review complete: r1=8 r2=0.

## Implementation

Phase 1 (Codex, `normal` rung, resumed at `sensitive`, which resolved to the same model/effort):
the leaf's first proof was red because its test fixture built moves without `move`/`san`; fix 1
corrected the fixture and exposed a real focus bug (the focus effect ran before Tiptap mounted the
rebuilt view); fix 2 moved focus to Tiptap's `onCreate`; fix 3 made Esc blur synchronously
(`commands.blur()` defers to `requestAnimationFrame`); fixes 4-5 removed a lint-flagged `expect`
in a test helper (fix 4's brief was the orchestrator's error). Fix rounds 3-5 exceeded the build
skill's two-round cap; each addressed a distinct, newly exposed and source-verified cause.

Pre-review: frontend mutation left 10 survivors in `AnnotationEditor.tsx` (fix-1 leaf removed
redundant guards and strengthened tests, score 100); the bundle total exceeded the cap because
the published base sat 13 B under it (this run recorded a raise to 1,690,000 B).

## Diff review, round 1 (DIFF 99f20fd6..HEAD excluding tasks/decisions.md; records lens on tasks/decisions.md)

- correctness APPROVED, root-cause APPROVED, tests APPROVED, minimalism APPROVED (bundle growth
  justified, no cut found), code-quality APPROVED with one nit, persisted-state REVISE, records REVISE.
- **CR-D1** [nit] `bundle-budgets.json` measurement `source` named `pnpm gate:run frontend-build`
  while the figures came from `pnpm build-vite`. Witness: code-quality#1. Fix (mechanical leaf).
- **CR-D2** [blocker, re-raised P7] keymap hydration write-back on a full localStorage falls into
  the parse-failure catch and can reset custom bindings. Witness: persisted-state#1. Skip: the
  code path is pre-existing and unchanged; the quota condition is unobserved (rule 4d); no new
  premise relative to plan issue P7.
- **CR-D3** [should-fix] decisions cite this handoff, which did not yet exist. Witness: records#1.
  Fix: this file.

## Diff review, closure round (DIFF cd1f940d..HEAD)

- code-quality: CR-D1 CLOSED (`bundle-budgets.json:10` names `pnpm build-vite`). APPROVED.
- records: CR-D3 CLOSED (handoff committed, references resolve). REVISE with **CR-D4**
  [should-fix] the handoff said the commits were on master while they were on the build branch.
  Fix: wording corrected in this file; a factual-wording correction of this record only, closed by
  the arbiter with unchanged semantics of every other entry.
- Totals: diff findings 4 (CR-D1..CR-D4); Fix 3, Skip 1 (CR-D2); all Fix closed.

## Browser verification and its repairs

- verify-ui leaf (Codex): container e2e of the new journey passed; trace frames extracted. The
  orchestrator's inspection found the focus-only hint's second line below the fold of the
  scrollable Annotate panel at 800x720 and raw keymap strings in the hint. Repair: shared
  `src/utils/formatKeymap.ts` routes the settings keycaps and the hint through one OS mapping
  (`c7f09aa4`); a scroll-into-view attempt for the hint failed in the browser and was dropped as
  ordinary scroll content of a scrollable panel, not clipping (horizontal containment asserted in
  e2e). Coverage scope re-recorded for the new module, counts unchanged (`cc2ab4c6`).
- WebKit probe: the annotation-navigation e2e journey also passed in Playwright WebKit
  (throwaway config, port 4199), since Felix's window is WebKitGTK and the suite runs Chromium.

## Diff review, closure rounds d3 and d4 (DIFF ce067a98..HEAD, then cc2ab4c6..HEAD)

- d3: correctness, root-cause, code-quality, minimalism APPROVED; tests APPROVED with **CR-D5**
  [should-fix] no rendered test of the settings keycaps. Fix: `KeybindInput.test.tsx`
  (`78a7295e`) with revert proof (both tests red without `formatKeymap`, green restored).
- d4: tests: CR-D5 CLOSED. APPROVED.
- Totals: diff findings 5 (CR-D1..CR-D5); Fix 4, Skip 1 (CR-D2); every Fix closed.

## Rebase onto master (supersedes the bundle and decision-id statements above)

Before release, `origin/master` had gained d-20261101-02..-04 from other runs, including
d-20261101-04, which already raised the total gzip ceiling to 1,690,000 B (measured 1,680,023 B).
This run's own decisions (recorded locally as d-20261101-02 hint, -03 bundle) collided by id and
its bundle raise and CR-D1 measurement-source fix became redundant: those four commits were dropped
when the branch was rebuilt on master by cherry-pick. The hint decision was re-recorded as
d-20261101-05; no separate bundle decision remains, because the feature's +1,135 B fits under
master's ceiling. CR-D1 is therefore moot rather than closed on master.
