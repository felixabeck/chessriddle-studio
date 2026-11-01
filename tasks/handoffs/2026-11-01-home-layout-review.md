# Review record: New Tab home layout, due-practice card, untitled labels, trashed recent file

Build run 2026-11-01, worktree build/home-layout-20261101. Orchestrator Claude Code (Opus); executor and all lenses Codex leaves. Plan: tasks/plans/2026-11-01-home-layout.md (ignored; its full content is reproduced below).

## Plan (final, reviewed)

## Plan: New Tab home — fill the page, due-practice panel, "Unknown" labels, trashed recent file
### Goal
The New Tab home uses the window height, shows what is due for practice next to Recent Files,
labels headerless games meaningfully, and opening a recent file that sits in the workspace trash no
longer fails with the misleading "The game changed on disk".

### MANDATE
Felix (screenshot 1, home page with ~450px empty below a Recent Files list clipped mid-row):
"Is it on purpose that there is some empty space at the bottom or should we use the space somehow?"
Agent recommendation he approved: (1) Recent Files fills the remaining height instead of the fixed
300px cap that clips the 8th row; (2) two-column bottom area: Recent Files left, a "Due for
practice" panel right listing repertoires sorted by due count with a Practice action that opens the
file in practice mode and a total ("N positions due across M repertoires"); (3) recent rows named
"Unknown" (headerless games) get an informative fallback label.
Felix (screenshot 2, after clicking the "Unknown" row, 9 days ago, toast "Error — The game changed on
disk"): "Alright, fix everything in a separate work tree that you recommend."
(4) That toast is a defect visible in his report and is root-caused and fixed in this run.

### Threat model and non-goals
No adversary: a single local user, files in their own workspace. Environments: Linux WebKitGTK
(Felix's daily app), the Chromium e2e container, macOS/Windows builds through CI. Deliberately
evasive paths (a user-crafted directory literally named like the trash outside a workspace root) are
out of scope.

### Traced premises
- `src/components/tabs/NewTabHome.tsx:272` caps the list with `ScrollArea.Autosize mah={300}`; the
  outer `Stack` (line 240) and the Recent Files `Card` (line 262) have no fill styling.
- Height is available: `src/routes/__root.tsx:310` `Main` is `100vh`; `src/components/tabs/BoardsPage.tsx:430/481`
  panels are `h="100%"` inside a column-flex container with `min-height: 0`
  (`BoardsPage.module.css:1`).
- `src/state/atoms.ts:601` `RecentFile` = `{name, handle, type, lastOpened}`; max 10, deduplicated by
  handle (`addRecentFileAtom`, line 626). The handle is an opaque capability id; no path or headers
  are stored.
- `src/utils/files.ts:138/169`: without an explicit `tabName`, a loaded non-empty PGN replaces the
  file-name fallback with `getGameName` (`src/utils/treeReducer.ts:198`), which returns the literal
  `"Unknown"` when White, Black and Event are all absent; that name is written into recents.
- `src/utils/files.ts:143/165`: `openFile` already selects the practice panel for
  `metadata.type === "repertoire"`; `NewTabHome.openRecentFile` passes the recent type, so opening a
  recent repertoire already lands in practice.
- Every mounted recent repertoire row subscribes to `deckAtomFamily({file, game: 0})`
  (`NewTabHome.tsx:48`); `getStats` (`src/components/files/opening.ts:66`) gives `due`/`unseen`; the
  badge shows `due + unseen`. No cross-repertoire aggregate exists.
- Defect (4), observed on Felix's machine: `~/.local/share/com.chessriddle.encroissant/logs/en-croissant.log`
  lines 127-128 — `native operation failed … label=read_game: The game changed on disk`, twice, 6 s
  apart (reproducible, not a race). The collections registry
  (`…/collections/registry.json`) holds one `purpose: game` record whose file is
  `Beck-Müller-2026-10-22.pgn` with a non-empty `trash_locator`; the file exists only at
  `<workspace>/.en-croissant-trash/<bucket>/Beck-Müller-2026-10-22.pgn`, contains just `*`
  (headerless → "Unknown"), mtime 2026-10-23 (9 days ago). Path: `openRecentFile` → `countPgnGames`
  (succeeds — the handle follows the file into the trash) → `openFile` → `readGame` →
  `pgn.rs::read_game` → `read_game_core` succeeds → `linked_collections::qualify_source` →
  `CollectionService::snapshot` (`linked_collections.rs` ~1830) returns `Error::StaleGame` because
  `record.is_trashed()`. The tab is not created.
- Trash UI: the only trash surface is the undo banner in `src/components/files/useFileWorkspace.tsx`
  (restore / delete permanently by handle); no renderer feature lists or opens files inside the trash.
- `NewTabHome.tsx:118-142` already reconciles recents on mount: entries whose `countPgnGames` fails
  with category `not-found` are removed.
- Localization (`docs/localization.md`): every new key needs a non-empty value in every shipped
  catalogue; `pnpm i18n:extract` then `pnpm i18n:check`; `pnpm i18n:jsx` forbids hard-coded JSX text.

### Approach
#### O1 — Home fills the height
The home content is a full-height column: the action cards keep their natural height, the bottom
area takes all remaining height (`flex: 1; min-height: 0`), and each bottom card's list scrolls
inside the card only when it is longer than the card. No fixed pixel cap. When the window is too
short for the cards plus a minimal bottom area (or at the 1-column breakpoints), the page scrolls as
a whole instead of squeezing the lists to nothing; a sensible minimum list height is the executor's
choice. The empty-state for no recent files stays.

#### O2 — Two-column bottom area with "Due for practice"
At the `lg` breakpoint and wider the bottom area is two columns: Recent Files (wider, left) and a
"Due for practice" card (right); below `lg` they stack (Recent Files first). The due card lists the
**recent repertoire files** (the existing ≤10 recents of type `repertoire` — the only repertoire
inventory available without new native work; decks are the same `deckAtomFamily` atoms the badges
already hydrate, so no extra native load) whose `due + unseen > 0`, sorted by that count descending,
ties by most recently opened. Each row: file display name, count, and a "Practice" button that runs
the same open path as clicking the recent row (which already opens repertoires in practice — O2
reuses it, it does not add a second open path). Verification includes an `openFile` unit assertion
that a repertoire open sets `tabFamily(id)` to `"practice"`. Header line: total "N positions due across M
repertoires" over the listed rows. Decks still hydrating are omitted until ready. A deck whose hydration failed
(`status: "read-failed"`, `src/state/practiceStorage.ts`) is listed as a row with a visible
"could not be loaded" marker and excluded from the total, and the total line then says it is
incomplete; "Nothing due" is shown only when every recent repertoire deck loaded successfully and
none has positions due. The count definition is shared with the existing badge (one
helper, rule 11), not recomputed differently.

#### O3 — Informative label instead of "Unknown"
When `openFile` derives a name and `getGameName` yields its no-information fallback, the name
written to the tab and to recents is the file's display name (file name without `.pgn`) instead of
"Unknown". Games with player or event headers keep their current name. Known limit (no migration, no new
IPC): a recent already stored as "Unknown" keeps that stored name (and the tab name) when reopened from Home, because Home
reopens with the stored name as an explicit `tabName` and no native command returns a handle's file
name; it is relabelled when the file is next opened from the Files page (which passes the real file
name, and `addRecentFileAtom` replaces the entry by handle). Felix's current "Unknown" entry that
triggered O4 disappears through O4. Verification: `files.test.ts` — a headerless game opened with
file name `Example.pgn` and no `tabName` yields tab and recent name `Example`; a game with White/Black
keeps `White - Black`.
Existing stored entries: Home renders a recent whose stored name is the no-information fallback
("Unknown") as a localized "Untitled game" label with the date it was last opened (e.g. "Untitled
game · 23 Oct 2026") instead of "Unknown", so every existing row is informative without stored data
changing. Reopening such a row from Home still passes its stored name (unchanged open path).
Verification: `NewTabHome.test.tsx` renders a stored "Unknown" row as the untitled label with date
and a named row unchanged.

#### O4 — A recent file in the workspace trash
Root cause: a file moved to the workspace trash keeps its handle, so reads of it still succeed, but
the trashed linked-collection record makes `qualify_source` fail with `StaleGame`, a misleading
message, and the recent entry is never cleaned up.
Required behaviour: a PGN read (`count_pgn_games`, `read_game`) of a file workspace handle whose
current location is inside its workspace's trash directory fails with a typed error the renderer
classifies as category `not-found` (message: the file was moved to the trash), checked before any
linked-collection qualification, so `StaleGame` is never produced for this case. Consequences that
must hold: the existing Home reconciliation removes such recents on mount; `openRecentFile` that
fails with `not-found` also removes that entry; restore and permanent delete from the trash banner
keep working (they do not go through the PGN read operation, or are explicitly unaffected); a file
restored from the trash reads normally again. `qualify_source`'s `StaleGame` for a genuinely changed
source is unchanged. If the new error is a new `Error` variant, its category mapping, Specta
binding and `src/platform/errors.ts` normalization follow the existing pattern
(`pnpm bindings:check`).

### Decisions and trade-offs
- Due panel scope = recent repertoires only (bounded, zero extra native cost). A workspace-wide
  repertoire scan would need a new native inventory command — not requested.
- Practice button reuses `openRecentFile`; no new practice-open path.
- Trashed = not found for reads (no trash browsing UI exists, so nothing legitimately reads a
  trashed PGN). Alternative rejected: renderer-only cleanup on the trash action — misses directory
  trashes, and does not clean existing entries like Felix's.
- O3 changes the name only in the "Unknown" case.

### Risks / open questions
- An open analysis tab whose file was trashed: its freshness/reload reads now report not-found
  instead of StaleGame. Executor confirms `FileFreshnessGate` handles `not-found` without a crash.
- e2e snapshots showing the home page will move (expected: only the home bottom area).

### Not part of this task
Repertoire inventory beyond recents; renaming non-"Unknown" games; a trash browser; changes to
`qualify_source` semantics for non-trashed sources; stored-recents migration.

### Phases
Sequential: Phase 1 (native + error normalization, independently committable), then Phase 2
(all renderer Home changes, including O4's renderer half). No file is touched by both phases.

#### Phase 1 — O4 trashed-source reads (role: sensitive)
Files: `src-tauri/src/pgn.rs`, `src-tauri/src/file_workspace.rs` and/or
`src-tauri/src/infra/path_authority*` (wherever the workspace-relative location of a handle is
resolvable), `src-tauri/src/error.rs` if a variant is added, `src/bindings/generated.ts` (regenerated
only), `src/platform/errors.ts`, tests beside each.
Tests: Rust — a file trashed through `trash_entry` then read via the count and read paths yields the
not-found-category error, not `StaleGame`; after restore it reads. Renderer — `errors.test.ts`: the
new error payload normalizes to category `not-found`.
PROOF COMMAND:
`PATH="$HOME/.cargo/bin:$PATH" cargo test --manifest-path src-tauri/Cargo.toml --locked trash && pnpm bindings:check && pnpm exec vitest run src/platform/errors.test.ts && pnpm exec tsgo --noEmit`

#### Phase 2 — O1, O2, O3 and O4's renderer half (role: normal)
Files: `src/components/tabs/NewTabHome.tsx` (layout, due card, untitled label, and `openRecentFile`
removing the entry on a `not-found` failure), `NewTabHome.module.css`, `NewTabHome.test.tsx`,
`src/utils/files.ts`, `src/utils/files.test.ts`, `src/translation/*.json` (all shipped catalogues),
the e2e spec carrying the geometry scenario — an extension of the registered
`e2e/workspace-tabs.spec.ts` (Playwright project `workspace-tabs`, `playwright.config.ts`), with its
fixture seeding in `e2e/fixtures.ts` if needed; run it with
`pnpm test:e2e:container --project=workspace-tabs`, affected
e2e snapshot files (re-recorded only through `pnpm test:e2e:update` after
`pnpm test:e2e:container`, per `.claude/skills/verify-ui/SKILL.md`).
Design: `DESIGN.md` tokens and existing Mantine components (Card, ScrollArea, Badge, Button).
Tests: Vitest — `openRecentFile` failing with `not-found` removes that recent entry and still
shows the error; due list order/total/empty state/hydrating exclusion/read-failed row and
incomplete total, Practice button opens via the recent-open path, `openFile` sets practice for a
repertoire, O3 fallback name for a headerless game and unchanged name for a game with headers.
Browser (jsdom cannot prove layout): a Playwright e2e scenario seeded with 10 recent files (mixed
types, several repertoires with due decks) that asserts by geometry, at a desktop viewport (≥ lg),
that every recent row is fully visible or reachable by scrolling inside the card, that the bottom
cards end within a small margin of the viewport bottom (no large empty band), that the recent
list's scroll viewport fills the card's content area below its title (its height is within a small
margin of the card's inner height minus the title, and exceeds 300px at that viewport — so a
retained cap inside a growing card fails), and that the two cards sit side by side; and at a short/narrow viewport that the cards stack and the last recent row
and the due card are reachable by scrolling. These assertions must fail with the old
`mah={300}` layout. Plus the WebKit check in build step 7 (`pnpm build && pnpm verify:app
--screenshot`).
PROOF COMMAND:
`pnpm exec tsgo --noEmit && pnpm exec vitest run src/components/tabs/NewTabHome.test.tsx src/utils/files.test.ts && pnpm i18n:extract && pnpm i18n:check && pnpm i18n:jsx && pnpm test:e2e:container --project=workspace-tabs` (the geometry scenario; existing moved home snapshots re-recorded only per verify-ui rules)


## Plan review
### Round 1 (plan-r1) — 10 lenses (Codex leaves)
Verdicts: plan REVISE, correctness REVISE, persisted-state REVISE, error-handling REVISE, tests REVISE;
minimalism, ipc-contract, pgn-index, platform-semantics, tauri-security APPROVED. Reports: `/tmp/build-homelayout/lens-*-r1.txt`.
- I-1 (plan#1, correctness#1, persisted-state#1) — O3 promised reopening repairs stored "Unknown", but Home passes the stored name as explicit `tabName`. Evidence: `NewTabHome.tsx:151/158`, `files.ts:139`; no native name-by-handle command in `generated.ts`. Disposition: Fix — promise removed, stated as known limit (Files-page open relabels), test specified. MANDATE (3).
- I-2 (plan#2, tests#1) — O1 has no browser proof; jsdom + mocked Mantine cannot detect clipping. Disposition: Fix — Playwright geometry scenario that fails on the old layout + WebKit step 7. MANDATE (1).
- I-3 (plan#3) — phases claimed file-disjoint but both touch NewTabHome. Disposition: Fix — sequential. 
- I-4 (error-handling#1) — read-failed decks would appear as "nothing due". Evidence: `practiceStorage.ts:680`. Disposition: Fix — failed row marker, incomplete total, empty state only when all loaded. MANDATE (2).
- I-5 (tests#2) — Practice proof could pass without practice selection. Disposition: Fix — `openFile` unit assertion on `tabFamily`. MANDATE (2).
- platform-semantics limitation (non-Linux proof via CI / pre-review `rust:windows:check`): no finding; covered by the push gates.
### Round 2 (plan-r2) — plan, correctness, persisted-state, error-handling, tests
Verdicts: correctness, persisted-state, error-handling, tests APPROVED; plan REVISE. Packet defect (plan#3): the
round-2 prompts carried round-1 HISTORY/REVISION lines (orchestrator substitution failed), so these
verdicts are not counted as closure; every open issue is re-checked in round 3 with corrected packets.
Reports: `/tmp/build-homelayout/lens-*-r2.txt`.
- I-1 reopened (plan r2#1) — existing stored "Unknown" rows stay uninformative, contrary to MANDATE (3). Fix — Home display label "Untitled game · <date>" for stored fallback names, tested.
- I-3 reopened (plan r2#2) — both phases still touched NewTabHome. Fix — Phase 1 native + errors.ts only; all Home changes in Phase 2.
- I-6 (plan r2#3) — round-2 packet mislabelled. Fix — round 3 packets with correct revision/history.
### Round 3 (plan-r3, delta from plan-r1) — plan, correctness, persisted-state, error-handling, tests
Verdicts: correctness, persisted-state, error-handling, tests APPROVED; plan REVISE.
Closed: I-1 (plan, correctness, persisted-state), I-3 (plan), I-4 (plan, error-handling), I-5 (plan, tests), I-6 (plan). I-2: tests CLOSED, plan NOT CLOSED.
- I-2 residual (plan r3#1) — geometry assertions would pass with the 300px cap kept inside a growing card. Fix — assert the list viewport fills the card content area and exceeds 300px.
- I-7 (plan r3#2) — Phase 2 omitted the e2e spec source. Fix — spec file and fixture listed.
### Round 4 (plan-r4, delta from plan-r3) — plan, tests
Verdicts: tests APPROVED; plan REVISE. Closed: I-2 (plan, tests), I-7 (plan).
- I-8 (plan r4#1 blocker, tests r4#1 should-fix) — a new `e2e/home-layout.spec.ts` is not registered in `playwright.config.ts` (explicit per-project `testMatch`; `workspace-tabs` matches only `workspace-tabs.spec.ts`). Fix — closed by arbiter: reference-only narrowing to the registered `workspace-tabs.spec.ts` and `--project=workspace-tabs`; behaviour/obligation unchanged; evidence `playwright.config.ts` project list (lines 60-61). Recheck in diff review.
Plan review complete: all issues I-1..I-8 Fix and closed. Adoptions per round: r1=5 r2=3 r3=2 r4=1.

## Diff review
### Round c1 — base a5e1b5b8..d5dbc54e, 11 lenses
Verdicts: correctness, root-cause, tests, error-handling, code-quality, persisted-state, pgn-index, ipc-contract, tauri-security, platform-semantics APPROVED; minimalism REVISE. CR-1 (carried I-8) CLOSED by all 11.
- EH-1 (error-handling, 95) write-blocked deck omitted, Home shows Loading forever — Fix (c9ef46fd).
- MIN-1 (minimalism, 97) test duplicates `shippedCatalogues`/`catalogueI18n` — Fix (c9ef46fd).
- T-1 (tests, 98) no test trashes between read and qualification — Fix (5cfff4b5).
- T-2 (tests, 96) permission/cancel tests do not assert recents intact — Fix (c9ef46fd).
- CQ-1 (code-quality nit, 94) unnamed geometry offsets — Fix (c9ef46fd).
- RC-1 (root-cause, verification limitation) no failing-before evidence — Fix: repair leaf removed the pre-qualification guard → new test fails with StaleGame; both guards removed → 3 tests fail; guards restored byte-exact.
- PS-1 (platform-semantics nit) linked trash tests are cfg(unix) — Skip: their fixture `linked_collections::tests::Fixture` is unix-only by existing design; the unlinked directory-descendant trash test still runs on Windows.
- ORCH-1 (orchestrator, screenshot) redundant "0 positions due across 0 repertoires" above "Nothing due" — Fix (c9ef46fd).
### Round c2 (closure, §4a) — d5dbc54e..5cfff4b5/c9ef46fd, 6 lenses
correctness, root-cause, tests, error-handling, code-quality, minimalism APPROVED. EH-1, MIN-1, T-1, T-2, CQ-1, RC-1 CLOSED; no new defects.

## Pre-review repair
Pre-review run 1 red: Windows GNU clippy E0432 — new linked trash tests imported the unix-only fixture. Fix d5dbc54e (`#[cfg(unix)]`), verified by `pnpm rust:windows:check`.

## Browser verification
- `pnpm test:e2e:container --project=workspace-tabs` 15/15 (Chromium container); geometry scenario fails with `mah={300}` restored ("recent list exceeds the old 300px cap", received 300).
- WebKit (installed Playwright webkit-2359, vite preview with the e2e IPC mocks): geometry scenario passes; desktop 1440×1000 and narrow 600×500 screenshots inspected (two columns filling to the window bottom; stacked and scroll-reachable when narrow).
- Moved snapshots: workspace-tabs-workspace-tabs.png, workspace-tabs-import-refused-workspace-tabs.png (home bottom area only).
