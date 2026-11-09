# Plan: drag-and-drop reordering of lines in a Repertoire file

## Goal
In the Library, a user reorders the lines of a Repertoire file by dragging a line, or a whole section by its heading. The file, section headings and open tabs stay correct, and each line keeps its practice progress, including across a crash mid-move.

## MANDATE
"As recommended, full auto execute the codex on a separate worktree."

The recommendations Felix accepted:

1. Dragging away the first line of a section leaves the heading where it is, and the next line becomes the group's first line. Dropping directly below a heading makes the line the group's first line. Dropping directly above a heading puts it at the end of the previous group.
2. A whole section can be dragged by its heading. Lines stay in the same order inside the section, and practice progress is kept.
3. Repertoire files only for now.

Also agreed: each line keeps its own practice progress, including if the app crashes mid-move ("The approach used for deleting a line can't simply be reused, because it detects a finished delete by the changed line count, and a move doesn't change the count. Moving needs its own safeguard."). Open tabs follow their line to its new position. A move is refused while an affected line has unsaved changes in an open tab. There's no undo button, you drag the line back instead. Windows stays refused like every per-game write and lifting that is out of scope.

Felix's request that started it: "I want to drag and drop or somehow move this up."

## Threat model and non-goals
Inputs are the user's own PGN files, which may be hand-edited or externally changed at any moment, and may carry CRLF, a BOM, headerless games, comments containing `[`, a final game without a newline. No malicious renderer is assumed beyond the existing command boundary. Crash means process or power loss at any point between journal write and map finalization.

## Traced premises
- `src-tauri/src/pgn.rs:849` `GameRange` excludes the initial BOM and includes everything through the next game's header-line start or EOF, so separators travel with the preceding game.
- `src-tauri/src/pgn.rs:910,936` A game starts only on a complete tag-header line after the preceding header block ended, and a blank line ends a header block. A join therefore needs a physical line boundary, and a header-only game needs a blank line after it.
- `src-tauri/src/pgn.rs:925` A headerless game moved later would merge into its predecessor.
- `src-tauri/src/pgn.rs:1301` A revision is device, inode, size, mtime, ctime. `game_stamp` hashes a game's exact bytes including trailing separators, so identical lines share a stamp.
- `src-tauri/src/pgn.rs:1781,1790,1935` `PgnMutation` replaces one range. `PgnReplacement::Stream` accepts a temp file. Game expectations hash the whole target and refuse several parser games, so a block needs a revision check rather than a game expectation.
- `src-tauri/src/pgn.rs:2126-2235` Delete holds the practice mutation lock, then the edit lock, resolves pending practice, scans, checks revision, prepares the journal, commits once, finalizes the journal by outcome class (`PgnEdit` uncertainty leaves it pending).
- `src-tauri/src/pgn.rs:1691,1744`, `src-tauri/src/practice.rs:2630` Pending work is recovered before later mutations and before practice access, and by inventory recovery.
- `src-tauri/src/practice.rs:44,56,588,650` `FileDeckMap.ordinals` maps ordinal to a stable deck number. `PendingDelete` holds id, ordinal, count. `apply_pending` removes an ordinal, rotates the epoch, sets `legacy_superseded`. Recovery uses `game_count - 1 == count`, which a move cannot satisfy.
- `src-tauri/src/practice.rs:531,735` A file without a map has decks addressed by ordinal. With a map, an ordinal past its length has no deck.
- `src/state/practiceStorage.ts:408-416` A deck in old browser storage migrates under its ordinal, and is dropped as superseded once `legacy_superseded` is true.
- `src/components/panels/info/InfoPanel.tsx:443-610` Delete's renderer flow: captures tab preconditions, `beginFileStructureChange`, `withFileWrite`, native call, tab rebinding through `tabsAtom`, `unverified`/`conflict` freshness, deck atom eviction, `clearPracticeFileMigrationFailures`.
- `src/components/tabs/FileFreshnessGate.tsx:392` An `unverified` tab re-reads its game and reconciles, using the tab's stored source stamp. A clean tab whose bytes changed is handled there.
- `src/components/files/FileCard.tsx:42-44`, `src/components/panels/info/GameSelector.tsx:123` Library selection is `{page}` plus an ordinal-keyed row map. Pending page reads are keyed only by file, so an old response can refill a cleared map.
- `src/components/panels/info/LineSectionEditor.tsx`, `src/components/files/lineSection.ts:66` The renderer edits the `Section` tag in raw game text.
- `src-tauri/src/db/linked_collections.rs:1003`, `src-tauri/src/pgn.rs:2248` Active Game and Tournament collections are protected from positional writes by `contains_source`.
- `src/components/files/rowDragPreview.ts:3` A native drag image is doubled on WebKitGTK at a fractional scale.
- `node_modules/@hello-pangea/dnd/src/view/use-draggable-publisher/get-dimension.ts:15` The library's registry does not publish size changes of mounted items during a drag, and `src/components/panels/info/GameSelector.tsx:135` measures rows when sections load.

