# Async and Resource Invariants Rule

> **Relevant when working on:** any command, any spawned process or task, any subscription, any
> registry that outlives one call — in Rust and in the renderer alike.
>
> *Not path-scoped: this file has no `paths:` frontmatter because it applies to essentially every
> diff in this repository, the same way `git-ci-workflow.md` does in ChessRiddles. Other
> agents never auto-load it — read it directly, as the rules table in the repo-root `CLAUDE.md`
> instructs.*

## The single rule

**Every asynchronous operation carries an identity, a stale-result or cancellation guard, a
terminal state, an error path, and a cleanup. Every registry that holds a resource has an owner,
per-resource identity, cleanup on *every* exit path, and a bounded retention policy. No
`unwrap`/`expect`/`panic!` on anything that reaches the process from a renderer call, a
user-selected file, a database, an engine, or the network.**

Incident history: `docs/context/RULE-HISTORY.md` → Async and resource invariants.

## What this means concretely

* **One process per distinct per-user root the app writes** is enforced by the instance locks acquired
  at the start of `.setup` in application data, configuration and local data. In-process registries
  over app-data state (credentials, path authority, engine images, practice) may rely on it. It does
  not cover a user-picked directory shared by two different
  app-data directories (release and `.dev` identifiers, a different HOME), nor a filesystem without
  advisory locks (logged at startup).
* **Renderer state is not authoritative** for native jobs, credentials, files, databases, engines,
  or games. Persist only versioned, schema-validated user state and reconcile it against native
  state at startup.
* **Blocking work stays off the Tokio workers.** Filesystem, compression, parsing, Diesel, Rayon,
  and child-process waits must not monopolise runtime workers, and no lock is held across `.await`.
* **The second approximately similar implementation gets extracted**, and both callers are routed
  through it — one operation type has one facade and one error/loading/cancellation contract. This
  is not a cleanup task for later; it happens in the same change.
* **Do not weaken CSP or capabilities**, and never move a bearer token or raw backend diagnostic
  into the renderer, to preserve an older shortcut.

## DO

* Give every spawn, subscription and job an owner, and name the exit paths it is cleaned up on:
  normal completion, cancel, tab close, resource swap, application exit, error.
* Return typed errors from commands and map them at the facade; fail the one item, not the process.
* Bound anything that accumulates — logs, caches, registries — and say what the bound is.
* No closure passed to `BLOCKING_GATEWAY` may, directly or transitively, call `BLOCKING_GATEWAY`
  again. Acquiring several permits in sequence from an async body is fine; acquiring one inside
  another is the deadlock.

## DO NOT

* Assume a response belongs to the most recent request because it arrived last. Use a
  discriminator, never timing.
* Add a `unwrap`/`expect` in a renderer-, file-, network-, database- or engine-driven path. A
  provable startup invariant may use one, with an adjacent comment saying why it is provable.
* Leave a spawned process, listener or registry entry whose removal depends on the happy path.
