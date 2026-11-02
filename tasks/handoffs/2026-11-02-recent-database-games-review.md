# Review record: database games in Recent Files (build, 2026-11-02)

Durable review history for the build that lists database games in the dashboard's Recent Files
(Felix, 2026-11-02: "I recently opened a game and analyzed it from my games, here the first one.
But this doesn't appear in my recently opened files at the dashboard. Why not?" — approved
proposal: "Yes, this is very good. Build this full auto executor codex."). The plan file lived in
the ignored `tasks/plans/2026-11-02-recent-database-games.md`; its MANDATE, approach and full
plan-review record are copied below. Executor: Codex (OpenAI high tier for review-plan, read and
sensitive write leaves; low tier for the mechanical fix leaf); orchestrator and arbiter: Claude
Code (Opus). Plan authorship and arbitration shared one context; detection ran on a different model
family (Codex). Linked-game identity: decision d-20261102-05.

## Plan (final reviewed revision, r7, with the two orchestrator proof/spec notes)

### Goal

A game opened from a database view appears in the New Tab dashboard's Recent Files list and
reopens from there, with the same lifetime rules as recent PGN files.

### MANDATE

Felix, 2026-11-02, asking why a game opened and analysed from "Meine Partien" does not appear under
Recent Files: "I recently opened a game and analyzed it from my games, here the first one. But this
doesn't appear in my recently opened files at the dashboard. Why not?"

Approved proposal (Felix: "Yes, this is very good. Build this full auto executor codex."):
database games appear in Recent Files, shown as "White – Black" with a game icon and the database
name as context; clicking the entry opens that exact game again; entries disappear when the game or
the database no longer exists, the same way missing files disappear today.

### Threat model and non-goals

Single local user. Inputs are the user's own SQLite databases and the renderer's own persisted
`recent-files` localStorage value, which may be absent, corrupt, from the older file-only shape, or
name a database/game that was since deleted, moved or revoked. No adversarial input. A downgrade to
an older app build that cannot parse the new entry shape is out of scope (local install only moves
forward from `master`).

### Traced premises

- `src/state/atoms.ts:601-633` — `RecentFile` holds only `FileWorkspaceHandle`; schema
  `recentFileSchema`, key `"recent-files"` in localStorage via `createZodStorage`, cap 10, dedupe by
  `fileWorkspaceKey`.
- `src/utils/files.ts:170` and `src/components/tabs/ImportModal.tsx:179` are the only writers
  (`addRecentFileAtom`).
- Database games open through `createTab({...databaseGameSeed(game, db), setTabs})` inside
  `runTabCreation` at `src/components/databases/GameTable.tsx:75` (library database view, where
  "Meine Partien" lives), `src/components/databases/TournamentCard.tsx:167`,
  `src/components/panels/database/GamesTable.tsx:47` (analysis database panel; handle may be `null`
  for online games), `src/components/common/GameReference.tsx:52`.
- `src/utils/tabs.ts:533` `runTabCreation` calls `onSuccess(id)` only for an admitted tab;
  `src/utils/tabs.ts:573` `createTab` resolves a linked locator into a file origin.
- `src-tauri/src/db/mod.rs:1889,1969,2193` — `get_games` / `get_games_blocking` /
  `normalize_games`; `GameQuery` has no id filter; no single-game reader exists.
  `qualify_games` (`src-tauri/src/db/linked_collections.rs:3222`) fills `NormalizedGame.linked`;
  a stale/absent locator is rejected by linked resolution (`linked_collections.rs:3536`).
- Games table `ID INTEGER PRIMARY KEY AUTOINCREMENT` (`src-tauri/src/db/create.sql:23`): ids are not
  reused after deletion. But a linked-collection database is rebuilt on any source change:
  `src-tauri/src/db/linked_collections.rs:2364` runs `DELETE FROM Games` and reinserts every game,
  writing `LinkedSource(GameID, Ordinal, Stamp)` per game (`:2387`), so game ids of a linked
  collection change while the games still exist. `LinkedGameLocator = { collection, generation,
  ordinal, stamp }`; `stamp` is the content stamp of the game's source bytes.
- In-app database deletion removes the capability (`src-tauri/src/db/mod.rs:3192`,
  `remove_database`); a later read fails in `persistent_entry_for` with
  `InvalidInput("workspace entry is not persistent")` (`src-tauri/src/infra/path_authority/mod.rs:9606`),
  which the renderer sees as `validation`, not `not-found`.