## Approach

### The move model
A file is a sequence of tokens: a heading token for each `Section` tag, and one line token per game, with each heading directly before the line carrying its tag. A section runs from its heading to the next heading or the end of the file. Empty values are headings too (a gap).

- A line move removes one line token and inserts it at a token gap. Heading tokens do not move.
- A section move takes its heading and all its lines as a block. Its destination is only directly before another heading or at the end of the file, and never inside its own block, since any other position would split a section or absorb lines into it.
- After the move, each heading attaches to the next line token. A heading with no line left before the next heading or the end of the file disappears.
- A drop that yields the same tokens is a no-op.

A destination is a game boundary `before` in `0..=count`, plus `belowHeading`. If game `before` starts a section, `belowHeading` chooses between the two token gaps at that boundary: below means the first line of that section, otherwise the end of the previous group. `belowHeading` is refused when `before` has no heading.

### Native block move
One new command `move_games` with the file handle, the move (kind line or section, source index, `before`, `belowHeading`) and the revision the list was read at.

- It runs under the same practice mutation lock, edit lock, pending resolution and off-Unix refusal as delete, and refuses an active collection source through `contains_source`.
- It refuses a stale revision and out-of-range or invalid destinations without writing.
- It assembles the affected span in the new order, applies the tag transfers, and commits through one `commit_pgn_mutation` using `PgnReplacement::Stream`, so a large span is not read into memory. No whole-span 10 MiB cap applies. One game's bounds still do.
- Joins: each game keeps its own bytes. At each new join, a game that lacks one gets a line ending plus blank line, in the file's line ending. A BOM stays once at offset zero. A headerless game that would end up after another game gets `[Event "?"]`, the same fallback the tag editor uses.
- Before publishing, the assembled file is rescanned and must have the expected number of games at the expected boundaries, or the command refuses and writes nothing.
- Identical output bytes are a no-op that writes nothing and permutes nothing.
- The result reports whether it changed, and the span's new order as old ordinals (`start`, `order`), which the renderer uses instead of recomputing section ranges.

### One tag editor
The `Section` tag edit moves to native code and `LineSectionEditor` calls one new command `set_game_section` (index, value or none, stamp, revision), so that one implementation owns tag editing. The renderer's `withLineSection` and its scanner are deleted. All cases in `src/components/files/lineSection.test.ts` carry over to Rust unchanged in expected bytes. A transferred heading keeps its value bytes.

### Practice survives the move
A new optional `pending_reorder` field on `FileDeckMap` journals id, digest of the original file, digest of the exact output, and the permutation, written durably before publication.

- A file without a map first gets the complete identity map. Entries past the map's length are padded with `None`.
- After publication becomes durable, one atomic map write applies the permutation, rotates the epoch, sets `legacy_superseded`, and clears the journal. No deck is retired.
- Outcome classes match delete: `PgnEdit` uncertainty stays pending, later uncertainty finalizes as landed.
- Recovery compares the current file's streamed digest: output digest means landed (after the same durability step as delete), original digest means not landed. Anything else cannot prove either outcome, so the journal stays and is never guessed at: practice access and structural edits for that file keep refusing with the existing typed conflict, exactly as an unresolved delete journal already refuses them. Recovery completes by itself if the file returns to either digest.
- Every path that checks or recovers pending deletes also handles pending reorders: `has_pending_delete` callers, mapped deck access, inventory recovery.
- A new operation is refused while either journal is unresolved.
- The field is additive, the map version stays 1, and an existing delete journal reads unchanged.

Old browser-stored decks: before the native call, the renderer awaits the practice migration pass, and refuses the move with a visible, retryable error unless that pass was complete and trusted, practice writes are not globally blocked, and this file has no unresolved migration failure (file-wide or for any of its games). Setting `legacy_superseded` would otherwise discard progress not yet migrated, including progress a failed scan never discovered.

