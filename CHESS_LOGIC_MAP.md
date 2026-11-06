# Chess Logic Map: ChessRiddle Studio 🥐

Architecture and navigation map for agents: where state lives, how the renderer reaches the Rust
side, how engine output is streamed, how games are stored, and which bottlenecks are still real.

This file is the *only* architecture map in the repository. It replaced `OPUS_HANDOVER.md` on
2026-08-29; that file described the pre-audit tree (an `AppState` full of bare `DashMap`s, engine
logs that grew without a bound) and had drifted far enough to mislead. Verify against the source
before trusting any line here, and correct the line rather than writing a third map.

## 1. Backend state

`AppState` — `src-tauri/src/main.rs:381`, registered at `main.rs:1366` via `.manage(AppState { … })`.
It holds no bare collections; each concern is behind a type that owns its own cleanup:

| Field | Type | Owns |
| --- | --- | --- |
| `database_repository` | `Arc<db::DatabaseRepository>` | Diesel/r2d2 SQLite pools |
| `search_cache` | `SearchCache` | position-search results |
| `pgn_repository` | `pgn::PgnRepository` | the cached byte-offset index over PGN files |
| `pgn_path_authority` | `infra::path_authority::SharedPathAuthority` | PGN path grants and the linked collection service |
| `engine_supervisor` | `EngineSupervisor` | UCI child processes and their lifetimes |
| `auth` | `Arc<AuthLifecycle>` | OAuth flow state |
| `credentials` | `Arc<CredentialManager>` | tokens, in the OS keyring — never in the renderer |
| `game_manager` | `Arc<GameManager>` | active games |
| `progress_state` | `progress::ProgressStore` | background-task progress |
| `puzzle_cache` | `Arc<Mutex<PuzzleCache>>` | puzzle sets |
| `http_transport` | `Arc<dyn infra::net::DownloadTransport>` | outbound HTTP, swappable in tests |
| `download_registry` | `Arc<fs::DownloadRegistry>` | in-flight downloads |

`sound::SoundServerPort` and `sound::SoundShutdownTx` are managed separately (`main.rs:1328-1353`),
because the local sound server (Linux) may fail to bind and the app must still start.

Modules: `chess` (engine analysis commands), `engine/{process,types,uci}` (UCI supervision),
`db/{mod,search,repository,ops,encoding,search_index,models,schema,migrations}`, `game` (active game
lifecycle), `pgn` + `lexer` (parsing and the offset index), `opening`, `puzzle`, `fs`, `oauth`,
`credentials`, `lichess`, `chesscom`, `progress`, `sound`, `file_workspace`, and `infra/*`
(`path_authority`, `net`, `fs`, `blocking`, `runtime`, `validation`).

## 2. The renderer boundary

Commands are `#[tauri::command] #[specta::specta]` functions, collected in
`tauri_specta::collect_commands!` at `src-tauri/src/main.rs:1119`; events in `collect_events!` at
`main.rs:1234`. Running the debug binary with `--export-bindings-only` (what
`pnpm bindings:generate` does) rewrites `src/bindings/generated.ts`; compiling alone does not.
The export is behind `#[cfg(debug_assertions)]`, so a release build exports nothing at all.

- The renderer imports `commands` and `events` from `src/bindings/generated.ts`, and reaches Tauri
  only through `src/platform/` (`tauri.ts`, `native.ts`, `errors.ts`).
  `pnpm tauri:boundary:check` enforces both.
- A new event goes into `collect_events!`. Emitting by bare string is how the `search_progress` and
  `convert_progress` incidents happened — see `.claude/rules/ipc-events.md`.
- `pnpm bindings:check` re-runs the exporter and fails if the checked-in file differs by a byte.
  Never hand-edit it.

Where the bindings are consumed:

