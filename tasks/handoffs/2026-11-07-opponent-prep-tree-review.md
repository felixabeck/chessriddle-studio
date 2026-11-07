# Opponent preparation in the database Players view — review record

Build run 2026-11-07 (Claude Code orchestrator, Codex executor, worktree `build/opponent-prep-tree-20261107`).
Same-family disclosure: Codex wrote the code and Codex lenses reviewed it (OpenAI high tier, same model family); Claude Code wrote the plan and arbitrated.

This file holds the full reviewed plan with its cumulative plan-review record, followed by the diff-review rounds.

## Plan: Opponent preparation in the database Players view

### Goal
Let Felix prepare against an opponent directly from Databases → Players: see every player's number of
games in the list, walk that player's opening tree (moves, game counts, the player's score) inside the
player card with the games that reached each position, and jump to a full analysis board with the same
filter preset.

### MANDATE
Felix, 2026-11-07 (verbatim excerpts):
- "In players openings I just see this general information, but that's not useful. I want to have more
  information to see the exact variation they play."
- "imagine he has 50 games, then it's not very useful. Then an opening tree would be much better. But
  shouldn't there be an easier option? For example, in chess space, I immediately see an opening tree with
  always references to the games that he played in the position when I click through the opening tree.
  That is what I expect here. I don't want this workaround with going to a separate tab and opening a
  board there. This is way too complicated."
- "the number of games is not shown. This is also be very important. There should be the number of games
  in the database shown when I look for a player, because this is useful information."
- Agreed proposal (assistant, accepted by Felix): (1) a sortable "Games" column in the player list;
  (2) an opening tree in the player card: small board, White/Black switch, move list with games and the
  player's score, click a move to advance, step back and reset, below it the player's games that reached
  the position (opponent, result, date, event), click → existing preview, double-click → open on a board;
  (3) a "Prepare on board" button opening the current position on a full analysis board with player and
  colour filter preset.
- Felix's decision: "Yes, replace it." — the opening tree replaces the current Openings tab.
  "Build this now full auto executor codex on a separate work tree."

### Threat model and non-goals
Inputs are the user's own local databases (converted PGN, linked collections, account databases),
including a 11.4M-game / 467k-player database (Mega Database 2025, 3 GB). No adversary beyond corrupt or
legacy database files, which existing schema validation/migration already rejects or repairs. Performance
on the 11M-game database is a correctness requirement for this feature. Non-goal: changing the Accounts
page's personal card.

### Traced premises
- `src-tauri/src/db/create.sql:16` Players = (ID, Name UNIQUE, Elo); no game count. Unknown player ID 0
  is protected by `protect_unknown_player_update` (checks ID/Name/Elo only) and `_delete` triggers.
- `src-tauri/src/db/migrations.rs:9` CURRENT_DATABASE_VERSION "2.1.0"; `migrate_database` (line 189)
  dispatches transactional migrations; `validate_schema` (~line 483) checks exact columns of the
  canonical schema; ordinary connection acquisition migrates (`repository.rs:875`).
- Game mutation paths (all must keep a count correct): convert/import via `TempGame::insert_to_db`
  (`db/mod.rs:411`, `:1435`, account-aware `:1202`), `insert_db_game` (`:4748`), `delete_db_game`
  (`:4699`), `delete_duplicated_games` (`:4293`), `delete_empty_games` (`:4357`),
  `write_parsed_db_game` player re-attribution (`:4856`), `merge_players` (`:5051`), linked-collection
  full rebuild (`linked_collections.rs:2414`), legacy migration rebuild (`migrations.rs:263`).
- `src-tauri/src/db/indexes.sql` / `create_indexes` / `delete_indexes` (`db/mod.rs:1748-1776`,
  UI toggle `useDatabaseLibrary.tsx:809`): the user can drop the Games WhiteID/BlackID indexes.
- Measured on Mega Database 2025 (read-only sqlite3, 2026-11-07): indexed per-player count 1 ms; a page
  of 25 name-filtered players with live counts 27 ms; unfiltered sort of all 467k players by live count
  5.0 s cold / 1.3 s warm; full `GROUP BY` backfill over 11.4M games 3.2 s. Kobert, Hans (ID 411646)
  has 6 games.
- `get_players` (`db/mod.rs:2947-3030`): blocking gateway, `read_snapshot`, filters name/Elo, sorts
  `PlayerSort` id|name|elo, separate COUNT for pagination. Binding `Player = { id, name, elo }`.