### Renderer orchestration
- `rebindFileTabsAfterStructureChange` is extracted into `src/utils/tabs.ts` and used by delete and reorder: it takes captured tab preconditions, the resulting count and an old-to-new ordinal map, persists through `tabsAtom`, and returns matched and saved.
- A reorder inspects open tabs on every game in the affected span with `scanBlockingTabs` and refuses with the existing unsaved-tab message style if any blocks. The affected span is a renderer upper bound computed before the call, and includes every game whose bytes can change. For a line move, that is from the smallest to the largest of the source, the source's successor (which inherits its heading) and the game at `before` (which loses its heading on a below-heading drop). For a section move, it runs from the smaller of source and `before` to the larger of `before` and the end of the section as known from loaded rows, and to the end of the file when the end is not loaded. Every displaced game is therefore inside the span.
- The flow holds `beginFileStructureChange` and `withFileWrite` like delete. On success it rebinds tabs, marks same-file tabs `unverified` so the existing gate reconciles clean tabs whose bytes changed, evicts deck atoms and clears migration failures, moves the Library selection with its line, and reloads the list.
- Applied-despite-error and stale-revision follow delete's handling: `conflict` marks, list reset, deck eviction. A refused tab-metadata write after a landed move marks `conflict` and reports durability uncertainty, as delete does.
- The list stays on screen with its scroll position during the reload, then swaps atomically. Pending page reads from before the move are invalidated so they cannot refill the list.
- No reorder starts while one is in flight for the file.

### The drag gesture
A pointer-event controller inside the existing virtualized list, because the existing drag library does not take row size changes during a drag and has no notion of the two gaps at a heading, and because a native HTML5 drag brings the doubled drag image.

- Enabled only by the `onMoveLines` prop, which `FileCard` passes for Repertoire files. The InfoPanel list is unchanged.
- A line starts dragging from its row, a section from its heading area. Nested buttons never start a drag. The gesture begins after a small movement threshold, so click selects and double click opens as they do today.
- A row-sized DOM preview follows the pointer. A section preview shows its name.
- A marker shows the destination, and distinguishes above a heading from below it.
- The viewport scrolls continuously near its edges, even with a stationary pointer, and the destination is recomputed while it does.
- Pointer capture is on a stable list element, because the source row can unmount.
- Each drag has one owned session, cleaned up on drop, Escape, pointer cancel, lost capture, window blur, unmount, file change and list reset, including its animation frame and preview element.
- A drop onto a position that is not allowed shows no marker and does nothing. A drop on an unloaded row is not offered.

## Decisions and trade-offs
Decided autonomously (recorded in `tasks/decisions.md`):
- A heading left with no line disappears, because a heading is stored on its line.
- A section can be dropped only at section boundaries, because anything else splits a section or absorbs lines into it.
- Native tag editing replaces the renderer's, because a second implementation of the same concept is not allowed to survive.
- Journal digest over the whole file, because a move preserves count and revisions cannot prove which edit landed.
- A file matching neither journal digest keeps the journal unresolved, because the outcome cannot be proved and guessing could assign progress to the wrong lines.
- Pointer controller over the drag library and HTML5, for the reasons above.
- Keyboard reordering is left out: the mandate is drag and drop.

## Risks / open questions
- Native WebKitGTK behaviour is proved only in the real app (see Real-app proof). Pointer events are not subject to the GTK drag surface.
- Known limit, same as delete: the native journal covers practice progress only. If the process dies, or the workspace write is refused, after the move lands but before the tab metadata persists, a saved tab reopens at its old position and the freshness gate reloads whichever line is now there. No content is lost, because a tab with unsaved changes refuses the move before it starts.
- If a crash window and an outside edit coincide, practice for that one file stays refused until the file returns to a known state. No progress is reassigned by guessing.
- A section heading at the very first line with an empty name occupies no space, so it has no drag handle.

## Not part of this task
Windows support. Undo. Keyboard reordering. Reordering in other file types. Multi-select. Dragging between files.

## Phases

Each phase ends with its native commands used by production renderer code, so the IPC consumer gate stays green.

