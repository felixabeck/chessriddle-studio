---
paths:
  - "src-tauri/src/main.rs"
  - "src-tauri/src/progress.rs"
  - "src-tauri/src/db/search.rs"
  - "src/platform/**"
  - "src/bindings/**"
  - "src-tauri/capabilities/**"
  - "src-tauri/tauri.conf.json"
---

# IPC Event and Command Contract Rule

> **Relevant when working on:** anything that crosses the Rust↔renderer boundary — a
> `#[tauri::command]`, an `emit`, a `listen`, progress reporting, or a capability scope.
>
> *Path-scoped: this file loads automatically when Claude Code touches the paths in the frontmatter
> above, but the rule binds for **any** file that emits or listens — the glob cannot express that.
> Other agents never auto-load it — read it directly, as the rules table in the repo-root
> `CLAUDE.md` instructs.*

## The single rule

**Nothing reaches the renderer except through the Specta registry: every event payload type appears
in `collect_events!` and every command in `collect_commands!` in `src-tauri/src/main.rs`. Progress
is reported through the existing `ProgressEvent` in `src-tauri/src/progress.rs`, never through a new
ad-hoc event. Anything broadcast globally carries an id the receiver filters on. The consumer gate
also rejects an exported IPC command that has no resolved production renderer consumer.**

## Why

This failure class type-checks on each side independently and fails only at runtime, so "the types
are fine" is never evidence.

* **A bare-string emit carrying another event's payload.** `d09de3c0` — report progress was emitted
  via `app.emit_all` with the download-progress struct and a final value of `progress: 1.0` while
  the renderer expected a percentage. `bc660364` later collapsed the duplicated progress events into
  the single `ProgressEvent` that exists today: `{ id, generation, progress, finished, state,
  cleared }`, with `progress` clamped to `0.0..=100.0` (`src-tauri/src/progress.rs:126`) and updates
  authenticated by a generation-bound lease so a stale id cannot recreate a finished job.
* **Broadcast events without a discriminator.** `daecd674` — `id` was hardcoded `0` on progress
  payloads, so concurrent operations drove each other's progress bars; it became a real `String` id.
* **A capability scope identifier that silently grants nothing.** `bd4edd4d` — `"fs:scope"` was
  replaced by `"fs:scope-appdata-recursive"`; the original identifier did not actually grant
  `$APPDATA`. The opposite failure is `551030cc`, which widened the fs scope to `"**"`. `93acc93c`
  replaced a blanket `http:default` with a host allowlist, and `e001c5f6` shows that allowlist
  rotting (`explorer.lichess.ovh` → `.org`).
* **Listener lifetime.** `aebc490e` — `app.listen_global("stop_engine", …)` never unlistened; the
  fix captures the returned `id` and calls `app.unlisten(id)`.
* **Command signature drift.** `fc7b70f5` — renaming a parameter from `file` to `file_path` changed
  the camelCase invoke key from `file` to `filePath`. Any caller not regenerated breaks only at
  runtime.

## The last bare-string holdout, and what it cost

Until 2026-08-11 `search_progress` was emitted by bare string in `src-tauri/src/db/search.rs` with
its own `ProgressPayload { progress: f64, id, finished, terminal }`, registered nowhere. The renderer
side had meanwhile moved on: `DatabaseLoader.tsx` drives its bar from `useProgress(tab)`, which
subscribes to the typed `ProgressEvent`. Nothing bridged the two, so **the database-search progress
bar never showed real progress** — the backend computed a percentage every 50,000 games and emitted
it into the void while the user watched an indeterminate animation. Exactly the failure mode this
rule exists to prevent, and neither `bindings:check` nor `tauri:boundary:check` can see it: one side
type-checks, the other side type-checks, and no contract connects them.

`SearchProgress` now takes a lease from the progress store and reports through
`update_progress_with_state`, so a search gets the same generation leases, terminal-state stickiness
and bounded retention as every other job.

## And then it happened again, from the other end — `convert_progress`, 2026-08-13

Fixing `search_progress` did not stop the same class from recurring, because the second instance was
created by removing the *consumer* rather than the producer. `src/App.tsx` listened to
`convert_progress` with a raw `listen<[number, number, string | null]>` and fed
`databaseConversionStateAtom`. When `tauri:boundary:check` began rejecting raw `listen()` outside
`src/platform/`, that listener was deleted — and the two `app.emit("convert_progress", …)` calls in
`src-tauri/src/db/mod.rs` were left in place, one of them `.unwrap()`-ing on a renderer-driven import
path. `DatabasesPage.tsx` kept rendering `conversionState.totalGames` and a `games/s` rate that could
no longer ever be anything but zero, so **the live import counter silently died** while an import of
hundreds of thousands of games ran. A boundary checker that only looks at one side will happily
green-light deleting the last listener for an event nobody stopped emitting.

The event is now the registered `ConvertProgress { id, imported_games, elapsed_ms, source_file_name }`,
emitted best-effort (never `unwrap`), and consumed by `useConversionProgress` through the facade.
`collect_events!` lists exactly `BestMovesPayload`, `ConvertProgress`, `DatabaseContentFailure`,
`ProgressEvent`, `GameMoveEvent`, `ClockUpdateEvent`, `GameOverEvent` — there is no longer any event
outside it. Keep it that way, and when a listener has to go, **check whether anything still emits to
it before deleting it**; an event with a producer and no consumer is invisible to every gate in this
repository.

`ConvertProgress.id` is a **per-operation** id the renderer mints (`conversion:` plus
`crypto.randomUUID()`) before it calls `convert_pgn`; Rust echoes it unchanged. Each conversion owns
one entry in `databaseConversionStateAtom`, keyed by that id, and `useConversionProgress` applies a
frame only to the entry with the same id — a frame for an unknown or retired id is dropped, never
turned into an entry. **Never derive the id from the target database.** It was, until
`f-20260914-06`: two imports into the same database shared `conversion:<database>`, both streams
passed the filter, their counts and source names interleaved, and the first completion cleared the
survivor's state. The backend queues a second conversion into the same target behind its write lock
rather than refusing it, so a target is not an operation identity.

## What the gates already prove — do not restate it as a rule

`pnpm bindings:check` re-runs the exporter and fails if `src/bindings/generated.ts` differs by a
byte; `pnpm tauri:boundary:check` rejects direct `@tauri-apps/*` imports, raw `listen()` outside
`src/platform/`, `:default`/`:write-all` permissions, renderer `fs:*` authority, and a wildcard CSP.
The unguarded surface is the **Rust emit side** and the agreement between emitter and listener —
that is where attention belongs.

## DO

* Grep the event literal in `src-tauri/src/main.rs` after adding an emit, and confirm the payload
  type is in `collect_events!`.
* Read the listener, not only the emitter: check the struct is the one that event owns, and that
  scale, range and optionality match.
* Pair every `listen`/`listen_global` with an unlisten on the path that ends the subscription, and
  every renderer subscription with an effect cleanup.
* Justify a widened capability glob in the diff — it is a security decision, not a build fix. For a
  *narrowed* or renamed scope, prove the identifier exists and grants what the code now needs.

## DO NOT

* Hand-edit `src/bindings/generated.ts`. Regenerating is `pnpm bindings:generate`; editing the file
  to make a gate pass is always wrong, whether or not it works.
* Add a second progress channel. There is one `ProgressEvent`.
* Rename a command parameter without checking the camelCase invoke key its callers use.

Reviewed by the `review-ipc-contract` lens, which treats a new unregistered event as a blocker.