- Explorer: `searchPosition(options, progressId, signal)` (`src/utils/db.ts:416`) → native
  `search_position` (`db/search.rs:675`) returns `[PositionStats{move,white,draw,black}[], NormalizedGame[]]`;
  `player1` = White ID, `player2` = Black ID (`search.rs:883`); stats cover all matches, games capped at
  500 (`search.rs:810/936`); results cached natively (`search.rs:780`); progress per progress id.
- `DatabasePanel.tsx:116` `fetchOpening` + `:217` SWR/`useNativeRequestOwner` keying incl. linked
  collection generation (`currency`) is the only consumer today; `LocalOptions` type at `:67`.
- `DatabasePanel.tsx:164-190` overrides `localOptions.path` with the global `referenceDbAtom`
  (localStorage "reference-database", `atoms.ts:696`). Per-tab explorer state: `localOptionsFamily`,
  `dbTypeFamily`, `dbTabFamily`, `tabFamily` (`atoms.ts:1031-1035`), cleaned on tab close (`:1388`).
- `PersonalCard.tsx` is shared by Accounts (`home/Databases.tsx:392`) and the database card
  (`databases/PlayerCard.tsx:42`, `isDatabase`); `OpeningsPanel` only via PersonalCard; active tab is
  the persisted `players.activeTab` shared by both.
- `GamePreview.tsx:41` exported preview (pgn + headers); `openDatabaseGame` (`utils/databaseGame.ts:9`)
  opens a database game in an analysis tab; `GamesTable.tsx:43` shows the established open flow.
- `createTab` (`utils/tabs.ts:561`) returns the new tab id or null; no explorer preset parameter.

### Approach

### O1 Persisted per-player game count
- New schema version 2.2.0: `Players.GameCount INTEGER NOT NULL DEFAULT 0` and an index for sorting by it.
- Count = number of distinct games in which the player is White or Black (a game with WhiteID = BlackID
  counts once). The Unknown player (ID 0) is never listed; its count may stay 0.
- Maintained by SQLite triggers on `Games` (AFTER INSERT, AFTER DELETE, AFTER UPDATE OF WhiteID, BlackID),
  created in `create.sql` and by the migration, so every present and future mutation path (list in
  Traced premises) stays correct inside its own transaction without per-path code. Triggers must not
  conflict with the protect_unknown_player_* triggers.
- Migration 2.1.0 → 2.2.0 (and the 2.0.0 / 1.0.0 chains ending at 2.2.0): add column, backfill with one
  aggregate over Games, create index + triggers, set version; transactional like existing migrations.
  `validate_schema` accepts exactly the new canonical schema (column, index, triggers).
- Bulk paths that are measurably slowed by per-row triggers (PGN conversion into a fresh database) may
  instead create the triggers after loading and backfill once, only if the executor measures a material
  regression; correctness must be identical either way.
- Proof: Rust tests asserting the count equals a fresh aggregate after each mutation path class
  (insert, delete single, delete duplicates/empty, header edit re-attributing players, merge players,
  linked-collection rebuild, migration from 2.1.0 / 2.0.0 / 1.0.0 fixtures).
- Performance acceptance (R1-5): an `#[ignore]` Rust benchmark test reading a database path from an
  environment variable, run against a migrated copy of Mega Database 2025 in the run's scratch directory
  with the Games indexes deleted, calls the production `get_players` path: page 1 sorted by games
  descending unfiltered and with name filter "kobert" each completes in < 250 ms warm. The migration time
  of the copy is reported. Trigger overhead on conversion is measured on a ≥100k-game PGN before/after;
  > 15 % slower triggers the O1 bulk mitigation.

### O2 Player list Games column
- `Player` gains `game_count` (Specta binding regenerated, never hand-edited); `PlayerSort` gains
  `games`; `get_players` sorts by it with a stable tie-breaker (name, then id).
- `PlayerTable.tsx` shows a sortable, right-aligned tabular-figure "Games" column; persisted
  `database-view` query state accepts the new sort value (schema-validated hydration still rejects
  unknown values).
- Proof (R1-5): Rust assertion of result order for games ascending/descending incl. tie-breaker; store
  hydration round trip of the `games` sort; PlayerTable test that clicking the Games header requests the
  `games` sort and renders counts.