### Phase 1: one tag editor, end to end
Role: sensitive. Files: `src-tauri/src/pgn.rs`, `src-tauri/src/main.rs`, `src-tauri/src/infra/platform_support/tests.rs` (guard row for the new command), `src/bindings/generated.ts` (regenerated only), `src/components/panels/info/LineSectionEditor.tsx` and its test, `src/components/files/lineSection.ts` and its test, `src/utils/files.ts` if a wrapper is needed.
Implements: One tag editor. The Rust tests carry over every `lineSection.test.ts` case with unchanged expected bytes, and the renderer test proves the editor calls the command with the listed stamp and revision.
PROOF COMMAND: `cargo test --manifest-path src-tauri/Cargo.toml --locked --bins -- pgn::` then `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --locked -- -D warnings` then `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` then `pnpm rust:windows:check` then `pnpm bindings:check` then `pnpm ipc:consumers:check` then `pnpm exec tsgo --noEmit` then the related Vitest command over changed paths.

### Phase 2: the native move and its renderer flow
Role: sensitive. Files: `src-tauri/src/pgn.rs`, `src-tauri/src/practice.rs`, `src-tauri/src/main.rs`, `src-tauri/src/infra/platform_support/tests.rs` (guard row), `src/bindings/generated.ts` (regenerated only), `src/utils/tabs.ts`, `src/components/panels/info/InfoPanel.tsx`, `src/state/practiceStorage.ts`, `src/utils/files.ts`, `src/components/files/FileCard.tsx`, `src/components/panels/info/GameSelector.tsx` (the `onMoveLines` prop and list-reload generation only), a new reorder module under `src/components/files/`, and their tests.
Implements: Native block move, Practice survives the move, Renderer orchestration in full, including `FileCard`'s selection following its line and the list reload that discards stale page reads. The reorder module holds the production `move_games` call, and `FileCard` passes it to `GameSelector` as `onMoveLines` for Repertoire files.
Native tests: every join shape in Traced premises, section ranges, the token rules, stale revision, each refusal, identical output, recovery at each journal state including a digest matching neither side, an existing delete journal, a file with no map, ordinals past the map's length.
Renderer tests assert: resulting tab ordinals after a move, a blocked move when a dirty tab is on the source, on the heading's new owner, on the below-heading destination and on a game displaced by a downward section move, and that no native call happens when blocked; refusal on an untrusted migration scan, a global write block and a file failure; delete's existing tab behaviour through the extracted function; selection following its line; a stale pending page read not refilling the list.
PROOF COMMAND: `cargo test --manifest-path src-tauri/Cargo.toml --locked --bins -- pgn:: practice::` then `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --locked -- -D warnings` then `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` then `pnpm rust:windows:check` then `pnpm bindings:check` then `pnpm ipc:consumers:check` then `pnpm exec tsgo --noEmit` then the related Vitest command over changed paths.

### Phase 3: the drag gesture
Role: normal. Files: `src/components/panels/info/GameSelector.tsx`, `GameSelector.module.css`, a new controller module next to it, translations only if a new string is unavoidable, tests, and `e2e/files-preview.spec.ts`.
Implements: The drag gesture, calling `onMoveLines`. Tests use real Playwright mouse gestures for the movement threshold, click and double-click unchanged, line drop on both sides of a heading, section drop, stationary edge scroll, Escape, an unmounted source, and an unaffected non-repertoire list.
PROOF COMMAND: `pnpm exec tsgo --noEmit` then the related Vitest command over changed paths then `pnpm test:e2e:container e2e/files-preview.spec.ts`.

## Real-app proof
After the last phase and review, the orchestrator drives the release build through `pnpm verify:app`'s harness (`scripts/app-driver.mjs`, real WebKitGTK, real Rust backend, throwaway HOME) on a real Repertoire file with a practice deck. It performs real pointer gestures and asserts: the file on disk has the new order, a line dropped below a heading is that section's first line, a dragged section keeps its internal order, the deck of a moved line still belongs to that line after the move and after a restart, the source row can scroll out of view during an edge-scroll drag, and the preview has the row's size. The remaining CI jobs prove Windows refusal (`rust-windows-test`), macOS behaviour (`rust-macos-test`) and target compilation (`rust-platform`), which are required at push.

## Reviews