| Area | Files | Commands / events |
| --- | --- | --- |
| Active game | `src/components/boards/BoardGame.tsx` | `startGame`, `makeGameMove`, `takeBackGameMove`, `abortGame`, `resignGame`, `getGameState`, `getGameEngineLogs`; `gameMoveEvent`, `clockUpdateEvent`, `gameOverEvent` |
| Databases / PGN | `src/components/databases/{DatabasesPage,AddDatabase}.tsx` | `clearGames`, `convertPgn`, `exportToPgn`, `deleteDatabase`, `mergePlayers`, `createIndexes`, `deleteIndexes` |
| Analysis | `src/components/boards/EvalListener.tsx`, `src/components/panels/analysis/ReportPanel.tsx`, `src/components/engines/EnginesPage.tsx` | `getEngineConfig`, `cancelAnalysis`; `bestMovesPayload` |
| Progress | `src/hooks/useProgress.ts`, `src/components/home/AccountCard.tsx` | `progressEvent` |

## 3. Engine connection and the UCI protocol

Implemented in `src-tauri/src/engine/process.rs`.

1. **Spawn** — `tokio::process::Command` with `Stdio::piped()` for `stdin`/`stdout`/`stderr`, under
   a spawn deadline (`deadlines.spawn`).
2. **Handshake** — `init_uci()` writes `uci` and `isready` and waits for `uciok` / `readyok`, each
   behind its own timeout (`deadlines.uciok`, `deadlines.readyok`).
3. **Configuration** — `set_option` (e.g. `UCI_Chess960`, `Threads`), validated in `engine/types.rs`
   (`MAX_ENGINE_LIMIT`, `MAX_ENGINE_OPTION_RESOURCES`).
4. **Search admission** — the renderer calls `prepare_engine_search`, which reserves one bounded,
   generation-owned native admission for the exact tab, application engine id and executable
   capability. The opaque generation is serialized as a string. `get_best_moves` consumes it once;
   tab close, exact stop, retirement and shutdown invalidate it before publication.
5. **Search** — `set_position` takes a FEN plus follow-up moves; `go` is parameterised by `GoMode`
   (time, depth, infinite). Every info and terminal payload carries the actor generation, and the
   renderer accepts it only for the current transient attempt fingerprint.

Output handling is asynchronous throughout: a dedicated `tokio::spawn` drains `stderr` line by line
into `log::error!`, `stdout` is read through a `BufReader<ChildStdout>` by
`read_bounded_engine_line` (`process.rs:149`), and each line is parsed by
`vampirc_uci::parse_one` into `UciMessage`. Reads are bounded by `deadlines.search` and
`deadlines.stop`, so a hung engine does not park a task forever.

Two different bounds, easily conflated. **Input is rejected, not trimmed:** a line longer than
`MAX_ENGINE_LINE_BYTES` (64 KiB) makes `read_bounded_engine_line` return
`Err(Error::ResourceLimit)`, and stderr is capped the same way at `MAX_ENGINE_STDERR_BYTES`
(512 KiB). **Retained logs are trimmed:** `BoundedLogs` (`process.rs:36-39`) keeps at most
`MAX_LOG_LINES` (2 000) entries and `MAX_LOG_BYTES` (512 KiB), truncating an oversized entry and
reporting the exact dropped-entry count.

Child cleanup authority lives independently of the protocol task. `ChildOwner` retains the original
child handle and executable/resource leases after an unconfirmed bounded reap, including partial
IO creation. The supervisor's existing generation-keyed pending registry owns retries. Concurrent
terminators attach to an immutable attempt outcome, and later explicit retries preserve earlier
results and actor join failures. A drain visits each generation once per invocation. Successful OS
wait confirms cleanup and releases ownership. Capacity is reserved before spawn, with 4096 slots
shared by active, spawning and unresolved child generations. Failed owners never expire or evict.

`LiveSession` records the actual game loop's cleanup result. Failed natural completion remains
reachable in `GameManager.games` until retirement, replacement or shutdown observes it, even after
a successful supervisor retry. Completed snapshots and game events keep their existing meaning.
The manager reserves one of 4096 unobserved-session slots before launch and releases it on natural
success or completed retirement. Shutdown visits each captured session once. Actor and game join
failures use one safe public conversion, with panic diagnostics confined to native logs.