### O3 Shared local explorer request
- Extract from `DatabasePanel.tsx` the local explorer request (option → `searchPosition`, sorted move
  stats, games, request owner/SWR key including linked collection generation, progress id) into one
  shared hook/facade used by both the analysis-board Database panel and the player opening tree. No
  second implementation of the request, key or cancellation contract. Panel behaviour unchanged.
- Native query extension (R1-1, R1-2), both optional with defaults that keep today's panel behaviour
  byte-for-byte: `include_unknown_results` (default false) — when true, games with unknown/non-standard
  results are matched and counted in a new `PositionStats.unknown` bucket (always 0 when false) and are
  eligible as sample games; `sample_order` `elo` (default, today's highest-rated selection) | `date`
  (most recent first, ties by id) applied before the 500 cap and to the returned order. Both fields are
  part of the native result-cache identity and of the renderer SWR key.
- Proof (R1-5): Rust tests for unknown-result inclusion/exclusion and date sample order beyond the cap
  (501+ matches, newest low-rated game retained); a mounted test of the shared hook proving a superseded
  request's result is discarded, a surviving subscriber keeps its result, and linked generation is part
  of the key; existing DatabasePanel tests stay green unchanged.

### O4 Opening tree replaces the database player card's Openings tab
- In the database player card (`isDatabase`), the Openings tab renders a new opening tree; the Accounts
  personal card keeps the existing OpeningsPanel unchanged.
- Opening tree state is local to the card (resets on player change): colour switch White/Black
  (default White), list of SAN moves played from the standard start position, derived FEN.
- Query: the card's own database handle (not the global reference database), player = selected player
  id on the chosen colour (`player1` for White, `player2` for Black), exact position, no other filters,
  `include_unknown_results` true, `sample_order` date.
- Board: small read-only board oriented to the chosen colour, showing the current position.
- Move table: move, games, the player's score from the player's perspective
  ((wins + draws/2) / scored games, where scored games exclude the unknown bucket), and a W/D/L bar;
  when a row has no scored games (only unknown results) the score shows as unavailable ("–") and the
  bar is empty while the game count is still shown (R2-1);
  rows sorted by games. Clicking a row (or the board move, optional) appends the move. The `"*"` row
  (games that ended in this position) is shown as a non-clickable "game ended here" row and counted
  (R1-3). Controls: step back, reset to start. A breadcrumb/move line shows the current sequence.
- Totals: header shows the number of the player's games in this position for this colour; the full
  game total remains in Overview.
- Games list under the tree: the player's games at the current position — opponent, result, date, event,
  sorted by date descending; when the native cap (500) truncates, state that the list shows the first N
  of M. Single click selects a game and shows it in the existing `GamePreview` (within the card);
  double-click (and an explicit Open button in the preview) opens it via `openDatabaseGame`.
- Loading shows the existing progress pattern; errors render in-card (no blank card); empty position
  says no games.
- Layout fits the card width ranges already supported (20rem min, compact stacking) without horizontal
  overflow.
- Proof (R1-5): component test with mocked native search — advancing a move updates the board FEN, the
  requested FEN and the games list; back/reset restore them; colour switch changes player1/player2;
  terminal row is not clickable; unknown results are counted; displayed scores are asserted for White
  and for Black with unequal wins/losses plus one unknown-result game, and an unknown-only row shows the
  unavailable score (R2-5); the outgoing `tauri.searchPosition` call (native command boundary, not a
  mocked facade) carries `include_unknown_results: true` and `sample_order: "date"` (R2-4); Accounts
  PersonalCard still renders the old OpeningsPanel. Playwright e2e (container) in `e2e/database-files.spec.ts`: select a player, open
  Openings, click a move, see the games list and preview, at wide and 320px widths with no horizontal
  overflow. Real-app verification (step 7) on Mega Database 2025.

### O5 Prepare on board
- Button in the opening tree opens a new analysis tab with the current move sequence as mainline
  (position at the end), orientation = chosen colour, right panel on Database → local → Stats, and the
  tab's local explorer options preset to player id + colour and to this card's database.
- The tab's explorer must use this database even when the global reference database differs, without
  changing the global reference preference: the local explorer options get a per-tab pinned database that
  the panel honours instead of the global reference; tabs without a pin behave as today. The pin is
  runtime per-tab state, cleaned on tab close like the other families.
- Failure semantics (R1-4): tab creation runs through the existing `runTabCreation` path; a rejection
  surfaces through the existing notification path (not for cancellation), a `null` admission refusal
  applies no preset and does not navigate; presets are applied only to the admitted tab id, before
  navigation.
- Proof (R1-5): integration test with card database A and global reference B — the new tab's Database
  panel requests `searchPosition` with path A, player, colour and the end FEN, and the global reference
  stays B; the admitted tab's tree has the move sequence as its mainline (start position + N moves, current
  position at its end) and orientation equal to the chosen colour; rejection and null refusal leave no
  preset and no navigation. The Playwright case additionally clicks Prepare on board after advancing two
  moves and asserts the new analysis tab shows those moves in notation and the Database panel on Stats.