### Round 1 (revision plan-r1, nine lenses)
Raw verdicts: plan REVISE, minimalism APPROVED, correctness APPROVED, tests REVISE, error-handling REVISE, pgn-index APPROVED, ipc-contract APPROVED, persisted-state REVISE, platform-semantics REVISE.
- R1-1 Unknown digest treated as not landed could leave progress on the wrong lines (plan #2, error-handling #1). Fix: the journal stays and practice and structural edits refuse.
- R1-2 Migration gate did not establish a trusted pass (plan #4, error-handling #2, persisted-state #1). Fix: complete, trusted pass, no global block, no file failure.
- R1-3 Affected span missed heading recipients (plan #1). Fix: span includes the successor and the below-heading destination, with a dirty-tab test for each.
- R1-4 Tab metadata not crash-safe (plan #3, persisted-state #2). Skip: the mandate's crash clause covers practice progress only ("each line keeps its own practice progress, including if the app crashes mid-move"). Evidence: dirty tabs refuse the move, so only clean tabs can be affected, and `src/components/tabs/FileFreshnessGate.tsx:392` reloads them from the file, so no content is lost. Delete has the same window. Goal wording corrected and the limit is stated under Risks.
- R1-5 No proof through the real app boundary or WebKitGTK (plan #5, platform-semantics #2, tests #2). Fix: Real-app proof section.
- R1-6 Review packet lacked revision, history and open IDs (plan #6). Fix: included from round 2.
- R1-7 Phase 1 exported commands without a consumer, and two phases shared FileCard (plan #7). Fix: phases recut around complete integrations, with the consumer gate in each proof.
- R1-8 Cross-platform proof (platform-semantics #1). Fix: `pnpm rust:windows:check` in native proofs, guard rows for both commands, CI jobs named.
- R1-9 Renderer behaviours lacked named assertions (tests #1). Fix: named in Phase 2.

### Round 2 (revision plan-r2, closure: plan, error-handling, persisted-state, tests, platform-semantics)
Raw verdicts: plan REVISE, error-handling APPROVED, persisted-state REVISE, tests APPROVED, platform-semantics APPROVED.
Closed: R1-1, R1-2, R1-4 (Skip accepted), R1-5, R1-6, R1-8, R1-9.
- R1-3 reopened (plan #1, persisted-state #1): the section span missed games displaced by a downward move. Fix: the span reaches the larger of `before` and the section end, with a downward-move dirty-tab assertion.
- R1-7 reopened (plan #2): selection following and stale page reads were proved in a phase that did not own their wiring. Fix: Phase 2 owns the full renderer flow including `FileCard` and the reload generation, and Phase 3 is the gesture only.

### Round 3 (revision plan-r3, closure: plan, persisted-state)
Raw verdicts: plan APPROVED, persisted-state APPROVED. R1-3 and R1-7 closed. Plan review ended with every issue closed.

### Round 4 (cumulative diff review, eleven lenses)
Raw verdicts: correctness REVISE, root-cause APPROVED, tests REVISE, code-quality REVISE, minimalism REVISE, error-handling APPROVED, pgn-index REVISE, ipc-contract APPROVED, persisted-state REVISE, platform-semantics APPROVED, tauri-security APPROVED.
All Fix: first versus last Section tag; selection after unmount; a tab opened during a reorder; inline-header fallback using the scanner's predicate; second copy of journal finalization; `has_pending_delete` naming; unnamed drag constants; `next + 999`; `take(80)`; the `fileStructureChange` comment; journal durable before publication; section move through native preparation; the boundary-validation refusal.

### Round 5 (closure: correctness, tests, code-quality, minimalism, persisted-state, pgn-index)
Verdicts: minimalism APPROVED, others REVISE. Waiting in `openFile` preserved a stale position and left in-flight opens unprotected; NBSP disagreed with the scanner; boundary refusal was only synthetic; a viewport fraction was unnamed. All Fix.

### Round 6 (closure: correctness, tests, code-quality, persisted-state, pgn-index)
Verdicts: correctness REVISE, persisted-state REVISE, tests APPROVED with one should-fix, code-quality APPROVED, pgn-index APPROVED. Stale rows after the lease ended, and file import outside the lease. Same mechanism reopened a second time, so patching stopped.

### Round 7 (focused fresh-context mechanism judgment, review-plan)
REVISE. Ruling: keep mutual exclusion, check both stamp and revision on open because identical lines share a stamp, and hold the lease through import admission. Adopted as written.

### Round 8 (closure: correctness, persisted-state, tests, plan)
Verdicts: persisted-state, tests and plan APPROVED, correctness REVISE: resetting rows after a refused open left the Open button nothing to check. Fix: keep rows until replaced.

### Round 9 (closure: correctness, tests)
Both APPROVED. Every adopted finding closed.

Real-app proof: `scripts/app-driver.mjs` probe, real WebKitGTK and backend, 14/14, each assertion seen to fail under a staged break.