## 4. Game storage

On Linux and macOS, `db/linked_collections.rs` owns a bounded native collection registry through
`SharedPathAuthority`. Library PGNs categorized as game or tournament are authoritative.
Their UUID caches live in private app data outside the standalone database directory.
Repertoires, puzzles and other PGNs remain plain files. Windows retains standalone databases.

Rebuilds stream source games through the existing importer in one SQLite transaction with source
ordinals, exact byte stamps, generation, digest and DataRevision. Query normalization verifies the
admitted source generation before returning. Linked openings read original PGN bytes and persist
their locators with the tree. All linked writes use the PGN edit owner and atomic replacement.
`db/linked_collections/batch.rs` stages append inputs and reconciles provider IDs with compatible
legacy fingerprints on disk. Migration snapshots include WAL state and expose explicit restore.
Pending inputs retain private read grants for explicit Library/account recovery. Completion
removes the owned staging copy and releases its grant after the durable terminal marker.

`state/linkedCollections.ts` connects Library, home summaries, explorer and reference consumers to
the root freshness clock in `state/fileFreshness.ts`. Shared metadata checks have two-second
deadlines. Native rebuilds retain their operation owner through completion and are bounded
separately, so a large collection can finish rebuilding without extending metadata reads.

SQLite via Diesel, `src-tauri/src/db/{models,schema}.rs`.

- `Game` (Queryable) / `NewGame` (Insertable), with `Player`, `Site`, `Event` alongside.
- Metadata: `white_id`, `black_id`, `event_id`, date, time control, `Outcome` as text (`1-0`, `0-1`),
  ECO code.
- `fen` holds the start position only when it is not the standard one — position identity depends on
  which FEN fields you compare (`.claude/rules/chess-tree-semantics.md`).
- `moves` is a binary blob (`Vec<u8>`), decoded on read. Encode and decode must agree on
  `CastlingMode`; `db/encoding.rs` owns that symmetry.
- `ply_count`, `pawn_home` support the search predicates in `db/search.rs` and the memory-mapped
  index in `db/search_index.rs`.

## 5. Streaming to the renderer

`src-tauri/src/game.rs` emits typed events through `event.emit(app)`; Tauri serialises to JSON over
IPC and the renderer subscribes through the platform facade.

- `GameState` — full game status (id, FEN, moves, clocks, players).
- `GameMoveEvent` (`game.rs:187`) — `game_id`, `session`, `revision`, `moves`, `fen`, `white_time`,
  `black_time`.
- `ClockUpdateEvent` (`game.rs:199`) — `game_id`, `session`, `revision`, both clocks.
- `GameOverEvent` — mate, draw, or flag, carrying `GameResult`.

`session` and `revision` are the correlation discriminators. A listener must match on them rather
than assuming the newest payload belongs to the newest request — that assumption is the bug class
`.claude/rules/async-resource-invariants.md` exists to prevent.

## 6. Bottlenecks that are still real

Two entries that stood here before the 2026-08-09 audit — unbounded engine logs and timeout-free
reads — are fixed (§3) and were removed. What remains, each verified on 2026-08-29:

1. **Threefold repetition keyed by FEN string** — `game.rs:248` holds
   `position_history: HashMap<String, u32>`. Building a FEN and hashing a string on every move is
   far more expensive than a Zobrist hash, and it makes position identity depend on exactly which
   FEN fields the key includes.
2. **Moves stored as an opaque blob** — SQLite cannot index into `Vec<u8>`, so searching for a move
   sequence means decoding games or maintaining the separate `MmapSearchIndex`, which costs RAM and
   has to be kept in sync with the table it shadows.
3. **`GameMoveEvent` carries the whole move list on every move** — the JSON payload grows with game
   length, and unthrottled `ClockUpdateEvent`s share the same IPC channel.