- Missing database file → backend `missing-resource` → renderer `normalizeError(...).category ===
  "not-found"` (`src-tauri/src/error.rs:538`, `src/platform/errors.ts:63`); revoked/unknown handle →
  `validation`.
- `src/state/pathOwners.ts:112` — recentFiles owner family validates every entry as
  `{ handle: fileWorkspaceHandleSchema }` and retains `handle.id`.
  `src-tauri/src/infra/path_authority/mod.rs:2791` — `EntryPurpose::DatabaseFile` owner families are
  `ReferenceDatabase, SessionWorkspace, DatabaseView` (no `RecentFiles`).
- `src/components/tabs/NewTabHome.tsx` keys rows and practice decks by `fileWorkspaceKey`, prunes on
  mount via `countPgnGames`, reopens via `openFile`.
- `src/platform/tauri.ts:118,161,402` — native read commands are listed in `NativeReadCommandName` /
  `NATIVE_READ_ARITY`; `scripts/check-ipc-command-consumers.mjs` requires a production consumer.
- `src/utils/pathCapabilities.ts:36` exports `databaseHandleSchema`; `src/utils/db.ts:123`
  exports `databaseHandleKey`.

### Approach

#### O1 — Recent entry model (persisted)

The persisted list becomes a union of two entry kinds:

- **file entry** — exactly the existing shape `{ name, handle, type, lastOpened }`, no new field,
  so every stored value of the old shape still parses unchanged and round-trips byte-equal (the
  `pathOwners` collector requires `equal(read.value, parsed.data)`).
- **database game entry** — `{ kind: "database", name, database: DatabaseHandle, gameId: number,
  linked?: { locator: LinkedGameLocator, signature: GameSignature }, databaseTitle?: string,
  lastOpened }`. `linked` is present when the game came from a linked collection: its last locator
  (reuse the exported `linkedGameLocatorSchema`) and its header signature `GameSignature = { white,
  black, event, site, date, round }` as the index stores them (`NormalizedGame` fields; `date` and
  `round` nullable). `name` is the `"<white> - <black>"` label that
  `databaseGameSeed` already uses for the tab. `databaseTitle` is the database's display title
  captured at open time when the opening surface knows it.

One identity function gives each entry its dedupe/React key: file entries keep `fileWorkspaceKey`;
database entries use a key built from `databaseHandleKey(database)` plus, for a linked game, the
locator's `collection` and an unambiguous encoding of the signature after the O3 absent-marker
normalization (so `null` and `"?"` produce the same key),
otherwise the `gameId` — never a key that changes when a linked collection is rebuilt or a linked
game is saved, and never one that can collide with a file key. Distinct linked games sharing all six
signature fields intentionally share one recent entry.
`addRecentFileAtom` dedupes and caps (10) on that key across both kinds, and every update of an
existing entry (O5 refresh) re-applies the same dedupe (most recent `lastOpened` wins) so the list
never holds two entries with one key; the old
file-only callers keep working unchanged. Absent/corrupt values keep falling back to `[]` through
`createZodStorage` (existing behaviour).

#### O2 — Startup path ownership

`collectOriginalSnapshots` in `src/state/pathOwners.ts` parses the recentFiles family with the same
union and retains `handle.id` for file entries and `database.id` for database entries. A value that
fails to parse keeps the family untrusted (existing behaviour). In Rust,
`owner_families_for_purpose(EntryPurpose::DatabaseFile)` gains `PathOwnerFamily::RecentFiles`, so an
unreadable recent-files value protects database capabilities from the startup sweep the same way it
already protects PGN files. No other path-authority change.

#### O3 — Read one database game by id

New Specta command `get_db_game(file: DatabaseHandle, game_id: i32, linked:
Option<LinkedGameIdentity>, ticket)` (`LinkedGameIdentity = { locator, signature }`, Specta-exported, the
same shape the entry persists) returning `Result<DbGameLookup, Error>` where `DbGameLookup` is a
Specta-exported tagged union `found { game: NormalizedGame } | missing`. It mirrors `get_games`: `native_read_operation`,
`run_native_operation`, exactly one `BLOCKING_GATEWAY.spawn_cancellable`, `resolve_database(...,
DatabaseRead)` → `get_db_or_create` → joined query filtered by `games::id` → `normalize_games` →
`qualify_games`, so a linked-collection game comes back with a fresh locator. The joined
select/normalize/qualify path is shared with `get_games_blocking` rather than copied (rule 11).