### O6 Player-filtered position search is interactive on large databases (added after real-app evidence)
- Evidence (real app, release build, migrated copy of Mega Database 2025, 2026-11-07): each opening-tree
  query for Kobert, Hans (6 games) takes about 57 s, the first about 90 s including one-time search-index
  generation. Cause (traced, round-4 lenses): every query re-opens the sidecar through
  `open_valid_preferred` (search.rs ~228) before any cache lookup, and `MmapSearchIndex::open_file_inner`
  validates every entry's mainline move stream sequentially (search_index.rs ~725); the search loop then
  validates every entry's move stream again before the cheap metadata filters (search.rs ~886).
- Obligations (validation and regeneration semantics unchanged):
  (a) Loader: a query whose sidecar identity matches an already loaded and validated mapping in the
      existing search cache reuses it without re-validating move streams; identity mismatch, invalidation
      or a stale revision still reopen and validate exactly as today.
  (b) Open-time validation: the per-entry move-stream validation in `open_file_inner` runs in parallel
      across chunks (Rayon, inside the existing blocking work), with the same errors (InvalidData →
      regenerate path), cancellation (Interrupted) and complete coverage of every entry.
  (c) Search loop: metadata filters (player, result, date, Elo, fast events) run before any per-entry
      move-stream work; because open-time validation already covered every entry, the loop no longer
      re-validates non-candidates. Candidate replay keeps its existing error mapping.
  Results, stats, sampling, cache identity and corruption behaviour are unchanged for every query.
- Acceptance (release build, migrated Mega copy, sidecar present): a Kobert-filtered exact-position
  query completes in < 2 s when the mapping is loaded, and the first query after app start in < 10 s;
  existing search/index tests unchanged and green; tests prove (a) a second query does not re-run
  move-stream validation (instrumented counter) and an invalidated/changed sidecar does, (b) a corrupt
  move stream in any chunk is still rejected on open and cancellation still interrupts validation,
  (c) a filtered-out entry's move stream is not iterated by the loop.

### Decisions and trade-offs
Decided autonomously (full auto):
- Count storage: persisted column maintained by triggers (rejected: live correlated count — 1.3–5 s for
  an unfiltered sort and full scans when the user deletes the Games indexes; rejected: per-path
  application maintenance — ten paths and every future one must remember it).