Identity across a linked rebuild: a linked collection's index is rebuilt from its source PGN on
every source change with new ids and re-enumerated ordinals (`linked_collections.rs:2364-2390`), and
the content `stamp` changes on every save and on appends (`pgn.rs:858-862,1242`), so none of id,
ordinal or stamp identifies the game. A linked game is identified by its header signature
(`white, black, event, site, date, round`) within the same collection. Both the stored signature and
every candidate's signature pass through one normalization before comparison: the raw index values
(Event/Site keep their PGN escapes, as `NormalizedGame` carries them), with absent markers folded
together — `null`, empty, `"?"`, for `white`/`black`/`event`/`site` also the index's id-0 sentinel
name `"Unknown"` (`db/migrations.rs:219-221`: an absent tag is stored as the sentinel row), and for
`date` `"????.??.??"` all mean absent — because the
renderer's serializer writes `"?"`/`"????.??.??"` for tags a source game never had
(`src/utils/chess.ts:186-191,563`) while the index stores them as `null` (`db/mod.rs:538-547`).
Otherwise values compare exactly. The renderer applies the same normalization rule for the O1 dedupe
key (one renderer helper; the Rust and TypeScript implementations share one table of test cases). When `linked` is supplied and the database belongs to that
collection, `get_db_game` selects the games whose full signature matches; among them it prefers the
stored stamp, otherwise the nearest stored ordinal, ties to the lower ordinal; it never falls back
outside the signature; no match → `missing`. The stored `game_id` is used only when no linked
identity is supplied or the database is not linked. The returned game carries its current id and
locator. Accepted consequences (decisions d-20261102-05 and its correction d-20261102-06): editing one of the six
tags of the remembered game drops its entry; if another game in the collection has the identical
full signature, reopening may select that game, including after the remembered one was removed.

`missing` is returned exactly when the target definitively no longer exists: no game row (no row with that id, or,
for a linked identity, no game in the collection with the full signature); the database capability is no longer held by the path
authority (deleted in the app, or swept at startup); or the database file is absent on disk. The
lookup never creates a database file for an absent path. *(Superseded in implementation by D1-1
below: the absent-file rule applies to ordinary databases; a linked collection's lost disposable
cache is rebuilt by collection resolution, and its game is missing only when the source or the game
is gone.)* Every other failure (busy, cancelled, I/O
other than absence, corrupt database) stays an error. Registered
in `collect_commands!`, bindings regenerated, exposed through `src/platform/tauri.ts` as a native
read with arity 3 (`database`, `gameId`, `linked` — `linked` passed as `null` when absent, never
omitted; abort signal → ticket).

#### O4 — One database-game opener that records the recent entry

A single renderer function (in `src/utils/databaseGame.ts`) opens a database game:
`createTab({...databaseGameSeed(game, database), setTabs})`, and only when the returned tab id is
non-null and `database` is non-null records a database recent entry (name, handle, `game.id`,
and, when `game.linked` is present, `{ locator: game.linked, signature }` taken from the game's
white/black/event/site/date/round, optional `databaseTitle`). All four call sites route through it and pass the database title where
their surface has it (GameTable and TournamentCard: `DatabaseViewStateContext` database `title`;
GameReference: the occurrence's database label if it is the title; GamesTable: the title if the
analysis panel has it, otherwise omitted). Their existing `runTabCreation` error/success handling
stays. Online games (no database handle) record nothing.

#### O5 — Dashboard rows, reopen and pruning

`NewTabHome`:
- Row: database entries show the game icon (`FileIcon type="game"`), the stored name, and the
  database title as dimmed secondary text when present; time column unchanged. File rows unchanged.
- Open: a database entry calls `getDbGame(database, gameId, linked)`; `found` → the O4 opener with
  the returned game (which bumps the entry to the top and stores the game's current id and locator)
  and `navigate({ to: "/" })`; `missing` → remove the entry and show a notification; an error →
  keep the entry and show the existing error notification.
- Mount-time pruning: database entries are checked with `getDbGame` under the existing
  AbortController; `missing` removes the entry, a `found` whose id or locator differs from the stored
  one updates the stored `gameId`/`linked` (then the O1 dedupe), every error keeps the entry. File entries keep
  `countPgnGames`.
- Practice deck rows and "Due for practice" stay file-only (`type === "repertoire"` file entries).

#### O6 — Verification

Rust unit tests for `get_db_game`: existing id → `found` with the game equal to the `get_games` row;
missing id → `missing`; database deleted through `delete_database` → `missing`; database file removed
on disk → `missing` and no file created; linked collection: open game, append another game to the
source PGN directly after it (forcing the rebuild and changing its separator bytes and stamp),
lookup with the old id and identity → `found` with the same game (assert its content), its new id and
a fresh locator; the game saved with a new comment and with a changed move → `found`; an earlier
game removed → `found`; in [A, B, C] with distinct signatures, B removed while A and C survive →
`missing` (never C); a game without Round/Site/Date tags saved once through the renderer serializer (now carrying
`"?"`/`"????.??.??"`) → `found`; a signature tag of the remembered game edited → `missing`; two games with an
identical signature → selection by stamp, then nearest ordinal. Plus the
owner-family change. Vitest: atoms schema parses old file-only values unchanged and the
union; dedupe/cap across kinds; pathOwners retains database ids and stays trusted with mixed
entries; opener records only on admitted tabs, never for a null database, and records `game.linked` with the signature taken from the raw `NormalizedGame` fields (assert
an escaped Event/Site value is stored unescaped-not-decoded, i.e. exactly as received, and a
`null` date/round stays absent); the
facade forwards `getDbGame(database, id, identity)` and `getDbGame(database, id, null, { signal })`
with the identity in the third native argument; NewTabHome passes the stored identity on open and
prune, reopening a linked game whose id changed leaves exactly one entry, reopening a tagless linked game
after a save (placeholders now present) leaves exactly one entry, and two linked games with
different signatures keep separate entries after an earlier game's removal shifts their ordinals; an integration test that
opening a game through `GameTable` (the "Meine Partien" surface) records a recent entry with that
database handle and exact game id, and each other call site's existing suite (where one exists)
asserts the same; NewTabHome renders, opens and prunes database entries (`missing` removed, error
kept, changed id updated). `e2e/workspace-tabs.spec.ts`
home layout injection gains a database entry so the screenshots cover the new row. Browser
verification of the dashboard per verify-ui.

### Decisions and trade-offs

- Old file entries keep their exact shape (no `kind` backfill) so stored values and the owner
  collector's round-trip equality stay valid without a migration.
- Reopen fetches the game fresh instead of persisting PGN in localStorage: no stale moves, no quota
  growth, and linked locators are re-qualified.
- Pruning reuses `getDbGame` (decodes ≤10 games on dashboard mount, negligible) instead of a second
  existence command.
- Linked-game identity is the header signature (O3). Considered and rejected: game id (changes on
  every rebuild), stamp (changes on save/append), ordinal (a removed game's neighbour takes its
  place), a durable source-carried occurrence id (no such id exists for arbitrary PGN; adding one is
  a separate, much larger identity project). Recorded as d-20261102-05.
- `databaseTitle` is captured at open time; a later rename of the database shows the old title until
  the game is opened again. Accepted.

### Risks / open questions

- GamesTable (analysis panel) may not know the database title; the row then shows no context line.

### Not part of this task

Recording games opened from other surfaces (play, puzzles, imports into a database), immediate
removal on delete (mount-time pruning covers it), recents for online games, changes to the
"Due for practice" panel.

### Phases

#### Phase 1 — Database games in Recent Files (O1–O6)

One phase: the persisted union, its dashboard consumer, the new command and its only consumer are
mutually dependent (the contract gate's `ipc:consumers:check` refuses a command without a production
consumer, and splitting the union from `NewTabHome` would need throwaway narrowing).

Files: `src/state/atoms.ts`, `src/state/pathOwners.ts`, `src/state/pathOwners.test.ts`, atoms tests,
`src-tauri/src/infra/path_authority/mod.rs` (owner family + test), `src-tauri/src/db/mod.rs`,
`src-tauri/src/db/linked_collections.rs` (linked identity lookup) and their test modules,
`src-tauri/src/main.rs`, `src/bindings/generated.ts` (regenerated only), `src/platform/tauri.ts`,
`src/utils/databaseGame.ts` (+ test), the four call sites (+ their tests), 
`src/components/tabs/NewTabHome.tsx` (+ test), `e2e/workspace-tabs.spec.ts`, translation catalogs
only for an unavoidable new string (then `pnpm i18n:extract` and every locale).
Sensitive (src/state/**, src-tauri/src/db/**, src-tauri/src/infra/**, main.rs, bindings).
Role: sensitive.
PROOF COMMAND:
`pnpm build-vite && cargo test --manifest-path src-tauri/Cargo.toml --bin chessfable db:: && cargo test --manifest-path src-tauri/Cargo.toml --bin chessfable path_authority && pnpm bindings:generate && pnpm bindings:check && pnpm exec tsgo --noEmit && pnpm exec vitest run src/state/pathOwners.test.ts src/state/atoms && pnpm exec vitest related --run src/state/atoms.ts src/utils/databaseGame.ts src/components/tabs/NewTabHome.tsx src/components/databases/GameTable.tsx src/components/databases/TournamentCard.tsx src/components/panels/database/GamesTable.tsx src/components/common/GameReference.tsx src/platform/tauri.ts && pnpm ipc:consumers:check && pnpm tauri:boundary:check && pnpm i18n:check`

### Reviews

#### Round 1 (plan-r1) — 9 lenses

Verdicts: plan REVISE, correctness REVISE, tests REVISE, error-handling APPROVED (1 should-fix),
minimalism APPROVED, persisted-state APPROVED, ipc-contract APPROVED, pgn-index APPROVED,
tauri-security APPROVED.

- **R1-1** [blocker] Linked-collection game ids change on every source rebuild
  (`linked_collections.rs:2364` `DELETE FROM Games` + reinsert), so a handle+id entry for an
  unchanged linked game is pruned. Witnesses: plan#1 (r1), correctness#1 (r1). Verified at
  `linked_collections.rs:2364-2390`. Obligation: MANDATE "clicking the entry opens that exact game
  again; entries disappear when the game … no longer exists". **Fix** — O1 persists `linked`; O3
  resolves linked games by stored stamp/ordinal through `LinkedSource`, returns current id; O5
  refreshes the stored id; O6 rebuild regression. Closure pending r2.
- **R1-2** [blocker] In-app database deletion makes reads fail as `validation`
  (`persistent_entry_for`, `path_authority/mod.rs:9606`), so pruning on `not-found` only keeps dead
  entries forever. Witnesses: plan#2 (r1), error-handling#1 (r1). Verified at `db/mod.rs:3192`,
  `path_authority/mod.rs:9606`. Obligation: MANDATE "entries disappear when … the database no
  longer exists". **Fix** — O3 returns a typed `found | missing` lookup, `missing` for absent game,
  absent capability, absent file; O5 prunes on `missing` only; O6 deletion regression. Closure
  pending r2.
- **R1-3** [should-fix] Two phases both edit `NewTabHome.tsx` with throwaway narrowing.
  Witness: plan#3 (r1). **Fix** — single phase (the command/consumer coupling also forces it).
  Closure pending r2.
- **R1-4** [blocker] No assertion that a database opening surface records the recent entry.
  Witness: tests#1 (r1). Obligation: MANDATE (the reported failure itself). **Fix** — O6 requires a
  GameTable integration test asserting handle + exact game id recorded, and the other sites' suites
  where present. Closure pending r2.

Round-1 adoptions: 4.

#### Round 2 (plan-r2) — 7 lenses (plan, correctness, error-handling, tests, pgn-index, ipc-contract, persisted-state)

Verdicts: plan REVISE, correctness REVISE, ipc-contract REVISE, persisted-state REVISE, pgn-index
REVISE, error-handling APPROVED, tests APPROVED (1 should-fix).
Closed: R1-2 (plan, error-handling), R1-3 (plan), R1-4 (plan, tests). R1-1 CLOSED by correctness,
NOT CLOSED by plan → stays open as lineage R1-1.

- **R1-1 (lineage, reopened)** [blocker] The stamp is not a stable linked identity: an analysis save
  rewrites the game (`src/utils/tabs.ts:1191`, stamp `pgn.rs:1242`) and an append changes the
  previous game's trailing separator (`pgn.rs:858-862`). Witnesses: plan#1 (r2), persisted-state#2
  (r2), pgn-index#1 (r2). Verified: `pgn.rs:1242` hashes the range bytes. **Fix** — O3 identity is
  the ordinal (the app's existing file-game identity) with stamp only as tie-breaker, ordered
  lookup, known limit stated; O6 covers append-separator, in-place save, earlier removal.
  Authority: MANDATE "clicking the entry opens that exact game again; entries disappear when the
  game … no longer exists".
- **R2-1** [blocker] Native-read arity 2 drops the third argument `linked`
  (`src/platform/tauri.ts:402-405`). Witnesses: correctness#1, ipc-contract#1, plan#2 (r2).
  Verified at `tauri.ts:402`. **Fix** — arity 3, `null` when absent, O6 facade forwarding test.
  Authority: same MANDATE clause (reopen must find the game).
- **R2-2** [blocker] Dedupe on mutable `gameId` duplicates a linked entry after a rebuild.
  Witnesses: correctness#2, persisted-state#1, plan#3 (r2). **Fix** — O1 key uses collection +
  ordinal for linked entries, refresh re-dedupes; O6 single-entry assertion. Authority: MANDATE
  "database games appear in Recent Files" (one row per game, as for files).
- **R2-3** [should-fix] No assertion that `game.linked` is recorded and forwarded. Witness:
  tests#1 (r2). **Fix** — O6 assertions. Authority: R1-1 correction.
- **R2-4** [should-fix] Correction rows lacked Authority. Witness: plan#4 (r2). **Fix** — Authority
  lines added for R1-1, R2-1, R2-2 (R1-2 authority: MANDATE "entries disappear when … the database
  no longer exists"; R1-4: the reported failure in MANDATE).

Round-2 adoptions: 5.

#### Round 3 (plan-r3) — 6 lenses (plan, correctness, ipc-contract, persisted-state, pgn-index, tests)

Verdicts: plan REVISE, correctness REVISE, persisted-state REVISE, pgn-index REVISE, ipc-contract
APPROVED, tests APPROVED. Closed: R2-1 (plan, correctness, ipc-contract), R2-3 (plan, tests), R2-4
(plan). R2-2 CLOSED by correctness, NOT CLOSED by plan and persisted-state.

- **R1-1 (lineage, second failed closure)** [blocker] Ordinal fallback: in [A,B,C] deleting B makes
  C take ordinal 1, so the lookup opens C. Witnesses: plan#1, correctness#1, persisted-state#1,
  pgn-index#1 (r3). Verified: rebuild re-enumerates ordinals (`linked_collections.rs:2366,2389`).
- **R2-2 (lineage, NOT CLOSED)** [blocker] Ordinal in the dedupe key merges B and C after an earlier
  removal. Witnesses: plan#2, persisted-state#2 (r3).

#### Round 4 — focused fresh-context review-plan judgment (escalation, rule: second failed lineage closure)

Invariant: a linked recent entry reopens the same game across appends, saves and other removals,
disappears when the game is removed, never becomes another game, and dedupes cleanly. Previous
answers: id (r1), stamp (r2), ordinal (r3), each refuted above. New evidence (lens-plan-r4):
no inspected mechanism gives a durable per-occurrence identity for arbitrary linked PGN —
`LinkedGameLocator` fields, `provider_game_id` (provider URLs only, `linked_collections.rs:3318`),
the semantic fingerprint (includes moves, `:3357`), legacy identity evidence (`legacy.rs:55`), and
open file tabs (position only, `FileFreshnessGate.tsx:234,273`). It recommends the relaxed header
signature as the simple implementation, with explicit acceptance that identical full signatures
collapse and that tag edits drop the entry; a durable id would be a much larger identity project.
Judgment (orchestrator, technical): adopt the header signature. Two games of one source PGN with
identical White/Black/Event/Site/Date/Round are practically duplicates, so the collapse does not
change what Felix approved in substance; the existing file-tab identity is weaker (position only).
Changes: O1 entry `linked = { locator, signature }` and signature-based dedupe key; O3 signature
lookup with stamp/ordinal tie-break and no fallback outside the signature; O4 records the
signature; O5/facade forward the identity; O6 middle-game removal, move/comment saves, tag edit,
identical signatures, separate entries after ordinal shift. Decision recorded in
`tasks/decisions.md`. Raw findings r4: plan-judgment#1-#3 (blockers on the r3 text and the strict
guarantee), #4 (should-fix: no delta block — it was a focused judgment, closure follows in r5).

Round-3 adoptions: 2 (R1-1 lineage, R2-2 lineage). Round-4 adoptions: 3 (signature identity,
signature dedupe key, O6 coverage).

#### Round 5 (plan-r5) — 6 lenses (plan, correctness, persisted-state, pgn-index, tests, ipc-contract)

Verdicts: plan, correctness, persisted-state, ipc-contract, tests APPROVED (tests 1 should-fix);
pgn-index REVISE. Closed: R1-1 lineage (plan, correctness, persisted-state, pgn-index, ipc-contract),
R2-2 lineage (same five).

- **R5-1** [blocker] Exact signature breaks on an ordinary save of a game lacking Round/Site/Date:
  index stores `null` (`db/mod.rs:538-547`), the renderer serializer writes `"?"`/`"????.??.??"`
  (`src/utils/chess.ts:186-191,563`). Witness: pgn-index#1 (r5). Verified at both locations.
  **Fix** — O3 normalization folds absent markers on both sides; O6 save-of-tagless-game test.
  Authority: MANDATE "opens that exact game again" (game still exists).
- **R5-2** [should-fix] No assertion that the persisted signature uses the raw index values.
  Witness: tests#1 (r5). **Fix** — O6 opener assertion. Authority: R5-1 / R1-1 correction.

Round-5 adoptions: 2.

#### Round 6 (plan-r6) — 3 lenses (plan, pgn-index, tests)

Verdicts: pgn-index, tests APPROVED; plan REVISE. Closed: R5-1, R5-2 (all three).

- **R6-1** [blocker] The O1 dedupe key encoded the raw signature while lookup normalizes, so
  save-then-reopen of a tagless game yields a second entry. Witness: plan#1 (r6). **Fix** — O1 key
  uses the O3 normalization; renderer helper mirrors the rule with shared test cases; O6
  single-entry assertion. Authority: R2-2 correction / MANDATE (one row per game).

Round-6 adoptions: 1.

#### Round 7 (plan-r7) — 2 lenses (plan, persisted-state)

Verdicts: plan APPROVED, persisted-state APPROVED. Closed: R6-1 (both). No open issues.
Round-7 adoptions: 0.

Totals: rounds r1–r7 (r4 a focused judgment round). Adoptions r1=4 r2=5 r3=2 r4=3 r5=2 r6=1 r7=0.
Unique issues: R1-1..R1-4, R2-1..R2-4, R5-1, R5-2, R6-1 (11), all closed; R1-1 lineage needed the
rule-12a escalation (decision d-20261102-05).

Proof-command correction (orchestrator, 2026-11-02, after phase-1 attempt 1): `--lib` does not exist for this binary crate and a fresh worktree needs `pnpm build-vite` before any cargo build; semantics of the proof unchanged.

Spec clarification (orchestrator, 2026-11-02, phase-1 fix round 2): the index represents an absent White/Black/Event/Site tag as the id-0 sentinel row named "Unknown", so "Unknown" joins the absent markers for those four fields on both sides (same R5-1 obligation, technical detail; a real player/event literally named "Unknown" is treated as absent).

## Implementation and diff review

### Implementation

Phase 1 (one sensitive Codex write leaf, thread `01a19a75-74e1-71d0-953c-2aa94bcf2656`), two
proof-fix rounds: round 1 corrected the orchestrator's proof command (`--bin chessfable`, `pnpm
build-vite` first; no code defect); round 2 added the id-0 `"Unknown"` sentinel to the absent
markers (spec clarification, same R5-1 obligation) and repaired test fixtures. Commit `d1bb8cac`.
Pre-review then found `src/utils/gameSignature.ts` unmapped to a coverage area; instead of a coverage
scope change, a mechanical Codex fix leaf moved the helper to `src/state/gameSignature.ts` (covered
by the existing `src/state/**` glob), commit `895050b6`. (An interim local commit that edited
`coverage-areas.json` was made before checking the gate exit code and was undone before any push.)

### Cumulative diff review, round d1 (base `45172e57`, through `895050b6`, record paths excluded)

11 Codex lenses: correctness, root-cause, error-handling, tests, minimalism, code-quality,
persisted-state (capacity failure, same-route retry), ipc-contract, pgn-index, tauri-security,
platform-semantics. Verdicts: error-handling REVISE, code-quality REVISE; all others APPROVED
(tests and root-cause with should-fix findings).

- **D1-1** [blocker] error-handling#1: the pre-resolution file check returned `missing` for a
  linked collection whose disposable cache was lost, before `resolve_database` →
  `ensure_database` could rebuild it, so pruning dropped an existing game. Verified at
  `src-tauri/src/db/mod.rs` `resolve_database` (calls `ensure_database`). **Fix** — commit
  `6fa48bdf`: collections resolve first; regression test deletes the cache and expects `found`.
- **D1-2** [blocker-ranked, quality] code-quality#1: positional `i == 4` selected the normalization
  kind. **Fix** — `6fa48bdf`: named `SignatureField` → normalization-kind mapping shared by the Rust
  and SQL side.
- **D1-3** [should-fix] tests#1: signature rejection tested only via White. **Fix** — `6fa48bdf`:
  one case per remaining field.
- **D1-4** [should-fix] tests#2: no test that a rejected `not-found` error keeps an entry.
  **Fix** — `6fa48bdf`: pruning and click cases.
- **D1-5** [should-fix] root-cause#1: no failing-before evidence supplied. **Skip** — the GameTable
  integration assertion checks the recent entry the pre-change code never wrote (plan R1-4); the
  lens found the cause removed at all four surfaces.
- **D1-6** platform-semantics note: new lookup tests are Unix-gated, so Windows CI does not run
  them. **Skip** — a stated proof limit, not a defect; compile/clippy coverage stays.

### Closure round d2 (delta `895050b6..6fa48bdf`)

Lenses: error-handling, code-quality, tests, correctness, root-cause, pgn-index — all APPROVED.
D1-1 CLOSED (error-handling), D1-2 CLOSED (code-quality), D1-3 and D1-4 CLOSED (tests). No defect
introduced by the repair.

### Browser verification

`pnpm test:e2e:container --project=workspace-tabs` (Codex verify-ui leaf). First run: 14 passed,
1 failed — the home layout fixture had replaced the tenth file entry with the database entry,
leaving three repertoires where the due-list assertion expects four (fixture defect from phase 1;
the screenshot already showed the database row rendering correctly). Mechanical fix leaf: the
database entry takes the slot of a plain game entry (commit `3ae53dbb`). Rerun: 15 passed. The
desktop capture shows the database row with the knight icon, "White - Black", the dimmed database
title "Meine Partien" and the relative time, file and repertoire rows unchanged, four due
repertoires; the narrow capture shows both lists reachable at 600 × 500. No snapshot re-recorded.
Native GTK chrome is not involved. The real-window run (`pnpm verify:app`) was not extended for this
flow; the behaviour is covered by the Rust lookup tests, the GameTable integration test and the
dashboard tests.

### Closure round d3 (delta `6fa48bdf..3ae53dbb`, fixture only)

Lenses: tests, correctness — both APPROVED. The fixture keeps ten recents with the database row and
four repertoires (indices 0, 3, 6, 9); reverting the repair fails the four-due-row assertion. No
open review issue remains.

### Final-gate repairs after d3

- **Import cycle (commit 76875fba).** The first full `gates:push` (all lanes green except
  `frontend-coverage`, one 5150 ms timeout in `src/state/referenceCollection.test.ts`) led to
  `atoms.ts` importing `databaseHandleKey` from `@/utils/db`, which imports `@/state/atoms` back
  and pulls signed catalogs, SWR and i18n into every importer of atoms. The fix keys database
  recents with the identical `capabilityKey` from `pathCapabilities` (a fix leaf also replaced an
  existing type-only import with a duplicated alias; the orchestrator reverted that part).
  Closure round d4: correctness, code-quality — both APPROVED. Second full `gates:push`: every lane
  green, `frontend-coverage` 94 s (was 138 s).
- **Red master CI, Node 26 (commit 5ea1ae3b, finding f-20261102-03).** `pnpm ci:remote:check`
  refused the push: run 41404314781 on master `af981d98` ran Node 26 via `lts/*` and failed 1645
  frontend tests and every frontend-mutation dry run; `rust-macos-test` was a hosted-runner loss.
  Felix's question 2026-11-02 ("So what is the solution then? … nothing will go forward, right?")
  led this run to repair it instead of waiting for another session's uncommitted fix. Reproduced
  locally with a checksum-verified Node 26.13.0 (35/158 failures in two files); repaired by passing
  `--no-experimental-webstorage` to the Vitest workers when Node knows the flag. Node 26 full suite
  6000/6000; Node 24 previously failing files 207/207. Closure round d5: correctness, root-cause,
  tests — all APPROVED; tests should-fix (no local Stryker thread-pool execution proof) **Skip**:
  the hosted `frontend-mutation` jobs on the pushed SHA run that dry run on Node 26 and the push
  waits for their conclusions.
- **Load-sensitive reload tests (finding f-20261102-04).** Timeouts in reload-simulating tests
  recurred at load average 41–65; a temporary per-test timeout was reverted to keep this push's
  scope, and the class is filed.
- Records lens d4 corrections applied as annotations to f-20261102-03 and f-20261102-04 and this
  section.