- Count semantics: distinct games per player, Unknown excluded from the list (already excluded).
- Explorer pin per tab instead of mutating the global reference database (rejected: silently changing
  Felix's reference DB for every other tab).
- Accounts card keeps the old OpeningsPanel (Felix's replace decision concerned the database player
  view; Accounts aggregates several online accounts and has no single local player id).
- Game click = preview inside the card, double-click/Open = analysis tab (matches what was promised).

### Risks / open questions
- Trigger overhead during conversion of a large PGN; measured in phase 1, mitigated per O1 if material.
- Migration of the 3 GB database runs on first open (~3–10 s) inside a transaction; must keep existing
  progress/locking behaviour of connection acquisition.
- Explorer search over 11M sidecar entries per move click; reused unchanged, cached natively per query.

### Not part of this task
Accounts personal card behaviour; ChessBase-style tree for the online explorers; repertoire export;
changing the 500-game native cap; player deduplication across spellings.

### Phases
1. Backend (O1, O2 backend, O3 native extension): `src-tauri/src/db/create.sql`, `migrations.rs`,
   `mod.rs` (Player model, PlayerSort, get_players), `search.rs`, schema/model files, tests incl. the
   ignored benchmark; regenerate bindings (`pnpm bindings:generate`); minimal TS adaptations so the tree
   typechecks with the new binding fields. Role: sensitive (src-tauri/src/db/**).
   PROOF: `PATH="$HOME/.cargo/bin:$PATH" cargo test --manifest-path src-tauri/Cargo.toml --locked --bins -- db::`,
   `pnpm bindings:check`, `pnpm exec tsgo --noEmit`, and the ignored benchmark against the migrated
   Mega copy with indexes deleted (orchestrator supplies the copy path).
2. Frontend list + shared explorer request + per-tab database pin (O2 frontend, O3 renderer, O5 pin in
   the Database panel and its atom/cleanup): `PlayerTable.tsx`, `state/store/database.ts`,
   `src/utils/db.ts`, `panels/database/**`, `state/atoms.ts`, new shared hook, tests, translations
   (`pnpm i18n:extract`). Phase 2 owns every `DatabasePanel.tsx` change (R2-2).
   Role: sensitive (src/state/**).
   PROOF: `pnpm exec tsgo --noEmit`, `pnpm exec vitest related --run <changed paths>`, `pnpm lint:ci`.
3. Opening tree + Prepare on board (O4, O5 button and tab creation using phase 2's pin): new
   opening-tree component(s) under `src/components/databases/`, `PersonalCard.tsx`, `PlayerCard.tsx`,
   `utils/tabs.ts` as needed, translations, unit/integration tests, e2e spec. Does not modify
   `DatabasePanel.tsx`. Role: sensitive (src/state/** via tab creation).
   PROOF: `pnpm exec tsgo --noEmit`, `pnpm exec vitest related --run <changed paths>`, `pnpm lint:ci`,
   and the new e2e cases through the container runner (`pnpm test:e2e:container` filtered to the new
   cases).
4. Player-filtered search performance (O6): `src-tauri/src/db/search.rs`, `src-tauri/src/db/search_index.rs`,
   `src-tauri/src/main.rs` (search cache owner; the existing mapping lookup is test-only at ~401-407 and
   becomes the production lookup used by O6(a)) (+ tests). Role: sensitive.
   PROOF: `cargo test --manifest-path src-tauri/Cargo.toml --locked --bins -- db::search::` AND
   `... -- db::search_index::` (incl. the existing corruption checks and the new validation, cancellation
   and reuse cases), `cargo clippy --all-targets --locked -D warnings`, and a release-mode timing of a
   Kobert-filtered exact-position query on the migrated Mega copy (real-app driver).

### Reviews
### Round 1 (plan-r1) — lenses: plan, minimalism, correctness, tests, error-handling, pgn-index, ipc-contract, persisted-state, chess-semantics
Verdicts: plan REVISE, correctness REVISE, ipc-contract REVISE, pgn-index REVISE, tests REVISE; minimalism, persisted-state, chess-semantics, error-handling APPROVED (error-handling with one should-fix).
- R1-1 [blocker] Unknown-result games excluded by native search (`search.rs:899`) so tree/list miss games. Witnesses: plan#1, correctness#1, ipc-contract#1, pgn-index#1. Verified at search.rs:899-903. Disposition: Fix — O3 native `include_unknown_results` + `unknown` bucket; O4 uses it. MANDATE: "references to the games that he played in the position".
- R1-2 [blocker/should-fix] 500-game sample chosen by Elo, date-sorted list wrong. Witnesses: correctness#2, pgn-index#2, plan#5. Verified search.rs:810-814, 936-945. Disposition: Fix — O3 `sample_order` date applied before cap.
- R1-3 [should-fix] `"*"` move row not appendable. Witness: plan#4. Verified search.rs:596. Disposition: Fix — O4 terminal row.
- R1-4 [should-fix] Prepare failure semantics undefined. Witness: error-handling#1. Disposition: Fix — O5 failure semantics.
- R1-5 [blocker/should-fix] Missing proofs: browser/e2e for O4/O5, indexes-deleted performance, sort/hydration, shared-request ownership, Prepare integration. Witnesses: plan#2, plan#3, tests#1-5. Disposition: Fix — proofs added to O1-O5, phases split into three.
Authority (R2-3) for round-1 corrections: R1-1, R1-2 — MANDATE "an opening tree with always references to the games that he played in the position" (all games, most relevant first for preparation). R1-3 — MANDATE "click through the opening tree" (only real continuations are clickable). R1-4 — MANDATE item (3) Prepare on board; failure path required by .claude/rules/async-resource-invariants.md "an error path". R1-5 — verification level required by the build skill (UI phase proofs automated, real-app verify-ui) and MANDATE performance on Felix's Mega Database ("the number of games in the database shown when I look for a player").
Source traces: R1-4 `src/utils/tabs.ts:541-561` runTabCreation/createTab return null on refusal, `src/components/files/notifyError.ts:14` notifyUnlessCancelled. R1-5 `vite.config.ts:72` Vitest excludes e2e; `DatabasePanel.tsx:189` global override.

### Round 2 (plan-r2) — lenses: plan, correctness, ipc-contract, pgn-index, error-handling, tests
Closures: R1-1 CLOSED (correctness, ipc-contract, pgn-index, plan); R1-2 CLOSED (correctness, pgn-index, plan); R1-3 CLOSED (plan); R1-4 CLOSED (error-handling, plan). R1-5 CLOSED by tests, NOT CLOSED by plan (Prepare outcome: orientation + mainline, browser Prepare). Verdicts: plan REVISE, correctness REVISE, ipc-contract/pgn-index/error-handling/tests APPROVED.
- R1-5 (residual, lineage R1-5) Fix — O5 proof asserts mainline + orientation; Playwright exercises Prepare.
- R2-1 [blocker] unknown-only row 0/0 score. Witnesses: correctness#1, plan#2. Verified `ResultsChart.tsx:20` divides by scored total. Fix — O4 unavailable score. Authority: correction-created by R1-1 (Follow-up of R1-1).
- R2-2 [should-fix] phases 2 and 3 both touch DatabasePanel. Witness: plan#3. Fix — pin moved to phase 2.
- R2-3 [should-fix] Authority entries missing. Witness: plan#4. Fix — Authority/source-trace lines above.
- R2-4 [should-fix] no native-boundary assertion of new query fields. Witness: tests#1. Fix — O4 proof.
- R2-5 [should-fix] no score assertion for both colours / denominator. Witness: tests#2. Fix — O4 proof.

### Round 3 (plan-r3) — lenses: plan, correctness, tests
Closures: R1-5 CLOSED (plan, tests); R2-1 CLOSED (correctness, plan); R2-2, R2-3 CLOSED (plan); R2-4, R2-5 CLOSED (plan, tests). Verdicts: all APPROVED.
- R3-1 [should-fix, record-only] correction packet lacked source traces for R2-4/R2-5. Witness: plan#7. Disposition: Fix (record, arbiter-closed, no obligation change) — traces: R2-4 `src/utils/db.ts:416-430` builds the native query from LocalOptions, so dropped fields escape component mocks; R2-5 `src/components/home/PersonalCardPanels/ResultsChart.tsx:20` divides by the scored total. closed_round: arbiter.
Plan review complete: rounds r1=5 issues (13 lens findings adopted), r2=6 issues (7 findings), r3=1 record-only.

### Round 4 (plan-r4) — O6 amendment — lenses: plan, pgn-index, correctness
Verdicts: all REVISE.
- R4-1 [blocker] O6 missed per-query full validation in the index loader (`open_valid_preferred` → `open_file_inner`, search_index.rs:725) before metadata filters and cache lookup. Witnesses: plan#1, pgn-index#1, correctness#1. Verified search.rs:228-238 (open before cache), search_index.rs:725-745 (sequential validation). Disposition: Fix — O6 rewritten as (a) cache reuse by identity, (b) parallel open-time validation, (c) metadata filters first; phase 4 includes search_index.rs. Corruption semantics now unchanged, so the previously proposed semantic consequence is withdrawn.
- R4-2 [should-fix] Authority for the changed corrupt-stream behaviour missing. Witness: plan#2. Disposition: Fix by withdrawal — the rewrite keeps corruption behaviour unchanged, so no new authority is needed. Authority for O6 itself: threat model "Performance on the 11M-game database is a correctness requirement for this feature" and MANDATE "an opening tree ... when I click through the opening tree".

### Round 5 (plan-r5) — lenses: plan, pgn-index, correctness
Closures: R4-1 CLOSED (plan, pgn-index, correctness); R4-2 CLOSED (plan, pgn-index). Verdicts: plan REVISE, pgn-index APPROVED, correctness APPROVED.
- R5-1 [should-fix] phase 4 omits src-tauri/src/main.rs (cache owner, test-only lookup at main.rs:401-407). Witness: plan#3. Fix — added to phase 4 scope.
- R5-2 [blocker] phase 4 proof runs only db::search::, excluding db::search_index:: corruption tests. Witness: plan#4. Fix — proof runs both modules plus new cases.

### Round 6 (plan-r6) — lens: plan
R5-1 CLOSED, R5-2 CLOSED. VERDICT APPROVED. Plan review for O6 complete.

## Diff review (cumulative range 9cd8158a..HEAD, records lens for tasks/decisions.md)

### Round d1 — lenses: correctness, root-cause, code-quality, minimalism, tests, error-handling, pgn-index, ipc-contract, persisted-state, chess-semantics (+ records lens)
APPROVED: root-cause, error-handling, ipc-contract, chess-semantics, records (benchmark timings noted as run-log evidence). REVISE: correctness, code-quality, minimalism, persisted-state, pgn-index; tests APPROVED with one should-fix.
- D1 [blocker] code-quality: `validate_player_game_counts` validates schema only. Fix — renamed `validate_player_game_count_schema` (5d11da8f).
- D2 [should-fix] code-quality: `phase_one_tests.rs` named after the build phase. Fix — `player_game_count_tests.rs` (5d11da8f).
- D3 [blocker] correctness: Prepare preset carried `include_unknown_results`/`sample_order` into the board panel, whose OpeningsTable ignores the unknown bucket (NaN%). Verified OpeningsTable.tsx:88. Fix — preset only path/fen/type/player/colour/result (3bfaccea).
- D4 [blocker] persisted-state: database-local player id kept across database switches. Fix r1 (3bfaccea) selector clearing; reopened in d2 (unpinned tabs share the global reference); Fix r2 (17bf270c) `player_database` ownership; repair-created D8 in d3; second reopening → mechanism note + focused review-plan judgment (mechanism A: one shared effective-player derivation against the searched database for the query, the options control and the facade; ownerless selections not applied); Fix r3 (88b504c8). CLOSED in d4 (persisted-state, correctness, tests); D4 still holds.
- D5 [blocker] pgn-index: "????.??.??" ranked above known dates in date sampling. Fix — unknown dates last, '?' lowest, before the cap and in SQL order (5d11da8f); cap-crossing test (38be56d9, R2-T).
- D6 [should-fix] minimalism: `playerOpeningLine` duplicated `makeMove`/`getMoveText`. Fix — reuse (3bfaccea).
- D7 [should-fix] tests: PlayerTable mock ignored `sortable`/`sortStatus`. Fix (3bfaccea).
### Round d2 (closure, 5c750b15..3bfaccea) — D1, D2, D3, D5, D6, D7 CLOSED; D4 NOT CLOSED; R2-T [should-fix] partial-date heap normalisation untested across the cap → Fix (38be56d9).
### Round d3 (closure, 3bfaccea..17bf270c) — D4, R2-T CLOSED; D8 [blocker/should-fix] (correctness, persisted-state) options control displayed the other database's player → mechanism judgment (above), Fix 88b504c8.
### Round d4 (closure, 17bf270c..88b504c8) — D8 CLOSED (persisted-state, correctness, tests).
### Phase 4 (O6, added after real-app evidence: ~57 s per tree click on Mega Database 2025) — plan rounds r4–r6 above; commit 50fdcc36.
### Round d5 (50fdcc36) — correctness, root-cause, pgn-index, error-handling, tests, code-quality, minimalism, ipc-contract: all APPROVED; adopted T1/T2 (tests) and N1 (code-quality nit) → Fix b9c427e2.
### Round d6 (closure, 50fdcc36..b9c427e2) — T1, T2, N1 CLOSED (tests, correctness, code-quality). Review complete.

## Verification
- Real app (`scripts/app-driver.mjs` harness, release build of 50fdcc36, throwaway profile seeded with a 2.1.0 copy of Mega Database 2025): 9/9 checks passed — library lists the database after the one-time 2.2.0 migration (62 s, "Loading games databases…"), Players Games column, Games sort over 467,610 players (BYE 11,322, Nakamura 9,999, Carlsen 7,822), Kobert, Hans = 6 games, opening tree White (first open 31 s incl. one-time search-index generation), move click 0.5 s with games list, game preview, Black side 0.5 s, Prepare on board → analysis tab on Database › Local › Mega Database 2025 › Stats.
- Before phase 4 the same run measured 57 s per tree click (log retained in the run directory).
- Unit/integration: Vitest related suites; Rust db:: 822 passed; container e2e opening-tree cases at 1920 px and 320 px.

## Open limits
- The one-time migration of a large database shows only "Loading games databases…" for about a minute.
